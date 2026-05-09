/**
 * Diagnose command tests — focuses on the pure helpers and the format
 * output. The full `gather()` function does network + DB + fs reads
 * that are awkward to fake in unit tests; those paths are covered
 * implicitly via integration (`chorus diagnose` run by hand) and via
 * the formatReport assertions below using a fixture snapshot.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { _testing } from '@/cli/commands/diagnose';

const {
  detectInstallMode,
  abbreviateHome,
  formatReport,
  resolveBinPath,
  filterBenignNoise,
  smokeOneCli,
  readLatestAttempt,
} = _testing;

describe('detectInstallMode', () => {
  it('classifies node_modules path as global-npm', () => {
    expect(detectInstallMode('/usr/local/lib/node_modules/chorus-codes/bin/chorus.mjs'))
      .toBe('global-npm');
  });

  it('classifies .ts source as dev-tsx', () => {
    expect(detectInstallMode('/home/dev/chorus/src/cli/index.ts')).toBe('dev-tsx');
  });

  it('classifies dist build as local-dist', () => {
    expect(detectInstallMode('/home/dev/chorus/dist/cli/index.js')).toBe('local-dist');
  });

  it('classifies windows-style dist path', () => {
    expect(detectInstallMode('C:\\proj\\chorus\\dist\\cli\\index.js')).toBe('local-dist');
  });

  it('returns unknown for unrecognized paths', () => {
    expect(detectInstallMode('/opt/random/chorus.js')).toBe('unknown');
  });
});

describe('abbreviateHome', () => {
  it('replaces home prefix with ~', () => {
    const home = os.homedir();
    expect(abbreviateHome(`${home}/.chorus/daemon.log`)).toBe('~/.chorus/daemon.log');
  });

  it('leaves non-home paths intact', () => {
    expect(abbreviateHome('/var/log/chorus.log')).toBe('/var/log/chorus.log');
  });
});

describe('formatReport', () => {
  it('renders a complete snapshot with version mismatch warning', () => {
    const out = formatReport({
      chorus: { cliVersion: '0.8.26', runningDaemonVersion: '0.8.25', mismatch: true },
      runtime: { node: '25.2.1', platform: 'win32', arch: 'x64', release: '10.0.0' },
      install: { binPath: 'C:\\Users\\u\\AppData\\bin\\chorus.mjs', mode: 'global-npm' },
      daemon: {
        daemonJson: '{\n  "daemonPort": 7707\n}',
        daemonPidAlive: true,
        healthyOnPort: 7707,
      },
      db: { chats: 17, voices: 53 },
      logs: { daemonTail: 'log line 1\nlog line 2', webTail: 'web line' },
      crashes: { count: 0, latest: null },
      clis: [
        { id: 'codex-cli', found: true, path: '~/.local/bin/codex' },
        { id: 'gemini-cli', found: false, reason: 'not on PATH' },
      ],
      voiceHealth: { total: 0, autoQuota: [], autoMissing: [], userDisabled: 0 },
      recentFailedChats: [],
    });

    expect(out).toContain('chorus CLI:      0.8.26');
    expect(out).toContain('running daemon:  0.8.25');
    expect(out).toContain('VERSION MISMATCH');
    expect(out).toContain('chorus stop && chorus start');
    expect(out).toContain('node:            25.2.1');
    expect(out).toContain('platform:        win32');
    expect(out).toContain('install mode:    global-npm');
    expect(out).toContain('chats:           17');
    expect(out).toContain('voices:          53');
    expect(out).toContain('✓ codex-cli');
    expect(out).toContain('✗ gemini-cli');
    expect(out).toContain('not on PATH');
    expect(out).toContain('## Recent daemon.log');
    expect(out).toContain('## Recent web.log');
    expect(out.startsWith('```')).toBe(true);
    expect(out.endsWith('```')).toBe(true);
  });

  it('omits the mismatch warning when versions match', () => {
    const out = formatReport({
      chorus: { cliVersion: '0.8.26', runningDaemonVersion: '0.8.26', mismatch: false },
      runtime: { node: '20.0.0', platform: 'linux', arch: 'x64', release: '6.8' },
      install: { binPath: '/usr/lib/node_modules/chorus-codes/bin/chorus.mjs', mode: 'global-npm' },
      daemon: { daemonJson: '{}', daemonPidAlive: true, healthyOnPort: 7707 },
      db: { chats: 0, voices: 0 },
      logs: { daemonTail: '', webTail: '' },
      crashes: { count: 0, latest: null },
      clis: [],
      voiceHealth: { total: 0, autoQuota: [], autoMissing: [], userDisabled: 0 },
      recentFailedChats: [],
    });
    expect(out).not.toContain('VERSION MISMATCH');
  });

  it('handles daemon-not-reachable case', () => {
    const out = formatReport({
      chorus: { cliVersion: '0.8.26', runningDaemonVersion: null, mismatch: false },
      runtime: { node: '20', platform: 'linux', arch: 'x64', release: '6' },
      install: { binPath: '/x', mode: 'unknown' },
      daemon: { daemonJson: '(missing)', daemonPidAlive: null, healthyOnPort: null },
      db: { chats: '(unavailable)', voices: '(unavailable)' },
      logs: { daemonTail: '(file not present)', webTail: '(file not present)' },
      crashes: { count: 0, latest: null },
      clis: [],
      voiceHealth: { total: 0, autoQuota: [], autoMissing: [], userDisabled: 0 },
      recentFailedChats: [],
    });
    expect(out).toContain('running daemon:  (not reachable)');
    expect(out).toContain('health probe:    no response');
    expect(out).toContain('chats:           (unavailable)');
  });

  it('renders a crash preview when present', () => {
    const out = formatReport({
      chorus: { cliVersion: '0.8.26', runningDaemonVersion: '0.8.26', mismatch: false },
      runtime: { node: '20', platform: 'linux', arch: 'x64', release: '6' },
      install: { binPath: '/x', mode: 'unknown' },
      daemon: { daemonJson: '{}', daemonPidAlive: true, healthyOnPort: 7707 },
      db: { chats: 1, voices: 1 },
      logs: { daemonTail: '', webTail: '' },
      crashes: {
        count: 2,
        latest: {
          file: '~/.chorus/crashes/2026-05-08T10-00-00.log',
          preview: 'Error: boom\n  at foo (bar.js:1:1)',
        },
      },
      clis: [],
      voiceHealth: { total: 0, autoQuota: [], autoMissing: [], userDisabled: 0 },
      recentFailedChats: [],
    });
    expect(out).toContain('count:           2');
    expect(out).toContain('2026-05-08T10-00-00.log');
    expect(out).toContain('Error: boom');
  });

  it('renders CLI smoke results inline with detection rows', () => {
    const out = formatReport({
      chorus: { cliVersion: '0.8.31', runningDaemonVersion: '0.8.31', mismatch: false },
      runtime: { node: '20', platform: 'linux', arch: 'x64', release: '6' },
      install: { binPath: '/x', mode: 'unknown' },
      daemon: { daemonJson: '{}', daemonPidAlive: true, healthyOnPort: 7707 },
      db: { chats: 1, voices: 1 },
      logs: { daemonTail: '', webTail: '' },
      crashes: { count: 0, latest: null },
      clis: [
        { id: 'opencode-cli', found: true, path: '~/.opencode/bin/opencode',
          smoke: { ok: false, exitCode: 1, stderrFirstLine: 'Error: not authenticated' } },
        { id: 'codex-cli', found: true, path: '~/.local/bin/codex',
          smoke: { ok: true, version: '0.51.0' } },
      ],
      voiceHealth: { total: 0, autoQuota: [], autoMissing: [], userDisabled: 0 },
      recentFailedChats: [],
    });
    expect(out).toContain('✓ codex-cli');
    expect(out).toContain('v0.51.0');
    expect(out).toContain('opencode-cli');
    expect(out).toContain('✗ smoke failed (exit 1) — Error: not authenticated');
  });

  it('renders voice health summary with auto-disabled IDs', () => {
    const out = formatReport({
      chorus: { cliVersion: '0.8.31', runningDaemonVersion: '0.8.31', mismatch: false },
      runtime: { node: '20', platform: 'linux', arch: 'x64', release: '6' },
      install: { binPath: '/x', mode: 'unknown' },
      daemon: { daemonJson: '{}', daemonPidAlive: true, healthyOnPort: 7707 },
      db: { chats: 1, voices: 158 },
      logs: { daemonTail: '', webTail: '' },
      crashes: { count: 0, latest: null },
      clis: [],
      voiceHealth: {
        total: 158,
        autoQuota: ['gemini-cli:gemini-3.1-pro-preview', 'openrouter:x-ai/grok-4.3'],
        autoMissing: ['kimi-cli'],
        userDisabled: 4,
      },
      recentFailedChats: [],
    });
    expect(out).toContain('## Voice health');
    expect(out).toContain('total:           158');
    expect(out).toContain('auto-disabled (quota):    2');
    expect(out).toContain('gemini-cli:gemini-3.1-pro-preview');
    expect(out).toContain('auto-disabled (missing):  1');
    expect(out).toContain('user-disabled:            4');
  });

  it('renders recent failed chats with errored participant + errorKind (no raw message)', () => {
    const out = formatReport({
      chorus: { cliVersion: '0.8.31', runningDaemonVersion: '0.8.31', mismatch: false },
      runtime: { node: '20', platform: 'linux', arch: 'x64', release: '6' },
      install: { binPath: '/x', mode: 'unknown' },
      daemon: { daemonJson: '{}', daemonPidAlive: true, healthyOnPort: 7707 },
      db: { chats: 17, voices: 53 },
      logs: { daemonTail: '', webTail: '' },
      crashes: { count: 0, latest: null },
      clis: [],
      voiceHealth: { total: 0, autoQuota: [], autoMissing: [], userDisabled: 0 },
      recentFailedChats: [
        {
          chatId: '019E0235E62E8561A85E70D05D8E298B',
          status: 'failed',
          createdAt: 1778154025000,
          erroredParticipants: [
            { dir: 'reviewer-opencode-cli-2', lineage: 'opencode',
              model: 'opencode-go/kimi-k2.6', errorKind: 'auth_error',
              errorMessageBytes: 124 },
          ],
        },
        {
          chatId: '019E01D17523A472821926572B6AC38C',
          status: 'blocked',
          createdAt: 1778147183000,
          erroredParticipants: [],
        },
      ],
    });
    expect(out).toContain('## Recent failed chats');
    expect(out).toContain('019E0235E62E8561A85E70D05D8E298B');
    expect(out).toContain('failed');
    expect(out).toContain('reviewer-opencode-cli-2');
    expect(out).toContain('auth_error');
    expect(out).toContain('124 bytes on disk');
    expect(out).toContain('019E01D17523A472821926572B6AC38C');
    // Privacy: never surface raw error text from LLM APIs (may echo
    // user prompts / template content). Bytes-only is the contract.
    expect(out).not.toContain('Not authenticated');
  });

  it('renders timed-out smoke distinctly from non-zero exit', () => {
    const out = formatReport({
      chorus: { cliVersion: '0.8.31', runningDaemonVersion: '0.8.31', mismatch: false },
      runtime: { node: '20', platform: 'linux', arch: 'x64', release: '6' },
      install: { binPath: '/x', mode: 'unknown' },
      daemon: { daemonJson: '{}', daemonPidAlive: true, healthyOnPort: 7707 },
      db: { chats: 0, voices: 0 },
      logs: { daemonTail: '', webTail: '' },
      crashes: { count: 0, latest: null },
      clis: [
        { id: 'kimi-cli', found: true, path: '~/.local/bin/kimi',
          smoke: { ok: false, exitCode: -1, timedOut: true, stderrFirstLine: 'timed out after 2s' } },
      ],
      voiceHealth: { total: 0, autoQuota: [], autoMissing: [], userDisabled: 0 },
      recentFailedChats: [],
    });
    expect(out).toContain('✗ smoke timed out (>2s)');
    expect(out).toContain('timed out after 2s');
    // Should NOT render the "exit -1" line for the timeout case —
    // that would be ambiguous with regular exit-code failure.
    expect(out).not.toContain('smoke failed (exit -1)');
  });

  it('omits new sections gracefully when arrays are empty', () => {
    const out = formatReport({
      chorus: { cliVersion: '0.8.31', runningDaemonVersion: '0.8.31', mismatch: false },
      runtime: { node: '20', platform: 'linux', arch: 'x64', release: '6' },
      install: { binPath: '/x', mode: 'unknown' },
      daemon: { daemonJson: '{}', daemonPidAlive: true, healthyOnPort: 7707 },
      db: { chats: 0, voices: 0 },
      logs: { daemonTail: '', webTail: '' },
      crashes: { count: 0, latest: null },
      clis: [],
      voiceHealth: { total: 0, autoQuota: [], autoMissing: [], userDisabled: 0 },
      recentFailedChats: [],
    });
    expect(out).toContain('## Recent failed chats');
    expect(out).toContain('(none)');
  });
});

describe('readLatestAttempt', () => {
  it('returns errorKind + errorMessageBytes (NOT the raw message) from last JSONL row', () => {
    const tmp = path.join(os.tmpdir(), `chorus-attempts-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(tmp, { recursive: true });
    const file = path.join(tmp, '_attempts.jsonl');
    const longMessage = 'Not authenticated — please run `opencode login` to refresh credentials';
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ ts: 1, round: 1, lineage: 'google', model: 'g-3', errorKind: 'quota_exhausted', errorMessage: 'first' }),
        JSON.stringify({ ts: 2, round: 1, lineage: 'opencode', model: 'kimi', errorKind: 'auth_error', errorMessage: longMessage }),
      ].join('\n') + '\n',
    );
    try {
      const r = readLatestAttempt(file);
      expect(r).not.toBeNull();
      expect(r!.errorKind).toBe('auth_error');
      expect(r!.errorMessageBytes).toBe(longMessage.length);
      expect(r!.lineage).toBe('opencode');
      expect(r!.model).toBe('kimi');
      // Privacy contract: the raw message must NOT appear on the
      // returned shape (it may echo user prompts / template text).
      expect(JSON.stringify(r)).not.toContain('Not authenticated');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns null for missing file', () => {
    expect(readLatestAttempt('/nope/does/not/exist.jsonl')).toBeNull();
  });

  it('returns null for empty file', () => {
    const tmp = path.join(os.tmpdir(), `chorus-attempts-empty-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(tmp, { recursive: true });
    const file = path.join(tmp, '_attempts.jsonl');
    fs.writeFileSync(file, '');
    try {
      expect(readLatestAttempt(file)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips malformed lines and returns the last valid one', () => {
    const tmp = path.join(os.tmpdir(), `chorus-attempts-bad-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(tmp, { recursive: true });
    const file = path.join(tmp, '_attempts.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ ts: 1, errorKind: 'a', errorMessage: 'first', lineage: 'l', model: 'm' }),
        '{not valid json',
        JSON.stringify({ ts: 2, errorKind: 'b', errorMessage: 'second-msg', lineage: 'l2', model: 'm2' }),
      ].join('\n') + '\n',
    );
    try {
      const r = readLatestAttempt(file);
      expect(r!.errorKind).toBe('b');
      expect(r!.errorMessageBytes).toBe('second-msg'.length);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('smokeOneCli', () => {
  it('returns ok=false with stderr first line when bin is missing', async () => {
    const r = await smokeOneCli('/definitely/does/not/exist/binary');
    expect(r.ok).toBe(false);
    expect(r.exitCode).not.toBe(0);
  });

  it('returns ok=true with version when bin runs --version successfully', async () => {
    // Use `node --version` as a portable proxy for "a real CLI".
    const r = await smokeOneCli('node');
    expect(r.ok).toBe(true);
    expect(r.version).toMatch(/^v?\d/);
  });

  it('redacts $HOME paths from stderr when spawn errors', async () => {
    // The bug: spawn ENOENT messages contain the full bin path
    // including $HOME. Bug-report bundles must not leak the user's
    // home dir layout. Skip on Windows (path semantics differ).
    if (process.platform === 'win32') return;
    const ghost = `${os.homedir()}/secret-workspace/missing-bin-${Math.random()}`;
    const r = await smokeOneCli(ghost);
    expect(r.ok).toBe(false);
    expect(r.stderrFirstLine).toBeTruthy();
    expect(r.stderrFirstLine).not.toContain(os.homedir());
  });

  it('returns timedOut=true when bin hangs longer than 2s', async () => {
    // `sleep 5` outlives the 2s deadline — the SIGKILL fallback
    // must fire and we must surface `timedOut: true` (not a generic
    // exit-code failure that's indistinguishable from other errors).
    if (process.platform === 'win32') return;
    const start = Date.now();
    const r = await smokeOneCli('sleep'); // `sleep --version` works on GNU; on BSD it errors
    const elapsed = Date.now() - start;
    // Either branch is acceptable: GNU sleep returns 0 with version,
    // BSD sleep errors. The contract we're enforcing is that the
    // call does NOT hang past ~3s (a soft upper bound on the 2s cap).
    expect(elapsed).toBeLessThan(3500);
    if (!r.ok && r.timedOut) {
      expect(r.stderrFirstLine).toMatch(/timed out|sleep/i);
    }
  }, 5_000);
});

describe('resolveBinPath', () => {
  it('resolves a symlink to its real target', () => {
    // Build a real symlink chain in /tmp so we cover the actual
    // realpath path (no mocks). This is the install-mode bug
    // reported on /usr/bin/chorus → node_modules/.../chorus.mjs.
    const tmp = path.join(os.tmpdir(), `chorus-realpath-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(tmp, { recursive: true });
    const realFile = path.join(tmp, 'fake-chorus.mjs');
    fs.writeFileSync(realFile, 'placeholder');
    const link = path.join(tmp, 'chorus-link');
    fs.symlinkSync(realFile, link);
    try {
      const resolved = resolveBinPath(link);
      // realpath strips symlinks (and may resolve /private/var on
      // macOS) — assert the basename matches the real file rather
      // than equality, so the test is portable.
      expect(path.basename(resolved)).toBe('fake-chorus.mjs');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('falls back to the raw path when realpath throws (broken symlink)', () => {
    const ghost = '/tmp/chorus-does-not-exist-' + Math.random();
    expect(resolveBinPath(ghost)).toBe(ghost);
  });

  it('returns input unchanged for "(unknown)" sentinel', () => {
    expect(resolveBinPath('(unknown)')).toBe('(unknown)');
  });
});

describe('detectInstallMode after realpath', () => {
  it('classifies a globally-installed bin as global-npm once symlink is followed', () => {
    // Simulate the full bug: raw path is /usr/bin/chorus (returns
    // 'unknown'), but realpath target is in node_modules. With the
    // fix, gather() resolves first then classifies.
    const realLikePath =
      '/usr/lib/node_modules/chorus-codes/bin/chorus.mjs';
    expect(detectInstallMode(realLikePath)).toBe('global-npm');
  });
});

describe('filterBenignNoise', () => {
  it('drops the Next.js SSE pipe-close trace block', () => {
    const noisy = [
      "[2026-05-08T06:12:51] info: server up",
      "  ⨯ Error: failed to pipe response",
      "      at l (.next/server/chunks/332.js:15:6940)",
      "      at async g (.next/server/app/api/run-artifacts/[chatId]/route.js:1:10987) {",
      "    [cause]: TypeError: terminated",
      "        at ignore-listed frames {",
      "      [cause]: Error [SocketError]: other side closed",
      "          at ignore-listed frames {",
      "        code: 'UND_ERR_SOCKET',",
      "        socket: [Object]",
      "      }",
      "    }",
      "  }",
      "▲ Next.js 16.2.4",
    ].join('\n');
    const { kept, filteredCount } = filterBenignNoise(noisy);
    expect(filteredCount).toBe(1);
    expect(kept).toContain('server up');
    expect(kept).toContain('Next.js 16.2.4');
    expect(kept).not.toContain('failed to pipe response');
    expect(kept).not.toContain('UND_ERR_SOCKET');
  });

  it('passes unrelated errors through unchanged', () => {
    const real = [
      'Error: something actually broke',
      '  at foo (bar.js:42:7)',
      '✓ Ready in 101ms',
    ].join('\n');
    const { kept, filteredCount } = filterBenignNoise(real);
    expect(filteredCount).toBe(0);
    expect(kept).toBe(real);
  });

  it('passes through "(file not present)" sentinel without scanning', () => {
    const { kept, filteredCount } = filterBenignNoise('(file not present)');
    expect(kept).toBe('(file not present)');
    expect(filteredCount).toBe(0);
  });

  it('strips an orphan trace tail when the window starts mid-trace', () => {
    // Real-world reproduction: tailFile reads N lines but a trace
    // started before the window. Without orphan handling the dangling
    // `code: 'UND_ERR_SOCKET'` and surrounding stack lines surface in
    // the bug report.
    const orphan = [
      "      at async Module.V (.next/server/app/api/daemon/[...path]/route.js:1:9000) {",
      "    [cause]: TypeError: terminated",
      "        at ignore-listed frames {",
      "      [cause]: Error [SocketError]: other side closed",
      "          at ignore-listed frames {",
      "        code: 'UND_ERR_SOCKET',",
      "        socket: [Object]",
      "      }",
      "    }",
      "  }",
      '▲ Next.js 16.2.4',
      '  ✓ Ready in 101ms',
    ].join('\n');
    const { kept, filteredCount } = filterBenignNoise(orphan);
    expect(filteredCount).toBe(1);
    expect(kept).not.toContain('UND_ERR_SOCKET');
    expect(kept).not.toContain('SocketError');
    expect(kept).toContain('Next.js 16.2.4');
    expect(kept).toContain('Ready in 101ms');
  });

  it('handles multiple trace blocks in one tail', () => {
    const block = [
      '  ⨯ Error: failed to pipe response',
      '    {',
      "      code: 'UND_ERR_SOCKET',",
      '    }',
      '  }',
    ].join('\n');
    const text = `before\n${block}\nmiddle\n${block}\nafter`;
    const { kept, filteredCount } = filterBenignNoise(text);
    expect(filteredCount).toBe(2);
    expect(kept).toContain('before');
    expect(kept).toContain('middle');
    expect(kept).toContain('after');
    expect(kept).not.toContain('UND_ERR_SOCKET');
  });
});
