/**
 * resolveCliBinaryPath — spawn the binary detection verified (issue #104).
 *
 * Detection (`detectAllClis`) resolves a concrete absolute path: PATH lookup
 * (`which`/`where`) → fallback-dir scan → manual override. Headless spawns,
 * however, used the BARE name and re-resolved against the daemon's PATH. The
 * two could disagree:
 *   - ENOENT: a CLI found only via the fallback-dir scan (its dir not on the
 *     spawn PATH) can't be spawned by bare name.
 *   - shadowing: two same-named binaries (e.g. ~/.kimi/bin/kimi and
 *     ~/.kimi-code/bin/kimi) — bare-name spawn may run a different build than
 *     detection resolved.
 *
 * resolveCliBinaryPath closes that gap by mapping a bare CLI name back to the
 * absolute path detection already chose. These tests drive REAL detection
 * (staged executables on a prepended PATH) so they fail if the reverse map or
 * the found-predicate regresses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  resolveCliBinaryPath,
  detectAllClis,
  clearDetectionCache,
} from '../src/lib/cli-detect.js';

// Mirrors BINARY_NAME in cli-detect.ts. Duplicated intentionally: a rename of
// a detection binary is a deliberate change that should make this test fail.
const BINARY_NAME: Record<string, string> = {
  'claude-code': 'claude',
  'codex-cli': 'codex',
  'gemini-cli': 'gemini',
  'opencode-cli': 'opencode',
  'kimi-cli': 'kimi',
  'grok-cli': 'grok',
  'antigravity-cli': 'agy',
};

let tmpRoot: string;
let savedPath: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-resolve-'));
  savedPath = process.env.PATH;
  clearDetectionCache();
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  clearDetectionCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Stage an executable shell stub named `name` in a fresh dir, prepend that dir
 * to PATH so `which`/`where` resolves it FIRST (ahead of any host install),
 * and return its absolute path. The stub echoes `versionOutput` so detection's
 * `<bin> --version` signature gate passes.
 */
function stageOnPath(name: string, versionOutput: string): string {
  const dir = path.join(tmpRoot, randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, name);
  fs.writeFileSync(full, `#!/bin/sh\necho "${versionOutput}"\n`, { mode: 0o755 });
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ''}`;
  return full;
}

describe('resolveCliBinaryPath (issue #104)', () => {
  it('resolves a bare known CLI name to the absolute path detection found', () => {
    const staged = stageOnPath('kimi', 'kimi, version 1.46.0');
    detectAllClis(true); // prime the cache against the staged PATH
    expect(resolveCliBinaryPath('kimi')).toBe(staged);
  });

  it('leaves an already-absolute path unchanged (caller already decided)', () => {
    // No detection lookup — a path-bearing command is spawned verbatim.
    expect(resolveCliBinaryPath('/opt/custom/kimi')).toBe('/opt/custom/kimi');
  });

  it('leaves a relative path (with separator) unchanged', () => {
    expect(resolveCliBinaryPath('./bin/kimi')).toBe('./bin/kimi');
  });

  it('leaves an unknown binary name unchanged (e.g. the `script` PTY wrapper)', () => {
    // `script` is not one of our CLIs, so it must never be rewritten — the
    // opencode PTY path spawns it with opencode embedded in argv.
    const staged = stageOnPath('kimi', 'kimi, version 1.46.0');
    detectAllClis(true);
    expect(staged).toContain('kimi'); // sanity: detection primed
    expect(resolveCliBinaryPath('script')).toBe('script');
    expect(resolveCliBinaryPath('sh')).toBe('sh');
  });

  it('returns the bare name for a known CLI that detection cannot find', () => {
    // Pick whichever supported CLI the host genuinely lacks so the assertion
    // is deterministic regardless of what's installed. (At least grok or
    // antigravity is absent on any normal dev/CI box.) Skip in the unlikely
    // event every CLI is installed.
    process.env.PATH = path.join(tmpRoot, 'empty');
    fs.mkdirSync(process.env.PATH, { recursive: true });
    const missing = detectAllClis(true).find((d) => !d.found);
    if (!missing) return;
    const bare = BINARY_NAME[missing.id];
    expect(resolveCliBinaryPath(bare)).toBe(bare);
  });

  it('mirrors detection for every CLI: detected path when found, bare name otherwise', () => {
    const results = detectAllClis(true);
    for (const d of results) {
      const bare = BINARY_NAME[d.id];
      const expected = d.found && d.path ? d.path : bare;
      expect(resolveCliBinaryPath(bare)).toBe(expected);
    }
  });
});
