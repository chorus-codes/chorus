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
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isDaemonHealthy, readDaemonInfo } from '../../lib/daemon-discovery.js';
import { pkg } from '../shared.js';

const ISSUE_URL = 'https://github.com/chorus-codes/chorus/issues/new';

interface SmokeResult {
  ok: boolean;
  exitCode?: number;
  version?: string;
  stderrFirstLine?: string;
  /** Set when the smoke timed out (SIGTERM / SIGKILL from spawn). Distinguishes
   *  hung CLI from non-zero exit so a paste-in bug report shows "timed out"
   *  explicitly. Without this, every failure mode renders identically. */
  timedOut?: boolean;
}

interface ErroredParticipant {
  dir: string;
  lineage: string;
  model: string | null;
  errorKind: string;
  /** Length of the original errorMessage in bytes — useful as a "yes there
   *  WAS a message" signal without leaking the content. The full message
   *  lives in the on-disk `_attempts.jsonl`; users can attach that file
   *  manually if a maintainer needs it. */
  errorMessageBytes: number;
}

interface RecentFailedChat {
  chatId: string;
  status: string;
  createdAt: number;
  erroredParticipants: ErroredParticipant[];
}

interface VoiceHealth {
  total: number;
  autoQuota: string[];
  autoMissing: string[];
  userDisabled: number;
}

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
  clis: Array<{ id: string; found: boolean; path?: string; reason?: string; smoke?: SmokeResult }>;
  voiceHealth: VoiceHealth;
  recentFailedChats: RecentFailedChat[];
}

