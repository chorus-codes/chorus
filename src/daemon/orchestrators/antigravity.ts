import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ConnectOpts,
  OrchestratorDefinition,
  OrchestratorStatus,
} from './shared.js';

/**
 * Antigravity CLI (`agy`) — reviewer-only orchestrator.
 *
 * Antigravity is the second Google first-party CLI (Gemini 3.5 Flash via
 * Google AI Pro subscription). Unlike Claude / Codex / Gemini / Kimi /
 * OpenCode, `agy` does NOT consume chorus's MCP tools — it's a one-way
 * reviewer dispatch target only. So this orchestrator has nothing to
 * "connect" in the MCP-wiring sense; its job is purely to surface
 * antigravity in the Home page Reviewer Fleet panel and the /connect
 * card list once the binary is detected.
 *
 * Without this entry, the orchestrators/list endpoint omits antigravity
 * and the Home fleet card disappears even though the voice is seeded,
 * the shim works, and the `agy` binary is on PATH. PR #62 (v0.8.45)
 * shipped detection + shim + voice but missed the orchestrator step.
 *
 * Authentication: `agy` does its own browser OAuth on first run, writing
 * `~/.gemini/antigravity-cli/antigravity-oauth-token`. Auth failures
 * surface via the standard cli-health pipeline (auth_invalid +
 * AUTH_INVALID_COOLDOWN_MS skip) — no orchestrator-side handling.
 */
const AGY_CONFIG_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');
const AGY_TOKEN_PATH = path.join(AGY_CONFIG_DIR, 'antigravity-oauth-token');

function detectAgy(): boolean {
  // Two-signal detection mirrors the precheck: the OAuth token file is
  // the most reliable "user has logged in once" signal; the config dir
  // alone catches the case where the user installed `agy` but hasn't
  // completed OAuth yet — we still want the card visible with a "log in
  // to enable" hint, not silently gone.
  return fs.existsSync(AGY_TOKEN_PATH) || fs.existsSync(AGY_CONFIG_DIR);
}

function getAntigravityStatus(): OrchestratorStatus {
  const detected = detectAgy();
  const authed = fs.existsSync(AGY_TOKEN_PATH);
  return {
    name: 'antigravity',
    label: 'Antigravity',
    // "Connected" here means "chorus can dispatch reviews to it" —
    // antigravity has no MCP tools to approve, so detection + auth is
    // the whole bar.
    connected: detected && authed,
    approvedTools: 0,
    totalTools: 0,
    note: authed
      ? 'Reviewer-only: chorus dispatches to agy as a Gemini 3.5 Flash reviewer. agy does NOT consume chorus.* tools — no MCP wiring needed.'
      : detected
        ? '`agy` binary detected but no OAuth token yet. Run `agy` interactively once to complete the Google AI Pro browser sign-in.'
        : 'Install Antigravity CLI from antigravity.dev — Google AI Pro subscription required for Gemini 3.5 Flash dispatch.',
    supported: detected,
    // `agy` never calls chorus tools, so firstCallBehavior is irrelevant.
    // `auto` is the sensible default for a "nothing to prompt about" CLI.
    firstCallBehavior: 'auto',
  };
}

export const antigravityOrchestrator: OrchestratorDefinition = {
  name: 'antigravity',
  label: 'Antigravity',
  getStatus: getAntigravityStatus,
  detect: detectAgy,
  connect: async (_opts: ConnectOpts) => {
    // No-op: agy has no MCP config to write. Surface a clear error when
    // the binary isn't on disk so the /connect flow doesn't claim
    // success on a missing CLI.
    if (!detectAgy()) {
      throw new Error(
        'Antigravity CLI (`agy`) not detected. Install from antigravity.dev ' +
          'and run `agy` once interactively to complete the Google AI Pro OAuth.',
      );
    }
    return {
      registered: false,
      toolsAdded: 0,
      slashCommand: 'skipped' as const,
      full: {
        added: [],
        alreadyPresent: ['(reviewer-only — no chorus MCP wiring needed)'],
        configPath: AGY_TOKEN_PATH,
        slashCommand: 'skipped' as const,
        slashCommandPath: '',
      },
    };
  },
};
