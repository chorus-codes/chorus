/**
 * Per-chat/round in-flight (lineage, model) registry — prevents two
 * reviewer slots from independently picking the SAME template fallback
 * target when their primaries fail in parallel.
 *
 * Why this exists:
 *   `buildSlotFallbackChain` dedups at chain-construction time against
 *   every active slot's PRIMARY model, but the template-level fallback
 *   list is shared across all slots. Two slots both compute the same
 *   tail (e.g. `anthropic/claude-sonnet-4-6`) and, when both primaries
 *   fail simultaneously, both dispatch to it in parallel — wasted cost,
 *   broken lineage diversity (the whole point of multi-LLM peer review).
 *   Real example 2026-05-08: a gemini slot AND an opencode/kimi slot
 *   both fell back to claude-sonnet-4-6 on the same run.
 *
 * Semantics:
 *   - `tryClaim(chatId, round, lineage, model)` — true on first claim,
 *     false if another slot in the same chat/round has ALREADY run or
 *     IS running this exact (lineage, model). Idempotent guard.
 *   - `release(...)` — called by the slot ONLY when its attempt THREW
 *     (infrastructure error outside the model call — e.g. shim
 *     resolution failure). A successful run OR a null result both
 *     HOLD the claim for the round. Idempotent.
 *   - `resetRound(chatId, round)` — drops all claims for a chat/round.
 *     Called from runner on phase_done so a multi-round chat starts
 *     each round with a clean registry. This is the only path that
 *     releases successful claims.
 *
 * Why hold on success AND null (diversity-first):
 *   With the daemon-wide CLI semaphore (chorus-102), reviewer slots
 *   often run sequentially, not in parallel. If we released the claim
 *   on any attempt, slot A could try the shared fallback, release,
 *   then slots B and C would re-claim and re-try the SAME model.
 *   That defeated diversity — three reviewer cards swapping to
 *   claude-sonnet-4-6 in sequence (chat=019E45413E126AFCD83146524A22BFC4,
 *   2026-05-20). The whole point of multi-LLM peer review collapses.
 *
 *   New rule (2026-05-20): first slot to reach a shared fallback
 *   target wins it. Subsequent slots reaching the same target via
 *   tryClaim see false and advance to the NEXT chain entry — fallback
 *   collision warning lands on those cards. If the first slot's
 *   attempt fails, the other slots simply have no backup. That's the
 *   honest signal: "this template's one shared fallback didn't cover
 *   all primary failures." Fix at the TEMPLATE layer by configuring
 *   multiple fallbacks (one per likely-failing lineage), not by
 *   recycling the same fallback across slots.
 *
 *   Throw still releases — a throw means something went wrong outside
 *   the model call itself (e.g. shim could not be resolved), so other
 *   slots SHOULD get a chance to try the target with a fresh shim.
 *
 * Why per-round, not per-chat:
 *   Round 2 reviewers are a fresh fan-out; their fallback targets
 *   should be claimable independently of round 1's already-completed
 *   reviewers. Round-scoped also means the registry self-clears on
 *   normal chat termination — no leak risk in long-running daemons.
 *
 * Why this is module-level state, not per-runner:
 *   The runner instantiates a fresh closure per chat, but the registry
 *   needs to outlive a single attempt() call across all slots in the
 *   same phase. Module state with chat-scoped keys is the smallest
 *   surface that gives the right reach. Same daemon-wide pattern as
 *   `cli-semaphore.ts`.
 *
 * Testing seam:
 *   `_testing.reset()` clears all state between vitest cases. Without
 *   this, claims from a prior test leak across the whole worker and
 *   later cases see false from `tryClaim` for unrelated targets.
 */

const inFlight: Map<string, Set<string>> = new Map();

function roundKey(chatId: string, round: number): string {
  return `${chatId}:${round}`;
}

function entryKey(lineage: string, model: string | undefined): string {
  // `(default)` is the canonical placeholder when a slot has no
  // declared model — buildSlotFallbackChain emits one such entry per
  // models-less slot. Two slots both falling through to the lineage
  // default would still collide; this key lets us catch that.
  return `${lineage}:${model ?? '(default)'}`;
}

export function tryClaim(
  chatId: string,
  round: number,
  lineage: string,
  model: string | undefined,
): boolean {
  const k = roundKey(chatId, round);
  let set = inFlight.get(k);
  if (!set) {
    set = new Set();
    inFlight.set(k, set);
  }
  const tag = entryKey(lineage, model);
  if (set.has(tag)) return false;
  set.add(tag);
  return true;
}

export function release(
  chatId: string,
  round: number,
  lineage: string,
  model: string | undefined,
): void {
  const k = roundKey(chatId, round);
  const set = inFlight.get(k);
  if (!set) return;
  set.delete(entryKey(lineage, model));
  // Opportunistically drop the empty-Set parent entry so a long-running
  // daemon processing thousands of chats doesn't accumulate one entry
  // per terminated round. Cheap (one Map.delete per fully-released
  // round); without this, ~50 bytes leak per chat × N chats over the
  // process lifetime. Caught on chorus self-review of this PR.
  if (set.size === 0) inFlight.delete(k);
}

export function resetRound(chatId: string, round: number): void {
  inFlight.delete(roundKey(chatId, round));
}

/**
 * Diagnostic snapshot — currently in-flight tags grouped by chat/round.
 * Useful when debugging "why did slot B skip this entry?" — pair with
 * the [reviewer] daemon log line.
 */
export function snapshot(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, set] of inFlight.entries()) {
    out[k] = [...set];
  }
  return out;
}

export const _testing = {
  reset: (): void => {
    inFlight.clear();
  },
};
