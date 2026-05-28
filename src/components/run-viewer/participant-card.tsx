"use client";

import { useState } from "react";
import { AlertTriangle, ArrowRight, Maximize2, Shuffle, X } from "lucide-react";
import { uiLineageDot, uiLineageLabel } from "@/lib/lineage-maps";
import { LINEAGE_GRADIENT } from "./lineage-gradient";
import { StateBadge } from "./state-badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FallbackSwap, ParticipantSnapshot, ParticipantState } from "./types";
import type { ReviewerLineage } from "@/lib/types";

/**
 * Display lineage = what to colour/label the card by.
 *
 * The slot's nominal lineage (e.g. "kimi") drives diversity scoring on the
 * daemon side. But moonshot has dual transports — standalone `kimi` CLI
 * vs `opencode -m opencode-go/kimi-k2.6`. Users without a Moonshot sub
 * route everything through opencode, so badging the card "KIMI" is
 * actively misleading: it implies a binary they don't have. When the
 * runtime sidecar tells us the binary was `opencode-cli`, badge the card
 * as opencode. The model id (`opencode-go/kimi-k2.6` vs
 * `opencode-go/deepseek-v4-pro`) still distinguishes voices visually.
 */
function displayLineage(p: ParticipantSnapshot): ReviewerLineage {
  if (p.binaryUsed === "opencode-cli") return "opencode";
  return p.lineage;
}

/**
 * One reviewer/doer card in the run grid.
 *
 * Card state precedence (most-specific first):
 *   pending  — placeholder synthesised from template, no dir on disk yet
 *   done     — answer.md has non-empty content
 *   working  — chat is mid-run AND (proc is alive OR live tail has bytes)
 *   errored  — chat is in a terminal state but this participant produced 0 B
 *   idle     — fall-through (rare; shouldn't normally render)
 */
