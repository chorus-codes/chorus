/**
 * Tests for the daemon-wide chat admission gate.
 *
 * Pure tests for `evaluateAdmission` — exhaustively cover the
 * constraint matrix without spinning up the daemon. Integration-style
 * tests for `admitChat` cover FIFO ordering, queued-callback firing,
 * cancellation, and release.
 *
 * The module's chats-concurrency settings are read via the real
 * `settings` table (vitest's per-file isolated SQLite); each test
 * resets the gate's in-memory state via `_testing.reset()`.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  admitChat,
  evaluateAdmission,
  snapshot,
  _testing,
  type AdmitDecision,
} from '../src/daemon/chat-gate.js';
import {
  setChatConcurrency,
  type ChatConcurrencyConfig,
} from '../src/lib/settings/chat-concurrency.js';

const STATS_OK = { swapFreeMb: 8192, loadAvg1: 1.0, cpuCount: 4 };

beforeEach(async () => {
  _testing.reset();
});

afterEach(() => {
  _testing.reset();
  vi.useRealTimers();
});

describe('evaluateAdmission — pure constraint logic', () => {
  const cfg: ChatConcurrencyConfig = {
    maxConcurrentChats: 3,
    swapMinFreeMb: 1024,
    loadAvgMaxPerCore: 4.0,
  };

  it('admits when all constraints clear', () => {
    expect(evaluateAdmission(0, STATS_OK, cfg)).toEqual({ admit: true });
    expect(evaluateAdmission(2, STATS_OK, cfg)).toEqual({ admit: true });
  });

  it('refuses with chats_at_cap when at cap', () => {
    const decision = evaluateAdmission(3, STATS_OK, cfg);
    expect(decision.admit).toBe(false);
    expect(decision.reason).toBe('chats_at_cap');
    expect(decision.message).toContain('3/3');
  });

  it('refuses with swap_low when free swap below threshold', () => {
    const decision = evaluateAdmission(0, { ...STATS_OK, swapFreeMb: 512 }, cfg);
    expect(decision.admit).toBe(false);
    expect(decision.reason).toBe('swap_low');
    expect(decision.message).toContain('512');
  });

  it('treats swap=0 as "platform reports no swap" — skips the swap check', () => {
    // macOS / containers without /proc/meminfo. Don't penalise the
    // user by refusing every chat.
    expect(evaluateAdmission(0, { ...STATS_OK, swapFreeMb: 0 }, cfg)).toEqual({
      admit: true,
    });
  });

  it('skips swap check when swapMinFreeMb is 0 (user disabled)', () => {
    const noSwapCfg = { ...cfg, swapMinFreeMb: 0 };
    expect(
      evaluateAdmission(0, { ...STATS_OK, swapFreeMb: 100 }, noSwapCfg),
    ).toEqual({ admit: true });
  });

  it('refuses with load_high when load/core exceeds threshold', () => {
    // load 20 / 4 cores = 5.0 per core, above 4.0 threshold
    const decision = evaluateAdmission(0, { ...STATS_OK, loadAvg1: 20 }, cfg);
    expect(decision.admit).toBe(false);
    expect(decision.reason).toBe('load_high');
    expect(decision.message).toContain('5.00');
  });

  it('skips load check when loadAvgMaxPerCore is 0 (user disabled)', () => {
    const noLoadCfg = { ...cfg, loadAvgMaxPerCore: 0 };
    expect(
      evaluateAdmission(0, { ...STATS_OK, loadAvg1: 100 }, noLoadCfg),
    ).toEqual({ admit: true });
  });

  it('prioritises chats_at_cap over swap/load (stable reason)', () => {
    // All constraints bad — chats_at_cap wins for a stable message
    // (UI flapping between reasons under multi-constraint blocks is
    // worse than picking one).
    const decision = evaluateAdmission(
      5,
      { swapFreeMb: 100, loadAvg1: 100, cpuCount: 4 },
      cfg,
    );
    expect(decision.reason).toBe('chats_at_cap');
  });

  it('scales load check by CPU count (per-core)', () => {
    // load 8 on a 16-core box = 0.5 per core — fine
    const big = evaluateAdmission(0, { swapFreeMb: 8192, loadAvg1: 8, cpuCount: 16 }, cfg);
    expect(big.admit).toBe(true);
    // Same load 8 on a 1-core box = 8 per core — high
    const small = evaluateAdmission(0, { swapFreeMb: 8192, loadAvg1: 8, cpuCount: 1 }, cfg);
    expect(small.admit).toBe(false);
    expect(small.reason).toBe('load_high');
  });
});

describe('admitChat — gate semantics', () => {
  it('admits immediately when no other chats are active', async () => {
    await setChatConcurrency({
      maxConcurrentChats: 3,
      swapMinFreeMb: 0,
      loadAvgMaxPerCore: 0,
    });
    const release = await admitChat();
    expect(snapshot().activeChats).toBe(1);
    expect(snapshot().queueDepth).toBe(0);
    release();
    expect(snapshot().activeChats).toBe(0);
  });

  it('queues the fourth chat when cap is 3', async () => {
    await setChatConcurrency({
      maxConcurrentChats: 3,
      swapMinFreeMb: 0,
      loadAvgMaxPerCore: 0,
    });
    const r1 = await admitChat();
    const r2 = await admitChat();
    const r3 = await admitChat();
    expect(snapshot().activeChats).toBe(3);

    // Fourth admit is queued — capture the promise without awaiting
    const waitDecisions: AdmitDecision[] = [];
    const positionsSeen: number[] = [];
    const p4 = admitChat({
      onWait: (d, pos) => {
        waitDecisions.push(d);
        positionsSeen.push(pos);
      },
    });
    // Yield so the gate's tryGrantHead microtask runs and onWait fires
    await new Promise((res) => setTimeout(res, 10));
    expect(snapshot().queueDepth).toBe(1);
    expect(waitDecisions.length).toBeGreaterThan(0);
    expect(waitDecisions[0].admit).toBe(false);
    expect(waitDecisions[0].reason).toBe('chats_at_cap');
    expect(positionsSeen[0]).toBe(1);

    // Release one — the queued chat should now admit
    r1();
    const r4 = await p4;
    expect(snapshot().activeChats).toBe(3); // r2, r3, r4
    expect(snapshot().queueDepth).toBe(0);

    r2();
    r3();
    r4();
    expect(snapshot().activeChats).toBe(0);
  });

  it('preserves FIFO ordering across releases', async () => {
    await setChatConcurrency({
      maxConcurrentChats: 1,
      swapMinFreeMb: 0,
      loadAvgMaxPerCore: 0,
    });
    const r1 = await admitChat();

    const order: string[] = [];
    const p2 = admitChat().then((rel) => {
      order.push('p2');
      return rel;
    });
    const p3 = admitChat().then((rel) => {
      order.push('p3');
      return rel;
    });
    // Wait for both to be queued
    await new Promise((res) => setTimeout(res, 10));
    expect(snapshot().queueDepth).toBe(2);

    r1();
    const r2 = await p2;
    expect(order).toEqual(['p2']);
    r2();
    const r3 = await p3;
    expect(order).toEqual(['p2', 'p3']);
    r3();
  });

  it('cancellation removes a queued waiter without holding the queue', async () => {
    await setChatConcurrency({
      maxConcurrentChats: 1,
      swapMinFreeMb: 0,
      loadAvgMaxPerCore: 0,
    });
    const r1 = await admitChat();

    const ac = new AbortController();
    const cancelled = admitChat({ signal: ac.signal });

    // Behind it, another waiter
    const p3 = admitChat();

    await new Promise((res) => setTimeout(res, 10));
    expect(snapshot().queueDepth).toBe(2);

    // Abort the front waiter — back waiter must promote correctly
    ac.abort();
    await expect(cancelled).rejects.toBeDefined();
    await new Promise((res) => setTimeout(res, 10));
    expect(snapshot().queueDepth).toBe(1);

    r1();
    const r3 = await p3;
    r3();
  });

  it('release is idempotent — double-call does not underflow', async () => {
    await setChatConcurrency({
      maxConcurrentChats: 2,
      swapMinFreeMb: 0,
      loadAvgMaxPerCore: 0,
    });
    const r1 = await admitChat();
    const r2 = await admitChat();
    expect(snapshot().activeChats).toBe(2);
    r1();
    r1(); // second call is a no-op
    expect(snapshot().activeChats).toBe(1);
    r2();
    r2();
    expect(snapshot().activeChats).toBe(0);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(admitChat({ signal: ac.signal })).rejects.toBeDefined();
    expect(snapshot().activeChats).toBe(0);
  });
});
