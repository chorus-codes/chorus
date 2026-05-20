/**
 * Daemon-wide chat-concurrency settings — distinct from cli-concurrency.
 *
 * `cli-semaphore.ts` caps the number of SUBPROCESSES per binary family
 * (max 2 opencode, max 3 codex, etc.). That helps with per-CLI memory
 * pressure but doesn't prevent the failure mode that crashed the box
 * on 2026-05-20: three concurrent chats × 8 reviewers each = 24
 * subprocesses fanning out in parallel. Even with the per-CLI semaphore
 * serialising within each lineage, the aggregate RAM + queued reviewer
 * state (file descriptors, SSE buffers, abort controllers) exhausted
 * 31 GB RAM + swap. Load avg hit 320.
 *
 * This module adds a HIGHER-level cap: max number of CHATS actively
 * fanning out simultaneously. When at cap, new chats wait at the
 * runner-entry layer — they're created in the DB and the cockpit
 * shows them as `drafting`, but no reviewer subprocesses spawn until
 * a running chat finishes.
 *
 * Three knobs, all daemon-wide, settings-backed (no daemon restart):
 *
 *   - `maxConcurrentChats` (1..20, default 3) — max chats that can be
 *     actively running. Whichever chat hits the gate fourth queues.
 *
 *   - `swapMinFreeMb` (0..16384, default 1024) — if free swap drops
 *     below this, refuse to admit new chats. 0 = disabled. Catches the
 *     incident from 2026-05-20 where swap went to 24 MB free before the
 *     host became unresponsive.
 *
 *   - `loadAvgMaxPerCore` (0..10, default 4.0) — if 1-min load avg
 *     divided by CPU count exceeds this, refuse to admit. 0 = disabled.
 *     Per-core multiplier so a 4-core box at load 16 looks the same as
 *     a 16-core box at load 64. 4.0 means "4× more pending work than
 *     CPUs can handle" — comfortably past the tipping point but well
 *     short of the load-320 catastrophe.
 *
 * Defaults are conservative: a single user with a 16 GB box should
 * notice no throttling under normal use. The settings are there for
 * the user who hits the wall.
 */

import { cpus } from 'node:os';
import { z } from 'zod';
import { settings } from '../db/index.js';

const DEFAULT_MAX_CONCURRENT_CHATS = 3;
const DEFAULT_SWAP_MIN_FREE_MB = 1024;
const DEFAULT_LOAD_AVG_MAX_PER_CORE = 4.0;

export const ChatConcurrencySchema = z.object({
  maxConcurrentChats: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(DEFAULT_MAX_CONCURRENT_CHATS),
  /**
   * Free swap in MB below which the gate refuses to admit a new chat.
   * 0 disables the check (boxes without swap; CI / containers).
   */
  swapMinFreeMb: z
    .number()
    .int()
    .min(0)
    .max(16384)
    .default(DEFAULT_SWAP_MIN_FREE_MB),
  /**
   * 1-min load avg divided by CPU count above which the gate refuses.
   * 0 disables the check.
   */
  loadAvgMaxPerCore: z
    .number()
    .min(0)
    .max(10)
    .default(DEFAULT_LOAD_AVG_MAX_PER_CORE),
});

export type ChatConcurrencyConfig = z.infer<typeof ChatConcurrencySchema>;

const SETTINGS_KEY = 'chat_concurrency';

export async function getChatConcurrency(): Promise<ChatConcurrencyConfig> {
  const raw = await settings.get(SETTINGS_KEY);
  if (raw === null) {
    return ChatConcurrencySchema.parse({});
  }
  // safeParse so a hand-edited bogus value never crashes the gate —
  // fall back to defaults, the cockpit will surface the broken state on
  // next save anyway.
  const result = ChatConcurrencySchema.safeParse(raw);
  if (!result.success) {
    return ChatConcurrencySchema.parse({});
  }
  return result.data;
}

export async function setChatConcurrency(
  config: ChatConcurrencyConfig,
): Promise<void> {
  const validated = ChatConcurrencySchema.parse(config);
  await settings.set(SETTINGS_KEY, validated);
}

/** Defaults exposed for the cockpit form. */
export const _defaults = {
  maxConcurrentChats: DEFAULT_MAX_CONCURRENT_CHATS,
  swapMinFreeMb: DEFAULT_SWAP_MIN_FREE_MB,
  loadAvgMaxPerCore: DEFAULT_LOAD_AVG_MAX_PER_CORE,
  cpuCount: cpus().length,
};
