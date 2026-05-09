/**
 * Regression tests for the gemini `-p` placeholder fix.
 *
 * Bug being pinned: with `shell: true` on Windows (required for .cmd shims —
 * see headless.ts), Node concatenates argv with spaces and the shell
 * collapses runs of whitespace before yargs sees them. The original `' '`
 * placeholder for `-p` got eaten and gemini parsed `--output-format` as the
 * `-p` value, then bailed with help output. The fix uses a non-whitespace
 * placeholder (`_`) that survives the shell concat round-trip.
 *
 * We mock `spawnHeadless` to capture the argv the gemini shim builds without
 * launching anything real, then assert (a) the placeholder is `_`, (b) the
 * placeholder survives a paranoid shell-collapse simulation, (c) the rest of
 * the expected flags are still present.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

interface CapturedSpawn {
  command: string;
  args: readonly string[];
  stdinPayload?: string;
  cwd: string;
}

/**
 * Set up a fresh spy on spawnHeadless that records the call but produces a
 * benign run handle (empty event stream, immediate exit). Returns the
 * captured-call accumulator and the dynamically-imported geminiShim.
 */
async function setupShimWithSpy(): Promise<{
  captured: CapturedSpawn[];
  geminiShim: typeof import('../src/daemon/agents/gemini').geminiShim;
}> {
  vi.resetModules();
  const captured: CapturedSpawn[] = [];

  vi.doMock('../src/daemon/headless', () => ({
    spawnHeadless: (opts: {
      command: string;
      args: readonly string[];
      cwd: string;
      stdinPayload?: string;
    }) => {
      captured.push({
        command: opts.command,
        args: [...opts.args],
        stdinPayload: opts.stdinPayload,
        cwd: opts.cwd,
      });
      return {
        pid: 12345,
        events: (async function* () {
          // empty stream — no events
        })(),
        done: Promise.resolve({ code: 0, killed: false }),
      };
    },
  }));

  const { geminiShim } = await import('../src/daemon/agents/gemini');
  return { captured, geminiShim };
}

describe('geminiShim.runHeadless — argv shape', () => {
  it('passes `-p` followed by a non-whitespace placeholder (`_`), not a space', async () => {
    const { captured, geminiShim } = await setupShimWithSpy();

    const stream = geminiShim.runHeadless!({
      cwd: process.cwd(),
      promptText: 'review this PR',
      model: 'gemini-2.5-pro',
      sandbox: 'workspace',
    });
    // Drain the (empty) iterator so the call is observed.
    for await (const _ of stream) { /* ignore */ }

    expect(captured).toHaveLength(1);
    const args = captured[0]!.args;
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('_');
    expect(args[1]).not.toBe(' ');
    expect(args[1]?.trim().length).toBeGreaterThan(0);
  });

  it('placeholder survives a Windows-shell-collapse simulation (multi-space → single-space split round-trip)', async () => {
    const { captured, geminiShim } = await setupShimWithSpy();

    const stream = geminiShim.runHeadless!({
      cwd: process.cwd(),
      promptText: 'review',
      model: 'gemini-2.5-pro',
      sandbox: 'workspace',
    });
    for await (const _ of stream) { /* drain */ }

    const args = [...captured[0]!.args];
    // Paranoid simulation of what cmd.exe does with shell:true: argv joined
    // by spaces, then runs of whitespace collapsed, then split again. With
    // the buggy ' ' placeholder this round-trip would reorder/eat the `-p`
    // value; with `_` the structure survives intact.
    const collapsed = args.join(' ').replace(/ +/g, ' ').split(' ');
    const dashPIdx = collapsed.indexOf('-p');
    expect(dashPIdx).toBeGreaterThanOrEqual(0);
    expect(collapsed[dashPIdx + 1]).toBe('_');
    // Sanity: --output-format still occupies the position after `-p _`,
    // not glued onto `-p`.
    expect(collapsed[dashPIdx + 2]).toBe('--output-format');
  });

  it('keeps the full headless flag set: --output-format stream-json, --skip-trust, --approval-mode auto_edit, -m <model>', async () => {
    const { captured, geminiShim } = await setupShimWithSpy();

    const stream = geminiShim.runHeadless!({
      cwd: process.cwd(),
      promptText: 'review',
      model: 'gemini-2.5-pro',
      sandbox: 'workspace',
    });
    for await (const _ of stream) { /* drain */ }

    const args = captured[0]!.args;
    const formatIdx = args.indexOf('--output-format');
    expect(formatIdx).toBeGreaterThanOrEqual(0);
    expect(args[formatIdx + 1]).toBe('stream-json');

    expect(args).toContain('--skip-trust');

    const approvalIdx = args.indexOf('--approval-mode');
    expect(approvalIdx).toBeGreaterThanOrEqual(0);
    expect(args[approvalIdx + 1]).toBe('auto_edit');

    const modelIdx = args.indexOf('-m');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe('gemini-2.5-pro');
  });

  it('strict sandbox flips approval-mode to plan (read-only) but keeps the `-p _` placeholder intact', async () => {
    const { captured, geminiShim } = await setupShimWithSpy();

    const stream = geminiShim.runHeadless!({
      cwd: process.cwd(),
      promptText: 'review',
      model: 'gemini-2.5-pro',
      sandbox: 'strict',
    });
    for await (const _ of stream) { /* drain */ }

    const args = captured[0]!.args;
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('_');
    const approvalIdx = args.indexOf('--approval-mode');
    expect(args[approvalIdx + 1]).toBe('plan');
  });

  it('falls back to gemini-2.5-pro when no model is provided (preview models 404 on most accounts)', async () => {
    const { captured, geminiShim } = await setupShimWithSpy();

    const stream = geminiShim.runHeadless!({
      cwd: process.cwd(),
      promptText: 'review',
      sandbox: 'workspace',
    });
    for await (const _ of stream) { /* drain */ }

    const args = captured[0]!.args;
    const modelIdx = args.indexOf('-m');
    expect(args[modelIdx + 1]).toBe('gemini-2.5-pro');
  });
});
