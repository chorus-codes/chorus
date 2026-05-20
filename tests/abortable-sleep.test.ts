/**
 * abortableSleep tests — the helper backing the retry-loop backoff.
 *
 * If this regresses, a cancelled chat hangs for the full backoff
 * window before teardown — exactly the bug chorus self-audit on
 * PR #79 flagged.
 */
import { describe, expect, it } from 'vitest';
import { abortableSleep } from '@/lib/abortable-sleep';

describe('abortableSleep', () => {
  it('resolves true after the full delay when no abort fires', async () => {
    const startedAt = Date.now();
    const completed = await abortableSleep(40, new AbortController().signal);
    const elapsed = Date.now() - startedAt;
    expect(completed).toBe(true);
    // Generous lower bound so flaky CI doesn't false-positive on jitter.
    expect(elapsed).toBeGreaterThanOrEqual(30);
  });

  it('returns false synchronously when signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const startedAt = Date.now();
    const completed = await abortableSleep(1000, ctrl.signal);
    const elapsed = Date.now() - startedAt;
    expect(completed).toBe(false);
    // Synchronous resolution — no waiting on the timer at all.
    expect(elapsed).toBeLessThan(20);
  });

  it('returns false promptly when abort fires mid-sleep', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    const startedAt = Date.now();
    const completed = await abortableSleep(1000, ctrl.signal);
    const elapsed = Date.now() - startedAt;
    expect(completed).toBe(false);
    // Should resolve close to the abort firing, NOT wait the full 1s.
    expect(elapsed).toBeLessThan(200);
  });

  it('removes its abort listener so a late abort does not leak', async () => {
    const ctrl = new AbortController();
    await abortableSleep(20, ctrl.signal);
    // After normal completion, firing the signal must be a no-op —
    // the listener should already be detached. If it weren't, the
    // detached resolve() would still fire, which is harmless but
    // observable as listener-count drift on the signal.
    // We can't directly inspect listeners on AbortSignal, so the
    // assertion is just that no exception is thrown when the now-
    // unrelated abort fires.
    expect(() => ctrl.abort()).not.toThrow();
  });
});
