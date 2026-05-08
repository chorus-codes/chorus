/**
 * Template-level fallback chain.
 *
 * Per-slot fallback (`candidate.models[]`) handles "if claude-opus fails, try
 * claude-sonnet" — same lineage, same shim, same auth, just a different
 * `--model` argv.
 *
 * Template-level fallback (`template.fallback[]`) is the catch-all that fires
 * when ANY slot exhausts its per-slot chain. The user sets it once at the
 * template root, and chorus applies it to every slot — cross-lineage swaps
 * are first-class: a codex reviewer hitting quota can fall through to a
 * claude or kimi fallback.
 *
 * Strict (lineage, model) dedup — TWO layers:
 *
 *   Build-time (this module):
 *     - Skip a fallback row that matches the slot's own current model — would
 *       just fail again.
 *     - Skip a fallback row that matches ANOTHER active slot's PRIMARY in the
 *       same phase. Example: reviewers=[kimi, deepseek] + fallback=[kimi]
 *       should NOT spawn a second kimi reviewer when deepseek fails.
 *     - Cross-lineage fallback dedup uses (lineage, model) tuples so two
 *       slots of different lineages on the same model name (rare) don't
 *       collide.
 *
 *   Runtime (`fallback-registry.ts`):
 *     - When two slots BOTH carry the same template fallback in their chains
 *       (the common case — one shared template-level fallback list applied
 *       to every slot), build-time dedup can't catch it because each slot
 *       only knows about other slots' PRIMARIES, not their fallback chains.
 *     - The reviewer-driver claims the (lineage, model) before each attempt
 *       and releases after; if a sibling slot is already running the same
 *       target, claim returns false and the chain advances to the next
 *       entry. This is what prevents the "two reviewers fall back to the
 *       same model in parallel" waste case (incident 2026-05-08).
 *
 * Diversity-first ordering:
 *   When multiple fallbacks survive dedup, sort by lineage occurrence
 *   across active slots (least-represented first). With reviewers
 *   [openai, google, anthropic] and fallbacks [anthropic/haiku,
 *   moonshot/kimi], the kimi entry runs FIRST — moonshot has 0 active
 *   slots, anthropic has 1. Within a single lineage, user-declared
 *   order wins. Lets the user spec a long fallback list without having
 *   to manually micro-order it for diversity.
 *
 * Cross-lineage swap mechanics:
 *   When a fallback's lineage differs from the slot's, the runner re-resolves
 *   the shim from the agent registry (`pickShimForVoice(entry.lineage,
 *   entry.model)`) for that one attempt. The slot's identity (agentName,
 *   on-disk dir, participant key) stays bound to the slot's primary lineage
 *   so the cockpit card doesn't re-key mid-run; the runner emits a
 *   `cli_warning` with `reason: 'lineage_fallback'` so the UI can show
 *   "switched to claude-opus-4-7 (cross-lineage)".
 */

interface SlotLike {
  /** Cockpit-side or daemon-side lineage — must compare apples to apples. */
  lineage: string;
  /** Index 0 holds the slot's primary model; subsequent are per-slot fallbacks. */
  models: string[];
}

interface FallbackRow {
  lineage: string;
  models: string[];
}

/**
 * One chain entry — a (lineage, model) tuple to try. The runner picks the
 * shim per entry via `pickShimForVoice`. `model` is undefined when the
 * lineage's CLI default should be used (rare; happens when a slot has no
 * `models` declared at all).
 */
export interface ChainEntry {
  lineage: string;
  model: string | undefined;
}

/**
 * Compose the slot's effective (lineage, model) chain by appending matching
 * template fallbacks (deduped) onto the slot's per-slot chain. The chain
 * mixes the slot's primary lineage with cross-lineage fallbacks at the
 * tail; the runner walks it in order, picking the right shim per entry.
 *
 * Caller is responsible for passing a stable `lineage` value across all
 * slots and template-fallback rows (don't mix cockpit-side and daemon-side
 * names in the same call).
 *
 * @param slot          The slot whose chain we're building (its primary +
 *                      its per-slot fallbacks).
 * @param activeSlots   All slots in the same phase, including `slot`. Used
 *                      to dedup template fallbacks that would duplicate an
 *                      already-running voice.
 * @param templateFallback The template-root `fallback` array (or undefined).
 * @returns Extended (lineage, model) chain — slot.models first, then
 *          deduped template fallbacks (same-lineage and cross-lineage).
 */
export function buildSlotFallbackChain(
  slot: SlotLike,
  activeSlots: readonly SlotLike[],
  templateFallback: readonly FallbackRow[] | undefined,
): ChainEntry[] {
  const chain: ChainEntry[] = (slot.models ?? []).map((m) => ({
    lineage: slot.lineage,
    model: m,
  }));

  // Slot with no models at all: emit one undefined entry so the runner makes
  // exactly one attempt with the lineage default.
  if (chain.length === 0) {
    chain.push({ lineage: slot.lineage, model: undefined });
  }

  if (!templateFallback || templateFallback.length === 0) return chain;

  // Pre-compute the dedup set: every (lineage, model) currently active in
  // this phase, including the slot's own per-slot fallbacks.
  const skipKeys = new Set<string>();
  // Lineage-occurrence count across active slots — used to prefer
  // cross-lineage fallbacks first ("most unique combination" = least
  // represented lineage). A slot whose primary lineage is openai pulls
  // the openai count up; a fallback into a lineage with count=0 wins
  // ties over one with count=1.
  const lineageCount = new Map<string, number>();
  for (const s of activeSlots) {
    lineageCount.set(s.lineage, (lineageCount.get(s.lineage) ?? 0) + 1);
    for (const m of s.models ?? []) {
      skipKeys.add(`${s.lineage}:${m}`);
    }
  }

  // Flatten user-declared fallback rows into individual entries while
  // remembering each entry's original order so we can stable-sort by
  // diversity without losing user intent for ties within a lineage.
  interface FbEntry {
    lineage: string;
    model: string;
    declaredIdx: number;
  }
  const candidates: FbEntry[] = [];
  let declared = 0;
  for (const fb of templateFallback) {
    for (const m of fb.models ?? []) {
      const key = `${fb.lineage}:${m}`;
      if (skipKeys.has(key)) {
        declared++;
        continue;
      }
      skipKeys.add(key);
      candidates.push({ lineage: fb.lineage, model: m, declaredIdx: declared });
      declared++;
    }
  }

  // Sort: lineages absent from active slots first (count=0), then less-
  // represented lineages, then user-declared order within a lineage.
  // Stable sort — equal keys preserve declared order.
  candidates.sort((a, b) => {
    const ca = lineageCount.get(a.lineage) ?? 0;
    const cb = lineageCount.get(b.lineage) ?? 0;
    if (ca !== cb) return ca - cb;
    return a.declaredIdx - b.declaredIdx;
  });

  for (const c of candidates) {
    chain.push({ lineage: c.lineage, model: c.model });
  }
  return chain;
}
