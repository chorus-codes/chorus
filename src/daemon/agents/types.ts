// Agent shim interface — every CLI lineage implements this.
// Pattern ported from openbridge's lib/agents/<name>.sh.

/**
 * Lineage tags a model family / vendor.
 *
 * v0.5 caveat: this enum currently conflates "CLI" with "model family":
 * `opencode` is a CLI that can host multiple lineages (moonshot/deepseek/grok
 * depending on user's opencode.json). v0.6 will split into:
 *   - Vendor: anthropic, openai, google, moonshot, deepseek, xai, mistral, ...
 *   - Channel: cli vs api
 *   - CLI:    claude, codex, gemini, kimi, opencode
 * For now, treat `opencode` as "the OpenCode CLI" and let the user's opencode
 * config decide the underlying model. `moonshot` means the dedicated kimi CLI.
 */
export type Lineage = 'anthropic' | 'openai' | 'google' | 'opencode' | 'moonshot' | 'openrouter' | 'local' | 'any';

/**
 * Transport-aware sandbox modes (Codex CLI relevant; others ignore).
 * - folder: writes only inside cwd, network blocked (strictest, default)
 * - github: workspace-write + network (gh CLI calls work)
 * - tmux: workspace-write, no network (live pane only, no persistence)
 */
export type Transport = 'folder' | 'github' | 'tmux';

export interface AgentSpawnOptions {
  /** Stable id like `chat-<chatId>-<phaseId>-<role>-<agentName>`. */
  sessionName: string;
  /** Working directory the CLI launches in. */
  cwd: string;
  /** Folder/github/tmux. Default `folder`. */
  transport?: Transport;
  /** Specific model (e.g. `claude-opus-4-7`); empty = CLI default. */
  model?: string;
  /** Pre-approved sandbox bypass for this session. Default false. Legacy — prefer `sandbox: 'full'`. */
  unsandboxed?: boolean;
  /** Used for per-account isolation (codex multi-auth). */
  accountId?: string;
  /**
   * User-configured sandbox profile from the settings table. Each shim
   * translates this into the right CLI flag(s). When unset, shims fall back
   * to their conservative default (workspace).
   */
  sandbox?: 'strict' | 'workspace' | 'full';
  /**
   * If true, shims emit auto-approval flags (kimi `--afk`, gemini auto-edit,
   * etc.) so the spawned reviewer doesn't hang on permission prompts.
   * Default true for headless reviewer spawns.
   */
  autoApprove?: boolean;
  /** Allow outbound network from the spawned reviewer. Default false. */
  networkAccess?: boolean;
}

export interface AgentNudgeOptions {
  /**
   * Absolute path to a file the agent should read before responding.
   * The CLI shim formats this path appropriately:
   *   - Gemini: `@/abs/path` inline syntax
   *   - Opencode: plain "at /abs/path" (no `/` or `@` prefix)
   *   - Claude/Codex: any reference works
   */
  promptFile: string;
  /**
   * Absolute path the agent should write its answer to. Communicated in the
   * prompt body; the daemon's output watcher polls for this file.
   */
  answerFile: string;
  /**
   * One-line summary that becomes the prompt's first line. Per-CLI formatting
   * (single-line vs multi-paragraph) is handled by the shim.
   */
  task: string;
  /**
   * Mark the prompt with `## DONE` sentinel so the watcher knows the agent
   * has flushed its full answer (some CLIs stream their output).
   */
  expectDoneSentinel?: boolean;
}

/**
 * One implementation per CLI lineage.
 * Lives at src/daemon/agents/<name>.ts and registered in src/daemon/agents/index.ts.
 */
