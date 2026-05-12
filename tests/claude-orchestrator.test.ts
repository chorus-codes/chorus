import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn(
      (
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, '', '');
      },
    ),
  };
});

import { execFile } from 'node:child_process';
import { registerClaudeMcpServer } from '@/daemon/orchestrators/claude';

let fakeHome: string;
let realHome: string | undefined;

beforeEach(() => {
  realHome = process.env.HOME;
  fakeHome = path.join(os.tmpdir(), `chorus-claude-orch-${randomUUID()}`);
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
  vi.mocked(execFile).mockClear();
});

afterEach(() => {
  try {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  if (realHome) process.env.HOME = realHome;
  else delete process.env.HOME;
});

function writeClaudeConfig(body: unknown): void {
  fs.writeFileSync(
    path.join(fakeHome, '.claude.json'),
    JSON.stringify(body, null, 2),
  );
}

function execFileCalls(): { cmd: string; args: readonly string[] }[] {
  return vi.mocked(execFile).mock.calls.map((c) => ({
    cmd: c[0] as string,
    args: c[1] as readonly string[],
  }));
}

describe('registerClaudeMcpServer', () => {
  it('shells out to `claude mcp add --scope user` on a fresh install', async () => {
    const result = await registerClaudeMcpServer({
      binPath: '/usr/local/lib/node_modules/chorus-codes/bin/chorus.mjs',
      daemonUrl: 'http://127.0.0.1:7707',
    });

    expect(result).toEqual({ added: true });

    const calls = execFileCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('claude');
    expect(calls[0].args).toEqual([
      'mcp',
      'add',
      'chorus',
      '--scope',
      'user',
      '--env',
      'CHORUS_DAEMON_URL=http://127.0.0.1:7707',
      '--',
      'node',
      '/usr/local/lib/node_modules/chorus-codes/bin/chorus.mjs',
      'mcp',
    ]);
  });

  it('never writes chorus under projects.<dir>.mcpServers', async () => {
    await registerClaudeMcpServer({ binPath: '/somewhere/chorus.mjs' });

    const claudeJsonPath = path.join(fakeHome, '.claude.json');
    if (fs.existsSync(claudeJsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')) as {
        projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
      };
      const anyProjectHasChorus = Object.values(parsed.projects ?? {}).some(
        (p) => p.mcpServers && 'chorus' in p.mcpServers,
      );
      expect(anyProjectHasChorus).toBe(false);
    }
  });

  it('is idempotent when the user-scope entry already points at the same binPath', async () => {
    writeClaudeConfig({
      mcpServers: {
        chorus: {
          command: 'node',
          args: ['/path/to/chorus.mjs', 'mcp'],
          env: { CHORUS_DAEMON_URL: 'http://127.0.0.1:7707' },
        },
      },
    });

    const result = await registerClaudeMcpServer({
      binPath: '/path/to/chorus.mjs',
    });

    expect(result).toEqual({ added: false });
    expect(execFileCalls()).toHaveLength(0);
  });

  it('removes a stale entry (different binPath) before re-adding', async () => {
    writeClaudeConfig({
      mcpServers: {
        chorus: {
          command: 'node',
          args: ['/old/path/to/chorus.mjs', 'mcp'],
        },
      },
    });

    const result = await registerClaudeMcpServer({
      binPath: '/new/path/to/chorus.mjs',
    });

    expect(result).toEqual({ added: true });

    const calls = execFileCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].args.slice(0, 5)).toEqual([
      'mcp',
      'remove',
      'chorus',
      '--scope',
      'user',
    ]);
    expect(calls[1].args.slice(0, 5)).toEqual([
      'mcp',
      'add',
      'chorus',
      '--scope',
      'user',
    ]);
  });

  it('ignores a legacy entry under projects.<dir>.mcpServers', async () => {
    writeClaudeConfig({
      projects: {
        [fakeHome]: {
          mcpServers: {
            chorus: {
              command: 'node',
              args: ['/stale/legacy/chorus.mjs', 'mcp'],
            },
          },
        },
      },
    });

    const result = await registerClaudeMcpServer({
      binPath: '/new/chorus.mjs',
    });

    expect(result).toEqual({ added: true });
    const calls = execFileCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args[1]).toBe('add');
  });

  it('throws a helpful error when `claude mcp add` fails', async () => {
    vi.mocked(execFile).mockImplementationOnce(
      ((
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        cb(new Error('claude: command not found'), '', '');
      }) as never,
    );

    await expect(
      registerClaudeMcpServer({ binPath: '/x/chorus.mjs' }),
    ).rejects.toThrow(/claude mcp add failed/);
  });
});
