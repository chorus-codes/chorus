import fs from 'fs';
import path from 'path';
import { DEFAULT_TMUX_PHASE_TIMEOUT_MS, type StandardPhase } from '../../lib/template-schema.js';
import { recordHealth, kindToStatus, type CliLineage } from '../../lib/cli-health.js';
import { precheckLineage } from '../../lib/cli-precheck.js';
import { abortableSleep } from '../../lib/abortable-sleep.js';
import { personas } from '../../lib/db/index.js';
import { getPermissions } from '../../lib/settings/permissions.js';
import { getTransport } from '../../lib/settings/transport.js';
import { CLI_LINEAGES, type CliLineageKey } from '../../lib/settings/concurrency.js';
import { acquire as acquireCliSlot } from '../cli-semaphore.js';
import { isHttpDispatchedShim, pickShimForVoice } from '../agents/index.js';
import { isRetryableErrorKind, type ErrorDetector } from '../error-detector.js';
import { waitForAnswer } from '../output-watcher.js';
import * as participantAborts from '../participant-aborts.js';
import type { TmuxManager } from '../tmux-types.js';
import { runDoerHeadless } from './doer.js';
import {
  release as releaseFallbackClaim,
  resetRound as resetFallbackRound,
  tryClaim as tryClaimFallbackTarget,
} from './fallback-registry.js';
import { buildAsk } from './prompt-builder.js';
import { runWithChainFallback, runWithModelFallback } from './run-with-fallback.js';
import { sanitizeName } from './sanitize-name.js';
import { appendSwapSidecar } from './swap-sidecar.js';
import { buildSlotFallbackChain } from './template-fallback.js';
import type { Lineage } from '../agents/types.js';
import type { RunnerEvent } from './types.js';

