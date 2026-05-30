/**
 * Transport selection for the kimi shim (issue #98).
 *
 * There are two `kimi` builds that share the binary name:
 *   - Python kimi-cli (MoonshotAI/kimi-cli)  → wired via ~/.kimi/config.toml
 *   - native Kimi Code (code.kimi.com)       → installs to ~/.kimi-code,
 *     account-authed via `kimi login` (no config.toml)
 *
 * `chooseKimiTransport` decides whether to drive the `kimi` binary directly
 * (kimi-cli transport) or route through opencode-go. Before the fix, a
 * Kimi-Code-only user (no ~/.kimi/config.toml) was silently shunted to the
 * opencode path — which ignores their kimi install or fails outright when
 * they lack an OpenCode Go subscription.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  chooseKimiTransport,
  isNativeKimiBinary,
  isPathUnder,
} from '../src/daemon/agents/kimi.js';

let tmpRoot: string;
beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-kimi-transport-'));
});
afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Fresh empty fake-home per test so cases don't bleed into each other. */
let home: string;
beforeEach(() => {
  home = path.join(tmpRoot, randomUUID());
  fs.mkdirSync(home, { recursive: true });
});

function writeKimiConfig(body: string): void {
  const dir = path.join(home, '.kimi');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.toml'), body, 'utf-8');
}

describe('chooseKimiTransport', () => {
  it('drives kimi directly when native Kimi Code (~/.kimi-code) is installed', () => {
    fs.mkdirSync(path.join(home, '.kimi-code', 'bin'), { recursive: true });
    expect(chooseKimiTransport(home)).toBe('kimi-cli');
  });

  it('drives kimi directly when ~/.kimi/config.toml wires a default_model', () => {
    writeKimiConfig('default_model = "kimi-k2.6"\n');
    expect(chooseKimiTransport(home)).toBe('kimi-cli');
  });

  it('drives kimi directly when ~/.kimi/config.toml has a [models.x] table', () => {
    writeKimiConfig('[models.foo]\napi_key = "x"\n');
    expect(chooseKimiTransport(home)).toBe('kimi-cli');
  });

  it('falls back to opencode when neither kimi build is configured', () => {
    expect(chooseKimiTransport(home)).toBe('opencode');
  });

  it('falls back to opencode for an unconfigured ~/.kimi/config.toml (empty model)', () => {
    writeKimiConfig('# no model set\n');
    expect(chooseKimiTransport(home)).toBe('opencode');
  });

  it('prefers native Kimi Code over an unconfigured ~/.kimi/config.toml', () => {
    // The exact bug: an empty ~/.kimi/config.toml would have yielded
    // opencode, but a present ~/.kimi-code install means the active `kimi`
    // binary is the native build and must be driven directly.
    fs.mkdirSync(path.join(home, '.kimi-code'), { recursive: true });
    writeKimiConfig('# no model set\n');
    expect(chooseKimiTransport(home)).toBe('kimi-cli');
  });

  it('honours CHORUS_KIMI_TRANSPORT=opencode override even when ~/.kimi-code exists', () => {
    fs.mkdirSync(path.join(home, '.kimi-code'), { recursive: true });
    expect(chooseKimiTransport(home, 'opencode')).toBe('opencode');
  });

  it('honours CHORUS_KIMI_TRANSPORT=kimi-cli override even when nothing is configured', () => {
    expect(chooseKimiTransport(home, 'kimi-cli')).toBe('kimi-cli');
  });
});

