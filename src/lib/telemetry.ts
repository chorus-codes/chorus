/**
 * Opt-out telemetry heartbeat (round-2-deferred §4).
 *
 * Daemon-side ping to chorus.codes once per boot + once per 24h. The
 * payload is a fixed, audited shape — version, OS, arch, node major,
 * daemon uptime, count of chats in the last 24h. No chat content, no
 * file paths, no hostnames, no API keys.
 *
 * Three opt-out paths, any one disables:
 *   1. CHORUS_TELEMETRY=0 environment variable
 *   2. ~/.chorus/no-telemetry touch-file (matches cargo / brew convention)
 *   3. settings key `telemetry.enabled` set to false
 *
 * The endpoint may not exist yet — sends are fire-and-forget with a 5s
 * timeout; failure logs at debug level only and never blocks the daemon
 * or surfaces to the user. Schema-versioned (`schema: 1`) so future
 * payload changes are additive and old daemons keep working.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { settings, getDb } from './db/index.js';

export interface TelemetryPayload {
  schema: 2;
  installId: string;
  version: string;
  os: string;
  arch: string;
  node: string;
  daemonUptimeSeconds: number;
  chatsLast24h: number;
  // Activation-funnel fields (added in schema 2). Pre-launch we tracked
  // only `chatsLast24h`, which conflates "never fired" with "stopped
  // firing." With these we can compute time-to-first-chat (TTFC) and
  // separate "tried once and bounced" from "active for N days."
  /** First-boot timestamp (ms epoch). Set once per install on first daemon
   *  start; persisted to `~/.chorus/install-at`. Stable across upgrades. */
  installAt: number;
  /** Timestamp (ms epoch) of the install's first-ever chat creation, or
   *  `null` if no chat has been created yet. Persisted in the settings
   *  table; latched once. The 30-min activation window analysis depends
   *  on this. */
  firstChatFiredAt: number | null;
  /** Count of voices in the DB with `enabled = 1`. Tells us if the user
   *  has any usable reviewer at all — the cubed-it (#25) failure mode
   *  was 4 enabled voices out of 27 with a cross-lineage template that
   *  couldn't be satisfied. */
  voicesEnabled: number;
  /** Count of CLIs detected on PATH at heartbeat time (claude-code,
   *  codex, gemini, opencode, kimi). Distinguishes "no CLIs installed"
   *  from "CLIs installed but voices disabled". */
  clisDetected: number;
}

const ENDPOINT = 'https://chorus.codes/api/telemetry';
const SETTINGS_KEY = 'telemetry.enabled';
const FIRST_CHAT_KEY = 'telemetry.firstChatFiredAt';
const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SEND_TIMEOUT_MS = 5_000;

function chorusDir(): string {
  return path.join(os.homedir(), '.chorus');
}

function installIdPath(): string {
  return path.join(chorusDir(), 'install-id');
}

function installAtPath(): string {
  return path.join(chorusDir(), 'install-at');
}

function noTelemetryPath(): string {
  return path.join(chorusDir(), 'no-telemetry');
}

/** Common falsy strings users naturally type to mean "off". */
const ENV_DISABLE_VALUES = new Set(['0', 'false', 'no', 'off']);

/**
 * Check all three opt-out paths. Returns false if any one disables.
 * Settings DB is consulted last so env / touch-file work even when the
 * DB hasn't been opened yet (e.g. first-boot probe).
 *
 * `CHORUS_TELEMETRY` accepts any of `0`/`false`/`no`/`off` (case
 * insensitive); anything else leaves telemetry enabled. The variable
 * is a soft kill switch, not a strict on/off enum.
 */
export async function isTelemetryEnabled(): Promise<boolean> {
  const env = process.env.CHORUS_TELEMETRY;
  if (env !== undefined && ENV_DISABLE_VALUES.has(env.toLowerCase())) return false;
  if (fs.existsSync(noTelemetryPath())) return false;
  try {
    const raw = await settings.get(SETTINGS_KEY);
    if (raw === false) return false;
  } catch {
    // DB not ready — assume enabled at the per-call level. The boot
    // wiring won't hit this path because it runs after seedSettings().
  }
  return true;
}

