/**
 * Regression tests for preTrustCodexWorkspace — specifically the Windows
 * path-normalization fix that prevents corrupting `~/.codex/config.toml`.
 *
 * Bug being pinned: TOML basic strings (double-quoted) interpret `\U` and
 * `\u` as Unicode escapes. Windows paths like `C:\Users\...` would write a
 * literal `[projects."C:\Users\..."]` block, then codex CLI would fail to
 * parse its own config on every subsequent invocation. Fix normalizes `\`
 * to `/` before writing the marker.
 *
 * These tests use a real tempdir per case (not mocked fs) so the assertion
 * exercises the same write path codex parses at runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { preTrustCodexWorkspace } from '../src/daemon/agents/preflight';

let codexHome: string;

beforeEach(() => {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-codex-home-'));
});

afterEach(() => {
  fs.rmSync(codexHome, { recursive: true, force: true });
});

const readConfig = (): string =>
  fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf-8');

describe('preTrustCodexWorkspace — path normalization', () => {
  it('normalizes a Windows path with \\Users to forward slashes', () => {
    const cwd = 'C:\\Users\\foo\\bar';
    preTrustCodexWorkspace(codexHome, cwd);
    const body = readConfig();
    expect(body).toContain('[projects."C:/Users/foo/bar"]');
    expect(body).not.toContain('\\Users'); // no escape-trap survives
    expect(body).toContain('trust_level = "trusted"');
  });

  it('normalizes a path with \\u (4-char unicode escape trap)', () => {
    const cwd = 'D:\\users\\test';
    preTrustCodexWorkspace(codexHome, cwd);
    const body = readConfig();
    expect(body).toContain('[projects."D:/users/test"]');
    expect(body).not.toMatch(/\\u/);
  });

  it('normalizes the realistic chorus reviewer cwd that triggered the bug', () => {
    const cwd = 'C:\\Users\\Administrator\\.chorus\\chats\\019E0D\\round-1\\reviewer-codex-cli-0';
    preTrustCodexWorkspace(codexHome, cwd);
    const body = readConfig();
    expect(body).toContain(
      '[projects."C:/Users/Administrator/.chorus/chats/019E0D/round-1/reviewer-codex-cli-0"]',
    );
  });

  it('leaves a Unix path unchanged (no backslashes in the marker)', () => {
    const cwd = '/home/foo/bar';
    preTrustCodexWorkspace(codexHome, cwd);
    const body = readConfig();
    expect(body).toContain('[projects."/home/foo/bar"]');
    expect(body).not.toContain('\\');
  });

  it('is idempotent: invoking twice with the same cwd does not duplicate the block', () => {
    const cwd = 'C:\\Users\\foo';
    preTrustCodexWorkspace(codexHome, cwd);
    preTrustCodexWorkspace(codexHome, cwd);
    const body = readConfig();
    const matches = body.match(/\[projects\."C:\/Users\/foo"\]/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('is idempotent across mixed-separator inputs that normalize to the same path', () => {
    // Both inputs collapse to "C:/Users/foo" after replace(/\\/g, '/'), so
    // the second call must be a no-op even though the literal cwds differ.
    preTrustCodexWorkspace(codexHome, 'C:\\Users\\foo');
    preTrustCodexWorkspace(codexHome, 'C:/Users/foo');
    const body = readConfig();
    const matches = body.match(/\[projects\."C:\/Users\/foo"\]/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('appends to an existing config.toml without disturbing prior content', () => {
    const configPath = path.join(codexHome, 'config.toml');
    const prior = '[a]\nb = 1\n';
    fs.writeFileSync(configPath, prior, 'utf-8');

    preTrustCodexWorkspace(codexHome, 'C:\\Users\\foo');
    const body = readConfig();
    expect(body.startsWith(prior)).toBe(true);
    expect(body).toContain('[projects."C:/Users/foo"]');
    expect(body).toContain('trust_level = "trusted"');
  });

  it('creates the codex home directory when it does not yet exist', () => {
    const fresh = path.join(codexHome, 'nested', 'codex');
    expect(fs.existsSync(fresh)).toBe(false);
    preTrustCodexWorkspace(fresh, 'C:\\Users\\foo');
    expect(fs.existsSync(path.join(fresh, 'config.toml'))).toBe(true);
  });
});
