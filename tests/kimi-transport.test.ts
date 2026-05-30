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

import { chooseKimiTransport } from '../src/daemon/agents/kimi.js';

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
