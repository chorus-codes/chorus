/**
 * Regression tests for the Windows-spawn fixes in src/daemon/headless.ts:
 *
 *   1. resolveBinaryPath (private — exercised through spawnHeadless):
 *      - Unix: no-op, the bare command name is passed to spawn unchanged.
 *      - Windows: shells out to `where <cmd>` once per command name (cached
 *        across spawns) and prefers the .cmd/.bat/.exe sibling over the
 *        bash shim returned alongside it on npm globals.
 *      - Windows fallback: if `where` exits non-zero or returns no stdout,
 *        the original command name is passed through (spawn will surface
 *        ENOENT cleanly to the caller).
 *
 *   2. shell:true is set ONLY on Windows. Unix spawns never get shell:true.
 *
 * The `binaryPathCache` is a module-level Map and the platform branch is
 * evaluated at import time via process.platform — so each test that needs a
 * specific platform calls `vi.resetModules()` + a fresh dynamic import, with
 * `process.platform` re-defined first via Object.defineProperty (writable on
 * the process object once you redefine the descriptor).
 *
 * Mocks:
 *   - child_process.spawn returns a stub EventEmitter+streams so spawnHeadless
 *     completes its happy-path setup without launching anything real.
 *   - child_process.spawnSync is the spy we assert against for the `where`
 *     resolution behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

const ORIGINAL_PLATFORM = process.platform;

/**
 * cli-paths.ts imports from `lib/db/settings`, which boots libsql — and
 * libsql's runtime native-binding loader keys off process.platform at
 * require time. Tests in this file flip process.platform to 'linux' and
 * 'darwin' to exercise the cross-platform branches; under that flip, the
 * native libsql for the host OS is no longer the right loader, and the
 * import explodes with "Cannot find module '@libsql/linux-x64-musl'".
 *
 * The headless module only uses cli-paths inside spawnEnv() to enrich
 * PATH with manual-CLI dirs. For the resolveBinaryPath / shell:true
 * assertions in this file, returning [] is fully sufficient.
 */
function stubCliPaths(): void {
  vi.doMock('../src/lib/cli-paths', () => ({
    cliPaths: {
      cachedDirs: (): string[] => [],
      get: (): string | undefined => undefined,
      set: async (): Promise<void> => undefined,
      refresh: async (): Promise<void> => undefined,
      list: (): Record<string, string> => ({}),
    },
  }));
}

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: p,
    configurable: true,
    writable: false,
    enumerable: true,
  });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', {
    value: ORIGINAL_PLATFORM,
    configurable: true,
    writable: false,
    enumerable: true,
  });
}

/**
 * Build a stub child process object that satisfies the contract the headless
 * spawn helper exercises (stdin.write/end, stdout/stderr.setEncoding/on,
 * .on('exit'|'error'), .kill, .pid). The streams are no-op pass-throughs;
 * stdout/stderr emit no data and `exit` is fired synchronously on next tick
 * so spawnHeadless's `done` promise resolves cleanly during tests.
 */
function makeFakeChild(): {
  child: EventEmitter & {
    pid: number;
    stdin: Writable;
    stdout: Readable & { setEncoding: (enc: string) => void };
    stderr: Readable & { setEncoding: (enc: string) => void };
    kill: (sig?: string) => boolean;
  };
  triggerExit: (code: number | null) => void;
} {
  const emitter = new EventEmitter();
  const stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  const stdout: Readable & { setEncoding: (enc: string) => void } = Object.assign(
    new Readable({ read() {} }),
    { setEncoding: (_e: string): void => undefined },
  );
  const stderr: Readable & { setEncoding: (enc: string) => void } = Object.assign(
    new Readable({ read() {} }),
    { setEncoding: (_e: string): void => undefined },
  );
  const child = Object.assign(emitter, {
    pid: 12345,
    stdin,
    stdout,
    stderr,
    kill: (_sig?: string): boolean => true,
  });
  // spawnHeadless now finalizes on `close` (post stdio-drain) rather than
  // `exit`. The trigger fires both events back-to-back for tests that
  // don't care about the drain timing — the runtime guard makes
  // finalize() idempotent so emitting both is safe.
  const triggerExit = (code: number | null): void => {
    setImmediate(() => {
      emitter.emit('exit', code);
      emitter.emit('close', code, null);
    });
  };
  return { child, triggerExit };
}

