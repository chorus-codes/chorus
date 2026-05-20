/**
 * Headless transport — spawn helpers, timeout/abort enforcement, heartbeat,
 * and orphan cleanup. Used by every shim's `runHeadless` implementation.
 *
 * Why this module exists:
 *   - tmux holds a TUI process resident (~200-500MB per CLI). 3 reviewers in
 *     parallel = 1-1.5GB just sitting there. Headless drops that to zero
 *     between rounds (process spawns, runs, exits).
 *   - Pane-scraping regex is fragile. Stream-json events are structured.
 *   - Permission dialogs mostly disappear in headless mode (CLIs auto-approve).
 *
 * Stuck-process safety (CRITICAL):
 *   - Every spawn enforces `timeoutMs` (default 10min) — SIGTERM on timeout,
 *     SIGKILL after 5s grace.
 *   - AbortSignal does the same kill sequence.
 *   - Daemon-startup reaper sweeps for orphan PIDs from prior runs (chats
 *     marked drafting/reviewing whose subprocesses outlived a daemon restart).
 *   - Without these, a hung CLI burns paid API tokens forever.
 */

import {
  spawn as spawnChild,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentEvent } from './agents/types.js';
import { cliPaths } from '../lib/cli-paths.js';

// Cache binary→path resolutions. `where` shells out — don't repeat per spawn.
const binaryPathCache = new Map<string, string>();

/**
 * Resolve a binary name to a full path with extension. Critical on Windows
 * where Node's spawn won't resolve `.cmd` shims (npm globals like
 * claude.cmd, codex.cmd, gemini.cmd) without shell:true (DEP0190 in
 * Node 22+). On Unix returns the name unchanged — spawn handles PATH
 * resolution natively for ELF/script files with shebangs.
 */
function resolveBinaryPath(command: string): string {
  if (process.platform !== 'win32') return command;
  // Use the Windows-specific isAbsolute (`path.win32`) so absolute
  // detection works the same on a real Windows host AND on a Linux CI
  // run where the test stubs `process.platform = 'win32'` but the
  // top-level `path` module is still POSIX.
  if (path.win32.isAbsolute(command)) return command;
  const cached = binaryPathCache.get(command);
  if (cached) return cached;
  const r = spawnSync('where', [command], { encoding: 'utf-8', timeout: 3000 });
  if (r.status !== 0 || !r.stdout) {
    binaryPathCache.set(command, command);
    return command; // fallback — daemon will surface ENOENT cleanly.
  }
  // npm globals on Windows ship two siblings: `claude` (Bash shim, not
  // executable by Node spawn) and `claude.cmd` (Windows shim). `where`
  // returns both; we must pick the .cmd/.bat/.exe variant for Node.
  const lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const preferred = lines.find((l) => /\.(cmd|bat|exe)$/i.test(l));
  const resolved = preferred ?? lines[0] ?? command;
  binaryPathCache.set(command, resolved);
  return resolved;
}

/**
 * Cached merged PATH for subprocess spawns. Populated by the daemon
 * boot path via `primeRuntimePath()`. Synchronous reads only — spawn
 * sites can't await. When unset (tests, pre-prime spawns) we fall back
 * to process.env.PATH unchanged, matching pre-fix behaviour.
 *
 * Composition (front-to-back, dedup):
 *   1. process.env.PATH                — daemon's own runtime
 *   2. captured interactive PATH        — what the user's terminal sees
 *   3. known install dirs that exist    — ~/.opencode/bin etc.
 *   4. saved manual cli_paths' dirnames — custom-location binaries
 *
 * See src/lib/runtime-path.ts for the builder used at prime time.
 */
let cachedSpawnPath: string | null = null;

export function setSpawnPath(merged: string): void {
  cachedSpawnPath = merged;
}

export function getSpawnPath(): string | null {
  return cachedSpawnPath;
}

function spawnEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env, ...(extra ?? {}) };
  // Caller-supplied env wins if it explicitly sets PATH (rare; tests).
  if (extra?.PATH) return base;
  if (cachedSpawnPath) base.PATH = cachedSpawnPath;
  // Belt-and-braces: prepend any cached manual-path dirs that aren't
  // already in the merged PATH. Covers "save endpoint ran after prime"
  // — refreshCache stuffs new entries; we re-prepend at spawn time
  // without forcing the daemon to re-run the full prime sequence.
  const dirs = cliPaths.cachedDirs();
  if (dirs.length > 0) {
    const existing = (base.PATH ?? '').split(path.delimiter);
    const missing = dirs.filter((d) => d && !existing.includes(d));
    if (missing.length > 0) {
      base.PATH = [...missing, ...existing].filter((p) => p).join(path.delimiter);
    }
  }
  return base;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const KILL_GRACE_MS = 5_000;               // SIGKILL after SIGTERM + 5s
const HEARTBEAT_INTERVAL_MS = 5_000;       // progress event for non-streaming CLIs
/**
 * Cap on the line-parser scratch buffer (`stdoutBuf`).
 *
 * `fullStdout` already has a 10 MB cap so a pathological no-newline stream
 * can't OOM the daemon — but the parser-side scratch buffer was uncapped,
 * which meant the same pathological stream would still grow `stdoutBuf`
 * forever. Caps the parser-side buffer at 1 MB; if we hit it we force a
 * line-mode flush (treat the whole blob as one line through `parseLine`)
 * then drop it on the floor. Real CLI output never crosses this — code/
 * gemini/opencode all emit `\n`-terminated lines within a few KB.
 */
const MAX_STDOUT_BUF_BYTES = 1 * 1024 * 1024;

/**
 * Where we persist child PIDs across daemon restarts so the reaper can find
 * orphans. One file per spawn, deleted on clean exit.
 */
const PID_DIR = path.join(os.homedir(), '.chorus', 'pids');

function ensurePidDir(): void {
  if (!fs.existsSync(PID_DIR)) fs.mkdirSync(PID_DIR, { recursive: true });
}

function pidFilePath(pid: number): string {
  return path.join(PID_DIR, `${pid}.json`);
}

interface PidRecord {
  pid: number;
  cli: string;
  chatId?: string;
  startedAt: number;
  cwd: string;
}

/**
 * Register a child PID on disk so the reaper can clean it up if the daemon
 * crashes. Called from spawn helpers below; matched by `unregisterPid` on
 * clean exit.
 */
function registerPid(rec: PidRecord): void {
  ensurePidDir();
  try {
    fs.writeFileSync(pidFilePath(rec.pid), JSON.stringify(rec), 'utf-8');
  } catch {
    // Best-effort — failing to register doesn't block the spawn.
  }
}

