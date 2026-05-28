/**
 * Reviewer streaming execution.
 *
 * Mirrors runDoerHeadless but returns a boolean | null verdict instead of
 * the {content, full} shape — caller (the per-chat reviewer pool) only
 * needs to know agreed / disagreed / failed.
 *
 * Tested by tests/runner-reviewer.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { StandardPhase } from '../../lib/template-schema.js';
import { DEFAULT_PHASE_TIMEOUT_MS } from '../../lib/template-schema.js';
import type { AgentShim } from '../agents/types.js';
import { getPermissions } from '../../lib/settings/permissions.js';
import {
  classifyOpenRouterError,
  getHealth,
  isKnownHealthLineage,
  kindToStatus,
  recordHealth,
  type CliLineage,
} from '../../lib/cli-health.js';
import { synthesizeCostUsd } from '../../lib/model-pricing.js';
import { StreamFileWriter } from './stream-file-writer.js';
import { verdictFromReviewerText } from './verdict.js';
import type { RunnerEvent } from './types.js';

export async function runReviewerHeadless(args: {
  shim: AgentShim;
  chatId: string;
  phase: StandardPhase;
  round: number;
  reviewerIdx: number;
  candidateLineage: string;
  candidateModel?: string;
  agentName: string;
  askContent: string;
  answerFile: string;
  reviewerDir: string;
  abortSignal: AbortSignal;
  onEvent: (e: RunnerEvent) => void;
  /**
   * Optional mutable out-param the caller (reviewer-driver) inspects
   * to decide whether to retry the same target before advancing the
   * fallback chain. Mutated when errorSummary is set; otherwise left
   * untouched (which the caller treats as "no kind = not retryable").
   * Out-of-band so the existing boolean | null return type stays
   * stable for every other caller.
   */
  lastError?: { kind?: string; message?: string };
}): Promise<boolean | null> {
  const {
    shim,
    chatId,
    phase,
    round,
    reviewerIdx,
    candidateLineage,
    candidateModel,
    agentName,
    askContent,
    answerFile,
    reviewerDir,
    abortSignal,
    onEvent,
    lastError,
  } = args;

  if (!shim.runHeadless) return null;

  const perms = await getPermissions();
  const startedAt = Date.now();
  let accumulated = '';
  let finalText: string | undefined;
  let errored = false;
  let capturedUsage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
        costUsd?: number;
      }
    | undefined;
  // Captured from the first error event so we can write it to
  // answer.md when the subprocess dies before producing any content.
  // Without this, callers reading ~/.chorus/chats/<id>/round-N/
  // reviewer-<agent>/answer.md see a 0-byte file with no clue what
  // went wrong (opencode lock contention, codex quota, etc.).
  let errorSummary: { kind: string; message: string } | undefined;

  fs.writeFileSync(answerFile, '');
  const writer = new StreamFileWriter(answerFile);

  const stream = shim.runHeadless({
    cwd: reviewerDir,
    promptText: askContent,
    model: candidateModel,
    sandbox: perms.sandboxProfile,
    autoApprove: perms.autoApprovePrompts,
    networkAccess: perms.networkAccess,
    abortSignal,
    timeoutMs: phase.timeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS,
  });

  // Safety net: if the stream closes without emitting ANY event (no text,
  // no error, no message_done), the reviewer subprocess silently produced
  // nothing — most often a CLI that wrote model output to /dev/tty instead
  // of the pipe, or one that exited 0 with empty stdout. Without this
  // counter the finally block has no signal to write a failure summary
  // (errorSummary stays undefined), and answer.md ends up 0 bytes — the
  // exact silent failure that hid opencode-cli for two days.
  let eventCount = 0;

  try {
    for await (const event of stream) {
      eventCount += 1;
      if (event.type === 'text_delta') {
        accumulated += event.text;
        writer.write(event.text);
        onEvent({
          chatId,
          type: 'phase_progress',
          payload: {
            phaseId: phase.id,
            round,
            role: 'reviewer',
            agent: `${agentName}-${reviewerIdx}`,
            output: accumulated.slice(-500),
          },
          ts: Date.now(),
        });
      } else if (event.type === 'tool_call_start') {
        onEvent({
          chatId,
          type: 'phase_progress',
          payload: {
            phaseId: phase.id,
            round,
            role: 'reviewer',
            agent: `${agentName}-${reviewerIdx}`,
            tool: event.tool,
          },
          ts: Date.now(),
        });
      } else if (event.type === 'progress') {
        onEvent({
          chatId,
          type: 'phase_progress',
          payload: {
            phaseId: phase.id,
            round,
            role: 'reviewer',
            agent: `${agentName}-${reviewerIdx}`,
            elapsedMs: event.elapsedMs,
          },
          ts: Date.now(),
        });
      } else if (event.type === 'message_done') {
        finalText = event.finalText;
        if (event.usage) capturedUsage = event.usage;
        // Same guard as the doer side: don't truncate accumulated deltas
        // when the CLI emits an empty `result` event (Gemini's text-then-
        // disappears bug). Only overwrite when there's real authoritative
        // text; otherwise just append the sentinel to what's already there.
        writer.flushNow();
        if (event.finalText.trim().length === 0) {
          const existing = fs.existsSync(answerFile)
            ? fs.readFileSync(answerFile, 'utf-8')
            : '';
          if (!/\n##\s*DONE\s*\n?$/i.test(existing.trimEnd())) {
            fs.appendFileSync(
              answerFile,
              existing.endsWith('\n') ? '\n## DONE\n' : '\n\n## DONE\n',
            );
          }
        } else {
          // Don't double-stamp the sentinel. Codex (and any CLI that
          // ends its own output with "## DONE") would otherwise ship
          // an answer with `... ## DONE\n\n\n## DONE\n` — the verdict
          // heuristic doesn't care, but it looks unprofessional in the
          // cockpit and breaks tools that grep for a single sentinel.
          const trimmedTail = event.finalText.replace(/\s+$/, '');
          const alreadyHasSentinel = /\n##\s*DONE\s*$/i.test(trimmedTail);
          const body = alreadyHasSentinel
            ? `${trimmedTail}\n`
            : `${trimmedTail}\n\n## DONE\n`;
          fs.writeFileSync(answerFile, body);
        }
        // Persist runtime stats next to the answer so the cockpit run-
        // artifacts route can surface "12.4s · 3.4k tok" on the card even
        // after a daemon restart or browser reload. Sidecar mirrors the
        // existing _meta.json (transport metadata) shape — write best-
        // effort, ignore errors.
        //
        // Cost synthesis: when the CLI emits tokens but no costUsd
        // (gemini-cli reports total_tokens only; codex reports nothing
        // in `exec` mode), look up the model in the OpenRouter pricing
        // catalog and compute cost from tokens × $/token. Fills the
        // "plan equivalent" column on the home page for the providers
        // whose own JSON doesn't carry pricing. Best-effort: a missing
        // model in the catalog or an offline daemon falls through to
        // costUsd unset rather than reporting a fake $0.
        let usageForStats = capturedUsage;
        if (
          usageForStats &&
          usageForStats.costUsd === undefined &&
          (usageForStats.inputTokens ||
            usageForStats.outputTokens ||
            usageForStats.cachedInputTokens)
        ) {
          try {
            const synth = await synthesizeCostUsd(candidateModel, usageForStats);
            if (synth !== undefined) {
              usageForStats = { ...usageForStats, costUsd: synth };
            }
          } catch {
            /* synthesis is informational — leave costUsd unset on failure */
          }
        }
        try {
          fs.writeFileSync(
            path.join(reviewerDir, '_stats.json'),
            JSON.stringify({
              durationMs: Date.now() - startedAt,
              // Lineage + model stamp lets the run-artifacts route
              // tell whether the LAST voice that succeeded was the
              // primary or a fallback. Without this stamp the cockpit
              // can't distinguish "fallback actually ran" from
              // "fallback collided, primary's answer is what's shown"
              // — and renders contradictory banners on collision-
              // exhausted slots like the bowerbird gemini case.
              lineage: candidateLineage,
              ...(candidateModel ? { model: candidateModel } : {}),
              ...(usageForStats ? { usage: usageForStats } : {}),
            }),
            'utf-8',
          );
        } catch {
          /* sidecar is informational; ignore write errors */
        }
        // participant_done payload carries identity only. The cockpit
        // refetches /api/run-artifacts on this event to pick up the
        // sidecar-backed stats — see retroactive PR #16 review for why
        // duplicating durationMs/usage in the SSE payload was dead bytes.
        onEvent({
          chatId,
          type: 'participant_done',
          payload: {
            phaseId: phase.id,
            round,
            role: 'reviewer',
            agent: `${agentName}-${reviewerIdx}`,
          },
          ts: Date.now(),
        });
      } else if (event.type === 'error') {
        errored = true;
        // Surface OpenRouter HTTP failures (insufficient credits, bad key,
        // rate-limit, upstream outage) as health state so the home-page
        // OpenRouter card flips to a quota/auth/rate-limit badge — same
        // surfacing tmux CLIs already get via error-detector. Best-effort:
        // health write doesn't block the run-page error event.
        const classified = classifyOpenRouterError(event.kind, event.message);
        if (classified) {
          recordHealth({
            lineage: 'openrouter',
            status: classified.status,
            message: classified.message,
          }).catch((healthErr: unknown) => {
            console.error('[chorus] recordHealth failed for openrouter:', healthErr);
          });
        } else {
          // Non-openrouter headless errors: record health under the
          // candidate's lineage when the error kind maps to a known
          // status. Mirrors what the tmux doer/reviewer drivers already
          // do via errorDetector.inspect() — without this the headless
          // path leaves cli-health stale, the precheck cooldown can't
          // fire, and the next chat in the next 10 minutes pays the
          // same 8-minute codex-retry tax.
          const mapped = kindToStatus(event.kind);
          if (mapped !== 'unknown' && isKnownHealthLineage(candidateLineage)) {
            recordHealth({
              lineage: candidateLineage as CliLineage,
              status: mapped,
              message: event.message,
            }).catch((healthErr: unknown) => {
              console.error(
                `[chorus] recordHealth failed for ${candidateLineage}:`,
                healthErr,
              );
            });
          }
        }
        // First error wins by default — but a more-specific later
        // kind can supersede a vague earlier one. The gemini parser
        // emits a generic `gemini_result_error` from the JSON result
        // line; the on-exit handler then emits a precise
        // `quota_exhausted` from stderr with the reset window. Without
        // this upgrade rule the cockpit shows the vague first message
        // and the user has no idea when their quota resets.
        const VAGUE_KINDS = new Set(['gemini_result_error']);
        const SPECIFIC_KINDS = new Set([
          'quota_exhausted',
          'rate_limit',
          'auth_error',
          'sandbox_unsupported',
          'cli_not_in_path',
        ]);
        const isUpgrade =
          errorSummary &&
          VAGUE_KINDS.has(errorSummary.kind) &&
          SPECIFIC_KINDS.has(event.kind);
        if (!errorSummary || isUpgrade) {
          errorSummary = {
            kind: event.kind,
            message: classified?.message ?? event.message,
          };
        }
        onEvent({
          chatId,
          type: 'cli_error',
          payload: {
            phaseId: phase.id,
            phaseKind: phase.kind,
            phaseIdx: 0,
            round,
            role: 'reviewer',
            agent: `${agentName}-${reviewerIdx}`,
            error: {
              kind: event.kind,
              message: classified?.message ?? event.message,
              ...(classified?.cta ? { cta: classified.cta } : {}),
              lineage: candidateLineage,
            },
          },
          ts: Date.now(),
        });
      }
    }
  } catch (err) {
    errored = true;
    const message = err instanceof Error ? err.message : String(err);
    if (!errorSummary) {
      errorSummary = { kind: 'stream_failure', message };
    }
    onEvent({
      chatId,
      type: 'cli_error',
      payload: {
        phaseId: phase.id,
        phaseKind: phase.kind,
        phaseIdx: 0,
        round,
        role: 'reviewer',
        agent: `${agentName}-${reviewerIdx}`,
        error: {
          kind: 'stream_failure',
          message,
          lineage: candidateLineage,
        },
      },
      ts: Date.now(),
    });
  } finally {
    writer.flushNow();
    // Stream closed with zero events — the CLI ran but produced nothing
    // we could parse (e.g. opencode 1.14.x writing to /dev/tty instead of
    // the pipe, or any future CLI that exits 0 with empty stdout).
    // Synthesise a no_output failure so:
    //   1. The reviewer card renders the kind+lineage instead of the
    //      generic "didn't produce any output" stub.
    //   2. answer.md carries a `## REVIEWER FAILED` block, matching the
    //      contract every other failure mode writes.
    //   3. The runner's verdict parser sees a definite "request changes"
    //      shape, not an empty string the verdict logic is undefined on.
    if (eventCount === 0 && !errorSummary) {
      errored = true;
      errorSummary = {
        kind: 'no_output',
        message:
          `${candidateLineage} CLI closed without emitting any output. ` +
          `Likely a transport bug (e.g. opencode 1.14.x writes JSON only to a TTY) ` +
          `or a silent abort. Check the CLI's own log for details.`,
      };
    }
    // When the subprocess errored without a complete message_done, write
    // the error summary to answer.md so the chat dir is self-explanatory.
    // We previously skipped this whenever any partial content was
    // accumulated — but that left files with mid-paragraph truncations and
    // no signal that the CLI crashed. Now: append the failure block to
    // whatever partial content survived, so post-mortem inspection sees
    // both what was produced AND why the run died.
    if (errored && !finalText && errorSummary) {
      try {
        // For quota / rate-limit failures, the error-detector (tmux path)
        // or recordHealth call (HTTP shim path) has already stamped the
        // lineage's cli-health row with `resetAt` if it's known. Pull
        // that here so the cockpit's failure card can render a "Resets
        // at HH:MM" countdown without a second round-trip. Best-effort:
        // resolves to undefined for unknown lineages or cleared health.
        let resetAt: number | undefined;
        try {
          const h = await getHealth(candidateLineage as CliLineage);
          if (typeof h.resetAt === 'number' && h.resetAt > Date.now()) {
            resetAt = h.resetAt;
          }
        } catch {
          /* health lookup is informational */
        }
        const summaryBlock =
          `## REVIEWER FAILED\n\n` +
          `**Kind:** ${errorSummary.kind}\n` +
          `**Lineage:** ${candidateLineage}\n` +
          `**Model:** ${candidateModel ?? '(default)'}\n` +
          (resetAt ? `**Resets:** ${new Date(resetAt).toISOString()}\n` : '') +
          `\n${errorSummary.message}\n`;
        const existing = accumulated.length > 0 && fs.existsSync(answerFile)
          ? fs.readFileSync(answerFile, 'utf-8')
          : '';
        if (existing.length === 0) {
          fs.writeFileSync(answerFile, summaryBlock);
        } else {
          // Separator makes the dual structure obvious to verdict parsers
          // and human readers — the partial answer above, the failure
          // record below.
          const sep = existing.endsWith('\n') ? '\n' : '\n\n';
          fs.writeFileSync(
            answerFile,
            `${existing}${sep}---\n\n[Partial output above — CLI failed before completion]\n\n${summaryBlock}`,
          );
        }
      } catch {
        /* best-effort — don't fail the runner because of a write error */
      }
    }
    // Persist a per-attempt sidecar so failures of EARLIER fallback chain
    // entries survive after a later attempt overwrites answer.md. Without
    // this, when (e.g.) kimi-k2.5 fails and the chain falls through to
    // claude-sonnet-4-6, the only on-disk record is "_swaps.json:
    // lineage_fallback" — the actual reason kimi failed (auth, model-not-
    // found, quota, ...) is gone. Writing in finally guarantees the row
    // lands regardless of how the run exits (success, error, abort).
    // Append-only JSONL keyed by (round, model) so multi-step fallback
    // chains leave a trail.
    //
    // Errored path only — silent failures (empty content, no error event,
    // verdict_ambiguous) are written below at the null-return sites so
    // zero rows in _attempts.jsonl genuinely means "no failure to log",
    // not "diagnostic gap". Bowerbird chat 019E6E3318873C26DCA60409B84F90E9
    // had a kimi slot that fell through to fallback with NO _attempts row
    // and NO daemon log line — that gap is what this refactor closes.
    if (errored) {
      const errorKind = errorSummary?.kind ?? 'unknown';
      const errorMessage = errorSummary?.message ?? '(no message captured)';
      // Mirror the classified error onto the caller's out-param so
      // reviewer-driver can decide retry-vs-advance without re-reading
      // _attempts.jsonl. Only mutated on errored runs; happy-path
      // returns leave lastError untouched.
      if (lastError) {
        lastError.kind = errorKind;
        lastError.message = errorMessage;
      }
      writeAttemptRow({
        reviewerDir,
        chatId,
        round,
        lineage: candidateLineage,
        model: candidateModel,
        kind: errorKind,
        message: errorMessage,
        durationMs: Date.now() - startedAt,
      });
    }
    // Mirror runDoerHeadless: surface answer.md write failures as a
    // cli_warning so the user sees "stream stopped writing" instead of
    // a quietly truncated reviewer transcript that the verdict parser
    // then chokes on.
    if (writer.isDead()) {
      const err = writer.lastError();
      onEvent({
        chatId,
        type: 'cli_warning',
        payload: {
          phaseId: phase.id,
          round,
          role: 'reviewer',
          agent: `${agentName}-${reviewerIdx}`,
          reason: 'stream_writer_dead',
          message: `answer.md write failed; subsequent deltas dropped: ${err ? err.message : 'unknown'}`,
          cta: 'Check disk space + permissions on ~/.chorus/chats. Re-run when fixed.',
        },
        ts: Date.now(),
      });
    }
  }

  // Prefer answer.md on disk over streamed text. Tool-using CLIs (gemini)
  // put the actual review into the file via a Write tool call and only
  // stream a confirmation message ("Changes have been requested...") that
  // the verdict heuristic can't classify. Reading the file picks up both
  // the tool-written verdict AND any text_delta-appended assistant text,
  // matching what the cockpit and CLI both display to the user.
  let onDisk = '';
  try {
    if (fs.existsSync(answerFile)) {
      onDisk = fs.readFileSync(answerFile, 'utf-8');
    }
  } catch {
    /* best-effort — fall through to streamed content */
  }
  const streamed = finalText && finalText.length > 0 ? finalText : accumulated;
  const content = onDisk.trim().length > 0 ? onDisk : streamed;
  if (errored && content.trim().length === 0) return null;
  if (content.trim().length === 0) {
    // Silent-failure path: stream ended without an error event AND
    // produced no usable content. Previously this returned null with no
    // _attempts.jsonl row and no daemon log line, leaving the operator
    // with no record of why a fallback fired. Synthesise a kind +
    // diagnostic row so every null return is traceable.
    if (lastError && !lastError.kind) {
      lastError.kind = 'empty_no_error';
      lastError.message =
        'CLI exited without writing usable content to answer.md and without emitting an error event.';
    }
    writeAttemptRow({
      reviewerDir,
      chatId,
      round,
      lineage: candidateLineage,
      model: candidateModel,
      kind: lastError?.kind ?? 'empty_no_error',
      message:
        lastError?.message ??
        'CLI exited without writing usable content to answer.md and without emitting an error event.',
      durationMs: Date.now() - startedAt,
    });
    return null;
  }

  // Record healthy on success so a stale quota_exhausted / auth_invalid
  // record from a prior session clears. Without this, the Reviewer
  // Fleet card stays "Quota out" / "Auth broken" even after the CLI
  // recovers — exactly the gemini bug Victor caught on the PR #83
  // audit (gemini produced a clean review but its home-page badge
  // still said "Quota out 3 models enabled"). OpenRouter + local
  // shims already do this; CLI-backed lineages were the gap.
  if (isKnownHealthLineage(candidateLineage)) {
    recordHealth({ lineage: candidateLineage, status: 'healthy' }).catch(
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[reviewer] recordHealth(healthy) failed for ${candidateLineage}: ${msg}`,
        );
      },
    );
  }

  const verdict = verdictFromReviewerText(content);
  // PR #91 audit catch (multiple reviewers, MEDIUM-HIGH): when the
  // reviewer produces non-empty content but verdictFromReviewerText
  // can't extract a positive/negative keyword, it returns null. The
  // caller (reviewer-driver retry loop) sees `result === null` with
  // `lastError.kind === undefined` — and the new opencode-shim
  // retryPolicy.onNullKind=true causes a retry. But this case ISN'T
  // a transport flake — the model successfully wrote prose that just
  // doesn't match the verdict heuristic (apology, refusal, off-topic).
  // Retrying it produces the same shape on the next attempt — wasted
  // tokens. Setting an explicit `verdict_ambiguous` kind classifies
  // this as terminal (not in the universal transient list, not opted
  // in by any shim) so the retry skips and the chain advances.
  //
  // Guarded on !lastError.kind so the classifier doesn't stomp a real
  // classified kind set by the finally block (e.g. when an errored
  // stream wrote a `## REVIEWER FAILED` block to answer.md — content
  // is non-empty so verdictFromReviewerText returns null, but the
  // failure was classified earlier as `stream_failure` /
  // `quota_exhausted` / etc. and that signal must survive).
  if (verdict === null && lastError && !lastError.kind) {
    lastError.kind = 'verdict_ambiguous';
    lastError.message =
      'Reviewer wrote non-empty content but no approve/reject verdict was detected.';
    writeAttemptRow({
      reviewerDir,
      chatId,
      round,
      lineage: candidateLineage,
      model: candidateModel,
      kind: 'verdict_ambiguous',
      message: lastError.message,
      durationMs: Date.now() - startedAt,
    });
  }
  return verdict;
}

/**
 * Append a diagnostic row to `_attempts.jsonl` and emit the matching
 * `[reviewer] attempt failed …` daemon log line. Called from every path
 * that returns a non-positive result (errored, empty-content, verdict-
 * ambiguous) so post-mortem grep across reviewer-slot _attempts.jsonl
 * sidecars shows every reason a slot fell back. Best-effort writes —
 * diagnostic failure must never fail the run.
 */
function writeAttemptRow(args: {
  reviewerDir: string;
  chatId: string;
  round: number;
  lineage: string;
  model: string | undefined;
  kind: string;
  message: string;
  durationMs: number;
}): void {
  const { reviewerDir, chatId, round, lineage, model, kind, message, durationMs } = args;
  try {
    const attemptsFile = path.join(reviewerDir, '_attempts.jsonl');
    const entry = {
      ts: Date.now(),
      round,
      lineage,
      model: model ?? null,
      errorKind: kind,
      errorMessage: message,
      durationMs,
    };
    fs.appendFileSync(attemptsFile, JSON.stringify(entry) + '\n');
  } catch {
    /* best-effort — diagnostics shouldn't fail the run */
  }
  console.warn(
    `[reviewer] attempt failed chat=${chatId} round=${round} ` +
      `lineage=${lineage} model=${model ?? '(default)'} ` +
      `kind=${kind} duration_ms=${durationMs} ` +
      `message=${JSON.stringify(message).slice(0, 300)}`,
  );
}