afterEach(() => {
  restorePlatform();
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.resetModules();
});

describe('resolveBinaryPath (via spawnHeadless) — Unix branch', () => {
  it('passes the command through unchanged on Linux and never calls `where`', async () => {
    setPlatform('linux');
    stubCliPaths();

    const spawnSyncSpy = vi.fn();
    const { child, triggerExit } = makeFakeChild();
    const spawnSpy = vi.fn((_cmd: string, _args: string[], _opts?: object) => child);

    vi.doMock('node:child_process', () => ({
      spawn: spawnSpy,
      spawnSync: spawnSyncSpy,
    }));
    vi.doMock('child_process', () => ({
      spawn: spawnSpy,
      spawnSync: spawnSyncSpy,
    }));

    const { spawnHeadless } = await import('../src/daemon/headless');
    const run = spawnHeadless({
      command: 'claude',
      args: ['--print'],
      cwd: process.cwd(),
      parseLine: () => [],
      cli: 'claude',
    });
    triggerExit(0);
    await run.done;

    expect(spawnSyncSpy).not.toHaveBeenCalled();
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy.mock.calls[0]?.[0]).toBe('claude'); // unchanged
    const opts = spawnSpy.mock.calls[0]?.[2] as { shell?: boolean };
    expect(opts.shell).toBe(false); // Unix never sets shell:true
  });
});

