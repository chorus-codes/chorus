/**
 * Tests for runtime-env detection — specifically the remote-dev helpers
 * added to surface VSCode/Cursor/Codespaces port-forward staleness after
 * a daemon restart.
 *
 * The bug class: editor proxies cache port→PID bindings. After
 * `chorus stop && chorus start` the next-server PID changes, but the
 * editor keeps forwarding 5050 to the dead PID — the browser shows a
 * blank page even though `curl localhost:5050` from the SAME shell
 * returns the new daemon's HTML. The hint walks the user through the
 * two-click fix in the Ports panel.
 */
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import {
  detectRuntimeEnv,
  isRemoteDevEnv,
  remoteRestartHint,
} from '../src/cli/runtime-env.js';

const ENV_KEYS = [
  'CODESPACES',
  'VSCODE_IPC_HOOK_CLI',
  'TERM_PROGRAM',
  'CURSOR_TRACE_ID',
  'WSL_DISTRO_NAME',
  'SSH_CONNECTION',
  'SSH_TTY',
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('isRemoteDevEnv', () => {
  it('flags VSCode Remote, Cursor Remote, and Codespaces', () => {
    expect(isRemoteDevEnv({ kind: 'vscode-remote', hint: '' })).toBe(true);
    expect(isRemoteDevEnv({ kind: 'cursor-remote', hint: '' })).toBe(true);
    expect(isRemoteDevEnv({ kind: 'codespaces', hint: '' })).toBe(true);
  });

  it('does NOT flag native, wsl, or plain SSH', () => {
    // ssh -L is user-managed — the user owns the tunnel lifecycle and
    // restart-staleness is not the editor's fault. Don't nag them.
    expect(isRemoteDevEnv({ kind: 'native', hint: '' })).toBe(false);
    expect(isRemoteDevEnv({ kind: 'wsl', hint: '' })).toBe(false);
    expect(isRemoteDevEnv({ kind: 'ssh', hint: '' })).toBe(false);
  });
});

describe('remoteRestartHint', () => {
  it('returns empty string for non-remote-dev kinds', () => {
    expect(remoteRestartHint({ kind: 'native', hint: '' })).toBe('');
    expect(remoteRestartHint({ kind: 'wsl', hint: '' })).toBe('');
    expect(remoteRestartHint({ kind: 'ssh', hint: '' })).toBe('');
  });

  it('names VSCode for vscode-remote', () => {
    const hint = remoteRestartHint({ kind: 'vscode-remote', hint: '' });
    expect(hint).toContain('VSCode');
    expect(hint).toContain('5050');
    expect(hint).toContain('Ports');
  });

  it('names Cursor for cursor-remote', () => {
    const hint = remoteRestartHint({ kind: 'cursor-remote', hint: '' });
    expect(hint).toContain('Cursor');
    expect(hint).not.toContain('VSCode');
  });

  it('names Codespaces for codespaces', () => {
    const hint = remoteRestartHint({ kind: 'codespaces', hint: '' });
    expect(hint).toContain('Codespaces');
  });
});

describe('detectRuntimeEnv — env-driven smoke checks', () => {
  it('detects Codespaces from CODESPACES=true', () => {
    process.env.CODESPACES = 'true';
    expect(detectRuntimeEnv().kind).toBe('codespaces');
  });

  it('detects VSCode from VSCODE_IPC_HOOK_CLI', () => {
    process.env.VSCODE_IPC_HOOK_CLI = '/tmp/vscode.sock';
    expect(detectRuntimeEnv().kind).toBe('vscode-remote');
  });

  it('detects Cursor when TERM_PROGRAM=cursor', () => {
    process.env.VSCODE_IPC_HOOK_CLI = '/tmp/vscode.sock';
    process.env.TERM_PROGRAM = 'cursor';
    expect(detectRuntimeEnv().kind).toBe('cursor-remote');
  });

  it('falls through to native with no signals', () => {
    expect(detectRuntimeEnv().kind).toBe('native');
  });
});
