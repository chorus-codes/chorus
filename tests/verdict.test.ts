import { describe, it, expect } from 'vitest';
import { verdictFromReviewerText } from '../src/daemon/runner/verdict';

const PAD =
  'lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';

function long(verdict: string): string {
  return PAD.repeat(2) + ' ' + verdict + '\n## DONE\n';
}

describe('verdictFromReviewerText', () => {
  it('returns null for empty input', () => {
    expect(verdictFromReviewerText('')).toBeNull();
  });

  it('returns null for under-20-char content (incl after stripping ## DONE)', () => {
    expect(verdictFromReviewerText('ok\n## DONE')).toBeNull();
    expect(verdictFromReviewerText('y\n## DONE')).toBeNull();
  });

  it('detects approve at the tail', () => {
    expect(verdictFromReviewerText(long('I approve this change.'))).toBe(true);
  });

  it('detects lgtm at the tail', () => {
    expect(verdictFromReviewerText(long('lgtm'))).toBe(true);
  });

  it('returns true for minimal LGTM-style verdict', () => {
    expect(verdictFromReviewerText('LGTM, no concerns here. ## DONE')).toBe(true);
  });

  it('detects "ship it" at the tail', () => {
    expect(verdictFromReviewerText(long('overall solid — ship it'))).toBe(true);
  });

  it('detects request changes', () => {
    expect(verdictFromReviewerText(long('request changes here'))).toBe(false);
  });

  it('detects rejected', () => {
    expect(verdictFromReviewerText(long('this PR is rejected'))).toBe(false);
  });

  it('detects "blocker"', () => {
    expect(verdictFromReviewerText(long('there is one blocker we need to fix'))).toBe(false);
  });

  it('avoids false-positive on "approached" (word boundary)', () => {
    // "approached" should NOT be matched as "approve" because of \b
    const text =
      PAD.repeat(2) +
      ' the team approached the problem analytically with no clear conclusion';
    expect(verdictFromReviewerText(text)).toBeNull();
  });

  it('terse but explicit verdict bypasses the length floor', () => {
    // Pre-fix this returned null because the 20-char floor ran BEFORE the
    // regex. That dropped valid short replies like "approve ## DONE" (15
    // chars). Verdict keywords now win regardless of length.
    expect(verdictFromReviewerText('lgtm everywhere\n## DONE')).toBe(true);
    expect(verdictFromReviewerText('approve\n## DONE')).toBe(true);
    expect(verdictFromReviewerText('reject\n## DONE')).toBe(false);
  });

  it('negative wins over positive when both appear', () => {
    // "approved-overall but blocker on auth" — has "approve" but also "blocker"
    const mixed = long('initially approved overall but there is a blocker on auth');
    expect(verdictFromReviewerText(mixed)).toBe(false);
  });

  it('falls back to whole-text scan when tail is silent', () => {
    // Long analytical body with verdict deep in middle, tail with no verdict
    const longTail = ' ' + 'x'.repeat(500);
    const text = PAD + 'I approve this' + PAD + longTail + '\n## DONE';
    expect(verdictFromReviewerText(text)).toBe(true);
  });

  // Contraction handling — added after launch-eve review (deepseek + gemini)
  // flagged that "don't approve" / "can't approve" silently slipped past
  // the negative regex, scanning as ambiguous (null) and letting a phase
  // auto-pass on a reviewer who explicitly meant to block.
  it('detects "don\'t approve" (straight apostrophe)', () => {
    expect(verdictFromReviewerText(long("I don't approve — needs error handling"))).toBe(false);
  });

  it('detects "don’t approve" (typographic apostrophe — common from LLM emit)', () => {
    expect(verdictFromReviewerText(long('I don’t approve, the diff is racy'))).toBe(false);
  });

  it('detects "can\'t approve"', () => {
    expect(verdictFromReviewerText(long("Can't approve in current shape"))).toBe(false);
  });

  it('detects "can’t approve" (typographic)', () => {
    expect(verdictFromReviewerText(long('I can’t approve this'))).toBe(false);
  });

  it('detects "do not approve"', () => {
    expect(verdictFromReviewerText(long('Do not approve — too risky'))).toBe(false);
  });

  it('detects "cannot approve"', () => {
    expect(verdictFromReviewerText(long('Cannot approve as-is'))).toBe(false);
  });

  it('detects "don\'t merge"', () => {
    expect(verdictFromReviewerText(long("Don't merge yet"))).toBe(false);
  });

  // Issue #52 — three concrete leak cases from brianmarr's report.
  // Each one used to return TRUE (false-positive APPROVED) before the
  // negatives vocabulary was expanded and the tail-first short-circuit
  // was changed to "negatives win globally".
  describe('issue #52 — rejection-but-tail-says-approve patterns', () => {
    it('case 1: "requests changes" (3rd-person plural form)', () => {
      const text =
        "This change requests changes before merge. I'd approve a revised version.\n## DONE";
      expect(verdictFromReviewerText(text)).toBe(false);
    });

    it('case 2: conditional approve in tail wins over "changes are needed" body', () => {
      // Brian's exact case 2 text. The "approve after" tail clause is
      // what flips this to false; we deliberately don't match the
      // ambiguous body phrase "changes are needed" because that pattern
      // also fires on "no changes needed, LGTM" (see false-positive
      // tests below).
      const text =
        "Several changes are needed before this can ship. I'll approve after the fixes are in.\n## DONE";
      expect(verdictFromReviewerText(text)).toBe(false);
    });

    it('"not ready" counts as negative', () => {
      expect(verdictFromReviewerText(long('this is not ready for merge'))).toBe(false);
    });

    it('case 3: body has "Request changes", tail has only "approve once"', () => {
      // The rejection lives in the body, the tail (last 400 chars) only
      // contains the polite kicker. Pre-fix tail-first short-circuited
      // to TRUE. Post-fix: negatives win globally → FALSE.
      const body =
        'Request changes. ' +
        PAD.repeat(5) + // pushes "Request changes" out of the last-400 window
        'Happy to approve once these are addressed.\n## DONE';
      expect(verdictFromReviewerText(body)).toBe(false);
    });

    it('conditional approve in the tail still counts as negative', () => {
      // The new "approve (after|once|when|conditional|...)" pattern
      // catches polite-kicker conditionals even when the body has no
      // other rejection language.
      expect(verdictFromReviewerText(long('Looks fine — would approve once tests pass'))).toBe(false);
      expect(verdictFromReviewerText(long('Approve when the type errors are gone'))).toBe(false);
      expect(verdictFromReviewerText(long('Conditional approve: only if you add a test'))).toBe(false);
    });

    it('still approves an unambiguous positive', () => {
      // Sanity: the expanded negatives must not eat clean approvals.
      expect(verdictFromReviewerText(long('approve, nothing to add'))).toBe(true);
      expect(verdictFromReviewerText(long('LGTM, all good'))).toBe(true);
    });

    // Pinned false-positive scenarios that round-1 self-review (cli-2,
    // cli-3, cli-7) flagged from candidate patterns that have since
    // been dropped. If anyone is tempted to re-add `changes needed` or
    // `needs work` to the negatives list, these tests fail loudly.
    it('"no changes needed, LGTM" stays positive', () => {
      // Real-world clean-approval phrasing. The dropped pattern
      // `changes (?:are )?(?:needed|required)` would have flipped this
      // to false; with that pattern gone, `lgtm` wins from positives.
      expect(verdictFromReviewerText(long('no changes needed, LGTM'))).toBe(true);
    });

    it('"the changes requested are fine, approve" stays positive', () => {
      // Reviewer is describing past requests being resolved, not
      // issuing a new rejection. `request(?:s|ed|ing)? changes` could
      // match "changes requested" — but the regex requires the noun
      // FOLLOWING the verb (`requested changes`), not preceding it,
      // so this passive form is naturally excluded.
      expect(
        verdictFromReviewerText(long('the changes requested have been addressed, approve')),
      ).toBe(true);
    });
  });
});
