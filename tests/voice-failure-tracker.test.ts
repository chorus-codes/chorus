/**
 * Auto-disable on persistent quota_exhausted (issue #11).
 *
 * Hits the real DB (libsql in-memory) so we cover the full path:
 *   - settings counter increment
 *   - voices.update on threshold cross
 *   - auto-restore protection (auto_quota rows are NOT auto-re-enabled
 *     by the seed loop; that's a property of voices.upsert + the
 *     wasAutoMissing guard in seed)
 *
 * The pure decision function is tested separately so future tuning of
 * the threshold or signal can be done without DB scaffolding.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { _resetDbForTests, getDb, voices, settings } from '@/lib/db';
import {
  recordVoiceFailure,
  recordVoiceSuccess,
  shouldAutoDisable,
  AUTO_DISABLE_THRESHOLD,
  _testing,
} from '@/lib/voice-failure-tracker';

let dbPath: string;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `chorus-vft-${randomUUID()}.db`);
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

async function seedGeminiProVoice() {
  await voices.upsert({
    id: 'gemini-cli:gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro Preview',
    source: 'cli',
    provider: 'gemini-cli',
    model_id: 'gemini-3.1-pro-preview',
    lineage: 'google',
    enabled: true,
  });
}

describe('shouldAutoDisable (pure)', () => {
  it('returns false when upstream provided a reset window (true rate limit)', () => {
    expect(shouldAutoDisable(2, true)).toBe(false);
    expect(shouldAutoDisable(99, true)).toBe(false);
  });

  it('returns false when below threshold even with no reset window', () => {
    expect(shouldAutoDisable(0, false)).toBe(false);
    expect(shouldAutoDisable(1, false)).toBe(false);
  });

  it('returns true at threshold with no reset window', () => {
    expect(shouldAutoDisable(AUTO_DISABLE_THRESHOLD, false)).toBe(true);
  });

  it('threshold is 2 strikes (locks the value)', () => {
    // The threshold is a product decision: one strike risks transient
    // network blips, three strikes is too patient. If you change this,
    // update the docstring in voice-failure-tracker.ts and the
    // user-facing message on the cockpit Connect page.
    expect(AUTO_DISABLE_THRESHOLD).toBe(2);
  });
});

describe('recordVoiceFailure (DB)', () => {
  it('first failure increments counter but does not disable', async () => {
    await seedGeminiProVoice();
    const result = await recordVoiceFailure({
      lineage: 'google',
      model: 'gemini-3.1-pro-preview',
      hasResetAt: false,
    });
    expect(result.disabled).toBe(false);
    expect(result.voiceId).toBe('gemini-cli:gemini-3.1-pro-preview');
    const counter = await settings.get(_testing.COUNTER_KEY('gemini-cli:gemini-3.1-pro-preview'));
    expect(counter).toBe(1);
    const row = await voices.getById('gemini-cli:gemini-3.1-pro-preview');
    expect(row?.enabled).toBe(true);
  });

  it('second failure with no resetAt disables voice with reason=auto_quota', async () => {
    await seedGeminiProVoice();
    await recordVoiceFailure({ lineage: 'google', model: 'gemini-3.1-pro-preview', hasResetAt: false });
    const result = await recordVoiceFailure({
      lineage: 'google',
      model: 'gemini-3.1-pro-preview',
      hasResetAt: false,
    });
    expect(result.disabled).toBe(true);
    const row = await voices.getById('gemini-cli:gemini-3.1-pro-preview');
    expect(row?.enabled).toBe(false);
    expect(row?.disabled_reason).toBe('auto_quota');
  });

  it('failures with resetAt do not contribute to disable (true rate limit recovers)', async () => {
    await seedGeminiProVoice();
    // 5 strikes WITH resetAt — should never disable.
    for (let i = 0; i < 5; i++) {
      const result = await recordVoiceFailure({
        lineage: 'google',
        model: 'gemini-3.1-pro-preview',
        hasResetAt: true,
      });
      expect(result.disabled).toBe(false);
    }
    const row = await voices.getById('gemini-cli:gemini-3.1-pro-preview');
    expect(row?.enabled).toBe(true);
  });

  it('failures with resetAt do not increment the counter (cross-poison guard)', async () => {
    // Regression for chorus self-review finding (cli-3): a transient
    // rate-limit (hasResetAt=true) followed by a permanent failure
    // (hasResetAt=false) must require TWO permanent strikes before
    // disable, not one. If hasResetAt=true bumped the counter, the
    // first permanent strike would already be at threshold.
    await seedGeminiProVoice();
    await recordVoiceFailure({ lineage: 'google', model: 'gemini-3.1-pro-preview', hasResetAt: true });
    await recordVoiceFailure({ lineage: 'google', model: 'gemini-3.1-pro-preview', hasResetAt: true });
    // Counter should still be 0 — neither strike was a permanent failure.
    const counter = await settings.get(_testing.COUNTER_KEY('gemini-cli:gemini-3.1-pro-preview'));
    expect(counter == null || counter === 0).toBe(true);
    // First permanent strike — must NOT disable.
    const first = await recordVoiceFailure({
      lineage: 'google',
      model: 'gemini-3.1-pro-preview',
      hasResetAt: false,
    });
    expect(first.disabled).toBe(false);
    const row = await voices.getById('gemini-cli:gemini-3.1-pro-preview');
    expect(row?.enabled).toBe(true);
  });

  it('counter resets on disable so a future re-enable starts clean', async () => {
    await seedGeminiProVoice();
    await recordVoiceFailure({ lineage: 'google', model: 'gemini-3.1-pro-preview', hasResetAt: false });
    await recordVoiceFailure({ lineage: 'google', model: 'gemini-3.1-pro-preview', hasResetAt: false });
    const counterAfter = await settings.get(_testing.COUNTER_KEY('gemini-cli:gemini-3.1-pro-preview'));
    expect(counterAfter).toBe(0);
  });

  it('returns voiceId=null + disabled=false when no matching voice exists', async () => {
    // No voice seeded — runner saw an error from a model not in the table.
    const result = await recordVoiceFailure({
      lineage: 'google',
      model: 'gemini-99-mythical',
      hasResetAt: false,
    });
    expect(result).toEqual({ disabled: false, voiceId: null });
  });

  it('returns voiceId=null when model is undefined', async () => {
    await seedGeminiProVoice();
    const result = await recordVoiceFailure({
      lineage: 'google',
      model: undefined,
      hasResetAt: false,
    });
    expect(result.voiceId).toBeNull();
  });

  it('counter is per-voice — failing on Pro does not impact Flash', async () => {
    await seedGeminiProVoice();
    await voices.upsert({
      id: 'gemini-cli:gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
      source: 'cli',
      provider: 'gemini-cli',
      model_id: 'gemini-2.5-flash',
      lineage: 'google',
      enabled: true,
    });
    await recordVoiceFailure({ lineage: 'google', model: 'gemini-3.1-pro-preview', hasResetAt: false });
    await recordVoiceFailure({ lineage: 'google', model: 'gemini-3.1-pro-preview', hasResetAt: false });
    const flash = await voices.getById('gemini-cli:gemini-2.5-flash');
    expect(flash?.enabled).toBe(true);
    const pro = await voices.getById('gemini-cli:gemini-3.1-pro-preview');
    expect(pro?.enabled).toBe(false);
  });
});

describe('recordVoiceSuccess (DB)', () => {
  it('clears the failure counter so a flaky day does not cumulate', async () => {
    await seedGeminiProVoice();
    await recordVoiceFailure({ lineage: 'google', model: 'gemini-3.1-pro-preview', hasResetAt: false });
    await recordVoiceSuccess({ lineage: 'google', model: 'gemini-3.1-pro-preview' });
    const counter = await settings.get(_testing.COUNTER_KEY('gemini-cli:gemini-3.1-pro-preview'));
    expect(counter).toBe(0);
    // Now a single subsequent failure must NOT disable (counter restarted from 0).
    const result = await recordVoiceFailure({
      lineage: 'google',
      model: 'gemini-3.1-pro-preview',
      hasResetAt: false,
    });
    expect(result.disabled).toBe(false);
  });

  it('is a no-op when the voice has no recorded failures', async () => {
    await seedGeminiProVoice();
    await recordVoiceSuccess({ lineage: 'google', model: 'gemini-3.1-pro-preview' });
    // Should not throw and should not write a row.
    const counter = await settings.get(_testing.COUNTER_KEY('gemini-cli:gemini-3.1-pro-preview'));
    // Either undefined (never written) or 0 — both are correct semantics.
    expect(counter == null || counter === 0).toBe(true);
  });

  it('is a no-op when the voice cannot be resolved', async () => {
    // No seeded voice. Should not throw.
    await recordVoiceSuccess({ lineage: 'google', model: 'gemini-99-mythical' });
  });
});