export async function runDoer(
  chatDir: string,
  chatId: string,
  phase: StandardPhase,
  phaseIdx: number,
  round: number,
  work: string,
  filesBlock: string,
  tmuxMgr: TmuxManager,
  errorDetector: ErrorDetector,
  onEvent: (e: RunnerEvent) => void,
  abortSignal: AbortSignal,
  repoPath?: string,
  templateFallbackDoer?: ReadonlyArray<{ lineage: string; models: string[] }>,
  priorRoundFeedback?: string,
): Promise<{ content: string; full: boolean } | null> {
  const doerModel = phase.doer.models?.[0];
  const shim = pickShimForVoice(phase.doer.lineage, doerModel);
  const agentName = shim.name;
  const isHttp = isHttpDispatchedShim(shim);

  // Pre-spawn precheck: short-circuit doomed runs without paying the spawn
  // tax. Two cheap layers: (1) recent quota_exhausted with future resetAt,
  // (2) credential file missing → user not logged in. HTTP-dispatched shims
  // (openrouter) skip this — their auth is the secrets table, checked
  // inside the shim itself.
  if (!isHttp) {
    const preDoer = await precheckLineage(phase.doer.lineage as CliLineage);
    if (!preDoer.ok) {
      onEvent({
        chatId,
        type: 'cli_warning',
        payload: {
          phaseId: phase.id,
          round,
          role: 'doer',
          agent: agentName,
          lineage: phase.doer.lineage,
          reason: preDoer.reason,
          message: preDoer.message,
          cta: preDoer.cta,
          resetAt: preDoer.resetAt,
        },
        ts: Date.now(),
      });
      return null;
    }
  }

  // Acquire daemon-wide CLI slot (global cap + per-lineage cap). Local
  // CLI only — HTTP-dispatched shims (openrouter) bypass. The slot is
  // held until the doer returns; cross-lineage fallback within the slot
  // doesn't refresh the slot (conservative — see reviewer-driver for
  // the same trade-off). The abortSignal lets a cancelled chat unwind
  // a queued doer without blocking the semaphore head forever.
  // The outer try/finally below guarantees release on every exit path.
  let releaseSlot: (() => void) | null = null;
  if (!isHttp && (CLI_LINEAGES as readonly string[]).includes(agentName)) {
    try {
      releaseSlot = await acquireCliSlot(agentName as CliLineageKey, abortSignal);
    } catch {
      // Aborted while queued — bail without spawning. Phase loop
      // already treats null doer return as "doer failed".
      return null;
    }
  }

  const roundDir = path.join(chatDir, `round-${round}`);
  const doerDir = path.join(roundDir, `doer-${agentName}`);

  if (!fs.existsSync(doerDir)) {
    fs.mkdirSync(doerDir, { recursive: true });
  }

  const askFile = path.join(doerDir, 'ask.md');
  const answerFile = path.join(doerDir, 'answer.md');

  // Outer try/finally guarantees the cli-semaphore slot is released on
  // every exit path (return null, throw, headless return, tmux return).
  // releaseSlot is null for HTTP shims; the optional-call is the guard.
  try {
  // Resolve doer persona. Falls back to no-persona prompt when the id can't
  // be resolved — emits cli_warning so the cockpit can surface the
  // misconfiguration. Without the warning, retroactive PR #17 review
  // (gemini + opencode-deepseek + opencode-kimi) flagged that a user
  // typoing a persona id silently runs the chat with a generic prompt.
  let doerPersonaPrompt: string | undefined;
  if ('persona' in phase.doer && phase.doer.persona) {
    const personaId = phase.doer.persona;
    try {
      const row = await personas.getById(personaId);
      if (row) {
        doerPersonaPrompt = row.system_prompt;
      } else {
        onEvent({
          chatId,
          type: 'cli_warning',
          payload: {
            phaseId: phase.id,
            phaseIdx,
            round,
            role: 'doer',
            agent: agentName,
            kind: 'persona_missing',
            message: `Doer persona "${personaId}" not found in personas table — running with generic prompt. Check the template's doer.persona field.`,
          },
          ts: Date.now(),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onEvent({
        chatId,
        type: 'cli_warning',
        payload: {
          phaseId: phase.id,
          phaseIdx,
          round,
          role: 'doer',
          agent: agentName,
          kind: 'persona_lookup_failed',
          message: `Doer persona lookup for "${personaId}" failed: ${message} — running with generic prompt.`,
        },
        ts: Date.now(),
      });
    }
  }

  const ask = buildAsk(
    phase,
    phaseIdx,
    round,
    work,
    phase.inputs,
    filesBlock,
    doerPersonaPrompt,
    priorRoundFeedback,
  );
  fs.writeFileSync(askFile, ask);

  // When the chat was created with a repoPath, the doer's working tree
  // becomes the user's repo (so it can read files + make real edits the
  // ship phase will commit). Reviewers always stay in scratch — they're
  // not allowed to write to the user's repo. ask.md/answer.md still live
  // in the chat dir for artifact viewing.
  const doerCwd = repoPath ?? doerDir;

  // Transport branch: headless when settings + shim support it; else fall
  // through to tmux. Mixed-mode in a single chat is OK — Claude can run
  // headless while a Gemini reviewer falls back to tmux.
  //
  // Per-slot model fallback: phase.doer.models can list multiple models.
  // The chain extends with template.fallback.doer (same lineage, dedup'd).
  // Doer has only one slot, so the dedup just guards against re-trying
  // the slot's own model.
  const transport = await getTransport();
  if (transport === 'headless' && shim.runHeadless) {
    const handle = participantAborts.register(
      chatId,
      participantAborts.participantKey('doer', agentName),
      abortSignal,
    );
    try {
      const doerSlot = {
        lineage: phase.doer.lineage,
        models: phase.doer.models ?? [],
      };
      const chain = buildSlotFallbackChain(
        doerSlot,
        [doerSlot],
        templateFallbackDoer,
      );
      return await runWithChainFallback(
        chain,
        async (entry) => {
          // Fallback-collision guard, mirroring reviewer-driver. The
          // doer normally runs alone, but its fallback chain can end at
          // the same shared template fallback target as the reviewer
          // slots' chains (e.g. anthropic/claude-sonnet-4-6). Without
          // this claim, the doer can run claude-sonnet-4-6 then a later
          // reviewer slot also resolves to claude-sonnet-4-6 and runs
          // it again — duplicate cost, lineage diversity broken. Sticky
          // semantics: claim is held through the round on success and
          // null; throw releases. See fallback-registry.ts for the full
          // rationale (PR #79 audit, opencode-cli-5 finding).
          const claimed = tryClaimFallbackTarget(
            chatId,
            round,
            entry.lineage,
            entry.model,
          );
          if (!claimed) {
            console.warn(
              `[doer] fallback collision chat=${chatId} round=${round} ` +
                `agent=${agentName} ` +
                `target=${entry.lineage}/${entry.model ?? '(default)'} ` +
                `— another slot is already running it; advancing chain`,
            );
            onEvent({
              chatId,
              type: 'cli_warning',
              payload: {
                phaseId: phase.id,
                round,
                role: 'doer',
                agent: agentName,
                reason: 'fallback_collision',
                fromLineage: entry.lineage,
                toLineage: entry.lineage,
                fromModel: entry.model ?? '(default)',
                toModel: entry.model ?? '(default)',
                message: `Skipping ${entry.lineage}/${entry.model ?? '(default)'} — another slot is already running it. Advancing to next fallback to preserve lineage diversity.`,
              },
              ts: Date.now(),
            });
            return null;
          }
          let threw = false;
          try {
            // Cross-lineage swap: when the entry's lineage differs from the
            // doer's primary, re-resolve the shim. Slot identity (agentName,
            // doerDir) stays bound to the primary lineage; cli_warning below
            // surfaces the swap to the cockpit.
            const entryShim = entry.lineage === phase.doer.lineage
              ? shim
              : pickShimForVoice(entry.lineage as Lineage, entry.model);
            // Single-retry on transient kinds before advancing the chain.
            // See reviewer-driver for full rationale and the kind taxonomy.
            const MAX_ATTEMPTS = 2;
            const RETRY_BACKOFF_MS = 1000;
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
              const lastError: { kind?: string; message?: string } = {};
              const result = await runDoerHeadless({
                shim: entryShim,
                chatId,
                phase,
                round,
                agentName,
                askContent: ask,
                answerFile,
                doerCwd,
                abortSignal: handle.signal,
                onEvent,
                modelOverride: entry.model,
                lastError,
              });
              if (result !== null) return result;
              if (attempt === MAX_ATTEMPTS) return null;
              if (!isRetryableErrorKind(lastError.kind)) return null;
              if (handle.signal.aborted) return null;
              console.warn(
                `[doer] retrying transient failure chat=${chatId} round=${round} ` +
                  `agent=${agentName} ` +
                  `target=${entry.lineage}/${entry.model ?? '(default)'} ` +
                  `kind=${lastError.kind} attempt=${attempt + 1}/${MAX_ATTEMPTS}`,
              );
              onEvent({
                chatId,
                type: 'cli_warning',
                payload: {
                  phaseId: phase.id,
                  round,
                  role: 'doer',
                  agent: agentName,
                  reason: 'transient_retry',
                  message: `Transient ${lastError.kind ?? 'failure'} on ${entry.lineage}/${entry.model ?? '(default)'} — retrying once before advancing fallback.`,
                },
                ts: Date.now(),
              });
              await abortableSleep(RETRY_BACKOFF_MS, handle.signal);
              if (handle.signal.aborted) return null;
            }
            return null;
          } catch (err) {
            threw = true;
            throw err;
          } finally {
            if (threw) {
              releaseFallbackClaim(chatId, round, entry.lineage, entry.model);
            }
          }
        },
        (from, to, fromIdx) => {
          const sameLineage = from.lineage === to.lineage;
          const reason = sameLineage ? 'model_fallback' : 'lineage_fallback';
          const message = sameLineage
            ? `Doer model "${from.model ?? '(default)'}" produced no answer; retrying with "${to.model ?? '(default)'}".`
            : `Doer ${from.lineage}/${from.model ?? '(default)'} failed; switching to ${to.lineage}/${to.model ?? '(default)'} (cross-lineage fallback).`;
          onEvent({
            chatId,
            type: 'cli_warning',
            payload: {
              phaseId: phase.id,
              round,
              role: 'doer',
              agent: agentName,
              reason,
              fromLineage: from.lineage,
              toLineage: to.lineage,
              fromModel: from.model ?? '(default)',
              toModel: to.model ?? '(default)',
              fallbackIdx: fromIdx,
              message,
            },
            ts: Date.now(),
          });
          // Persist to sidecar (see reviewer-driver.ts for rationale).
          // doerDir is the chat-scoped scratch dir, used here even when
          // doerCwd was overridden to the user's repo.
          appendSwapSidecar(doerDir, {
            round,
            phaseId: phase.id,
            role: 'doer',
            agent: agentName,
            reason,
            fromLineage: from.lineage,
            toLineage: to.lineage,
            fromModel: from.model ?? '(default)',
            toModel: to.model ?? '(default)',
            fallbackIdx: fromIdx,
            ts: Date.now(),
          });
        },
      );
    } finally {
      handle.release();
    }
  }

  // Acquire session — fresh per chat by default; reuses across rounds when
  // template policy says so (shareSessionAcrossRounds, default true).
  const perms = await getPermissions();
  const sessionName = sanitizeName(`chorus-${chatId}-${phase.id}-doer-${agentName}`);
  const session = await tmuxMgr.acquire({
    chatId,
    phaseId: phase.id,
    role: 'doer',
    round,
    shareSessionAcrossRounds: phase.iterate.shareSessionAcrossRounds,
    shareSessionAcrossPhases: phase.iterate.shareSessionAcrossPhases,
    shim,
    spawnOpts: {
      sessionName,
      cwd: doerCwd,
      model: phase.doer.models?.[0],
      sandbox: perms.sandboxProfile,
      autoApprove: perms.autoApprovePrompts,
      networkAccess: perms.networkAccess,
    },
    agentName,
  });

  if (shim.clearKeys && shim.clearKeys.length > 0) {
    tmuxMgr.sendKeys(session.name, [...shim.clearKeys]);
  }
  if (shim.preNudge) shim.preNudge(session.name);

  const prompt = shim.formatPrompt({
    promptFile: askFile,
    answerFile,
    task: phase.title,
    expectDoneSentinel: true,
  });

  // Wait for the CLI's TUI to finish cold-start before pasting. 6s covers
  // Codex's slow cold-start (it auths + paints panels); shorter and the
  // Enter we send below races against the input box being ready and gets
  // eaten. Raise if a slower box still misses the prompt.
  // abortableSleep so a cancelled chat doesn't wait the full 6s before
  // teardown — PR #77 audit.
  await abortableSleep(6000, abortSignal);
  if (abortSignal.aborted) return null;

  tmuxMgr.pasteBuffer(session.name, prompt);
  // Small gap between paste and Enter so the TUI registers the paste before
  // we submit.
  await abortableSleep(500, abortSignal);
  if (abortSignal.aborted) return null;
  tmuxMgr.sendKeys(session.name, ['Enter']);

  // Poll capture-pane every 2s to surface known CLI failure modes while we
  // wait for the answer file. The detector is stateful for opencode's
  // sustained-error pattern.
  const pollHandle = setInterval(() => {
    try {
      const pane = tmuxMgr.capturePane(session.name);
      const err = errorDetector.inspect(session.name, phase.doer.lineage, pane);
      if (err) {
        const recoveryKeys =
          err.kind === 'permission_prompt' ? shim.recoverKeys?.permission_prompt : undefined;
        if (recoveryKeys && recoveryKeys.length > 0) {
          // Layer 2 recovery: navigate the dialog, emit a warning (not error),
          // skip health recording — we recovered, no degradation.
          tmuxMgr.sendKeys(session.name, [...recoveryKeys]);
          onEvent({
            chatId,
            type: 'cli_warning',
            payload: {
              phaseId: phase.id,
              round,
              role: 'doer',
              agent: agentName,
              recovered: err.kind,
              keys: [...recoveryKeys],
              detail: err.detail,
            },
            ts: Date.now(),
          });
        } else {
          // Fire-and-forget — recordHealth became async in the libsql
          // migration. Inside a setInterval callback we can't await without
          // changing the callback shape; explicit .catch keeps unhandled
          // rejections off the process and preserves the pre-migration
          // semantics (non-blocking health record).
          recordHealth({
            lineage: phase.doer.lineage as CliLineage,
            status: kindToStatus(err.kind),
            message: err.message,
            resetAt: err.resetAt,
          }).catch((healthErr: unknown) => {
            console.error(`[chorus] recordHealth failed for ${phase.doer.lineage}:`, healthErr);
          });
          onEvent({
            chatId,
            type: 'cli_error',
            payload: { phaseId: phase.id, round, role: 'doer', agent: agentName, error: err },
            ts: Date.now(),
          });
        }
      }
    } catch {
      // ignore — the watcher will time out independently
    }
  }, 2000);

  try {
    return await waitForAnswer(answerFile, {
      timeoutMs: phase.timeoutMs ?? DEFAULT_TMUX_PHASE_TIMEOUT_MS,
      doneSentinel: '## DONE',
    });
  } catch {
    return null;
  } finally {
    clearInterval(pollHandle);
  }
  } finally {
    releaseSlot?.();
  }
}
