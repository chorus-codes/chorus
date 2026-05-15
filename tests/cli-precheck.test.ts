/**
 * Pre-spawn CLI precheck regression net.
 *
 * Covers the two layers:
 *   - Quota gate: getHealth(lineage) returning quota_exhausted with a future
 *     resetAt → returns ok:false. Past resetAt or no resetAt → falls through.
 *   - Cred gate: per-lineage credential file existence. Existing+non-empty
 *     file passes; missing/empty/zero-byte fails.
 *
 * Each test isolates DB state via CHORUS_DB_PATH + _resetDbForTests, and
 * isolates HOME via process.env.HOME so the precheck reads from a tempdir
 * we control.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { _resetDbForTests, getDb } from '@/lib/db';
import { recordHealth } from '@/lib/cli-health';

// Spread `importOriginal` so other child_process exports (spawn, exec, etc.)
// keep their real implementations. A bare replacement here would silently
// break any sibling test that imports anything else from this module.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(() => { throw new Error('no keychain entry'); }),
  };
});

import { execFileSync } from 'node:child_process';
import { precheckLineage, hasKeychainEntry } from '@/lib/cli-precheck';

let dbPath: string;
let fakeHome: string;
let realHome: string | undefined;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `chorus-precheck-${randomUUID()}.db`);
  process.env.CHORUS_DB_PATH = dbPath;
  await _resetDbForTests();
  await getDb();

  realHome = process.env.HOME;
  fakeHome = path.join(os.tmpdir(), `chorus-fakehome-${randomUUID()}`);
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;

  vi.mocked(execFileSync).mockReset();
  vi.mocked(execFileSync).mockImplementation(() => { throw new Error('no keychain entry'); });
});

afterEach(async () => {
  await _resetDbForTests();
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* best-effort */ }
  }
  delete process.env.CHORUS_DB_PATH;

  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  if (realHome) process.env.HOME = realHome;
  else delete process.env.HOME;
});