function unregisterPid(pid: number): void {
  try {
    fs.unlinkSync(pidFilePath(pid));
  } catch {
    // Already gone, fine.
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Daemon-startup reaper. Walks PID_DIR, kills any process that's still alive
 * (orphan from a prior daemon crash), and clears the records.
 *
 * Call once from the daemon's bootstrap before accepting requests. Without
 * this, a daemon crash mid-run leaves child CLIs alive — they'll keep
 * burning subscription quota or API tokens until manually killed.
 */
export function reapOrphanProcesses(): { reaped: number; cleared: number } {
  if (!fs.existsSync(PID_DIR)) return { reaped: 0, cleared: 0 };
  let reaped = 0;
  let cleared = 0;
  for (const entry of fs.readdirSync(PID_DIR)) {
    if (!entry.endsWith('.json')) continue;
    const recordPath = path.join(PID_DIR, entry);
    try {
      const rec = JSON.parse(fs.readFileSync(recordPath, 'utf-8')) as PidRecord;
      // Check if the process is still alive.
      if (processIsAlive(rec.pid)) {
        // Still alive — orphan. Send SIGTERM.
        try {
          process.kill(rec.pid, 'SIGTERM');
        } catch {
          /* ignore */
        }
        // Schedule SIGKILL after grace; use unref so it doesn't block exit.
        const t = setTimeout(() => {
          try {
            process.kill(rec.pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }, KILL_GRACE_MS);
        t.unref();
        reaped++;
        // IMPORTANT: Do not unlink the record yet. If daemon crashes during
        // the grace period, the PID record stays on disk for next startup.
        // The next reaper run will find it and try again.
      } else {
        // Process already dead — safe to clear the record.
        cleared++;
        try {
          fs.unlinkSync(recordPath);
        } catch {
          /* ignore */
        }
      }
    } catch {
      // Malformed record — drop it.
      try {
        fs.unlinkSync(recordPath);
      } catch {
        /* ignore */
      }
    }
  }
  return { reaped, cleared };
}

/**
 * Result handle from `spawnHeadless`. Holds the process for cancellation and
 * an async iterator of AgentEvents the caller consumes.
 */
export interface HeadlessRun {
  pid: number;
  events: AsyncIterable<AgentEvent>;
  /** Resolves when the child exits (clean or killed). */
  done: Promise<{ code: number | null; killed: boolean; reason?: string }>;
}

export interface SpawnHeadlessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  /** If set, written to stdin then stdin closed. */
  stdinPayload?: string;
  /** Environment overrides (merged with process.env). */
  env?: Record<string, string>;
  /** Hard timeout. Default DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** External cancel signal (chat cancelled, daemon shutdown). */
  abortSignal?: AbortSignal;
  /**
   * Stream parser: take a line of stdout, return zero-or-more AgentEvents.
   * Called once per `\n`-terminated line. Buffer split is handled here.
   *
   * Streaming CLIs (Claude, Gemini, Kimi) parse stream-json into deltas.
   * One-shot CLIs (OpenCode, Codex) accumulate text and return it all on
   * the synthetic `message_done` we emit at exit.
   */
  parseLine: (line: string) => AgentEvent[];
  /**
   * Called at process exit with the full accumulated stdout. Used for
   * one-shot CLIs to emit a final `message_done` from the entire blob.
   * Streaming CLIs typically return [] (their `message_done` came from
   * `parseLine` already).
   */
  onExit?: (fullStdout: string, fullStderr: string, code: number | null) => AgentEvent[];
  /**
   * If true, emit a `progress` event every HEARTBEAT_INTERVAL_MS while the
   * process is alive. Use for one-shot CLIs that don't stream. Default false.
   */
  heartbeat?: boolean;
  /** Tag for the PID record (CLI name, chatId). Best-effort logging only. */
  cli: string;
  chatId?: string;
  /**
   * Stream-time error sniffer. Called with the accumulated stderr buffer
   * after every chunk; if it returns a non-null result the subprocess is
   * SIGTERMed and a structured `error` event is enqueued.
   *
   * Solves the 8-minute codex latency: when `codex exec` fails with
   * "access token could not be refreshed", the codex CLI retries
   * internally for ~8 minutes before exiting. Without this hook we wait
   * for the subprocess to give up on its own. With it, we kill the
   * subprocess the moment the deterministic signature appears in stderr.
   *
   * Scanned on stderr only — many CLIs echo the user's prompt to stdout
   * (codex doesn't, gemini does), and an auth-error pattern matching
   * the echoed prompt would false-positive into killing a healthy run.
   */
  earlyAbortStderrScan?: (stderrSoFar: string) => {
    kind: string;
    message: string;
  } | null;
}

/**
 * Spawn a headless CLI subprocess and yield AgentEvents from its stdout.
 *
 * Lifecycle:
 *   1. Spawn child + register PID for orphan reaper
 *   2. Pipe stdinPayload (if any), close stdin
 *   3. Stream stdout line-by-line through parseLine → events queue
 *   4. Emit progress heartbeats if enabled
 *   5. On exit: emit onExit(fullStdout) events, then close iterator
 *   6. On abort/timeout: SIGTERM, then SIGKILL after KILL_GRACE_MS
 *   7. unregister PID on any exit path
 */
export function spawnHeadless(opts: SpawnHeadlessOptions): HeadlessRun {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  // Windows CLIs ship as .cmd shims (npm globals: claude.cmd, codex.cmd,
  // gemini.cmd). Node 18.20+/20.x/22+ added CVE-2024-27980 mitigations that
  // *block* spawn of .cmd/.bat without shell:true (EINVAL). We:
  //   1. Resolve to the full .cmd path via `where` (cached) so PATH lookups
  //      always pick the .cmd shim, never the Bash sibling.
  //   2. Set shell:true ONLY on Windows. DEP0190 fires informationally; our
  //      args are fixed CLI flags (not user-controlled) so the shell-escaping
  //      class of risks doesn't apply here.
  // On Unix this is a no-op: spawn handles ELF/shebang scripts natively.
  const isWindows = process.platform === 'win32';
  const resolvedCommand = resolveBinaryPath(opts.command);

  const child: ChildProcessWithoutNullStreams = spawnChild(resolvedCommand, [...opts.args], {
    cwd: opts.cwd,
    env: spawnEnv(opts.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: isWindows,
  });

  if (child.pid !== undefined) {
    registerPid({
      pid: child.pid,
      cli: opts.cli,
      chatId: opts.chatId,
      startedAt,
      cwd: opts.cwd,
    });
  } else {
    console.warn(`[headless] spawn succeeded but child.pid is undefined (cli=${opts.cli})`);
  }

  // Buffer of pending events for the async iterator. We push from stdout
  // listener / heartbeat / exit; the iterator's `next()` drains.
  const queue: AgentEvent[] = [];
  let queueResolver: ((value: void) => void) | null = null;
  let closed = false;

  const enqueue = (e: AgentEvent): void => {
    queue.push(e);
    if (queueResolver) {
      const r = queueResolver;
      queueResolver = null;
      r();
    }
  };

  const closeQueue = (): void => {
    closed = true;
    if (queueResolver) {
      const r = queueResolver;
      queueResolver = null;
      r();
    }
  };

  // ─── stdin payload ─────────────────────────────────────────────────────
  // Register an error listener BEFORE writing. If the child dies during
  // the write the stdin pipe emits an async 'error' event (EPIPE) — with
  // no listener, Node crashes the whole daemon process. The try/catch
  // below only catches the synchronous throw path. PR #70 audit caught
  // this (antigravity-cli-8 finding #4).
  child.stdin.on('error', () => {
    // intentional no-op — surfaced via the subsequent 'close' + non-zero
    // exit if it actually matters.
  });
  if (opts.stdinPayload !== undefined) {
    try {
      child.stdin.write(opts.stdinPayload);
      child.stdin.end();
    } catch {
      // child may have died before stdin pipe ready
    }
  } else {
    // Always close stdin to unblock CLIs that block on EOF
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
  }

  // ─── stdout / stderr accumulators ──────────────────────────────────────
  //
  // fullStdout + fullStderr buffer the entire CLI output for `onExit` callers
  // (codex/opencode emit one final blob, parsed at exit) and for the tail
  // diagnostic on hangs (lines 391–392 below). A pathological CLI streaming
  // unparsed output forever would otherwise grow these strings unbounded
  // until the daemon OOMs. Cap each at MAX_FULL_BUFFER_BYTES; once exceeded
  // we keep accumulating *for parsing* via stdoutBuf (line-mode), but stop
  // appending to the full-text accumulator and set a truncation flag the
  // exit path surfaces in error events.
  const MAX_FULL_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB
  let stdoutBuf = '';
  let fullStdout = '';
  let stdoutTruncated = false;
  let fullStderr = '';
  let stderrTruncated = false;

  let stdoutBufFlushed = false;
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => {
    if (!stdoutTruncated) {
      if (Buffer.byteLength(fullStdout, 'utf-8') + Buffer.byteLength(chunk, 'utf-8') > MAX_FULL_BUFFER_BYTES) {
        stdoutTruncated = true;
      } else {
        fullStdout += chunk;
      }
    }
    stdoutBuf += chunk;
    let nl: number;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      try {
        for (const evt of opts.parseLine(line)) enqueue(evt);
      } catch (err) {
        enqueue({
          type: 'error',
          kind: 'parse_error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Defend against an unbounded scratch buffer when a CLI streams MB+
    // of output without ever emitting a newline. Force-flush via
    // parseLine once (gives the parser a chance to recover something),
    // then reset so the next chunks aren't appended on top of the
    // already-flushed prefix. One structured warning per spawn — we
    // don't want a spammy stream pumping this on every chunk.
    if (Buffer.byteLength(stdoutBuf, 'utf-8') > MAX_STDOUT_BUF_BYTES) {
      try {
        for (const evt of opts.parseLine(stdoutBuf)) enqueue(evt);
      } catch {
        /* parse error on overflow path isn't fatal */
      }
      stdoutBuf = '';
      if (!stdoutBufFlushed) {
        stdoutBufFlushed = true;
        enqueue({
          type: 'error',
          kind: 'output_truncated',
          message: `${opts.cli} stdout line buffer exceeded ${MAX_STDOUT_BUF_BYTES / (1024 * 1024)} MB without a newline; dropping un-parsed scratch.`,
        });
      }
    }
  });

  // ─── stderr (for error visibility, not parsing) ────────────────────────
  // Tracks whether the early-abort scanner has already fired, so the
  // expensive regex scan only runs until the first hit. Cheap follow-on
  // chunks (heartbeats, progress prints) don't repeat the scan.
  let earlyAbortFired = false;
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk: string) => {
    if (stderrTruncated) return;
    if (Buffer.byteLength(fullStderr, 'utf-8') + Buffer.byteLength(chunk, 'utf-8') > MAX_FULL_BUFFER_BYTES) {
      stderrTruncated = true;
      return;
    }
    fullStderr += chunk;
    if (!earlyAbortFired && opts.earlyAbortStderrScan) {
      try {
        const hit = opts.earlyAbortStderrScan(fullStderr);
        if (hit) {
          earlyAbortFired = true;
          enqueue({
            type: 'error',
            kind: hit.kind,
            message: hit.message,
          });
          sigtermThenKill('early_abort');
        }
      } catch {
        // Detector blew up — never let it crash the headless run.
      }
    }
  });

  // ─── heartbeat ─────────────────────────────────────────────────────────
  let heartbeatHandle: NodeJS.Timeout | null = null;
  if (opts.heartbeat) {
    heartbeatHandle = setInterval(() => {
      if (closed) return;
      enqueue({ type: 'progress', elapsedMs: Date.now() - startedAt });
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatHandle.unref();
  }

  // ─── timeout + abort kill plumbing ─────────────────────────────────────
  let killReason: string | undefined;
  // Hold a reference to the SIGKILL grace timer so finalize() can clear
  // it. PR #74 audit (gemini-cli-1 MEDIUM): when the child dies on
  // SIGTERM before the 5s grace expires, the timer's no-op closure stays
  // pinned in memory until KILL_GRACE_MS — adds 5s of dangling closures
  // per CLI invocation. unref() means it doesn't block process exit but
  // it DOES still hold the closure (and the file-scope `child` ref).
  let killGraceTimer: NodeJS.Timeout | null = null;

  const sigtermThenKill = (reason: string): void => {
    if (killReason) return; // already killing
    killReason = reason;
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    killGraceTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      killGraceTimer = null;
    }, KILL_GRACE_MS);
    killGraceTimer.unref();
  };

  const timeoutHandle = setTimeout(() => {
    sigtermThenKill('timeout');
  }, timeoutMs);
  timeoutHandle.unref();

  const abortHandler = (): void => sigtermThenKill('aborted');
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) {
      sigtermThenKill('aborted');
    } else {
      opts.abortSignal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  // ─── exit/close/error ──────────────────────────────────────────────────
  //
  // We hang the finalization off `close` rather than `exit` because Node
  // does NOT guarantee stdout/stderr have fully drained when `exit` fires.
  // For one-shot CLIs like codex / opencode that feed `fullStdout` into
  // their `onExit` parser, an exit-time parse can see a truncated buffer
  // and emit an empty `message_done` — which downstream renders as a
  // silent zero-byte answer.md. `close` fires only after stdio is drained.
  //
  // The spawn `error` handler can fire WITHOUT a subsequent `close` (e.g.
  // synchronous ENOENT — child never came up), so it must also finalize.
  // A `finalized` guard makes finalize() idempotent regardless of which
  // path gets there first.
  const done = new Promise<{ code: number | null; killed: boolean; reason?: string }>(
    (resolve) => {
      let finalized = false;

      const finalize = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (finalized) return;
        finalized = true;
        clearTimeout(timeoutHandle);
        if (heartbeatHandle) clearInterval(heartbeatHandle);
        if (killGraceTimer) {
          // Child exited within the SIGTERM grace window — cancel the
          // pending SIGKILL or its closure leaks for KILL_GRACE_MS.
          clearTimeout(killGraceTimer);
          killGraceTimer = null;
        }
        if (opts.abortSignal) {
          opts.abortSignal.removeEventListener('abort', abortHandler);
        }
        if (child.pid !== undefined) {
          unregisterPid(child.pid);
        }

        // Drain any trailing partial line through parser one more time.
        if (stdoutBuf.length > 0) {
          try {
            for (const evt of opts.parseLine(stdoutBuf)) enqueue(evt);
          } catch {
            /* parse errors at EOF aren't fatal */
          }
          stdoutBuf = '';
        }

        // Per-shim final emission (e.g. message_done from full output for
        // one-shot CLIs). When the 10 MB accumulator cap was hit we MUST
        // surface a partial-output warning — non-streaming CLIs (codex,
        // opencode) feed fullStdout into onExit() to parse the final blob,
        // and a truncated blob would parse as "complete" silently. The
        // warning is independent of exit code: a "successful" run with a
        // truncated diagnostic is still incomplete from the user's view.
        if (stdoutTruncated || stderrTruncated) {
          enqueue({
            type: 'error',
            kind: 'output_truncated',
            message: `${opts.cli} output exceeded ${MAX_FULL_BUFFER_BYTES / (1024 * 1024)} MB cap; trailing data dropped. Final parse may be incomplete.`,
          });
        }
        if (opts.onExit) {
          try {
            for (const evt of opts.onExit(fullStdout, fullStderr, code)) enqueue(evt);
          } catch {
            /* ignore */
          }
        }

        // Early-abort path already enqueued the SPECIFIC error event
        // (e.g. token_refresh_lost) BEFORE sending SIGTERM. The exit
        // handler must NOT add a second generic "cancelled" / "cli_failed"
        // event on top — downstream consumers (reviewer.ts / doer.ts)
        // process every error event and would overwrite the structured
        // kind with the generic one. Skip the cli_failed branch too for
        // the same reason.
        if (killReason === 'early_abort') {
          // already emitted; nothing further to surface
        } else if (killReason) {
          // Was killed by timeout / abort. Emit the structured error
          // event REGARDLESS of exit code — some CLIs catch SIGTERM and
          // exit 0 on a "graceful" shutdown, which used to silently
          // swallow the kill signal and convince the caller everything
          // was fine. The downstream `errored` flag is now the source
          // of truth; if the CLI also produced a real `message_done`
          // before dying, the answer text is still preserved.
          enqueue({
            type: 'error',
            kind: killReason,
            message: killReason === 'timeout'
              ? `CLI ${opts.cli} timed out after ${Math.round(timeoutMs / 1000)}s`
              : `CLI ${opts.cli} cancelled`,
          });
        } else if (code !== 0 && code !== null) {
          // Process exited non-zero on its own — likely auth/config/quota.
          // Surface BOTH stderr and stdout so the user sees an actionable
          // message instead of a silent 0-byte answer.md. Some CLIs print
          // their actual error to stdout (kimi: "LLM not set") and only
          // bookkeeping info to stderr ("To resume this session: ..."), so
          // checking both is non-optional. Trim to keep it terse.
          const stderrTail = fullStderr.trim().slice(-300);
          const stdoutTail = fullStdout.trim().slice(-300);

          // Specialize the most common failure mode at launch — daemon
          // spawned from a non-interactive shell, can't find the CLI on
          // PATH. Bash exits 127 and prints "command not found" to one
          // of the streams. Without this branch the generic `cli_failed`
          // surfaces "opencode exited 127: bash: line 1: opencode: command
          // not found", which is technically accurate but doesn't tell
          // the user how to fix it. Emit `cli_not_in_path` instead with
          // a doctor pointer.
          const cmdNotFound = /command not found|: not found/i;
          const isPathError =
            code === 127 || cmdNotFound.test(stderrTail) || cmdNotFound.test(stdoutTail);
          if (isPathError) {
            enqueue({
              type: 'error',
              kind: 'cli_not_in_path',
              message:
                `${opts.cli} not found on the daemon's PATH. ` +
                `Run 'chorus doctor' for a diagnosis, or set the path manually ` +
                `via Settings → Connect a CLI → "I know where it is".`,
            });
          } else {
            const tails = [stdoutTail, stderrTail].filter((s) => s.length > 0).join(' | ');
            const truncationNote =
              stdoutTruncated || stderrTruncated
                ? `[output truncated at ${MAX_FULL_BUFFER_BYTES / (1024 * 1024)}MB cap]`
                : '';
            const detail = [tails, truncationNote].filter((s) => s.length > 0).join(' ');
            enqueue({
              type: 'error',
              kind: 'cli_failed',
              message: detail.length > 0
                ? `${opts.cli} exited ${code}: ${detail}`
                : `${opts.cli} exited ${code} with no output`,
            });
          }
        }

        closeQueue();
        resolve({ code, killed: Boolean(killReason), reason: killReason });
        void signal; // signal is captured for potential future use
      };

      child.on('close', (code, signal) => finalize(code, signal));

      child.on('error', (err) => {
        // ENOENT is the direct-spawn equivalent of bash's exit-127 — the
        // binary literally isn't on the daemon's PATH. Surface the same
        // doctor pointer as the bash-wrapped path-error branch above.
        //
        // Critical: also finalize here. If spawn fails synchronously
        // (binary not on PATH), `close` may never fire — the queue
        // would stay open forever and async iterators waiting on
        // events would hang. The `finalized` guard makes this safe to
        // call even when `close` ALSO fires.
        const enoent =
          (err as NodeJS.ErrnoException).code === 'ENOENT' ||
          /ENOENT/.test(err.message);
        enqueue({
          type: 'error',
          kind: enoent ? 'cli_not_in_path' : 'spawn_failed',
          message: enoent
            ? `${opts.cli} not found on the daemon's PATH (ENOENT: ${err.message}). ` +
              `Run 'chorus doctor' or set the path manually via Settings.`
            : err.message,
        });
        finalize(null, null);
      });
    },
  );

  // ─── async iterator ────────────────────────────────────────────────────
  //
  // The custom iterator implements `return()` and `throw()` in addition to
  // `next()` so `for await` consumers that break early — or whose body
  // throws — tear the subprocess down via SIGTERM instead of letting it
  // run as a background orphan.
  //
  // Without these methods, the runtime's automatic cleanup walks away
  // and the child CLI keeps consuming subscription quota / API tokens
  // until either the spawnHeadless `timeoutMs` fires or the daemon
  // restarts. PR #70 audit (antigravity-cli-8 finding #1, marked
  // CRITICAL) caught this.
  //
  // `sigtermThenKill` is idempotent (its own `killReason` guard), so
  // calling it on dispose even after a natural close is safe — the
  // `closed` check below is a fast-path optimisation, not correctness.
  const disposeIterator = (reason: string): void => {
    if (closed) return;
    sigtermThenKill(reason);
  };

  const events: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      return {
        async next(): Promise<IteratorResult<AgentEvent>> {
          while (queue.length === 0 && !closed) {
            await new Promise<void>((resolve) => {
              queueResolver = resolve;
            });
          }
          if (queue.length > 0) {
            const value = queue.shift() as AgentEvent;
            return { value, done: false };
          }
          return { value: undefined, done: true };
        },
        async return(): Promise<IteratorResult<AgentEvent>> {
          // `for await ... break`, manual `iter.return()`, or generator
          // early-completion. Tear the subprocess down so the underlying
          // CLI doesn't keep running to completion against a consumer
          // that has stopped listening.
          disposeIterator('iterator_disposed');
          return { value: undefined, done: true };
        },
        async throw(err?: unknown): Promise<IteratorResult<AgentEvent>> {
          // Consumer's `for await` body threw — same cleanup as
          // early-break. Re-throw so the caller's catch / rethrow chain
          // still sees the original error.
          disposeIterator('iterator_threw');
          throw err;
        },
      };
    },
  };

  return { pid: child.pid ?? -1, events, done };
}
