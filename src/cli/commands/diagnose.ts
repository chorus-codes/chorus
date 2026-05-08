/**
 * `chorus diagnose` — copy-pasteable diagnostic bundle for bug reports.
 *
 * Differs from `chorus doctor`:
 *   - doctor: human-readable PATH/CLI detection report, actionable
 *     ("run X to fix Y").
 *   - diagnose: machine-friendly markdown block. The user pastes this
 *     into a GitHub issue; maintainer reads it.
 *
 * Output is a fenced markdown block with: chorus version, runtime
 * (node, OS, arch), install method, daemon state (PID + version
 * served on /health, version-mismatch flag if CLI vs running daemon
 * disagree), DB row counts, log tails, latest crash dump if any, CLI
 * detection summary.
 *
 * Redaction: paths under $HOME are abbreviated to `~/...`. No tokens,
 * no chat content, no telemetry payload — diagnose is read by humans.
 *
 * Failure mode: each section runs in try/catch and degrades to
 * `(unavailable)`. A broken DB or missing log file must not abort the
 * report — the very state we want to capture in a bug report often
 * involves things being broken.
 */
import type { Command } from 'commander';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isDaemonHealthy, readDaemonInfo } from '../../lib/daemon-discovery.js';
import { pkg } from '../shared.js';

const ISSUE_URL = 'https://github.com/chorus-codes/chorus/issues/new';

interface DiagnoseSnapshot {
  chorus: { cliVersion: string; runningDaemonVersion: string | null; mismatch: boolean };
  runtime: { node: string; platform: string; arch: string; release: string };
  install: { binPath: string; mode: 'global-npm' | 'dev-tsx' | 'local-dist' | 'unknown' };
  daemon: {
    daemonJson: string;
    daemonPidAlive: boolean | null;
    healthyOnPort: number | null;
  };
  db: { chats: number | string; voices: number | string };
  logs: { daemonTail: string; webTail: string };
  crashes: { count: number; latest: { file: string; preview: string } | null };
  clis: Array<{ id: string; found: boolean; path?: string; reason?: string }>;
}

function abbreviateHome(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function detectInstallMode(binPath: string): DiagnoseSnapshot['install']['mode'] {
  if (binPath.includes('node_modules')) return 'global-npm';
  if (binPath.endsWith('.ts')) return 'dev-tsx';
  if (binPath.includes('/dist/') || binPath.includes('\\dist\\')) return 'local-dist';
  return 'unknown';
}

function tailFile(p: string, lines: number): string {
  try {
    if (!fs.existsSync(p)) return '(file not present)';
    const content = fs.readFileSync(p, 'utf-8');
    const all = content.split('\n');
    return all.slice(-lines).join('\n').trim();
  } catch (err) {
    return `(read failed: ${err instanceof Error ? err.message : String(err)})`;
  }
}

async function gather(): Promise<DiagnoseSnapshot> {
  const chorusDir = path.join(os.homedir(), '.chorus');
  const cliVersion = pkg.version;

  // Daemon state — look up daemon.json and probe /health for the
  // currently-running version. Mismatch flag fires when CLI has been
  // upgraded but the running daemon is still on the old version
  // (the case the user hit after `npm install -g` without restart).
  let runningDaemonVersion: string | null = null;
  let healthyOnPort: number | null = null;
  let daemonPidAlive: boolean | null = null;
  let daemonJsonRaw = '(missing)';
  try {
    const info = readDaemonInfo();
    if (info) {
      daemonJsonRaw = JSON.stringify(info, null, 2);
      try {
        process.kill(info.daemonPid, 0);
        daemonPidAlive = true;
      } catch (err) {
        // ESRCH — process truly dead. EPERM — process exists but we
        // don't own it (sudo'd daemon, container UID mismatch). Treat
        // EPERM as alive — the daemon is there, we just can't signal
        // it. Distinguishing matters: a sudo-started daemon with a
        // user-mode CLI looks "dead" without this check, leading to
        // wrong remediation advice in the bug report.
        const code = (err as NodeJS.ErrnoException).code;
        daemonPidAlive = code === 'EPERM';
      }
      const healthy = await isDaemonHealthy(info.daemonPort, 800);
      if (healthy) {
        healthyOnPort = info.daemonPort;
        try {
          // Mirror the 800ms cap from isDaemonHealthy. Without this,
          // a daemon that passes the first health probe but stalls on
          // the second response will hang `chorus diagnose` forever —
          // the very state we're trying to capture in a bug report.
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), 800);
          try {
            const res = await fetch(
              `http://127.0.0.1:${info.daemonPort}/api/v1/health`,
              { signal: ac.signal },
            );
            const env = (await res.json()) as { data?: { version?: string } };
            if (env.data?.version) runningDaemonVersion = env.data.version;
          } finally {
            clearTimeout(timer);
          }
        } catch {
          /* health passed but version read failed/timed out — leave null */
        }
      }
    }
  } catch {
    /* daemon.json absent or malformed — leave defaults */
  }

  const mismatch =
    runningDaemonVersion !== null && runningDaemonVersion !== cliVersion;

  // DB counts — best-effort. If the daemon is on an old version with
  // a schema we can't read, we want to say "(unavailable)" not crash.
  let chatsCount: number | string = '(unavailable)';
  let voicesCount: number | string = '(unavailable)';
  try {
    const { getDb } = await import('../../lib/db/connection.js');
    const db = await getDb();
    const cr = await db.execute('SELECT COUNT(*) AS n FROM chats');
    const vr = await db.execute('SELECT COUNT(*) AS n FROM voices');
    chatsCount = Number((cr.rows[0] as unknown as { n: number }).n);
    voicesCount = Number((vr.rows[0] as unknown as { n: number }).n);
  } catch (err) {
    chatsCount = `(error: ${err instanceof Error ? err.message.slice(0, 80) : 'unknown'})`;
  }

  // Crashes — list crashes/ dir, surface the most recent file and a
  // 20-line preview. The crash hook writes here; if diagnose finds
  // entries, the user almost certainly wants to attach them.
  let crashCount = 0;
  let latestCrash: DiagnoseSnapshot['crashes']['latest'] = null;
  try {
    const crashDir = path.join(chorusDir, 'crashes');
    if (fs.existsSync(crashDir)) {
      const entries = fs
        .readdirSync(crashDir)
        .filter((n) => n.endsWith('.log'))
        .map((n) => ({ name: n, full: path.join(crashDir, n) }))
        .sort((a, b) => (a.name < b.name ? 1 : -1));
      crashCount = entries.length;
      if (entries.length > 0) {
        const head = entries[0];
        latestCrash = {
          file: abbreviateHome(head.full),
          preview: tailFile(head.full, 20),
        };
      }
    }
  } catch {
    /* crashes dir unreadable — leave defaults */
  }

  // CLI detection — reuse the same module doctor uses, but emit a
  // compact summary (no PATH visibility section; that's doctor's job).
  let clis: DiagnoseSnapshot['clis'] = [];
  try {
    const { detectAllClis } = await import('../../lib/cli-detect.js');
    const found = detectAllClis(true);
    clis = found.map((d) => ({
      id: d.id,
      found: d.found,
      path: d.path ? abbreviateHome(d.path) : undefined,
      reason: d.reason,
    }));
  } catch {
    /* detection module load failed — leave empty */
  }

  return {
    chorus: { cliVersion, runningDaemonVersion, mismatch },
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
    },
    install: {
      binPath: abbreviateHome(process.argv[1] ?? '(unknown)'),
      mode: detectInstallMode(process.argv[1] ?? ''),
    },
    daemon: { daemonJson: daemonJsonRaw, daemonPidAlive, healthyOnPort },
    db: { chats: chatsCount, voices: voicesCount },
    logs: {
      daemonTail: tailFile(path.join(chorusDir, 'logs', 'daemon.log'), 50),
      webTail: tailFile(path.join(chorusDir, 'logs', 'web.log'), 20),
    },
    crashes: { count: crashCount, latest: latestCrash },
    clis,
  };
}

