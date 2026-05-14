/**
 * Single source of truth for lineage display labels and colour swatches.
 *
 * Two parallel maps because the data flows from two directions:
 *   - Templates use the daemon-side YAML schema lineage names ("anthropic",
 *     "openai", "google", "opencode", "moonshot"). UI helpers translate
 *     these to the cockpit-side ReviewerLineage names ("claude", "codex",
 *     "gemini", "opencode", "kimi") via UI_LINEAGE_MAP / mapLineage.
 *   - Personas use the daemon-side names directly via recommended_lineage.
 *
 * Keep both maps keyed by the daemon-side names; let callers translate
 * inputs once at the boundary and look up via the canonical key.
 */

export type DaemonLineage =
  | "anthropic"
  | "openai"
  | "google"
  | "opencode"
  | "moonshot"
  | "local";

export const LINEAGE_LABEL: Record<DaemonLineage, string> = {
  anthropic: "Claude",
  openai: "Codex",
  google: "Gemini",
  opencode: "OpenCode",
  moonshot: "Kimi",
  local: "Local LLM",
};

/** Tailwind background colour class for the small lineage dot indicator. */
const LINEAGE_DOT: Record<DaemonLineage, string> = {
  anthropic: "bg-violet-400",
  openai: "bg-orange-400",
  google: "bg-blue-400",
  opencode: "bg-emerald-400",
  moonshot: "bg-pink-400",
  local: "bg-teal-400",
};

/** Returns the human label for a lineage, falling back to the raw key. */
export function lineageLabel(lineage: string | undefined): string {
  if (!lineage) return "";
  return LINEAGE_LABEL[lineage as DaemonLineage] ?? lineage;
}

/** Returns the dot colour class, falling back to a neutral muted dot. */
export function lineageDot(lineage: string | undefined): string {
  if (!lineage) return "bg-muted";
  return LINEAGE_DOT[lineage as DaemonLineage] ?? "bg-muted";
}

/**
 * UI-side lineage names — used by cockpit components that operate on the
 * `ReviewerLineage` enum (claude/codex/gemini/opencode/kimi). Kept in sync
 * with the daemon-side maps above; the cockpit calls these directly without
 * a translation step.
 */
export type UILineage =
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "kimi"
  | "openrouter"
  | "local";

export const UI_LINEAGE_LABEL: Record<UILineage, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
  kimi: "Kimi",
  // Meta-lineage for HTTP-dispatched voices. The real underlying lineage
  // (anthropic/openai/google/etc.) is preserved on the voices table for
  // diversity scoring; this label is what the cockpit cards show because
  // the runner creates `reviewer-openrouter-N` dirs regardless of the
  // underlying model.
  openrouter: "OpenRouter",
  // Local inference — any OpenAI-compatible endpoint (Ollama, llama-swap,
  // LM Studio, vLLM). Base URL configured via Settings → Local LLM.
  local: "Local LLM",
};

const UI_LINEAGE_DOT: Record<UILineage, string> = {
  claude: "bg-violet-400",
  codex: "bg-orange-400",
  gemini: "bg-blue-400",
  opencode: "bg-emerald-400",
  kimi: "bg-pink-400",
  // Cyan picked over amber — amber reads as "warning/in-progress" in UI
  // convention, which clashed with lineage-as-brand semantics. Cyan is
  // brand-distinct without state ambiguity.
  openrouter: "bg-cyan-400",
  // Teal distinguishes local from openrouter (cyan) while staying in the
  // same cool-green family — both are "non-cloud" HTTP-dispatched voices.
  local: "bg-teal-400",
};

export function uiLineageLabel(lineage: string | undefined): string {
  if (!lineage) return "";
  return UI_LINEAGE_LABEL[lineage as UILineage] ?? lineage;
}

export function uiLineageDot(lineage: string | undefined): string {
  if (!lineage) return "bg-muted";
  return UI_LINEAGE_DOT[lineage as UILineage] ?? "bg-muted";
}

/**
 * Default model per UI lineage when a template's `models: []` is empty.
 * Mirrors the per-lineage defaults used by phase-editor and new-template-dialog;
 * lifted here so the run page can show the actual model on cards even when
 * the YAML omits it.
 */
export const UI_LINEAGE_DEFAULT_MODEL: Record<UILineage, string> = {
  claude: "claude-opus-4-7",
  codex: "gpt-5.5",
  gemini: "gemini-2.5-pro",
  opencode: "kimi-k2.6",
  kimi: "kimi-k2.6",
  // No sensible default for openrouter — user explicitly selects a model.
  // Empty string lets `models?.[0] ?? defaultModel` resolve to "" which
  // the run page treats as "no model" (skips the · model · separator).
  openrouter: "",
  // No default for local either — model IDs are endpoint-specific.
  local: "",
};

