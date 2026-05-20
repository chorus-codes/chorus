/**
 * Doer streaming execution.
 *
 * Drives one doer subprocess via its AgentShim's runHeadless iterator,
 * forwarding text_delta events to a buffered StreamFileWriter and to the
 * SSE bus, and producing the final `{content, full}` shape the phase
 * loop consumes.
 *
 * Critical invariants (covered by tests/runner-doer.test.ts):
 *   - text_delta events accumulate AND get flushed to answer.md
 *   - message_done with non-empty finalText overwrites authoritatively +
 *     appends ## DONE sentinel when missing
 *   - message_done with EMPTY finalText keeps accumulated deltas
 *     (the Gemini "result-line-only" failure mode)
 *   - error event flips errored AND preserves accumulated content
 *   - StreamFileWriter buffer is flushed in the finally block on every path
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
import type { RunnerEvent } from './types.js';

export async function runDoerHeadless(args: {
  shim: AgentShim;
  chatId: string;
  phase: StandardPhase;
  round: number;
  agentName: string;
  askContent: string;
  answerFile: string;
  /** Doer's working dir — repoPath when chat targets a real repo, else scratch. */
  doerCwd: string;
  abortSignal: AbortSignal;
  onEvent: (e: RunnerEvent) => void;
  /** Per-attempt model override for the slot's fallback chain. When set, wins
   *  over `phase.doer.models?.[0]` so the outer runDoer can iterate the
   *  models[] list without rewriting the phase fixture between attempts. */
  modelOverride?: string;
  /** Optional mutable out-param the caller (doer-driver) inspects to
   *  decide whether to retry the same target before advancing the
   *  fallback chain. Mutated when the run errors; otherwise untouched.
   *  See runReviewerHeadless's matching field for rationale. */
  lastError?: { kind?: string; message?: string };
}): Promise<{
  content: string;
  full: boolean;
  /**
   * Token-usage block from the message_done terminal event. Undefined
   * when the upstream shim doesn't (yet) populate it — kimi/opencode
   * fall through with no usage; claude/codex/gemini will once their
   * parsers are migrated. The runner persists these into phase_events
   * tokens_in/tokens_out + cost_usd in a follow-up wiring PR.
   */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
} | null> {
  const {
    shim,
    chatId,
    phase,
    round,
    agentName,
    askContent,
    answerFile,
    doerCwd,
    abortSignal,
    onEvent,
    modelOverride,
    lastError,
  } = args;

  if (!shim.runHeadless) {
    // Defensive — caller should have checked. Fail closed.
    return null;
  }

  const perms = await getPermissions();
  let accumulated = '';
  let finalText: string | undefined;
  let errored = false;
  // Captured from the first error event so we can write it to
  // answer.md when the subprocess dies before producing any content.
  // Mirrors the reviewer-side handling so chat dirs are self-
  // explanatory after a silent-failure crash.
  let errorSummary: { kind: string; message: string } | undefined;
  let capturedUsage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    costUsd?: number;
  } | undefined;
  const startedAt = Date.now();

  // Initialize answer.md so the artifacts endpoint sees the file mid-stream.
  fs.writeFileSync(answerFile, '');
  const writer = new StreamFileWriter(answerFile);

  // Mirrors reviewer.ts: tracks whether the shim emitted ANY event. If
  // not (CLI exits 0 with empty stdout — opencode 1.14.x writes only to
  // /dev/tty, some legacy stubs do the same), the finally block
  // synthesises a `no_output` failure so answer.md gets a structured
  // `## DOER FAILED` block instead of silently being zero bytes.
  let eventCount = 0;

  const stream = shim.runHeadless({
    cwd: doerCwd,
    promptText: askContent,
    model: modelOverride ?? phase.doer.models?.[0],
    sandbox: perms.sandboxProfile,
    autoApprove: perms.autoApprovePrompts,
    networkAccess: perms.networkAccess,
    abortSignal,
    timeoutMs: phase.timeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS,
  });

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
            role: 'doer',
            agent: agentName,
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
            role: 'doer',
            agent: agentName,
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
            role: 'doer',
            agent: agentName,
            elapsedMs: event.elapsedMs,
          },
          ts: Date.now(),
        });
      } else if (event.type === 'message_done') {
        finalText = event.finalText;
        if (event.usage) capturedUsage = event.usage;
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
          const needsSentinel = !/\n##\s*DONE\s*\n?$/i.test(
            event.finalText.trimEnd(),
          );
          const finalContent = needsSentinel
            ? `${event.finalText}\n\n## DONE\n`
            : event.finalText.endsWith('\n')
              ? event.finalText
              : `${event.finalText}\n`;
          fs.writeFileSync(answerFile, finalContent);
        }
        // Tell the cockpit this participant is fully on disk so it can
        // flip the card immediately rather than wait for the 8s polling
        // tick. Mirrored in reviewer.ts.
        // Persist runtime stats next to answer.md — see reviewer.ts for
        // rationale. Use path.dirname + path.join (clearer than the
        // anchored regex; flagged in retroactive PR #16 review).
        //
        // Cost synthesis: see same block in reviewer.ts. Doer's model is
        // `modelOverride ?? phase.doer.models?.[0]` which we already
        // resolved at top of function and passed into shim.runHeadless;
        // re-resolve the same string here for the lookup.
        let usageForStats = capturedUsage;
        const doerModel = modelOverride ?? phase.doer.models?.[0];
        if (
          usageForStats &&
          usageForStats.costUsd === undefined &&
          (usageForStats.inputTokens ||
            usageForStats.outputTokens ||
            usageForStats.cachedInputTokens)
        ) {
          try {
            const synth = await synthesizeCostUsd(doerModel, usageForStats);
            if (synth !== undefined) {
              usageForStats = { ...usageForStats, costUsd: synth };
            }
          } catch {
            /* synthesis is informational — leave costUsd unset on failure */
          }
        }
        try {
          const statsPath = path.join(path.dirname(answerFile), '_stats.json');
          fs.writeFileSync(
            statsPath,
            JSON.stringify({
              durationMs: Date.now() - startedAt,
              ...(usageForStats ? { usage: usageForStats } : {}),
            }),
            'utf-8',
          );
        } catch {
          /* sidecar is informational; ignore write errors */
        }
        // participant_done payload carries identity only — the cockpit
        // refetches /api/run-artifacts on this event to pick up the
        // sidecar-backed stats. Earlier diff also embedded durationMs
        // and usage in the SSE payload; retroactive PR #16 review by
        // both opencode reviewers flagged those as dead bytes never
        // consumed on the cockpit side.
        onEvent({
          chatId,
          type: 'participant_done',
          payload: {
            phaseId: phase.id,
            round,
            role: 'doer',
            agent: agentName,
          },
          ts: Date.now(),
        });
      } else if (event.type === 'error') {
        errored = true;
        // Mirror reviewer.ts: persist OpenRouter HTTP-error state into
        // cli-health so the home-page card flips to quota/auth/rate-limit
        // and so the run-page error event carries a remediation CTA.
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
          // Non-openrouter headless errors: persist health under the doer's
          // lineage when the error kind is one the tmux path already
          // records (token_refresh_lost, quota_exhausted, ...). Without
          // this the precheck cooldown can't fire on subsequent chats —
          // see reviewer.ts for the matching block.
          const mapped = kindToStatus(event.kind);
          const doerLineage = phase.doer.lineage;
          if (mapped !== 'unknown' && isKnownHealthLineage(doerLineage)) {
            recordHealth({
              lineage: doerLineage as CliLineage,
              status: mapped,
              message: event.message,
            }).catch((healthErr: unknown) => {
              console.error(
                `[chorus] recordHealth failed for ${doerLineage}:`,
                healthErr,
              );
            });
          }
        }
        // Vague→specific upgrade rule. Gemini's stream-parser emits a
        // generic `gemini_result_error` from the JSON result line; the
        // on-exit handler then emits a precise `quota_exhausted` from
        // stderr with the reset window. Without this upgrade the doer
        // card shows the vague first message and the user has no idea
        // when their quota resets. Mirrors reviewer.ts — keep these
        // sets in sync.
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
            role: 'doer',
            agent: agentName,
            error: {
              kind: event.kind,
              message: classified?.message ?? event.message,
              ...(classified?.cta ? { cta: classified.cta } : {}),
              lineage: phase.doer.lineage,
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
        role: 'doer',
        agent: agentName,
        error: {
          kind: 'stream_failure',
          message,
          lineage: phase.doer.lineage,
        },
      },
      ts: Date.now(),
    });
  } finally {
    writer.flushNow();
    // Mirror reviewer.ts: synthesise a `no_output` failure when the CLI
    // closed without emitting any event (silent failure mode — most
    // often a CLI writing to /dev/tty instead of the pipe). Without this,
    // the doer phase swallows the failure and the chat sits with a
    // zero-byte answer.md and no error signal. PR #70 audit (gemini-cli-1)
    // flagged the asymmetry between reviewer and doer.
    if (eventCount === 0 && !errorSummary) {
      errored = true;
      errorSummary = {
        kind: 'no_output',
        message:
          `${phase.doer.lineage} CLI closed without emitting any output. ` +
          `Likely a transport bug (e.g. opencode 1.14.x writes JSON only to a TTY) ` +
          `or a silent abort. Check the CLI's own log for details.`,
      };
    }
    // When the subprocess errored without a complete message_done, write
    // the error summary to answer.md so the chat dir is self-explanatory.
    // Append (not overwrite) when partial content survived so post-mortem
    // sees both. Mirrors the matching block in runReviewerHeadless — keep
    // them in sync.
    // Mirror the classified error onto the caller's out-param so the
    // doer-driver can decide retry-vs-advance without re-parsing
    // answer.md. Only mutated on errored runs. Falls back to 'unknown'
    // if errored fired before errorSummary was set so the caller's
    // out-param is never left undefined on a real failure (matches
    // reviewer.ts; caught by chorus self-audit on PR #79).
    if (errored && lastError) {
      lastError.kind = errorSummary?.kind ?? 'unknown';
      lastError.message =
        errorSummary?.message ?? '(no message captured)';
    }
    if (errored && !finalText && errorSummary) {
      try {
        let resetAt: number | undefined;
        try {
          const h = await getHealth(phase.doer.lineage as CliLineage);
          if (typeof h.resetAt === 'number' && h.resetAt > Date.now()) {
            resetAt = h.resetAt;
          }
        } catch {
          /* health lookup is informational */
        }
        const summaryBlock =
          `## DOER FAILED\n\n` +
          `**Kind:** ${errorSummary.kind}\n` +
          `**Lineage:** ${phase.doer.lineage}\n` +
          `**Model:** ${modelOverride ?? phase.doer.models?.[0] ?? '(default)'}\n` +
          (resetAt ? `**Resets:** ${new Date(resetAt).toISOString()}\n` : '') +
          `\n${errorSummary.message}\n`;
        const existing = accumulated.length > 0 && fs.existsSync(answerFile)
          ? fs.readFileSync(answerFile, 'utf-8')
          : '';
        if (existing.length === 0) {
          fs.writeFileSync(answerFile, summaryBlock);
        } else {
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
    // If the StreamFileWriter went dead (FS ENOSPC, EACCES, etc.) it
    // dropped the failing chunk to avoid retrying the same sync write
    // forever. Surface this so the user sees "stream stopped writing"
    // rather than silently truncated answer.md.
    if (writer.isDead()) {
      const err = writer.lastError();
      onEvent({
        chatId,
        type: 'cli_warning',
        payload: {
          phaseId: phase.id,
          round,
          role: 'doer',
          agent: agentName,
          reason: 'stream_writer_dead',
          message: `answer.md write failed; subsequent deltas dropped: ${err ? err.message : 'unknown'}`,
          cta: 'Check disk space + permissions on ~/.chorus/chats. Re-run when fixed.',
        },
        ts: Date.now(),
      });
    }
  }

  if (errored && finalText === undefined && accumulated.length === 0) {
    return null;
  }

  const content = finalText && finalText.length > 0 ? finalText : accumulated;

  if (finalText === undefined && content.trim().length === 0) {
    return null;
  }

  // `full` means "the doer's answer is complete" — a truthful signal to
  // downstream reviewers that they can review the artifact as-is. An
  // errored stream that wrote partial bytes before the subprocess crashed
  // must NOT be marked full: reviewers receiving truncated mid-paragraph
  // text will silently produce nonsense verdicts on a half-written answer.
  // Only treat as full when EITHER the parser saw a final message_done
  // (finalText set) AND no error, OR we accumulated text without any
  // error mid-stream. The launch-eve gemini review of runner orchestration
  // flagged this — earlier code returned full=true whenever
  // `accumulated.length > 0`, regardless of `errored` state.
  const isFull = !errored && (finalText !== undefined || accumulated.length > 0);

  return {
    content,
    full: isFull,
    ...(capturedUsage ? { usage: capturedUsage } : {}),
  };
}