export interface TelemetryStatus {
  /** Effective enabled state — what the next heartbeat will use. */
  enabled: boolean;
  /** True when CHORUS_TELEMETRY is set to a recognised disable value. */
  envOverride: boolean;
  /** True when ~/.chorus/no-telemetry exists. */
  fileOverride: boolean;
  /** Settings-DB value: true / false (explicit) / undefined (default-on). */
  settingValue: boolean | undefined;
  /** Endpoint the heartbeat targets. Surfaced for transparency. */
  endpoint: string;
}

/**
 * Detailed status used by the cockpit UI: same effective answer as
 * `isTelemetryEnabled` plus a breakdown of which path is winning, so the
 * settings page can explain "disabled by env var" rather than show a toggle
 * that secretly does nothing.
 */
export async function getTelemetryStatus(): Promise<TelemetryStatus> {
  const env = process.env.CHORUS_TELEMETRY;
  const envOverride =
    env !== undefined && ENV_DISABLE_VALUES.has(env.toLowerCase());
  const fileOverride = fs.existsSync(noTelemetryPath());
  let settingValue: boolean | undefined;
  try {
    const raw = await settings.get(SETTINGS_KEY);
    if (raw === true || raw === false) settingValue = raw;
  } catch {
    /* DB not ready — leave undefined */
  }
  const enabled =
    !envOverride && !fileOverride && settingValue !== false;
  return { enabled, envOverride, fileOverride, settingValue, endpoint: ENDPOINT };
}

/** Set the persisted opt-in flag. Env / file overrides still trump it. */
export async function setTelemetryEnabled(value: boolean): Promise<TelemetryStatus> {
  await settings.set(SETTINGS_KEY, value);
  return getTelemetryStatus();
}

/**
 * Read or mint an anonymous install ID. Lives in `~/.chorus/install-id`
 * as a single line; user can `rm` it to reset (a new UUID is minted on
 * the next call). Not derived from anything machine-specific.
 */
export function getOrCreateInstallId(): string {
  const dir = chorusDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = installIdPath();
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf-8').trim();
    // Tolerate manual edits / partial writes — only accept UUID-shaped
    // strings (any version); anything else gets replaced with a fresh ID
    // rather than failing the heartbeat. randomUUID() emits v4, but the
    // shape check is intentionally version-agnostic so a hand-edited v7
    // installId from a downstream tool keeps working.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing)) {
      return existing;
    }
  }
  const fresh = randomUUID();
  // 0o600 — readable + writable only by the daemon's user. Belt-and-
  // braces against ID correlation across users on a shared host.
  fs.writeFileSync(file, fresh + '\n', { mode: 0o600 });
  return fresh;
}

/**
 * Count chats created in the last 24 hours. Pure DB read; no chat
 * content, just a count of rows.
 */
export async function countChatsLast24h(now: number = Date.now()): Promise<number> {
  const cutoff = now - HEARTBEAT_INTERVAL_MS;
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM chats WHERE created_at >= ?',
    args: [cutoff],
  });
  const row = result.rows[0];
  if (!row) return 0;
  // libsql returns column values via row.n (object access) when columns
  // are aliased — index access is also valid. Be defensive across both.
  const raw = (row as Record<string, unknown>).n ?? (row as unknown as unknown[])[0];
  const n = typeof raw === 'bigint' ? Number(raw) : Number(raw ?? 0);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Read or mint the install's first-boot timestamp (ms epoch). Persisted
 * to `~/.chorus/install-at` so it survives daemon restarts AND chorus
 * upgrades — same lifetime semantics as `install-id`.
 *
 * Best-effort: every fs operation is guarded so a read-only $HOME,
 * ENOSPC, or permission error returns `Date.now()` rather than
 * propagating the throw to the heartbeat caller. Without this guard
 * a single fs failure took out the entire telemetry pipeline (not just
 * the new fields), which the chorus self-review caught as blocking.
 *
 * The malformed-file fallback mirrors `getOrCreateInstallId`: if the
 * file is corrupt, mint a fresh timestamp rather than crashing. The
 * analytics view simply counts that user as a new cohort starting from
 * the recovery date.
 */
