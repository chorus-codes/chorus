/**
 * `chorus doctor` — diagnose CLI detection + PATH issues.
 *
 * Surfaces the gap between "what your terminal sees" and "what the
 * daemon sees" when those diverge — the bug class that bit the launch
 * smoke tests (opencode in ~/.opencode/bin, .bashrc early-returns on
 * non-interactive shells, daemon spawned without it on PATH).
 *
 * Output:
 *   - Each CLI: detection status + resolved path + source (path / fallback /
 *     manual).
 *   - Daemon's current PATH (what subprocess spawns inherit).
 *   - Captured interactive PATH (what your shell sees), if any.
 *   - Saved manual overrides.
 *   - Concrete next step when a gap is detected.
 */
import type { Command } from 'commander';
import { readDaemonInfo } from '../../lib/daemon-discovery.js';
import {
  detectRuntimeEnv,
  isRemoteDevEnv,
  type RuntimeEnvInfo,
} from '../runtime-env.js';
import { c, header, sym } from '../ui.js';

interface DoctorReport {
  detection: Array<{
    id: string;
    found: boolean;
    path?: string;
    source?: string;
    reason?: string;
  }>;
  capturedPath: string | null;
  daemonPath: string;
  manualPaths: Record<string, string>;
  runtimeEnv: RuntimeEnvInfo;
  /** ms since the daemon last (re)started, or null if no daemon.json. */
  daemonAgeMs: number | null;
}

/**
 * Below this age, we treat a restart as "recent" — the user is most
 * likely to hit the port-forward staleness window in this slice and
 * we should surface the known-issue hint loudly.
 *
 * Five minutes covers: the editor's proxy reconnect window after a
 * restart, the typical "I ran chorus update and now the page is blank"
 * debug timeline, and isn't so long that a healthy daemon noise-floor
 * triggers the warning.
 */
const RECENT_RESTART_WINDOW_MS = 5 * 60 * 1000;

async function gatherReport(): Promise<DoctorReport> {
  const { detectAllClis } = await import('../../lib/cli-detect.js');
  const { loadCapturedPath } = await import('../../lib/runtime-path.js');
  const { cliPaths } = await import('../../lib/cli-paths.js');

  await cliPaths.refreshCache();
  const detection = detectAllClis(true);
  const capturedPath = await loadCapturedPath();
  const manualPaths = await cliPaths.listAll();

  const compactManual: Record<string, string> = {};
  for (const [id, p] of Object.entries(manualPaths)) {
    if (p) compactManual[id] = p;
  }

  const info = readDaemonInfo();
  let daemonAgeMs: number | null = null;
  if (info?.startedAt) {
    const started = Date.parse(info.startedAt);
    if (Number.isFinite(started)) {
      daemonAgeMs = Math.max(0, Date.now() - started);
    }
  }

  return {
    detection,
    capturedPath,
    daemonPath: process.env.PATH ?? '',
    manualPaths: compactManual,
    runtimeEnv: detectRuntimeEnv(),
    daemonAgeMs,
  };
}

