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

const KIMI_CONFIG_DIR = path.join(os.homedir(), '.kimi');
const KIMI_MCP_PATH = path.join(KIMI_CONFIG_DIR, 'mcp.json');

function getKimiStatus(): OrchestratorStatus {
  const detected = fs.existsSync(KIMI_CONFIG_DIR);
  const connected = detected && hasKimiMcpServer();
  return {
    name: 'kimi',
    label: 'Kimi CLI',
    connected,
    approvedTools: connected ? 1 : 0,
    totalTools: 1,
    note: 'Registers Chorus as an MCP server in ~/.kimi/mcp.json. Kimi may show a one-time prompt before the first tool call — click Always allow.',
    supported: detected,
    firstCallBehavior: 'prompts_once',
  };
}

function hasKimiMcpServer(expectedBinPath?: string): boolean {
  if (!fs.existsSync(KIMI_MCP_PATH)) return false;
  try {
    const body = JSON.parse(fs.readFileSync(KIMI_MCP_PATH, 'utf-8')) as Record<
      string,
      unknown
    >;
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
 * Register Chorus with Kimi CLI via `kimi mcp add`. Same JSON shape as
 * Gemini (mcpServers.<name>) but stored in ~/.kimi/mcp.json. Idempotent
 * + path-aware: re-registers if binPath drifted.
 */
async function connectKimi(
  opts: { binPath: string; daemonUrl?: string },
): Promise<ConnectResult> {
  if (hasKimiMcpServer(opts.binPath)) {
    return {
      added: [],
      alreadyPresent: ['mcpServers.chorus'],
      configPath: KIMI_MCP_PATH,
      slashCommand: 'skipped',
      slashCommandPath: '',
    };
  }

  if (hasKimiMcpServer()) {
    try {
      await execFileAsync('kimi', ['mcp', 'remove', 'chorus'], {
        timeout: 30_000,
        shell: process.platform === 'win32',
      });
    } catch {
      /* best-effort */
    }
  }

  const daemonUrl = opts.daemonUrl ?? DEFAULT_DAEMON_URL;
  try {
    await execFileAsync(
      'kimi',
      [
        'mcp',
        'add',
        '--transport',
        'stdio',
        'chorus',
        '-e',
        `CHORUS_DAEMON_URL=${daemonUrl}`,
        '--',
        'node',
        opts.binPath,
        'mcp',
      ],
      {
        timeout: 30_000,
        shell: process.platform === 'win32',
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`kimi mcp add failed: ${msg}`);
  }

  return {
    added: ['mcpServers.chorus'],
    alreadyPresent: [],
    configPath: KIMI_MCP_PATH,
    slashCommand: 'skipped',
    slashCommandPath: '',
  };
}

export const kimiOrchestrator: OrchestratorDefinition = {
  name: 'kimi',
  label: 'Kimi CLI',
  getStatus: getKimiStatus,
  detect: () => fs.existsSync(KIMI_CONFIG_DIR),
  connect: async (opts: ConnectOpts) => {
    const before = hasKimiMcpServer(opts.binPath);
    const full = await connectKimi(opts);
    return { registered: !before, toolsAdded: 0, full };
  },
};
