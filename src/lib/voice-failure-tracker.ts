/**
 * Per-voice failure tracker for auto-disabling voices that fail
 * permanently against a specific account.
 *
 * Concrete pain (issue #11): a Gemini Pro model on a Flash-only
 * account fails every call with "exhausted your capacity on this
 * model" — but Gemini does not return a `resetAt`, because the model
 * isn't going to become available. Without auto-disable the runner
 * keeps picking that voice on every chat the user fires, every voice
 * times-out, the user keeps seeing the same opaque error.
 *
 * The signal we trust:
 *   - kind: 'quota_exhausted'
 *   - hasResetAt: false  (the upstream did NOT promise recovery)
 *
 * One strike with that exact signal isn't enough — the user might
 * have hit a transient network blip that the parser couldn't extract
 * a reset window from. Two consecutive strikes is the threshold:
 * cheap on false positives, fast on true permanent-failures (user
 * sees one failed run, not five).
 *
 * On any successful run for the same voice, the counter resets — so
 * a flaky day doesn't accumulate into auto-disable forever.
 */
import { settings } from './db/settings.js';
import { voices } from './db/voices.js';
import type { CliLineage } from './cli-health.js';

const COUNTER_KEY = (voiceId: string): string => `voice_failures.${voiceId}`;

/**
 * Strikes-before-disable threshold.
 *
 * Tuned for "fast on true permanent failures, conservative on
 * transient noise". One strike risks a network-blip false positive;
 * three+ strikes is too patient when the user's already complained.
 */
export const AUTO_DISABLE_THRESHOLD = 2;

/**
 * Pure decision function — exposed so tests don't need DB.
 *
 * Returns true when the runner should disable the voice based on the
 * post-increment counter and whether the upstream promised recovery.
 */
export function shouldAutoDisable(
  consecutiveFailures: number,
  hasResetAt: boolean,
): boolean {
  // Upstream promised recovery (true rate limit) — this isn't a
  // permanent failure, just wait for the reset window.
  if (hasResetAt) return false;
  return consecutiveFailures >= AUTO_DISABLE_THRESHOLD;
}

/**
 * Resolve a voice row by its lineage + model. Returns the first
 * matching enabled voice, or null if none. Used by the runner to
 * find the voice it just ran against without plumbing voice IDs
 * through the entire dispatch pipeline.
 */
async function resolveVoice(
  lineage: CliLineage,
  model: string | undefined,
): Promise<{ id: string } | null> {
  if (!model) return null;
  const rows = await voices.list({ lineage });
  // Exact model match. Voice IDs aren't stable across (lineage, model)
  // combinations (e.g. openrouter wraps with `openrouter:` prefix), so
  // we match on `model_id` which is what the runner has at hand.
  const match = rows.find((r) => r.model_id === model);
  return match ? { id: match.id } : null;
}

/**
 * Record a failure for the voice that ran (lineage + model).
 *
 * Increments the per-voice counter. If the post-increment counter
 * crosses AUTO_DISABLE_THRESHOLD AND the upstream did not provide a
 * reset window, sets `voices.enabled=false` with
 * `disabled_reason='auto_quota'`.
 *
 * Returns whether the voice was disabled by this call so the runner
 * can surface a specific cli_warning in the run page.
 */
export async function recordVoiceFailure(input: {
  lineage: CliLineage;
  model: string | undefined;
  hasResetAt: boolean;
}): Promise<{ disabled: boolean; voiceId: string | null }> {
  const voice = await resolveVoice(input.lineage, input.model);
  if (!voice) return { disabled: false, voiceId: null };

  // Skip the counter entirely when the upstream promised recovery.
  // True rate limits should not contribute to the strike count —
  // otherwise a transient daily-quota hit + a later permanent
  // failure would trip the threshold on the first permanent strike
  // instead of the second.
  if (input.hasResetAt) {
    return { disabled: false, voiceId: voice.id };
  }

  const key = COUNTER_KEY(voice.id);
  const raw = await settings.get(key);
  const previous = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  const next = previous + 1;
  await settings.set(key, next);

  if (shouldAutoDisable(next, input.hasResetAt)) {
    await voices.update(voice.id, {
      enabled: false,
      disabled_reason: 'auto_quota',
    });
    // Reset the counter so a future re-enable doesn't trip on
    // stale state.
    await settings.set(key, 0);
    return { disabled: true, voiceId: voice.id };
  }

  return { disabled: false, voiceId: voice.id };
}

/**
 * Reset the failure counter for a voice after a successful run.
 *
 * Called from the runner's participant_done path. Bounded — a
 * voice that succeeds once a day clears its counter, so a flaky
 * day can't accumulate into permanent auto-disable.
 */
export async function recordVoiceSuccess(input: {
  lineage: CliLineage;
  model: string | undefined;
}): Promise<void> {
  const voice = await resolveVoice(input.lineage, input.model);
  if (!voice) return;
  const key = COUNTER_KEY(voice.id);
  const raw = await settings.get(key);
  // Skip the write when the counter is already 0 — saves a DB roundtrip
  // on the hot success path.
  if (typeof raw === 'number' && raw > 0) {
    await settings.set(key, 0);
  }
}

/**
 * Internal — exported only for tests.
 * @internal
 */
export const _testing = {
  COUNTER_KEY,
};
