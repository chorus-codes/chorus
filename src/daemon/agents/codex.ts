/**
 * Codex CLI agent shim.
 * Per-session CODEX_HOME for parallel safety (see feedback_codex_home_per_account.md).
 * Transport-aware sandbox modes (see feedback_codex_sandbox_modes.md).
 */

import type {
  AgentShim,
  AgentSpawnOptions,
  AgentNudgeOptions,
  HeadlessSpawnOptions,
  AgentEvent,
} from './types.js';
import { quoteValue, quotePath, validateValue } from './quote.js';
import { preTrustCodexWorkspace } from './preflight.js';
import { spawnHeadless } from '../headless.js';
import { parseCodex, parseCodexExit } from './parsers/index.js';
import { scanCodexStderr } from './parsers/codex-stderr-scan.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Resolve CODEX_HOME for this spawn.
 *
 * - `CHORUS_CODEX_HOME` env var (when set) wins on the single-user path.
 *   Lets users point chorus at a non-rate-limited codex account
 *   (e.g. `~/.codex-cdx-2`) without forking the shim or wiring multi-account
 *   isolation. Ignored when `accountId` is explicit — that path already owns
 *   account selection.
 * - When `accountId` is undefined/empty AND no env override: reuse the user's
 *   existing `~/.codex/` (their primary login). v0.5 single-user default.
 * - When `accountId` is explicit: create/reuse `~/.codex-<accountId>/` for
 *   parallel multi-account isolation. Copies config.toml from the primary
 *   home; NEVER copies auth.json (each account must have its own login).
 */
function ensureCodexHome(accountId: string | undefined): string {
  const homeDir = os.homedir();
  const primary = path.join(homeDir, '.codex');

  if (!accountId) {
    const override = process.env.CHORUS_CODEX_HOME?.trim();
    if (override && override.length > 0) {
      // Trust the user — if the dir doesn't exist or has no auth.json, codex
      // exec will fail loudly (which is now surfaced via quota_exhausted /
      // cli_error). Better than silently picking the rate-limited primary.
      return override;
    }
    // Single-user fast path — use the user's existing login.
    return primary;
  }

  const codexDir = path.join(homeDir, `.codex-${accountId}`);

  if (!fs.existsSync(codexDir)) {
    fs.mkdirSync(codexDir, { recursive: true });

    // config.toml is non-critical — codex falls back to its built-in
    // defaults when the file is absent. Wrap the copy so an EACCES /
    // ENOENT race (file unlinked between exists and read, or chmod 0)
    // doesn't crash ensureCodexHome with an unhandled exception. The
    // directory was already created; the caller can still attempt to
    // spawn codex with no overridden config.
    try {
      const defaultConfigPath = path.join(primary, 'config.toml');
      const targetConfigPath = path.join(codexDir, 'config.toml');
      if (fs.existsSync(defaultConfigPath) && !fs.existsSync(targetConfigPath)) {
        const content = fs.readFileSync(defaultConfigPath, 'utf-8');
        fs.writeFileSync(targetConfigPath, content, 'utf-8');
      }
    } catch (err) {
      console.warn(
        `[codex] config.toml copy to ${codexDir} failed (continuing with codex defaults):`,
        err instanceof Error ? err.message : err,
      );
    }

    // NOTE: NEVER copy auth.json — each CODEX_HOME must have its own.
    // First launch will prompt for `codex login`.
  }

  return codexDir;
}

/**
 * Build `codex exec` argv for headless reviewer/doer runs.
 *
 * Pure function — no I/O, no env reads — so we can unit-test the exact
 * argv shape (especially `--ignore-user-config`, which is load-bearing
 * for issues #10 and #16).
 *
 * Why `--ignore-user-config` is here: the user's `~/.codex/config.toml`
 * may declare MCP servers, plugins, or notification hooks. In headless
 * `codex exec` mode those integrations have caused codex to hang or
 * cancel mid-call — see #10 (codex as our reviewer) and #16 (codex as
 * MCP client of chorus) for two independent reproductions of the same
 * class of failure. Skipping the user config gives us a clean,
 * deterministic codex run for review work; we still pass through the
 * sandbox/network flags chorus owns explicitly below.
 */