/**
 * Curated model lists per CLI. Used as a fallback when the CLI doesn't
 * expose a live model-listing command (claude / gemini / kimi today). For
 * codex we run `codex debug models` at seed time and prefer the live
 * catalog; the list below is the safety net if that probe fails.
 *
 * Cross-checked against `opencode models` (which aggregates upstream
 * provider names) and `codex debug models` so entries here are real
 * model ids the corresponding CLI accepts. Don't list speculative names —
 * a wrong entry here is what makes the home page look unprofessional.
 *
 * Order = recommended first; the first entry is the canonical default
 * and matches UI_LINEAGE_DEFAULT_MODEL.
 *
 * OpenCode is omitted because it's always discovered live via
 * `opencode models` (gateway-aware). Cursor/Windsurf are IDE
 * orchestrators with no model selection of their own.
 */
export const UI_LINEAGE_AVAILABLE_MODELS: Partial<Record<UILineage, string[]>> = {
  claude: [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-opus-4-5",
  ],
  codex: [
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.2",
  ],
  // Gemini list verified 2026-05-04 by `gemini -p "ok" --model <X>`.
  // gemini-2.5-pro is the universally-available default — gemini-3.1-pro-preview
  // is gated behind a preview-access tier and 404s on most accounts (the
  // failure mode that surfaced as "Reviewer · GEMINI failed → cross-lineage
  // fallback" in dogfood). 2.5-pro works on every gemini-cli account we've
  // tested. Users with preview access can switch via the model dropdown.
  gemini: [
    "gemini-2.5-pro",
    "gemini-3.1-pro-preview",
    "gemini-2.5-flash",
  ],
  // Kimi list cross-checked against the official kimi-cli docs +
  // source (2026-05-04):
  //   - CHANGELOG.md: kimi-k2.6, kimi-k2-thinking
  //   - klips/klip-6: kimi-k2-thinking-turbo (recommended turbo flagship)
  //   - sdks/kimi-sdk/README.md, klips/klip-7: kimi-k2-turbo-preview
  //   - Welcome screen dropped hardcoded kimi-k2.5, but it still works
  // Not end-to-end probed because the dedicated kimi CLI needs a
  // separate Moonshot account login; cross-referenced from official docs
  // is the next-best signal.
  // Index 0 must match UI_LINEAGE_DEFAULT_MODEL.kimi to keep the seed's
  // immutable provider row pointed at the same default. kimi-k2.6 has
  // been the chorus default since v0.7; not auto-rotating to the
  // turbo-thinking variant here so existing installs don't silently
  // change behavior. Users can still toggle the turbo entries on.
  kimi: [
    "kimi-k2.6",
    "kimi-k2-thinking-turbo",
    "kimi-k2-turbo-preview",
    "kimi-k2-thinking",
    "kimi-k2.5",
  ],
};

export function uiLineageDefaultModel(lineage: string | undefined): string | undefined {
  if (!lineage) return undefined;
  return UI_LINEAGE_DEFAULT_MODEL[lineage as UILineage];
}

/**
 * Per-CLI brand identity. ONE place to adjust colors so the violet=Claude,
 * blue=Gemini, etc. mapping never drifts across the run page, template
 * editor, sidebar, and connect surfaces. Add new CLIs here, not in callers.
 */
export interface LineageBrand {
  /** 400-shade for solid dots/swatches. */
  dot: string;
  /** 500-shade for ring/border accents. */
  ring: string;
  /** Subtle vertical gradient applied to participant cards. */
  gradient: string;
}

export const UI_LINEAGE_BRAND: Record<UILineage, LineageBrand> = {
  claude: {
    dot: "bg-violet-400",
    ring: "ring-violet-400/40",
    gradient: "bg-gradient-to-b from-violet-500/15 to-card",
  },
  codex: {
    dot: "bg-orange-400",
    ring: "ring-orange-400/40",
    gradient: "bg-gradient-to-b from-orange-500/15 to-card",
  },
  gemini: {
    dot: "bg-blue-400",
    ring: "ring-blue-400/40",
    gradient: "bg-gradient-to-b from-blue-500/15 to-card",
  },
  opencode: {
    dot: "bg-emerald-400",
    ring: "ring-emerald-400/40",
    gradient: "bg-gradient-to-b from-emerald-500/15 to-card",
  },
  kimi: {
    dot: "bg-pink-400",
    ring: "ring-pink-400/40",
    gradient: "bg-gradient-to-b from-pink-500/15 to-card",
  },
  openrouter: {
    dot: "bg-cyan-400",
    ring: "ring-cyan-400/40",
    gradient: "bg-gradient-to-b from-cyan-500/15 to-card",
  },
  local: {
    dot: "bg-teal-400",
    ring: "ring-teal-400/40",
    gradient: "bg-gradient-to-b from-teal-500/15 to-card",
  },
};

