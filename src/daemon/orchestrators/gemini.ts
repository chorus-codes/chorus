import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_DAEMON_URL,
  execFileAsync,
  type ConnectOpts,
  type ConnectResult,
  type OrchestratorDefinition,
  type OrchestratorStatus,
} from './shared.js';

const GEMINI_SETTINGS_PATH = path.join(
  os.homedir(),
  '.gemini',
  'settings.json',
);

function getGeminiStatus(): OrchestratorStatus {
  const detected = fs.existsSync(GEMINI_SETTINGS_PATH);
  const connected = detected && hasGeminiMcpServer();
  return {
    name: 'gemini',
    label: 'Gemini CLI',
    connected,
    approvedTools: connected ? 1 : 0,
    totalTools: 1,
    note: "Registers Chorus as a user-scope MCP server in ~/.gemini/settings.json with --trust set so calls don't prompt.",
    supported: detected,
    firstCallBehavior: 'auto',
  };
}

function hasGeminiMcpServer(expectedBinPath?: string): boolean {
  if (!fs.existsSync(GEMINI_SETTINGS_PATH)) return false;
  try {
    const body = JSON.parse(
      fs.readFileSync(GEMINI_SETTINGS_PATH, 'utf-8'),
    ) as Record<string, unknown>;
    const servers = body.mcpServers as Record<string, unknown> | undefined;
    const chorus = servers?.chorus as { args?: string[] } | undefined;
    if (!chorus) return false;
    if (!expectedBinPath) return true;
    return Array.isArray(chorus.args) && chorus.args.includes(expectedBinPath);
  } catch {
    return false;
  }
}

/**
 * Register Chorus with Gemini CLI. `gemini mcp add` writes to
 * ~/.gemini/settings.json (or per-project) for us — we use --scope user
 * to make it global. Idempotent: skips when already present.
 */
async function connectGemini(
  opts: { binPath: string; daemonUrl?: string },
): Promise<ConnectResult> {
  if (hasGeminiMcpServer(opts.binPath)) {
    return {
      added: [],
      alreadyPresent: ['mcpServers.chorus'],
      configPath: GEMINI_SETTINGS_PATH,
      slashCommand: 'skipped',
      slashCommandPath: '',
    };
  }

  // Stale entry with different binPath — remove (user-scope) before re-add.
  if (hasGeminiMcpServer()) {
    try {
      await execFileAsync(
        'gemini',
        ['mcp', 'remove', 'chorus', '-s', 'user'],
        {
        timeout: 30_000,
        shell: process.platform === 'win32',
      },
      );
    } catch {
      /* best-effort */
    }
  }

  const daemonUrl = opts.daemonUrl ?? DEFAULT_DAEMON_URL;
  try {
    await execFileAsync(
      'gemini',
      [
        'mcp',
        'add',
        'chorus',
        'node',
        opts.binPath,
        'mcp',
        '-e',
        `CHORUS_DAEMON_URL=${daemonUrl}`,
        '-s',
        'user',
        '-t',
        'stdio',
        '--trust',
      ],
      {
        timeout: 30_000,
        shell: process.platform === 'win32',
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`gemini mcp add failed: ${msg}`);
  }

  return {
    added: ['mcpServers.chorus'],
    alreadyPresent: [],
    configPath: GEMINI_SETTINGS_PATH,
    slashCommand: 'skipped',
    slashCommandPath: '',
  };
}

export const geminiOrchestrator: OrchestratorDefinition = {
  name: 'gemini',
  label: 'Gemini CLI',
  getStatus: getGeminiStatus,
  detect: () => fs.existsSync(GEMINI_SETTINGS_PATH),
  connect: async (opts: ConnectOpts) => {
    const before = hasGeminiMcpServer();
    const full = await connectGemini(opts);
    return { registered: !before, toolsAdded: 0, full };
  },
};