/** Drop a non-empty fake credential file at the canonical path for `lineage`. */
function writeFakeCred(relPath: string, content = '{"oauth":"fake"}'): void {
  const full = path.join(fakeHome, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('precheckLineage', () => {
  describe('quota gate', () => {
    it('blocks when quota_exhausted with future resetAt', async () => {
      writeFakeCred('.claude/.credentials.json');
      await recordHealth({
        lineage: 'anthropic',
        status: 'quota_exhausted',
        resetAt: Date.now() + 60 * 60_000, // +1h
      });
      const result = await precheckLineage('anthropic');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('quota_exhausted');
        expect(result.resetAt).toBeGreaterThan(Date.now());
      }
    });

    it('falls through when quota_exhausted with past resetAt (stale marker)', async () => {
      writeFakeCred('.claude/.credentials.json');
      await recordHealth({
        lineage: 'anthropic',
        status: 'quota_exhausted',
        resetAt: Date.now() - 60_000, // 1m ago
      });
      const result = await precheckLineage('anthropic');
      expect(result.ok).toBe(true);
    });

    it('falls through when quota_exhausted has no resetAt', async () => {
      writeFakeCred('.claude/.credentials.json');
      await recordHealth({
        lineage: 'anthropic',
        status: 'quota_exhausted',
        // resetAt omitted
      });
      const result = await precheckLineage('anthropic');
      expect(result.ok).toBe(true);
    });

    it('passes when health is healthy / unknown', async () => {
      writeFakeCred('.claude/.credentials.json');
      const result = await precheckLineage('anthropic');
      expect(result.ok).toBe(true);
    });
  });

  describe('cred gate', () => {
    it('blocks when no credential file exists for the lineage', async () => {
      // No fake creds written for openai
      const result = await precheckLineage('openai');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('auth_missing');
        expect(result.cta).toMatch(/codex login/i);
      }
    });

    it('blocks when credential file is zero bytes (treated as not logged in)', async () => {
      writeFakeCred('.codex/auth.json', '');
      const result = await precheckLineage('openai');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('auth_missing');
    });

    it('passes when credential file exists for any candidate path', async () => {
      writeFakeCred('.codex/auth.json');
      const result = await precheckLineage('openai');
      expect(result.ok).toBe(true);
    });

    it('passes when fallback candidate path exists (google)', async () => {
      // Primary path does not exist, fallback at .config/gemini/oauth_creds.json does
      writeFakeCred('.config/gemini/oauth_creds.json');
      const result = await precheckLineage('google');
      expect(result.ok).toBe(true);
    });

    it('per-lineage CTA mentions the right login command', async () => {
      const cases: Array<{ lineage: 'anthropic' | 'openai' | 'google' | 'opencode' | 'moonshot'; needle: RegExp }> = [
        { lineage: 'anthropic', needle: /claude login/i },
        { lineage: 'openai', needle: /codex login/i },
        { lineage: 'google', needle: /gemini/i },
        { lineage: 'opencode', needle: /opencode/i },
        { lineage: 'moonshot', needle: /kimi|opencode/i },
      ];
      for (const c of cases) {
        const result = await precheckLineage(c.lineage);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.cta).toMatch(c.needle);
      }
    });
  });

  describe('keychain fallback (macOS)', () => {
    const mockExecFileSync = vi.mocked(execFileSync);
    let originalPlatform: string;

    beforeEach(() => {
      originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('passes when no cred file but keychain entry exists', async () => {
      mockExecFileSync.mockReturnValueOnce(Buffer.from(''));

      const result = await precheckLineage('anthropic');
      expect(result.ok).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials'],
        expect.objectContaining({ stdio: 'ignore' }),
      );
    });

    it('blocks when no cred file and no keychain entry', async () => {
      const result = await precheckLineage('anthropic');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('auth_missing');
    });

    it('skips keychain check when cred file exists', async () => {
      writeFakeCred('.claude/.credentials.json');
      const result = await precheckLineage('anthropic');
      expect(result.ok).toBe(true);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('returns false on non-darwin platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      expect(hasKeychainEntry('anthropic')).toBe(false);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('returns false for lineages without keychain service', () => {
      expect(hasKeychainEntry('openai')).toBe(false);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('issue #38: probes "Claude Code" when "Claude Code-credentials" is absent', () => {
      // Claude Code v2.1.140 uses two different Keychain services:
      //   - "Claude Code-credentials" — Pro/Max OAuth
      //   - "Claude Code" (no suffix) — API-key auth + some Console flows
      // First call (suffixed) throws, second call (suffixless) succeeds.
      mockExecFileSync
        .mockImplementationOnce(() => { throw new Error('not found'); })
        .mockReturnValueOnce(Buffer.from(''));

      expect(hasKeychainEntry('anthropic')).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
      expect(mockExecFileSync).toHaveBeenNthCalledWith(
        1,
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials'],
        expect.objectContaining({ stdio: 'ignore' }),
      );
      expect(mockExecFileSync).toHaveBeenNthCalledWith(
        2,
        'security',
        ['find-generic-password', '-s', 'Claude Code'],
        expect.objectContaining({ stdio: 'ignore' }),
      );
    });

    it('issue #38: short-circuits on first match — does not probe second service', () => {
      // If the suffixed entry exists, the suffixless probe is a waste.
      mockExecFileSync.mockReturnValueOnce(Buffer.from(''));

      expect(hasKeychainEntry('anthropic')).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    });

    it('issue #38: returns false only when BOTH services are absent', () => {
      mockExecFileSync
        .mockImplementationOnce(() => { throw new Error('not found'); })
        .mockImplementationOnce(() => { throw new Error('not found'); });

      expect(hasKeychainEntry('anthropic')).toBe(false);
      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    });
  });

  describe('grok env-var auth (GROK_CODE_XAI_API_KEY)', () => {
    let savedKey: string | undefined;

    beforeEach(() => {
      savedKey = process.env.GROK_CODE_XAI_API_KEY;
    });

    afterEach(() => {
      if (savedKey === undefined) delete process.env.GROK_CODE_XAI_API_KEY;
      else process.env.GROK_CODE_XAI_API_KEY = savedKey;
    });

    it('returns ok when GROK_CODE_XAI_API_KEY is set even without ~/.grok/auth.json', async () => {
      // No auth.json on disk — would normally fail. The env var short-
      // circuits the file probe so users on CI (where grok login can't
      // run interactively) still pass precheck.
      process.env.GROK_CODE_XAI_API_KEY = 'xai-test-key';
      const result = await precheckLineage('grok');
      expect(result.ok).toBe(true);
    });

    it('falls back to file probe when env var is unset', async () => {
      delete process.env.GROK_CODE_XAI_API_KEY;
      const result = await precheckLineage('grok');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('auth_missing');
        expect(result.cta).toMatch(/grok login|GROK_CODE_XAI_API_KEY/);
      }
    });

    it('passes precheck when ~/.grok/auth.json exists even without env var', async () => {
      delete process.env.GROK_CODE_XAI_API_KEY;
      writeFakeCred('.grok/auth.json');
      const result = await precheckLineage('grok');
      expect(result.ok).toBe(true);
    });
  });
});
