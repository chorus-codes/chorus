/**
 * Promise-based sleep that resolves early when the supplied AbortSignal
 * fires. Returns true if the wait completed normally; false if the
 * abort triggered. Used by the reviewer/doer retry loops so a cancelled
 * chat doesn't wait the full backoff before tearing down.
 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
