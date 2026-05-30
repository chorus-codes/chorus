/**
 * Kimi CLI (MoonshotAI) agent shim.
 *
 * Uses `--afk` flag which auto-dismisses AskUserQuestion AND auto-approves
 * tool calls. Equivalent to claude's auto-accept and codex's
 * approval_policy=never. Without it kimi shows a one-time "Allow this tool?"
 * dialog that would block a chorus-spawned reviewer indefinitely.
 *
 * If a new kimi release ever drops `--afk`, the error-detector pattern in
 * src/daemon/error-detector.ts (kind='permission_prompt') is a defense-in-
 * depth fallback — runner can capture-pane and send-keys to dismiss it.
 *
 * MCP context: kimi spawned as a reviewer doesn't talk to chorus's own MCP
 * server (that would be circular). It just reads ask.md, writes answer.md.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentShim,
  AgentSpawnOptions,
  AgentNudgeOptions,
  HeadlessSpawnOptions,
  AgentEvent,
} from './types.js';
import { quoteValue, quotePath, validateValue } from './quote.js';
import { spawnHeadless } from '../headless.js';
import { parseOpencode, parseOpencodeExit, parseKimi } from './parsers/index.js';
import { atomicWriteJsonSync } from '../../lib/atomic-write.js';
import { wrapWithPty } from './opencode.js';
import { assertSandboxSupported, sandboxFailClosed } from './sandbox-guard.js';

/**
 * Two ways to talk to Kimi K2.6:
 *
 *   - Standalone `kimi` CLI — Claude-Code-compatible, supports streaming
 *     text deltas via `--print --output-format stream-json`. Two builds
 *     share this binary: native Kimi Code (code.kimi.com → `~/.kimi-code`,
 *     account-authed via `kimi login`) and the legacy Python kimi-cli
 *     (needs a `default_model`/`[models]` block in `~/.kimi/config.toml`;
 *     an empty config exits 1 with "LLM not set").
 *
 *   - `opencode run --format json --model opencode-go/kimi-k2.6` (paid
 *     OpenCode Go subscription) — same model under the hood, routed
 *     through OpenCode. JSON-Lines output; one text event per LLM
 *     message. The fleet and openbridge journals use this path.
 *
 * `chooseKimiTransport` (below) holds the full precedence. In short: env
 * override wins; a native `~/.kimi-code` install or a configured Python
 * kimi-cli drives `kimi` directly; otherwise fall back to opencode-go.
 * Override via env `CHORUS_KIMI_TRANSPORT=kimi-cli|opencode` (default auto).
 */
type KimiTransport = 'kimi-cli' | 'opencode';

let cachedTransport: KimiTransport | null = null;

/**
 * Pure transport decision — no module-level cache, takes the home dir and
 * the raw env override as arguments so it's testable without touching the
 * real `~`. `detectKimiTransport()` wraps it with the cache + real homedir.
 *
 * Precedence:
 *   1. `CHORUS_KIMI_TRANSPORT` env override always wins.
 *   2. Native Kimi Code (code.kimi.com → `~/.kimi-code`) → drive `kimi`
 *      directly. It's account-authed via `kimi login` and has no
 *      `~/.kimi/config.toml`, so the legacy config probe below would have
 *      wrongly shunted it to opencode-go — ignoring the user's install or
 *      failing outright when they lack an OpenCode Go subscription (#98).
 *   3. Python kimi-cli with a wired model in `~/.kimi/config.toml` (empty
 *      config exits 1 "LLM not set", so a populated one is the gate).
 *   4. Otherwise fall back to opencode + opencode-go.
 */
