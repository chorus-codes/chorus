/**
 * System-level routes: blocked-chats list, CLI health snapshot, onboarding
 * helpers (CLI detection + manual path validation), orchestrator wiring
 * for the editors that drive chorus (Claude Code / Cursor / Codex / etc).
 *
 * Decoupled from the runner singleton; only the orchestrator-connect
 * endpoint needs the chorus binary path so the editor's MCP config can
 * point at the right entry script.
 */
import type { FastifyInstance } from 'fastify';
import { chats } from '../../lib/db/index.js';
import {
  successResponse,
  errorResponse,
  listEnvelope,
  type ApiResponse,
  type ListEnvelope,
} from '../api-response.js';

export interface SystemRouteDeps {
  /** Absolute path to bin/chorus.mjs — used by /orchestrators/:name/connect. */
  chorusBinPath: string;
  /** Daemon's own version string (from package.json at boot). Used by
   *  /update-check to compare against npm's `latest` dist-tag. */
  version: string;
}

// In-memory cache for the latest npm version. Tightened to 30 min after
// early-launch users complained banners lagged a release by hours. The
// dist-tags endpoint is tiny (~30 bytes); 30-min freshness is plenty
// generous and catches a same-day patch within one cockpit reload.
// Daemon restart busts the cache (in-process Map), so users who
// `chorus update` always see fresh state on first cockpit load.
const NPM_LATEST_TTL_MS = 30 * 60 * 1000;
let npmLatestCache: { value: string | null; fetchedAt: number } | null = null;

async function getCachedLatestVersion(
  fetcher: () => Promise<string | null>,
): Promise<string | null> {
  const now = Date.now();
  if (npmLatestCache && now - npmLatestCache.fetchedAt < NPM_LATEST_TTL_MS) {
    return npmLatestCache.value;
  }
  const value = await fetcher();
  npmLatestCache = { value, fetchedAt: now };
  return value;
}

