/**
 * Lightweight resource stats for the chat-gate admission check.
 *
 * Pure-ish: reads `/proc/meminfo` + `os.loadavg()` synchronously. No
 * subprocess, no network. Both calls are sub-millisecond on Linux.
 * macOS has no /proc/meminfo — swap is reported as 0 free there, which
 * effectively disables the swap-check on macOS (the gate's default
 * `swapMinFreeMb=1024` would refuse every chat). Users on macOS should
 * lower swapMinFreeMb to 0 if they want the gate active.
 *
 * Output shape kept narrow so the admit-decision function (in chat-gate)
 * stays a pure function of (state, config) — no side effects, easy to
 * unit-test.
 */

import * as fs from 'node:fs';
import { cpus, loadavg, platform } from 'node:os';

export interface ResourceStats {
  /** Free swap in MB. 0 on platforms without /proc/meminfo. */
  swapFreeMb: number;
  /** 1-minute load average. */
  loadAvg1: number;
  /** CPU count — denominator for load-per-core check. */
  cpuCount: number;
}

/**
 * Read free swap from /proc/meminfo. Returns 0 on non-Linux or if the
 * file is unreadable / malformed. Caller treats 0 as "swap-check
 * skipped" — combined with the gate's swap=0 disabled semantics, a
 * macOS / container without /proc/meminfo effectively bypasses the
 * swap guard rather than blocking every chat.
 */
function readSwapFreeMb(): number {
  if (platform() !== 'linux') return 0;
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8');
    const match = meminfo.match(/^SwapFree:\s+(\d+)\s+kB/m);
    if (!match) return 0;
    return Math.floor(parseInt(match[1], 10) / 1024);
  } catch {
    return 0;
  }
}

/** Snapshot of current resource pressure. Called per admission attempt. */
export function readResourceStats(): ResourceStats {
  return {
    swapFreeMb: readSwapFreeMb(),
    loadAvg1: loadavg()[0] ?? 0,
    cpuCount: cpus().length,
  };
}
