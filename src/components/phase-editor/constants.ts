import {
  ClipboardList,
  Code2,
  Eye,
  FileCode2,
  FlaskConical,
  GitPullRequest,
  Search,
  Shuffle,
  TestTube2,
} from "lucide-react";
import {
  UI_LINEAGE_BRAND,
  UI_LINEAGE_DEFAULT_MODEL,
  UI_LINEAGE_LABEL,
} from "@/lib/lineage-maps";
import type { PhaseKind, ReviewerLineage } from "@/lib/cockpit-types";

export const KIND_ICON: Record<
  PhaseKind,
  React.ComponentType<{ className?: string }>
> = {
  review: Eye,
  review_only: Eye,
  plan: ClipboardList,
  spec: FileCode2,
  tests: TestTube2,
  implement: Code2,
  verify: FlaskConical,
  pr: GitPullRequest,
  divergence: Shuffle,
  recon: Search,
};

export const KINDS: { id: PhaseKind; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "spec", label: "Spec / API" },
  { id: "tests", label: "Tests" },
  { id: "implement", label: "Implement" },
  { id: "verify", label: "Verify" },
  { id: "pr", label: "Open PR" },
  { id: "review", label: "Review" },
  { id: "review_only", label: "Review only (artifact)" },
  { id: "divergence", label: "Divergence" },
  { id: "recon", label: "Recon" },
];

export const LINEAGES: { id: ReviewerLineage; label: string; dot: string }[] = (
  ["claude", "codex", "gemini", "opencode", "kimi", "openrouter", "local", "grok"] as const
).map((id) => ({
  id,
  label: UI_LINEAGE_LABEL[id],
  dot: UI_LINEAGE_BRAND[id].dot,
}));

export const DEFAULT_MODELS: Record<ReviewerLineage, string> =
  UI_LINEAGE_DEFAULT_MODEL;

// Daemon-lineage → cockpit-lineage. `xai` is a legacy alias from older
// templates that grouped opencode-go/grok-* models under cockpit "opencode";
// preserved so old YAML still renders. The new first-party `grok` daemon
// lineage (Grok Build CLI) maps to its own cockpit "grok" — distinct from
// the legacy alias, distinct from the opencode umbrella.
export const DAEMON_TO_COCKPIT_LINEAGE: Record<string, ReviewerLineage> = {
  anthropic: "claude",
  openai: "codex",
  google: "gemini",
  opencode: "opencode",
  moonshot: "kimi",
  xai: "opencode",
  local: "local",
  grok: "grok",
};