export function buildHeadlessArgs(opts: HeadlessSpawnOptions): string[] {
  const args: string[] = ['exec'];

  // Chorus chat dirs aren't git repos. Without this flag codex exec
  // exits 1 with "Not inside a trusted directory".
  args.push('--skip-git-repo-check');

  // Strip user config — see function docstring for why.
  args.push('--ignore-user-config');

  if (opts.sandbox === 'full') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else if (opts.sandbox === 'strict') {
    args.push('-c', 'sandbox_mode="read-only"');
  }

  if (opts.networkAccess) {
    args.push('-c', 'sandbox_workspace_write.network_access=true');
  }

  if (opts.model) {
    args.push('--model', opts.model);
  }

  // `-` tells codex exec to read the prompt from stdin (avoids ARG_MAX).
  args.push('-');

  return args;
}

export const codexShim: AgentShim = {
  lineage: 'openai',
  name: 'codex-cli',

  buildLaunchCommand(opts: AgentSpawnOptions): string {
    validateValue('accountId', opts.accountId);
    validateValue('model', opts.model);

    const codexHome = ensureCodexHome(opts.accountId);
    // Pre-trust the chat dir so Codex skips its first-launch trust prompt.
    preTrustCodexWorkspace(codexHome, opts.cwd);

    const cwd = quotePath(opts.cwd);
    const flags: string[] = [];

    // Sandbox profile from user settings (may be overridden by transport).
    if (opts.unsandboxed || opts.sandbox === 'full') {
      // Full bypass — user explicitly opted into trust-everything.
      flags.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (opts.sandbox === 'strict') {
      // Read-only — codex can't write files or shell-exec.
      flags.push('-c', 'sandbox_mode="read-only"');
    }
    // 'workspace' (default) leaves codex in its config.toml-defined
    // workspace-write mode. No flag override.

    // Network access — opt-in. github transport always needs network.
    if (opts.networkAccess || opts.transport === 'github') {
      flags.push('-c', 'sandbox_workspace_write.network_access=true');
    }

    if (opts.model) {
      flags.push('--model', quoteValue(opts.model));
    }

    const flagsStr = flags.length > 0 ? ` ${flags.join(' ')}` : '';
    return `cd ${cwd} && CODEX_HOME=${quotePath(codexHome)} codex${flagsStr}`;
  },

  formatPrompt(opts: AgentNudgeOptions): string {
    const sentinel = opts.expectDoneSentinel
      ? '\n\nWhen finished, end your response with: ## DONE'
      : '';

    return (
      `${opts.task}\n\n` +
      `Read the prompt at: ${opts.promptFile}\n\n` +
      `Write your full answer to: ${opts.answerFile}${sentinel}`
    );
  },

  /**
   * Headless mode (`codex exec -`).
   *
   * Codex `exec` accepts the prompt either as a positional arg or, when `-`
   * is passed (or no positional), on stdin. We always pipe via stdin so big
   * diff reviews (chorus self-review on a 100KB+ PR diff) don't hit the OS
   * argv ceiling — a single large argv string crosses ARG_MAX on some shells
   * and triggers truncation/silent failure modes upstream.
   *
   * Sandbox flags forwarded same as the tmux path. Codex's `exec` honors
   * `-c sandbox_mode=...` and `-c sandbox_workspace_write.network_access=...`
   * the same way as the interactive command.
   */
  runHeadless(opts: HeadlessSpawnOptions): AsyncIterable<AgentEvent> {
    validateValue('accountId', opts.accountId);
    validateValue('model', opts.model);

    const codexHome = ensureCodexHome(opts.accountId);
    preTrustCodexWorkspace(codexHome, opts.cwd);

    const args = buildHeadlessArgs(opts);

    const run = spawnHeadless({
      command: 'codex',
      args,
      cwd: opts.cwd,
      env: { CODEX_HOME: codexHome },
      stdinPayload: opts.promptText,
      parseLine: parseCodex,
      onExit: (fullStdout, fullStderr, code) =>
        parseCodexExit(fullStdout, fullStderr, code),
      cli: 'codex',
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
      heartbeat: true, // no streaming; heartbeat keeps UI alive
      // Cut codex's 8-minute internal-retry loop on auth failures by
      // matching the deterministic stderr signatures the moment they
      // surface. Without this, parseCodexExit only sees the error
      // after `codex` finally gives up — which is the multi-minute
      // wait we're trying to remove.
      earlyAbortStderrScan: scanCodexStderr,
    });

    return run.events;
  },

  estimateCostUsd(): number {
    // Codex uses subscription, not per-call API billing
    return 0;
  },
};
