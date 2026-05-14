import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createChat } from '@/mcp/tools';

let fakeHome: string;
let realHome: string | undefined;
let realCwd: string;
let fakeCwd: string;
let realDaemonUrl: string | undefined;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  realHome = process.env.HOME;
  realDaemonUrl = process.env.CHORUS_DAEMON_URL;
  realCwd = process.cwd();

  fakeHome = path.join(os.tmpdir(), `chorus-mcp-${randomUUID()}`);
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
  process.env.CHORUS_DAEMON_URL = 'http://chorus-test.invalid:7707';

  fakeCwd = path.join(os.tmpdir(), `chorus-cwd-${randomUUID()}`);
  fs.mkdirSync(fakeCwd, { recursive: true });
  process.chdir(fakeCwd);

  fetchSpy = vi.fn(async () =>
    new Response(
      JSON.stringify({
        ok: true,
        data: {
          id: 'chat_test',
          status: 'queued',
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.chdir(realCwd);
  try {
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(fakeCwd, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  if (realHome) process.env.HOME = realHome;
  else delete process.env.HOME;
  if (realDaemonUrl) process.env.CHORUS_DAEMON_URL = realDaemonUrl;
  else delete process.env.CHORUS_DAEMON_URL;
});

function bodyOf(call: 0 | number = 0): Record<string, unknown> {
  const init = fetchSpy.mock.calls[call][1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe('createChat', () => {
  it('forwards the explicit repoPath when the caller passes one', async () => {
    await createChat({
      work: 'review this',
      templateId: 'code-review',
      repoPath: '/abs/path/to/repo',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(bodyOf().repoPath).toBe('/abs/path/to/repo');
  });

  it("defaults repoPath to process.cwd() when the caller omits it", async () => {
    await createChat({ work: 'review this', templateId: 'code-review' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const cwdReal = fs.realpathSync(fakeCwd);
    const sentReal = fs.realpathSync(bodyOf().repoPath as string);
    expect(sentReal).toBe(cwdReal);
  });

  it('still forwards work, templateId, files, and artifact', async () => {
    await createChat({
      work: 'review this',
      templateId: 'review-only',
      files: ['src/foo.ts', 'src/bar.ts'],
      artifact: 'diff body here',
    });

    const body = bodyOf();
    expect(body.work).toBe('review this');
    expect(body.templateId).toBe('review-only');
    expect(body.files).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(body.artifact).toBe('diff body here');
  });

  it('falls back to homedir when process.cwd() throws ENOENT', async () => {
    // Simulate a deleted cwd. process.cwd() throws on Linux when the
    // dir backing the process is unlink-then-rmdir'd. We can't reliably
    // delete fakeCwd while the process holds it as cwd, so spy directly.
    const cwdSpy = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    try {
      await createChat({ work: 'review this', templateId: 'code-review' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(bodyOf().repoPath).toBe(os.homedir());
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
