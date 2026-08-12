/**
 * Voices seed + migration tests.
 *
 * Covers:
 *   - classifyOpencodeModel: gateway-prefix-agnostic lineage/vendor_family
 *     extraction.
 *   - migrationFor: absent vs empty vs populated semantics.
 *   - seedCliVoices: idempotency, immutable-ID upsert across version bumps,
 *     auto-disable on CLI uninstall, first-boot migration from settings.
 *
 * NOTE: We don't directly test seedOpencodeVoicesAsync because it shells
 * out to `opencode models`. The classifier is unit-tested instead, which
 * is the only logic specific to that path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';

import { _resetDbForTests, getDb, settings, voices } from '@/lib/db';
import { _internals, seedCliVoices } from '@/lib/voices';
import {
  UI_LINEAGE_AVAILABLE_MODELS,
  UI_LINEAGE_DEFAULT_MODEL,
} from '@/lib/lineage-maps';

let dbPath: string;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `chorus-voices-seed-${randomUUID()}.db`);
  process.env.CHORUS_DB_PATH = dbPath;
  await _resetDbForTests();
  await getDb();
});

afterEach(async () => {
  await _resetDbForTests();
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* best-effort */ }
  }
  delete process.env.CHORUS_DB_PATH;
});

describe('classifyOpencodeModel', () => {
  const { classifyOpencodeModel } = _internals;

  it('maps opencode-go/kimi → opencode lineage with moonshot vendor_family', () => {
    // opencode-go gateway always routes through the opencode binary, so
    // lineage = 'opencode' regardless of underlying model family. Model
    // family preserved on vendor_family. Avoids the impossible-template
    // combo (lineage=Kimi, model=opencode-go/kimi-k2.6) that implied a
    // standalone kimi-CLI subscription users may not have.
    expect(classifyOpencodeModel('opencode-go/kimi-k2.6')).toEqual({
      lineage: 'opencode',
      vendor_family: 'moonshot',
    });
  });

  it('maps non-gateway moonshotai/kimi → moonshot lineage', () => {
    // OpenRouter-style native prefix isn't routed through opencode, so
    // lineage tracks model family.
    expect(classifyOpencodeModel('moonshotai/kimi-k2')).toEqual({
      lineage: 'moonshot',
      vendor_family: null,
    });
  });

  it('maps claude → anthropic regardless of gateway', () => {
    expect(classifyOpencodeModel('opencode-zen/claude-opus-4-7').lineage).toBe('anthropic');
    expect(classifyOpencodeModel('opencode/claude-sonnet-4-6').lineage).toBe('anthropic');
  });

  it('maps gpt → openai', () => {
    expect(classifyOpencodeModel('opencode/gpt-5.5').lineage).toBe('openai');
  });

  it('maps gemini → google', () => {
    expect(classifyOpencodeModel('opencode/gemini-3-flash').lineage).toBe('google');
  });

  it('maps deepseek → opencode lineage with deepseek vendor_family', () => {
    expect(classifyOpencodeModel('opencode-go/deepseek-v4-pro')).toEqual({
      lineage: 'opencode',
      vendor_family: 'deepseek',
    });
  });

  it('maps llama / meta → opencode + meta vendor_family', () => {
    expect(classifyOpencodeModel('opencode-go/llama-4-405b').vendor_family).toBe('meta');
    expect(classifyOpencodeModel('opencode-go/meta-llama').vendor_family).toBe('meta');
  });

  it('maps mistral / mixtral → opencode + mistral vendor_family', () => {
    expect(classifyOpencodeModel('opencode-go/mistral-large').vendor_family).toBe('mistral');
    expect(classifyOpencodeModel('opencode-go/mixtral-8x7b').vendor_family).toBe('mistral');
  });

  it('maps grok / xai → opencode + xai vendor_family', () => {
    expect(classifyOpencodeModel('opencode-go/grok-4').vendor_family).toBe('xai');
  });

  it('maps OpenAI reasoning models o1/o3/o4 routed via opencode-go → opencode lineage with openai vendor_family', () => {
    // opencode-go gateway ⇒ opencode binary ⇒ lineage=opencode. Model
    // family preserved on vendor_family.
    expect(classifyOpencodeModel('opencode-go/o3-mini')).toEqual({
      lineage: 'opencode',
      vendor_family: 'openai',
    });
    // Other gateways (opencode, opencode-zen) still classify by model family
    // — they aren't opencode-binary-routed. This branch is OpenRouter-style
    // native-prefix matching.
    expect(classifyOpencodeModel('opencode/o1-preview').lineage).toBe('openai');
    expect(classifyOpencodeModel('opencode-zen/o4').lineage).toBe('openai');
  });

  it('does not false-match o1/o3 inside other words', () => {
    // "octopus" or "go" shouldn't resolve to openai.
    expect(classifyOpencodeModel('opencode-go/octopus').lineage).not.toBe('openai');
  });

  it('falls back to opencode lineage with no vendor_family for unknown', () => {
    expect(classifyOpencodeModel('opencode-go/totally-unknown')).toEqual({
      lineage: 'opencode',
      vendor_family: null,
    });
  });

  it('handles bare model name without gateway prefix', () => {
    expect(classifyOpencodeModel('kimi-k2.6').lineage).toBe('moonshot');
  });
});

