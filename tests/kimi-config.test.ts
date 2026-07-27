/**
 * Bridging template model names onto the kimi CLI's own `[models]` keys.
 *
 * Why this matters: kimi's lookup is an EXACT key match, and a miss does
 * not fall back to `default_model` — it builds an empty model, prints
 * "LLM not set", and exits 0 with no answer. So the resolver must either
 * find a real key or return null (meaning "omit -m"), and must never
 * invent one.
 *
 * Key shapes are what `/login` actually writes: `<platform>/<model-id>`,
 * TOML-quoted because they contain a slash.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  readKimiDefaultModel,
  readKimiModelKeys,
  resolveKimiModel,
} from '@/lib/kimi-config';
import { kimiNotConfiguredError } from '@/daemon/agents/kimi';

let home: string;

beforeEach(() => {
  home = path.join(os.tmpdir(), `chorus-kimi-${randomUUID()}`);
  fs.mkdirSync(home, { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function writeConfig(dir: '.kimi' | '.kimi-code', body: string): void {
  const full = path.join(home, dir);
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(full, 'config.toml'), body, 'utf-8');
}

/** Verbatim shape of a logged-in Kimi Code config (tomlkit output). */
const LOGGED_IN = `default_model = "kimi-code/k2.6"

[models."kimi-code/k2.6"]
provider = "managed:kimi-code"
model = "k2.6"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
`;

describe('readKimiModelKeys', () => {
  it('reads TOML-quoted keys — the shape /login writes', () => {
    writeConfig('.kimi', LOGGED_IN);
    expect(readKimiModelKeys(home)).toEqual(['kimi-code/k2.6', 'kimi-code/k3']);
  });

  it('reads bare (unquoted) keys from a hand-written config', () => {
    writeConfig('.kimi', '[models.my-local]\nprovider = "ollama"\n');
    expect(readKimiModelKeys(home)).toEqual(['my-local']);
  });

  it('merges and dedupes across the Python and native-build config dirs', () => {
    writeConfig('.kimi', '[models."kimi-code/k3"]\n');
    writeConfig('.kimi-code', '[models."kimi-code/k3"]\n[models."kimi-code/k2.6"]\n');
    expect(readKimiModelKeys(home)).toEqual(['kimi-code/k2.6', 'kimi-code/k3']);
  });

  it('returns empty for an unwired config (the "not logged in" state)', () => {
    writeConfig('.kimi', 'default_model = ""\n\n[models]\n\n[providers]\n');
    expect(readKimiModelKeys(home)).toEqual([]);
    expect(readKimiDefaultModel(home)).toBeNull();
  });

  it('returns empty when no config exists at all (native build, fresh box)', () => {
    expect(readKimiModelKeys(home)).toEqual([]);
    expect(readKimiDefaultModel(home)).toBeNull();
  });

  it('reads default_model when set', () => {
    writeConfig('.kimi', LOGGED_IN);
    expect(readKimiDefaultModel(home)).toBe('kimi-code/k2.6');
  });
});

describe('resolveKimiModel', () => {
  const configured = ['kimi-code/k2.6', 'kimi-code/k3'];

  it('passes an exact key straight through', () => {
    expect(resolveKimiModel('kimi-code/k3', configured)).toBe('kimi-code/k3');
  });

  it('maps a vendor-prefixed id onto the platform key (the reported bug)', () => {
    // Templates carry moonshotai/… ; the CLI only knows kimi-code/… .
    expect(resolveKimiModel('moonshotai/kimi-k3', configured)).toBe('kimi-code/k3');
  });

  it('maps the bare template default across the punctuation difference', () => {
    expect(resolveKimiModel('kimi-k2.6', configured)).toBe('kimi-code/k2.6');
  });

  it('maps an opencode-go-prefixed id (shared template across transports)', () => {
    expect(resolveKimiModel('opencode-go/kimi-k2.6', configured)).toBe('kimi-code/k2.6');
  });

  it('returns null when nothing matches, so the caller omits -m', () => {
    // The whole point: a wrong -m makes kimi ignore default_model and
    // produce nothing. No match must mean "let the CLI choose".
    expect(resolveKimiModel('gpt-5.5', configured)).toBeNull();
    expect(resolveKimiModel('kimi-k9-imaginary', configured)).toBeNull();
  });

  it('returns null when the install has no configured models', () => {
    expect(resolveKimiModel('kimi-k2.6', [])).toBeNull();
  });

  it('returns null when no model was requested', () => {
    expect(resolveKimiModel(undefined, configured)).toBeNull();
  });

  it('is deterministic when two platforms expose the same model', () => {
    const both = ['moonshot-ai/k3', 'kimi-code/k3'];
    expect(resolveKimiModel('kimi-k3', both)).toBe('kimi-code/k3');
    expect(resolveKimiModel('kimi-k3', [...both].reverse())).toBe('kimi-code/k3');
  });
});

describe('kimiNotConfiguredError', () => {
  it('turns the CLI\'s "LLM not set" no-op into an auth error', () => {
    // Verbatim from `kimi --print -p hi -m <unknown>`: exit 0, no answer.
    const events = kimiNotConfiguredError('hi\nTurnBegin(user_input=\'hi\')\nTurnEnd()\nLLM not set\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', kind: 'auth_missing' });
    expect((events[0] as { message: string }).message).toMatch(/\/login/);
  });

  it('stays silent on a normal run, so real answers are not clobbered', () => {
    expect(kimiNotConfiguredError('{"type":"text","text":"looks good"}\n## DONE')).toEqual([]);
  });
});
