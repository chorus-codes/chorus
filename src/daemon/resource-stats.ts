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
  /**
   * Free swap in MB. -1 on platforms without /proc/meminfo (macOS,
   * containers) — caller treats `-1` as "skip the swap check".
   *
   * Critically: 0 is NOT a sentinel. 0 means "swap is genuinely
   * exhausted" — exactly the failure mode the gate was built to catch
   * (2026-05-20 incident: Linux host with SwapFree=24kB hung on swap
   * thrash). Convergent self-review (4/6 reviewers on PR #64) caught
   * the original sentinel-0 bug, which would have made the gate admit
   * chats at the moment of maximum vulnerability.
   */
  swapFreeMb: number;
  /** 1-minute load average. */
  loadAvg1: number;
  /** CPU count — denominator for load-per-core check. */
  cpuCount: number;
}

/**
 * Read free swap from /proc/meminfo. Returns -1 (not 0) when
 * unavailable so callers can distinguish "platform reports nothing"
 * from "SwapFree is genuinely 0 — host is OOM-imminent".
 */
function readSwapFreeMb(): number {
  if (platform() !== 'linux') return -1;
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8');
    const match = meminfo.match(/^SwapFree:\s+(\d+)\s+kB/m);
    if (!match) return -1;
    return Math.floor(parseInt(match[1], 10) / 1024);
  } catch {
    return -1;
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
