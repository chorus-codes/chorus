import { uiLineageDefaultModel } from "@/lib/lineage-maps";
import { isReviewOnlyTemplate, type ReviewerLineage, type Template } from "@/lib/types";
import type {
  ParticipantSnapshot,
  ParticipantWarning,
  RoundSnapshot,
} from "../run-viewer/types.js";
import { AGENT_LABEL, TEMPLATE_TO_UI_LINEAGE } from "./helpers";

interface Slot {
  role: "doer" | "reviewer";
  lineage: ReviewerLineage;
  model?: string;
  reviewerIdx?: number;
}

/**
 * OpenRouter dispatch overrides the slot's lineage for UI matching: the
 * runner creates `reviewer-openrouter-N` dirs (not `reviewer-codex-N`
 * or `-gemini-N`) regardless of the underlying model's lineage. So a
 * slot with model `openrouter:openai/gpt-4o-mini` synthesises an
 * "openrouter" UI card that reconciles with the real participant once
 * dispatch finishes. The voice's underlying lineage stays accurate on
 * the voices table for diversity scoring.
 */
function slotLineageForModel(
  templateLineage: string,
  model: string | undefined,
): ReviewerLineage {
  if (model && model.startsWith("openrouter:")) return "openrouter";
  return TEMPLATE_TO_UI_LINEAGE[templateLineage] ?? (templateLineage as ReviewerLineage);
}

function buildExpectedSlots(template: Template, reviewOnly: boolean): Slot[] {
  const phase = template.phases[0];
  // Fall back to the per-lineage default when a template's `models: []`
  // is empty so the card shows the actual model the runner will use.
  const resolveModel = (lineage: ReviewerLineage, models: string[] | undefined) =>
    models?.[0] ?? uiLineageDefaultModel(lineage);

  const slots: Slot[] = [];
  if (!reviewOnly) {
    const doerModel = phase.doer.models?.[0];
    const doerLineage = slotLineageForModel(phase.doer.lineage, doerModel);
    slots.push({
      role: "doer",
      lineage: doerLineage,
      model: doerModel ?? resolveModel(doerLineage, phase.doer.models),
    });
  }
  // Use candidatesWithModels (added to the parser) so we keep the model
  // assignment per slot. The legacy `candidates` string array is still
  // emitted for connection-status grids that don't care about models.
  for (const [idx, c] of (phase.reviewer?.candidatesWithModels ?? []).entries()) {
    const slotModel = c.models?.[0];
    const lineage = slotLineageForModel(c.lineage, slotModel);
    slots.push({
      role: "reviewer",
      lineage,
      model: slotModel ?? resolveModel(lineage, c.models),
      reviewerIdx: idx,
    });
  }
  return slots;
}

/**
 * Enrich rounds with model lookups + placeholder reviewer slots from
 * the template config. Without this, reviewer cards only appear once
 * the runner has spawned their dirs — leaving the doer card alone in
 * the viewport for the first 30-60s of a run with no hint that 2
 * reviewers are about to chime in. Now we render placeholder cards
 * from the start.
 */
export function enrichRounds(
  rounds: RoundSnapshot[],
  template: Template | null,
  participantWarnings: Record<string, ParticipantWarning[]>,
): RoundSnapshot[] {
  if (!template?.phases?.length) return rounds;
  const reviewOnly = isReviewOnlyTemplate(template);
  const expectedSlots = buildExpectedSlots(template, reviewOnly);

  // Pre-spawn synthesis: when zero reviewer dirs exist on disk yet
  // (chat just created, daemon's CLI semaphore is still queueing the
  // first batch), `rounds` is `[]` — the .map() below would return
  // `[]` and the run page would render no cards at all. Without this,
  // cards "appear one-by-one" as each reviewer's dir lands, even
  // though the placeholder synthesis below already supports queued
  // reviewers — the loop just never ran. Seed an empty round-1 so
  // every expected slot gets a QUEUED placeholder from t=0.
  const seedRounds: RoundSnapshot[] =
    rounds.length === 0 ? [{ round: 1, participants: [] }] : rounds;

  return seedRounds.map((round) => {
    const enriched: ParticipantSnapshot[] = [];
    const seen = new Set<string>();
    for (const slot of expectedSlots) {
      const slotKey =
        slot.role === "doer"
          ? `doer-${slot.lineage}`
          : `reviewer-${slot.lineage}-${slot.reviewerIdx}`;
      const real = round.participants.find((p) => {
        if (slot.role === "doer") return p.role === "doer" && p.lineage === slot.lineage;
        if (p.role !== "reviewer") return false;
        if (p.lineage !== slot.lineage) return false;
        const idxFromName = parseInt(p.participant.match(/-(\d+)$/)?.[1] ?? "0", 10);
        return idxFromName === slot.reviewerIdx;
      });
      if (real) {
        enriched.push({
          ...real,
          model: slot.model,
          ...(participantWarnings[real.participant]
            ? { warnings: participantWarnings[real.participant] }
            : {}),
        });
        seen.add(real.participant);
      } else {
        enriched.push({
          participant: slotKey,
          role: slot.role,
          agentName: AGENT_LABEL[slot.lineage] ?? slot.lineage,
          lineage: slot.lineage,
          hasAnswer: false,
          model: slot.model,
          pending: true,
          ...(participantWarnings[slotKey]
            ? { warnings: participantWarnings[slotKey] }
            : {}),
        });
      }
    }
    // Append any unexpected participants (defensive — shouldn't happen).
    for (const p of round.participants) {
      if (!seen.has(p.participant)) {
        enriched.push({
          ...p,
          ...(participantWarnings[p.participant]
            ? { warnings: participantWarnings[p.participant] }
            : {}),
        });
      }
    }
    return { ...round, participants: enriched };
  });
}
