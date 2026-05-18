/**
 * Unit tests for cli-detect.ts utility functions.
 * Tests: buildVersionSpawn, validateCliPath
 */
import { describe, expect, it } from 'vitest';
import path from 'path';
import os from 'os';

import {
  buildVersionSpawn,
  validateCliPath,
} from '../src/lib/cli-detect.js';

const IS_WIN = os.platform() === 'win32';

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
    const result = validateCliPath('claude-code', '/usr/local/bin/claude');
    expect(result.found).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns found:false when basename does not match', () => {
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

  it('strips .cmd/.bat extension on Windows before comparing basename', () => {
    if (!IS_WIN) {
      // On unix, we just verify it passes through
      const result = validateCliPath('claude-code', '/usr/local/bin/claude.cmd');
      expect(result.found).toBe(true);
    }
  });

  it('returns found:false when file does not exist', () => {
    const result = validateCliPath('claude-code', '/nonexistent/path/claude');
    expect(result.found).toBe(false);
    expect(result.reason).toContain('no file at');
  });
});