/**
 * Integration tests for runReviewerHeadless.
 *
 * Same shape as the doer tests but the reviewer returns boolean | null
 * (the verdict) instead of {content, full}. Verifies that approve / disagree
 * text is correctly extracted from streamed deltas and that empty / errored
 * paths fail closed (null).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runReviewerHeadless } from '../src/daemon/runner';
import { _resetDbForTests } from '../src/lib/db/connection';
import type { StandardPhase } from '../src/lib/template-schema';
import type { RunnerEvent } from '../src/daemon/runner';
import { makeFakeShim, happyPathEvents } from './helpers/fake-agent-shim';

let tmp: string;
let reviewerDir: string;
let answerFile: string;
let events: RunnerEvent[];
let dbPath: string;

beforeEach(async () => {
  // Each test gets a unique DB so parallel vitest workers don't race
  // on a shared ~/.chorus/chorus.db (CI hit SQLITE_BUSY otherwise).
  dbPath = path.join(os.tmpdir(), `chorus-runner-reviewer-${randomUUID()}.db`);
  process.env.CHORUS_DB_PATH = dbPath;
  await _resetDbForTests();

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-reviewer-'));
  reviewerDir = path.join(tmp, 'reviewer-codex-0');
  fs.mkdirSync(reviewerDir, { recursive: true });
  answerFile = path.join(reviewerDir, 'answer.md');
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

const PADDING =
  'lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(3);

const callReviewer = (shimHandle: ReturnType<typeof makeFakeShim>) =>
  runReviewerHeadless({
    shim: shimHandle.shim,
    chatId: 'test-chat',
    phase: fixturePhase,
    round: 1,
    reviewerIdx: 0,
    candidateLineage: 'openai',
    candidateModel: 'gpt-5.5',
    agentName: 'codex-cli',
    askContent: 'review the doer output',
    answerFile,
    reviewerDir,
    abortSignal: new AbortController().signal,
    onEvent: (e) => events.push(e),
  });

describe('runReviewerHeadless', () => {
  it('forwards phase.timeoutMs to the shim spawn options', async () => {
    const handle = makeFakeShim({
      events: happyPathEvents(`${PADDING}\nlgtm\n## DONE`),
    });
    const phaseWithTimeout: StandardPhase = { ...fixturePhase, timeoutMs: 45_000 };
    await runReviewerHeadless({
      shim: handle.shim,
      chatId: 'test-chat',
      phase: phaseWithTimeout,
      round: 1,
      reviewerIdx: 0,
      candidateLineage: 'openai',
      candidateModel: 'gpt-5.5',
      agentName: 'codex-cli',
      askContent: 'review the doer output',
      answerFile,
      reviewerDir,
      abortSignal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    });
    expect(handle.calls).toHaveLength(1);
    expect(handle.calls[0].options.timeoutMs).toBe(45_000);
  });

  it('falls back to the default phase timeout when phase.timeoutMs is unset', async () => {
    const handle = makeFakeShim({
      events: happyPathEvents(`${PADDING}\nlgtm\n## DONE`),
    });
    await callReviewer(handle);
    expect(handle.calls[0].options.timeoutMs).toBe(10 * 60 * 1000);
  });

  it('returns true when reviewer text approves at the tail', async () => {
    const text = `${PADDING}\nThis change handles divide-by-zero correctly. lgtm.\n## DONE`;
    const handle = makeFakeShim({ events: happyPathEvents(text) });
    const verdict = await callReviewer(handle);
    expect(verdict).toBe(true);
  });

  it('emits participant_done after message_done so the cockpit can flip the card without polling lag', async () => {
    const text = `${PADDING}\nlgtm.\n## DONE`;
    const handle = makeFakeShim({ events: happyPathEvents(text) });
    await callReviewer(handle);
    const done = events.filter((e) => e.type === 'participant_done');
    expect(done).toHaveLength(1);
    expect(done[0].payload).toMatchObject({
      role: 'reviewer',
      agent: 'codex-cli-0',
      round: 1,
    });
  });

  it('does NOT emit participant_done when the run errors before message_done', async () => {
    const handle = makeFakeShim({
      events: [{ type: 'error', kind: 'quota_exhausted', message: 'limit hit' }],
    });
    await callReviewer(handle);
    expect(events.some((e) => e.type === 'participant_done')).toBe(false);
  });

  it('returns false when reviewer requests changes', async () => {
    const text = `${PADDING}\nMissing input validation; request changes.\n## DONE`;
    const handle = makeFakeShim({ events: happyPathEvents(text) });
    const verdict = await callReviewer(handle);
    expect(verdict).toBe(false);
  });

  it('returns null on ambiguous text (no positive/negative match)', async () => {
    const text = `${PADDING} ${PADDING} the code seems consistent with the rest of the codebase.\n## DONE`;
    const handle = makeFakeShim({ events: happyPathEvents(text) });
    const verdict = await callReviewer(handle);
    expect(verdict).toBeNull();
  });

  it('returns null when stream errors with no content', async () => {
    const handle = makeFakeShim({
      events: [{ type: 'error', kind: 'quota_exhausted', message: 'limit hit' }],
    });
    const verdict = await callReviewer(handle);
    expect(verdict).toBeNull();
  });

  it('returns null when stream is silent (no message_done, no deltas)', async () => {
    const handle = makeFakeShim({ events: [] });
    const verdict = await callReviewer(handle);
    expect(verdict).toBeNull();
  });

  it('surfaces classified errorKind via lastError out-param', async () => {
    // The driver depends on this contract to decide retry-vs-advance.
    // A stream that errors with kind=stream_failure must populate
    // lastError.kind so the driver sees "transient — retry once".
    const handle = makeFakeShim({
      events: [{ type: 'error', kind: 'stream_failure', message: 'EPIPE' }],
    });
    const lastError: { kind?: string; message?: string } = {};
    const verdict = await runReviewerHeadless({
      shim: handle.shim,
      chatId: 'test-chat',
      phase: fixturePhase,
      round: 1,
      reviewerIdx: 0,
      candidateLineage: 'openai',
      candidateModel: 'gpt-5.5',
      agentName: 'codex-cli',
      askContent: 'review the doer output',
      answerFile,
      reviewerDir,
      abortSignal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      lastError,
    });
    expect(verdict).toBeNull();
    expect(lastError.kind).toBe('stream_failure');
    expect(lastError.message).toContain('EPIPE');
  });

  it('leaves lastError untouched on successful run', async () => {
    // Happy-path: classifier shouldn't see a phantom error from a
    // successful reviewer attempt.
    const handle = makeFakeShim({
      events: happyPathEvents(`${PADDING}\nlgtm\n## DONE`),
    });
    const lastError: { kind?: string; message?: string } = {};
    const verdict = await runReviewerHeadless({
      shim: handle.shim,
      chatId: 'test-chat',
      phase: fixturePhase,
      round: 1,
      reviewerIdx: 0,
      candidateLineage: 'openai',
      candidateModel: 'gpt-5.5',
      agentName: 'codex-cli',
      askContent: 'review the doer output',
      answerFile,
      reviewerDir,
      abortSignal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      lastError,
    });
    expect(verdict).toBe(true);
    expect(lastError.kind).toBeUndefined();
  });

  it('preserves streamed deltas to disk when finalText is empty', async () => {
    const text = `${PADDING}\nlgtm — ship it`;
    const handle = makeFakeShim({
      events: [
        { type: 'text_delta', text },
        { type: 'message_done', finalText: '' },
      ],
    });
    const verdict = await callReviewer(handle);
    const written = fs.readFileSync(answerFile, 'utf-8');
    expect(written).toContain('lgtm');
    expect(verdict).toBe(true);
  });

  // This test forces an EACCES on the writer's appendFileSync via chmod
  // 0o444. Root bypasses POSIX permission bits on Linux, so the test only
  // works when the test process runs as a non-root user. CI and `pnpm test`
  // (without sudo) are non-root and validate the behavior; `sudo pnpm test`
  // skips with a clear note instead of silently failing. Mocking `fs` at
  // the module level isn't an option here — Node 20+ marks fs exports
  // non-configurable, so vi.spyOn(fs, 'appendFileSync') throws.
  const isRoot =
    typeof process.getuid === 'function' && process.getuid() === 0;
  (isRoot ? it.skip : it)(
    'emits cli_warning when answer.md write fails (StreamFileWriter dies mid-stream)',
    async () => {
      // Run AFTER runReviewerHeadless's initial fs.writeFileSync(answerFile,'').
      async function* hostileStream(): AsyncIterable<{
        type: 'text_delta' | 'message_done';
        text?: string;
        finalText?: string;
      }> {
        fs.chmodSync(answerFile, 0o444);
        // Buffer crosses the flush threshold (4KB) so the synchronous
        // appendFileSync fails with EACCES, flipping the writer dead.
        yield { type: 'text_delta', text: 'x'.repeat(8192) };
        yield { type: 'message_done', finalText: '' };
      }
      const fakeShim = makeFakeShim({ events: [] });
      fakeShim.shim.runHeadless = () => hostileStream() as never;

      await callReviewer(fakeShim);

      // Restore perms so afterEach rmSync can clean up.
      try {
        fs.chmodSync(answerFile, 0o644);
      } catch {
        /* best-effort */
      }

      const warning = events.find(
        (e) =>
          e.type === 'cli_warning' &&
          (e.payload as { reason?: string }).reason === 'stream_writer_dead',
      );
      expect(warning).toBeDefined();
      const payload = warning!.payload as { role?: string; agent?: string };
      expect(payload.role).toBe('reviewer');
      expect(payload.agent).toBe('codex-cli-0');
    },
  );
});
