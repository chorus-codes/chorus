/**
 * Per-CLI health state, persisted in the settings table.
 *
 * Records the most recent failure mode the error-detector observed per
 * lineage, plus a timestamp and (when available) a reset-at time so the UI
 * can show "Codex resets at 10:05 PM".
 *
 * Recorded by: daemon's runner when it forwards cli_error events.
 * Read by: home-page CLI status panel via GET /cli/health.
 */

import { settings } from './db';

export type CliLineage =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'opencode'
  | 'moonshot'
  | 'openrouter'
  | 'local'
  | 'grok';

export type HealthStatus =
  | 'healthy'
  | 'quota_exhausted'
  | 'auth_invalid'
  | 'rate_limited'
  | 'unknown';

export interface CliHealth {
  lineage: CliLineage;
  status: HealthStatus;
  /** Free-form one-liner for the UI. */
  message?: string;
  /** When the CLI is expected to recover (ms-epoch). undefined = unknown. */
  resetAt?: number;
  /** When this status was last updated (ms-epoch). */
  updatedAt: number;
}

const KEY = (l: CliLineage) => `cli_health.${l}`;

const ALL_LINEAGES: CliLineage[] = [
  'anthropic',
  'openai',
  'google',
  'opencode',
  'moonshot',
  'openrouter',
  'local',
  'grok',
];

export async function recordHealth(input: {
  lineage: CliLineage;
  status: HealthStatus;
  message?: string;
  resetAt?: number;
}): Promise<void> {
  const payload: CliHealth = {
    lineage: input.lineage,
    status: input.status,
    message: input.message,
    resetAt: input.resetAt,
    updatedAt: Date.now(),
  };
  await settings.set(KEY(input.lineage), payload);
}

export async function getHealth(lineage: CliLineage): Promise<CliHealth> {
  const raw = await settings.get(KEY(lineage));
  if (raw && typeof raw === 'object' && 'status' in raw) {
    return raw as CliHealth;
  }
  return {
    lineage,
    status: 'unknown',
    updatedAt: 0,
  };
}

export async function getAllHealth(): Promise<CliHealth[]> {
  return Promise.all(ALL_LINEAGES.map(getHealth));
}

/**
 * Sweep cli-health entries and reset any whose `resetAt` has passed.
 * Called periodically from the reaper so the home-page fleet card flips
 * back to green automatically once a quota window expires — no refresh,
 * no manual intervention. Bounded by ALL_LINEAGES so this is O(7) DB
 * roundtrips per tick (six writes max even in the worst case).
 *
 * Returns the list of lineages whose state was cleared so the caller
 * can log them.
 */
export async function clearStaleHealth(): Promise<CliLineage[]> {
  const now = Date.now();
  const cleared: CliLineage[] = [];
  for (const lineage of ALL_LINEAGES) {
    const h = await getHealth(lineage);
    if (
      h.status !== 'healthy' &&
      h.status !== 'unknown' &&
      typeof h.resetAt === 'number' &&
      h.resetAt > 0 &&
      h.resetAt <= now
    ) {
      await recordHealth({ lineage, status: 'healthy' });
      cleared.push(lineage);
    }
  }
  return cleared;
}

/**
 * Translate an error-detector CliErrorKind into a HealthStatus.
 * Used by the runner when forwarding cli_error events.
 */
export function kindToStatus(kind: string): HealthStatus {
  switch (kind) {
    case 'quota_exhausted':
      return 'quota_exhausted';
    case 'token_refresh_lost':
    case 'mcp_handshake_failed':
      return 'auth_invalid';
    default:
      return 'unknown';
  }
}

/**
 * Classify a headless-shim error kind (e.g. `openrouter_402`,
 * `openrouter_401`, `openrouter_429`) into a health status + friendlier
 * one-liner the cockpit can show on the fleet card and run-page error
 * banner. Returns null when the kind isn't a known OpenRouter HTTP code,
 * so callers can fall through to generic handling.
 *
 * Reference: https://openrouter.ai/docs/errors — 402 means "your account
 * is out of credits", 401 a bad/revoked key, 429 a rate cap, 403 a model
 * the key isn't allowed to call (paid tier / BYOK), 5xx an upstream
 * outage. We deliberately collapse 401 + 403 to auth_invalid since the
 * remediation is the same (fix the key).
 */
export function classifyOpenRouterError(
  kind: string,
  message?: string,
): { status: HealthStatus; message: string; cta?: string } | null {
  const m = (message ?? '').trim();
  if (kind === 'auth_missing') {
    return {
      status: 'auth_invalid',
      message: 'No OpenRouter API key saved.',
      cta: 'Add your key on the Connect page.',
    };
  }
  if (!kind.startsWith('openrouter_')) return null;
  const statusCode = Number(kind.slice('openrouter_'.length));
  if (statusCode === 402) {
    return {
      status: 'quota_exhausted',
      message: m || 'OpenRouter account is out of credits.',
      cta: 'Top up at openrouter.ai/credits.',
    };
  }
  if (statusCode === 401 || statusCode === 403) {
    return {
      status: 'auth_invalid',
      message: m || 'OpenRouter rejected the API key.',
      cta: 'Replace the key on the Connect page.',
    };
  }
  if (statusCode === 429) {
    return {
      status: 'rate_limited',
      message: m || 'OpenRouter rate-limited the request.',
      cta: 'Slow down or pick a higher-tier model.',
    };
  }
  if (statusCode === 404) {
    return {
      status: 'unknown',
      message: m || 'OpenRouter could not find the requested model.',
      cta: 'Pick a different model on the Connect page.',
    };
  }
  if (statusCode >= 500 && statusCode < 600) {
    return {
      status: 'rate_limited',
      message: m || `OpenRouter upstream error (${statusCode}).`,
      cta: 'Try again in a moment.',
    };
  }
  return null;
}
