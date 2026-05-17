/**
 * Regression test for issue #49 — runner now honours all three
 * iterate.onDisagreement values, not just 'continue'.
 *
 * Tests resolveDisagreement (the policy table extracted from the round
 * loop) rather than the whole runChat scaffold. The runner's call site
 * is a one-line application of this table, so unit coverage here pins
 * the behaviour without standing up tmuxMgr/errorDetector/fake doer.
 */

import { describe, it, expect } from 'vitest';
import { resolveDisagreement } from '@/daemon/runner';

describe('resolveDisagreement (issue #49)', () => {
  it('continue → fails with max_rounds_exhausted (historical default)', () => {
    expect(resolveDisagreement('continue')).toEqual({
      kind: 'fail',
      reason: 'max_rounds_exhausted',
    });
  });

  it('accept-doer → drops the reviewer veto, accepts doer last answer', () => {
    // The runner uses this to short-circuit the failure branch and let
    // the chat carry on as if reviewers had agreed. Without this the
    // cockpit's "drop reviewer veto, accept doer" option (per
    // template-dialog/emit.ts:144) was a silent no-op.
    expect(resolveDisagreement('accept-doer')).toEqual({ kind: 'accept-doer' });
  });

  it('escalate → fails with a distinct reason so cockpits can render "needs human"', () => {
    expect(resolveDisagreement('escalate')).toEqual({
      kind: 'fail',
      reason: 'escalated_on_disagreement',
    });
  });
});
