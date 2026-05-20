import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { notFound } from "next/navigation";
import { LiveRunReal } from "@/components/live-run-real";
import { getChat, getTemplate, DaemonError } from "@/lib/api";

export const dynamic = "force-dynamic";

interface RunPageProps {
  params: Promise<{ runId: string }>;
}

async function getRunData(runId: string) {
  // Chat row + template are loaded independently. Template lookup is allowed
  // to fail (template deleted after the chat ran) — the chat is immutable
  // history and shouldn't 500 just because the user removed the template.
  // LiveRunReal accepts `template: Template | null` and degrades to a
  // template-less render (no phase stepper labels) when it's missing.
  let chat;
  try {
    chat = await getChat(runId);
  } catch (err) {
    throw err instanceof DaemonError ? err : new Error("Failed to load chat");
  }
  // Prefer the frozen snapshot captured at run-fire — this is what the
  // chat actually executed against. Without this, editing the template
  // later (adding/removing/renaming reviewers) retroactively reshapes
  // every old run page: phantom QUEUED cards for new candidates, lost
  // model labels on participants whose slot no longer exists. Fall back
  // to the live template only for chats that pre-date the snapshot
  // column (or chats deleted after run completion).
  let template = chat.templateSnapshot ?? null;
  if (!template) {
    try {
      template = await getTemplate(chat.templateId);
    } catch {
      // Template was deleted AND no snapshot exists — chat still renders,
      // just without template-derived UI (placeholder reviewer cards from
      // candidate definitions, phase names, etc.). Recorded participants
      // still come from disk via /api/run-artifacts.
    }
  }
  return { chat, template };
}

const AGENT_TO_LINEAGE: Record<string, "claude" | "codex" | "gemini" | "opencode" | "kimi" | "openrouter"> = {
  "claude-code": "claude",
  "codex-cli": "codex",
  "gemini-cli": "gemini",
  "opencode-cli": "opencode",
  "kimi-cli": "kimi",
  // HTTP-dispatched shim — runner creates `reviewer-openrouter-N` dirs;
  // without this entry the lineage fell through to "claude" and rendered
  // OpenRouter answers with the wrong brand on the run page.
  openrouter: "openrouter",
};

interface ParticipantSnapshot {
  participant: string;
  role: "doer" | "reviewer";
  agentName: string;
  lineage: "claude" | "codex" | "gemini" | "opencode" | "kimi" | "openrouter";
  hasAnswer: boolean;
  answer?: string;
  findingsPreview?: string[];
  binaryUsed?: string;
  modelUsed?: string;
  durationMs?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    costUsd?: number;
  };
}

interface RoundSnapshot {
  round: number;
  participants: ParticipantSnapshot[];
}

function readChatRounds(chatId: string): RoundSnapshot[] {
  const chatDir = path.join(os.homedir(), ".chorus", "chats", chatId);
  if (!fs.existsSync(chatDir)) return [];

  const entries = fs
    .readdirSync(chatDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("round-"));

  const rounds: RoundSnapshot[] = [];
  for (const entry of entries) {
    const roundNum = parseInt(entry.name.replace("round-", ""), 10);
    if (!Number.isFinite(roundNum)) continue;

    const roundDir = path.join(chatDir, entry.name);
    const participants: ParticipantSnapshot[] = fs
      .readdirSync(roundDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const role: "doer" | "reviewer" = d.name.startsWith("doer-") ? "doer" : "reviewer";
        const rawAgent = d.name.replace(/^(doer-|reviewer-)/, "").replace(/-\d+$/, "");
        const lineage = AGENT_TO_LINEAGE[rawAgent] ?? "claude";
        const answerPath = path.join(roundDir, d.name, "answer.md");
        // hasAnswer must mirror the API route: gated on the `## DONE`
        // sentinel so a mid-stream doer doesn't render as "done · no
        // output yet" when the user lands on the page during a live run.
        let hasAnswer = false;
        let answer: string | undefined;
        let findingsPreview: string[] | undefined;
        if (fs.existsSync(answerPath)) {
          try {
            answer = fs.readFileSync(answerPath, "utf-8");
            hasAnswer = /\n##\s*DONE\s*\n?$/i.test(answer.trimEnd());
            if (hasAnswer) {
              findingsPreview = answer
                .split("\n")
                .filter((l) => l.trim().length > 0 && !l.startsWith("##"))
                .slice(0, 4)
                .map((l) => (l.length > 90 ? l.slice(0, 90) + "…" : l));
            }
          } catch {
            answer = undefined;
          }
        }
        let binaryUsed: string | undefined;
        let modelUsed: string | undefined;
        const metaPath = path.join(roundDir, d.name, "_meta.json");
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as {
              binary?: unknown;
              model?: unknown;
            };
            if (typeof meta.binary === "string") binaryUsed = meta.binary;
            if (typeof meta.model === "string") modelUsed = meta.model;
          } catch {
            /* informational sidecar; ignore parse errors */
          }
        }
        // Stats sidecar — runner writes `{durationMs, usage}` at
        // participant_done. Without reading it here, terminal chats
        // (which skip the live run-artifacts polling) render with
        // empty time/tokens/cost chips. Mirrors the same parse in
        // /api/run-artifacts/[chatId]/route.ts.
        let durationMs: number | undefined;
        let usage:
          | {
              inputTokens?: number;
              outputTokens?: number;
              cachedInputTokens?: number;
              costUsd?: number;
            }
          | undefined;
        const statsPath = path.join(roundDir, d.name, "_stats.json");
        if (fs.existsSync(statsPath)) {
          try {
            const stats = JSON.parse(fs.readFileSync(statsPath, "utf-8")) as {
              durationMs?: unknown;
              usage?: {
                inputTokens?: unknown;
                outputTokens?: unknown;
                cachedInputTokens?: unknown;
                costUsd?: unknown;
              };
            };
            if (typeof stats.durationMs === "number") durationMs = stats.durationMs;
            if (stats.usage && typeof stats.usage === "object") {
              const u: Record<string, number> = {};
              if (typeof stats.usage.inputTokens === "number")
                u.inputTokens = stats.usage.inputTokens;
              if (typeof stats.usage.outputTokens === "number")
                u.outputTokens = stats.usage.outputTokens;
              if (typeof stats.usage.cachedInputTokens === "number")
                u.cachedInputTokens = stats.usage.cachedInputTokens;
              if (typeof stats.usage.costUsd === "number")
                u.costUsd = stats.usage.costUsd;
              if (Object.keys(u).length > 0) usage = u;
            }
          } catch {
            /* informational sidecar; ignore parse errors */
          }
        }
        return {
          participant: d.name,
          role,
          agentName: rawAgent,
          lineage,
          hasAnswer,
          answer,
          findingsPreview,
          binaryUsed,
          modelUsed,
          durationMs,
          usage,
        };
      });

    rounds.push({ round: roundNum, participants });
  }

  return rounds.sort((a, b) => a.round - b.round);
}

export default async function RunPage({ params }: RunPageProps) {
  const { runId } = await params;
  const { chat, template } = await getRunData(runId);

  if (!chat) {
    notFound();
  }

  const initialRounds = readChatRounds(chat.id);

  return (
      <LiveRunReal
        chatId={chat.id}
        initialStatus={chat.status}
        initialRounds={initialRounds}
        template={template}
        templateId={chat.templateId}
        work={chat.work}
        initialPrUrl={chat.prUrl}
        initialShipError={chat.shipError}
        initialVerdict={chat.verdict}
      />
  );
}
