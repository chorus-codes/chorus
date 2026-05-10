import type { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { chats, phaseEvents, templates } from '../../lib/db/index.js';
import { chatLogger, logger } from '../../lib/logger.js';
import {
  TemplateSchema,
  isReviewOnlyPhase,
  templateRequiresArtifact,
} from '../../lib/template-schema.js';
import {
  errorResponse,
  listEnvelope,
  sendError,
  successResponse,
  type ApiResponse,
  type ListEnvelope,
} from '../api-response.js';
import type { ErrorDetector } from '../error-detector.js';
import * as participantAborts from '../participant-aborts.js';
import {
  abortActiveRun,
  getActiveRun,
  runWithMultiplex,
} from '../runner-multiplex.js';
import type { TmuxManager } from '../tmux-types.js';
import { registerChatStreamRoute } from './chats-stream.js';
import { isValidChatId } from './chats-validation.js';

export { isValidChatId };

const TERMINAL_STATUSES = [
  'approved',
  'merged',
  'blocked',
  'cancelled',
  'failed',
  'no_review',
] as const;
type ChatStatus = (typeof TERMINAL_STATUSES)[number] | 'drafting' | 'reviewing';
type PhaseKind =
  | 'plan'
  | 'spec'
  | 'tests'
  | 'implement'
  | 'review'
  | 'verify'
  | 'divergence'
  | 'review_only';

const VALID_PHASE_KINDS: readonly PhaseKind[] = [
  'plan',
  'spec',
  'tests',
  'implement',
  'review',
  'verify',
  'divergence',
];

interface RegisterChatRoutesArgs {
  tmuxMgr: TmuxManager;
  errorDetector: ErrorDetector;
}

export function registerChatRoutes(
  fastify: FastifyInstance,
  { tmuxMgr, errorDetector }: RegisterChatRoutesArgs,
): void {
  fastify.get<{
    Querystring: { status?: string; limit?: string; offset?: string };
    Reply: ApiResponse<ListEnvelope<object>>;
  }>('/chats', async (request) => {
    try {
      const { status, limit, offset } = request.query;
      const list = await chats.list({
        status: status || undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      });
      return successResponse(listEnvelope(list));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  fastify.get<{
    Params: { id: string };
    Reply: ApiResponse<object>;
  }>('/chats/:id', async (request, reply) => {
    try {
      if (!isValidChatId(request.params.id)) {
        return sendError(reply, 'validation', 'invalid chat id');
      }
      const chat = await chats.getBySlugOrId(request.params.id);
      if (!chat) {
        return sendError(reply, 'not_found', `Chat ${request.params.id} not found`);
      }
      // phaseEvents.list keys by ULID, not slug. Use the resolved row's
      // id so a /chats/<slug> request returns events correctly.
      const events = await phaseEvents.list(chat.id);
      return successResponse({ ...chat, events });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  fastify.post<{
    Body: {
      work: string;
      templateId: string;
      files?: string[];
      repoPath?: string;
      artifact?: string;
      yolo?: boolean;
    };
    Reply: ApiResponse<object>;
  }>('/chats', async (request, reply) => {
    try {
      const { work, templateId, files, repoPath, artifact, yolo } = request.body;

      if (!work || !templateId) {
        return sendError(reply, 'validation', 'work and templateId are required');
      }

      // Validate repoPath — must be an absolute path to an existing
      // directory.
      //
      // Symlink handling (Audit D2 BLOCKER): pre-fix `existsSync`
      // followed symlinks silently, so a `repoPath` pointing at
      // `~/innocent-link → /etc` would pass and the doer would spawn
      // with `cwd=/etc`. We realpath-resolve and re-check the target
      // is a directory. Storing the canonical path means a later swap
      // of the symlink can't redirect the doer.
      //
      // Stricter checks (is-a-repo, gh-authed) happen when the ship
      // phase runs.
      // Resolve `repoPath` to its canonical (symlink-followed) form once
      // so we can persist the canonical path on the chat row. Pre-fix
      // we validated via realpath but stored the original `repoPath`,
      // leaving the symlink-swap attack surface from Audit D2 partially
      // open: a later swap of `~/innocent-link → /etc` would still
      // redirect the runner. `canonicalRepoPath` is undefined when no
      // repoPath was supplied — the chat creates without one.
      let canonicalRepoPath: string | undefined;
      if (repoPath !== undefined) {
        if (typeof repoPath !== 'string' || !path.isAbsolute(repoPath)) {
          return sendError(reply, 'validation', 'repoPath must be an absolute path');
        }
        const resolved = path.resolve(repoPath);
        try {
          // realpathSync resolves symlinks AND verifies the path
          // exists. Throws ENOENT if either link or target is missing.
          canonicalRepoPath = fs.realpathSync(resolved);
        } catch {
          return sendError(reply, 'validation', `repoPath does not exist: ${resolved}`);
        }
        let stat: fs.Stats;
        try {
          stat = fs.statSync(canonicalRepoPath);
        } catch {
          return sendError(
            reply,
            'validation',
            `repoPath does not exist: ${canonicalRepoPath}`,
          );
        }
        if (!stat.isDirectory()) {
          return sendError(
            reply,
            'validation',
            `repoPath must be a directory: ${canonicalRepoPath}`,
          );
        }
      }

      // C4 — template existence check is the daemon-side invariant (the
      // MCP layer also validates, but only this check is authoritative).
      // Pre-fix, an unknown templateId silently fell through to chat
      // creation and the runner stalled looking up a row that didn't
      // exist; the user saw a chat stuck in 'drafting' forever.
      const tmpl = await templates.getById(templateId);
      if (!tmpl) {
        const valid = (await templates.list()).map((t) => t.id);
        return sendError(
          reply,
          'not_found',
          `Unknown templateId "${templateId}". Valid IDs: ${valid.join(', ')}`,
          { validIds: valid },
        );
      }
      // Refuse to create a chat off an incomplete template — the seed
      // adapter couldn't fill at least one slot from the user's voices.
      // Without this gate, the runner stalls when it hits the empty
      // models[] array and the user sees a confusing "no model
      // available" error mid-run.
      if (!tmpl.is_complete) {
        return sendError(
          reply,
          'validation',
          `Template "${templateId}" needs setup — at least one slot has no models. Edit the YAML to assign models for your fleet.`,
        );
      }

      // Parse the template up-front so we can branch on review-only vs
      // standard. Two reads of the same template are tolerable (this
      // path is request-scoped, not hot); the alternative is hand-rolling
      // YAML parsing twice in the same handler.
      let initialPhaseKind: PhaseKind = 'plan';
      let parsedTemplateForArtifactCheck: ReturnType<typeof TemplateSchema.parse> | null = null;
      try {
        const rawParsed = yaml.parse(tmpl.yaml);
        const safe = TemplateSchema.safeParse(rawParsed);
        if (safe.success) {
          parsedTemplateForArtifactCheck = safe.data;
          const firstKind = safe.data.phases[0]?.kind;
          initialPhaseKind = firstKind as PhaseKind;
        } else {
          // Fall back to a loose read so older malformed templates
          // still produce an initial event with their declared kind.
          const loose = rawParsed as { phases?: Array<{ kind?: string }> } | undefined;
          const firstKind = loose?.phases?.[0]?.kind;
          if (firstKind === 'review_only') initialPhaseKind = 'review_only';
          else if (
            typeof firstKind === 'string' &&
            (VALID_PHASE_KINDS as readonly string[]).includes(firstKind)
          ) {
            initialPhaseKind = firstKind as PhaseKind;
          }
        }
      } catch {
        /* fall through with 'plan' default */
      }

      // Artifact validation — only meaningful for review-only templates.
      if (
        parsedTemplateForArtifactCheck &&
        templateRequiresArtifact(parsedTemplateForArtifactCheck)
      ) {
        if (typeof artifact !== 'string' || artifact.trim().length === 0) {
          return sendError(
            reply,
            'validation',
            'artifact is required for review-only templates',
          );
        }
        const firstPhase = parsedTemplateForArtifactCheck.phases[0];
        if (firstPhase && isReviewOnlyPhase(firstPhase)) {
          const maxBytes = firstPhase.artifact.maxBytes;
          const byteLen = Buffer.byteLength(artifact, 'utf-8');
          if (byteLen > maxBytes) {
            return sendError(
              reply,
              'validation',
              `artifact exceeds template limit (${byteLen} bytes > ${maxBytes} bytes)`,
            );
          }
        }
      } else if (artifact !== undefined && artifact !== null && artifact !== '') {
        // Non-review-only templates: artifact is meaningless. Reject
        // loudly so callers don't silently lose payload (e.g. mistyped
        // templateId pointing at a full-pipeline template).
        return sendError(
          reply,
          'validation',
          'artifact is only valid for review-only templates',
        );
      }

      const chat = await chats.create({
        work,
        template_id: templateId,
        attached_files: files ? JSON.stringify(files) : undefined,
        // Persist the canonical (realpath-resolved) repo path so a
        // later swap of an intermediate symlink can't redirect the
        // doer's cwd. See Audit D2 BLOCKER for the attack scenario.
        repo_path: canonicalRepoPath,
        artifact: artifact ?? undefined,
        yolo: yolo === true,
      });

      await phaseEvents.create({
        chat_id: chat.id,
        phase_idx: 0,
        phase_kind: initialPhaseKind,
        role: 'doer',
        agent_id: null,
        state: 'drafting',
        output: null,
        cost_usd: 0,
        tokens_in: 0,
        tokens_out: 0,
        started_at: Date.now(),
        finished_at: null,
      });

      chatLogger(chat.id).info(
        {
          templateId,
          phaseKind: initialPhaseKind,
          requestId: request.id,
          hasArtifact: artifact !== undefined && artifact !== null && artifact !== '',
          hasRepoPath: repoPath !== undefined,
          attachedFileCount: files?.length ?? 0,
        },
        'chat created',
      );

      // Latch the install's first-ever chat-fire timestamp for telemetry
      // activation analytics. Idempotent — only writes the first time.
      // Fire-and-forget: a settings-write failure must not block the
      // chat-create path. Lazy-imported to keep this route's import
      // graph minimal and tolerant of telemetry-disabled builds.
      void (async () => {
        try {
          const { markFirstChatFired } = await import('../../lib/telemetry.js');
          await markFirstChatFired();
        } catch {
          /* never block chat creation on telemetry */
        }
      })();

      // Auto-fire the runner. Earlier code left chats inert until a
      // client hit /chats/:id/stream — fine for the cockpit (the run
      // page subscribes on open), but the MCP path (autonomous batch
      // reviews, scripts) had no way to trigger the run without a curl-
      // trigger workaround. Fire-and-forget; the SSE route still attaches
      // to the existing activeRuns entry rather than re-creating one.
      //
      // Skip when:
      //   - template parsing failed (nothing valid to run)
      //   - chat is already in a terminal state (defensive — a fresh
      //     row should always be drafting; rules out manual DB seeds and
      //     replay bugs)
      //
      // `yolo: false` is NOT checked because chat.status has no
      // pre-run/pending state to pause at — yolo today only gates ship.
      if (
        parsedTemplateForArtifactCheck &&
        !(TERMINAL_STATUSES as readonly string[]).includes(chat.status)
      ) {
        // Chain `.catch` so an async rejection inside runChat doesn't
        // escape as an unhandled promise rejection (Node.js >= 15
        // terminates the process on those).
        const entry = runWithMultiplex({
          chatId: chat.id,
          template: parsedTemplateForArtifactCheck,
          chat,
          tmuxMgr,
          errorDetector,
        });
        entry.promise.catch((err: unknown) => {
          chatLogger(chat.id).error(
            { err: err instanceof Error ? err.message : String(err) },
            'auto-fired chat runner failed',
          );
        });
      }

      return successResponse(chat);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        { requestId: request.id, err: message, route: 'POST /chats' },
        'chat create failed',
      );
      return errorResponse('db_error', message);
    }
  });

  fastify.post<{
    Params: { id: string };
    Reply: ApiResponse<object>;
  }>('/chats/:id/cancel', async (request, reply) => {
    try {
      const param = request.params.id;
      if (!isValidChatId(param)) {
        return sendError(reply, 'validation', 'invalid chat id');
      }
      // Resolve slug → ULID first. Cancel/abort/tmux all key by ULID.
      const existing = await chats.getBySlugOrId(param);
      if (!existing) {
        return sendError(reply, 'not_found', `Chat ${param} not found`);
      }
      const chatId = existing.id;
      const chat = await chats.cancel(chatId);

      // Abort the active runner if there is one. This propagates into
      // the runChat abortListener which fires chat_done(cancelled) once
      // (latched by emitChatDone) — including killing any LLM CLI
      // subprocesses via their AbortSignal. Without this, cancel only
      // flipped the DB row and the runner kept burning tokens until
      // natural termination.
      abortActiveRun(chatId);

      // Kill any tmux sessions associated with this chat (legacy transport).
      const allSessions = tmuxMgr.list();
      for (const session of allSessions) {
        if (session.chatId === chatId) {
          tmuxMgr.kill(session.name);
        }
      }

      return successResponse(chat);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // Cancel a single participant (one reviewer or the doer) without
  // collapsing the entire chat. Useful when one runner is stuck or the
  // user wants to drop a low-value reviewer mid-flight.
  //
  // Path: POST /chats/:id/participants/:key/cancel
  // `key` matches participantAborts.participantKey:
  //   `doer-<agentName>` or `reviewer-<agentName>-<idx>`
  //
  // Returns ok:true{aborted:bool}. aborted=false means the participant
  // wasn't found in the registry (already finished, not yet started, or
  // running on the legacy tmux transport which doesn't register).
  fastify.post<{
    Params: { id: string; key: string };
    Reply: ApiResponse<{ aborted: boolean }>;
  }>('/chats/:id/participants/:key/cancel', async (request, reply) => {
    try {
      const id = request.params.id;
      if (!isValidChatId(id)) {
        return sendError(reply, 'validation', 'invalid chat id');
      }
      const key = request.params.key;
      // Strict key shape — both prefixes the registry uses. Reject
      // unrecognised shapes so a malformed URL can't side-channel
      // arbitrary registry inspection by guessing keys. The agent name
      // MUST start with an alphanumeric (not `-`/`_`) so a key like
      // `reviewer--0` (empty agent name) is rejected.
      if (!/^(doer-|reviewer-)[A-Za-z0-9][A-Za-z0-9_-]*(?:-\d+)?$/.test(key)) {
        return sendError(reply, 'validation', 'invalid participant key');
      }
      const existing = await chats.getBySlugOrId(id);
      if (!existing) {
        return sendError(reply, 'not_found', `Chat ${id} not found`);
      }
      const aborted = participantAborts.abortParticipant(existing.id, key);
      return successResponse({ aborted });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // Re-run an existing chat. Creates a fresh chat row carrying over the
  // same work + template_id + attached_files + repo_path + artifact, plus
  // an initial phase event mirroring /chats POST. Intended for the
  // cancelled/failed → Retry button on the run viewer; the original chat
  // row stays untouched as history.
  fastify.post<{
    Params: { id: string };
    Reply: ApiResponse<object>;
  }>('/chats/:id/rerun', async (request, reply) => {
    try {
      const param = request.params.id;
      if (!isValidChatId(param)) {
        return sendError(reply, 'validation', 'invalid chat id');
      }
      const original = await chats.getBySlugOrId(param);
      if (!original) {
        return sendError(reply, 'not_found', `Chat ${param} not found`);
      }
      // Guard against rerun-on-active. The cockpit Retry button only
      // renders for terminal statuses, but a direct API call could
      // otherwise spawn a duplicate runner alongside the still-alive
      // original. Reject loudly with a dedicated kind so the caller can
      // distinguish from generic validation.
      if (!(TERMINAL_STATUSES as readonly string[]).includes(original.status)) {
        return sendError(
          reply,
          'conflict',
          `Chat ${param} is still active (status=${original.status}). Cancel it first, then retry.`,
        );
      }
      // Re-realpath on rerun even though create-side now persists the
      // canonical path. Catches legacy rows from before that fix shipped
      // AND defends against a swap that happened between the original
      // chat's success and the rerun click.
      let rerunRepoPath: string | undefined = original.repo_path ?? undefined;
      if (rerunRepoPath) {
        try {
          rerunRepoPath = fs.realpathSync(rerunRepoPath);
        } catch {
          // Original path no longer resolves — skip the rerun's repoPath
          // rather than silently shipping with a broken cwd.
          rerunRepoPath = undefined;
        }
      }
      const newChat = await chats.create({
        work: original.work,
        template_id: original.template_id,
        attached_files: original.attached_files ?? undefined,
        repo_path: rerunRepoPath,
        artifact: original.artifact ?? undefined,
      });
      // Mirror the create-path's initial phase_event so the cockpit
      // gets a populated stepper from t=0.
      let initialPhaseKind: PhaseKind = 'plan';
      try {
        const tmpl = await templates.getById(original.template_id);
        if (tmpl) {
          const safe = TemplateSchema.safeParse(yaml.parse(tmpl.yaml));
          if (safe.success) {
            const firstKind = safe.data.phases[0]?.kind;
            if (firstKind) initialPhaseKind = firstKind as PhaseKind;
          }
        }
      } catch {
        /* keep default */
      }
      await phaseEvents.create({
        chat_id: newChat.id,
        phase_idx: 0,
        phase_kind: initialPhaseKind,
        role: 'doer',
        agent_id: null,
        state: 'drafting',
        output: null,
        cost_usd: 0,
        tokens_in: 0,
        tokens_out: 0,
        started_at: Date.now(),
        finished_at: null,
      });
      return successResponse(newChat);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // Hard-delete a chat (row + phase_events + filesystem artifacts).
  // Cancels any active session first to avoid orphaned subprocesses
  // writing to the dir we're about to nuke. Idempotent: returns 200
  // even if the chat is already gone (allows the cockpit to retry
  // without distinguishing races).
  fastify.delete<{
    Params: { id: string };
    Reply: ApiResponse<object>;
  }>('/chats/:id', async (request, reply) => {
    try {
      const id = request.params.id;
      if (!isValidChatId(id)) {
        return sendError(reply, 'validation', 'invalid chat id');
      }
      const existing = await chats.getBySlugOrId(id);
      if (!existing) {
        return successResponse({ id, deleted: false, reason: 'not_found' });
      }
      // Resolve to the row's authoritative ULID — every downstream key
      // (activeRuns, tmux sessions, phase_events, chat dir on disk)
      // uses the ULID, not the slug. Without this, the route partly
      // worked when called by slug but failed to abort the runner /
      // kill tmux.
      const ulid = existing.id;

      // 1. Cancel first if still active — flips status, signals abort.
      if (existing.status === 'drafting' || existing.status === 'reviewing') {
        try {
          await chats.cancel(ulid);
        } catch {
          /* best-effort */
        }
      }

      // 1b. Abort the in-memory runner if one is active. Otherwise the
      // runner could keep streaming events and write to a chat dir
      // that we're about to rm -rf, plus it would re-create the row.
      const active = getActiveRun(ulid);
      if (active) {
        active.abortController.abort();
        // Wait for the runner to settle before proceeding with the
        // delete. 5-second timeout to avoid hanging forever.
        try {
          await Promise.race([
            active.promise.catch(() => {}),
            new Promise((r) => setTimeout(r, 5000)),
          ]);
        } catch {
          /* timeout or error — proceed with delete anyway */
        }
      }

      // 2. Kill any tmux sessions tied to this chat.
      try {
        const allSessions = tmuxMgr.list();
        for (const session of allSessions) {
          if (session.chatId === ulid) tmuxMgr.kill(session.name);
        }
      } catch {
        /* tmuxMgr may not be ready in test paths */
      }

      // 3. Drop DB row + phase events.
      await chats.delete(ulid);

      // 4. Nuke chat artifacts directory.
      const osModule = await import('os');
      const chatDir = path.join(osModule.homedir(), '.chorus', 'chats', ulid);
      if (fs.existsSync(chatDir)) {
        try {
          fs.rmSync(chatDir, { recursive: true, force: true });
        } catch (err) {
          // Don't fail the request — DB row is already gone, dir is
          // just disk-space cleanup.
          console.warn(`[chorus] failed to remove ${chatDir}:`, err);
        }
      }

      return successResponse({ id: ulid, deleted: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // Resume — answer a blocking question.
  fastify.post<{
    Params: { id: string };
    Body: { answer: string };
    Reply: ApiResponse<object>;
  }>('/chats/:id/resume', async (request, reply) => {
    try {
      const chatId = request.params.id;
      if (!isValidChatId(chatId)) {
        return sendError(reply, 'validation', 'invalid chat id');
      }
      const { answer } = request.body;
      if (!answer) {
        return sendError(reply, 'validation', 'answer is required');
      }
      const chat = await chats.update(chatId, { status: 'reviewing' });
      return successResponse(chat);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  registerChatStreamRoute(fastify, { tmuxMgr, errorDetector });
}