export function getOrCreateInstallAt(): number {
  try {
    const dir = chorusDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = installAtPath();
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf-8').trim();
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    const fresh = Date.now();
    fs.writeFileSync(file, String(fresh) + '\n', { mode: 0o600 });
    return fresh;
  } catch {
    // Read-only $HOME / ENOSPC / permission error / race-on-mkdir —
    // return an in-memory timestamp so the heartbeat still goes out.
    // Loses install-age stability across restarts on this host, but
    // doesn't lose the entire payload.
    return Date.now();
  }
}

/**
 * Read the persisted "first chat fired at" timestamp. Returns null when
 * no chat has ever been created against this install. Best-effort: a DB
 * read failure resolves to null rather than throwing — telemetry must
 * never block a heartbeat.
 */
export async function getFirstChatFiredAt(): Promise<number | null> {
  try {
    const raw = await settings.get(FIRST_CHAT_KEY);
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
    return null;
  } catch {
    return null;
  }
}

/**
 * Latch the "first chat fired at" timestamp. Idempotent — only writes
 * the first time. Subsequent calls are no-ops, preserving the original
 * fire timestamp so TTFC analytics stay stable across re-runs.
 *
 * Called from POST /chats once we've confirmed a row was created. Best-
 * effort write — a DB failure is logged at debug level only and never
 * blocks the chat-create path.
 */
export async function markFirstChatFired(now: number = Date.now()): Promise<void> {
  try {
    const existing = await settings.get(FIRST_CHAT_KEY);
    if (typeof existing === 'number' && existing > 0) return;
    await settings.set(FIRST_CHAT_KEY, now);
  } catch {
    // Best-effort — never let telemetry-write block a chat creation.
  }
}

/**
 * Count voices currently enabled. Idx_voices_enabled covers this; on a
 * tiny voices table (<200 rows) it's sub-millisecond. Best-effort: a
 * read failure resolves to 0 so the heartbeat still goes out.
 */
