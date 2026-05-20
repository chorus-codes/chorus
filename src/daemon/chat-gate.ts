/**
 * Daemon-wide chat admission gate.
 *
 * Sits at the runner-entry: every `runChat` call awaits `admitChat(...)`
 * before fanning out reviewers. When at cap (or under resource pressure)
 * the call blocks; the chat row stays in `drafting` and the cockpit's
 * SSE stream gets a `chat_progress` event tagged with `reason: 'queued'`
 * so the run page can show "Waiting for slot — N chats ahead".
 *
 * Design mirrors `cli-semaphore.ts` (mutex + FIFO queue + dynamic
 * settings re-read). Differences:
 *
 *   - Single queue (no per-lineage subqueue) — admission is whole-chat.
 *   - Admission check is multi-factor: chat count + free swap +
 *     load-per-core, all from settings.
 *   - Periodic resource-recheck: even with no chat-end event, the gate
 *     re-evaluates every 30s so a transient swap spike clears
 *     automatically.
 *
 * The gate is daemon-wide module state — there's exactly one daemon
 * process so this is the authoritative counter. Tests use
 * `_testing.reset()` between cases.
 */

import {
  getChatConcurrency,
  type ChatConcurrencyConfig,
} from '../lib/settings/chat-concurrency.js';
import { readResourceStats, type ResourceStats } from './resource-stats.js';

/**
 * Why the gate refused to admit this chat right now. Surfaced to the
 * cockpit so the run page can render a meaningful "Queued because…"
 * line.
 */
export type AdmitDenyReason =
  | 'chats_at_cap'
  | 'swap_low'
  | 'load_high';

export interface AdmitDecision {
  admit: boolean;
  /** Set when admit=false; identifies the binding constraint. */
  reason?: AdmitDenyReason;
  /** Human-readable explanation including the binding number. */
  message?: string;
}

/**
 * Pure decision function — given current admitted count + resource
 * snapshot + config, return whether to admit. No I/O, easy to unit
 * test exhaustively.
 *
 * Order of checks matters for the `reason` field: chats_at_cap wins
 * over swap_low wins over load_high, so the cockpit message is stable
 * across multi-constraint blocks (otherwise UI would flap between
 * "Queued (swap low)" and "Queued (load high)" as conditions oscillate).
 */
export function evaluateAdmission(
  activeChats: number,
  stats: ResourceStats,
  config: ChatConcurrencyConfig,
): AdmitDecision {
  if (activeChats >= config.maxConcurrentChats) {
    return {
      admit: false,
      reason: 'chats_at_cap',
      message: `${activeChats}/${config.maxConcurrentChats} chats already running`,
    };
  }
  // swapMinFreeMb=0 → user disabled the check.
  // stats.swapFreeMb=-1 → platform doesn't expose swap (macOS,
  //   containers without /proc/meminfo) — skip rather than block.
  // stats.swapFreeMb=0 → swap is genuinely exhausted; THIS is the
  //   incident-2026-05-20 case we MUST catch (prior revision used 0
  //   as a sentinel and silently bypassed the check at the worst
  //   possible moment).
  if (
    config.swapMinFreeMb > 0 &&
    stats.swapFreeMb >= 0 &&
    stats.swapFreeMb < config.swapMinFreeMb
  ) {
    return {
      admit: false,
      reason: 'swap_low',
      message: `free swap ${stats.swapFreeMb}MB below threshold ${config.swapMinFreeMb}MB`,
    };
  }
  if (config.loadAvgMaxPerCore > 0 && stats.cpuCount > 0) {
    const perCore = stats.loadAvg1 / stats.cpuCount;
    if (perCore > config.loadAvgMaxPerCore) {
      return {
        admit: false,
        reason: 'load_high',
        message: `load/core ${perCore.toFixed(2)} above threshold ${config.loadAvgMaxPerCore}`,
      };
    }
  }
  return { admit: true };
}

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
  /** Callback invoked when the gate re-evaluates and the chat is still
   *  waiting — lets the runner emit a `chat_progress` event so the
   *  cockpit knows it's still gated and why. */
  onWait?: (decision: AdmitDecision, position: number) => void;
  cleanup?: () => void;
}

let activeChats = 0;
const waiters: Waiter[] = [];

let granting = false;
let dirty = false;

/**
 * Recheck cadence when the queue head is blocked on resource pressure
 * (swap/load) rather than chat-cap. Without this, a queue that's
 * blocked purely on swap_low would never re-evaluate until a chat
 * ends — but if no chat is running, that's never.
 */
const RESOURCE_RECHECK_MS = 30_000;
let recheckTimer: NodeJS.Timeout | null = null;

function scheduleRecheck(): void {
  if (recheckTimer) return;
  if (waiters.length === 0) return;
  recheckTimer = setTimeout(() => {
    recheckTimer = null;
    void tryGrantHead();
  }, RESOURCE_RECHECK_MS);
}

function cancelRecheck(): void {
  if (recheckTimer) {
    clearTimeout(recheckTimer);
    recheckTimer = null;
  }
}

/**
 * Try to grant the head waiter. Recursive in spirit (re-runs after
 * each grant) but flattened into a loop. Reentrant-safe via the
 * granting/dirty mutex — same pattern as cli-semaphore.
 *
 * When the head can't be admitted but the reason is resource pressure
 * (not chats_at_cap), notify the waiter so the cockpit shows the
 * current reason, and schedule a periodic recheck so transient
 * swap/load spikes clear.
 */