describe('resolveBinaryPath (via spawnHeadless) — Windows branch', () => {
  it('prefers the .cmd shim when `where` returns both bash sibling and .cmd', async () => {
    setPlatform('win32');
    stubCliPaths();

    const spawnSyncSpy = vi.fn().mockReturnValue({
      status: 0,
      stdout: 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude\r\nC:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd\r\n',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    });
    const { child, triggerExit } = makeFakeChild();
    const spawnSpy = vi.fn((_cmd: string, _args: string[], _opts?: object) => child);

    vi.doMock('node:child_process', () => ({
      spawn: spawnSpy,
      spawnSync: spawnSyncSpy,
    }));
    vi.doMock('child_process', () => ({
      spawn: spawnSpy,
      spawnSync: spawnSyncSpy,
    }));

    const { spawnHeadless } = await import('../src/daemon/headless');
    const run = spawnHeadless({
      command: 'claude',
      args: ['--print'],
      cwd: process.cwd(),
      parseLine: () => [],
      cli: 'claude',
    });
    triggerExit(0);
    await run.done;

    expect(spawnSyncSpy).toHaveBeenCalledTimes(1);
    expect(spawnSyncSpy.mock.calls[0]?.[0]).toBe('where');
    expect(spawnSyncSpy.mock.calls[0]?.[1]).toEqual(['claude']);

    const resolvedArg = spawnSpy.mock.calls[0]?.[0] as string;
    expect(resolvedArg.toLowerCase()).toMatch(/claude\.cmd$/);

    const opts = spawnSpy.mock.calls[0]?.[2] as { shell?: boolean };
    expect(opts.shell).toBe(true);
  });

  it('caches the resolution: a second spawn for the same command does not re-invoke `where`', async () => {
    setPlatform('win32');
    stubCliPaths();

    const spawnSyncSpy = vi.fn().mockReturnValue({
      status: 0,
      stdout: 'C:\\path\\codex.cmd\r\n',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    });
    const spawnSpy = vi.fn(() => {
      const { child, triggerExit } = makeFakeChild();
      triggerExit(0);
      return child;
    });

    vi.doMock('node:child_process', () => ({
      spawn: spawnSpy,
      spawnSync: spawnSyncSpy,
    }));
    vi.doMock('child_process', () => ({
      spawn: spawnSpy,
      spawnSync: spawnSyncSpy,
    }));

    const { spawnHeadless } = await import('../src/daemon/headless');

    const r1 = spawnHeadless({
      command: 'codex',
      args: ['exec'],
      cwd: process.cwd(),
      parseLine: () => [],
      cli: 'codex',
    });
    await r1.done;

    const r2 = spawnHeadless({
      command: 'codex',
      args: ['exec'],
      cwd: process.cwd(),
      parseLine: () => [],
      cli: 'codex',
    });
    await r2.done;

    expect(spawnSyncSpy).toHaveBeenCalledTimes(1); // cached
    expect(spawnSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back to the original command name when `where` exits non-zero', async () => {
    setPlatform('win32');
    stubCliPaths();

    const spawnSyncSpy = vi.fn().mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'INFO: Could not find files for the given pattern(s).',
      pid: 0,
      output: [],
      signal: null,
    });
    const { child, triggerExit } = makeFakeChild();
    const spawnSpy = vi.fn((_cmd: string, _args: string[], _opts?: object) => child);

    vi.doMock('node:child_process', () => ({
      spawn: spawnSpy,
      spawnSync: spawnSyncSpy,
    }));
    vi.doMock('child_process', () => ({
      spawn: spawnSpy,
      spawnSync: spawnSyncSpy,
    }));

    const { spawnHeadless } = await import('../src/daemon/headless');
    const run = spawnHeadless({
      command: 'gemini',
      args: ['-p', '_'],
      cwd: process.cwd(),
      parseLine: () => [],
      cli: 'gemini',
    });
    triggerExit(0);
    await run.done;

    expect(spawnSpy.mock.calls[0]?.[0]).toBe('gemini'); // unchanged → ENOENT-clean fallback
  });

  it('falls back to the original command when `where` reports success but stdout is empty', async () => {
    setPlatform('win32');
    stubCliPaths();

    const spawnSyncSpy = vi.fn().mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      pid: 0,
      output: [],
      signal: null,
    });
    const { child, triggerExit } = makeFakeChild();
    const spawnSpy = vi.fn((_cmd: string, _args: string[], _opts?: object) => child);

    vi.doMock('node:child_process', () => ({
      spawn: spawnSpy,
      spawnSync: spawnSyncSpy,
    }));
    vi.doMock('child_process', () => ({
      spawn: spawnSpy,
      spawnSync: spawnSyncSpy,
    }));

    const { spawnHeadless } = await import('../src/daemon/headless');
    const run = spawnHeadless({
      command: 'kimi',
      args: [],
      cwd: process.cwd(),
      parseLine: () => [],
      cli: 'kimi',
    });
    triggerExit(0);
    await run.done;

    expect(spawnSpy.mock.calls[0]?.[0]).toBe('kimi');
  });

  it('preserves an absolute command path without invoking `where`', async () => {
    setPlatform('win32');
    stubCliPaths();

    const spawnSyncSpy = vi.fn();
    const { child, triggerExit } = makeFakeChild();
    const spawnSpy = vi.fn((_cmd: string, _args: string[], _opts?: object) => child);

    vi.doMock('node:child_process', () => ({
      spawn: spawnSpy,
      spawnSync: spawnSyncSpy,
    }));
    vi.doMock('child_process', () => ({
      spawn: spawnSpy,
      spawnSync: spawnSyncSpy,
    }));

    const { spawnHeadless } = await import('../src/daemon/headless');
    const absolute = 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd';
    const run = spawnHeadless({
      command: absolute,
      args: ['--print'],
      cwd: process.cwd(),
      parseLine: () => [],
      cli: 'claude',
    });
    triggerExit(0);
    await run.done;

    expect(spawnSyncSpy).not.toHaveBeenCalled();
    expect(spawnSpy.mock.calls[0]?.[0]).toBe(absolute);

    const opts = spawnSpy.mock.calls[0]?.[2] as { shell?: boolean };
    expect(opts.shell).toBe(true); // still shell:true on Windows
  });
});

describe('spawnHeadless shell:true gating', () => {
  it('does NOT set shell:true on darwin', async () => {
    setPlatform('darwin');
    stubCliPaths();

    const spawnSyncSpy = vi.fn();
    const { child, triggerExit } = makeFakeChild();
    const spawnSpy = vi.fn((_cmd: string, _args: string[], _opts?: object) => child);

    vi.doMock('node:child_process', () => ({
      spawn: spawnSpy,
      spawnSync: spawnSyncSpy,
    }));
    vi.doMock('child_process', () => ({
      spawn: spawnSpy,
      spawnSync: spawnSyncSpy,
    }));

    const { spawnHeadless } = await import('../src/daemon/headless');
    const run = spawnHeadless({
      command: 'claude',
      args: ['--print'],
      cwd: process.cwd(),
      parseLine: () => [],
      cli: 'claude',
    });
    triggerExit(0);
    await run.done;

    const opts = spawnSpy.mock.calls[0]?.[2] as { shell?: boolean };
    expect(opts.shell).toBe(false);
    expect(spawnSyncSpy).not.toHaveBeenCalled();
  });
});