export function registerSystemRoutes(
  fastify: FastifyInstance,
  deps: SystemRouteDeps,
): void {
  // List blocked chats — consumed by the MCP `list_blocked` tool. There
  // is no cockpit /blocked page today; older comments referenced one
  // that never landed.
  fastify.get<{ Reply: ApiResponse<ListEnvelope<object>> }>('/blocked', async () => {
    try {
      const items = await chats.list({ status: 'blocked' });
      return successResponse(listEnvelope(items));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // ─── Update availability check ────────────────────────────────────────
  // Polls npm's dist-tags endpoint (~30 bytes) and returns whether a
  // newer version of chorus-codes is on the registry. Cached in memory
  // for 4h to avoid hammering npm — the user's update cadence is days,
  // not minutes, so 4h freshness is plenty. The cockpit sidebar banner
  // calls this on mount; CLI's chorus-start checkForUpdate also already
  // reuses fetchLatestVersion from cli/commands/update.ts (same source).
  fastify.get<{
    Reply: ApiResponse<{
      current: string;
      latest: string | null;
      updateAvailable: boolean;
    }>;
  }>('/update-check', async () => {
    try {
      const { fetchLatestVersion, versionGreater } = await import(
        '../../cli/commands/update.js'
      );
      const current = deps.version;
      const latest = await getCachedLatestVersion(() =>
        fetchLatestVersion('chorus-codes'),
      );
      const updateAvailable =
        latest !== null && versionGreater(latest, current);
      return successResponse({ current, latest, updateAvailable });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('internal', message);
    }
  });

  // ─── CLI health snapshot ──────────────────────────────────────────────
  fastify.get<{ Reply: ApiResponse<ListEnvelope<object>> }>('/cli/health', async () => {
    try {
      const { getAllHealth } = await import('../../lib/cli-health.js');
      const items = await getAllHealth();
      return successResponse(listEnvelope(items));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('internal', message);
    }
  });

  // ─── Onboarding: detect installed CLIs + validate manual paths ────────
  fastify.get<{ Reply: ApiResponse<ListEnvelope<object>> }>(
    '/onboard/detect-clis',
    async () => {
      try {
        const { detectAllClis } = await import('../../lib/cli-detect.js');
        return successResponse(listEnvelope(detectAllClis()));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return errorResponse('internal', message);
      }
    },
  );

  fastify.post<{
    Body: { id: string; path: string };
    Reply: ApiResponse<object>;
  }>('/onboard/validate-cli-path', async (req) => {
    try {
      const { id, path: customPath } = req.body || {};
      if (!id || typeof customPath !== 'string') {
        return errorResponse('bad_request', 'id and path are required');
      }
      const { validateCliPath } = await import('../../lib/cli-detect.js');
      return successResponse(validateCliPath(id as never, customPath));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('internal', message);
    }
  });

  /**
   * Persist a validated manual CLI path so it survives daemon restarts
   * and is visible to subsequent reviewer spawns. Pre-fix the cockpit
   * just kept successful validations in React state — the next boot lost
   * the hint entirely (the bug the launch dogfood pass surfaced).
   *
   * Caller MUST validate via `/onboard/validate-cli-path` first; we
   * re-validate here as a safety net so a stale React state can't store
   * a path that no longer runs.
   */
  fastify.post<{
    Body: { id: string; path: string };
    Reply: ApiResponse<object>;
  }>('/onboard/save-cli-path', async (req) => {
    try {
      const { id, path: customPath } = req.body || {};
      if (!id || typeof customPath !== 'string') {
        return errorResponse('bad_request', 'id and path are required');
      }
      const { validateCliPath, clearDetectionCache } = await import(
        '../../lib/cli-detect.js'
      );
      const validation = validateCliPath(id as never, customPath);
      if (!validation.found) {
        return errorResponse(
          'validation',
          validation.reason ?? 'path failed validation',
        );
      }
      const { cliPaths } = await import('../../lib/cli-paths.js');
      await cliPaths.set(id as never, validation.path!);
      // Refresh sync caches so subsequent detection + spawns honour the
      // new path immediately, not after the next boot.
      await cliPaths.refreshCache();
      clearDetectionCache();
      // Also refresh the headless spawn PATH so the new dirname is
      // prepended without requiring a daemon restart.
      try {
        const { buildRuntimePath } = await import('../../lib/runtime-path.js');
        const { setSpawnPath } = await import('../headless.js');
        const merged = await buildRuntimePath({
          additionalDirs: cliPaths.cachedDirs(),
        });
        setSpawnPath(merged);
      } catch {
        /* spawn-path refresh is best-effort; spawnEnv() already
           prepends cli-paths cachedDirs at spawn time */
      }
      return successResponse({ id, path: validation.path });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('internal', message);
    }
  });

  /** Read every saved manual CLI path. Drives the cockpit's "saved" badge
   *  and `chorus doctor`. Empty values are omitted. */
  fastify.get<{ Reply: ApiResponse<object> }>(
    '/onboard/cli-paths',
    async () => {
      try {
        const { cliPaths } = await import('../../lib/cli-paths.js');
        const all = await cliPaths.listAll();
        const compact: Record<string, string> = {};
        for (const [id, p] of Object.entries(all)) {
          if (p) compact[id] = p;
        }
        return successResponse(compact);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return errorResponse('internal', message);
      }
    },
  );

  /** Forget a saved manual path. Cockpit calls this when the user
   *  clicks "use auto-detect instead". */
  fastify.delete<{
    Params: { id: string };
    Reply: ApiResponse<object>;
  }>('/onboard/cli-paths/:id', async (req) => {
    try {
      const { cliPaths } = await import('../../lib/cli-paths.js');
      const { clearDetectionCache } = await import('../../lib/cli-detect.js');
      await cliPaths.clear(req.params.id as never);
      clearDetectionCache();
      return successResponse({ id: req.params.id, cleared: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('internal', message);
    }
  });

  // ─── Orchestrators (editors that call chorus via MCP) ────────────────
  fastify.get<{ Reply: ApiResponse<ListEnvelope<object>> }>('/orchestrators', async () => {
    try {
      const { listOrchestrators } = await import('../orchestrators/index.js');
      return successResponse(listEnvelope(listOrchestrators()));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('internal', message);
    }
  });

  fastify.post<{
    Params: { name: string };
    Reply: ApiResponse<object>;
  }>('/orchestrators/:name/connect', async (request) => {
    try {
      const { connectByName, listOrchestrators } = await import(
        '../orchestrators/index.js'
      );
      const result = await connectByName(request.params.name, {
        binPath: deps.chorusBinPath,
      });
      const status = listOrchestrators().find(
        (o) => o.name === request.params.name,
      );
      return successResponse({ ...result, status });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('validation', message);
    }
  });

  // ─── OpenCode model discovery ────────────────────────────────────────
  // Lists models the local `opencode` CLI knows about, grouped by gateway
  // prefix (`opencode/`, `opencode-go/`, `opencode-zen/`). Used by the
  // onboarding flow so users can pick which subscription models they want
  // chorus to expose as voices.
  fastify.get<{
    Reply: ApiResponse<{
      gateways: Record<string, string[]>;
      flat: string[];
      defaultPicks: string[];
    }>;
  }>('/orchestrators/opencode/models', async () => {
    try {
      // Resolve the actual installed path rather than spawning bare
      // 'opencode' — when the daemon's $PATH doesn't include the
      // installer's bin dir (common: opencode lives at
      // ~/.opencode/bin, not in /usr/local/bin), bare lookup ENOENTs
      // even when detection found the binary fine.
      const { detectAllClis } = await import('../../lib/cli-detect.js');
      const opencode = detectAllClis().find((c) => c.id === 'opencode-cli');
      if (!opencode?.found || !opencode.path) {
        return errorResponse(
          'cli_failed',
          'opencode CLI not found on this host. Install from https://opencode.ai or set its path manually in onboarding.',
        );
      }
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);
      const { stdout } = await run(opencode.path, ['models'], { timeout: 10_000, shell: process.platform === 'win32' });
      const flat = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const gateways: Record<string, string[]> = {};
      for (const m of flat) {
        const slash = m.indexOf('/');
        const gw = slash > 0 ? m.slice(0, slash) : 'other';
        if (!gateways[gw]) gateways[gw] = [];
        gateways[gw].push(m);
      }
      // Fleet defaults — kimi + deepseek via Go subscription. Only suggest
      // those that actually appear in the user's `opencode models` output.
      const FLEET = ['opencode-go/kimi-k2.6', 'opencode-go/deepseek-v4-pro'];
      const defaultPicks = FLEET.filter((m) => flat.includes(m));
      return successResponse({ gateways, flat, defaultPicks });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('cli_failed', message);
    }
  });
}
