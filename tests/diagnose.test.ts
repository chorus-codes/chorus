/**
 * Diagnose command tests — focuses on the pure helpers and the format
 * output. The full `gather()` function does network + DB + fs reads
 * that are awkward to fake in unit tests; those paths are covered
 * implicitly via integration (`chorus diagnose` run by hand) and via
 * the formatReport assertions below using a fixture snapshot.
 */

import { describe, expect, it } from 'vitest';
import os from 'os';
import { _testing } from '@/cli/commands/diagnose';

const { detectInstallMode, abbreviateHome, formatReport } = _testing;

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
    });
    expect(out).toContain('count:           2');
    expect(out).toContain('2026-05-08T10-00-00.log');
    expect(out).toContain('Error: boom');
  });
});
