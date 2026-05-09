/**
 * `chorus connect [orchestrator]` — wire Chorus into a CLI's MCP config so
 * the user can call chorus.* tools from inside it. Removes the per-tool
 * "Yes, allow for this project?" friction (Claude) or registers the MCP
 * server (Codex/Gemini/OpenCode) which they don't have until we add it.
 *
 * Idempotent. Same logic exposed at daemon `POST /orchestrators/:name/connect`
 * so the cockpit's /connect page can run it with one click.
 *
 * Usage:
 *   chorus connect              # all detected CLIs
 *   chorus connect claude       # just Claude Code
 *   chorus connect codex,gemini # comma-separated subset
 */

import path from 'node:path';
import {
  autoConnectAll,
  CHORUS_TOOLS,
  listOrchestrators,
  type OrchestratorName,
} from '../daemon/orchestrators/index.js';

const CHORUS_BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'chorus.mjs');

const ALL_NAMES = ['claude', 'codex', 'gemini', 'opencode', 'kimi', 'cursor', 'windsurf'] as const;

function parseTargets(arg: string | undefined): OrchestratorName[] | null {
  if (!arg) return null; // null = "all detected"
  const wanted = arg.split(',').map((s) => s.trim().toLowerCase());
  const valid: OrchestratorName[] = [];
  for (const w of wanted) {
    if ((ALL_NAMES as readonly string[]).includes(w)) {
      valid.push(w as OrchestratorName);
    } else {
      console.error(`Unknown orchestrator: '${w}'. Valid: ${ALL_NAMES.join(', ')}`);
      process.exit(1);
    }
  }
  return valid;
}

export async function runConnect(orchestrator?: string): Promise<void> {
  const only = parseTargets(orchestrator);
  const binPath = CHORUS_BIN_PATH;

  console.log(`Connecting Chorus${only ? ` to: ${only.join(', ')}` : ''}...`);
  console.log('');

  try {
    const result = await autoConnectAll({
      binPath,
      ...(only && only.length > 0 ? { only } : {}),
    });

    const statuses = listOrchestrators();
    const promptsOnce: string[] = [];
    const inheritsGlobal: string[] = [];
    let codexConnected = false;

    for (const step of result.steps) {
      if (!step.detected) {
        console.log(`  ✗ ${step.label}: not detected on this machine`);
        continue;
      }
      if (step.error) {
        console.log(`  ! ${step.label}: ${step.error}`);
        continue;
      }
      const parts: string[] = [];
      if (step.registered) parts.push('MCP server registered');
      else parts.push('MCP already registered');
      if (step.toolsAdded > 0) parts.push(`${step.toolsAdded} tool(s) approved`);
      else if (step.name === 'claude') parts.push(`all ${CHORUS_TOOLS.length} tools already approved`);
      if (step.slashCommand === 'installed') parts.push('/chorus command installed');
      else if (step.slashCommand === 'updated') parts.push('/chorus command updated');
      console.log(`  ✓ ${step.label}: ${parts.join(' · ')}`);

      const status = statuses.find((s) => s.name === step.name);
      if (status?.firstCallBehavior === 'prompts_once') promptsOnce.push(step.label);
      if (status?.firstCallBehavior === 'inherits_global') inheritsGlobal.push(step.label);
      if (step.name === 'codex' && !step.error) codexConnected = true;
    }

    if (!result.anyConnected) {
      console.log('');
      console.log('No supported CLIs detected. Install Claude Code, Codex, Gemini, OpenCode, Kimi, Cursor, or Windsurf then retry.');
      return;
    }

    console.log('');
    console.log('Restart any CLI you just connected so it picks up the new MCP server.');
    console.log('Inside the CLI: try `/chorus bug-diagnose <paste a snippet>` (Claude) or');
    console.log('say `chorus, run bug-diagnose on <snippet>` (any other CLI).');

    if (promptsOnce.length > 0) {
      console.log('');
      console.log(`Heads up: ${promptsOnce.join(', ')} will show a one-time permission prompt`);
      console.log('on your first chorus.* tool call. Click "Always allow" to make it stick.');
    }
    if (inheritsGlobal.length > 0) {
      console.log('');
      console.log(`${inheritsGlobal.join(', ')} use a global approval policy — whether tool calls`);
      console.log('prompt depends on your existing config (we don\'t override it).');
    }
    if (codexConnected) {
      console.log('');
      console.log('Codex headless note: `codex exec` blocks all MCP tool calls under any');
      console.log('approval_policy except `--dangerously-bypass-approvals-and-sandbox`.');
      console.log('Interactive `codex` (TUI) prompts normally and works fine. Use the bypass');
      console.log('flag for scripted/CI usage. See https://github.com/chorus-codes/chorus/issues/16.');
    }
  } catch (err) {
    console.error(
      `\nFailed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
