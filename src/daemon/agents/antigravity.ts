/**
 * Antigravity CLI (Google) agent shim.
 *
 * Dispatches to `agy -p <prompt> --dangerously-skip-permissions`,
 * parsing plain-text stdout (no JSON streaming mode exists).
 *
 * Status (2026-07-27): Level 3 shim, re-probed against agy 1.1.7.
 * The CLI is NO LONGER single-model: it grew a `--model` flag and an
 * `agy models` subcommand listing 11 models, spanning vendors —
 * gemini-3.6/3.5-flash and 3.1-pro, but also claude-sonnet-4-6,
 * claude-opus-4-6-thinking and gpt-oss-120b-medium.
 *
 * Running a Claude model through `agy` is a legitimate choice — an
 * Antigravity subscriber may have no Claude subscription of their own,
 * and this is the only way they reach that model. Chorus passes the
 * selection through rather than second-guessing it. What it does NOT do
 * is pretend the reviewer is Google-family: the voice row carries
 * `vendor_family` from the model name (see voices.ts), so quorum
 * fallback and diversity still see anthropic when anthropic is what's
 * actually answering — the same split opencode-go voices use.
 *
 * Auth: OAuth token at ~/.gemini/antigravity-cli/antigravity-oauth-token.
 * Without it, agy attempts an inline browser-OAuth flow that hangs
 * headless dispatch indefinitely — cli-precheck.ts blocks before spawn.
 */

import type {
  AgentShim,
  AgentSpawnOptions,
  AgentNudgeOptions,
  HeadlessSpawnOptions,
  AgentEvent,
} from './types.js';
import { quotePath, quoteValue, validateValue } from './quote.js';
import { spawnHeadless } from '../headless.js';
import { parseAntigravity, parseAntigravityExit } from './parsers/index.js';

/**
 * Pure argv builder for `agy -p`. Exported for direct testing, mirroring
 * codex's buildHeadlessArgs — the argv is the whole contract with the CLI,
 * and it's the part that silently rots when the CLI adds a flag.
 */
export function buildHeadlessArgs(opts: HeadlessSpawnOptions): string[] {
  return [
    '-p',
    opts.promptText,
    '--dangerously-skip-permissions',
    // Omitted when the slot names no model, so the CLI keeps its own
    // default instead of us naming one this account may not have.
    ...(opts.model ? ['--model', opts.model] : []),
  ];
}

export const antigravityShim: AgentShim = {
  lineage: 'antigravity',
  name: 'antigravity-cli',

  buildLaunchCommand(opts: AgentSpawnOptions): string {
    // tmux interactive path. No --dangerously-skip-permissions here: the
    // TUI prompts for approval inline, which is the point of watching a
    // session. `--model` IS accepted (it's a global flag, "Model for the
    // current CLI session"), so an interactive takeover runs the same
    // model the headless slot would have.
    validateValue('model', opts.model);
    const cwd = quotePath(opts.cwd);
    const model = opts.model ? ` --model ${quoteValue(opts.model)}` : '';
    return `cd ${cwd} && agy${model}`;
  },

  formatPrompt(opts: AgentNudgeOptions): string {
    const sentinel = opts.expectDoneSentinel
      ? '\n\nEnd your response with ## DONE.'
      : '';
    return `Read ${opts.promptFile} and follow the <ask> XML block. Write your full answer to ${opts.answerFile}.${sentinel}`;
  },

  /**
   * Headless mode (`agy -p <prompt> --dangerously-skip-permissions`).
   *
   * Flags:
   * - `-p` / `--print` — single-prompt non-interactive mode (5m timeout
   *   default per `agy --help`; chorus's own timeout governs).
   * - `--dangerously-skip-permissions` — auto-approve tool invocations.
   *   Same flag name as Claude Code; chosen by Google to mirror that
   *   established UX. Without it, headless dispatch hangs on the first
   *   tool-approval prompt that has no TTY.
   *
   * - `--model` — passed through when the slot names one. Omitted when
   *   it doesn't, so the CLI keeps its own default rather than us
   *   guessing at a model this account may not have access to.
   * No `--max-turns` — agy doesn't expose multi-turn cap; reviewer
   *   slots are single-shot by chorus convention (one prompt, one
   *   answer file), so this hasn't been an issue in probe runs.
   * No JSON output format — stdout is plain text. The parser treats
   *   each line as a text_delta.
   *
   * Auth precheck (cli-precheck.ts) verifies the OAuth token file
   * exists before we spawn. Without it agy launches a browser-OAuth
   * flow inline and the headless dispatch hangs forever.
   */
  runHeadless(opts: HeadlessSpawnOptions): AsyncIterable<AgentEvent> {
    const run = spawnHeadless({
      command: 'agy',
      args: buildHeadlessArgs(opts),
      cwd: opts.cwd,
      parseLine: parseAntigravity,
      onExit: (out, err, code) => parseAntigravityExit(out, err, code),
      cli: 'agy',
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
      heartbeat: true,
    });

    return run.events;
  },

  estimateCostUsd(): number {
    // Google AI Pro is a flat subscription — agy doesn't surface per-call
    // cost. Matches the claude/gemini-cli/grok pattern: plan cost is
    // amortised across calls; chorus shows 0 in the shadow-price column.
    return 0;
  },
};
