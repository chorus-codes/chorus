/**
 * Integration tests for runDoerHeadless.
 *
 * Drives the real runner code with a FakeAgentShim instead of a real CLI
 * subprocess. Confirms the contracts that earlier hand-debugging surfaced:
 *
 *   - `text_delta` events accumulate AND get flushed to answer.md
 *   - `message_done` with non-empty finalText overwrites answer.md
 *     authoritatively + appends ## DONE sentinel when missing
 *   - `message_done` with EMPTY finalText keeps accumulated deltas in
 *     place (the Gemini `result-line-only` bug)
 *   - `error` event flips errored AND preserves accumulated content
 *   - aborted stream returns null when no content was streamed
 *   - StreamFileWriter buffer is flushed in the finally block on every path
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runDoerHeadless } from '../src/daemon/runner';
import { _resetDbForTests } from '../src/lib/db/connection';
import type { StandardPhase } from '../src/lib/template-schema';
import type { RunnerEvent } from '../src/daemon/runner';
import { makeFakeShim, happyPathEvents } from './helpers/fake-agent-shim';

let tmp: string;
let answerFile: string;
let events: RunnerEvent[];
let dbPath: string;

beforeEach(async () => {
  // Each test gets a unique DB so parallel vitest workers don't race
  // on a shared ~/.chorus/chorus.db (CI hit SQLITE_BUSY otherwise).
  dbPath = path.join(os.tmpdir(), `chorus-runner-doer-${randomUUID()}.db`);
  process.env.CHORUS_DB_PATH = dbPath;
  await _resetDbForTests();

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-doer-'));
  answerFile = path.join(tmp, 'answer.md');
  events = [];
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CHORUS_DB_PATH;
});

const fixturePhase: StandardPhase = {
  id: 'review',
  kind: 'review',
  title: 'Code Review',
  description: '',
  doer: { lineage: 'anthropic', models: ['claude-opus-4-7'] },
  reviewer: {
    require: 1,
    crossLineage: true,
    candidates: [{ lineage: 'openai', models: ['gpt-5.5'] }],
  },
  inputs: { include: [], exclude: [] },
  iterate: {
    maxRounds: 1,
    onDisagreement: 'continue',
    shareSessionAcrossRounds: false,
    shareSessionAcrossPhases: false,
  },
} as unknown as StandardPhase;

const callDoer = (shimHandle: ReturnType<typeof makeFakeShim>) =>
  runDoerHeadless({
    shim: shimHandle.shim,
    chatId: 'test-chat',
    phase: fixturePhase,
    round: 1,
    agentName: 'fake',
    askContent: 'do the thing',
    answerFile,
    doerCwd: tmp,
    abortSignal: new AbortController().signal,
    onEvent: (e) => events.push(e),
  });

describe('runDoerHeadless', () => {
  it('forwards phase.timeoutMs to the shim spawn options', async () => {
    const handle = makeFakeShim({ events: happyPathEvents('done\n## DONE') });
    const phaseWithTimeout: StandardPhase = { ...fixturePhase, timeoutMs: 90_000 };
    await runDoerHeadless({
      shim: handle.shim,
      chatId: 'test-chat',
      phase: phaseWithTimeout,
      round: 1,
      agentName: 'fake',
      askContent: 'do the thing',
      answerFile,
      doerCwd: tmp,
      abortSignal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    });
    expect(handle.calls).toHaveLength(1);
    expect(handle.calls[0].options.timeoutMs).toBe(90_000);
  });

  it('falls back to the default phase timeout when phase.timeoutMs is unset', async () => {
    const handle = makeFakeShim({ events: happyPathEvents('done\n## DONE') });
    await callDoer(handle);
    expect(handle.calls[0].options.timeoutMs).toBe(10 * 60 * 1000);
  });

  it('uses phase.doer.models[0] when modelOverride is omitted', async () => {
    const handle = makeFakeShim({ events: happyPathEvents('done\n## DONE') });
    await callDoer(handle);
    expect(handle.calls[0].options.model).toBe('claude-opus-4-7');
  });

  it('honours modelOverride over phase.doer.models[0] (per-attempt fallback)', async () => {
    const handle = makeFakeShim({ events: happyPathEvents('done\n## DONE') });
    await runDoerHeadless({
      shim: handle.shim,
      chatId: 'test-chat',
      phase: fixturePhase,
      round: 1,
      agentName: 'fake',
      askContent: 'do the thing',
      answerFile,
      doerCwd: tmp,
      abortSignal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      modelOverride: 'claude-sonnet-4-6',
    });
    expect(handle.calls).toHaveLength(1);
    expect(handle.calls[0].options.model).toBe('claude-sonnet-4-6');
  });

  it('happy path: streams deltas + finalText, returns full content with DONE sentinel', async () => {
    const handle = makeFakeShim({
      events: happyPathEvents('I made the fix.\n\nLooks good.\n## DONE'),
    });
    const res = await callDoer(handle);
    expect(res).not.toBeNull();
    expect(res!.full).toBe(true);
    expect(res!.content).toContain('I made the fix.');
    const written = fs.readFileSync(answerFile, 'utf-8');
    expect(written).toContain('I made the fix.');
    expect(written).toMatch(/##\s*DONE/);
  });

  it('emits participant_done after message_done so the cockpit can flip the card without polling lag', async () => {
    const handle = makeFakeShim({
      events: happyPathEvents('done\n## DONE'),
    });
    await callDoer(handle);
    const done = events.filter((e) => e.type === 'participant_done');
    expect(done).toHaveLength(1);
    expect(done[0].payload).toMatchObject({
      role: 'doer',
      agent: 'fake',
      round: 1,
    });
  });

  it('appends ## DONE sentinel when finalText lacks it', async () => {
    const handle = makeFakeShim({
      events: [
        { type: 'text_delta', text: 'partial' },
        { type: 'message_done', finalText: 'authoritative final answer here' },
      ],
    });
    await callDoer(handle);
    const written = fs.readFileSync(answerFile, 'utf-8');
    expect(written).toContain('authoritative final answer here');
    expect(written).toMatch(/##\s*DONE/);
  });

  it('preserves accumulated deltas when message_done.finalText is empty', async () => {
    // Gemini's "result line is empty after streaming many deltas" failure
    // mode. Earlier code overwrote answer.md with just `## DONE`, wiping
    // the live stream. Now: we keep the deltas, append DONE if missing.
    const handle = makeFakeShim({
      events: [
        { type: 'text_delta', text: 'streaming chunk one\n' },
        { type: 'text_delta', text: 'streaming chunk two\n' },
        { type: 'message_done', finalText: '' },
      ],
    });
    const res = await callDoer(handle);
    const written = fs.readFileSync(answerFile, 'utf-8');
    expect(written).toContain('streaming chunk one');
    expect(written).toContain('streaming chunk two');
    expect(written).toMatch(/##\s*DONE/);
    expect(res!.content).toContain('streaming chunk');
  });

  it('emits phase_progress events for every text_delta', async () => {
    const handle = makeFakeShim({ events: happyPathEvents('three chunks here', { chunks: 3 }) });
    await callDoer(handle);
    const progress = events.filter(
      (e) => e.type === 'phase_progress' && e.payload.role === 'doer',
    );
    expect(progress.length).toBeGreaterThanOrEqual(3);
  });

  it('emits cli_error and returns null when stream errors with no content', async () => {
    const handle = makeFakeShim({
      events: [{ type: 'error', kind: 'quota_exhausted', message: 'rate limited' }],
    });
    const res = await callDoer(handle);
    expect(res).toBeNull();
    const cliError = events.find((e) => e.type === 'cli_error');
    expect(cliError).toBeDefined();
    expect((cliError!.payload.error as { kind: string }).kind).toBe('quota_exhausted');
  });

  it('keeps accumulated content even when a final error event fires', async () => {
    const handle = makeFakeShim({
      events: [
        { type: 'text_delta', text: 'partial answer before crash\n' },
        { type: 'error', kind: 'crashed', message: 'subprocess died' },
      ],
    });
    const res = await callDoer(handle);
    expect(res).not.toBeNull();
    expect(res!.content).toContain('partial answer before crash');
    const written = fs.readFileSync(answerFile, 'utf-8');
    expect(written).toContain('partial answer before crash');
  });

  it('returns null when shim has no runHeadless implementation', async () => {
    const handle = makeFakeShim({ events: [] });
    // Force-strip runHeadless to simulate a tmux-only shim
    delete (handle.shim as { runHeadless?: unknown }).runHeadless;
    const res = await callDoer(handle);
    expect(res).toBeNull();
  });

  it('captures message_done.usage onto the return shape (round-2-deferred §1 rails)', async () => {
    const handle = makeFakeShim({
      events: [
        { type: 'text_delta', text: 'doing the thing' },
        {
          type: 'message_done',
          finalText: 'doing the thing\n## DONE',
          usage: { inputTokens: 1234, outputTokens: 567, cachedInputTokens: 100 },
        },
      ],
    });
    const res = await callDoer(handle);
    expect(res).not.toBeNull();
    expect(res!.usage).toEqual({
      inputTokens: 1234,
      outputTokens: 567,
      cachedInputTokens: 100,
    });
  });

  it('omits usage from the return when message_done has no usage block', async () => {
    const handle = makeFakeShim({
      events: [
        { type: 'text_delta', text: 'no usage here' },
        { type: 'message_done', finalText: 'no usage here\n## DONE' },
      ],
    });
    const res = await callDoer(handle);
    expect(res).not.toBeNull();
    expect(res!.usage).toBeUndefined();
  });

  it('records cli_health healthy on success so sticky quota_exhausted clears', async () => {
    // Mirror of the matching reviewer test — a sticky quota_exhausted
    // marker with no resetAt was the symptom Victor caught on the
    // home page: gemini ran fine but the Reviewer Fleet card still
    // said "Quota out". The runner now writes healthy on every
    // successful CLI run, symmetric to what openrouter + local
    // shims already do.
    const { recordHealth, getHealth } = await import('@/lib/cli-health');
    await recordHealth({
      lineage: 'anthropic',
      status: 'quota_exhausted',
      message: 'stale quota marker',
    });
    const before = await getHealth('anthropic');
    expect(before.status).toBe('quota_exhausted');

    const handle = makeFakeShim({ events: happyPathEvents('done\n## DONE') });
    await callDoer(handle);

    const after = await getHealth('anthropic');
    expect(after.status).toBe('healthy');
  });
});