export interface AgentShim {
  /** Lineage tag this shim handles. */
  readonly lineage: Lineage;
  /** Stable name for logs / agent picker. */
  readonly name: string;
  /**
   * Build the shell command that launches this CLI. Returned string is fed to
   * `tmux new-session -d -s <name> "<launch>"`. Caller is responsible for %q
   * quoting any user-supplied values BEFORE they reach this function — this
   * function only adds CLI-specific flags.
   */
  buildLaunchCommand(opts: AgentSpawnOptions): string;
  /**
   * Format the prompt text for THIS CLI's TUI. Must return a string safe to
   * paste via `tmux load-buffer / paste-buffer`. Per-CLI rules:
   *   - Gemini: single line, `@/abs/path`
   *   - Opencode: single line, "at /abs/path", never leads with `/` or `@`
   *   - Claude/Codex: multi-paragraph fine
   */
  formatPrompt(opts: AgentNudgeOptions): string;
  /**
   * Pre-nudge cleanup the CLI's TUI may need (dismiss overlays, send /clear,
   * etc.). Synchronous tmux send-keys calls only — no awaits.
   * Default: noop.
   */
  preNudge?(sessionName: string): void;
  /**
   * Optional tmux send-keys sequence for pre-nudge setup (e.g., /clear for opencode).
   * Array of key names like ['Escape', '/clear', 'Enter'].
   * The runner invokes `mgr.sendKeys(...)` with these in sequence.
   */
  readonly clearKeys?: readonly string[];
  /**
   * Per-CLI key sequences to auto-recover from blocking dialogs the
   * error-detector flags. The runner consults this map when a `RecoverableKind`
   * is detected, sends the keys via tmux, and emits a `cli_warning` rather than
   * a `cli_error` (we recovered, no need to fail the chat).
   *
   * Example: OpenCode's "Always allow" dialog needs `['Right', 'Enter']` to
   * navigate from default "Allow once" to "Always allow" and confirm.
   *
   * Layer 2 of the three-layer permission model. Layer 1 (config-file
   * pre-approval, e.g. `permission.bash.allow` in opencode.json) prevents the
   * dialog from appearing in the first place; Layer 2 catches anything Layer 1
   * missed; Layer 3 surfaces non-recoverable failures (quota, auth) to the user.
   */
  readonly recoverKeys?: Partial<Record<RecoverableKind, readonly string[]>>;
  /**
   * Run this CLI in headless mode (no tmux, no TUI). Yields a stream of
   * AgentEvents the runner consumes for live UI updates and final persistence.
   *
   * Optional during transition: when missing or when settings.transport='tmux',
   * runner falls back to the tmux + tmux-types path. Implement per shim in
   * Phase B of the headless migration.
   *
   * Implementation contract:
   *   - Spawn the CLI's headless mode (claude --print, gemini -p, etc.)
   *   - Pipe `opts.promptText` via argv or stdin per CLI's convention
   *   - Parse stream-json (or one-shot output) into AgentEvents
   *   - Honor `opts.abortSignal` — SIGTERM the child, then SIGKILL after grace
   *   - Honor `opts.timeoutMs` — same kill sequence on timeout
   *   - For non-streaming CLIs, emit `progress` every 5s while alive
   *   - End with exactly one `message_done` (or `error`) before iterator closes
   */
  runHeadless?(opts: HeadlessSpawnOptions): AsyncIterable<AgentEvent>;
  /**
   * Estimate per-call cost in USD. Used by /new cost preview. CLI-subscription
   * lineages return 0; API-keyed lineages use the rate card. Best-effort.
   */
  estimateCostUsd(inputTokens: number, outputTokens: number, model?: string): number;
}

/**
 * Error-detector kinds that the runner can attempt to auto-recover from by
 * sending a per-CLI key sequence. Non-recoverable kinds (quota_exhausted,
 * auth_required, opencode_db_corrupt, etc.) stay as `cli_error` events.
 */
export type RecoverableKind = 'permission_prompt';

