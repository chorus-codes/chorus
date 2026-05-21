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
import { buildReviewerAsk } from './prompt-builder.js';
import { runReviewerHeadless } from './reviewer.js';
import {
  release as releaseFallbackClaim,
  resetRound as resetFallbackRound,
  tryClaim as tryClaimFallbackTarget,
} from './fallback-registry.js';
import { runWithChainFallback, runWithModelFallback } from './run-with-fallback.js';
import { sanitizeName } from './sanitize-name.js';
import { appendSwapSidecar } from './swap-sidecar.js';
import { buildSlotFallbackChain } from './template-fallback.js';
import type { Lineage } from '../agents/types.js';
import type { RunnerEvent } from './types.js';
import { verdictFromReviewerText } from './verdict.js';

/**
 * Local-CLI reviewer concurrency is enforced daemon-wide by
 * `cli-semaphore.ts` — global cap (`maxParallelCli`) + per-CLI cap
 * (`perCli['opencode-cli']` etc.). Settings are user-tunable via
 * /settings; defaults are the same numbers we used to hardcode here
 * (3 global, opencode/gemini/kimi capped at 2 each). The semaphore is
 * shared across chats, not per-chat — that's where the OOM risk lives.
 *
 * HTTP-dispatched shims (openrouter and friends) bypass the semaphore
 * entirely — they're network calls and don't consume local resources.
 */

/**
 * Type guard for shim names that map to our capped CLI lineage keys.
 * Anything that isn't one of these is treated as a non-cap'd lineage
 * (defensive — covers future shim names we forgot to add to CLI_LINEAGES).
 */
function isCappedLineage(shimName: string): shimName is CliLineageKey {
  return (CLI_LINEAGES as readonly string[]).includes(shimName);
}

