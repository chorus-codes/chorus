/**
 * Reviewer-text → verdict heuristic.
 *
 * Reviewers don't return a structured boolean; they write English. This
 * tries to extract `approve / request-changes / null` from their final
 * answer.md, scanning the tail first (where verdicts typically live)
 * before falling back to the whole text. Word-boundary regex matches
 * avoid false positives like "approached" → approve.
 *
 * Returns:
 *   true   = reviewer approved
 *   false  = reviewer disagreed / requested changes
 *   null   = ambiguous (caller should treat as failed/inconclusive)
 *
 * The 80-char floor protects against `## DONE`-only answers being
 * counted as ambiguous-empty rather than auto-failures upstream.
 */
export function verdictFromReviewerText(content: string): boolean | null {
  const stripped = content.replace(/##\s*DONE\s*$/i, '').trim();

  // Contractions matter: a reviewer writing "don't approve" or "can't
  // approve" would slip past the spaced-out forms below if we only matched
  // `do not approve` / `cannot approve`. Both spellings are common in real
  // reviews. The optional `['’]?t` segment catches both straight (') and
  // typographic (’) apostrophes — LLMs emit the latter often.
  //
  // Issue #52 expansions (the original list missed real-world rejections
  // that happened to end with a polite "I'd approve once …" kicker):
  //   - request(?:s|ed|ing)? changes   — covers requests/requested/requesting
  //   - not (?:approved|ready|merging|ok|acceptable|good to (?:merge|ship))
  //   - approve (?:after|once|when|conditional(?:ly)?|if|provided|assuming)
  //   - conditional(?:ly)? approve
  //     — both forms reframe conditional approvals as negative, since
  //       the reviewer is explicitly NOT approving the current diff.
  //   - would(?:\s+not|n['’]?t) approve
  //
  // Round-1 self-review (3 convergent dissenters) flagged candidate
  // patterns `changes (?:are )?(?:needed|required|requested)` and
  // `needs (?:work|changes|fixes)` as too ambiguous — both match in
  // clean-approval contexts like "no changes needed, LGTM" or "the
  // changes requested by the reviewer are fine". They're dropped from
  // the negatives list; the remaining patterns still catch all three
  // concrete leak cases in brianmarr's report (case 2a is caught by
  // `approve after`, case 2 family by `not ready`).
  const negatives =
    /\b(request(?:s|ed|ing)? changes|not (?:approved|ready|merging|ok|acceptable|good to (?:merge|ship))|approve (?:after|once|when|conditional(?:ly)?|if|provided|assuming)|conditional(?:ly)? approve|would(?:\s+not|n['’]?t) approve|disagree|reject(?:ed|ing)?|blocker|(?:do not|don['’]?t) (?:approve|merge)|(?:cannot|can['’]?t) (?:approve|merge)|nack)\b/;
  const positives =
    /\b(approve(?:d|s)?|lgtm|looks good to me|no concerns|ship it|ack)\b/;

  const whole = stripped.toLowerCase();
  const tail = stripped.slice(-400).toLowerCase();

  // Negatives win globally. Issue #52: previously the function returned
  // TRUE when the tail contained a positive token even if the body of
  // the answer carried an explicit rejection. Real reviewers routinely
  // write "Request changes. … [substantive critique] … Happy to approve
  // once these are addressed." — that's a rejection, not an approval.
  // Scan the entire stripped answer for negatives first; only fall
  // through to positives once we've confirmed there's no rejection
  // anywhere in the text.
  if (negatives.test(whole)) return false;

  // Positives prefer the tail so an analytical review mentioning
  // "good practice" mid-paragraph doesn't get auto-approved without an
  // explicit verdict at the end. Whole-text fallback catches the case
  // where the verdict lives mid-body and the tail is padded with
  // closing matter (test: "falls back to whole-text scan").
  if (positives.test(tail)) return true;
  if (positives.test(whole)) return true;

  // No verdict keyword anywhere — return null (ambiguous). The 20-char
  // floor was previously applied BEFORE the regex, which dropped valid
  // terse approvals like "approve ## DONE". It's no longer needed: short
  // replies without a keyword still resolve to null here.
  return null;
}
