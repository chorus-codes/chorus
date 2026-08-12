/**
 * Chorus daemon — Fastify HTTP server.
 *
 * Boots the DB, seeds builtin personas/voices/templates, registers route
 * groups, and starts the reaper. Routes live in `routes/*.ts`; the
 * runChat multi-subscriber wrapper lives in `runner-multiplex.ts`.
 */

import fastifyCors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import { chats, templates } from '../lib/db/index.js';
import { logger } from '../lib/logger.js';
import { ErrorDetector } from './error-detector.js';
import { startReaper } from './reaper.js';
import { activeRunsCount, activeRunsSnapshot } from './runner-multiplex.js';
import { registerChatRoutes } from './routes/chats.js';
import { registerChatEventsRoute } from './routes/chats-events.js';
import { registerOpenRouterRoutes } from './routes/openrouter.js';
import {
  registerPersonaRoutes,
  registerTemplateRoutes,
} from './routes/templates-personas.js';
import {
  registerSecretRoutes,
  registerSettingsRoutes,
} from './routes/settings.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerVoiceRoutes } from './routes/voices.js';
import { TmuxManagerImpl } from './tmux.js';
import {
  errorResponse,
  successResponse,
  type ApiResponse,
} from './api-response.js';

export { getParsedTemplate } from './template-cache.js';
export { isValidChatId } from './routes/chats.js';

/**
 * Resolve daemon port from env, with hard validation. parseInt('chorus', 10)
 * silently returns NaN, which Fastify accepts as "let the OS pick a port" —
 * the daemon would start, bind to a random port, and the cockpit would
 * never find it. Catch this at boot with a useful error message instead.
 */