export function formatReport(s: DiagnoseSnapshot): string {
  const lines: string[] = [];
  lines.push('```');
  lines.push('# Chorus diagnose');
  lines.push('');
  lines.push(`chorus CLI:      ${s.chorus.cliVersion}`);
  lines.push(
    `running daemon:  ${s.chorus.runningDaemonVersion ?? '(not reachable)'}` +
      (s.chorus.mismatch ? '   ⚠ VERSION MISMATCH — run `chorus stop && chorus start`' : ''),
  );
  lines.push(`node:            ${s.runtime.node}`);
  lines.push(
    `platform:        ${s.runtime.platform} (${s.runtime.arch}, ${s.runtime.release})`,
  );
  lines.push(`install mode:    ${s.install.mode}`);
  lines.push(`bin path:        ${s.install.binPath}`);
  lines.push('');
  lines.push('## Daemon state');
  lines.push(`pid alive:       ${s.daemon.daemonPidAlive ?? '(no daemon.json)'}`);
  lines.push(
    `health probe:    ${s.daemon.healthyOnPort !== null ? `OK on :${s.daemon.healthyOnPort}` : 'no response'}`,
  );
  lines.push('daemon.json:');
  for (const ln of s.daemon.daemonJson.split('\n')) lines.push(`  ${ln}`);
  lines.push('');
  lines.push('## DB');
  lines.push(`chats:           ${s.db.chats}`);
  lines.push(`voices:          ${s.db.voices}`);
  lines.push('');
  lines.push('## CLI detection');
  if (s.clis.length === 0) {
    lines.push('(detection module failed to load)');
  } else {
    for (const c of s.clis) {
      lines.push(
        c.found
          ? `  ✓ ${c.id.padEnd(14)} ${c.path ?? ''}`
          : `  ✗ ${c.id.padEnd(14)} not found${c.reason ? ` — ${c.reason}` : ''}`,
      );
    }
  }
  lines.push('');
  lines.push('## Crashes');
  lines.push(`count:           ${s.crashes.count}`);
  if (s.crashes.latest) {
    lines.push(`latest:          ${s.crashes.latest.file}`);
    lines.push('preview:');
    for (const ln of s.crashes.latest.preview.split('\n')) lines.push(`  ${ln}`);
  }
  lines.push('');
  lines.push('## Recent daemon.log (last 50 lines)');
  for (const ln of s.logs.daemonTail.split('\n')) lines.push(`  ${ln}`);
  lines.push('');
  lines.push('## Recent web.log (last 20 lines)');
  for (const ln of s.logs.webTail.split('\n')) lines.push(`  ${ln}`);
  lines.push('```');
  return lines.join('\n');
}

export function registerDiagnoseCommand(program: Command): void {
  program
    .command('diagnose')
    .description(
      'Print a redacted diagnostic bundle to paste into a bug report',
    )
    .action(async () => {
      try {
        const snap = await gather();
        const report = formatReport(snap);
        console.log('');
        console.log(report);
        console.log('');
        console.log(
          `Copy the block above into a new issue: ${ISSUE_URL}`,
        );
        console.log('');
      } catch (err) {
        console.error(
          'diagnose failed:',
          err instanceof Error ? err.message : err,
        );
        process.exit(1);
      }
    });
}

// Exported for tests — pure function over a snapshot is easy to assert.
export const _testing = { gather, formatReport, detectInstallMode, abbreviateHome };