function printReport(r: DoctorReport): void {
  const labelMap: Record<string, string> = {
    'claude-code': 'claude',
    'codex-cli': 'codex',
    'gemini-cli': 'gemini',
    'opencode-cli': 'opencode',
    'kimi-cli': 'kimi',
    'grok-cli': 'grok',
    'antigravity-cli': 'agy',
  };

  console.log('');
  console.log(header(sym.pointer, 'Chorus doctor'));
  console.log('');
  console.log(c.bold('  CLI detection'));
  console.log('');

  for (const d of r.detection) {
    const name = labelMap[d.id] ?? d.id;
    if (d.found) {
      const sourceTag =
        d.source === 'manual'
          ? c.cyan('manual')
          : d.source === 'fallback'
            ? c.yellow('fallback')
            : c.dim('PATH');
      console.log(
        `    ${sym.ok} ${c.bold(name.padEnd(10))} ${c.dim(d.path ?? '')} ${c.dim('(')}${sourceTag}${c.dim(')')}`,
      );
    } else {
      const reason = d.reason ? c.dim(` — ${d.reason}`) : '';
      console.log(
        `    ${sym.err} ${c.bold(name.padEnd(10))} ${c.red('not found')}${reason}`,
      );
    }
  }

  console.log('');
  console.log(c.bold('  PATH visibility'));
  console.log('');
  console.log(
    `    daemon PATH:      ${c.dim(`${r.daemonPath.split(':').length} dirs`)} ${r.daemonPath ? c.dim(`(${r.daemonPath.slice(0, 80)}${r.daemonPath.length > 80 ? '…' : ''})`) : ''}`,
  );
  if (r.capturedPath) {
    console.log(
      `    captured shell:   ${c.dim(`${r.capturedPath.split(':').length} dirs`)} ${c.dim(`(${r.capturedPath.slice(0, 80)}${r.capturedPath.length > 80 ? '…' : ''})`)}`,
    );
    const inDaemon = new Set(r.daemonPath.split(':'));
    const missing = r.capturedPath
      .split(':')
      .filter((p) => p && !inDaemon.has(p));
    if (missing.length > 0) {
      console.log('');
      console.log(
        `    ${c.yellow('!')} ${missing.length} dirs in your shell PATH but NOT in the daemon's PATH:`,
      );
      for (const p of missing.slice(0, 8)) {
        console.log(`      ${c.dim(p)}`);
      }
      if (missing.length > 8) {
        console.log(`      ${c.dim(`… +${missing.length - 8} more`)}`);
      }
      console.log('');
      console.log(
        `    ${c.dim('Tip:')} restart the daemon with ${c.bold('chorus stop && chorus start')} to re-capture.`,
      );
    }
  } else {
    console.log(
      `    captured shell:   ${c.dim('not captured yet — run ')}${c.bold('chorus init')}${c.dim(' or ')}${c.bold('chorus start')}`,
    );
  }

  if (isRemoteDevEnv(r.runtimeEnv)) {
    printRemoteSessionSection(r);
  }

  if (Object.keys(r.manualPaths).length > 0) {
    console.log('');
    console.log(c.bold('  Manual overrides'));
    console.log('');
    for (const [id, p] of Object.entries(r.manualPaths)) {
      const name = labelMap[id] ?? id;
      console.log(`    ${sym.ok} ${c.bold(name.padEnd(10))} ${c.dim(p)}`);
    }
  }

  // Final hint when something looks off
  const missingCli = r.detection.filter((d) => !d.found);
  if (missingCli.length > 0) {
    console.log('');
    console.log(c.bold('  Next steps'));
    console.log('');
    console.log(
      `    ${c.dim('•')} Visit ${c.cyan('http://127.0.0.1:5050/onboarding')} → "I know where it is"`,
    );
    console.log(
      `      to paste a path for any missing CLI.`,
    );
    console.log(
      `    ${c.dim('•')} Or run ${c.bold('chorus stop && chorus start')} from your usual terminal so`,
    );
    console.log(
      `      we re-capture the PATH that has the CLI.`,
    );
  }
  console.log('');
}

function formatDaemonAge(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s ago`;
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m ago`;
  const totalHr = Math.round(totalMin / 60);
  if (totalHr < 24) return `${totalHr}h ago`;
  return `${Math.round(totalHr / 24)}d ago`;
}

function printRemoteSessionSection(r: DoctorReport): void {
  const editor =
    r.runtimeEnv.kind === 'cursor-remote'
      ? 'Cursor Remote-SSH'
      : r.runtimeEnv.kind === 'codespaces'
        ? 'GitHub Codespaces'
        : 'VSCode Remote-SSH';

  console.log('');
  console.log(c.bold('  Remote session'));
  console.log('');
  console.log(`    ${sym.info} ${editor} detected.`);

  if (r.daemonAgeMs === null) {
    console.log(
      `      ${c.dim('No running daemon — start one with ')}${c.bold('chorus start')}${c.dim('.')}`,
    );
    return;
  }

  const recent = r.daemonAgeMs < RECENT_RESTART_WINDOW_MS;
  console.log(
    `      Daemon started ${c.dim(formatDaemonAge(r.daemonAgeMs))}.`,
  );

  if (recent) {
    console.log('');
    console.log(
      `    ${c.yellow('!')} Known-issue check: a recent restart can leave your editor's port-forward`,
    );
    console.log(
      `      bound to the old daemon's PID, so ${c.cyan('http://127.0.0.1:5050')} loads blank.`,
    );
    console.log(
      `      Open the ${c.bold('Ports')} panel and re-forward ${c.bold('5050')} to rebind.`,
    );
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description(
      'Diagnose CLI detection + PATH issues — what the daemon sees vs what your shell sees',
    )
    .action(async () => {
      try {
        const report = await gatherReport();
        printReport(report);
      } catch (err) {
        console.error(
          'doctor failed:',
          err instanceof Error ? err.message : err,
        );
        process.exit(1);
      }
    });
}
