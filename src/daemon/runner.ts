/**
 * Phase runner — orchestrates template execution.
 * Spawns CLI sessions per phase/round/role, writes prompts, watches for
 * answers, handles reviewer consensus, and emits SSE events.
 *
 * Per-role drivers live in runner/{doer-driver,reviewer-driver,
 * review-only-phase}.ts. Headless streaming hot paths live in
 * runner/{doer,reviewer,stream-file-writer}.ts. Pure prompt-construction
 * helpers live in runner/prompt-builder.ts.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { atomicWriteJsonSync } from '../lib/atomic-write.js';
import { chats } from '../lib/db/index.js';
import { logger } from '../lib/logger.js';
import { isReviewOnlyPhase, type StandardPhase, type Template } from '../lib/template-schema.js';
import { admitChat } from './chat-gate.js';
import type { ErrorDetector } from './error-detector.js';
import { runDoer } from './runner/doer-driver.js';
import { resetRound as resetFallbackRound } from './runner/fallback-registry.js';
import { readPriorRoundFeedback } from './runner/prior-round.js';
import { runReviewers } from './runner/reviewer-driver.js';
import { runReviewOnlyPhase } from './runner/review-only-phase.js';
import { detectGitContext, runShipPhase } from './ship.js';
import type { TmuxManager } from './tmux-types.js';

export type { RunnerEvent } from './runner/types.js';
import type { RunnerEvent } from './runner/types.js';

export interface PhaseRunnerOptions {
  chatId: string;
  template: Template;
  work: string;
  /**
   * Artifact text for review-only phases. When the template's first
   * phase has `kind: review_only`, this MUST be supplied (the
   * chat-create endpoint enforces it). The runner writes it into a
   * synthetic doer-answer slot and emits synthetic doer phase events so
   * reviewers see the same shape they always do.
   */
  artifact?: string;
  /**
   * Optional absolute path to the user's repo. When set:
   *   - Doer cwd becomes this path (real edits land in the working tree)
   *   - Reviewers stay in scratch dirs (read-only, no writes to user's repo)
   *   - Ship phase (if template.ship.enabled) runs after consensus
   * When unset: doer cwd is scratch dir as before; ship phase auto-skips.
   */
  repoPath?: string;
  /**
   * Optional list of file paths to read and inline into doer + reviewer
   * prompts. Paths are resolved relative to repoPath when set, else
   * absolute. Missing files are skipped with a note. Each file is capped
   * at 64 KB, total payload at 256 KB.
   */
  attachedFiles?: string[];
  onEvent: (e: RunnerEvent) => void;
  abortSignal: AbortSignal;
  tmuxMgr: TmuxManager;
  errorDetector: ErrorDetector;
}

interface ChatMeta {
  chatId: string;
  work: string;
  templateId: string;
  createdAt: number;
}

/**
 * Main runner. Iterates phases, spawns doers, waits for answers, runs
 * reviewers, checks consensus, and emits events.
 */