function abbreviateHome(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/**
 * Redact every occurrence of $HOME embedded inside a free-form string —
 * used for spawn() error messages and process stderr where `abbreviateHome`
 * can't help because the path doesn't start at offset 0 (e.g.
 * `spawn /home/alice/foo ENOENT`).
 */
function redactHomePaths(s: string): string {
  const home = os.homedir();
  if (!home) return s;
  // Escape for regex use — Node's homedir is a literal path, but be safe.
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return s.replace(new RegExp(escaped, 'g'), '~');
}

/**
 * Resolve the bin path through any symlinks before classifying. A
 * `sudo npm install -g chorus-codes` plants a symlink at
 * `/usr/bin/chorus` (or `/usr/local/bin/chorus`) pointing into
 * `/usr/lib/node_modules/chorus-codes/bin/chorus.mjs`. Node's
 * `process.argv[1]` returns the SYMLINK path on Linux, not the
 * resolved target — so the raw path matches none of the
 * `node_modules` / `dist` / `.ts` substrings and `detectInstallMode`
 * returns `'unknown'`.
 *
 * realpath fixes that. Wrapped in try/catch because a broken symlink
 * (or a path we can't stat) shouldn't abort the diagnostic — we fall
 * back to the original path so the report still tells you SOMETHING.
 */
function resolveBinPath(rawBinPath: string): string {
  try {
    return fs.realpathSync(rawBinPath);
  } catch {
    return rawBinPath;
  }
}

function detectInstallMode(binPath: string): DiagnoseSnapshot['install']['mode'] {
  if (binPath.includes('node_modules')) return 'global-npm';
  if (binPath.endsWith('.ts')) return 'dev-tsx';
  if (binPath.includes('/dist/') || binPath.includes('\\dist\\')) return 'local-dist';
  return 'unknown';
}

/**
 * Drop log lines that are known-benign — they make a bug-report block
 * look scarier than it is, and they're not actionable. Currently just
 * Next.js 16's "failed to pipe response" trace which fires whenever an
 * SSE client (browser tab) closes mid-stream — expected behaviour, not
 * an error worth surfacing.
 *
 * Conservative: only filters specific known patterns. New noise types
 * earn their entry by being explicitly added — we don't want to hide
 * an actual bug because its message vaguely matches a regex.
 */
function filterBenignNoise(text: string): { kept: string; filteredCount: number } {
  if (!text || text.startsWith('(')) return { kept: text, filteredCount: 0 };
  // The Next.js 16 SSE pipe-close trace spans ~15 lines starting from
  // `⨯ Error: failed to pipe response` and ending after the inner
  // `UND_ERR_SOCKET` block. We split on a `}` line that follows a
  // `code: 'UND_ERR_SOCKET'` to find the end of the trace.
  //
  // Two cases to handle:
  //   1. Full trace within the window — match opening line, drop until
  //      brace depth returns to <= 0.
  //   2. Trace tail orphaned at start of window (the trace's opening
  //      line was BEFORE our raw-tail window). The orphan opens with
  //      stack/cause fragments like `at async ...{` or `[cause]: ...`
  //      with no preceding error line; keep dropping until we hit the
  //      end-of-trace `}` cluster. We detect this by looking back from
  //      a `code: 'UND_ERR_SOCKET'` line — if found in the first N
  //      lines without a preceding `failed to pipe response`, the
  //      window is starting mid-trace and we drop everything before
  //      and including the trace closer.
  const lines = text.split('\n');

  // Pass 1: find an orphan trace tail (UND_ERR_SOCKET without a
  // preceding `failed to pipe response`) and trim everything before
  // its closer.
  const orphanIdx = lines.findIndex((l) => l.includes("code: 'UND_ERR_SOCKET'"));
  let startIdx = 0;
  let orphanCount = 0;
  if (orphanIdx >= 0) {
    let sawOpener = false;
    for (let i = 0; i <= orphanIdx; i++) {
      if (lines[i].includes('failed to pipe response')) {
        sawOpener = true;
        break;
      }
    }
    if (!sawOpener) {
      // Walk forward from orphanIdx to find the trace closer (a line
      // that's just `}` or `  }` after which the next line either ends
      // the cluster or starts new content).
      let braceDepth = 0;
      let closeIdx = orphanIdx;
      for (let i = 0; i <= orphanIdx; i++) {
        for (const ch of lines[i]) {
          if (ch === '{') braceDepth++;
          else if (ch === '}') braceDepth--;
        }
      }
      for (let i = orphanIdx + 1; i < lines.length; i++) {
        for (const ch of lines[i]) {
          if (ch === '{') braceDepth++;
          else if (ch === '}') braceDepth--;
        }
        if (braceDepth <= 0 && lines[i].trim().endsWith('}')) {
          closeIdx = i;
          break;
        }
      }
      startIdx = closeIdx + 1;
      orphanCount = 1;
    }
  }

  // Pass 2: walk the rest of the window dropping full traces.
  const out: string[] = [];
  let dropping = false;
  let braceDepth = 0;
  let filteredCount = orphanCount;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (!dropping && line.includes('failed to pipe response')) {
      dropping = true;
      braceDepth = 0;
      filteredCount++;
      continue;
    }
    if (dropping) {
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
      }
      if (braceDepth <= 0 && line.trim().endsWith('}')) {
        dropping = false;
      }
      continue;
    }
    out.push(line);
  }
  return { kept: out.join('\n'), filteredCount };
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

/**
 * Run `<bin> --version` with a 2s wall clock and capture exit code +
 * a single line of useful output. Detects the case where the CLI is
 * present at the expected path but explodes on invocation (auth
 * missing, missing native dep, broken symlink target). That class of
 * failure is invisible in pure path-detection — it's the most common
 * reason a CLI shows up as ✓ in the bundle but a chat against it
 * silently fails.
 *
 * Async (`spawn` + Promise) so a 5-CLI fleet smokes concurrently
 * instead of sequentially blocking for 5×2s on the worst case.
 *
 * Privacy: any string that lands in the bundle runs through
 * `abbreviateHome()` so $HOME paths from spawn errors / process stderr
 * don't leak the reporter's username or workspace layout.
 *
 * Timeout: hard SIGKILL after 2s — a hung wrapper that traps SIGTERM
 * can't extend the deadline. The timeout case is surfaced with an
 * explicit `timedOut: true` flag so the report says "timed out"
 * instead of being indistinguishable from a non-zero exit.
 */
