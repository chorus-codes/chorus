/**
 * Antigravity CLI (Google) agent shim.
 *
 * Dispatches to `agy -p <prompt> --dangerously-skip-permissions`,
 * parsing plain-text stdout (no JSON streaming mode exists).
 *
 * Status (2026-05-20): Level 3 shim with empirical happy-path probe
 * verified against agy 1.0.0 (Google AI Pro subscription, victor@99x.agency).
 * The CLI locks the model to Gemini 3.5 Flash (High) — there's no
 * `--model` flag. Model field on this shim is informational only.
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
import { quotePath } from './quote.js';
import { spawnHeadless } from '../headless.js';
import { parseAntigravity, parseAntigravityExit } from './parsers/index.js';

export const antigravityShim: AgentShim = {
  lineage: 'antigravity',
  name: 'antigravity-cli',

  buildLaunchCommand(opts: AgentSpawnOptions): string {
    // tmux interactive path. agy's TUI doesn't accept --model and
    // doesn't need a --dangerously-skip-permissions flag in interactive
    // mode (it prompts for approval inline). `opts.model` is ignored
    // because the CLI hard-locks Gemini 3.5 Flash.
    const cwd = quotePath(opts.cwd);
    return `cd ${cwd} && agy`;
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
   * No `--model` flag — the binary is locked to Gemini 3.5 Flash.
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
    const args = [
      '-p',
      opts.promptText,
      '--dangerously-skip-permissions',
    ];

    const run = spawnHeadless({
      command: 'agy',
      args,
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