export async function countEnabledVoices(): Promise<number> {
  try {
    const db = await getDb();
    const r = await db.execute('SELECT COUNT(*) AS n FROM voices WHERE enabled = 1');
    const row = r.rows[0];
    if (!row) return 0;
    const raw = (row as Record<string, unknown>).n ?? (row as unknown as unknown[])[0];
    const n = typeof raw === 'bigint' ? Number(raw) : Number(raw ?? 0);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

/**
 * Count detected CLIs on PATH (claude-code, codex, gemini, opencode,
 * kimi). Lazy-imports `cli-detect` so a heartbeat that fires before the
 * detection module is wired (extremely unlikely; defensive) still works.
 */
export async function countDetectedClis(): Promise<number> {
  try {
    const { detectAllClis } = await import('./cli-detect.js');
    const results = detectAllClis(true);
    return results.filter((d) => d.found).length;
  } catch {
    return 0;
  }
}

/**
 * Assemble the payload. Pure shape — easy to test against the spec.
 * `version` is read from package.json so a stale literal can't drift;
 * caller supplies it (the daemon already imports its own version).
 */
export async function buildPayload(args: {
  version: string;
  daemonStartedAt: number;
  now?: number;
}): Promise<TelemetryPayload> {
  const now = args.now ?? Date.now();
  // Node 'major' only — minor/patch leak less-useful detail and bloat
  // the analytics cardinality.
  const nodeMajor = process.versions.node.split('.')[0];
  return {
    schema: 2,
    installId: getOrCreateInstallId(),
    version: args.version,
    os: process.platform,
    arch: process.arch,
    node: nodeMajor,
    daemonUptimeSeconds: Math.max(0, Math.floor((now - args.daemonStartedAt) / 1000)),
    chatsLast24h: await countChatsLast24h(now),
    installAt: getOrCreateInstallAt(),
    firstChatFiredAt: await getFirstChatFiredAt(),
    voicesEnabled: await countEnabledVoices(),
    clisDetected: await countDetectedClis(),
  };
}

/**
 * Fire-and-forget POST. Honours all three opt-out paths. Never throws —
 * a dead endpoint, DB error during `buildPayload`, fs error during
 * `getOrCreateInstallId`, or any other failure resolves to `null`
 * rather than rejecting. Returns the sent payload on success so tests
 * can assert exact bytes without scraping log lines.
 *
 * Round-1 dogfood (PR #6) caught a bug here: `buildPayload` ran
 * outside the try/catch, so a transient libsql disconnect during
 * shutdown rejected the promise the daemon discarded with `void`,
 * producing an unhandled rejection. The whole body is now wrapped.
 */
export async function sendHeartbeat(args: {
  version: string;
  daemonStartedAt: number;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam — defaults to console.log("[telemetry] ..."). */
  log?: (msg: string) => void;
}): Promise<TelemetryPayload | null> {
  const log = args.log ?? ((m: string) => console.log(`[telemetry] ${m}`));
  try {
    if (!(await isTelemetryEnabled())) return null;

    const payload = await buildPayload({
      version: args.version,
      daemonStartedAt: args.daemonStartedAt,
    });

    const fetchFn = args.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      await fetchFn(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    log(`heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Boot wiring — fires once now (after a small delay so the daemon is
 * definitely listening) and then every 24h. Returns the interval handle
 * so the daemon can clear it on shutdown.
 */
export function startTelemetryHeartbeat(args: {
  version: string;
  daemonStartedAt: number;
  /** Test seam — defaults to setInterval. */
  setIntervalImpl?: typeof setInterval;
  /** Test seam — defaults to setTimeout. */
  setTimeoutImpl?: typeof setTimeout;
}): { stop: () => void } {
  const setIntervalFn = args.setIntervalImpl ?? setInterval;
  const setTimeoutFn = args.setTimeoutImpl ?? setTimeout;

  // Small delay on first send so the daemon is definitely up + the DB is
  // open. 5s is enough; the heartbeat itself has a 5s timeout.
  const bootHandle = setTimeoutFn(() => {
    void sendHeartbeat({ version: args.version, daemonStartedAt: args.daemonStartedAt });
  }, 5_000);

  const intervalHandle = setIntervalFn(() => {
    void sendHeartbeat({ version: args.version, daemonStartedAt: args.daemonStartedAt });
  }, HEARTBEAT_INTERVAL_MS);

  // Don't pin the event loop. If the daemon ever wants natural exit
  // (e.g. SIGTERM → fastify.close → drain pendings), telemetry timers
  // shouldn't keep it alive. The daemon also calls .stop() on signal,
  // so this is belt-and-braces.
  if (typeof (bootHandle as NodeJS.Timeout).unref === 'function') {
    (bootHandle as NodeJS.Timeout).unref();
  }
  if (typeof (intervalHandle as NodeJS.Timeout).unref === 'function') {
    (intervalHandle as NodeJS.Timeout).unref();
  }

  return {
    stop: () => {
      clearTimeout(bootHandle as NodeJS.Timeout);
      clearInterval(intervalHandle as NodeJS.Timeout);
    },
  };
}

// Test-only seams. These are exported under a stable namespace so the
// test file can mutate paths without touching `~/.chorus` on the host.
export const _testing = {
  installIdPath,
  installAtPath,
  noTelemetryPath,
  chorusDir,
  ENDPOINT,
  SETTINGS_KEY,
  FIRST_CHAT_KEY,
  HEARTBEAT_INTERVAL_MS,
  SEND_TIMEOUT_MS,
};
