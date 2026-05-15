/**
 * Orchestrator integrations: pre-approve Chorus's MCP tools in
 * third-party editors / CLIs so users don't get prompted on every tool
 * call. Same logic the `chorus connect` CLI uses, exposed via daemon
 * HTTP so the cockpit's /connect page can do it with one click.
 */

import { claudeOrchestrator, registerClaudeMcpServer } from './claude.js';
import { codexOrchestrator } from './codex.js';
import {
  cursorOrchestrator,
  windsurfOrchestrator,
} from './cursor-windsurf.js';
import { geminiOrchestrator } from './gemini.js';
import { grokOrchestrator } from './grok.js';
import { kimiOrchestrator } from './kimi.js';
import { opencodeOrchestrator } from './opencode.js';
import type {
  AutoConnectResult,
  AutoConnectStep,
  ConnectResult,
  OrchestratorDefinition,
  OrchestratorName,
  OrchestratorStatus,
} from './shared.js';

export {
  CHORUS_TOOLS,
  type AutoConnectResult,
  type AutoConnectStep,
  type ConnectResult,
  type OrchestratorName,
  type OrchestratorStatus,
} from './shared.js';

const ORCHESTRATORS: OrchestratorDefinition[] = [
  claudeOrchestrator,
  codexOrchestrator,
  geminiOrchestrator,
  opencodeOrchestrator,
  kimiOrchestrator,
  grokOrchestrator,
  cursorOrchestrator,
  windsurfOrchestrator,
];

export function listOrchestrators(): OrchestratorStatus[] {
  return ORCHESTRATORS.map((o) => o.getStatus());
}

export async function connectByName(
  name: string,
  opts: { binPath: string; daemonUrl?: string } = { binPath: '' },
): Promise<ConnectResult> {
  const def = ORCHESTRATORS.find((o) => o.name === name);
  if (!def) throw new Error(`Unknown orchestrator '${name}'.`);
  if (def.name === 'claude') await registerClaudeMcpServer(opts);
  const result = await def.connect(opts);
  return result.full;
}

/**
 * Detect every CLI we know about and connect to all that are present.
 * Pass `only` to limit to a subset (e.g. ['claude', 'gemini']).
 */
export async function autoConnectAll(opts: {
  binPath: string;
  projectDir?: string;
  daemonUrl?: string;
  only?: OrchestratorName[];
}): Promise<AutoConnectResult> {
  const steps: AutoConnectStep[] = [];
  const allowed = opts.only ? new Set(opts.only) : null;

  for (const def of ORCHESTRATORS) {
    if (allowed && !allowed.has(def.name)) continue;

    if (!def.detect()) {
      steps.push({
        name: def.name,
        label: def.label,
        detected: false,
        registered: false,
        toolsAdded: 0,
      });
      continue;
    }

    try {
      const result = await def.connect(opts);
      steps.push({
        name: def.name,
        label: def.label,
        detected: true,
        registered: result.registered,
        toolsAdded: result.toolsAdded,
        slashCommand: result.slashCommand,
      });
    } catch (err) {
      steps.push({
        name: def.name,
        label: def.label,
        detected: true,
        registered: false,
        toolsAdded: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const anyConnected = steps.some(
    (s) => s.detected && !s.unsupported && !s.error,
  );
  return { steps, anyConnected };
}

