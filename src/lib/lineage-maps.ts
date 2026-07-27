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
  | "local"
  | "grok"
  | "antigravity";

export const LINEAGE_LABEL: Record<DaemonLineage, string> = {
  anthropic: "Claude",
  openai: "Codex",
  google: "Gemini",
  opencode: "OpenCode",
  moonshot: "Kimi",
  local: "Local LLM",
  grok: "Grok",
  // Antigravity is Google's second first-party CLI alongside gemini-cli —
  // separate binary (`agy`), separate auth (~/.gemini/antigravity-cli/),
  // single locked model (Gemini 3.5 Flash). Distinct lineage so users with
  // both CLIs installed get TWO Google voices in the picker, not one that
  // collides on the `google` key.
  antigravity: "Antigravity",
};

/** Tailwind background colour class for the small lineage dot indicator. */
const LINEAGE_DOT: Record<DaemonLineage, string> = {
  anthropic: "bg-violet-400",
  openai: "bg-orange-400",
  google: "bg-blue-400",
  opencode: "bg-emerald-400",
  moonshot: "bg-pink-400",
  local: "bg-teal-400",
  // Slate dot for Grok — distinct from claude/gemini/codex brand colours;
  // matches xAI's neutral monochrome brand palette.
  grok: "bg-slate-400",
  // Sky for Antigravity — adjacent to gemini's blue (same vendor) but a
  // distinct shade so the cockpit doesn't visually conflate the two
  // Google CLIs on the run page.
  antigravity: "bg-sky-400",
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
  | "local"
  | "grok"
  | "antigravity";

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
  // xAI's first-party CLI (grok-build model). Distinct from opencode-go/grok-*
  // voices which run via the opencode-cli umbrella with lineage="opencode".
  grok: "Grok",
  // Google's second first-party CLI — Gemini 3.5 Flash via `agy`. Distinct
  // from `gemini` lineage so the two Google CLIs render as separate
  // reviewer cards when both are installed.
  antigravity: "Antigravity",
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
  // Slate — xAI's neutral monochrome brand. Distinct from the warmer
  // cloud-provider dots (violet/orange/blue/pink) and the cool-green
  // HTTP-dispatched family (cyan/teal).
  grok: "bg-slate-400",
  // Sky — same vendor as gemini (blue family) but a distinct shade so the
  // cockpit doesn't conflate the two Google CLIs at a glance.
  antigravity: "bg-sky-400",
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
  claude: "claude-opus-5",
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
  // Grok Build has one model today (grok-build). xAI ships single-binary
  // versioned models, so this stays stable across CLI bumps.
  grok: "grok-build",
  // Informational only — the antigravity shim doesn't pass a model. The
  // id matches what `agy models` actually lists for the build the shim
  // documents (bare "gemini-3.5-flash" is not a valid id there; every
  // entry carries a -high/-medium/-low reasoning suffix).
  // NOTE: agy 1.1.7 HAS grown `--model` plus an `agy models` subcommand
  // listing 11 models — including non-Google ones (claude-sonnet-4-6,
  // gpt-oss-120b-medium). Wiring selection through the shim is a
  // follow-up; it also needs lineage rethink, since an agy voice running
  // a Claude model is not a google-family reviewer for quorum purposes.
  antigravity: "gemini-3.5-flash-high",
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
  // Claude list re-probed 2026-07-27 with `claude --model <X> -p "say ok"`
  // against an authed Claude Code 2.1.220: opus-5, sonnet-5, opus-4-7,
  // sonnet-4-6 and haiku-4-5 all answered. The 4-5-era entries are kept
  // (removing a model deletes its voice row, breaking any template pinned
  // to it) — they're simply no longer near the top.
  // claude-fable-5 is deliberately ABSENT: it exists, but answers with
  // "Fable 5 requires usage credits", which breaks the $0-out-of-pocket
  // promise the subscription transports are here to keep.
  claude: [
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-sonnet-4-5",
    "claude-opus-4-5",
  ],
  // Static fallback only — when codex-cli is installed, `codex debug
  // models` wins (see voices.ts). Trimmed 2026-07-27 to the slugs that
  // probe still returns as `visibility: list`: gpt-5.4, gpt-5.3-codex and
  // gpt-5.2 have aged out of the account catalog, so offering them just
  // seeds rows the live probe deletes on the next boot.
  codex: [
    "gpt-5.5",
    "gpt-5.4-mini",
  ],
  // Gemini list verified 2026-05-04 by `gemini -p "ok" --model <X>`.
  // gemini-2.5-pro is the universally-available default — gemini-3.1-pro-preview
  // is gated behind a preview-access tier and 404s on most accounts (the
  // failure mode that surfaced as "Reviewer · GEMINI failed → cross-lineage
  // fallback" in dogfood). 2.5-pro works on every gemini-cli account we've
  // tested. Users with preview access can switch via the model dropdown.
  // WARNING (re-probed 2026-07-27, gemini-cli 0.52.0 = current latest):
  // Google now rejects the free individual tier outright —
  // "IneligibleTierError: This client is no longer supported for Gemini
  // Code Assist for individuals … migrate to the Antigravity suite"
  // (reasonCode UNSUPPORTED_CLIENT). That's an ACCESS failure, not a
  // model-name failure, so the list below is unchanged: it still holds
  // for API-key and paid-tier accounts. Free-tier users need `agy`
  // (antigravity) instead — same models, supported client.
  gemini: [
    "gemini-2.5-pro",
    "gemini-3.1-pro-preview",
    "gemini-2.5-flash",
  ],
  // Rebuilt 2026-07-27 from what the two moonshot transports actually
  // accept. The previous list was Moonshot *API* ids (kimi-k2-thinking,
  // kimi-k2-turbo-preview, …) which neither transport takes:
  //   - opencode-go: `opencode models` lists kimi-k2.6, kimi-k2.7-code
  //     and kimi-k3 under the opencode-go/ gateway — and nothing else.
  //     The shim prefixes the bare name, so these are the valid inputs.
  //   - standalone kimi-cli: takes only its OWN `[models]` keys
  //     (kimi-code/k3, …), which are per-account and server-issued. Those
  //     are read live from the user's config at seed time and override
  //     this list entirely (see readKimiModelKeys in voices.ts), so this
  //     list is really the opencode-transport catalog.
  // Index 0 must match UI_LINEAGE_DEFAULT_MODEL.kimi. Holding k2.6 as the
  // default rather than auto-rotating to k3, so existing installs don't
  // silently change model on upgrade — k3 is one dropdown click away.
  kimi: [
    "kimi-k2.6",
    "kimi-k3",
    "kimi-k2.7-code",
  ],
  // Grok Build ships a single model name today — `grok-build` — which xAI
  // versions internally. From `grok models` against an authed install:
  //   * grok-build (default)
  // SuperGrok Heavy subscription required for invocation. Single-entry
  // list matches UI_LINEAGE_DEFAULT_MODEL.grok.
  grok: ['grok-build'],
  // Antigravity ships a single locked model (Gemini 3.5 Flash). The chorus-
  // side id `gemini-3.5-flash` mirrors what `agy` self-reports — the CLI
  // doesn't accept a --model flag, but listing it here keeps the voices
  // catalog / template dropdown consistent with other single-model CLIs.
  antigravity: ['gemini-3.5-flash'],
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
  grok: {
    dot: "bg-slate-400",
    ring: "ring-slate-400/40",
    gradient: "bg-gradient-to-b from-slate-500/15 to-card",
  },
  antigravity: {
    dot: "bg-sky-400",
    ring: "ring-sky-400/40",
    gradient: "bg-gradient-to-b from-sky-500/15 to-card",
  },
};

