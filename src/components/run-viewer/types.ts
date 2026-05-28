import type { ReviewerLineage } from "@/lib/types";

/**
 * Shared snapshot shapes for the run-viewer family.
 *
 * The run page assembles these from /api/run-artifacts/:chatId — the daemon
 * walks the chat directory and returns one ParticipantSnapshot per
 * doer/reviewer dir per round. The cockpit synthesises additional placeholder
 * snapshots from template config so reviewer cards appear immediately at
 * chat start instead of waiting for the directory to materialise.
 */
export interface ParticipantSnapshot {
  participant: string;
  role: "doer" | "reviewer";
  agentName: string;
  lineage: ReviewerLineage;
  hasAnswer: boolean;
  answer?: string;
  findingsPreview?: string[];
  /** Model id picked by the template for this slot, e.g. "claude-opus-4-7". */
  model?: string;
  /**
   * Resolved transport — what the shim ACTUALLY spawned at runtime.
   * Populated from the per-participant `_meta.json` sidecar the runner
   * writes. Differs from `agentName` + `model` when a single lineage has
   * multiple transports (e.g. moonshot/kimi can run via standalone `kimi`
   * CLI OR via `opencode -m opencode-go/kimi-k2.6`). Cards prefer these
   * fields over the template-default `model`/`agentName` so the user can
   * tell at a glance which path is in use.
   */
  binaryUsed?: string;
  modelUsed?: string;
  /**
   * Synthesised slot — no directory on disk yet. Present so we can render
   * placeholder reviewer cards from template config the moment the chat
   * starts, instead of leaving the user staring at a lone doer card.
   */
  pending?: boolean;
  /**
   * Wall-clock duration of the participant's CLI run, in ms. Captured from
   * the runner's `_stats.json` sidecar written at participant_done. Absent
   * for pending / still-working participants.
   */
  durationMs?: number;
  /**
   * Token usage reported by the upstream CLI's stream. Populated by shims
   * that surface usage in `message_done` (claude/anthropic today; others
   * fill in as parsers grow). Absent when the CLI didn't report it.
   *
   * `costUsd` is the dollar cost the CLI itself reports — opencode emits
   * a per-step `cost` summed across step_finish events. CLIs that don't
   * emit cost natively will get derived cost from voices.input_cost_per_mtok
   * / output_cost_per_mtok in a follow-up.
   */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    costUsd?: number;
  };
  /**
   * Warnings emitted via cli_warning SSE events for this participant —
   * persona id misconfigurations, transient CLI hiccups, etc. Threaded
   * through from live-run-real.tsx state (not the disk sidecar — these
   * are session-only signals the runner doesn't persist).
   */
  warnings?: ParticipantWarning[];
}

export interface ParticipantWarning {
  /** Short identifier — `persona_missing`, `persona_lookup_failed`, etc. */
  kind: string;
  /** User-facing message the cockpit renders verbatim. */
  message: string;
  /** Wall-clock when the warning was received. */
  ts: number;
}

/**
 * One cross-lineage / cross-model fallback swap event. Emitted when a
 * slot's primary lineage exhausts and the runner switches to a fallback
 * (per-slot or template-level). Rendered as its own card on the run
 * page so the user can SEE that voice X failed and voice Y took over —
 * the slot's on-disk identity stays bound to the primary, but the
 * actual review came from the fallback.
 */
export interface FallbackSwap {
  /** Round number this swap belongs to (1-indexed). */
  round: number;
  /** Phase id — currently always the single review phase, future-proofed. */
  phaseId: string;
  /** "doer" or "reviewer". */
  role: string;
  /** Participant identifier from the original slot — same key the
   *  participant card uses (e.g. "codex-cli-0"). */
  agent: string;
  /** "lineage_fallback" (cross-lineage) or "model_fallback" (same-lineage). */
  reason: "lineage_fallback" | "model_fallback";
  fromLineage: string;
  toLineage: string;
  fromModel: string;
  toModel: string;
  /** 0-indexed position in the slot's chain when the swap fired. */
  fallbackIdx: number;
  /** Wall-clock when the swap was received. */
  ts: number;
  /** Why the FROM lineage/model failed (kind taxonomy from cli-health, or
   *  "no_output" / "stream_failure" / etc). Surfaced from the failing
   *  attempt's _attempts.jsonl entry so the UI can show "kimi-k2.6
   *  failed: cli_failed — model not found" instead of just an arrow. */
  fromErrorKind?: string;
  /** One-line message from the failing attempt; trimmed to ~200 chars. */
  fromErrorMessage?: string;
  /** True iff the TO voice was the LAST writer of `_stats.json` for
   *  this slot (the runner stamps lineage+model on every successful
   *  `message_done`). Not "did it run at all" — a fallback that
   *  ran-and-failed before message_done won't stamp stats and will
   *  report false here. For the UI gate (suppress banner when primary
   *  has answer + no swap actuallyRan), this is the right semantic:
   *  the banner mismatch only matters when the displayed answer is the
   *  primary's, which means no successful fallback writer overrode it.
   *  Previously the UI inferred "actually ran" from `isLast` in the
   *  swaps array — wrong for collision/exhausted chains. */
  actuallyRan?: boolean;
}

export interface RoundSnapshot {
  round: number;
  participants: ParticipantSnapshot[];
}

export type ParticipantState = "pending" | "working" | "done" | "errored" | "idle";
