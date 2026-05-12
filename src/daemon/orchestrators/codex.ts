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

const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

function getCodexStatus(): OrchestratorStatus {
  const detected = fs.existsSync(CODEX_CONFIG_PATH);
  const connected = detected && hasCodexMcpServer();
  return {
    name: 'codex',
    label: 'Codex CLI',
    connected,
    approvedTools: connected ? 1 : 0,
    totalTools: 1,
    note: "Registers Chorus as an MCP server in ~/.codex/config.toml. Note: `codex exec` (headless mode) blocks MCP tool calls under any `approval_policy` setting except when run with `--dangerously-bypass-approvals-and-sandbox`. Interactive `codex` (TUI) prompts the user normally. See https://github.com/chorus-codes/chorus/issues/16.",
    supported: detected,
    firstCallBehavior: 'inherits_global',
  };
}

function hasCodexMcpServer(expectedBinPath?: string): boolean {
  if (!fs.existsSync(CODEX_CONFIG_PATH)) return false;
  const body = fs.readFileSync(CODEX_CONFIG_PATH, 'utf-8');
  if (!/^\[mcp_servers\.chorus\]/m.test(body)) return false;
  if (!expectedBinPath) return true;
  return body.includes(expectedBinPath);
}

/**
 * Register Chorus as an MCP server in Codex via `codex mcp add`. We shell
 * out rather than write TOML by hand so we always emit the exact format
 * Codex expects — and stay forward-compatible if it changes.
 *
 * Idempotent: skips the call when the entry already exists.
 */
async function connectCodex(
  opts: { binPath: string; daemonUrl?: string },
): Promise<ConnectResult> {
  if (hasCodexMcpServer(opts.binPath)) {
    return {
      added: [],
      alreadyPresent: ['mcp_servers.chorus'],
      configPath: CODEX_CONFIG_PATH,
      slashCommand: 'skipped',
      slashCommandPath: '',
    };
  }

  // Stale entry with a different binPath — remove it before re-add.
  if (hasCodexMcpServer()) {
    try {
      await execFileAsync('codex', ['mcp', 'remove', 'chorus'], {
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
      'codex',
      [
        'mcp',
        'add',
        'chorus',
        '--env',
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
    throw new Error(`codex mcp add failed: ${msg}`);
  }

  return {
    added: ['mcp_servers.chorus'],
    alreadyPresent: [],
    configPath: CODEX_CONFIG_PATH,
    slashCommand: 'skipped',
    slashCommandPath: '',
  };
}

export const codexOrchestrator: OrchestratorDefinition = {
  name: 'codex',
  label: 'Codex CLI',
  getStatus: getCodexStatus,
  detect: () => fs.existsSync(CODEX_CONFIG_PATH),
  connect: async (opts: ConnectOpts) => {
    const before = hasCodexMcpServer();
    const full = await connectCodex(opts);
    return { registered: !before, toolsAdded: 0, full };
  },
};
