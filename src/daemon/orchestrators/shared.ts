/**
 * Cross-orchestrator constants, types, and small JSON helpers reused by
 * Cursor + Windsurf (they share the `{ mcpServers: ... }` JSON shape).
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

export const execFileAsync = promisify(execFile);

export const CHORUS_TOOLS = [
  'mcp__chorus__create_chat',
  'mcp__chorus__wait_for_chat',
  'mcp__chorus__get_chat_status',
  'mcp__chorus__list_blocked',
  'mcp__chorus__resume_chat',
  'mcp__chorus__cancel_chat',
  'mcp__chorus__list_templates',
];

export type OrchestratorName =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'kimi'
  | 'grok'
  | 'cursor'
  | 'windsurf';

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7707';

export interface OrchestratorStatus {
  name: OrchestratorName;
  label: string;
  /** True when Chorus's MCP tools are pre-approved (all of them). */
  connected: boolean;
  /** How many of CHORUS_TOOLS are pre-approved right now. */
  approvedTools: number;
  /** Total expected (always CHORUS_TOOLS.length for now). */
  totalTools: number;
  /** Human note for "what does connecting do?" UX copy. */
  note: string;
  /** False = we know how to detect/connect; true = stub for future. */
  supported: boolean;
  /**
   * What happens the first time the user calls a chorus.* tool from
   * inside this CLI?
   *
   * - `auto`: tools fire without any prompt (we've pre-approved them).
   * - `prompts_once`: CLI shows a one-time prompt; user clicks "Always
   *   allow" and the prompt is gone forever. We don't have a
   *   config-file way to skip this for these CLIs.
   * - `inherits_global`: depends on the user's broader CLI config (e.g.
   *   Codex's `approval_policy`). We don't override their setting.
   */
  firstCallBehavior: 'auto' | 'prompts_once' | 'inherits_global';
}

export interface ConnectResult {
  added: string[];
  alreadyPresent: string[];
  configPath: string;
  /**
   * State of the `/chorus` slash command in `~/.claude/commands/chorus.md`.
   *   - `installed` = file did not exist, we wrote it
   *   - `updated`   = file existed with stale contents, we overwrote it
   *   - `unchanged` = file already matched the current asset
   *   - `skipped`   = source asset not found, or this CLI doesn't carry one
   */
  slashCommand: 'installed' | 'updated' | 'unchanged' | 'skipped';
  slashCommandPath: string;
}

export interface AutoConnectStep {
  name: OrchestratorName;
  label: string;
  /** Was this CLI's config file present on disk? */
  detected: boolean;
  /** Did we add a new MCP server entry? (false if already registered) */
  registered: boolean;
  /** How many tools were added to the allow-list (0 if all were already there) */
  toolsAdded: number;
  /** State of the `/chorus` slash command for this CLI (claude only for v0.5) */
  slashCommand?: ConnectResult['slashCommand'];
  /** True if the CLI was detected but Chorus doesn't know how to wire it yet */
  unsupported?: boolean;
  /** Surfaced when something failed */
  error?: string;
}

export interface AutoConnectResult {
  steps: AutoConnectStep[];
  /** Did we touch at least one CLI? */
  anyConnected: boolean;
}

/** Definition of a per-orchestrator integration registered with the registry. */
export interface OrchestratorDefinition {
  name: OrchestratorName;
  label: string;
  /** Status used by `/connect` page rendering. */
  getStatus: () => OrchestratorStatus;
  /** True if this CLI is installed (config file/dir exists). */
  detect: () => boolean;
  /** Called from `connectByName` and `autoConnectAll`. */
  connect: (opts: ConnectOpts) => Promise<{
    /** True if a NEW MCP entry was added (false when already present). */
    registered: boolean;
    /** Tools added to the allow-list. Always 0 for non-Claude CLIs. */
    toolsAdded: number;
    /** Only Claude installs the `/chorus` slash command. */
    slashCommand?: ConnectResult['slashCommand'];
    /** Full result for `connectByName` callers. */
    full: ConnectResult;
  }>;
}

export interface ConnectOpts {
  binPath: string;
  projectDir?: string;
  daemonUrl?: string;
}

// ─── McpJson helpers ─────────────────────────────────────────────────────
// Cursor + Windsurf share an identical `{ mcpServers: { ... } }` JSON shape
// with no companion CLI; we patch directly. Gemini + Kimi also use this
// shape but go through their respective `mcp add` CLIs.

export interface McpJsonShape {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function readJsonOrEmpty(filePath: string): McpJsonShape {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as McpJsonShape;
  } catch {
    return {};
  }
}

export function hasMcpEntry(filePath: string, expectedBinPath?: string): boolean {
  const cfg = readJsonOrEmpty(filePath);
  const chorus = (cfg.mcpServers as Record<string, { args?: string[] }> | undefined)
    ?.chorus;
  if (!chorus) return false;
  if (!expectedBinPath) return true;
  return Array.isArray(chorus.args) && chorus.args.includes(expectedBinPath);
}

export function writeMcpEntry(opts: {
  filePath: string;
  binPath: string;
  daemonUrl: string;
}): void {
  const cfg = readJsonOrEmpty(opts.filePath);
  const servers = (cfg.mcpServers ?? {}) as Record<string, unknown>;
  servers.chorus = {
    command: 'node',
    args: [opts.binPath, 'mcp'],
    env: { CHORUS_DAEMON_URL: opts.daemonUrl },
  };
  const next: McpJsonShape = { ...cfg, mcpServers: servers };
  fs.mkdirSync(path.dirname(opts.filePath), { recursive: true });
  fs.writeFileSync(opts.filePath, JSON.stringify(next, null, 2) + '\n', 'utf-8');
}
