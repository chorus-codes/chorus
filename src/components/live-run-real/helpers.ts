import { UI_LINEAGE_TO_AGENT } from "@/lib/agent-name-map";
import type { ReviewerLineage } from "@/lib/types";

// Used when synthesising placeholder participants — picks a sensible
// CLI name for the lineage in case the real spawn hasn't happened yet.
// Sourced from the shared agent↔UI map so a new CLI lineage drops into
// both directions automatically. The `openrouter` entry is a special
// case: HTTP-dispatched voices write `reviewer-openrouter-<idx>` dirs
// regardless of the underlying model lineage, so the placeholder card
// must match that literal dir name.
export const AGENT_LABEL: Record<string, string> = {
  ...UI_LINEAGE_TO_AGENT,
  openrouter: "openrouter",
};

// Templates use runtime lineage names ("anthropic", "openai", "google",
// ...) while the cockpit UI displays Linear-style brand names ("claude",
// "codex", "gemini", ...). This map translates between them so
// placeholder reviewer cards match the visual lineage of real spawns.
export const TEMPLATE_TO_UI_LINEAGE: Record<string, ReviewerLineage> = {
  anthropic: "claude",
  openai: "codex",
  google: "gemini",
  opencode: "opencode",
  moonshot: "kimi",
  grok: "grok",
  antigravity: "antigravity",
};

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  drafting: { text: "DRAFTING · doer working", color: "primary" },
  reviewing: { text: "REVIEWING · cross-lineage check", color: "primary" },
  approved: { text: "APPROVED", color: "emerald" },
  // Internal status name is 'merged' (legacy) — but chorus only opens
  // the PR; the human clicks Merge in GitHub. Label reflects reality.
  merged: { text: "PR OPENED", color: "emerald" },
  blocked: { text: "BLOCKED · ship error", color: "amber" },
  no_review: { text: "NO REVIEW · reviewers unavailable", color: "amber" },
  failed: { text: "FAILED", color: "destructive" },
  cancelled: { text: "CANCELLED", color: "muted" },
};

/**
 * When a chat finishes with status='approved' the reviewer verdict still
 * decides whether the work actually passed. A green "APPROVED" badge for
 * a run where every reviewer said "request changes" was found in
 * real-user testing on 2026-05-03 and is the kind of misread that gets
 * bad code shipped. Verdict overrides the status label whenever it
 * disagrees with the optimistic green path.
 */
export function deriveStatusMeta(
  status: string,
  verdict: string | undefined,
): { text: string; color: string } {
  if (status === "approved" && verdict && verdict !== "approved") {
    if (verdict === "request_changes") {
      return { text: "REVIEW · CHANGES REQUESTED", color: "amber" };
    }
    return { text: `REVIEW · ${verdict.toUpperCase()}`, color: "amber" };
  }
  return STATUS_LABEL[status] ?? { text: status.toUpperCase(), color: "muted" };
}

export const STATUS_DOT_COLOR: Record<string, string> = {
  primary: "bg-primary",
  emerald: "bg-emerald-400",
  amber: "bg-amber-400",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground",
};

export interface SSEEvent {
  chatId: string;
  type:
    | "phase_start"
    | "phase_progress"
    | "phase_done"
    | "phase_failed"
    | "cli_error"
    | "cli_warning"
    | "chat_done"
    | "participant_done";
  payload: Record<string, unknown>;
  ts: number;
}

/**
 * Build the participant key the run page uses for matching SSE events
 * to participant cards. Mirrors the on-disk directory name format —
 * `<role>-<agentName>` (where agentName for reviewers includes the
 * trailing index, e.g. `opencode-cli-1`, `opencode-cli-2`).
 *
 * Was previously keyed on `role:lineage`, which collided whenever a
 * phase had multiple reviewers of the SAME lineage (e.g. two opencode
 * reviewers — deepseek + kimi). Both wrote to the same liveTails slot;
 * whichever fired its phase_progress event last won, so one card
 * rendered the other reviewer's stream.
 *
 * Keying on the full directory name guarantees uniqueness because the
 * runner allocates a distinct -<idx> suffix per slot.
 */
export function participantKey(role: string, agent: string): string {
  return `${role}-${agent}`;
}

export const TERMINAL_STATUSES = [
  "approved",
  "merged",
  "blocked",
  "failed",
  "cancelled",
  "no_review",
] as const;
