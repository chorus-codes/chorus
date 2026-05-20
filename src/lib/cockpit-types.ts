/**
 * Cockpit form-shape types.
 *
 * These types model what the template-dialog and phase-editor *render*.
 * They use parallel arrays for reviewer slots (candidates +
 * candidateModels + candidatePersonas) — the shape the form's add/remove
 * UI is built around. The translation to/from the daemon's canonical
 * shape (`lib/types.ts`) lives in template-dialog/{emit,parse}.ts.
 *
 * Why this exists separately from `lib/types.ts`: the daemon collapsed
 * those parallel arrays into a single `candidatesWithModels:
 * ReviewerCandidate[]` for storage. Refactoring the cockpit form to use
 * the same shape is a v0.8 cleanup; today the form uses what's natural
 * for the UI.
 */

export type ReviewerLineage =
  | "codex"
  | "gemini"
  | "opencode"
  | "claude"
  | "kimi"
  | "openrouter"
  | "local"
  | "grok"
  | "antigravity";

export type AgreementThreshold = "unanimous" | "majority" | "any";
export type ThresholdAction = "auto-finalize" | "ask-user";
export type ExecutionMode = "parallel" | "sequential";

export type DriverTarget =
  | "claude-code"
  | "cursor"
  | "codex-cli"
  | "windsurf"
  | "external"; // user picks at runtime

export type BlindSpotPack =
  | "security"
  | "data"
  | "api"
  | "architecture"
  | "ops"
  | "performance";

export type NotifyChannel = "mcp-tool" | "webhook" | "dashboard-only";

/** What a phase produces — drives the UI body and the artifact type. */
export type PhaseKind =
  | "review" // panel critiques an existing artifact
  | "review_only" // single-pass review of a runtime-supplied artifact (no doer)
  | "plan" // doer drafts a plan
  | "spec" // doer derives spec / API contract
  | "tests" // doer writes tests
  | "implement" // doer writes code
  | "verify" // deterministic runner (tests / type-checks / lint)
  | "pr" // open PR / publish
  | "divergence" // optional: check if earlier phases need amendment
  | "recon"; // read-only exploration

/** The agent that produces this phase's output. */
export interface DoerSlot {
  lineage: ReviewerLineage;
  /** First entry is primary; rest are fallbacks. */
  models: string[];
  /**
   * Optional persona id. The runner prepends the persona's
   * `system_prompt` to the doer's ask.md so the worldview is explicit
   * (architect, sentinel, …). When empty, the doer runs without a
   * persona prefix.
   */
  persona?: string;
}

/** How the work is reviewed — adversarial by default. */
export interface ReviewerRule {
  /** How many independent reviewers required to approve. 1 = single gate, 3 = panel. */
  require: number;
  /** Reviewer lineage MUST differ from doer (adversarial red/green default). */
  crossLineage: boolean;
  /** Allowed reviewer pool. If empty, any non-doer lineage is acceptable. */
  candidates: ReviewerLineage[];
  /**
   * Optional per-lineage model assignment. Lets a template author pick a
   * specific model per reviewer (e.g. Claude Sonnet as reviewer with
   * Claude Opus as doer). When unset for a given lineage, the form falls
   * back to that lineage's default model.
   */
  candidateModels?: Partial<Record<ReviewerLineage, string[]>>;
  /**
   * Optional per-slot persona assignment, keyed by lineage then model id.
   * The runner looks up the persona's system_prompt and prepends it to
   * the reviewer's ask.md so this slot critiques from a specific
   * worldview (sentinel/security, cartographer/cross-platform, etc).
   *
   * The nested map (rather than an array of triples) keeps the structure
   * compatible with the existing parallel-array form (candidates +
   * candidateModels) without needing a schema-level slot refactor.
   */
  candidatePersonas?: Partial<
    Record<ReviewerLineage, Record<string, string | undefined>>
  >;
}

/** What prior phases this phase's doer is allowed to read. */
export interface PhaseInputs {
  /** Phase IDs whose outputs are visible to this doer. Empty = all priors. */
  include: string[];
  /** Phase IDs whose outputs are EXPLICITLY blocked (info asymmetry). */
  exclude: string[];
}

/** Iteration policy when the reviewer rejects. */
export interface IteratePolicy {
  /** Max revise rounds within the phase before escalating. */
  max: number;
  onMax: "ask-user" | "loopback" | "fail";
  /** When onMax = loopback, which earlier phase to restart from. */
  loopbackTo?: string;
}

/** A phase is a sub-stage of the template. Built-in or user-authored, same shape. */
export interface TemplatePhase {
  id: string;
  name: string;
  description: string;
  kind: PhaseKind;
  /** Auto-proceed to next phase, or stop & wait for user (the "checkpoint"). */
  gate: "auto" | "ask-user";
  doer: DoerSlot;
  reviewer: ReviewerRule;
  inputs: PhaseInputs;
  iterate: IteratePolicy;
  blindSpots: BlindSpotPack[];
  /** Run reviewers in parallel (default) or sequentially. */
  execution: ExecutionMode;
  /** True for opinionated built-in phases — user-authored phases are false. */
  builtin: boolean;
  /**
   * Only meaningful when kind === 'review_only'. Drives the cockpit
   * textarea label/placeholder and the size cap. Mirrors the daemon
   * shape so the dialog and PhaseEditor can round-trip review_only
   * templates.
   */
  artifact?: {
    label: string;
    hint: string;
    maxBytes: number;
  };
}

export interface Template {
  id: string;
  name: string;
  description: string;
  category: "review" | "plan" | "debug" | "decide";
  /** Stages of work this template runs through. Single-phase templates are still phases[0]. */
  phases: TemplatePhase[];
  /** Consensus across reviewers within a phase. */
  agreementThreshold: AgreementThreshold;
  onThresholdMet: ThresholdAction;
  maxRounds: number;
  driver: DriverTarget;
  /** Skip the implementation hand-off entirely (review-only templates). */
  driverHandoff: boolean;
  /** Verification gate before the driver writes code. */
  verificationGate: "auto" | "run-tests" | "ask-user";
  /** Hard stop when chat hits this cost (USD). 0 = no cap. */
  costCapUsd: number;
  /** Auto-approve all reviewer gates and ask-user prompts. Default false. */
  yoloDefault?: boolean;
  onError: "fallback" | "fail" | "ask-user";
  /** How the outer orchestrator (if any) gets notified when the chat finishes/blocks. */
  notify: NotifyChannel;
  yaml: string;
  authorHandle: string;
  forks: number;
  popularity: number; // 0–100
}
