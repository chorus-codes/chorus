/**
 * The spawn PATH (KNOWN_INSTALL_DIRS in runtime-path.ts) must include every
 * per-CLI install dir that detection probes (fallbackPaths in cli-detect.ts).
 * When the two lists drift, a CLI gets DETECTED but the daemon can't SPAWN it
 * by bare name → ENOENT.
 *
 * Concretely (#98 follow-up): native Kimi Code installs to ~/.kimi-code/bin
 * and grok to ~/.grok/bin. Both are probed by detection's fallback scan, so a
 * user who installed there without updating PATH gets a green "detected" — but
 * `runHeadless` spawns bare `kimi`/`grok`, which would fail unless the dir is
 * also on the merged spawn PATH built here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { _resetDbForTests, getDb } from '@/lib/db';
import { buildRuntimePath } from '@/lib/runtime-path';

let dbPath: string;
let fakeHome: string;
let realHome: string | undefined;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `chorus-runtime-path-${randomUUID()}.db`);
  process.env.CHORUS_DB_PATH = dbPath;
  await _resetDbForTests();
  await getDb();
  // Point os.homedir() at a throwaway dir (honoured via $HOME on POSIX) so
  // we control which per-tool install dirs "exist".
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-fakehome-'));
  realHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterEach(async () => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  await _resetDbForTests();
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* best-effort */ }
  }
  delete process.env.CHORUS_DB_PATH;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe('buildRuntimePath — per-CLI install dirs reach the spawn PATH (#98 follow-up)', () => {
  it('includes ~/.kimi-code/bin (native Kimi Code) when it exists on disk', async () => {
    const dir = path.join(fakeHome, '.kimi-code', 'bin');
    fs.mkdirSync(dir, { recursive: true });
    const merged = await buildRuntimePath();
    expect(merged.split(path.delimiter)).toContain(dir);
  });

  it('includes ~/.grok/bin (xAI grok) when it exists on disk', async () => {
    const dir = path.join(fakeHome, '.grok', 'bin');
    fs.mkdirSync(dir, { recursive: true });
    const merged = await buildRuntimePath();
    expect(merged.split(path.delimiter)).toContain(dir);
  });

  it('still includes the long-standing ~/.kimi/bin (legacy Python kimi-cli)', async () => {
    const dir = path.join(fakeHome, '.kimi', 'bin');
    fs.mkdirSync(dir, { recursive: true });
    const merged = await buildRuntimePath();
    expect(merged.split(path.delimiter)).toContain(dir);
  });

  it('omits ~/.kimi-code/bin when it does not exist (no phantom PATH entries)', async () => {
    const dir = path.join(fakeHome, '.kimi-code', 'bin');
    const merged = await buildRuntimePath();
    expect(merged.split(path.delimiter)).not.toContain(dir);
  });
});