export async function runChat(opts: PhaseRunnerOptions): Promise<void> {
  const { chatId, template, work, artifact, repoPath, attachedFiles, onEvent, abortSignal, tmuxMgr, errorDetector } = opts;
  const chatDir = path.join(os.homedir(), '.chorus', 'chats', chatId);

  // Pack attached files into a single block once per chat. Both doer +
  // every reviewer get the same block — they're auditing the same artifacts.
  const filesBlock = packAttachedFiles(attachedFiles, repoPath);

  if (!fs.existsSync(chatDir)) {
    fs.mkdirSync(chatDir, { recursive: true });
  }

  // Freeze the template onto the chat row BEFORE any other durable run
  // artifact. Ordering matters: if we wrote meta.json first and crashed
  // before the snapshot, a daemon-restart-resume would re-enter runChat
  // with whatever template the runner re-resolved at restart time — which
  // could be a user-edited version, not the one this chat actually
  // intended to run against. Writing the snapshot first means resume's
  // IS-NULL guard finds it already there and the original is preserved.
  // Write-once: a second call after a daemon-restart-resume is a no-op
  // (helper guards on `template_snapshot IS NULL`). Failures are
  // non-fatal — the cockpit falls back to the live template by id, same
  // as legacy behaviour.
  try {
    await chats.setTemplateSnapshot(chatId, JSON.stringify(template));
  } catch (err) {
    logger.warn(
      { chatId, err: err instanceof Error ? err.message : String(err) },
      'failed to persist template snapshot — cockpit will use live template fallback',
    );
  }

  // Atomic temp+rename so a partial write (daemon crash, FS ENOSPC
  // mid-fsync) can't leave a corrupt JSON the cockpit chokes on.
  const meta: ChatMeta = {
    chatId,
    work,
    templateId: template.id,
    createdAt: Date.now(),
  };
  atomicWriteJsonSync(path.join(chatDir, 'meta.json'), meta);

  // chat_done is a one-way latch. The abort listener and the normal
  // terminal emission both try to fire it; whichever runs first wins.
  // This closes a race where SSE-disconnect → abort → chat_done(cancelled),
  // then the loop kept running and emitted chat_done(completed),
  // overwriting 'cancelled' with 'approved' in the DB.
  let chatDoneEmitted = false;
  const emitChatDone = (payload: Record<string, unknown>): void => {
    if (chatDoneEmitted) return;
    chatDoneEmitted = true;
    onEvent({ chatId, type: 'chat_done', payload, ts: Date.now() });
  };

  const abortListener = () => {
    // TODO(H): send polite Escape to active session, flip status to cancelled
    emitChatDone({ status: 'cancelled' });
  };
  abortSignal.addEventListener('abort', abortListener);

  // Daemon-wide admission gate. Caps the number of chats actively
  // fanning out reviewers (separate from cli-semaphore which caps
  // subprocesses per binary family). Configurable in /settings; default
  // 3 concurrent chats + refuse on low swap or high load. The chat row
  // stays at status='drafting' while queued; we emit `chat_queued`
  // events so the cockpit can render "Waiting for slot — N chats ahead".
  // On admission failure (signal abort), exit cleanly — emitChatDone
  // with cancelled was already wired via the abortListener above.
  let releaseAdmission: (() => void) | null = null;
  try {
    releaseAdmission = await admitChat({
      signal: abortSignal,
      onWait: (decision, position) => {
        // decision.reason is always populated when admit=false (the
        // gate guarantees this — see evaluateAdmission). The `??`
        // fallback is a defensive no-op; we keep it to satisfy the
        // type checker without inventing a sentinel string that
        // isn't in AdmitDenyReason.
        const reason: 'chats_at_cap' | 'swap_low' | 'load_high' =
          decision.reason ?? 'chats_at_cap';
        onEvent({
          chatId,
          type: 'chat_queued',
          payload: {
            reason,
            position,
            message: decision.message ?? '',
          },
          ts: Date.now(),
        });
      },
    });
  } catch (err) {
    // Aborted while queued — abortListener already fired chat_done.
    // Cleanly exit without proceeding into the doer/reviewer fan-out.
    abortSignal.removeEventListener('abort', abortListener);
    if (!chatDoneEmitted) {
      emitChatDone({
        status: 'cancelled',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // Track whether any phase failed because every reviewer in it failed
  // (timeout/quota/crash). If so, the chat ends in 'no_review' rather
  // than 'approved' — there was no actual peer review to approve from.
  let anyPhaseAllReviewersFailed = false;
  // Track whether any doer failed all rounds (couldn't produce output).
  // If so, the chat must NOT end approved — there was no real
  // implementation to review.
  let anyPhaseDoerFailed = false;
  // Distinguishes `iterate.onDisagreement: 'escalate'` from the default
  // `'continue'` path when surfacing the terminal chat_done. Both end
  // status='failed', but escalate carries a different verdict + error
  // string so cockpits/CLIs can render "reviewers disagreed, needs
  // human" distinctly from "doer never produced a working answer."
  let doerFailureReason: 'max_rounds_exhausted' | 'escalated_on_disagreement' =
    'max_rounds_exhausted';
  // Captures the consensus from the most recent review-only phase. Used
  // to override the default 'approved' verdict in chat_done — review-only
  // chats surface what the reviewers actually said rather than auto-
  // approving. null when no review-only phase ran (standard templates).
  let reviewOnlyConsensus: { agreed: boolean; summary: string } | null = null;

  try {
    for (let phaseIdx = 0; phaseIdx < template.phases.length; phaseIdx++) {
      if (abortSignal.aborted) break;

      const phase = template.phases[phaseIdx];

      // Review-only phases skip the doer entirely. Single pass, no
      // iterate loop, no ship — enforced here, not in the schema, so
      // future hybrid templates can mix kinds without re-plumbing the
      // validator.
      if (isReviewOnlyPhase(phase)) {
        const outcome = await runReviewOnlyPhase({
          chatDir,
          chatId,
          phase,
          phaseIdx,
          artifact: artifact ?? '',
          work,
          filesBlock,
          tmuxMgr,
          errorDetector,
          onEvent,
          abortSignal,
          templateFallbackReviewer: template.fallback?.reviewer,
        });
        if (outcome.allReviewersFailed) {
          anyPhaseAllReviewersFailed = true;
        }
        if (!outcome.completed) {
          // Aborted (Ctrl-C / cockpit cancel). DO NOT capture consensus
          // here — emitChatDone is racing with the abort listener which
          // fires status='cancelled', and surfacing 'request_changes'
          // would collapse "user hit cancel" with "reviewers said no" if
          // the abort listener loses the latch race.
          break;
        }
        // Reviewers actually finished a pass. Capture so chat_done can
        // surface the real verdict instead of always reporting 'approved'.
        reviewOnlyConsensus = {
          agreed: outcome.agreed,
          summary: outcome.summary,
        };
        onEvent({
          chatId,
          type: 'phase_done',
          payload: {
            phaseId: phase.id,
            phaseIdx,
            kind: phase.kind,
          },
          ts: Date.now(),
        });
        continue;
      }

      // Standard phase from here on.
      const stdPhase: StandardPhase = phase;

      let doerSucceeded = false;
      // Reflects the OUTCOME OF THE MOST-RECENTLY-COMPLETED round only:
      // - doer produced a full answer AND reviewers ran AND no consensus
      //   (and not allFailed) → true
      // - doer crashed / aborted / reviewers all crashed → false
      // Reset at the top of every round so a stale `true` from round N-1
      // can never bleed into a round-N abort or all-reviewers-failed,
      // which would otherwise let 'accept-doer' silently accept a non-
      // disagreement outcome. Convergent finding from PR #50's round-2
      // self-review (4/8 reviewers flagged the flag-reset gap).
      let disagreementInLastRound = false;
      for (let round = 1; round <= stdPhase.iterate.maxRounds; round++) {
        disagreementInLastRound = false;
        if (abortSignal.aborted) break;

        onEvent({
          chatId,
          type: 'phase_start',
          payload: {
            phaseId: stdPhase.id,
            phaseIdx,
            kind: stdPhase.kind,
            round,
            role: 'doer',
            agent: stdPhase.doer.lineage,
          },
          ts: Date.now(),
        });

        // Round 2+ feeds prior reviewer findings back into the doer prompt
        // so disagreement → retry is a real revision loop, not "ask the same
        // question again." Returns "" when round === 1.
        const priorRoundFeedback = readPriorRoundFeedback(chatDir, round);

        const doerAnswer = await runDoer(
          chatDir,
          chatId,
          stdPhase,
          phaseIdx,
          round,
          work,
          filesBlock,
          tmuxMgr,
          errorDetector,
          onEvent,
          abortSignal,
          repoPath,
          template.fallback?.doer,
          priorRoundFeedback,
        );

        // Treat null OR partial-stream as a doer failure — `!doerAnswer.full`
        // means runDoerHeadless saw a mid-stream error and only captured a
        // partial transcript. Passing that to reviewers leads to verdicts
        // on a half-written answer (gemini caught this on the launch-eve
        // runner review). The runner already retries via the round loop,
        // so failing this round is the right move; reviewing garbage is not.
        if (!doerAnswer || !doerAnswer.full) {
          // Doer crashed mid-stream. The round loop exits here without
          // recording a real disagreement — onDisagreement policy must
          // NOT fire on this path, otherwise 'accept-doer' would silently
          // accept a partial/empty answer as final. (Top-of-round reset
          // already covers this; explicit reset here documents intent.)
          disagreementInLastRound = false;
          onEvent({
            chatId,
            type: 'phase_failed',
            payload: {
              phaseId: stdPhase.id,
              phaseIdx,
              kind: stdPhase.kind,
              role: 'doer',
              reason: doerAnswer ? 'doer_partial_stream' : 'doer_timeout',
            },
            ts: Date.now(),
          });
          break;
        }

        onEvent({
          chatId,
          type: 'phase_progress',
          payload: {
            phaseId: stdPhase.id,
            round,
            role: 'doer',
            output: doerAnswer.content.slice(0, 500),
          },
          ts: Date.now(),
        });

        if (stdPhase.reviewer && stdPhase.reviewer.candidates.length > 0) {
          const consensus = await runReviewers(
            chatDir,
            chatId,
            stdPhase,
            phaseIdx,
            round,
            doerAnswer.content,
            work,
            filesBlock,
            tmuxMgr,
            errorDetector,
            onEvent,
            abortSignal,
            template.fallback?.reviewer,
          );

          if (consensus.allFailed) {
            anyPhaseAllReviewersFailed = true;
          }

          if (consensus.agreed) {
            doerSucceeded = true;
            // Phase succeeded in this round — clear any
            // all-reviewers-failed latch from prior rounds of THIS
            // phase. Without this, a chat that had a flaky round 1 (one
            // reviewer's CLI quota briefly exhausted, or a subprocess
            // crashed) but recovered to consensus in round 2 was being
            // terminally classified as `no_review`. The latch is meant
            // to surface "we never got a real review", not "we briefly
            // couldn't but eventually did". Subsequent phases set the
            // flag again from their own round-1 outcomes, so cross-phase
            // failure semantics are preserved.
            anyPhaseAllReviewersFailed = false;
            break;
          }

          // Doer produced a full answer; reviewers ran but didn't agree.
          // This is a real "policy applies" disagreement, not a technical
          // failure. `consensus.allFailed` means every reviewer's CLI
          // crashed/quota-blew, which is a different no-review path
          // handled by anyPhaseAllReviewersFailed below.
          if (!consensus.allFailed) {
            disagreementInLastRound = true;
          }

          if (round < stdPhase.iterate.maxRounds) {
            onEvent({
              chatId,
              type: 'phase_progress',
              payload: {
                phaseId: stdPhase.id,
                round,
                role: 'reviewer',
                disagreement: consensus.summary,
              },
              ts: Date.now(),
            });
          }
        } else {
          // No reviewers: doer succeeds immediately. Drop any fallback
          // claim the doer took on this round so the registry doesn't
          // leak across long-running daemons. (For phases WITH
          // reviewers, the reset already fires from runReviewers'
          // finally block.)
          resetFallbackRound(chatId, round);
          doerSucceeded = true;
          break;
        }
      }

      if (!doerSucceeded) {
        // Round loop exited without consensus. Two paths land here:
        //   (a) doer crashed / partial-stream → the inner break already
        //       fired phase_failed with the specific reason; we honor
        //       the existing "doer failed" semantics regardless of
        //       onDisagreement (a crashed doer's output must not be
        //       silently accepted as final).
        //   (b) reviewers disagreed → the template's onDisagreement
        //       policy decides what happens. Historically the runner
        //       only honored 'continue'; 'accept-doer' and 'escalate'
        //       were silent no-ops (issue #49).
        const phaseOutcome = decidePhaseOutcome({
          disagreementInLastRound,
          policy: stdPhase.iterate.onDisagreement,
        });
        if (phaseOutcome.kind === 'accept-doer') {
          doerSucceeded = true;
          onEvent({
            chatId,
            type: 'phase_progress',
            payload: {
              phaseId: stdPhase.id,
              phaseIdx,
              kind: stdPhase.kind,
              role: 'doer',
              accepted: 'doer_after_disagreement',
              round: stdPhase.iterate.maxRounds,
            },
            ts: Date.now(),
          });
        } else {
          anyPhaseDoerFailed = true;
          doerFailureReason = phaseOutcome.reason;
          onEvent({
            chatId,
            type: 'phase_failed',
            payload: {
              phaseId: stdPhase.id,
              phaseIdx,
              kind: stdPhase.kind,
              role: 'doer',
              reason: phaseOutcome.reason,
            },
            ts: Date.now(),
          });
          // Don't continue to subsequent phases when a doer failed every
          // round — there is no real implementation to feed forward, and
          // the chat must not end 'approved'. The chat_done branch below
          // handles the terminal status as 'failed' / 'no_review'.
          break;
        }
      }

      onEvent({
        chatId,
        type: 'phase_done',
        payload: {
          phaseId: stdPhase.id,
          phaseIdx,
          kind: stdPhase.kind,
        },
        ts: Date.now(),
      });
    }

    // ─── Ship phase ────────────────────────────────────────────────
    // Runs after all phases pass + reviewers agree, AND chat targets a
    // real repo, AND template opted in. Failures are surfaced as
    // status=blocked (chat ran fine, ship couldn't complete) rather
    // than failed (chat broke).
    let shipOutcome:
      | { kind: 'skipped'; reason?: string }
      | { kind: 'merged'; prUrl: string }
      | { kind: 'blocked'; error: string }
      = { kind: 'skipped' };

    // Forcibly skipped when any phase is review_only — there's no doer
    // diff to commit and a template author who set ship.enabled=true on
    // a review-only template would otherwise hit gh-cli with an empty
    // stage. The schema docs claim the runner enforces this.
    const templateHasReviewOnly = template.phases.some(isReviewOnlyPhase);
    if (
      !anyPhaseAllReviewersFailed &&
      !anyPhaseDoerFailed &&
      !templateHasReviewOnly &&
      template.ship?.enabled &&
      repoPath
    ) {
      const ctx = detectGitContext(repoPath, template.ship.baseBranch);
      if (!ctx.ok) {
        // Surface as a skip with reason — chat still ends approved
        // (we didn't ship, but the review was real).
        shipOutcome = { kind: 'skipped', reason: `${ctx.reason}: ${ctx.detail}` };
        onEvent({
          chatId,
          type: 'phase_progress',
          payload: { phaseId: 'ship', skipped: true, reason: ctx.reason, detail: ctx.detail },
          ts: Date.now(),
        });
      } else {
        // Read the most recent doer's output for the PR body. Fall back
        // to the chat's `work` if we can't find it (shouldn't happen in
        // practice — ship phase only runs after a successful doer).
        const lastDoerOutput = readLastDoerAnswer(chatDir) ?? work;
        onEvent({
          chatId,
          type: 'phase_start',
          payload: { phaseId: 'ship', kind: 'ship' },
          ts: Date.now(),
        });
        const result = runShipPhase({
          context: ctx.context,
          chatId,
          templateId: template.id,
          branchPattern: template.ship.branchPattern ?? 'chorus/{chatId}',
          titleTemplate: template.ship.titleTemplate ?? 'chorus: {template} via #{chatId}',
          summary: work,
          doerOutput: lastDoerOutput,
        });
        if (result.ok) {
          shipOutcome = { kind: 'merged', prUrl: result.prUrl };
          onEvent({
            chatId,
            type: 'phase_done',
            payload: { phaseId: 'ship', prUrl: result.prUrl, branch: result.branch },
            ts: Date.now(),
          });
        } else {
          shipOutcome = { kind: 'blocked', error: `${result.stage}: ${result.detail}` };
          onEvent({
            chatId,
            type: 'phase_failed',
            payload: { phaseId: 'ship', stage: result.stage, detail: result.detail },
            ts: Date.now(),
          });
        }
      }
    }

    // Final chat_done — encodes terminal status and ship-phase outcome.
    // Routed through emitChatDone so an earlier abort (SSE close, user
    // cancel) can't be overwritten by a later "completed" emission.
    if (anyPhaseDoerFailed) {
      // The doer never produced a real implementation, OR the template's
      // `iterate.onDisagreement: 'escalate'` policy halted the loop on
      // reviewer disagreement. Both end status='failed' so the cockpit
      // renders the chat red; the verdict + error string differ so
      // downstream can tell "needs human" from "doer broke."
      if (doerFailureReason === 'escalated_on_disagreement') {
        emitChatDone({
          status: 'failed',
          verdict: 'request_changes',
          error: 'escalated_on_disagreement',
        });
      } else {
        emitChatDone({ status: 'failed', verdict: 'failed', error: 'doer_failed_all_rounds' });
      }
    } else if (anyPhaseAllReviewersFailed) {
      emitChatDone({ status: 'no_review', verdict: 'no_review' });
    } else if (shipOutcome.kind === 'merged') {
      emitChatDone({
        status: 'merged',
        verdict: 'approved',
        prUrl: shipOutcome.prUrl,
      });
    } else if (shipOutcome.kind === 'blocked') {
      emitChatDone({ status: 'blocked', verdict: 'approved', shipError: shipOutcome.error });
    } else if (reviewOnlyConsensus !== null) {
      // Review-only chats surface the actual reviewer consensus rather
      // than auto-approving. The chat itself completed (artifact
      // reviewed, findings written) regardless of agreement — verdict
      // reflects what reviewers said so the cockpit/CLI can render a
      // meaningful "agreed / requested changes" state.
      emitChatDone({
        status: 'completed',
        verdict: reviewOnlyConsensus.agreed ? 'approved' : 'request_changes',
        reviewerSummary: reviewOnlyConsensus.summary,
      });
    } else {
      // Either no ship phase or ship was skipped — chat ends approved.
      emitChatDone({
        status: 'completed',
        verdict: 'approved',
        ...(shipOutcome.kind === 'skipped' && shipOutcome.reason
          ? { shipSkipped: shipOutcome.reason }
          : {}),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitChatDone({ status: 'failed', error: message });
  } finally {
    abortSignal.removeEventListener('abort', abortListener);
    // Release the daemon-wide admission slot so the next queued chat
    // can proceed. Idempotent — releaseAdmission swallows double-release.
    releaseAdmission?.();
  }
}

/**
 * Find and read the most recent doer's answer.md from the chat dir.
 * Used by the ship phase to embed doer output in the PR body. Returns
 * undefined if no doer output exists (shouldn't happen since ship runs
 * after success).
 */
function readLastDoerAnswer(chatDir: string): string | undefined {
  if (!fs.existsSync(chatDir)) return undefined;
  // Walk rounds in reverse (highest first). Within each round pick the
  // doer-* dir's answer.md. There's at most one doer per round.
  const rounds = fs
    .readdirSync(chatDir)
    .filter((n) => /^round-\d+$/.test(n))
    .map((n) => ({ name: n, num: parseInt(n.replace('round-', ''), 10) }))
    .sort((a, b) => b.num - a.num);

  for (const r of rounds) {
    const roundDir = path.join(chatDir, r.name);
    const doerSubdir = fs
      .readdirSync(roundDir)
      .find((n) => n.startsWith('doer-'));
    if (!doerSubdir) continue;
    const answerFile = path.join(roundDir, doerSubdir, 'answer.md');
    if (fs.existsSync(answerFile)) {
      const content = fs.readFileSync(answerFile, 'utf-8');
      if (content.trim().length > 0) return content;
    }
  }
  return undefined;
}

/**
 * Pure decision table for "what happens after the round loop exits
 * without reviewer consensus?"
 *
 * Inputs:
 *   - `disagreementInLastRound` — true iff at least one round completed
 *     with the doer producing a full answer AND reviewers running but
 *     failing to agree. False when the doer crashed mid-stream (the
 *     inner round-loop break) or when reviewers all crashed.
 *   - `policy` — the template's `iterate.onDisagreement`. Three values
 *     historically exposed by the schema, the cockpit form, and the
 *     SPEC docs, but only 'continue' was honored by the runner before
 *     issue #49.
 *
 * Outcomes:
 *   - `accept-doer`: drop the reviewer veto, treat the doer's last
 *     answer as final, let the chat carry on as if reviewers had agreed.
 *     Only fires when `disagreementInLastRound` AND policy is 'accept-doer'.
 *   - `fail` with `max_rounds_exhausted`: historical default. Either
 *     policy is 'continue', OR the round loop exited because the doer
 *     crashed (regardless of policy — a partial answer must never be
 *     silently accepted, even when the user wrote `accept-doer`).
 *   - `fail` with `escalated_on_disagreement`: policy is 'escalate' AND
 *     reviewers actually returned verdicts but didn't agree. Surfaces
 *     a distinct verdict + error so cockpits can render "needs human
 *     review" rather than "doer broke."
 *
 * Extracted so the table is unit-testable without standing up the full
 * runChat scaffold (tmuxMgr, errorDetector, fake doer + fake reviewers).
 */
export type OnDisagreementPolicy = 'continue' | 'escalate' | 'accept-doer';
export type PhaseOutcome =
  | { kind: 'accept-doer' }
  | { kind: 'fail'; reason: 'max_rounds_exhausted' | 'escalated_on_disagreement' };

export function decidePhaseOutcome(opts: {
  disagreementInLastRound: boolean;
  policy: OnDisagreementPolicy;
}): PhaseOutcome {
  // Doer crashed or never produced a full answer → policy doesn't apply.
  // Surface as the historical max_rounds_exhausted; the inner round-loop
  // break has already fired phase_failed with the specific
  // doer_partial_stream / doer_timeout reason for the cockpit to render.
  if (!opts.disagreementInLastRound) {
    return { kind: 'fail', reason: 'max_rounds_exhausted' };
  }
  if (opts.policy === 'accept-doer') return { kind: 'accept-doer' };
  if (opts.policy === 'escalate') {
    return { kind: 'fail', reason: 'escalated_on_disagreement' };
  }
  return { kind: 'fail', reason: 'max_rounds_exhausted' };
}

// Re-exports keep external import sites stable. Tests import some of
// these from `'../src/daemon/runner'`, the MCP layer imports verdict.
import { buildAsk, buildReviewerAsk, packAttachedFiles } from './runner/prompt-builder.js';
import { runDoerHeadless } from './runner/doer.js';
import { runReviewerHeadless } from './runner/reviewer.js';
import { StreamFileWriter } from './runner/stream-file-writer.js';
import { verdictFromReviewerText } from './runner/verdict.js';

export { buildAsk, buildReviewerAsk, packAttachedFiles, runDoerHeadless, runReviewerHeadless, StreamFileWriter, verdictFromReviewerText };
