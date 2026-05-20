/**
 * Settings + secrets routes.
 *
 * Covers four sub-namespaces: base settings (key/value), permissions
 * (sandbox profile + per-tool auto-approve), transport (headless vs tmux),
 * and billing mode (subscription vs API). All decoupled from the runner.
 */
import type { FastifyInstance } from 'fastify';
import { settings, secrets } from '../../lib/db/index.js';
import {
  successResponse,
  errorResponse,
  listEnvelope,
  sendError,
  type ApiResponse,
  type ListEnvelope,
} from '../api-response.js';

export function registerSettingsRoutes(fastify: FastifyInstance): void {
  // ─── Base settings (key/value bag) ───────────────────────────────────
  fastify.get<{ Reply: ApiResponse<object> }>('/settings', async () => {
    try {
      const allSettings = await settings.getAll();
      return successResponse(allSettings);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  fastify.put<{
    Body: Record<string, unknown>;
    Reply: ApiResponse<object>;
  }>('/settings', async (request) => {
    try {
      const updates = request.body;
      for (const [key, value] of Object.entries(updates)) {
        await settings.set(key, value);
      }
      return successResponse(await settings.getAll());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // ─── Permissions (sandbox + auto-approve + network) ──────────────────
  fastify.get<{ Reply: ApiResponse<object> }>(
    '/settings/permissions',
    async () => {
      try {
        const { getPermissions, PROFILE_DESCRIPTIONS } = await import(
          '../../lib/settings/permissions.js'
        );
        return successResponse({
          ...(await getPermissions()),
          profileDescriptions: PROFILE_DESCRIPTIONS,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return errorResponse('internal', message);
      }
    },
  );

  fastify.put<{
    Body: {
      sandboxProfile?: string;
      autoApprovePrompts?: boolean;
      networkAccess?: boolean;
    };
    Reply: ApiResponse<object>;
  }>('/settings/permissions', async (request) => {
    try {
      const { setPermissions } = await import('../../lib/settings/permissions.js');
      const body = request.body ?? {};
      const next = await setPermissions({
        ...(body.sandboxProfile !== undefined && {
          sandboxProfile: body.sandboxProfile as 'strict' | 'workspace' | 'full',
        }),
        ...(body.autoApprovePrompts !== undefined && {
          autoApprovePrompts: body.autoApprovePrompts,
        }),
        ...(body.networkAccess !== undefined && {
          networkAccess: body.networkAccess,
        }),
      });
      return successResponse(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('validation', message);
    }
  });

  // ─── Transport (headless vs tmux) ────────────────────────────────────
  fastify.get<{ Reply: ApiResponse<object> }>(
    '/settings/transport',
    async () => {
      try {
        const { getTransport, TRANSPORT_DESCRIPTIONS, TMUX_AVAILABLE } = await import(
          '../../lib/settings/transport.js'
        );
        return successResponse({
          transport: await getTransport(),
          descriptions: TRANSPORT_DESCRIPTIONS,
          // Lets the cockpit grey out the Tmux card on hosts without tmux —
          // the user gets the install hint up front instead of a 400 on click.
          tmuxAvailable: TMUX_AVAILABLE,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return errorResponse('internal', message);
      }
    },
  );

  fastify.put<{
    Body: { transport: 'headless' | 'tmux' };
    Reply: ApiResponse<object>;
  }>('/settings/transport', async (request) => {
    try {
      const { setTransport } = await import('../../lib/settings/transport.js');
      const body = request.body ?? ({} as { transport: 'headless' | 'tmux' });
      if (body.transport !== 'headless' && body.transport !== 'tmux') {
        return errorResponse('validation', 'transport must be "headless" or "tmux"');
      }
      return successResponse({ transport: await setTransport(body.transport) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('validation', message);
    }
  });

  // ─── Concurrency (daemon-wide CLI subprocess caps) ────────────────────
  fastify.get<{ Reply: ApiResponse<object> }>(
    '/settings/concurrency',
    async () => {
      try {
        const { getConcurrency, CLI_LINEAGES, _defaults } = await import(
          '../../lib/settings/concurrency.js'
        );
        return successResponse({
          ...(await getConcurrency()),
          // Surface the canonical CLI list + defaults so the cockpit
          // doesn't have to mirror them. Cockpit renders one input per
          // lineage; missing perCli keys fall through to defaults.
          cliLineages: CLI_LINEAGES,
          defaults: _defaults,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return errorResponse('internal', message);
      }
    },
  );

  fastify.put<{
    Body: { maxParallelCli?: number; perCli?: Record<string, number> };
    Reply: ApiResponse<object>;
  }>('/settings/concurrency', async (request) => {
    try {
      const { getConcurrency, setConcurrency, ConcurrencySchema } = await import(
        '../../lib/settings/concurrency.js'
      );
      const current = await getConcurrency();
      const body = request.body ?? {};
      // Merge incoming patch with current state — partial PUTs are
      // friendlier to the cockpit (it can save just the changed input
      // without having to round-trip the whole object).
      const merged = {
        maxParallelCli: body.maxParallelCli ?? current.maxParallelCli,
        perCli: { ...current.perCli, ...(body.perCli ?? {}) },
      };
      const validated = ConcurrencySchema.parse(merged);
      await setConcurrency(validated);
      return successResponse(validated);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('validation', message);
    }
  });

  // ─── Chat concurrency (daemon-wide max-active-chats + resource caps) ─
  // Distinct from cli-concurrency above: this caps the NUMBER OF CHATS
  // that can fan out reviewers simultaneously, plus refuses admission
  // when swap/load are under pressure. Added after the 2026-05-20
  // incident where 3 concurrent chats × 8 reviewers each crushed the
  // host (load 320, swap exhausted).
  fastify.get<{ Reply: ApiResponse<object> }>(
    '/settings/chat-concurrency',
    async () => {
      try {
        const { getChatConcurrency, _defaults } = await import(
          '../../lib/settings/chat-concurrency.js'
        );
        const { snapshot } = await import('../chat-gate.js');
        const { readResourceStats } = await import('../resource-stats.js');
        return successResponse({
          ...(await getChatConcurrency()),
          defaults: _defaults,
          // Live snapshot so the cockpit can show "currently 2/3 chats
          // active, swap 4200MB free, load/core 1.2" alongside the
          // sliders — actionable feedback rather than blind tuning.
          live: {
            ...snapshot(),
            ...readResourceStats(),
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return errorResponse('internal', message);
      }
    },
  );

  fastify.put<{
    Body: {
      maxConcurrentChats?: number;
      swapMinFreeMb?: number;
      loadAvgMaxPerCore?: number;
    };
    Reply: ApiResponse<object>;
  }>('/settings/chat-concurrency', async (request) => {
    try {
      const {
        getChatConcurrency,
        setChatConcurrency,
        ChatConcurrencySchema,
      } = await import('../../lib/settings/chat-concurrency.js');
      const current = await getChatConcurrency();
      const body = request.body ?? {};
      const merged = {
        maxConcurrentChats: body.maxConcurrentChats ?? current.maxConcurrentChats,
        swapMinFreeMb: body.swapMinFreeMb ?? current.swapMinFreeMb,
        loadAvgMaxPerCore: body.loadAvgMaxPerCore ?? current.loadAvgMaxPerCore,
      };
      const validated = ChatConcurrencySchema.parse(merged);
      await setChatConcurrency(validated);
      // Poke the gate so a loosened cap (3 → 5, or 1024MB → 512MB)
      // admits queued waiters immediately. Without this, queued chats
      // would wait for an active chat to finish before the new cap
      // takes effect — surprising UX. Convergent self-review (2/6
      // reviewers on PR #64) flagged the gap.
      const { pokeGate } = await import('../chat-gate.js');
      pokeGate();
      return successResponse(validated);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('validation', message);
    }
  });

  // ─── Telemetry (anonymous heartbeat opt-out) ─────────────────────────
  fastify.get<{ Reply: ApiResponse<object> }>(
    '/settings/telemetry',
    async () => {
      try {
        const { getTelemetryStatus } = await import('../../lib/telemetry.js');
        return successResponse(await getTelemetryStatus());
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return errorResponse('internal', message);
      }
    },
  );

  fastify.put<{
    Body: { enabled: boolean };
    Reply: ApiResponse<object>;
  }>('/settings/telemetry', async (request) => {
    try {
      const body = request.body ?? ({} as { enabled: boolean });
      if (typeof body.enabled !== 'boolean') {
        return errorResponse('validation', 'enabled must be a boolean');
      }
      const { setTelemetryEnabled } = await import('../../lib/telemetry.js');
      return successResponse(await setTelemetryEnabled(body.enabled));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('validation', message);
    }
  });

  // ─── Billing mode (subscription vs API) ──────────────────────────────
  fastify.get<{ Reply: ApiResponse<object> }>('/settings/billing', async () => {
    try {
      const { getBillingMode, BILLING_MODE_LABELS } = await import(
        '../../lib/settings/billing.js'
      );
      return successResponse({
        mode: await getBillingMode(),
        descriptions: BILLING_MODE_LABELS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('internal', message);
    }
  });

  fastify.put<{
    Body: { mode: 'api' | 'subscription' | 'mixed' };
    Reply: ApiResponse<object>;
  }>('/settings/billing', async (request) => {
    try {
      const { setBillingMode } = await import('../../lib/settings/billing.js');
      const body =
        request.body ?? ({} as { mode: 'api' | 'subscription' | 'mixed' });
      if (
        body.mode !== 'api' &&
        body.mode !== 'subscription' &&
        body.mode !== 'mixed'
      ) {
        return errorResponse(
          'validation',
          'mode must be "api" | "subscription" | "mixed"',
        );
      }
      return successResponse({ mode: await setBillingMode(body.mode) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('validation', message);
    }
  });
}

export function registerSecretRoutes(fastify: FastifyInstance): void {
  fastify.get<{ Reply: ApiResponse<ListEnvelope<object>> }>('/secrets', async () => {
    try {
      const items = await secrets.list();
      return successResponse(listEnvelope(items));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  fastify.put<{
    Params: { provider: string };
    Body: { value: string; kind: string; meta?: Record<string, unknown> };
    Reply: ApiResponse<object>;
  }>('/secrets/:provider', async (request, reply) => {
    try {
      const { provider } = request.params;
      const { value, kind, meta } = request.body;
      if (!value || !kind) {
        return sendError(reply, 'validation', 'value and kind are required');
      }
      await secrets.set(provider, kind as 'api_key' | 'cli_subscription', value, meta);
      return successResponse({ provider, kind, updated_at: Date.now() });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  /**
   * Idempotent secret rotation entry-point. Returns 200 with `{deleted}`
   * indicating whether a row actually existed. Cockpit uses this when the
   * user removes a saved API key from settings; pre-fix the only way to
   * rotate was hand-editing chorus.db.
   */
  fastify.delete<{
    Params: { provider: string };
    Reply: ApiResponse<{ provider: string; deleted: boolean }>;
  }>('/secrets/:provider', async (request) => {
    try {
      const { provider } = request.params;
      const deleted = await secrets.delete(provider);
      return successResponse({ provider, deleted });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });
}