function resolveDaemonPort(): number {
  const raw = process.env.CHORUS_DAEMON_PORT;
  if (!raw) return 7707;
  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `CHORUS_DAEMON_PORT must be an integer between 1 and 65535. Got: ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

const PORT = resolveDaemonPort();
const HOST = '127.0.0.1';
// Read version from the shipped package.json so it can never drift from
// `package.json#version`. __dirname is dist/daemon (built) or src/daemon
// (tsx dev); ../../package.json lands at the package root in both layouts.
const VERSION: string = (() => {
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const startTime = Date.now();

// Absolute path to bin/chorus.mjs — used by /orchestrators/:name/connect
// when the cockpit triggers a one-click wire-up. Both src/daemon/index.ts
// (tsx) and dist/daemon/index.js (PM2/built) resolve to <pkg-root>/bin/
// chorus.mjs.
const CHORUS_BIN_PATH = path.resolve(__dirname, '..', '..', 'bin', 'chorus.mjs');

// Singletons shared across the daemon lifetime.
let tmuxMgr: TmuxManagerImpl;
let stopReaper: (() => void) | null = null;
const errorDetector = new ErrorDetector();

async function main(): Promise<void> {
  // Eager DB probe: trying to open the sqlite file at startup catches
  // permission errors, schema-migration crashes, and missing-init
  // issues *before* the first HTTP request fails opaquely.
  try {
    await chats.list({ limit: 1 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
     
    console.error(
      `\n[chorus] Could not open database. Run \`chorus init\` first, ` +
        `or check permissions on ~/.chorus/chorus.db.\n  detail: ${msg}\n`,
    );
    process.exit(1);
  }

  const fastify = Fastify({ logger: false });

  // CORS allowlist follows the cockpit port that `chorus start` chose
  // (via CHORUS_COCKPIT_PORT). The legacy 5050 default is preserved as
  // a fallback for installs that haven't migrated to v0.8 daemon.json.
  const cockpitPort = (() => {
    const raw = process.env.CHORUS_COCKPIT_PORT;
    if (!raw) return 5050;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 && n < 65536 ? n : 5050;
  })();
  await fastify.register(fastifyCors, {
    origin: [`http://127.0.0.1:${cockpitPort}`],
    credentials: true,
  });

  // Seed built-in personas from prompts/personas/*.md. Idempotent:
  // builtin rows refresh from the file source of truth on every
  // startup; user-created rows (builtin=0) are not touched.
  try {
    const { seedBuiltinPersonas } = await import('../lib/personas.js');
    const count = await seedBuiltinPersonas();
     
    console.log(`[daemon] seeded ${count} built-in personas`);
  } catch (err) {
    // Non-fatal: daemon still works without personas.
     
    console.warn('[daemon] persona seed failed:', err instanceof Error ? err.message : err);
  }

  // Prime the merged spawn PATH BEFORE voice seed. seedCliVoices runs
  // detectAllClis(), which honours saved manual paths via the cli-paths
  // cache; without priming, the cache is empty and a custom-location
  // CLI shows up as undetected on the first boot after the user pasted
  // its path into onboarding.
  try {
    const { buildRuntimePath } = await import('../lib/runtime-path.js');
    const { cliPaths } = await import('../lib/cli-paths.js');
    const { setSpawnPath } = await import('./headless.js');
    await cliPaths.refreshCache();
    const merged = await buildRuntimePath({
      additionalDirs: cliPaths.cachedDirs(),
    });
    setSpawnPath(merged);
     
    console.log(`[daemon] runtime PATH primed (${merged.split(':').length} dirs)`);
  } catch (err) {
     
    console.warn(
      '[daemon] runtime PATH prime failed (falling back to process.env.PATH):',
      err instanceof Error ? err.message : err,
    );
  }

  // Voices Phase 1 — synchronous, pre-listen seed of single-model CLIs
  // + first-boot migration from <lineage>.enabled_models. Fast (no
  // shell-outs); blocks listen on intent (we want voices ready before
  // routes serve).
  try {
    const { seedCliVoices } = await import('../lib/voices.js');
    const result = await seedCliVoices();
     
    console.log(
      `[daemon] voices Phase 1: +${result.added} added, ${result.updated} updated, ${result.disabled} auto-disabled`,
    );
  } catch (err) {
     
    console.warn(
      '[daemon] voices Phase 1 seed failed:',
      err instanceof Error ? err.message : err,
    );
  }

  // ─── Routes ─────────────────────────────────────────────────────────
  //
  // Every public REST + SSE route mounts under /api/v1. Pre-launch
  // shape-freeze (v0.7) — adding /api/v2 later is non-breaking.
  //
  // Bare paths (`/health`, `/chats`, ...) are kept as transitional
  // aliases for one minor (v0.7) so that globally-installed MCP servers
  // shipping older chorus-codes versions don't break the moment a user
  // upgrades the daemon. Callers should migrate to /api/v1; the bare
  // paths are dropped in v0.8.
  // Initialize tmux manager BEFORE registering chat routes — the chat
  // route handlers capture it for the duration of the daemon.
  tmuxMgr = new TmuxManagerImpl();

  const registerAll = (api: FastifyInstance): void => {
    api.get<{
      Reply: ApiResponse<{ version: string; uptime: number }>;
    }>('/health', async () => {
      // The redundant inner `ok: true` from earlier shipped versions
      // was dropped here — the envelope's outer `ok: true` is the
      // canonical liveness signal. Consumers that want a flat
      // monitor-friendly probe still read `data.version` /
      // `data.uptime`.
      return successResponse({
        version: VERSION,
        uptime: Date.now() - startTime,
      });
    });

    registerChatRoutes(api, { tmuxMgr: tmuxMgr!, errorDetector });
    registerChatEventsRoute(api);
    registerTemplateRoutes(api);
    registerPersonaRoutes(api);
    registerSettingsRoutes(api);
    registerSecretRoutes(api);
    registerSystemRoutes(api, { chorusBinPath: CHORUS_BIN_PATH, version: VERSION });
    registerVoiceRoutes(api);
    registerOpenRouterRoutes(api);
    registerStatsRoutes(api);
  };

  await fastify.register(async (api) => registerAll(api), { prefix: '/api/v1' });
  // v0.7 transitional aliases — drop in v0.8.
  await fastify.register(async (api) => registerAll(api));

  await seedBuiltinTemplates();

  // Reap orphan headless subprocesses from any prior daemon crash.
  // Without this, a hung CLI from a previous run keeps burning
  // subscription quota until manually killed.
  try {
    const { reapOrphanProcesses } = await import('./headless.js');
    const result = reapOrphanProcesses();
    if (result.reaped > 0 || result.cleared > 0) {
      console.log(
        `[chorus] reaper: killed ${result.reaped} orphan headless processes, cleared ${result.cleared} stale records`,
      );
    }
  } catch (err) {
    // Non-fatal — orphan cleanup is best-effort.
    console.warn('[chorus] reaper: failed to scan PID dir', err);
  }

  stopReaper = startReaper(
    tmuxMgr,
    async () => {
      // getActiveChats: chatId → status for active chats only (drafting
      // and reviewing). Terminal states are reaped.
      const allChats = await chats.list({ limit: 1000, offset: 0 });
      const activeMap = new Map<string, string>();
      const activeStatuses = new Set(['drafting', 'reviewing']);
      for (const chat of allChats) {
        if (activeStatuses.has(chat.status)) {
          activeMap.set(chat.id, chat.status);
        }
      }
      return activeMap;
    },
    {
      intervalMs: 5 * 60 * 1000,
      idleDestroyMinutes: 30,
    },
  );

  // ─── Graceful shutdown ──────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    if (activeRunsCount() > 0) {
      const runs = activeRunsSnapshot();
      for (const entry of runs) {
        entry.abortController.abort();
      }
      try {
        await Promise.race([
          Promise.allSettled(runs.map((e) => e.promise)),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout waiting for active runs')), 10000),
          ),
        ]);
        console.log(`[chorus] aborted ${runs.length} active runs (${signal})`);
      } catch {
        console.warn('[chorus] timeout or error waiting for active runs to abort');
      }
    }
    if (stopReaper) stopReaper();
    await fastify.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await fastify.listen({ port: PORT, host: HOST });
  logger.info({ port: PORT, host: HOST, version: VERSION }, 'daemon listening');
  // Keep the human-readable startup line — the install script +
  // onboarding grep for it. Structured line above is what `chorus logs`
  // consumes.
  console.log(`Chorus daemon listening on http://${HOST}:${PORT}`);

  // Anonymous opt-out telemetry. First send is delayed 5s so the
  // listener is definitely up; subsequent sends every 24h. All three
  // opt-out paths (env, touch-file, settings) are honoured per send.
  const { startTelemetryHeartbeat } = await import('../lib/telemetry.js');
  const telemetryHandle = startTelemetryHeartbeat({
    version: VERSION,
    daemonStartedAt: startTime,
  });
  process.on('SIGTERM', () => telemetryHandle.stop());
  process.on('SIGINT', () => telemetryHandle.stop());

  // Voices Phase 2 — background warmup. `opencode models` shells out
  // and can take up to 10s; running it post-listen avoids that boot-
  // latency hit. Errors are logged but don't crash the daemon.
  void (async () => {
    try {
      const { seedOpencodeVoicesAsync } = await import('../lib/voices.js');
      const result = await seedOpencodeVoicesAsync();
      if (result) {
        console.log(
          `[daemon] voices Phase 2 (opencode): +${result.added} added, ${result.updated} updated, ${result.disabled} auto-disabled`,
        );
        // Re-adapt builtin templates so newly-detected opencode voices
        // can fill template slots that were left blank by Phase 1.
        // Idempotent: if Phase 1 already filled everything, this is a
        // no-op. The cost is one disk read per template + zero DB
        // writes when nothing changed.
        if (result.added > 0 || result.updated > 0) {
          try {
            await seedBuiltinTemplates();
            console.log('[daemon] templates re-adapted after Phase 2 voice seed');
          } catch (err) {
            console.warn(
              '[daemon] template re-adapt after Phase 2 failed:',
              err instanceof Error ? err.message : err,
            );
          }
        }
      } else {
        console.log(
          '[daemon] voices Phase 2 (opencode): skipped (CLI not detected or shell-out failed)',
        );
      }

      // Antigravity's catalog is a ~3s network fetch (`agy models`), so it
      // rides the same post-listen pass rather than the boot path. Runs
      // after opencode so a slow agy can't delay those rows.
      const { seedAntigravityVoicesAsync } = await import('../lib/voices.js');
      const agy = await seedAntigravityVoicesAsync();
      if (agy) {
        console.log(
          `[daemon] voices Phase 2 (antigravity): +${agy.added} added, ${agy.updated} updated, ${agy.disabled} auto-disabled`,
        );
      } else {
        console.log(
          '[daemon] voices Phase 2 (antigravity): skipped (CLI not detected or probe failed)',
        );
      }
    } catch (err) {
      console.warn(
        '[daemon] voices Phase 2 failed:',
        err instanceof Error ? err.message : err,
      );
    }
  })();
}

async function seedBuiltinTemplates(): Promise<void> {
  const templatesDir = path.join(__dirname, '..', '..', 'templates');

  if (!fs.existsSync(templatesDir)) {
    console.log('No templates directory found, skipping seed');
    return;
  }

  const files = fs.readdirSync(templatesDir).filter((f) => f.endsWith('.yaml'));
  const onDiskIds = new Set<string>();

  // Load the user's enabled voices once. The adapter rewrites slot
  // model lists to the voices the user actually has — substitutes
  // missing lineages with diversity-preserving alternatives, leaves
  // truly-empty slots blank and flags the template incomplete.
  const { voices: voicesDb } = await import('../lib/db/index.js');
  const userVoices = await voicesDb.list();
  const { adaptTemplate } = await import('./template-adapter.js');

  for (const file of files) {
    const id = file.replace('.yaml', '');
    onDiskIds.add(id);
    const yamlPath = path.join(templatesDir, file);
    const yamlContent = fs.readFileSync(yamlPath, 'utf-8');

    // Adapt to user's voice fleet. Pure function — same input/voices
    // → same output, so re-running on every boot is idempotent unless
    // the voice set actually changed.
    const adapted = adaptTemplate(yamlContent, userVoices);

    const existing = await templates.getById(id);

    if (!existing) {
      await templates.create(id, adapted.yaml, 'builtin', adapted.isComplete);
      console.log(
        `[daemon] seeded template: ${id}${adapted.isComplete ? '' : ' (incomplete — needs setup)'}`,
      );
      continue;
    }

    // Re-sync builtin rows. Two reasons to refresh:
    //   1. Disk content changed (chorus upgrade brought a new template).
    //   2. Adapter output changed (user enabled/disabled CLIs since
    //      last boot).
    // User-cloned rows (source='user') are NEVER overwritten.
    const yamlChanged = existing.yaml !== adapted.yaml;
    const completenessChanged = existing.is_complete !== adapted.isComplete;
    if (existing.source === 'builtin' && (yamlChanged || completenessChanged)) {
      await templates.create(id, adapted.yaml, 'builtin', adapted.isComplete);
      console.log(
        `[daemon] refreshed builtin template: ${id}${adapted.isComplete ? '' : ' (incomplete)'}`,
      );
    }
  }

  // Flag any builtin templates that are no longer present on disk.
  // templates.delete is exposed by the DB layer but the loop only logs
  // intent today — refresh-on-disk-change keeps content fresh, and
  // stale rows are inert (just don't appear in templatesDir). Tracked
  // outside the libsql migration scope.
  try {
    const allTemplates = await templates.list();
    let staleCount = 0;
    for (const tmpl of allTemplates) {
      if (tmpl.source === 'builtin' && !onDiskIds.has(tmpl.id)) {
        console.log(`[daemon] would delete stale builtin template (no delete method): ${tmpl.id}`);
        staleCount++;
      }
    }
    if (staleCount > 0) {
      console.log(`[daemon] flagged ${staleCount} stale builtin templates for cleanup`);
    }
  } catch (err) {
    // Non-fatal: if templates.list() fails, skip cleanup.
    console.warn('[daemon] failed to scan stale builtin templates:', err);
  }
}

// Auto-run main() only when this file is the process entry point. When
// the daemon module is imported from a test (e.g.
// tests/template-cache.test.ts importing the exported getParsedTemplate),
// we don't want a side-effecty fastify boot or DB probe firing on module
// load.
const isEntryPoint = typeof require !== 'undefined' && require.main === module;

if (isEntryPoint) {
  main().catch((error) => {
    console.error('Failed to start daemon:', error);
    process.exit(1);
  });
}

/**
 * @internal — for tests / cross-module daemon code. Throws if called
 * before main() has wired the singleton.
 */
export function getTmuxManager(): TmuxManagerImpl {
  if (!tmuxMgr) {
    throw new Error('TmuxManager not initialized. Daemon may not have started yet.');
  }
  return tmuxMgr;
}

// `successResponse`/`errorResponse` re-exports for any straggling
// importer that pulled the helpers via `daemon/index`. Keep them here
// so a future module split doesn't need to chase down the type imports.
export { errorResponse, successResponse, type ApiResponse };