// ─── Headless transport (v0.5+) ─────────────────────────────────────────────
//
// Alternative to tmux: spawn each CLI in `--print` / `exec` mode, pipe the
// prompt to stdin, parse stream-json events from stdout. No TUI, no
// pane-scraping, ~80% lower RAM, no persistent process between rounds.
//
// Each shim implements `runHeadless(opts)` returning AsyncIterable<AgentEvent>.
// Runner consumes the stream, persists final text to answer.md (for run-page
// artifact API backward compat), and emits SSE events as deltas arrive.
//
// CLIs that don't support stream-json (OpenCode `run --format json` is one-
// shot; Codex `exec` is plain stdout) emit a synthetic `progress` heartbeat
// every 5s so the UI shows the agent is alive, then a `message_done` with
// the full text when the process exits.

/**
 * Internal event taxonomy emitted by `runHeadless`. Discriminated union of
 * what every CLI's stream-json reduces to. Streaming CLIs (Claude, Gemini,
 * Kimi) emit `text_delta` and `tool_call_*`; one-shot CLIs (OpenCode, Codex)
 * emit only `progress` then `message_done`.
 */
export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; tool: string; input?: unknown }
  | { type: 'tool_call_end'; tool: string; ok: boolean }
  | { type: 'progress'; elapsedMs: number }
  | {
      type: 'message_done';
      finalText: string;
      /**
       * Optional usage block extracted from the upstream stream-json's
       * terminal event (claude `result.usage`, codex `assistant_done`
       * usage, gemini terminal chunk's `*TokenCount` fields). Per-lineage
       * parsers populate this when available; left undefined for kimi /
       * opencode which currently lack a structured token signal.
       *
       * Numbers are integers; cachedInputTokens is anthropic-only today.
       * The runner persists these into phase_events.tokens_in /
       * tokens_out and ignores undefined values.
       */
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
        /**
         * Cost in USD reported natively by the CLI (opencode emits per-step
         * `cost`, summed across step_finish events; other CLIs compute via
         * voices.input_cost_per_mtok / output_cost_per_mtok in a follow-up).
         * Persisted into the per-participant _stats.json sidecar so the
         * cockpit's time/tokens chip can surface "0.02 USD" alongside the
         * token count.
         */
        costUsd?: number;
      };
    }
  | { type: 'error'; kind: string; message: string };

/**
 * Options for `AgentShim.runHeadless`. Mirrors `AgentSpawnOptions` for the
 * fields that still apply (cwd, model, sandbox, autoApprove, networkAccess)
 * plus a prompt-text payload (no separate ask.md file in headless), an
 * AbortSignal for cancel, and a hard timeoutMs.
 *
 * **Stuck-process safety:** the spawn manager enforces `timeoutMs` (default
 * 10min) — SIGTERM on timeout, SIGKILL after 5s grace. AbortSignal does the
 * same on user cancel. Without these a hung CLI can burn API tokens forever.
 */
export interface HeadlessSpawnOptions {
  /** Working directory the CLI launches in. */
  cwd: string;
  /**
   * Full prompt text. Some CLIs accept this on argv (`gemini -p "<text>"`),
   * others on stdin (`claude --print < prompt`). The shim chooses.
   */
  promptText: string;
  /** Specific model; empty = CLI default. */
  model?: string;
  /** Sandbox profile from settings. */
  sandbox?: 'strict' | 'workspace' | 'full';
  /** Auto-approve in-CLI prompts. Headless mode usually auto-approves regardless. */
  autoApprove?: boolean;
  /** Allow outbound network. */
  networkAccess?: boolean;
  /** Cancel propagation (chat cancel button, daemon shutdown). */
  abortSignal?: AbortSignal;
  /** Hard timeout — process is killed after this. Default 600_000 (10 min). */
  timeoutMs?: number;
  /** Per-account isolation (codex multi-auth). */
  accountId?: string;
}

/**
 * Registry: lineage → shim. See src/daemon/agents/index.ts.
 */
export interface AgentRegistry {
  pickShim(lineage: Lineage, model?: string): AgentShim;
  listAvailable(): AgentShim[];
}