describe('chooseKimiTransport — native-build verdict (both builds installed)', () => {
  // The decision keys on whether the `kimi` that will actually run is the
  // native build (a tri-state boolean), not on the mere existence of a
  // ~/.kimi-code dir. This prevents detection (which resolves a concrete
  // path) and dispatch from disagreeing when both builds coexist on PATH.

  it('drives kimi directly when the resolved binary is native, even with an empty ~/.kimi/config.toml', () => {
    writeKimiConfig('# no model set\n');
    expect(chooseKimiTransport(home, undefined, true)).toBe('kimi-cli');
  });

  it('routes to opencode when a stale ~/.kimi-code dir exists but the resolved kimi is a NON-native unconfigured build', () => {
    // The exact "both installed" edge: ~/.kimi-code exists, but PATH resolves
    // `kimi` to the legacy Python build with no model wired. An explicit
    // `false` must skip the dir-existence shortcut and fall through to the
    // config probe → opencode-go (driving it directly would exit "LLM not set").
    fs.mkdirSync(path.join(home, '.kimi-code'), { recursive: true });
    writeKimiConfig('# no model set\n');
    expect(chooseKimiTransport(home, undefined, false)).toBe('opencode');
  });

  it('drives a non-native build directly when its ~/.kimi/config.toml IS configured', () => {
    fs.mkdirSync(path.join(home, '.kimi-code'), { recursive: true });
    writeKimiConfig('default_model = "kimi-k2.6"\n');
    expect(chooseKimiTransport(home, undefined, false)).toBe('kimi-cli');
  });

  it('falls back to ~/.kimi-code dir existence when the build is unknown (undefined)', () => {
    // Preserves v0.8.61 behaviour when detection couldn't resolve a path.
    fs.mkdirSync(path.join(home, '.kimi-code'), { recursive: true });
    expect(chooseKimiTransport(home, undefined, undefined)).toBe('kimi-cli');
  });

  it('override still wins over a native-build verdict', () => {
    expect(chooseKimiTransport(home, 'opencode', true)).toBe('opencode');
  });
});

describe('isPathUnder (lexical containment)', () => {
  it('accepts a binary directly under the parent', () => {
    expect(isPathUnder('/h/.kimi-code/bin/kimi', '/h/.kimi-code')).toBe(true);
  });
  it('rejects an identical path (not strictly inside)', () => {
    expect(isPathUnder('/h/.kimi-code', '/h/.kimi-code')).toBe(false);
  });
  it('rejects a sibling with a shared prefix (~/.kimi-code-backup)', () => {
    expect(isPathUnder('/h/.kimi-code-backup/bin/kimi', '/h/.kimi-code')).toBe(false);
  });
  it('rejects a parent ref', () => {
    expect(isPathUnder('/h/.kimi/bin/kimi', '/h/.kimi-code')).toBe(false);
  });
  it('accepts a child segment that merely starts with dots (..helpers)', () => {
    // gemini #46-review: `!rel.startsWith("..")` wrongly rejected this.
    expect(isPathUnder('/h/.kimi-code/..helpers/bin/kimi', '/h/.kimi-code')).toBe(true);
  });
});

describe('isNativeKimiBinary (realpaths both sides)', () => {
  it('returns undefined when no binary path is known', () => {
    expect(isNativeKimiBinary(home, undefined)).toBeUndefined();
  });
  it('true for a real binary under ~/.kimi-code', () => {
    const bin = path.join(home, '.kimi-code', 'bin', 'kimi');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '', { mode: 0o755 });
    expect(isNativeKimiBinary(home, bin)).toBe(true);
  });
  it('false for a Python-style path outside ~/.kimi-code', () => {
    const bin = path.join(home, '.local', 'bin', 'kimi');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '', { mode: 0o755 });
    expect(isNativeKimiBinary(home, bin)).toBe(false);
  });
  it('true when the binary is a SYMLINK on PATH pointing into ~/.kimi-code', () => {
    // e.g. /usr/local/bin/kimi → ~/.kimi-code/bin/kimi
    const real = path.join(home, '.kimi-code', 'bin', 'kimi');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '', { mode: 0o755 });
    const linkDir = path.join(home, 'pathdir');
    fs.mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, 'kimi');
    fs.symlinkSync(real, link);
    expect(isNativeKimiBinary(home, link)).toBe(true);
  });
  it('true when ~/.kimi-code itself is a SYMLINK to another location (asymmetry fix)', () => {
    // The exact gap reviewers flagged: realpathing only the binary while the
    // dir stays lexical would false-negative. Both sides resolve here.
    const target = path.join(home, 'opt-kimi-code');
    fs.mkdirSync(path.join(target, 'bin'), { recursive: true });
    const bin = path.join(target, 'bin', 'kimi');
    fs.writeFileSync(bin, '', { mode: 0o755 });
    fs.symlinkSync(target, path.join(home, '.kimi-code'));
    // detection resolves the binary through the dir symlink:
    expect(isNativeKimiBinary(home, path.join(home, '.kimi-code', 'bin', 'kimi'))).toBe(true);
  });
});