export function smokeOneCli(bin: string): Promise<SmokeResult> {
  return new Promise<SmokeResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (r: SmokeResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ['--version'], { windowsHide: true });
    } catch (err) {
      settle({
        ok: false,
        exitCode: -1,
        stderrFirstLine: redactHomePaths(
          (err instanceof Error ? err.message : String(err)).slice(0, 200),
        ),
      });
      return;
    }
    const timer = setTimeout(() => {
      // Hard kill — SIGTERM can be trapped by wrapper scripts.
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
      settle({
        ok: false,
        exitCode: -1,
        timedOut: true,
        stderrFirstLine: 'timed out after 2s',
      });
    }, 2_000);

    child.stdout?.on('data', (d: Buffer) => {
      // Cap at 4 KiB — a `--version` printing megabytes is misbehaving
      // and we don't want the bundle to bloat from it.
      if (stdout.length < 4096) stdout += d.toString('utf-8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 4096) stderr += d.toString('utf-8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      settle({
        ok: false,
        exitCode: -1,
        stderrFirstLine: redactHomePaths(
          err.message.split('\n')[0]?.slice(0, 200) ?? '',
        ),
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        // Some CLIs print version on stdout, some on stderr.
        const first =
          stdout.split('\n').find((l) => l.trim()) ||
          stderr.split('\n').find((l) => l.trim()) ||
          '';
        settle({ ok: true, exitCode: 0, version: first.trim().replace(/^v/, '') });
        return;
      }
      if (signal) {
        // External signal (OOM-killer, unrelated kill) — distinguish
        // from non-zero exit.
        settle({
          ok: false,
          exitCode: -1,
          timedOut: signal === 'SIGKILL' || signal === 'SIGTERM' || undefined,
          stderrFirstLine: `signalled: ${signal}`,
        });
        return;
      }
      const firstLine = (stderr + stdout)
        .split('\n')
        .find((l) => l.trim())
        ?.trim()
        .slice(0, 200);
      settle({
        ok: false,
        exitCode: code ?? -1,
        stderrFirstLine: firstLine ? redactHomePaths(firstLine) : undefined,
      });
    });
  });
}

/**
 * Read the LAST line of a participant's `_attempts.jsonl` and parse it.
 * The reviewer writes one row per failed attempt in the run's `finally`
 * block; the last row is the most recent failure for that slot —
 * exactly the field a bug reporter needs to see (errorKind + length of
 * errorMessage). Tolerant of malformed lines because the file is
 * append-only and a partial write can leave a torn tail.
 *
 * **Privacy**: `errorMessage` is exposed as `errorMessageBytes` only —
 * raw error strings from LLM APIs frequently echo the user's prompt,
 * template content, file paths, or provider response excerpts back to
 * the caller, and `chorus diagnose` output is meant to be pasted into
 * public bug reports. The on-disk JSONL still has the full message;
 * users can attach that file manually if a maintainer needs more.
 */