export function ParticipantCard({
  participant,
  isActive,
  liveTail,
  chatTerminal,
  chatId,
  reviewOnly,
  swaps,
}: {
  participant: ParticipantSnapshot;
  isActive: boolean;
  liveTail?: string;
  /** Chat itself reached a terminal state — distinguishes "errored (no
   *  output produced even though run finished)" from "still working". */
  chatTerminal: boolean;
  /** When provided AND the card is in working state, render a per-card
   *  cancel button. Routes to /chats/:id/participants/:key/cancel.
   *  When omitted (older callers, terminal chats), the button is hidden. */
  chatId?: string;
  /** True when the chat is a review-only template (no doer phase). The
   *  pending-state copy swaps from "runs after the doer" to a generic
   *  "queued" line in that case — there is no doer to wait for. */
  reviewOnly?: boolean;
  /** Fallback swaps that fired on this slot (per-slot model fallback or
   *  cross-lineage). Rendered as inline rows under the header showing
   *  what voice ACTUALLY produced the answer — the slot's identity in
   *  the header stays bound to its primary lineage so cards don't
   *  re-key mid-run. Empty when no swap fired. */
  swaps?: FallbackSwap[];
}) {
  const [cancelling, setCancelling] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // State precedence: pending (synthesised slot) → done (answer on disk) →
  // errored (chat terminal but no answer) → working (the implicit
  // non-terminal mid-flight state). Earlier code gated "working" on isActive
  // or liveTail bytes, but those signals lag behind phase_start replay and
  // would briefly flicker the card to "idle" — making it look frozen
  // between phase_start and the first text_delta. Anchoring on chat status
  // closes that window.
  // When the runner wrote a `## REVIEWER FAILED` summary (PR #11
  // silent-failure preempt), surface its parsed Kind + body in the
  // errored state instead of the generic "didn't produce any output"
  // message. The summary always carries the reason the LLM CLI failed
  // (quota_exhausted, refresh_token_stale, cli_failed, ...).
  const failure = parseFailureSummary(participant.answer);

  // State precedence — `failure` MUST come before the chatTerminal check.
  // The runner writes `## REVIEWER FAILED ...` to answer.md when a CLI
  // dies, but does NOT append `## DONE` (failure summaries aren't
  // "answers"). Without elevating failure here, a single reviewer that
  // crashes mid-chat would sit in `working` (showing "Thinking...") for
  // the rest of the run, only flipping to `errored` when chatTerminal
  // becomes true. Launch-eve gemini review of the run page caught this —
  // a stuck-WORKING card is a UX trust hit. Same precedence applies to
  // doer cards via the same helper.
  const state: ParticipantState = participant.pending
    ? "pending"
    : participant.hasAnswer
      ? "done"
      : failure
        ? "errored"
        : chatTerminal
          ? "errored"
          : "working";

  const ui = displayLineage(participant);

  return (
    <div
      className={`flex h-[320px] flex-col overflow-hidden rounded-lg border transition-[opacity,border-color,box-shadow] duration-300 ${
        LINEAGE_GRADIENT[ui] ?? "bg-card"
      } ${
        state === "done"
          ? "border-emerald-500/30"
          : state === "working"
            ? "border-primary/60 shadow-[0_0_0_1px_rgba(124,58,237,0.25),0_0_24px_-6px_rgba(124,58,237,0.45)] animate-pulse-soft"
            : state === "errored"
              ? "border-destructive/40"
              : state === "pending"
                ? "border-border/40 opacity-50 grayscale-[0.6]"
                : "border-border"
      }`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card/60 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2 text-xs leading-none">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${uiLineageDot(ui)} ${
              state === "working" ? "animate-pulse-soft" : ""
            }`}
          />
          <span className="font-medium capitalize text-foreground">{participant.role}</span>
          <span className="text-muted-foreground">·</span>
          <span className="uppercase tracking-wider text-muted-foreground">
            {uiLineageLabel(ui)}
          </span>
          {(participant.modelUsed ?? participant.model) && (
            <>
              <span className="text-muted-foreground/60">·</span>
              <span className="truncate font-mono text-muted-foreground">
                {participant.modelUsed ?? participant.model}
              </span>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {state === "working" && chatId && (
            <button
              type="button"
              disabled={cancelling}
              onClick={async () => {
                if (cancelling) return;
                setCancelling(true);
                try {
                  const res = await fetch(
                    `/api/daemon/chats/${chatId}/participants/${encodeURIComponent(participant.participant)}/cancel`,
                    { method: "POST" },
                  );
                  if (!res.ok) {
                    setCancelling(false);
                    return;
                  }
                  const body = (await res.json()) as {
                    ok: boolean;
                    data?: { aborted?: boolean };
                    error?: { message?: string };
                  };
                  if (!body.ok) {
                    window.alert(
                      `Couldn't cancel: ${body.error?.message ?? "unknown error"}`,
                    );
                    setCancelling(false);
                    return;
                  }
                  // Leave `cancelling=true` until the SSE flips this
                  // card's state away from working — avoids a re-click
                  // before the runner actually exits. The chat-level
                  // SSE handler will re-render with state==='errored'
                  // (no output) once the abort propagates.
                  //
                  // Fallback: if SSE never fires (stalled stream, dead
                  // chat, network drop) the button would otherwise be
                  // disabled forever. Reset after 15s so the user can
                  // retry. Flagged in retroactive PR #24 review by
                  // gemini + opencode-deepseek.
                  setTimeout(() => setCancelling(false), 15_000);
                } catch {
                  setCancelling(false);
                }
              }}
              aria-label="Cancel this reviewer"
              title="Cancel this reviewer (chat continues with others)"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-border bg-card/40 text-muted-foreground transition hover:border-destructive/40 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X className="h-3 w-3" />
            </button>
          )}
          <StateBadge state={state} />
        </div>
      </div>

      {swaps && swaps.length > 0 && (() => {
        const sorted = swaps.slice().sort((a, b) => a.fallbackIdx - b.fallbackIdx);
        // Suppress the banner block entirely when the primary produced
        // the displayed answer AND no swap target actually ran. This
        // is the gemini bowerbird case (verdict_ambiguous false-
        // positive → fallback fired → collision → chain exhausted)
        // where the slot card was rendering DONE + content + three
        // contradictory amber banners. The primary's content stands
        // on its own; the failed-fallback breadcrumbs are noise.
        const someSwapActuallyRan = sorted.some((s) => s.actuallyRan);
        if (participant.hasAnswer && !someSwapActuallyRan) return null;
        return (
          <div className="space-y-1.5 border-b border-amber-500/30 bg-amber-500/5 px-4 py-2 text-[11px]">
            {sorted.map((s, i) => {
              const isCross = s.reason === "lineage_fallback";
              // `actuallyRan` is the truth-bearing signal — derived
              // server-side from the slot's `_stats.json` lineage+
              // model stamp matching this entry's `to` voice. The
              // pre-fix `isLast` heuristic was wrong for collision-
              // exhausted chains (where the last entry's TO voice
              // never ran). Strikethrough + dim styling applies to
              // any entry where the TO didn't run.
              const ran = s.actuallyRan === true;
              return (
                <div
                  key={`${s.fromLineage}-${s.fromModel}-${i}`}
                  className="flex items-start gap-2"
                >
                  <Shuffle className="mt-0.5 h-3 w-3 shrink-0 text-amber-300" />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="font-medium uppercase tracking-wider text-[10px] text-amber-300">
                      {isCross ? "Cross-lineage fallback" : "Model fallback"}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-amber-100/90">
                      <span className="text-amber-100/60 line-through">
                        {s.fromLineage}/{s.fromModel}
                      </span>
                      <ArrowRight className="h-3 w-3 shrink-0 text-amber-300" />
                      <span
                        className={
                          ran
                            ? "font-medium text-amber-100"
                            : "text-amber-100/60 line-through"
                        }
                      >
                        {s.toLineage}/{s.toModel}
                      </span>
                      {ran && (
                        <span className="rounded bg-amber-500/15 px-1 py-0.5 font-mono text-[9px] text-amber-200">
                          actually ran
                        </span>
                      )}
                    </div>
                    {s.fromErrorKind && (
                      <div className="text-[10px] text-amber-200/75">
                        <span className="font-mono uppercase tracking-wider text-amber-300/90">
                          {s.fromErrorKind}
                        </span>
                        {s.fromErrorMessage && (
                          <span className="ml-1.5 text-amber-100/80">
                            — {s.fromErrorMessage}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}

      {participant.warnings && participant.warnings.length > 0 && (
        <div className="space-y-1 border-b border-amber-500/30 bg-amber-500/5 px-4 py-2 text-[11px] text-amber-200/90">
          {participant.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" />
              <div className="min-w-0 flex-1">
                <span className="font-medium uppercase tracking-wider text-[10px] text-amber-300">
                  {w.kind}
                </span>
                <div className="mt-0.5 break-words font-mono text-[11px] leading-snug text-amber-100/85">
                  {w.message}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-3 font-mono text-xs leading-relaxed text-muted-foreground">
        {participant.findingsPreview && participant.findingsPreview.length > 0 ? (
          participant.findingsPreview.map((line, i) => (
            <div key={i} className="py-0.5 text-foreground/90">
              {line}
            </div>
          ))
        ) : state === "working" && liveTail && liveTail.length > 0 ? (
          // Live tail from headless transport — last ~500 chars of streaming
          // output. Gated on state==="working" so a stale tail keyed by
          // role:lineage (e.g. Round 1 reviewer's last text) can't leak
          // into a freshly-pending Round 2 reviewer card.
          //
          // `column-reverse` keeps the most recent output anchored at the
          // bottom and scrolls older output off the top — same visual the
          // user gets from `tail -f` and what production CLI streams expect.
          // The fixed card height (h-[320px] above) means streaming content
          // never grows the card, eliminating the layout shift across cards
          // on the same row.
          <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
            <pre className="whitespace-pre-wrap break-words text-foreground/85">
              {liveTail}
            </pre>
          </div>
        ) : state === "working" ? (
          <div className="text-muted-foreground">Thinking…</div>
        ) : state === "pending" ? (
          <div className="text-muted-foreground/70">
            {reviewOnly
              ? "Queued — waiting for an open slot."
              : "Queued — runs after the doer."}
          </div>
        ) : state === "errored" ? (
          failure ? (
            <div className="space-y-1.5 text-destructive/90">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider">
                  {failure.kind}
                </span>
                {failure.resetAt && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                    Resets {formatResetAt(failure.resetAt)}
                  </span>
                )}
              </div>
              <div className="whitespace-pre-wrap break-words text-foreground/85">
                {failure.message}
              </div>
              {failure.cta && (
                <div className="text-[11px] text-muted-foreground/80">
                  {failure.cta}
                </div>
              )}
            </div>
          ) : (
            <div className="text-destructive/80">
              The program finished but didn&apos;t produce any output.
            </div>
          )
        ) : state === "done" && participant.answer ? (
          // DONE state — render the answer inline, top-anchored, with
          // overflow scrolled internally so the card stays at fixed
          // height. Click anywhere on the answer body to expand into a
          // full-screen modal showing the complete output (per user
          // feedback: truncated text on the card means there was no way
          // to read past the fold).
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="group min-h-0 flex-1 cursor-zoom-in overflow-y-auto rounded text-left transition-colors hover:bg-foreground/5 focus:outline-none focus:ring-2 focus:ring-primary/40"
            title="Click to view the full answer"
          >
            <pre className="whitespace-pre-wrap break-words text-foreground/85">
              {participant.answer}
            </pre>
          </button>
        ) : (
          <div className="text-muted-foreground/70">No output yet.</div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border bg-card/60 px-4 py-2 font-mono text-[10px] text-muted-foreground">
        <span className="truncate">{participant.binaryUsed ?? participant.agentName}</span>
        <span className="flex shrink-0 items-center gap-2">
          {participant.durationMs !== undefined && (
            <span title="Wall-clock time the CLI took to finish.">
              {formatDuration(participant.durationMs)}
            </span>
          )}
          {participant.usage?.costUsd !== undefined && (
            <span title="USD cost reported by the CLI for this run.">
              {formatCost(participant.usage.costUsd)}
            </span>
          )}
          {participant.usage && formatTokens(participant.usage) && (
            <span title={tokensTitle(participant.usage)}>
              {formatTokens(participant.usage)}
            </span>
          )}
          <span>
            {participant.hasAnswer
              ? `${(participant.answer?.length ?? 0).toLocaleString()} B`
              : "—"}
          </span>
          {state === "done" && participant.answer && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground/80 transition-colors hover:bg-foreground/10 hover:text-foreground"
              title="View full answer"
            >
              <Maximize2 className="h-3 w-3" />
              <span className="hidden sm:inline">expand</span>
            </button>
          )}
        </span>
      </div>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${uiLineageDot(ui)}`}
              />
              <span className="font-medium capitalize">{participant.role}</span>
              <span className="text-muted-foreground">·</span>
              <span className="uppercase tracking-wider text-muted-foreground">
                {uiLineageLabel(ui)}
              </span>
              {(participant.modelUsed ?? participant.model) && (
                <>
                  <span className="text-muted-foreground/60">·</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {participant.modelUsed ?? participant.model}
                  </span>
                </>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto rounded border border-border bg-card/40 p-4">
            <pre className="whitespace-pre-wrap break-words text-sm text-foreground/90">
              {participant.answer ?? ""}
            </pre>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m${r.toString().padStart(2, "0")}s`;
}

/**
 * Render USD cost as either `$0.022` (sub-dollar) or `$0.30` / `$2.45`.
 * Sub-cent costs round to the nearest cent — opencode reports
 * fractional cents (e.g. 0.000123) which clutter the chip; users care
 * about totals, not micro-cost precision.
 */
function formatCost(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(u: NonNullable<ParticipantSnapshot["usage"]>): string | null {
  const total = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
  if (total <= 0) return null;
  if (total < 1000) return `${total} tok`;
  return `${(total / 1000).toFixed(1)}k tok`;
}

function tokensTitle(u: NonNullable<ParticipantSnapshot["usage"]>): string {
  const parts: string[] = [];
  if (u.inputTokens !== undefined) parts.push(`in ${u.inputTokens.toLocaleString()}`);
  if (u.outputTokens !== undefined) parts.push(`out ${u.outputTokens.toLocaleString()}`);
  if (u.cachedInputTokens !== undefined)
    parts.push(`cached ${u.cachedInputTokens.toLocaleString()}`);
  return parts.join(" · ");
}

/**
 * Extract Kind + message from a `## REVIEWER FAILED` / `## DOER FAILED`
 * summary written by runReviewerHeadless / runDoerHeadless when a CLI
 * subprocess dies before producing content. Returns null when the answer
 * isn't a failure summary.
 *
 * Summary shape (per src/daemon/runner/{reviewer,doer}.ts finally block):
 *   ## REVIEWER FAILED
 *
 *   **Kind:** quota_exhausted
 *   **Lineage:** openai
 *   **Model:** gpt-5.5
 *
 *   ERROR: ...message...
 */
function parseFailureSummary(
  answer: string | undefined,
): { kind: string; message: string; cta?: string; resetAt?: number } | null {
  if (!answer) return null;
  const trimmed = answer.trimStart();
  if (!/^##\s+(?:REVIEWER|DOER)\s+FAILED/i.test(trimmed)) return null;
  const kindMatch = trimmed.match(/\*\*Kind:\*\*\s*(.+?)(?:\n|$)/);
  const kind = kindMatch ? kindMatch[1].trim() : "failed";
  // Optional `**Resets:** <iso-time>` line written by reviewer.ts/doer.ts
  // when cli-health knows when the upstream quota window expires.
  const resetMatch = trimmed.match(/\*\*Resets:\*\*\s*(.+?)(?:\n|$)/);
  let resetAt: number | undefined;
  if (resetMatch) {
    const t = Date.parse(resetMatch[1].trim());
    if (Number.isFinite(t)) resetAt = t;
  }
  // Body = everything after the first blank line that follows the
  // header block. The header block has Kind/Lineage/Model[/Resets] lines.
  const headerEnd = trimmed.search(/\n\n[^*]/);
  const body = headerEnd >= 0 ? trimmed.slice(headerEnd + 2).trim() : "";
  const message = body.length > 0 ? body : "(no error message reported)";
  // Map common kinds to a short call-to-action so the user knows what to do.
  // Pass the message text too so kind-CTAs can match on specific stderr
  // signatures (e.g. Claude's --dangerously-skip-permissions root refusal
  // surfaces as cli_failed but needs a very different remedy than re-auth).
  const cta = ctaForKind(kind, message);
  return {
    kind,
    message,
    ...(cta ? { cta } : {}),
    ...(resetAt ? { resetAt } : {}),
  };
}

function formatResetAt(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return "now";
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `in ${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) {
    const at = new Date(ms);
    return `at ${at.getHours().toString().padStart(2, "0")}:${at
      .getMinutes()
      .toString()
      .padStart(2, "0")}`;
  }
  const days = Math.round(hr / 24);
  return `in ${days}d`;
}

function ctaForKind(kind: string, message?: string): string | undefined {
  // Specific stderr signatures override the generic per-kind CTAs.
  // Claude CLI refuses --dangerously-skip-permissions when running as
  // root (Anthropic's security policy) — common on WSL where users
  // default to root. The generic "re-auth the CLI" CTA misleads them
  // into wasted login attempts.
  if (
    message &&
    /dangerously-skip-permissions cannot be used with root\/sudo/i.test(message)
  ) {
    return (
      "Claude CLI refuses --dangerously-skip-permissions as root. " +
      "Run chorus as a non-root user, or disable Claude voices in /connect."
    );
  }
  switch (kind) {
    case "quota_exhausted":
      return "Check your subscription dashboard or swap the account in CHORUS_CODEX_HOME / chorus settings.";
    case "stream_failure":
      return "Subprocess died mid-stream — check disk space and CLI version.";
    case "cli_failed":
    case "cli_error":
      return "Re-auth the CLI (codex/gemini/opencode login) and retry.";
    default:
      return undefined;
  }
}