export function chooseKimiTransport(
  homeDir: string,
  override?: string,
): KimiTransport {
  if (override === 'kimi-cli' || override === 'opencode') return override;

  // Native Kimi Code install — the active `kimi` on PATH (its installer
  // renames any prior Python kimi-cli to `kimi-legacy`). Drive it directly.
  if (fs.existsSync(path.join(homeDir, '.kimi-code'))) return 'kimi-cli';

  // Standalone Python kimi-cli — usable only when a model is wired:
  // non-empty `default_model` OR any `[models.<name>]` table.
  const configPath = path.join(homeDir, '.kimi', 'config.toml');
  if (fs.existsSync(configPath)) {
    try {
      const body = fs.readFileSync(configPath, 'utf-8');
      const defaultModel = body.match(/^\s*default_model\s*=\s*["']([^"']+)["']/m);
      const hasDefault = defaultModel != null && defaultModel[1].length > 0;
      const hasModelsTable = /^\[models\.[A-Za-z0-9_.-]+\]/m.test(body);
      if (hasDefault || hasModelsTable) return 'kimi-cli';
    } catch {
      /* fall through */
    }
  }

  return 'opencode';
}

function detectKimiTransport(): KimiTransport {
  if (cachedTransport) return cachedTransport;
  cachedTransport = chooseKimiTransport(
    os.homedir(),
    process.env.CHORUS_KIMI_TRANSPORT,
  );
  return cachedTransport;
}

/**
 * Drop a per-participant `_meta.json` sidecar so the cockpit can show
 * which binary + model actually ran. Without this the run page would
 * always say "kimi-cli · kimi-k2.6" even when the underlying transport
 * is opencode + opencode-go/kimi-k2.6. Best-effort — failures are silent
 * (the sidecar is purely informational).
 */
function writeTransportMeta(cwd: string, binary: string, model: string): void {
  try {
    // Atomic temp+rename — cockpit polls this file; a crash mid-write would
    // otherwise leave a half-written JSON that the parser rejects. See
    // src/lib/atomic-write.ts for the rationale.
    const metaPath = path.join(cwd, '_meta.json');
    atomicWriteJsonSync(metaPath, { binary, model, ts: Date.now() });
  } catch {
    /* informational only */
  }
}