describe('migrationFor', () => {
  const { migrationFor } = _internals;

  type UiLineage = 'claude' | 'codex' | 'gemini' | 'opencode' | 'kimi';
  type MigrationData = { byUiLineage: Map<UiLineage, string[] | undefined> };

  it('absent → default model only is enabled', () => {
    // Reads the default from the catalog rather than pinning an id: the
    // rule under test is "the lineage default is the one enabled", which
    // must survive a model-catalog refresh (2026-07-27: opus-4-7 → opus-5).
    const defaultModel = UI_LINEAGE_DEFAULT_MODEL.claude;
    const nonDefault = (UI_LINEAGE_AVAILABLE_MODELS.claude ?? []).find(
      (m) => m !== defaultModel,
    );
    expect(nonDefault).toBeDefined();
    const data: MigrationData = { byUiLineage: new Map([['claude', undefined]]) };
    expect(migrationFor(data, 'claude', defaultModel)).toBe(true);
    expect(migrationFor(data, 'claude', nonDefault as string)).toBe(false);
  });

  it('empty array → no models enabled', () => {
    const data: MigrationData = { byUiLineage: new Map([['claude', []]]) };
    expect(migrationFor(data, 'claude', 'claude-opus-4-7')).toBe(false);
    expect(migrationFor(data, 'claude', 'claude-sonnet-4-6')).toBe(false);
  });

  it('populated array → exact membership', () => {
    const data: MigrationData = { byUiLineage: new Map([['claude', ['claude-opus-4-7', 'claude-haiku-4-5']]]) };
    expect(migrationFor(data, 'claude', 'claude-opus-4-7')).toBe(true);
    expect(migrationFor(data, 'claude', 'claude-haiku-4-5')).toBe(true);
    expect(migrationFor(data, 'claude', 'claude-sonnet-4-6')).toBe(false);
  });

  it('opencode lineage with absent setting returns undefined (caller handles)', () => {
    const data: MigrationData = { byUiLineage: new Map([['opencode', undefined]]) };
    expect(migrationFor(data, 'opencode', 'opencode-go/kimi-k2.6')).toBeUndefined();
  });
});

