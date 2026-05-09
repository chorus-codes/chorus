import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import { sym } from './ui.js';

/**
 * Probe whether anything is listening on a TCP port on 127.0.0.1.
 *
 * Used by the start-path orphan reaper: if a previous next-server from
 * an earlier `chorus start` survived a `chorus stop` (because the
 * pidfile was lost or the SIGTERM was ignored), the next start would
 * silently race against it on :5050 and leave the user stuck on stale
 * chunks after a rebuild.
 */
export function isPortInUse(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 500,
): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (inUse: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(inUse);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

/**
 * Find any process holding a TCP listener on `port` on 127.0.0.1.
 * Returns the PIDs found via `ss`/`lsof`. Best-effort — returns [] on
 * platforms where neither tool is available.
 *
 * Why: pidfile-based tracking is fragile (file deleted on a partial
 * stop, PID reused by an unrelated process). Port-based reaping is the
 * source of truth — if something's bound to :5050, we want it gone
 * before we spawn our own.
 */
export function findPidsOnPort(port: number): number[] {
  const candidates: { cmd: string; parse: (out: string) => number[] }[] = [
    {
      cmd: `ss -ltnp 'sport = :${port}' 2>/dev/null`,
      parse: (out) => {
        const pids: number[] = [];
        for (const m of out.matchAll(/pid=(\d+)/g)) {
          const pid = parseInt(m[1], 10);
          if (Number.isFinite(pid) && pid > 0) pids.push(pid);
        }
        return pids;
      },
    },
    {
      cmd: `lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`,
      parse: (out) =>
        out
          .split(/\s+/)
          .map((s) => parseInt(s, 10))
          .filter((n) => Number.isFinite(n) && n > 0),
    },
  ];
  for (const { cmd, parse } of candidates) {
    try {
      const out = execSync(cmd, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      });
      const pids = parse(out);
      if (pids.length > 0) return Array.from(new Set(pids));
    } catch {
      /* tool not present or no match — try next */
    }
  }
  return [];
}

/**
 * Same as findPidsOnPort but escalates via `sudo -n` (non-interactive).
 * Linux's `ss -p` and `lsof` redact the PID column for sockets owned by
 * a different uid when the caller is unprivileged — so a chorus daemon
 * left behind by a `sudo chorus start` is invisible to a plain
 * `chorus start`. Without this, the user hits the dead-end "couldn't
 * identify the PID — free the port and retry" message and gets stuck.
 *
 * Returns [] on any failure: sudo prompt would block (no passwordless
 * sudoers entry), tool missing, no listener, etc. Never blocks the
 * terminal — the `-n` flag makes sudo fail-fast instead of prompting.
 */
export function findPidsOnPortWithSudo(port: number): number[] {
  const candidates: { argv: string[]; parse: (out: string) => number[] }[] = [
    {
      // ss accepts the filter as a separate argument, so execFileSync
      // is safe (no shell interpolation). Numeric port is type-checked
      // by the caller via TypeScript, but argv-style invocation makes
      // even an untrusted port literal harmless.
      argv: ['-n', 'ss', '-ltnp', `sport = :${port}`],
      parse: (out) => {
        const pids: number[] = [];
        for (const m of out.matchAll(/pid=(\d+)/g)) {
          const pid = parseInt(m[1], 10);
          if (Number.isFinite(pid) && pid > 0) pids.push(pid);
        }
        return pids;
      },
    },
    {
      argv: ['-n', 'lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      parse: (out) =>
        out
          .split(/\s+/)
          .map((s) => parseInt(s, 10))
          .filter((n) => Number.isFinite(n) && n > 0),
    },
  ];
  for (const { argv, parse } of candidates) {
    try {
      const out = execFileSync('sudo', argv, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      });
      const pids = parse(out);
      if (pids.length > 0) return Array.from(new Set(pids));
    } catch {
      /* sudo would prompt, tool missing, no match — try next */
    }
  }
  return [];
}

