/**
 * Unit tests for cli-detect.ts utility functions.
 * Tests: buildVersionSpawn, validateCliPath
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

import {
  buildVersionSpawn,
  validateCliPath,
} from '../src/lib/cli-detect.js';

const IS_WIN = os.platform() === 'win32';

// validateCliPath stats the file (lstat → realpath) to defend against the
// symlink-swap TOCTOU described inline in the source. We can't point at
// a hardcoded /usr/local/bin/claude because contributors / CI may not
// have claude-code installed — tests would pass on author's laptop and
// fail in CI. Stage a real file under a tempdir with the right basename
// per-test instead.
let tmpDir: string;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-cli-detect-'));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
function stageBinary(name: string): string {
  // Unique-suffix the directory so the same basename can be staged
  // multiple times across tests without colliding (e.g., claude + claude.cmd).
  // The stub must echo a string matching CLI_SIGNATURES[cli] — for
  // claude-code that's /\bclaude\b/i. verifyRunnable spawns the binary
  // with --version and pattern-matches the output, so an empty stub
  // would fail the signature gate even though the file exists.
  const dir = path.join(tmpDir, randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, name);
  fs.writeFileSync(full, '#!/bin/sh\necho "claude 0.0.0-test"\n', { mode: 0o755 });
  return full;
}

describe('buildVersionSpawn', () => {
  it('returns {cmd, args} for unix paths (non-Windows)', () => {
    const spec = buildVersionSpawn('/usr/local/bin/claude');
    expect(spec).toEqual({ cmd: '/usr/local/bin/claude', args: ['--version'] });
    expect(spec.shell).toBeUndefined();
  });

  it('rejects unsafe Windows .cmd paths (injection guard)', () => {
    const spec = buildVersionSpawn('/home/user/malicious.cmd');
    expect(spec).toEqual({ cmd: '/home/user/malicious.cmd', args: ['--version'] });
    expect(spec.shell).toBeUndefined();
  });

  it('accepts safe Windows C:\\ path, returns shell:true for .cmd/.bat', () => {
    const spec = buildVersionSpawn('C:\\tools\\codex.bat', true);
    expect(spec.shell).toBe(true);
    expect(spec.args).toEqual([]);
  });

  it('accepts safe Windows C:\\ path for .ps1 (no shell wrap needed)', () => {
    const spec = buildVersionSpawn('C:\\tools\\kimi.ps1', true);
    expect(spec.args).toEqual(['--version']);
    expect(spec.shell).toBeUndefined();
  });

  it('rejects Windows path with cmd.exe metacharacters (pipe, ampersand etc)', () => {
    const evil = 'C:\\tools\\kimi.ps1&malware';
    const spec = buildVersionSpawn(evil, true);
    expect(spec).toEqual({ cmd: evil, args: ['--version'] });
    expect(spec.shell).toBeUndefined();
  });

  it('rejects Windows path with cmd.exe metacharacters (semicolon)', () => {
    const evil = 'C:\\tools\\kimi.ps1;rm -rf /';
    const spec = buildVersionSpawn(evil, true);
    expect(spec).toEqual({ cmd: evil, args: ['--version'] });
    expect(spec.shell).toBeUndefined();
  });

  it('rejects Windows path with cmd.exe metacharacters (pipe)', () => {
    const evil = 'C:\\tools\\kimi.ps1|dir';
    const spec = buildVersionSpawn(evil, true);
    expect(spec).toEqual({ cmd: evil, args: ['--version'] });
    expect(spec.shell).toBeUndefined();
  });

  it('rejects Windows path with cmd.exe metacharacters (backtick)', () => {
    const evil = 'C:\\tools\\kimi.ps1`whoami';
    const spec = buildVersionSpawn(evil, true);
    expect(spec).toEqual({ cmd: evil, args: ['--version'] });
    expect(spec.shell).toBeUndefined();
  });

  it('accepts safe Windows Unix-style path under msys64', () => {
    const spec = buildVersionSpawn('C:\\msys64\\usr\\bin\\opencode', true);
    expect(spec.args).toEqual(['--version']);
    expect(spec.shell).toBeUndefined();
  });

  it('does not shell-escalate non-.cmd/.bat Windows executables', () => {
    const spec = buildVersionSpawn('C:\\msys64\\usr\\bin\\opencode', true);
    expect(spec.shell).toBeUndefined();
  });
});

describe('validateCliPath — basename gate', () => {
  it('returns found:true for correct binary name (claude)', () => {
    const staged = stageBinary('claude');
    const result = validateCliPath('claude-code', staged);
    expect(result.found).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns found:false when basename does not match', () => {
    // Basename gate runs BEFORE the file-existence check, so a
    // never-existing path is fine here — the test exercises the
    // basename mismatch branch, nothing else.
    const result = validateCliPath('claude-code', '/usr/local/bin/npm');
    expect(result.found).toBe(false);
    expect(result.reason).toContain('named "npm"');
    expect(result.reason).toContain('claude');
  });

  it('returns found:false for empty path', () => {
    const result = validateCliPath('claude-code', '   ');
    expect(result.found).toBe(false);
    expect(result.reason).toContain('path is empty');
  });

  it('returns found:false for empty string', () => {
    const result = validateCliPath('claude-code', '');
    expect(result.found).toBe(false);
    expect(result.reason).toContain('path is empty');
  });

  it.skipIf(!IS_WIN)('strips .cmd/.bat extension on Windows before comparing basename', () => {
    // The .cmd/.exe strip in validateCliPath() only fires when
    // `isWindows` is true (it consults `process.platform === 'win32'`
    // at module load). On unix the strip is a no-op and basename
    // "claude.cmd" doesn't equal "claude" — so this assertion is only
    // valid on Windows runners.
    const staged = stageBinary('claude.cmd');
    const result = validateCliPath('claude-code', staged);
    expect(result.found).toBe(true);
  });

  it('returns found:false when file does not exist', () => {
    // Basename is right but the file is absent — exercises the lstat
    // ENOENT branch (returns reason "no file at …"). Path is inside
    // the tempdir so we don't depend on host filesystem state.
    const result = validateCliPath('claude-code', path.join(tmpDir, 'missing', 'claude'));
    expect(result.found).toBe(false);
    expect(result.reason).toContain('no file at');
  });
});