import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ConnectOpts,
  OrchestratorDefinition,
  OrchestratorStatus,
} from './shared.js';

const GROK_CONFIG_DIR = path.join(os.homedir(), '.grok');
const GROK_BIN_PATH = path.join(GROK_CONFIG_DIR, 'bin', 'grok');

/**
 * Grok Build CLI (xAI) — pickup-via-Claude orchestrator.
 *
 * Verified 2026-05-15: Grok Build reads `~/.claude.json` natively and
 * shows chorus under its merged MCP server list (`grok inspect` →
 * "chorus (stdio) config"). It does NOT need its own `grok mcp add`
 * call — the entry registered by the claude orchestrator is reused.
 *
 * Implications:
 *   - When the user has already run `chorus connect claude`, Grok
 *     auto-picks chorus from the same file. Zero additional config.
 *   - When the user hasn't connected claude, Grok won't see chorus.
 *     Solution: tell them to connect claude first.
 *
 * This orchestrator therefore reports `connected = true` when it
 * detects the grok binary AND chorus is present in `~/.claude.json`
 * (under either top-level `mcpServers` or any project-scoped
 * `projects.*.mcpServers`). `supported = true` so the /connect card
 * shows in the normal section. `connect()` is a no-op that just
 * tells the user to wire claude — no duplicate MCP entry needed.
 *
 * Authentication: `grok login` (browser) or `GROK_DEPLOYMENT_KEY`
 * env var. Headless `grok -p` invocation needs SuperGrok Heavy.
 * Like every other CLI, unauthenticated grok surfaces as
 * `auth_missing` at dispatch time — handled by the existing health
 * + voice auto-disable machinery, no shim-specific code needed.
 */
function hasChorusInClaudeJson(): boolean {
  const claudeJson = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(claudeJson)) return false;
  try {
    const config = JSON.parse(fs.readFileSync(claudeJson, 'utf-8')) as {
      mcpServers?: Record<string, unknown>;
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    if (config.mcpServers && 'chorus' in config.mcpServers) return true;
    for (const project of Object.values(config.projects ?? {})) {
      if (project?.mcpServers && 'chorus' in project.mcpServers) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function getGrokStatus(): OrchestratorStatus {
  const detected =
    fs.existsSync(GROK_BIN_PATH) || fs.existsSync(GROK_CONFIG_DIR);
  const connected = detected && hasChorusInClaudeJson();
  return {
    name: 'grok',
    label: 'Grok Build',
    connected,
    approvedTools: connected ? 1 : 0,
    totalTools: 1,
    note: connected
      ? 'Grok Build reads ~/.claude.json automatically — chorus is already wired via your Claude Code config. No additional setup needed.'
      : 'Grok Build picks up chorus from ~/.claude.json. Run `chorus connect claude` first; Grok will then see chorus automatically (verified via `grok inspect`).',
    supported: detected,
    firstCallBehavior: 'inherits_global',
  };
}

export const grokOrchestrator: OrchestratorDefinition = {
  name: 'grok',
  label: 'Grok Build',
  getStatus: getGrokStatus,
  detect: () =>
    fs.existsSync(GROK_BIN_PATH) || fs.existsSync(GROK_CONFIG_DIR),
  connect: async (_opts: ConnectOpts) => {
    // No-op: Grok Build auto-discovers chorus from ~/.claude.json via
    // its config merge. Tell the user to wire claude (if not already)
    // and they're done.
    if (!hasChorusInClaudeJson()) {
      throw new Error(
        'Grok Build reads chorus MCP from ~/.claude.json — but no chorus ' +
          'entry exists there yet. Run `chorus connect claude` first, then ' +
          'Grok will see chorus automatically.',
      );
    }
    return {
      registered: false,
      toolsAdded: 0,
      slashCommand: 'skipped' as const,
      full: {
        added: [],
        alreadyPresent: ['mcpServers.chorus (via ~/.claude.json)'],
        configPath: path.join(os.homedir(), '.claude.json'),
        slashCommand: 'skipped' as const,
        slashCommandPath: '',
      },
    };
  },
};