export function readLatestAttempt(file: string): {
  errorKind: string;
  errorMessageBytes: number;
  lineage: string;
  model: string | null;
} | null {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]) as {
          errorKind?: unknown;
          errorMessage?: unknown;
          lineage?: unknown;
          model?: unknown;
        };
        if (typeof obj.errorKind === 'string' && typeof obj.errorMessage === 'string') {
          return {
            errorKind: obj.errorKind,
            errorMessageBytes: obj.errorMessage.length,
            lineage: typeof obj.lineage === 'string' ? obj.lineage : 'unknown',
            model: typeof obj.model === 'string' ? obj.model : null,
          };
        }
      } catch {
        /* try the previous line */
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Walk a chat's per-round directories and surface every participant
 * whose `_attempts.jsonl` shows a failure. A reviewer that succeeded
 * writes no JSONL — the file's mere presence is the signal.
 */
function gatherErroredParticipants(chatId: string): ErroredParticipant[] {
  const chatDir = path.join(os.homedir(), '.chorus', 'chats', chatId);
  if (!fs.existsSync(chatDir)) return [];
  const out: ErroredParticipant[] = [];
  try {
    const rounds = fs.readdirSync(chatDir).filter((n) => n.startsWith('round-'));
    for (const r of rounds) {
      const rDir = path.join(chatDir, r);
      if (!fs.statSync(rDir).isDirectory()) continue;
      for (const part of fs.readdirSync(rDir)) {
        const partDir = path.join(rDir, part);
        const attempts = path.join(partDir, '_attempts.jsonl');
        const latest = readLatestAttempt(attempts);
        if (latest) {
          out.push({
            dir: `${r}/${part}`,
            lineage: latest.lineage,
            model: latest.model,
            errorKind: latest.errorKind,
            errorMessageBytes: latest.errorMessageBytes,
          });
        }
      }
    }
  } catch {
    /* missing dir, permission error — best-effort */
  }
  return out;
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
  // Also smoke each detected bin (`<bin> --version`) so the bundle
  // captures CLIs that resolve on PATH but explode on invocation —
  // the most common "✓ detected but chats fail silently" case.
  // Smokes run in parallel via Promise.all-around-Promise.resolve so a
  // 5-CLI fleet doesn't block diagnose for 5×2s = 10s on the worst case.
  let clis: DiagnoseSnapshot['clis'] = [];
  try {
    const { detectAllClis } = await import('../../lib/cli-detect.js');
    const found = detectAllClis(true);
    const smokes: Array<SmokeResult | undefined> = await Promise.all(
      found.map((d) => (d.found && d.path ? smokeOneCli(d.path) : Promise.resolve(undefined))),
    );
    clis = found.map((d, i) => ({
      id: d.id,
      found: d.found,
      path: d.path ? abbreviateHome(d.path) : undefined,
      reason: d.reason,
      smoke: smokes[i],
    }));
  } catch {
    /* detection module load failed — leave empty */
  }

  // Voice health — count voices by disabled_reason. Surfaces the
  // auto-disable signal from the voice-failure-tracker (chorus-106)
  // so reporters know when chorus has silently sidelined a model.
  // Best-effort: same DB connection as the chats/voices counts above.
  let voiceHealth: VoiceHealth = { total: 0, autoQuota: [], autoMissing: [], userDisabled: 0 };
  try {
    const { getDb } = await import('../../lib/db/connection.js');
    const db = await getDb();
    const total = await db.execute('SELECT COUNT(*) AS n FROM voices');
    const disabled = await db.execute(
      "SELECT id, disabled_reason FROM voices WHERE enabled = 0",
    );
    const autoQuota: string[] = [];
    const autoMissing: string[] = [];
    let userDisabled = 0;
    for (const row of disabled.rows as unknown as Array<{
      id: string;
      disabled_reason: string | null;
    }>) {
      if (row.disabled_reason === 'auto_quota') autoQuota.push(row.id);
      else if (row.disabled_reason === 'auto_missing') autoMissing.push(row.id);
      else userDisabled++;
    }
    voiceHealth = {
      total: Number((total.rows[0] as unknown as { n: number }).n),
      autoQuota,
      autoMissing,
      userDisabled,
    };
  } catch {
    /* DB unreachable / schema older — leave defaults */
  }

  // Recent failed chats — last 5 chats whose status is non-terminal-OK.
  // Joined to per-participant `_attempts.jsonl` so the bundle shows the
  // ACTUAL failure reason (errorKind + first line of errorMessage)
  // instead of just "this chat failed". Cuts the most common triage
  // roundtrip ("what specifically happens when you run it?").
  let recentFailedChats: RecentFailedChat[] = [];
  try {
    const { getDb } = await import('../../lib/db/connection.js');
    const db = await getDb();
    const rows = await db.execute(
      `SELECT id, status, created_at FROM chats
       WHERE status IN ('failed', 'blocked', 'cancelled')
       ORDER BY created_at DESC LIMIT 5`,
    );
    recentFailedChats = (
      rows.rows as unknown as Array<{ id: string; status: string; created_at: number }>
    ).map((r) => ({
      chatId: r.id,
      status: r.status,
      createdAt: r.created_at,
      erroredParticipants: gatherErroredParticipants(r.id),
    }));
  } catch {
    /* DB unreachable or chats schema mismatch — leave empty */
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
      // realpath the bin path so symlinks (e.g. /usr/bin/chorus →
      // /usr/lib/node_modules/chorus-codes/bin/chorus.mjs from a
      // global npm install) resolve before classification.
      binPath: abbreviateHome(resolveBinPath(process.argv[1] ?? '(unknown)')),
      mode: detectInstallMode(resolveBinPath(process.argv[1] ?? '')),
    },
    daemon: { daemonJson: daemonJsonRaw, daemonPidAlive, healthyOnPort },
    db: { chats: chatsCount, voices: voicesCount },
    logs: {
      daemonTail: tailFile(path.join(chorusDir, 'logs', 'daemon.log'), 50),
      // Strip Next.js 16's SSE pipe-close noise so the bug report
      // doesn't look scary for what's actually a benign client
      // disconnect. Read 300 raw lines (each trace ~15 lines, so this
      // captures up to ~20 traces fully) then surface 20 post-filter
      // so real errors aren't pushed out by noise.
      webTail: (() => {
        const raw = tailFile(path.join(chorusDir, 'logs', 'web.log'), 300);
        const { kept, filteredCount } = filterBenignNoise(raw);
        const trimmed = kept.split('\n').slice(-20).join('\n').trim();
        return filteredCount > 0
          ? `${trimmed}\n  (${filteredCount} benign SSE-disconnect trace${filteredCount === 1 ? '' : 's'} filtered)`
          : trimmed;
      })(),
    },
    crashes: { count: crashCount, latest: latestCrash },
    clis,
    voiceHealth,
    recentFailedChats,
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
      if (!c.found) {
        lines.push(`  ✗ ${c.id.padEnd(14)} not found${c.reason ? ` — ${c.reason}` : ''}`);
        continue;
      }
      lines.push(`  ✓ ${c.id.padEnd(14)} ${c.path ?? ''}`);
      if (c.smoke) {
        if (c.smoke.ok) {
          lines.push(`      smoke: ok${c.smoke.version ? ` (v${c.smoke.version})` : ''}`);
        } else if (c.smoke.timedOut) {
          const detail = c.smoke.stderrFirstLine ? ` — ${c.smoke.stderrFirstLine}` : '';
          lines.push(`      ✗ smoke timed out (>2s)${detail}`);
        } else {
          const detail = c.smoke.stderrFirstLine
            ? ` — ${c.smoke.stderrFirstLine}`
            : '';
          lines.push(
            `      ✗ smoke failed (exit ${c.smoke.exitCode ?? '?'})${detail}`,
          );
        }
      }
    }
  }
  lines.push('');
  lines.push('## Voice health');
  lines.push(`total:           ${s.voiceHealth.total}`);
  lines.push(
    `auto-disabled (quota):    ${s.voiceHealth.autoQuota.length}` +
      (s.voiceHealth.autoQuota.length > 0
        ? `  → ${s.voiceHealth.autoQuota.join(', ')}`
        : ''),
  );
  lines.push(
    `auto-disabled (missing):  ${s.voiceHealth.autoMissing.length}` +
      (s.voiceHealth.autoMissing.length > 0
        ? `  → ${s.voiceHealth.autoMissing.join(', ')}`
        : ''),
  );
  lines.push(`user-disabled:            ${s.voiceHealth.userDisabled}`);
  lines.push('');
  lines.push('## Recent failed chats');
  if (s.recentFailedChats.length === 0) {
    lines.push('(none)');
  } else {
    for (const c of s.recentFailedChats) {
      lines.push(`  ${c.chatId}  status=${c.status}`);
      if (c.erroredParticipants.length === 0) {
        lines.push('      (no errored participants — see daemon.log)');
      } else {
        for (const p of c.erroredParticipants) {
          const modelPart = p.model ? ` model=${p.model}` : '';
          lines.push(`      ${p.dir}  lineage=${p.lineage}${modelPart}`);
          // errorKind is a controlled vocabulary (auth_error,
          // quota_exhausted, network, parse, timeout, ...). The full
          // errorMessage stays on disk in `_attempts.jsonl` — we only
          // surface the byte length so the reporter can attach the
          // file if a maintainer needs more.
          lines.push(`        ${p.errorKind} (errorMessage: ${p.errorMessageBytes} bytes on disk)`);
        }
      }
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
export const _testing = {
  gather,
  formatReport,
  detectInstallMode,
  abbreviateHome,
  resolveBinPath,
  filterBenignNoise,
  smokeOneCli,
  readLatestAttempt,
};
