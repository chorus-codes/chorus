/**
 * Crash hook tests — covers the canonical src/cli/crash-hook.ts module.
 * The inline twin in bin/chorus.mjs is intentionally not unit-tested
 * (it's a plain-ESM entry point); behavioural parity is reviewed on
 * source change.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { installCrashHook, _testing } from '@/cli/crash-hook';

beforeEach(() => {
  _testing.reset();
});

describe('buildCrashLog', () => {
  it('formats Error with stack', () => {
    const err = new Error('boom');
    const body = _testing.buildCrashLog(err, 'uncaughtException', '0.9.0');
    expect(body).toContain('chorus:       0.9.0');
    expect(body).toContain('source:       uncaughtException');
    expect(body).toContain('Error: boom');
    expect(body).toContain('## Error');
  });

  it('handles non-Error throw values without crashing', () => {
    const body = _testing.buildCrashLog('plain string', 'unhandledRejection', '0.9.0');
    expect(body).toContain('plain string');
    expect(body).toContain('source:       unhandledRejection');
  });

  it('handles undefined', () => {
    const body = _testing.buildCrashLog(undefined, 'uncaughtException', '0.9.0');
    expect(body).toContain('undefined');
  });
});

describe('writeCrashFile', () => {
  it('writes to the target dir, creating it if absent', () => {
    const tmp = path.join(os.tmpdir(), `chorus-crash-${Date.now()}-${Math.random()}`);
    expect(fs.existsSync(tmp)).toBe(false);
    const file = _testing.writeCrashFile(tmp, 'hello\n');
    expect(file).not.toBeNull();
    if (file) {
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.readFileSync(file, 'utf-8')).toBe('hello\n');
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null on write failure (read-only target) without throwing', () => {
    // /dev/null/something is guaranteed-unwritable on POSIX. Skip on
    // Windows where the path semantics differ.
    if (process.platform === 'win32') return;
    const file = _testing.writeCrashFile('/dev/null/cannot-mkdir', 'x');
    expect(file).toBeNull();
  });
});

describe('installCrashHook', () => {
  it('captures uncaughtException, writes a log, and calls exit', async () => {
    const tmp = path.join(os.tmpdir(), `chorus-hook-${Date.now()}-${Math.random()}`);
    const stderrChunks: string[] = [];
    let exitCode: number | null = null;

    installCrashHook({
      crashDir: tmp,
      stderr: (msg) => stderrChunks.push(msg),
      exit: (code) => {
        exitCode = code;
      },
      version: '0.9.0',
    });

    process.emit('uncaughtException', new Error('test crash'));

    // Hook is synchronous after emit; but exit is invoked from inside
    // the listener — give the runtime one tick to settle.
    await new Promise((r) => setImmediate(r));

    expect(exitCode).toBe(1);
    const out = stderrChunks.join('');
    expect(out).toContain('Chorus crashed (uncaughtException)');
    expect(out).toContain('test crash');
    expect(out).toContain('issues/new');

    const files = fs.readdirSync(tmp).filter((n) => n.endsWith('.log'));
    expect(files).toHaveLength(1);
    const body = fs.readFileSync(path.join(tmp, files[0]), 'utf-8');
    expect(body).toContain('Error: test crash');
    expect(body).toContain('chorus:       0.9.0');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('captures unhandledRejection', async () => {
    _testing.reset();
    const tmp = path.join(os.tmpdir(), `chorus-hook-${Date.now()}-${Math.random()}`);
    const stderrChunks: string[] = [];
    let exitCode: number | null = null;

    installCrashHook({
      crashDir: tmp,
      stderr: (msg) => stderrChunks.push(msg),
      exit: (code) => {
        exitCode = code;
      },
    });

    process.emit('unhandledRejection', new Error('rejected'), Promise.resolve());

    await new Promise((r) => setImmediate(r));

    expect(exitCode).toBe(1);
    expect(stderrChunks.join('')).toContain('unhandledRejection');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('is idempotent — second install does not double-register listeners', () => {
    const before = process.listenerCount('uncaughtException');
    installCrashHook({ crashDir: '/tmp/never', stderr: () => {}, exit: () => {} });
    const after1 = process.listenerCount('uncaughtException');
    installCrashHook({ crashDir: '/tmp/never', stderr: () => {}, exit: () => {} });
    const after2 = process.listenerCount('uncaughtException');
    // First install adds 1 listener; second install must not add another.
    expect(after1 - before).toBe(1);
    expect(after2 - after1).toBe(0);
  });

  it('_testing.reset() detaches the registered process listeners', () => {
    const before = process.listenerCount('uncaughtException');
    installCrashHook({ crashDir: '/tmp/never', stderr: () => {}, exit: () => {} });
    expect(process.listenerCount('uncaughtException') - before).toBe(1);
    expect(process.listenerCount('unhandledRejection')).toBeGreaterThan(0);

    _testing.reset();

    // After reset, the listener count returns to baseline. Without
    // this, every test that calls install grows the listener chain
    // and a real crash would fire all of them — exit(1) on the first,
    // then orphan callbacks on subsequent fires (Node warns at 11+).
    expect(process.listenerCount('uncaughtException')).toBe(before);
  });

  it('still nudges to stderr when crash file write fails', async () => {
    if (process.platform === 'win32') return;
    _testing.reset();
    const stderrChunks: string[] = [];
    let exitCode: number | null = null;

    installCrashHook({
      crashDir: '/dev/null/cannot-mkdir',
      stderr: (msg) => stderrChunks.push(msg),
      exit: (code) => {
        exitCode = code;
      },
    });

    process.emit('uncaughtException', new Error('write-blocked'));
    await new Promise((r) => setImmediate(r));

    expect(exitCode).toBe(1);
    const out = stderrChunks.join('');
    expect(out).toContain('could not write crash log');
    expect(out).toContain('issues/new');
    // When the file write fails, the hook prints the full body inline
    // so the user has SOMETHING to paste.
    expect(out).toContain('Error: write-blocked');
  });
});
