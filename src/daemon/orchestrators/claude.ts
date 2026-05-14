import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHORUS_TOOLS,
  DEFAULT_DAEMON_URL,
  execFileAsync,
  type ConnectOpts,
  type ConnectResult,
  type OrchestratorDefinition,
  type OrchestratorStatus,
} from './shared.js';

interface ClaudeSettings {
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
    defaultMode?: string;
    additionalDirectories?: string[];
  };
  [key: string]: unknown;
}

const CLAUDE_SETTINGS_PATH = path.join(
  os.homedir(),
  '.claude',
  'settings.local.json',
);
const CLAUDE_SLASH_COMMAND_PATH = path.join(
  os.homedir(),
  '.claude',
  'commands',
  'chorus.md',
);
const CLAUDE_PROJECT_CONFIG_PATH = path.join(os.homedir(), '.claude.json');

function readClaudeSettings(): ClaudeSettings {
  if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function getClaudeStatus(): OrchestratorStatus {
  const config = readClaudeSettings();
  const allow = new Set(config.permissions?.allow ?? []);
  const approved = CHORUS_TOOLS.filter((t) => allow.has(t)).length;
  return {
    name: 'claude',
    label: 'Claude Code',
    connected: approved === CHORUS_TOOLS.length,
    approvedTools: approved,
    totalTools: CHORUS_TOOLS.length,
    note: "Pre-approves the 7 chorus.* tools so Claude Code doesn't prompt per-tool.",
    supported: true,
    firstCallBehavior: 'auto',
  };
}

/**
 * Resolve the bundled `/chorus` slash command markdown shipped in the npm
 * package at `assets/slash-commands/chorus.md`. Works in both dist
 * (`__dirname` = `dist/daemon/orchestrators`) and dev/tsx
 * (`__dirname` = `src/daemon/orchestrators`) — both resolve to
 * `<pkg>/assets/...`.
 */
function resolveChorusSlashAsset(): string | null {
  const candidate = path.join(
    __dirname,
    '..',
    '..',
    '..',
    'assets',
    'slash-commands',
    'chorus.md',
  );
  return fs.existsSync(candidate) ? candidate : null;
}

function installChorusSlashCommand(): ConnectResult['slashCommand'] {
  const source = resolveChorusSlashAsset();
  if (!source) return 'skipped';
  const desired = fs.readFileSync(source, 'utf-8');

  if (fs.existsSync(CLAUDE_SLASH_COMMAND_PATH)) {
    const current = fs.readFileSync(CLAUDE_SLASH_COMMAND_PATH, 'utf-8');
    if (current === desired) return 'unchanged';
    fs.writeFileSync(CLAUDE_SLASH_COMMAND_PATH, desired, 'utf-8');
    return 'updated';
  }

  fs.mkdirSync(path.dirname(CLAUDE_SLASH_COMMAND_PATH), { recursive: true });
  fs.writeFileSync(CLAUDE_SLASH_COMMAND_PATH, desired, 'utf-8');
  return 'installed';
}

/**
 * Patch Claude Code's local settings to whitelist all 7 Chorus MCP tools, and
 * drop the `/chorus` slash command into `~/.claude/commands/`. Idempotent.
 */
async function connectClaude(): Promise<ConnectResult> {
  const config = readClaudeSettings();
  const permissions = (config.permissions ?? {}) as NonNullable<
    ClaudeSettings['permissions']
  >;
  const existing = new Set(permissions.allow ?? []);

  const added: string[] = [];
  const alreadyPresent: string[] = [];
  for (const tool of CHORUS_TOOLS) {
    if (existing.has(tool)) {
      alreadyPresent.push(tool);
    } else {
      existing.add(tool);
      added.push(tool);
    }
  }

  if (added.length > 0) {
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
    const next: ClaudeSettings = {
      ...config,
      permissions: {
        ...permissions,
        allow: Array.from(existing).sort(),
      },
    };
    fs.writeFileSync(
      CLAUDE_SETTINGS_PATH,
      JSON.stringify(next, null, 2) + '\n',
      'utf-8',
    );
  }

  const slashCommand = installChorusSlashCommand();

  return {
    added,
    alreadyPresent,
    configPath: CLAUDE_SETTINGS_PATH,
    slashCommand,
    slashCommandPath: CLAUDE_SLASH_COMMAND_PATH,
  };
}

function readUserScopeChorusEntry(): { binPath: string } | null {
  const configPath = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      mcpServers?: Record<string, { args?: unknown }>;
    };
    const chorus = config.mcpServers?.chorus;
    if (!chorus || !Array.isArray(chorus.args)) return null;
    const binPath = chorus.args[0];
    return typeof binPath === 'string' ? { binPath } : null;
  } catch {
    return null;
  }
}

export async function registerClaudeMcpServer(opts: {
  binPath: string;
  daemonUrl?: string;
}): Promise<{ added: boolean }> {
  const existing = readUserScopeChorusEntry();
  if (existing && existing.binPath === opts.binPath) {
    return { added: false };
  }

  const execOpts = {
    timeout: 30_000,
    shell: process.platform === 'win32',
  };

  if (existing) {
    try {
      await execFileAsync(
        'claude',
        ['mcp', 'remove', 'chorus', '--scope', 'user'],
        execOpts,
      );
    } catch {
      /* best-effort */
    }
  }

  const daemonUrl = opts.daemonUrl ?? DEFAULT_DAEMON_URL;
  try {
    await execFileAsync(
      'claude',
      [
        'mcp',
        'add',
        'chorus',
        '--scope',
        'user',
        '--env',
        `CHORUS_DAEMON_URL=${daemonUrl}`,
        '--',
        'node',
        opts.binPath,
        'mcp',
      ],
      execOpts,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `claude mcp add failed: ${msg}\n` +
        `(if your Claude Code is older than ~v1.0, it may not support ` +
        `'mcp add --scope user' — upgrade Claude Code and retry)`,
    );
  }

  return { added: true };
}

export const claudeOrchestrator: OrchestratorDefinition = {
  name: 'claude',
  label: 'Claude Code',
  getStatus: getClaudeStatus,
  detect: () => fs.existsSync(CLAUDE_PROJECT_CONFIG_PATH),
  connect: async (opts: ConnectOpts) => {
    const reg = await registerClaudeMcpServer(opts);
    const conn = await connectClaude();
    return {
      registered: reg.added,
      toolsAdded: conn.added.length,
      slashCommand: conn.slashCommand,
      full: conn,
    };
  },
};
