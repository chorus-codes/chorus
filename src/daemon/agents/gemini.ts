/**
 * Gemini CLI agent shim.
 * Single-line prompts only (see feedback_gemini_multiline_prompts.md).
 * Uses --approval-mode auto_edit (never yolo, see feedback_gemini_yolo_dangerous.md).
 * File references via @/abs/path inline syntax.
 */

import type {
  AgentShim,
  AgentSpawnOptions,
  AgentNudgeOptions,
  HeadlessSpawnOptions,
  AgentEvent,
} from './types.js';
import { quoteValue, quotePath, validateValue } from './quote.js';
import { spawnHeadless } from '../headless.js';
import { parseGemini, parseGeminiExit } from './parsers/index.js';

export const geminiShim: AgentShim = {
  lineage: 'google',
  name: 'gemini-cli',

  buildLaunchCommand(opts: AgentSpawnOptions): string {
    validateValue('model', opts.model);

    const cwd = quotePath(opts.cwd);

    // Map sandbox profile to gemini's approval-mode. Never use yolo —
    // see feedback_gemini_yolo_dangerous.md (auto_edit is safe-by-default).
    let approvalMode = 'auto_edit';
    if (opts.sandbox === 'strict') approvalMode = 'default';
    // 'workspace' (default) and 'full' both use auto_edit. Going beyond
    // auto_edit (i.e. yolo) is intentionally NOT supported here — the user
    // who wants gemini fully unsandboxed can run gemini outside chorus.

    let cmd = `cd ${cwd} && gemini --approval-mode ${approvalMode}`;

    if (opts.model) {
      cmd += ` -m ${quoteValue(opts.model)}`;
    } else {
      // Default to gemini-2.5-pro — universally available across gemini-cli
      // accounts (gemini-3.1-pro-preview is gated behind preview access and
      // 404s on most accounts, see catalog comment in lineage-maps.ts).
      cmd += ` -m gemini-2.5-pro`;
    }

    return cmd;
  },

  formatPrompt(opts: AgentNudgeOptions): string {
    // CRITICAL: Single-line only. Gemini submits each \n as a separate query.
    // Use @/abs/path inline syntax for file references (no plain paths).
    const sentinel = opts.expectDoneSentinel ? ' End your response with ## DONE.' : '';

    return (
      `@${opts.promptFile} Read this file and follow the <ask> XML block, ` +
      `write your full answer to ${opts.answerFile}.${sentinel}`
    );
  },

  /**
   * Headless mode (`gemini -p " " --output-format stream-json` + stdin).
   *
   * Gemini's `-p`/`--prompt` value is appended to anything piped on stdin
   * ("Appended to input on stdin (if any)" — verified `gemini --help`
   * 2026-05-02). We pipe the full multi-line prompt via stdin and pass a
   * placeholder `" "` (single space) on `-p` to mark the run non-interactive.
   * This dodges:
   *   1. argv overflow on big diffs (chorus self-reviews routinely cross
   *      100KB+ — argv hits ARG_MAX or shell-quoting issues).
   *   2. The historical "-p with newlines hangs" bug — irrelevant once the
   *      multi-line content lives on stdin.
   *
   * Format verified 2026-04-30; see parseGemini for shape.
   */
  runHeadless(opts: HeadlessSpawnOptions): AsyncIterable<AgentEvent> {
    // -p needs a non-empty value to flip gemini into non-interactive mode.
    // Windows note: when daemon spawns with shell:true (required for .cmd
    // shims, see headless.ts), Node concatenates argv with spaces and the
    // shell collapses runs of whitespace — the original placeholder ' '
    // got eaten and gemini parsed --output-format as the -p value, then
    // exited with help. Use a non-whitespace placeholder. The trailing
    // character on the prompt is harmless: gemini appends it after the
    // stdin payload, which our reviewers ignore as content noise.
    const args = [
      '-p',
      '_',
      '--output-format',
      'stream-json',
      '--skip-trust',
    ];

    // Sandbox profile → approval-mode mapping. Never use yolo
    // (see feedback_gemini_yolo_dangerous.md — empty-content overwrites).
    if (opts.sandbox === 'strict') {
      args.push('--approval-mode', 'plan'); // read-only
    } else {
      args.push('--approval-mode', 'auto_edit');
    }

    // Model — Gemini CLI requires an explicit model on current API; default
    // to gemini-2.5-pro (universally available; 3.1-pro-preview is gated).
    args.push('-m', opts.model || 'gemini-2.5-pro');

    const run = spawnHeadless({
      command: 'gemini',
      args,
      cwd: opts.cwd,
      stdinPayload: opts.promptText,
      env: {
        // Defense in depth: env-var trust override matches the --skip-trust flag.
        GEMINI_CLI_TRUST_WORKSPACE: 'true',
      },
      parseLine: parseGemini,
      // gemini-cli logs upstream API errors (notably 429 quota
      // exhaustion) to stderr without mirroring them in the JSON
      // result line. parseGeminiExit scans the captured stderr on
      // exit and emits a `quota_exhausted` event with the parsed
      // reset window — without this, the cockpit only sees the
      // generic "Gemini result status=error" from the parser and
      // the user can't tell when their quota will reset.
      onExit: (out, err, code) => parseGeminiExit(out, err, code),
      cli: 'gemini',
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
      heartbeat: false, // streaming
    });

    return run.events;
  },

  estimateCostUsd(): number {
    // Gemini via CLI may use subscription or API key; assume 0 for now
    return 0;
  },
};
