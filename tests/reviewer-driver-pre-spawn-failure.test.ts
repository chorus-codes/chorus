/**
 * Regression test for issue #25 — when a reviewer's precheck fails (e.g.
 * the underlying CLI isn't installed), the runner used to return null
 * silently, leaving NO on-disk participant directory. The cockpit's
 * enrich-rounds loop couldn't reconcile the synthesised template slot
 * against any real participant, so the card sat at "Queued — waiting
 * for an open slot." forever, with the actual error invisible.
 *
 * The fix creates the reviewer dir BEFORE the precheck runs and writes
 * a `## REVIEWER FAILED` summary on every pre-spawn null-return path.
 * The cockpit's `parseFailureSummary` then lifts the card out of
 * "pending" and shows the actual error (kind, lineage, message).
 *
 * We mock `precheckLineage` to fail, then call `runReviewers` and
 * assert (a) the participant directory exists, (b) answer.md contains
 * the failure block in the canonical format, (c) cli_warning fired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { StandardPhase } from '../src/lib/template-schema';
import type { RunnerEvent } from '../src/daemon/runner';

vi.mock('../src/lib/cli-precheck', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    precheckLineage: vi.fn(async () => ({
      ok: false,
      reason: 'cli_missing',
      message: 'codex-cli is not installed on this system.',
      cta: 'Install Codex from https://github.com/openai/codex',
    })),
  };
});

let tmp: string;
let chatDir: string;
let events: RunnerEvent[];
let dbPath: string;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `chorus-rev-pre-${randomUUID()}.db`);
  process.env.CHORUS_DB_PATH = dbPath;
  const conn = await import('../src/lib/db/connection');
  await conn._resetDbForTests();

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-pre-spawn-'));
  chatDir = tmp;
  events = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CHORUS_DB_PATH;
  vi.restoreAllMocks();
});

const phase: StandardPhase = {
  id: 'review',
  kind: 'review',
  title: 'Code Review',
  description: '',
  doer: { lineage: 'anthropic', models: ['claude-opus-4-7'] },
  reviewer: {
    require: 1,
    crossLineage: false,
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

describe('runReviewers — pre-spawn precheck failure', () => {
  it('writes a REVIEWER FAILED summary so the cockpit slot transitions out of pending', async () => {
    const { runReviewers } = await import('../src/daemon/runner/reviewer-driver');
    type RunReviewersArgs = Parameters<typeof runReviewers>;
    // The precheck fails before any tmux/errorDetector reference is
    // dereferenced, so passing empty objects is safe for this path.
    const fakeTmux = {} as RunReviewersArgs[8];
    const fakeErrorDetector = {} as RunReviewersArgs[9];

    await runReviewers(
      chatDir,
      'test-chat',
      phase,
      0,
      1,
      'doer output',
      'work brief',
      '',
      fakeTmux,
      fakeErrorDetector,
      (e) => events.push(e),
      new AbortController().signal,
    );

    // The reviewer directory must exist on disk so enrich-rounds can
    // reconcile against the synthetic slot.
    const reviewerDir = path.join(chatDir, 'round-1', 'reviewer-codex-cli-0');
    expect(fs.existsSync(reviewerDir)).toBe(true);

    // answer.md must contain a `## REVIEWER FAILED` block in the format
    // `parseFailureSummary` understands.
    const answer = fs.readFileSync(path.join(reviewerDir, 'answer.md'), 'utf-8');
    expect(answer).toMatch(/^## REVIEWER FAILED/);
    expect(answer).toMatch(/\*\*Kind:\*\* cli_missing/);
    expect(answer).toMatch(/\*\*Lineage:\*\* openai/);
    expect(answer).toMatch(/\*\*Model:\*\* gpt-5\.5/);
    expect(answer).toMatch(/codex-cli is not installed/);

    // cli_warning event must still fire — banners on the run page rely
    // on this for the user-readable explanation.
    const warning = events.find((e) => e.type === 'cli_warning');
    expect(warning).toBeDefined();
    expect((warning?.payload as { reason?: string })?.reason).toBe('cli_missing');
  });
});