export async function runReviewers(
  chatDir: string,
  chatId: string,
  phase: StandardPhase,
  phaseIdx: number,
  round: number,
  doerOutput: string,
  work: string,
  filesBlock: string,
  tmuxMgr: TmuxManager,
  errorDetector: ErrorDetector,
  onEvent: (e: RunnerEvent) => void,
  abortSignal: AbortSignal,
  templateFallbackReviewer?: ReadonlyArray<{ lineage: string; models: string[] }>,
): Promise<{ agreed: boolean; summary: string; allFailed: boolean }> {
  if (!phase.reviewer || phase.reviewer.candidates.length === 0) {
    return { agreed: true, summary: '', allFailed: false };
  }

  const roundDir = path.join(chatDir, `round-${round}`);
  if (!fs.existsSync(roundDir)) {
    fs.mkdirSync(roundDir, { recursive: true });
  }

  // 'failed' = reviewer never produced a valid answer (timeout/quota/crash).
  // The chat-level verdict has to know the difference: if EVERY reviewer
  // failed, we shouldn't auto-approve.
  const reviews: {
    reviewer: string;
    outcome: 'agreed' | 'disagreed' | 'failed';
  }[] = [];

  const candidates = phase.reviewer.candidates;
  const required = phase.reviewer.require;

  // Split candidates by transport. HTTP-dispatched shims (openrouter,
  // future API-only shims) consume zero local CPU/RAM — they're just
  // network calls — so they bypass the cli-semaphore entirely and run
  // unbounded parallel. Per-shim rate limiting (e.g. OpenRouter's 429
  // with Retry-After) is the upstream's job; chorus shouldn't double-
  // throttle. Local CLI candidates go through the semaphore which
  // enforces both the global cap and the per-CLI cap; the wait happens
  // INSIDE runReviewer right before spawn so a reviewer that's queued
  // still emits its phase_start / participant cards, just in a
  // "waiting for slot" state.
  const localCandidateIdxs: number[] = [];
  const httpCandidateIdxs: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const reviewerModel = candidate.models?.[0];
    const shim = pickShimForVoice(candidate.lineage as Lineage, reviewerModel);
    if (isHttpDispatchedShim(shim)) {
      httpCandidateIdxs.push(i);
    } else {
      localCandidateIdxs.push(i);
    }
  }

  async function runOne(idx: number): Promise<void> {
    if (abortSignal.aborted) return;
    const candidate = candidates[idx];
    // Resolve the agent name for events here so phase_start/phase_done
    // carry the same `agent` shape the cockpit + per-reviewer error/
    // warning events already emit (`<shimName>-<idx>`). Without this,
    // successful reviewers never produced a `phase_start` / `phase_done`
    // pair and the runner-multiplex persister had nothing to write to
    // SQLite — so /chats/:id and the CLI's /show only saw the doer side
    // even though answer.md + verdict were correct on disk. Errored
    // reviewers were unaffected (cli_error has its own persistence
    // path). Mirrors the doer pattern in runner.ts.
    const reviewerModel = candidate.models?.[0];
    const reviewerShim = pickShimForVoice(candidate.lineage as Lineage, reviewerModel);
    const reviewerAgentLabel = `${reviewerShim.name}-${idx}`;
    onEvent({
      chatId,
      type: 'phase_start',
      payload: {
        phaseId: phase.id,
        phaseIdx,
        kind: phase.kind,
        round,
        role: 'reviewer',
        agent: reviewerAgentLabel,
      },
      ts: Date.now(),
    });
    try {
      const res = await runReviewer(
        chatDir,
        chatId,
        phase,
        phaseIdx,
        round,
        idx,
        doerOutput,
        work,
        filesBlock,
        tmuxMgr,
        errorDetector,
        onEvent,
        abortSignal,
        templateFallbackReviewer,
      );
      reviews.push({
        reviewer: `${candidate.lineage}-${idx}`,
        outcome: res === null ? 'failed' : res ? 'agreed' : 'disagreed',
      });
      // Only emit phase_done for outcomes the runner actually got a
      // verdict on (agreed / disagreed). `null` outcomes already
      // produced a cli_error / cli_warning earlier in the chain — those
      // carry the failure into phase_events with state='errored' /
      // 'warning' and we'd double-count by also emitting phase_done.
      if (res !== null) {
        onEvent({
          chatId,
          type: 'phase_done',
          payload: {
            phaseId: phase.id,
            phaseIdx,
            kind: phase.kind,
            round,
            role: 'reviewer',
            agent: reviewerAgentLabel,
            verdict: res ? 'agreed' : 'disagreed',
          },
          ts: Date.now(),
        });
      }
    } catch (err) {
      // PR #77 audit: 4 reviewers converged on this catch swallowing
      // exceptions silently. The phase loop recorded `'failed'` but no
      // log, no cli_error event, and no phase_done — the cockpit slot
      // card had no terminal signal and stayed visually stuck. Now we
      // log the exception and emit cli_error so the slot transitions
      // out of "running" and post-mortem inspection can find the
      // actual stack trace.
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[reviewer] runOne crashed chat=${chatId} round=${round} ` +
          `slot=${reviewerAgentLabel}: ${message}`,
        err,
      );
      onEvent({
        chatId,
        type: 'cli_error',
        payload: {
          phaseId: phase.id,
          phaseKind: phase.kind,
          phaseIdx,
          round,
          role: 'reviewer',
          agent: reviewerAgentLabel,
          error: {
            kind: 'reviewer_driver_crash',
            message,
            lineage: candidate.lineage,
          },
        },
        ts: Date.now(),
      });
      reviews.push({
        reviewer: `${candidate.lineage}-${idx}`,
        outcome: 'failed',
      });
    }
  }

  // Both buckets fire in parallel — the cli-semaphore inside
  // runReviewer is what enforces the local-CLI caps, so we don't need
  // a worker pool here. Reviewers continue to all run to completion
  // (no cancel-on-consensus); that's the established behaviour from
  // chorus-085 (see memory `feedback_let_all_reviewers_finish`),
  // unchanged by this PR. We're only swapping the worker-pool
  // implementation for a daemon-wide semaphore.
  try {
    await Promise.all([
      ...localCandidateIdxs.map((i) => runOne(i)),
      ...httpCandidateIdxs.map((i) => runOne(i)),
    ]);
  } finally {
    // Drop any fallback claims that succeeded in this round so the next
    // round (and a long-lived daemon) doesn't accumulate held targets.
    // Failed claims were released inline; successful ones are dropped
    // here. Safe to call when there are no claims — no-op.
    resetFallbackRound(chatId, round);
  }

  const agreedCount = reviews.filter((r) => r.outcome === 'agreed').length;
  const failedCount = reviews.filter((r) => r.outcome === 'failed').length;
  const agreed = agreedCount >= required;
  const allFailed = failedCount === reviews.length && reviews.length > 0;

  const summary = allFailed
    ? `All ${reviews.length} reviewer(s) failed (timeout/quota/crash)`
    : reviews.length > 0
      ? `${agreedCount}/${reviews.length} reviewers agreed${failedCount ? `, ${failedCount} failed` : ''}`
      : 'No reviews completed';

  return { agreed, summary, allFailed };
}

async function runReviewer(
  chatDir: string,
  chatId: string,
  phase: StandardPhase,
  phaseIdx: number,
  round: number,
  reviewerIdx: number,
  doerOutput: string,
  work: string,
  filesBlock: string,
  tmuxMgr: TmuxManager,
  errorDetector: ErrorDetector,
  onEvent: (e: RunnerEvent) => void,
  abortSignal: AbortSignal,
  templateFallbackReviewer?: ReadonlyArray<{ lineage: string; models: string[] }>,
): Promise<boolean | null> {
  // Returns:
  //   true  = reviewer ran and approved
  //   false = reviewer ran and disagreed
  //   null  = reviewer never produced a valid answer (timeout/quota/crash)
  if (!phase.reviewer) return true;
  const candidate = phase.reviewer.candidates[reviewerIdx];

  const reviewerModel = candidate.models?.[0];
  const shim = pickShimForVoice(candidate.lineage, reviewerModel);
  const agentName = shim.name;
  const isHttp = isHttpDispatchedShim(shim);

  // Reviewer dir is created BEFORE the precheck so any pre-spawn failure
  // can still write a `## REVIEWER FAILED` summary to answer.md. Without
  // this, a precheck-failed slot leaves NO on-disk participant; the
  // cockpit's enrich-rounds loop then can't reconcile the synthesised
  // template slot against any real participant, so the card sits at
  // "Queued — waiting for an open slot." forever (issue #25 — user with
  // no codex/gemini/kimi installed saw every chat stuck queued).
  const roundDir = path.join(chatDir, `round-${round}`);
  const reviewerDir = path.join(roundDir, `reviewer-${agentName}-${reviewerIdx}`);
  if (!fs.existsSync(reviewerDir)) {
    fs.mkdirSync(reviewerDir, { recursive: true });
  }
  const askFile = path.join(reviewerDir, 'ask.md');
  const answerFile = path.join(reviewerDir, 'answer.md');

  // Helper: write a `## REVIEWER FAILED` summary to answer.md so the
  // cockpit's `parseFailureSummary` lifts the slot out of "pending" and
  // shows the actual error. Same shape `runReviewerHeadless` writes for
  // post-spawn failures, kept in sync with the parser (kind, lineage,
  // model, message).
  const writePreSpawnFailure = (
    kind: string,
    message: string,
    resetAt?: number,
  ): void => {
    try {
      fs.writeFileSync(
        answerFile,
        `## REVIEWER FAILED\n\n` +
          `**Kind:** ${kind}\n` +
          `**Lineage:** ${candidate.lineage}\n` +
          `**Model:** ${reviewerModel ?? '(default)'}\n` +
          (resetAt ? `**Resets:** ${new Date(resetAt).toISOString()}\n` : '') +
          `\n${message}\n`,
      );
    } catch {
      /* best-effort — diagnostics shouldn't fail the run */
    }
  };

  // Pre-spawn precheck — same gate as runDoer. A reviewer that fails
  // precheck returns null, which the phase loop already handles by
  // counting it toward the all-reviewers-failed threshold and continuing
  // with the remaining reviewers. HTTP-dispatched shims (openrouter)
  // skip this — auth is the secrets table, checked inside the shim.
  if (!isHttp) {
    const preRev = await precheckLineage(candidate.lineage as CliLineage);
    if (!preRev.ok) {
      writePreSpawnFailure(preRev.reason, preRev.message, preRev.resetAt);
      onEvent({
        chatId,
        type: 'cli_warning',
        payload: {
          phaseId: phase.id,
          round,
          role: 'reviewer',
          agent: `${agentName}-${reviewerIdx}`,
          lineage: candidate.lineage,
          reason: preRev.reason,
          message: preRev.message,
          cta: preRev.cta,
          resetAt: preRev.resetAt,
        },
        ts: Date.now(),
      });
      return null;
    }
  }

  // Acquire the daemon-wide CLI slot (global + per-lineage). Local CLI
  // only — HTTP-dispatched shims aren't a memory pressure source and
  // bypass the semaphore. The slot is held for the reviewer's entire
  // lifetime, including any per-slot fallback chain — this is
  // conservative when a fallback swaps to a different lineage (we keep
  // the original slot rather than swap), but worst case is over-
  // counting the original lineage's quota during the swap window. The
  // global cap still holds.
  //
  // The abortSignal is passed so a chat cancelled while this reviewer
  // is queued behind the cap doesn't leave a stale waiter blocking the
  // semaphore head forever. On abort, acquire rejects → we return null
  // (treated as a failed reviewer by the phase loop) without spawning.
  //
  // `releaseSlot` is null for HTTP shims and the precheck-failed early-
  // return; the finally block below is robust to that.
  let releaseSlot: (() => void) | null = null;
  if (!isHttp && isCappedLineage(agentName)) {
    try {
      releaseSlot = await acquireCliSlot(agentName, abortSignal);
    } catch {
      // Aborted while waiting for slot — don't proceed. The phase loop
      // counts this reviewer as failed which preserves "all-failed"
      // semantics for the chat-level verdict.
      writePreSpawnFailure(
        'cancelled',
        'Reviewer cancelled while queued for an open CLI slot.',
      );
      return null;
    }
  }

  // Outer try/finally — guarantees the cli-semaphore slot is returned
  // on every path: headless's nested try/finally for participantAborts,
  // tmux's nested try/finally for the poll interval, AND any thrown
  // error in persona resolution or ask building. `releaseSlot` is null
  // for HTTP shims (acquire was skipped) — the optional-call is the
  // guard.
  try {
  // Resolve reviewer persona — same fallback + warning pattern as runDoer.
  let reviewerPersonaPrompt: string | undefined;
  if (candidate.persona) {
    const personaId = candidate.persona;
    try {
      const row = await personas.getById(personaId);
      if (row) {
        reviewerPersonaPrompt = row.system_prompt;
      } else {
        onEvent({
          chatId,
          type: 'cli_warning',
          payload: {
            phaseId: phase.id,
            phaseIdx,
            round,
            role: 'reviewer',
            agent: `${agentName}-${reviewerIdx}`,
            kind: 'persona_missing',
            message: `Reviewer persona "${personaId}" not found in personas table — running with generic prompt. Check the template's reviewer candidate persona field.`,
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
          role: 'reviewer',
          agent: `${agentName}-${reviewerIdx}`,
          kind: 'persona_lookup_failed',
          message: `Reviewer persona lookup for "${personaId}" failed: ${message} — running with generic prompt.`,
        },
        ts: Date.now(),
      });
    }
  }

  const ask = buildReviewerAsk(
    phase,
    phaseIdx,
    round,
    work,
    doerOutput,
    filesBlock,
    reviewerPersonaPrompt,
  );
  fs.writeFileSync(askFile, ask);

  // Per-slot model fallback: when candidate.models lists multiple models
  // we try them in order, falling through on `null` (no answer produced).
  // The boolean verdict `false` (disagreement) is a real result and stops
  // the chain — runWithModelFallback only re-tries on literal null.
  const transport = await getTransport();
  if (transport === 'headless' && shim.runHeadless) {
    const handle = participantAborts.register(
      chatId,
      participantAborts.participantKey('reviewer', agentName, reviewerIdx),
      abortSignal,
    );
    try {
      // Compose: this slot's per-slot chain + template-level
      // fallback.reviewer (same lineage, dedup'd against this slot AND
      // every other reviewer slot in the phase so we don't spawn a
      // duplicate voice).
      const allReviewerSlots = (phase.reviewer?.candidates ?? []).map((c) => ({
        lineage: c.lineage,
        models: c.models ?? [],
      }));
      const thisSlot = {
        lineage: candidate.lineage,
        models: candidate.models ?? [],
      };
      const chain = buildSlotFallbackChain(
        thisSlot,
        allReviewerSlots,
        templateFallbackReviewer,
      );
      return await runWithChainFallback(
        chain,
        async (entry) => {
          // Cross-slot collision check: another reviewer in this same
          // chat/round may already be running this exact (lineage,
          // model). Common cause is two slots sharing the template-
          // level fallback (e.g. anthropic/claude-sonnet-4-6 at the
          // tail of every slot's chain). Without this, both slots
          // dispatch the same model in parallel — wasted cost AND the
          // lineage diversity that's the whole point of multi-LLM
          // peer review collapses. On collision, we return null so
          // runWithChainFallback advances to the next chain entry;
          // emits a cli_warning tagged `fallback_collision` so the
          // cockpit can show why the slot skipped.
          const claimed = tryClaimFallbackTarget(
            chatId,
            round,
            entry.lineage,
            entry.model,
          );
          if (!claimed) {
            console.warn(
              `[reviewer] fallback collision chat=${chatId} round=${round} ` +
                `slot=${agentName}-${reviewerIdx} ` +
                `target=${entry.lineage}/${entry.model ?? '(default)'} ` +
                `— another slot is already running it; advancing chain`,
            );
            onEvent({
              chatId,
              type: 'cli_warning',
              payload: {
                phaseId: phase.id,
                round,
                role: 'reviewer',
                agent: `${agentName}-${reviewerIdx}`,
                reason: 'fallback_collision',
                fromLineage: entry.lineage,
                toLineage: entry.lineage,
                fromModel: entry.model ?? '(default)',
                toModel: entry.model ?? '(default)',
                message: `Skipping ${entry.lineage}/${entry.model ?? '(default)'} — another reviewer slot is already running it. Advancing to next fallback to preserve lineage diversity.`,
              },
              ts: Date.now(),
            });
            return null;
          }
          // Hold the claim through the round REGARDLESS of attempt
          // outcome — diversity-preserving semantics for shared
          // template fallbacks.
          //
          // The old behavior released the claim on null/throw so the
          // next slot could retry the same fallback target. Rationale
          // was "transient model failure shouldn't lock out other
          // slots". But the user-visible result in
          // chat=019E45413E126AFCD83146524A22BFC4 (2026-05-20) was
          // three reviewer cards all swapping to claude-sonnet-4-6 in
          // sequence — claude failed for slot A, released, slot B
          // claimed and failed, released, slot C claimed and failed.
          // Diversity collapse, the whole point of multi-LLM peer
          // review defeated.
          //
          // New rule: claim is sticky for the round. First slot to
          // reach a shared fallback target "wins" it. Subsequent slots
          // reaching the same target via tryClaim get false and
          // advance to the NEXT chain entry — fallback_collision
          // warning lands on those cards, no duplicate run. If the
          // first slot's attempt fails, the OTHER slots simply have no
          // backup — they end in failed state, which is the honest
          // signal that "this template's single shared fallback didn't
          // cover all primaries". The user can fix that by configuring
          // multiple fallbacks (one per likely-failing lineage) so
          // each slot can take an independent backup.
          //
          // Throw still releases — a throw means something went wrong
          // outside the model call (e.g. shim resolution failure), and
          // the other slots should be allowed to try the target
          // themselves. result === null is treated as "model ran but
          // produced no output" — that's a real model outcome, not an
          // infrastructure error.
          let threw = false;
          try {
            // Cross-lineage swap: when the entry's lineage differs from
            // the slot's primary, re-resolve the shim. The slot's
            // identity (agentName, reviewerDir, participant key) stays
            // bound to the primary lineage so the cockpit card doesn't
            // re-key mid-run — the cli_warning below tells the UI a
            // swap happened. Resolved INSIDE the try block so a
            // pickShimForVoice throw still releases the claim we just
            // took (caught by chorus audit on PR #77).
            const entryShim = entry.lineage === candidate.lineage
              ? shim
              : pickShimForVoice(entry.lineage as Lineage, entry.model);
            // Single-retry on transient kinds before advancing the
            // chain. Most CLI calls succeed; the failures that DO
            // recur are deterministic (auth, quota, db-corrupt) and
            // are NOT retried. Stream-failures, cold-start timeouts,
            // tmux-dead, and HTTP 5xx ARE retried — a single ~1s
            // backoff catches the cheap save (mid-stream network blip,
            // slow cold start hitting warm cache on the second try)
            // without doubling spend on a real outage (which fails
            // twice and then advances). See isRetryableErrorKind for
            // the full taxonomy.
            const MAX_ATTEMPTS = 2;
            const RETRY_BACKOFF_MS = 1000;
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
              const lastError: { kind?: string; message?: string } = {};
              const result = await runReviewerHeadless({
                shim: entryShim,
                chatId,
                phase,
                round,
                reviewerIdx,
                candidateLineage: entry.lineage,
                candidateModel: entry.model,
                agentName,
                askContent: ask,
                answerFile,
                reviewerDir,
                abortSignal: handle.signal,
                onEvent,
                lastError,
              });
              if (result !== null) return result;
              if (attempt === MAX_ATTEMPTS) return null;
              if (!isRetryableErrorKind(lastError.kind)) return null;
              if (handle.signal.aborted) return null;
              console.warn(
                `[reviewer] retrying transient failure chat=${chatId} round=${round} ` +
                  `slot=${agentName}-${reviewerIdx} ` +
                  `target=${entry.lineage}/${entry.model ?? '(default)'} ` +
                  `kind=${lastError.kind} attempt=${attempt + 1}/${MAX_ATTEMPTS}`,
              );
              onEvent({
                chatId,
                type: 'cli_warning',
                payload: {
                  phaseId: phase.id,
                  round,
                  role: 'reviewer',
                  agent: `${agentName}-${reviewerIdx}`,
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
            ? `Reviewer model "${from.model ?? '(default)'}" produced no answer; retrying with "${to.model ?? '(default)'}".`
            : `Reviewer ${from.lineage}/${from.model ?? '(default)'} failed; switching to ${to.lineage}/${to.model ?? '(default)'} (cross-lineage fallback).`;
          // Structured daemon-log line. Pairs with the [reviewer] attempt-
          // failed line that was just emitted by reviewer.ts: tail the log
          // and you see "attempt failed" → "fallback fired" → next
          // "attempt failed" or success in order, per slot.
          console.warn(
            `[reviewer] fallback fired chat=${chatId} round=${round} ` +
              `slot=${agentName}-${reviewerIdx} reason=${reason} ` +
              `from=${from.lineage}/${from.model ?? '(default)'} ` +
              `to=${to.lineage}/${to.model ?? '(default)'} ` +
              `chain_idx=${fromIdx}`,
          );
          onEvent({
            chatId,
            type: 'cli_warning',
            payload: {
              phaseId: phase.id,
              round,
              role: 'reviewer',
              agent: `${agentName}-${reviewerIdx}`,
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
          // Persist a sidecar so swap cards survive page reloads — the
          // SSE stream shuts off for terminal chats, and phase_events
          // packs warnings as opaque text. Mirrors the _stats.json /
          // _meta.json pattern: append-only JSON array, read by the
          // run-artifacts route at the next refresh tick.
          appendSwapSidecar(reviewerDir, {
            round,
            phaseId: phase.id,
            role: 'reviewer',
            agent: `${agentName}-${reviewerIdx}`,
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

  // Reviewers don't share sessions across rounds — each round wants a
  // fresh perspective on the new doer output. Across-phase reuse never
  // makes sense.
  const perms = await getPermissions();
  const sessionName = sanitizeName(
    `chorus-${chatId}-${phase.id}-reviewer-${agentName}-${reviewerIdx}`,
  );
  const session = await tmuxMgr.acquire({
    chatId,
    phaseId: phase.id,
    role: 'reviewer',
    round,
    shareSessionAcrossRounds: false,
    shareSessionAcrossPhases: false,
    shim,
    spawnOpts: {
      sessionName,
      cwd: reviewerDir,
      model: candidate.models?.[0],
      sandbox: perms.sandboxProfile,
      autoApprove: perms.autoApprovePrompts,
      networkAccess: perms.networkAccess,
    },
    agentName: `${agentName}-${reviewerIdx}`,
  });

  if (shim.clearKeys && shim.clearKeys.length > 0) {
    tmuxMgr.sendKeys(session.name, [...shim.clearKeys]);
  }
  if (shim.preNudge) shim.preNudge(session.name);

  const prompt = shim.formatPrompt({
    promptFile: askFile,
    answerFile,
    task: `Review: ${phase.title}`,
    expectDoneSentinel: true,
  });
  // Wait for the CLI's TUI to finish cold-start before pasting (6s
  // covers Codex's slow cold-start). See doer-driver for rationale.
  // abortableSleep so a cancelled chat doesn't wait the full 6s before
  // teardown — PR #77 audit (multiple reviewers + opencode-cli-3).
  await abortableSleep(6000, abortSignal);
  if (abortSignal.aborted) return null;

  tmuxMgr.pasteBuffer(session.name, prompt);
  await abortableSleep(500, abortSignal);
  if (abortSignal.aborted) return null;
  tmuxMgr.sendKeys(session.name, ['Enter']);

  // Failure-mode polling — same pattern as the doer.
  const pollHandle = setInterval(() => {
    try {
      const pane = tmuxMgr.capturePane(session.name);
      const err = errorDetector.inspect(session.name, candidate.lineage, pane);
      if (err) {
        const recoveryKeys =
          err.kind === 'permission_prompt' ? shim.recoverKeys?.permission_prompt : undefined;
        if (recoveryKeys && recoveryKeys.length > 0) {
          tmuxMgr.sendKeys(session.name, [...recoveryKeys]);
          onEvent({
            chatId,
            type: 'cli_warning',
            payload: {
              phaseId: phase.id,
              round,
              role: 'reviewer',
              agent: `${agentName}-${reviewerIdx}`,
              recovered: err.kind,
              keys: [...recoveryKeys],
              detail: err.detail,
            },
            ts: Date.now(),
          });
        } else {
          // Fire-and-forget — see doer-driver for rationale.
          recordHealth({
            lineage: candidate.lineage as CliLineage,
            status: kindToStatus(err.kind),
            message: err.message,
            resetAt: err.resetAt,
          }).catch((healthErr: unknown) => {
            console.error(`[chorus] recordHealth failed for ${candidate.lineage}:`, healthErr);
          });
          onEvent({
            chatId,
            type: 'cli_error',
            payload: {
              phaseId: phase.id,
              round,
              role: 'reviewer',
              agent: `${agentName}-${reviewerIdx}`,
              error: err,
            },
            ts: Date.now(),
          });
        }
      }
    } catch {
      // ignore
    }
  }, 2000);

  try {
    const result = await waitForAnswer(answerFile, {
      timeoutMs: phase.timeoutMs ?? DEFAULT_TMUX_PHASE_TIMEOUT_MS,
      doneSentinel: '## DONE',
    });
    if (!result.full || result.content.trim().length === 0) {
      // Watcher resolved on timeout/silence with no real answer.
      return null;
    }
    return verdictFromReviewerText(result.content);
  } catch {
    // Timed out or watcher errored — no valid answer produced.
    return null;
  } finally {
    clearInterval(pollHandle);
  }
  } finally {
    releaseSlot?.();
  }
}
