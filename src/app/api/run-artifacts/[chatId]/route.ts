/**
 * Filesystem-backed artifacts endpoint for the run page.
 * Returns the structure of ~/.chorus/chats/<id>/round-N/<participant>/answer.md
 * as a JSON tree the LiveRunReal client component can consume.
 *
 * Reads from disk, no DB. Cheap enough to poll every 4s. Daemon and Next.js
 * are co-hosted so the filesystem read is local.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AGENT_TO_UI_LINEAGE as AGENT_TO_LINEAGE } from "@/lib/agent-name-map";

interface ParticipantSnapshot {
  participant: string;
  role: "doer" | "reviewer";
  agentName: string;
  lineage: string;
  hasAnswer: boolean;
  answer?: string;
  findingsPreview?: string[];
  binaryUsed?: string;
  modelUsed?: string;
}

interface RoundSnapshot {
  round: number;
  participants: ParticipantSnapshot[];
}

interface SwapEntry {
  round: number;
  phaseId: string;
  role: "doer" | "reviewer";
  agent: string;
  reason: "lineage_fallback" | "model_fallback";
  fromLineage: string;
  toLineage: string;
  fromModel: string;
  toModel: string;
  fallbackIdx: number;
  ts: number;
  fromErrorKind?: string;
  fromErrorMessage?: string;
}

/**
 * Full shape validation — sidecar is on disk and could be hand-edited
 * or written by an older runner. Returns the typed entry on success or
 * null. The UI sorts on `fallbackIdx` (NaN if missing) and branches on
 * `reason` (silent fallthrough to "Model fallback" if unknown), so
 * loose validation propagates display bugs.
 */
function isValidSwapEntry(entry: unknown): SwapEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.round !== "number") return null;
  if (typeof e.phaseId !== "string") return null;
  if (e.role !== "doer" && e.role !== "reviewer") return null;
  if (typeof e.agent !== "string") return null;
  if (e.reason !== "lineage_fallback" && e.reason !== "model_fallback")
    return null;
  if (typeof e.fromLineage !== "string") return null;
  if (typeof e.toLineage !== "string") return null;
  if (typeof e.fromModel !== "string") return null;
  if (typeof e.toModel !== "string") return null;
  if (typeof e.fallbackIdx !== "number") return null;
  if (typeof e.ts !== "number") return null;
  return e as unknown as SwapEntry;
}

/**
 * Reads `_attempts.jsonl` from a participant dir and indexes the rows by
 * model id. Used to enrich swap entries with the underlying error of the
 * failed attempt — the JSONL is append-only, so multi-step fallback chains
 * leave one row per attempt (oldest first). On a model collision we keep
 * the latest entry, which matches "the most recent failure for this
 * model" when the swap UI is interpreting a single chain.
 */
function readAttemptsByModel(
  partDir: string,
): Map<string, { errorKind: string; errorMessage: string }> {
  const map = new Map<string, { errorKind: string; errorMessage: string }>();
  const attemptsPath = path.join(partDir, "_attempts.jsonl");
  if (!fs.existsSync(attemptsPath)) return map;
  try {
    const lines = fs
      .readFileSync(attemptsPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        const model =
          typeof e.model === "string" ? e.model : "(default)";
        const errorKind =
          typeof e.errorKind === "string" ? e.errorKind : "unknown";
        const errorMessage =
          typeof e.errorMessage === "string"
            ? e.errorMessage.slice(0, 200)
            : "";
        map.set(model, { errorKind, errorMessage });
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* best-effort */
  }
  return map;
}

/**
 * Walks every participant dir under a chat and aggregates the
 * `_swaps.json` sidecars into a flat array. Mirrors how _stats.json
 * is consumed: the run page renders one swap card per entry. Empty
 * array when no swaps fired.
 */
function readChatSwaps(chatId: string): SwapEntry[] {
  const chatDir = path.join(os.homedir(), ".chorus", "chats", chatId);
  if (!fs.existsSync(chatDir)) return [];
  const out: SwapEntry[] = [];
  for (const round of fs
    .readdirSync(chatDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("round-"))) {
    const roundDir = path.join(chatDir, round.name);
    for (const part of fs.readdirSync(roundDir, { withFileTypes: true })) {
      if (!part.isDirectory()) continue;
      const partDir = path.join(roundDir, part.name);
      const swapPath = path.join(partDir, "_swaps.json");
      if (!fs.existsSync(swapPath)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(swapPath, "utf-8"));
        if (Array.isArray(parsed)) {
          // Pre-load _attempts.jsonl once per participant dir — each swap
          // entry's "from" side maps to the JSONL row whose model matches
          // the swap's fromModel. Lets the UI render "kimi-k2.6 failed:
          // cli_failed — model not found" instead of a bare arrow.
          const attemptsByModel = readAttemptsByModel(partDir);
          for (const entry of parsed) {
            const valid = isValidSwapEntry(entry);
            if (!valid) continue;
            const att = attemptsByModel.get(valid.fromModel);
            if (att) {
              valid.fromErrorKind = att.errorKind;
              valid.fromErrorMessage = att.errorMessage;
            }
            out.push(valid);
          }
        }
      } catch {
        /* malformed sidecar — skip */
      }
    }
  }
  return out;
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
        const role: "doer" | "reviewer" = d.name.startsWith("doer-")
          ? "doer"
          : "reviewer";
        // Strip role prefix and trailing -N for reviewer indices.
        const rawAgent = d.name.replace(/^(doer-|reviewer-)/, "").replace(/-\d+$/, "");
        const lineage = AGENT_TO_LINEAGE[rawAgent] ?? rawAgent;
        const answerPath = path.join(roundDir, d.name, "answer.md");
        // `hasAnswer` means "this participant finished" — gated on the
        // `## DONE` sentinel the runner appends to answer.md when the
        // shim's message_done fires. Earlier code used `.trim().length > 0`,
        // which flipped to DONE the moment the buffered StreamFileWriter
        // flushed its first chunk to disk — so a mid-stream doer rendered
        // as "DONE · No output yet." until the next poll. The sentinel
        // is the only durable signal that the participant is actually
        // finished. See ROADMAP #15.
        let hasAnswer = false;
        let answer: string | undefined;
        let findingsPreview: string[] | undefined;
        if (fs.existsSync(answerPath)) {
          try {
            answer = fs.readFileSync(answerPath, "utf-8");
            hasAnswer = /\n##\s*DONE\s*\n?$/i.test(answer.trimEnd());
            // Only emit findingsPreview when the participant is actually
            // done. Mid-stream content here would suppress the liveTail
            // rendering in the card body, hiding the streaming text from
            // the user.
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
        // Transport sidecar — runner writes `{binary,model}` at spawn time
        // for participants whose lineage has multiple transports (e.g.
        // kimi via standalone CLI vs opencode-go). Cards prefer these
        // over template defaults so the user sees what actually ran.
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
            /* sidecar is informational; ignore parse errors */
          }
        }
        // Stats sidecar — runner writes `{durationMs,usage}` at
        // participant_done. Powers the time/tokens chips on the card.
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
            /* sidecar is informational; ignore parse errors */
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

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ chatId: string }> },
) {
  const { chatId } = await params;
  // Defense-in-depth: chatId is a ULID-looking string. Reject paths with `..`
  // or slashes so a malformed param can't escape the chats dir.
  if (chatId.includes("..") || chatId.includes("/") || chatId.includes("\\")) {
    return Response.json({ rounds: [] }, { status: 400 });
  }
  const rounds = readChatRounds(chatId);
  const swaps = readChatSwaps(chatId);
  return Response.json({ rounds, swaps });
}