export const kimiShim: AgentShim = {
  lineage: 'moonshot',
  name: 'kimi-cli',

  buildLaunchCommand(opts: AgentSpawnOptions): string {
    validateValue('model', opts.model);
    // Same fail-closed gate as opencode — kimi-cli mirrors opencode's
    // codebase and inherits the same gap. Audit D1 BLOCKER.
    assertSandboxSupported(opts.sandbox, 'kimi');

    const cwd = quotePath(opts.cwd);
    let cmd = `cd ${cwd} && kimi`;

    // --afk auto-dismisses prompts and auto-approves tool calls. Default ON
    // for headless reviewer spawns; user can flip via settings if they want
    // to be prompted in the kimi terminal session.
    if (opts.autoApprove !== false) {
      cmd += ` --afk`;
    }

    if (opts.model) {
      cmd += ` -m ${quoteValue(opts.model)}`;
    }

    return cmd;
  },

  // Defense-in-depth recovery if --afk is dropped or a future kimi rev shows
  // a different prompt shape. The kimi standalone CLI mirrors opencode's
  // 2-step dialog UX (it's the same upstream codebase) so we send the same
  // 3-key sequence: `Right` highlights "Allow always", first `Enter` opens
  // the nested "Confirm/Cancel" dialog (default = Confirm), second `Enter`
  // confirms it. See opencode.ts for the full per-key rationale.
  recoverKeys: {
    permission_prompt: ['Right', 'Enter', 'Enter'] as const,
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
   * Headless mode — branches on detected transport (see top-of-file
   * comment for the kimi-cli vs opencode-go decision tree).
   *
   *   - kimi-cli: streaming `kimi --print --output-format stream-json`,
   *     parsed via parseKimi (Claude-Code-compatible JSON events).
   *
   *   - opencode: one-shot `opencode run --format json --model
   *     opencode-go/kimi-k2.6 "<prompt>"`, parsed via parseOpencode
   *     (JSON-Lines, one text event per LLM message).
   *
   * Model normalisation: templates pass `kimi-k2.6` (plain). For the
   * opencode path we prepend `opencode-go/` so the CLI routes through
   * the Go subscription gateway.
   */
  runHeadless(opts: HeadlessSpawnOptions): AsyncIterable<AgentEvent> {
    const sandboxError = sandboxFailClosed(opts.sandbox, 'kimi');
    if (sandboxError) return sandboxError;

    const transport = detectKimiTransport();

    if (transport === 'kimi-cli') {
      const model = opts.model ?? 'kimi-k2.6';
      writeTransportMeta(opts.cwd, 'kimi-cli', model);
      const args = ['--print', '--output-format', 'stream-json'];
      if (opts.model) args.push('-m', opts.model);
      const run = spawnHeadless({
        command: 'kimi',
        args,
        cwd: opts.cwd,
        stdinPayload: opts.promptText,
        parseLine: parseKimi,
        // cli tag is the binary that actually ran — error messages quote
        // it as "{cli} exited N", so misattributing failures to the wrong
        // binary sends the user looking at the wrong PATH/auth/install.
        cli: 'kimi',
        timeoutMs: opts.timeoutMs,
        abortSignal: opts.abortSignal,
        heartbeat: false,
      });
      return run.events;
    }

    // opencode path — qualify the model with the opencode-go/ prefix.
    const rawModel = opts.model ?? 'kimi-k2.6';
    const model = rawModel.startsWith('opencode-go/')
      ? rawModel
      : `opencode-go/${rawModel}`;
    writeTransportMeta(opts.cwd, 'opencode-cli', model);
    // Argv-overflow guard: stash the prompt on disk and pass a tiny argv
    // directive instead of the full prompt. Mirrors opencodeShim — see its
    // runHeadless for why (opencode `run` only takes a positional argv).
    const promptPath = path.join(opts.cwd, 'prompt.md');
    fs.writeFileSync(promptPath, opts.promptText, 'utf-8');
    const directive =
      `Open the file at this absolute path using your read tool: ${promptPath} ` +
      `— follow the instructions inside exactly and respond with your full answer in this conversation, ending with ## DONE.`;
    const opencodeArgs = ['run', '--format', 'json', '--model', model, directive];
    // PTY-wrap the spawn — opencode 1.14.x's `run --format json` checks
    // isatty(stdout) and emits zero bytes when piped (model still runs to
    // completion, just no JSON output). The opencode shim's runHeadless
    // wraps for the same reason. Without this, every Kimi reviewer routed
    // through the opencode-go transport (the default when no standalone
    // kimi config exists) silently produces 0-byte answer.md — exactly the
    // failure mode the opencode PTY fix was written to prevent. Confirmed
    // launch-eve by both deepseek and gemini reviewing the shims; the bug
    // was a copy-paste oversight when the PTY fix landed in opencode.ts.
    const { command, args } = wrapWithPty('opencode', opencodeArgs);
    const run = spawnHeadless({
      command,
      args,
      cwd: opts.cwd,
      parseLine: parseOpencode,
      onExit: (fullStdout) => parseOpencodeExit(fullStdout),
      // Tag the failure as 'opencode' — that's the binary that runs.
      // The previous 'kimi' tag emitted "kimi exited 127: opencode:
      // command not found" which sent the user hunting for a kimi-CLI
      // PATH issue when the actual missing binary is opencode.
      cli: 'opencode',
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
      heartbeat: true,
    });
    return run.events;
  },

  estimateCostUsd(): number {
    // Kimi CLI uses Moonshot subscription on the user's plan, not metered API.
    return 0;
  },

  // Same opencode-go gateway flake risk as the opencode shim — when the
  // requested model carries the opencode-go/ prefix the kimi shim
  // delegates to opencode internally (see runHeadless above). Inherit
  // the same retry posture so moonshot lineages don't silently fall
  // back without an attempt at the cheap recovery. Flagged by codex on
  // the PR #87 self-audit ("isOpenCodeFamily" idiom appears throughout
  // error-detector.ts; the original lineage dispatch only checked
  // 'opencode' and left this gap open).
  retryPolicy: {
    onNullKind: true,
    onNoOutput: true,
  },
};