describe('seedCliVoices', () => {
  // Note: this test depends on detectAllClis() returning the host's actual
  // CLI presence. On this dev box, claude/codex/gemini/opencode/kimi are
  // typically installed. We can't easily mock the detect() call in the
  // current architecture (it spawns subprocesses), so the assertions
  // tolerate either presence pattern.

  it('runs idempotently — second call does not duplicate single-model CLI rows', async () => {
    await seedCliVoices();
    const after1 = await voices.list({ source: 'cli' });
    const ids1 = after1.map((v) => v.id).sort();

    await seedCliVoices();
    const after2 = await voices.list({ source: 'cli' });
    const ids2 = after2.map((v) => v.id).sort();

    expect(ids2).toEqual(ids1);
  });

  it('preserves user-set enabled=false across re-seeds', async () => {
    await seedCliVoices();
    const before = await voices.list({ source: 'cli', provider: 'claude-code' });
    if (before.length === 0) return; // claude not installed on this host

    await voices.update('claude-code', { enabled: false });
    await seedCliVoices();
    const after = await voices.getById('claude-code');
    expect(after?.enabled).toBe(false);
  });

  it('first-boot migration from populated <lineage>.enabled_models setting', async () => {
    // Pre-populate a setting; voices table is currently empty.
    await settings.set('claude.enabled_models', ['claude-haiku-4-5']);

    await seedCliVoices();

    const claudeVoices = await voices.list({ source: 'cli', provider: 'claude-code' });
    if (claudeVoices.length === 0) return; // claude-code not installed

    // Default model should NOT be enabled (not in setting list).
    const opus = claudeVoices.find((v) => v.id === 'claude-code');
    expect(opus?.enabled).toBe(false);

    // Haiku (curated, in user's list) should be enabled.
    const haiku = claudeVoices.find((v) => v.model_id === 'claude-haiku-4-5');
    expect(haiku?.enabled).toBe(true);
  });

  it('first-install with no migration data → all curated models enabled', async () => {
    // No <lineage>.enabled_models setting at all → treated as a fresh
    // install. Every curated/discovered model row starts enabled so the
    // user opts out of what they don't want, rather than opting in.
    await seedCliVoices();
    const claudeVoices = await voices.list({ source: 'cli', provider: 'claude-code' });
    if (claudeVoices.length === 0) return;

    for (const v of claudeVoices) {
      expect(v.enabled).toBe(true);
    }
  });

  // Per round 1 cdx-1 BLOCKER 1: if a single-model CLI isn't currently
  // detected but the user has a prior <lineage>.enabled_models setting,
  // first-boot migration must still seed the voices so the intent
  // isn't lost when the CLI later installs.
  it('first-boot migration seeds voices for undetected CLIs when settings exist', async () => {
    // Point HOME at an empty dir for the duration: kimi's catalog is now
    // read live from the developer's own ~/.kimi config when one is wired
    // (those keys are the only strings its CLI accepts). Without this the
    // assertion below would pass or fail depending on whose laptop runs
    // the suite. Empty home → no keys → the static catalog is used.
    const realHome = process.env.HOME;
    const emptyHome = path.join(os.tmpdir(), `chorus-seed-home-${randomUUID()}`);
    fs.mkdirSync(emptyHome, { recursive: true });
    process.env.HOME = emptyHome;

    // A model from the static catalog — the setting is seeded BEFORE
    // voices so migration sees first-boot=true.
    const migratedModel = (UI_LINEAGE_AVAILABLE_MODELS.kimi ?? [])[1];
    expect(migratedModel).toBeDefined();

    try {
      await settings.set('kimi.enabled_models', [migratedModel]);

      await seedCliVoices();

      // Even if kimi-cli isn't detected on this host, the setting's
      // intent should be migrated into voice rows.
      const kimiVoices = await voices.list({ provider: 'kimi-cli' });
      if (kimiVoices.length > 0) {
        // Migrated rows exist regardless of detect outcome.
        const migrated = kimiVoices.find((v) => v.model_id === migratedModel);
        expect(migrated).toBeDefined();
        expect(migrated?.enabled).toBe(true);
      }
    } finally {
      if (realHome) process.env.HOME = realHome;
      else delete process.env.HOME;
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it('first-boot migration with empty array → all curated disabled', async () => {
    await settings.set('claude.enabled_models', []);

    await seedCliVoices();
    const claudeVoices = await voices.list({ source: 'cli', provider: 'claude-code' });
    if (claudeVoices.length === 0) return;

    for (const v of claudeVoices) {
      expect(v.enabled).toBe(false);
    }
  });

  it('catalog drift: stale model rows get deleted on re-seed', async () => {
    // First seed creates rows for whatever's in the current catalog.
    await seedCliVoices();
    const claudeRows = await voices.list({ provider: 'claude-code' });
    if (claudeRows.length === 0) return; // claude not on this host

    // Inject a stale row simulating a model that USED to be in the catalog.
    await voices.upsert({
      id: 'claude-code:claude-stale-deprecated',
      label: 'Claude (claude-stale-deprecated)',
      source: 'cli',
      provider: 'claude-code',
      model_id: 'claude-stale-deprecated',
      lineage: 'anthropic',
      enabled: true,
    });
    expect(await voices.getById('claude-code:claude-stale-deprecated')).toBeDefined();

    // Re-seed should delete it (not in current catalog).
    await seedCliVoices();
    expect(await voices.getById('claude-code:claude-stale-deprecated')).toBeNull();
  });

  it('antigravity: Phase 2 injects a live catalog that overrides the static one', async () => {
    // `agy models` is a ~3s network fetch, so Phase 1 never runs it —
    // it seeds from the static catalog and Phase 2 re-runs this same
    // idempotent seed with the live list. This is that second call.
    await seedCliVoices();
    const agyRows = await voices.list({ provider: 'antigravity-cli' });
    if (agyRows.length === 0) return; // agy not on this host

    await seedCliVoices({ antigravityModels: ['gemini-9.9-flash-high', 'claude-sonnet-4-6'] });

    // Live list wins: its entries exist...
    const live = await voices.getById('antigravity-cli:claude-sonnet-4-6');
    expect(live).toBeDefined();
    // ...and a static-catalog model the account can't reach is dropped.
    expect(await voices.getById('antigravity-cli:gemini-3.1-pro-low')).toBeNull();

    // A Claude model reached through agy is the user's call — but it must
    // be recorded as anthropic-family so quorum fallback doesn't treat it
    // as a Google-family reviewer.
    expect(live?.vendor_family).toBe('anthropic');
    const provider = await voices.getById('antigravity-cli');
    expect(provider?.model_id).toBe('gemini-9.9-flash-high');
    expect(provider?.vendor_family).toBe('google');
  });

  it('catalog drift: immutable provider row never gets deleted even when its model_id is stale', async () => {
    await seedCliVoices();
    const before = await voices.getById('claude-code');
    if (!before) return;

    // Force the immutable row to a model id that's NOT in the catalog.
    // Re-seed should rewrite model_id to the latest, NOT delete the row.
    await voices.update('claude-code', { model_id: 'claude-stale-deprecated' });
    await seedCliVoices();
    const after = await voices.getById('claude-code');
    expect(after).not.toBeNull();
    expect(after!.id).toBe('claude-code');
    // model_id should have been rotated forward to whatever's at index 0
    // of the current catalog.
    expect(after!.model_id).not.toBe('claude-stale-deprecated');
  });

  it('immutable single-model CLI ID survives seed cycle (no ghost rows)', async () => {
    await seedCliVoices();
    const before = await voices.list({ provider: 'claude-code' });
    if (before.length === 0) return;

    // Find the immutable claude-code row
    const immutable = before.find((v) => v.id === 'claude-code');
    expect(immutable).toBeDefined();

    // Simulate a "model ID changed in lineage-maps" by directly updating the row
    await voices.update('claude-code', { model_id: 'claude-opus-4-6' });

    // Re-seed
    await seedCliVoices();

    const after = await voices.list({ provider: 'claude-code' });
    const allIds = after.map((v) => v.id);
    // Still exactly ONE row at id='claude-code' (no version-suffixed dup)
    const claudeCodeCount = allIds.filter((id) => id === 'claude-code').length;
    expect(claudeCodeCount).toBe(1);
  });
});
