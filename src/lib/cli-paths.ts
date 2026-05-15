/**
 * Persistence for user-supplied "I know where the CLI lives" paths.
 *
 * Pre-fix the onboarding `/onboard/validate-cli-path` endpoint validated
 * a custom path and returned `{ found: true, path: ... }` to the cockpit
 * — which only updated React state. The path was never persisted, so:
 *
 *   - Next daemon boot: cli-detect ran the bare PATH search and lost the
 *     hint entirely. CLIs in non-standard locations stayed undetected.
 *   - Reviewer spawns: never saw the path. Same "command not found" we
 *     hit in the launch smoke tests.
 *
 * This module closes the loop. The cockpit calls `/onboard/save-cli-path`
 * after validation succeeds; cli-detect.ts honours saved paths first
 * (with `source: 'manual'`); the headless spawn merges each saved path's
 * dirname into the runtime PATH.
 *
 * Storage shape: one settings row per CLI, keyed `cli_paths.<id>`. Value
 * is the absolute path string. We deliberately don't use a dedicated
 * table — the data is sparse, write-rarely, single-string, and lives
 * fine alongside other settings.
 */

import { settings } from './db/settings.js';

export type CliId =
  | 'claude-code'
  | 'codex-cli'
  | 'gemini-cli'
  | 'opencode-cli'
  | 'kimi-cli'
  | 'grok-cli';

const ALL_CLI_IDS: readonly CliId[] = [
  'claude-code',
  'codex-cli',
  'gemini-cli',
  'opencode-cli',
  'kimi-cli',
  'grok-cli',
] as const;

const keyFor = (id: CliId): string => `cli_paths.${id}`;

/**
 * Sync read-through cache. cli-detect.ts is synchronous (it's called
 * from many places that pre-date the async refactor) but the source of
 * truth lives in the async `settings` table. Boot calls
 * `refreshManualPathCache()` once to populate; sync callers read via
 * `getCached`. Tests / save endpoint call `refresh` again to invalidate.
 *
 * Empty string in DB = explicit clear; we treat as absent in the cache.
 */
const cache = new Map<CliId, string>();
let cacheLoaded = false;

export const cliPaths = {
  /** Save (or overwrite) a manual path for a CLI. Caller must validate. */
  async set(id: CliId, absolutePath: string): Promise<void> {
    await settings.set(keyFor(id), absolutePath);
    cache.set(id, absolutePath);
    cacheLoaded = true;
  },

  async get(id: CliId): Promise<string | null> {
    const raw = await settings.get(keyFor(id));
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  },

  async clear(id: CliId): Promise<void> {
    // settings has no delete; null-store via empty string + treat empty
    // as absent in `get`. Keeps the table cleanable without a schema add.
    await settings.set(keyFor(id), '');
    cache.delete(id);
  },

  /** Load every saved manual path. Used by buildRuntimeEnv() and chorus doctor. */
  async listAll(): Promise<Record<CliId, string | null>> {
    const out = {} as Record<CliId, string | null>;
    for (const id of ALL_CLI_IDS) {
      out[id] = await cliPaths.get(id);
    }
    return out;
  },

  /**
   * Sync lookup against the in-memory cache. Returns null when the cache
   * hasn't been hydrated yet — caller should treat that as "no manual
   * path" (the worst case is a bare PATH search, same as before this
   * feature shipped).
   */
  getCached(id: CliId): string | null {
    if (!cacheLoaded) return null;
    return cache.get(id) ?? null;
  },

  /**
   * List every cached manual path's directory. Drives PATH prepend in
   * runtime-path.ts so even a custom-location binary can be invoked by
   * bare name from a daemon-spawned subprocess.
   */
  cachedDirs(): string[] {
    if (!cacheLoaded) return [];
    return Array.from(cache.values()).map((abs) => abs.replace(/\/[^/]+$/, ''));
  },

  /**
   * Hydrate the sync cache from settings. Called once at daemon boot;
   * also called by the save/clear endpoints to ensure fresh reads. Safe
   * to call multiple times — wipes and repopulates.
   */
  async refreshCache(): Promise<void> {
    cache.clear();
    for (const id of ALL_CLI_IDS) {
      const raw = await settings.get(keyFor(id));
      if (typeof raw === 'string' && raw.length > 0) cache.set(id, raw);
    }
    cacheLoaded = true;
  },

  /** @internal — for tests that rebuild the DB across cases. */
  _resetCacheForTests(): void {
    cache.clear();
    cacheLoaded = false;
  },
};

export const KNOWN_CLI_IDS = ALL_CLI_IDS;
