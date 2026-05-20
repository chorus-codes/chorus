/**
 * Async iterator cleanup tests for `spawnHeadless`.
 *
 * The bug this exists for: when a `for await (event of stream)` consumer
 * breaks early or throws, the iterator runtime calls `return()` / `throw()`
 * on the iterator. Before this fix, neither method existed on
 * spawnHeadless's hand-rolled iterator — so the subprocess kept running,
 * burning subscription quota / API tokens until `timeoutMs` fired (default
 * 10 min) or the daemon restarted.
 *
 * PR #70 audit caught this (antigravity-cli-8 finding #1, CRITICAL).
 *
 * Tests use a real subprocess (`bash -c "sleep N; ..."`) to verify the
 * SIGTERM actually lands. Sleep durations are short (3-5s) but long
 * enough that a missing cleanup would obviously leave the process alive
 * past test exit. Each test asserts on the `done` promise resolving
 * with `killed: true` and the appropriate reason.
 */
import { describe, expect, it } from 'vitest';
import { spawnHeadless } from '../src/daemon/headless.js';

const LONG_RUNNING = `for i in 1 2 3 4 5; do echo "tick $i"; sleep 1; done`;

describe('spawnHeadless iterator cleanup', () => {
  it('SIGTERMs the subprocess when the for-await loop breaks early', async () => {
    const run = spawnHeadless({
      command: 'bash',
      args: ['-c', LONG_RUNNING],
      cwd: process.cwd(),
      cli: 'test-bash',
      // Cap so the test can't hang — without iterator cleanup the
      // subprocess would run the full 5s loop.
      timeoutMs: 30_000,
      parseLine: (line) =>
        line.length > 0 ? [{ type: 'text_delta', text: line }] : [],
    });

    let firstEvent = '';
    for await (const evt of run.events) {
      if (evt.type === 'text_delta') {
        firstEvent = evt.text;
        break;
      }
    }
    // We got tick 1 — at least one delta arrived before the break.
    expect(firstEvent).toContain('tick');

    // The break above triggers iterator.return() → sigtermThenKill →
    // child dies on SIGTERM within the 5s grace window. `done` should
    // resolve with killed=true and a non-timeout reason.
    const result = await run.done;
    expect(result.killed).toBe(true);
    expect(result.reason).toBe('iterator_disposed');
  }, 15_000);

  it('SIGTERMs the subprocess when the consumer throws inside the for-await loop', async () => {
    // Per the iterator protocol, the runtime calls `return()` (not
    // `throw()`) when a for-await body throws — `throw()` is reserved
    // for explicit `iter.throw(err)` calls. So this test verifies the
    // cleanup happens on the body-throw path even though the reason
    // ends up `iterator_disposed`, not `iterator_threw`.
    const run = spawnHeadless({
      command: 'bash',
      args: ['-c', LONG_RUNNING],
      cwd: process.cwd(),
      cli: 'test-bash',
      timeoutMs: 30_000,
      parseLine: (line) =>
        line.length > 0 ? [{ type: 'text_delta', text: line }] : [],
    });

    const boom = new Error('consumer panic');
    let caught: unknown;
    try {
      for await (const evt of run.events) {
        if (evt.type === 'text_delta') {
          throw boom;
        }
      }
    } catch (err) {
      caught = err;
    }
    // The throw must bubble out unchanged.
    expect(caught).toBe(boom);

    const result = await run.done;
    expect(result.killed).toBe(true);
    expect(result.reason).toBe('iterator_disposed');
  }, 15_000);

  it('SIGTERMs the subprocess on explicit iter.throw()', async () => {
    // The throw() method exists for callers that drive the iterator
    // manually (no for-await sugar). Verifies the kill path triggers.
    const run = spawnHeadless({
      command: 'bash',
      args: ['-c', LONG_RUNNING],
      cwd: process.cwd(),
      cli: 'test-bash',
      timeoutMs: 30_000,
      parseLine: (line) =>
        line.length > 0 ? [{ type: 'text_delta', text: line }] : [],
    });

    const iter = run.events[Symbol.asyncIterator]();
    // Drain one event so the subprocess has actually started.
    await iter.next();
    // Now throw at the iterator. The method must re-throw the original
    // error to the caller and also kill the subprocess.
    const boom = new Error('explicit throw');
    let caught: unknown;
    try {
      await iter.throw!(boom);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);

    const result = await run.done;
    expect(result.killed).toBe(true);
    expect(result.reason).toBe('iterator_threw');
  }, 15_000);

  it('does NOT kill on natural completion (consumer drains the iterator)', async () => {
    // Quick subprocess that exits 0 on its own — the iterator should
    // close naturally without a SIGTERM. Reason stays undefined.
    const run = spawnHeadless({
      command: 'bash',
      args: ['-c', 'echo hello; exit 0'],
      cwd: process.cwd(),
      cli: 'test-bash',
      timeoutMs: 5_000,
      parseLine: (line) =>
        line.length > 0 ? [{ type: 'text_delta', text: line }] : [],
    });

    const events: string[] = [];
    for await (const evt of run.events) {
      if (evt.type === 'text_delta') events.push(evt.text);
    }
    expect(events).toContain('hello');

    const result = await run.done;
    expect(result.killed).toBe(false);
    expect(result.code).toBe(0);
  }, 10_000);
});
