/**
 * Regression test for issue #49 — runner now honours all three
 * iterate.onDisagreement values, not just 'continue'.
 *
 * Tests decidePhaseOutcome (the policy table extracted from the round
 * loop) over the full input matrix: 3 policies × 2 disagreement-in-last
 * -round values = 6 cases. The runner's call site is a one-line
 * application of this table, so unit coverage here pins both axes
 * without standing up tmuxMgr/errorDetector/fake doer+reviewers.
 *
 * The `disagreementInLastRound: false` branch is the convergent
 * finding from 5/8 reviewers on PR #50's chorus self-review: a doer
 * that crashed mid-stream must NOT be silently "accept-doer"'d.
 */

import { describe, it, expect } from 'vitest';
import { decidePhaseOutcome } from '@/daemon/runner';

describe('decidePhaseOutcome (issue #49)', () => {
  describe('reviewers disagreed in the last round (policy applies)', () => {
    it('continue → fails with max_rounds_exhausted (historical default)', () => {
      expect(
        decidePhaseOutcome({ disagreementInLastRound: true, policy: 'continue' }),
      ).toEqual({ kind: 'fail', reason: 'max_rounds_exhausted' });
    });

    it('accept-doer → drops the reviewer veto, accepts doer last answer', () => {
      // The runner uses this to short-circuit the failure branch and let
      // the chat carry on as if reviewers had agreed. Without this the
      // cockpit's "drop reviewer veto, accept doer" option (per
      // template-dialog/emit.ts:144) was a silent no-op.
      expect(
        decidePhaseOutcome({ disagreementInLastRound: true, policy: 'accept-doer' }),
      ).toEqual({ kind: 'accept-doer' });
    });

    it('escalate → fails with a distinct reason so cockpits can render "needs human"', () => {
      expect(
        decidePhaseOutcome({ disagreementInLastRound: true, policy: 'escalate' }),
      ).toEqual({ kind: 'fail', reason: 'escalated_on_disagreement' });
    });
  });

  describe('doer crashed / no real disagreement (policy must NOT apply)', () => {
    // Convergent finding from 5/8 reviewers on PR #50's chorus self-
    // review: when the doer crashed mid-stream (round loop exited via
    // the `!doerAnswer.full` break), accept-doer was silently accepting
    // a partial / empty answer as final. These cases pin the gate.
    it('continue → fails with max_rounds_exhausted', () => {
      expect(
        decidePhaseOutcome({ disagreementInLastRound: false, policy: 'continue' }),
      ).toEqual({ kind: 'fail', reason: 'max_rounds_exhausted' });
    });

    it('accept-doer → STILL fails — a crashed doer must not be accepted', () => {
      expect(
        decidePhaseOutcome({ disagreementInLastRound: false, policy: 'accept-doer' }),
      ).toEqual({ kind: 'fail', reason: 'max_rounds_exhausted' });
    });

    it('escalate → STILL fails as max_rounds, not as escalation', () => {
      // Escalation means "reviewers gave verdicts and disagreed → human
      // decides." A crashed doer is not a disagreement to escalate; it's
      // a technical failure that belongs in the doer_failed_all_rounds
      // bucket.
      expect(
        decidePhaseOutcome({ disagreementInLastRound: false, policy: 'escalate' }),
      ).toEqual({ kind: 'fail', reason: 'max_rounds_exhausted' });
    });
  });
});
