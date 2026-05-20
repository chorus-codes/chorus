/**
 * Unit tests for `isDaemonOlderThanCli` — the pure version-comparison
 * helper that drives drift detection in `chorus start`. The wrapper
 * adds two policies on top of plain semver compare:
 *   - undefined / null daemon version → treated as "older" so a
 *     pre-0.7 daemon (which never wrote `version` into daemon.json)
 *     gets restarted automatically.
 *   - equal versions → not older (no restart).
 *
 * Drift recovery itself spawns subprocesses + writes to ~/.chorus, so
 * it's exercised end-to-end via manual smoke and the
 * `tests/cli-update.test.ts` integration; here we pin the policy.
 */
import { describe, expect, it } from 'vitest';
import { isDaemonOlderThanCli } from '../src/cli/commands/start.js';

describe('isDaemonOlderThanCli', () => {
  it('returns true when CLI patch version is newer', () => {
    expect(isDaemonOlderThanCli('0.8.38', '0.8.43')).toBe(true);
  });

  it('returns true when CLI minor version is newer', () => {
    expect(isDaemonOlderThanCli('0.7.5', '0.8.0')).toBe(true);
  });

  it('returns true when CLI major version is newer', () => {
    expect(isDaemonOlderThanCli('0.8.43', '1.0.0')).toBe(true);
  });

  it('returns false when versions are equal', () => {
    expect(isDaemonOlderThanCli('0.8.43', '0.8.43')).toBe(false);
  });

  it('returns false when daemon is newer than CLI', () => {
    // Two-install scenario (sudo prefix + nvm prefix). PATH chorus is
    // older than the running daemon. Restarting would downgrade —
    // refuse, let caller warn instead.
    expect(isDaemonOlderThanCli('0.8.43', '0.8.42')).toBe(false);
  });

  it('treats missing daemon version as older', () => {
    // Pre-0.7 daemons never wrote `version` to daemon.json. Restart
    // gives the user the fresh binary on their next `chorus start`.
    expect(isDaemonOlderThanCli(undefined, '0.8.43')).toBe(true);
    expect(isDaemonOlderThanCli(null, '0.8.43')).toBe(true);
  });

  it('handles single-segment versions defensively', () => {
    // `versionGreater` zero-fills missing segments. A daemon that
    // somehow recorded just "0.8" still sorts under "0.8.1".
    expect(isDaemonOlderThanCli('0.8', '0.8.1')).toBe(true);
    expect(isDaemonOlderThanCli('0.8', '0.8.0')).toBe(false);
  });

  it('treats empty-string daemon version as older', () => {
    // Defensive: malformed daemon.json (version: "") shouldn't make
    // chorus think the daemon is current. Force the restart.
    expect(isDaemonOlderThanCli('', '0.8.43')).toBe(true);
  });

  it('documents prerelease comparison behaviour (known limitation)', () => {
    // The underlying versionGreater does split-on-dot + parseInt, so
    // any non-numeric tail compares as zero. We DON'T promise correct
    // semver prerelease ordering — flagged for follow-up if we ever
    // ship RC tags to npm latest. This test pins the *observed*
    // behaviour so a future semver-aware rewrite doesn't silently
    // change drift semantics.
    //
    // "0.8.43-rc.1" → parses to [0, 8, 43, 1] (the "rc" tail in "43-rc"
    // returns NaN || 0 = 0, then the trailing ".1" is 1). So daemon
    // "0.8.43-rc.1" is seen as NEWER than CLI "0.8.43" → no restart.
    // Stable RC tags would need a real semver parser; out of scope here.
    expect(isDaemonOlderThanCli('0.8.43-rc.1', '0.8.43')).toBe(false);
  });
});
