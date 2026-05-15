/**
 * Grok Build (xAI) agent shim.
 *
 * Dispatches to `grok -p <prompt> --output-format streaming-json --yolo`,
 * parsing the newline-delimited JSON event stream. Format documented in
 * ~/.grok/docs/user-guide/13-headless-mode.md (shipped with the binary).
 *
 * Status (2026-05-15): Level 3 shim with VERIFIED FAILURE PATH only.
 * Happy-path requires a SuperGrok Heavy subscription which chorus's
 * maintainers don't have. Free-tier accounts (and unauthenticated
 * runs) cleanly surface as `quota_exhausted`/`auth_invalid` via the
 * parser + exit-handler, so a user without entitlement gets a tidy
 * "subscription required" error card and the grok voice auto-disables
 * after N strikes — same UX as any other unpaid CLI.
 *
 * If you have SuperGrok Heavy and hit a parsing bug, please open an
 * issue with the streaming-json output of a real run so we can fix
 * the parser.
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
import { parseGrok, parseGrokExit } from './parsers/index.js';

export const grokShim: AgentShim = {
  lineage: 'grok',
  name: 'grok-cli',

  buildLaunchCommand(opts: AgentSpawnOptions): string {
    validateValue('model', opts.model);
    const cwd = quotePath(opts.cwd);

    // No --yolo in tmux mode: the interactive TUI handles approvals
    // itself; passing --yolo would also reach the headless flag and
    // auto-approve everything in the visible session, which violates
    // the sandbox principle for interactive use.
    let cmd = `cd ${cwd} && grok`;

    if (opts.model) {
      cmd += ` -m ${quoteValue(opts.model)}`;
    } else {
      cmd += ` -m grok-build`;
    }

    return cmd;
  },

  formatPrompt(opts: AgentNudgeOptions): string {
    // Grok TUI accepts multi-line text. The ## DONE sentinel is the
    // standard chorus convention — see prompt-builder.ts.
    const sentinel = opts.expectDoneSentinel
      ? '\n\nEnd your response with ## DONE.'
      : '';
    return `Read ${opts.promptFile} and follow the <ask> XML block. Write your full answer to ${opts.answerFile}.${sentinel}`;
  },

  /**
   * Headless mode (`grok -p ... --output-format streaming-json --yolo`).
   *
   * `--yolo` auto-approves tool executions inside the agent run. This is
   * the standard headless pattern documented in Grok's user-guide; without
   * it the run hangs waiting for tool-approval prompts that have no UI.
   *
   * `--max-turns 1` keeps reviewer dispatch to a single agentic turn —
   * reviewers are expected to produce one structured response, not loop
   * through multi-turn tool-use cycles. Caps subscription-quota burn on
   * a runaway and matches the single-shot semantics other reviewer
   * shims rely on. For doer slots the runner could override via opts
   * (future extension; not wired today).
   *
   * Auth: Grok reads ~/.grok/auth.json (OIDC) or GROK_CODE_XAI_API_KEY.
   * Precheck verifies one of these is present before we even spawn —
   * otherwise grok would attempt to spawn a browser-OAuth flow inline,
   * which hangs the daemon's headless dispatch indefinitely.
   */
  runHeadless(opts: HeadlessSpawnOptions): AsyncIterable<AgentEvent> {
    const args = [
      '-p',
      opts.promptText,
      '--output-format',
      'streaming-json',
      '--yolo',
      '--max-turns',
      '1',
      '-m',
      opts.model || 'grok-build',
    ];

    const run = spawnHeadless({
      command: 'grok',
      args,
      cwd: opts.cwd,
      parseLine: parseGrok,
      onExit: (out, err, code) => parseGrokExit(out, err, code),
      cli: 'grok',
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
      heartbeat: false, // streaming
    });

    return run.events;
  },

  estimateCostUsd(): number {
    // Grok Build is SuperGrok-Heavy subscription only — no per-call
    // metering surfaced to the CLI. Cost is opaque from chorus's POV;
    // 0 in the shadow-price column matches the claude/gemini subscription
    // pattern (their plan cost is amortised, not per-call).
    return 0;
  },
};