async function tryGrantHead(): Promise<void> {
  if (granting) {
    dirty = true;
    return;
  }
  granting = true;
  dirty = false;
  try {
    do {
      dirty = false;
      while (waiters.length > 0) {
        const config = await getChatConcurrency();
        if (waiters.length === 0) break;
        const stats = readResourceStats();
        const decision = evaluateAdmission(activeChats, stats, config);
        if (!decision.admit) {
          // Notify all waiting chats of their queue position + current
          // reason. Position = 1-indexed slot in the FIFO.
          for (let i = 0; i < waiters.length; i++) {
            try {
              waiters[i].onWait?.(decision, i + 1);
            } catch {
              /* swallow — a buggy onWait should not deadlock the gate */
            }
          }
          // If blocked on resource pressure, schedule a periodic recheck
          // since no chat_end event will arrive. chats_at_cap unblocks
          // naturally on release().
          if (decision.reason !== 'chats_at_cap') {
            scheduleRecheck();
          }
          break;
        }
        const head = waiters.shift()!;
        activeChats++;
        head.cleanup?.();
        head.resolve();
      }
    } while (dirty);
  } catch (err) {
    // Settings DB unreadable, resource stats read failed, anything
    // unexpected. Pre-fix this just logged and exited, leaving the
    // queue stranded — convergent self-review (6/6 reviewers on PR
    // #64) flagged this. Two-pronged recovery:
    //   1. Schedule a recheck so the queue gets another chance once
    //      the transient issue clears.
    //   2. If the failure persists, the recheck will hit the same
    //      catch again; that's acceptable — better a noisy log than
    //      a silently stalled queue. For a circuit-breaker we'd add
    //      a consecutive-failure counter, but the simpler retry
    //      handles the common DB-busy / disk-blip cases.
    console.error('[chorus] chat-gate tryGrantHead failed:', err);
    if (waiters.length > 0) {
      scheduleRecheck();
    }
  } finally {
    granting = false;
  }
}

export interface AdmitOptions {
  /** Cancel teardown for a queued chat (chat cancel, daemon shutdown). */
  signal?: AbortSignal;
  /** Invoked while the chat is waiting; lets the caller emit SSE events. */
  onWait?: (decision: AdmitDecision, position: number) => void;
}

/**
 * Acquire an admission slot. Returns a release() function the caller
 * MUST invoke (typically in a finally block) when the chat reaches a
 * terminal state. Idempotent on release — calling twice is a no-op.
 *
 * The chat's row stays at status='drafting' in the DB while queued;
 * onWait fires immediately with the current decision so the cockpit
 * knows whether to render "Drafting" or "Queued (reason)" right away.
 */
export async function admitChat(
  opts: AdmitOptions = {},
): Promise<() => void> {
  return new Promise<() => void>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(opts.signal.reason ?? new Error('aborted'));
      return;
    }

    // settled flag prevents double-resolution if abort fires AFTER
    // tryGrantHead has shifted+resolved this waiter but BEFORE the
    // resolve's microtask runs. Node tolerates redundant resolve/
    // reject calls on a settled promise, but a future Promise impl
    // change could surface it as an unhandled rejection — belt-and-
    // suspenders. Convergent self-review (PR #64, ocg-4) flagged it.
    let settled = false;
    const waiter: Waiter = {
      resolve: () => {
        if (settled) return;
        settled = true;
        resolve(makeRelease());
      },
      reject: (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err);
      },
      onWait: opts.onWait,
    };

    if (opts.signal) {
      const onAbort = (): void => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        // Re-poke in case the abort frees up something at the head.
        void tryGrantHead();
        waiter.reject(opts.signal!.reason ?? new Error('aborted'));
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      waiter.cleanup = (): void => opts.signal!.removeEventListener('abort', onAbort);
    }

    waiters.push(waiter);
    void tryGrantHead();
  });
}

function makeRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeChats = Math.max(0, activeChats - 1);
    // Cancel any pending resource recheck — a real release event is
    // a stronger signal than the periodic poll.
    cancelRecheck();
    void tryGrantHead();
  };
}

/** Diagnostic snapshot for /api/v1/diagnostics + tests. */
export function snapshot(): {
  activeChats: number;
  queueDepth: number;
} {
  return {
    activeChats,
    queueDepth: waiters.length,
  };
}

/**
 * External poke for "settings changed, re-evaluate the queue". Called
 * by the PUT /settings/chat-concurrency route after a successful save
 * so that an increased maxConcurrentChats / loosened swap floor /
 * loosened load cap admits queued chats immediately — without it,
 * users bumping the cap up would have to wait for an active chat to
 * end before queued chats could proceed. Convergent self-review
 * (2/6 reviewers on PR #64) flagged the gap.
 */
export function pokeGate(): void {
  void tryGrantHead();
}

export const _testing = {
  reset: (): void => {
    activeChats = 0;
    granting = false;
    dirty = false;
    cancelRecheck();
    while (waiters.length > 0) {
      const w = waiters.shift();
      if (!w) break;
      w.cleanup?.();
      try {
        w.reject(new Error('chat-gate reset (tests)'));
      } catch {
        /* defensive */
      }
    }
  },
};