/**
 * SIGTERM-then-SIGKILL via `sudo -n kill`. Same shape as killAndVerify
 * but escalates so we can reap an orphan owned by another uid (typically
 * a daemon a sudo-invoked `chorus start` left behind). Returns true if
 * the process is gone by the time we return.
 *
 * Silently fails (returns false) when passwordless sudo isn't
 * available — callers should already have established that the orphan
 * is chorus-shaped before deciding to reap, so the worst case is that
 * the user gets the actionable diagnostic instead of auto-recovery.
 */
export async function killWithSudoAndVerify(
  pid: number,
  label: string,
  gracefulMs = 1500,
): Promise<boolean> {
  const isAlive = (): boolean => {
    // process.kill(pid, 0) works cross-uid on Linux: the EPERM/ESRCH
    // distinction tells us "exists but I can't signal it" vs "gone".
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM = process exists, owned by another uid → still alive.
      // ESRCH = no such process → gone.
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'EPERM';
    }
  };
  if (!isAlive()) return true;
  const sudoKill = (signal: 'TERM' | 'KILL'): void => {
    try {
      execFileSync('sudo', ['-n', 'kill', `-${signal}`, String(pid)], {
        stdio: 'ignore',
      });
    } catch {
      /* sudo prompt would block — fall through to liveness probe */
    }
  };
  sudoKill('TERM');

  const deadline = Date.now() + gracefulMs;
  while (Date.now() < deadline) {
    if (!isAlive()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  sudoKill('KILL');
  await new Promise((r) => setTimeout(r, 200));
  if (!isAlive()) return true;
  console.warn(
    `  ${sym.err} ${label} PID ${pid} survived sudo -n kill — manual cleanup needed`,
  );
  return false;
}

/**
 * Read the process's command line so we can decide whether it looks
 * like a chorus orphan (safe to reap) vs a foreign process the user
 * owns (refuse to kill — Grafana/another dev server happens to be on
 * 5050 or 7707). Linux exposes /proc/<pid>/cmdline; macOS doesn't, so
 * we fall back to `ps -p <pid> -o command=`.
 */
function readCmdline(pid: number): string | null {
  try {
    const procPath = `/proc/${pid}/cmdline`;
    if (fs.existsSync(procPath)) {
      // /proc/<pid>/cmdline is NUL-separated argv. Replace with spaces
      // so we can substring-match against the joined invocation.
      return fs.readFileSync(procPath, 'utf-8').replace(/ /g, ' ').trim();
    }
  } catch {
    /* race with process exit, fall through to ps */
  }
  try {
    // execFileSync over execSync so a future loosening of `pid`'s
    // numeric type can't slip into a shell command-injection. argv
    // goes straight to ps without an intermediate sh -c.
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Path-segment match for the chorus / chorus-codes directory names.
 * Splitting on `/` so we accept `/dev/chorus/...` but not
 * `/dev/chorus-experiments/...`. Used by the next-launcher fallback
 * for both cmdline and cwd checks.
 */
function pathHasChorusSegment(somePath: string): boolean {
  const segs = somePath.split('/');
  return segs.includes('chorus') || segs.includes('chorus-codes');
}

function cmdlineHasChorusSegment(cmdline: string): boolean {
  for (const tok of cmdline.split(/\s+/)) {
    if (pathHasChorusSegment(tok)) return true;
  }
  return false;
}

/**
 * Does this process look like a chorus daemon or cockpit?
 *
 * The reap loop in `chorus start` kills whatever's bound to 5050/7707
 * before respawning. Pre-fix, that loop would happily SIGKILL
 * `grafana-server` or another user's `next dev` if either happened to
 * be on the same port — silently murdering work and surprising the user.
 *
 * Accept anything whose argv mentions one of these markers, all of
 * which are uniquely chorus-shaped:
 *   - `chorus/dist/daemon/index.js` — compiled daemon entrypoint
 *   - `src/daemon/index.ts`         — dev (tsx) entrypoint
 *   - `chorus/bin/chorus.mjs`       — CLI wrapper
 *   - `next-server` / `next start` running in a path that contains chorus
 *
 * Anything else returns false; the caller should refuse to reap and
 * surface a clear "port is taken by <cmd>" error.
 */
export function pidLooksLikeChorus(pid: number): {
  match: boolean;
  cmdline: string | null;
} {
  const cmdline = readCmdline(pid);
  if (!cmdline) {
    // Couldn't read cmdline (race / permission). Fail-closed: treat as
    // foreign, force the user to investigate.
    return { match: false, cmdline: null };
  }
  // Path markers covering both dev (repo) and installed (node_modules)
  // layouts. The unscoped npm name `chorus-codes` lands the package at
  // node_modules/chorus-codes/* on global installs.
  //
  // Each marker is prefixed with `/` so substring search anchors on a
  // path-segment boundary. Without the leading slash,
  // `cmdline.includes('chorus/dist/...')` would match
  // `/x/notchorus/dist/...` or `/x/mychorus-fork/dist/...`.
  const markers = [
    '/chorus/dist/daemon/index.js',
    '/chorus/src/daemon/index.ts',
    '/chorus/bin/chorus.mjs',
    '/chorus/dist/cli/index.js',
    '/chorus-codes/dist/daemon/index.js',
    '/chorus-codes/src/daemon/index.ts',
    '/chorus-codes/bin/chorus.mjs',
    '/chorus-codes/dist/cli/index.js',
  ];
  if (markers.some((m) => cmdline.includes(m))) return { match: true, cmdline };

  // next-server is the cockpit. The launcher may show up as either the
  // literal `next-server (vXX.YY.ZZ)` worker title (Next overwrites
  // process.title once running, wiping the original argv — chorus
  // disappears from cmdline at that point) OR as the original `node
  // node_modules/next/dist/bin/next start` argv. To stay safe in both
  // states, accept either form when the cmdline carries a chorus path
  // segment OR the process's cwd has one — chorus start always spawns
  // Next with cwd: packageRoot. Path-segment matching (split + includes)
  // so /home/user/chorus-experiments/marketing-site doesn't mistakenly
  // match.
  const nextLauncher =
    cmdline.includes('next-server') ||
    /node_modules\/next\/dist\/bin\/next (start|dev)/.test(cmdline);
  if (nextLauncher) {
    if (cmdlineHasChorusSegment(cmdline)) return { match: true, cmdline };
    const cwd = readCwd(pid);
    if (cwd && pathHasChorusSegment(cwd)) return { match: true, cmdline };
  }
  return { match: false, cmdline };
}

/**
 * Read /proc/<pid>/cwd, falling back to `sudo -n readlink` when the
 * unprivileged readlink hits EACCES — the cwd symlink is owned by the
 * process uid and locked to mode 0500, so a `sudo chorus start` orphan
 * is invisible to a plain `chorus start` without escalation.
 *
 * Used by the next-server cwd cross-check: cmdline gets clobbered to
 * `next-server (vX.Y.Z)` once Next overwrites process.title, leaving
 * cwd as the only signal that an unidentifiable next-server is in fact
 * the chorus cockpit.
 *
 * Returns null when both probes fail (non-Linux, process gone, sudo
 * would prompt). Caller should treat null as "not chorus" — fail-closed
 * matches the foreign-process guard's intent.
 */
function readCwd(pid: number): string | null {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    /* permission denied or process gone — fall through to sudo */
  }
  try {
    const out = execFileSync('sudo', ['-n', 'readlink', `/proc/${pid}/cwd`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Send SIGTERM to a PID and wait up to `gracefulMs` for it to die. If
 * still alive, escalate to SIGKILL. Returns true if the process is
 * gone by the time we return (or never existed in the first place),
 * false if SIGKILL also failed.
 */
export async function killAndVerify(
  pid: number,
  label: string,
  gracefulMs = 1500,
): Promise<boolean> {
  const isAlive = (): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!isAlive()) return true;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* gone already */
  }

  const deadline = Date.now() + gracefulMs;
  while (Date.now() < deadline) {
    if (!isAlive()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  // Stubborn — escalate.
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* may already be dead */
  }
  await new Promise((r) => setTimeout(r, 200));
  if (!isAlive()) return true;
  console.warn(
    `  ${sym.err} ${label} PID ${pid} survived SIGKILL — manual cleanup needed`,
  );
  return false;
}
