// Chat API endpoints
import { TemplateSchema } from "@/lib/template-schema";
import type { Chat, ListEnvelope, Template } from "@/lib/types";
import { fetchFromDaemon } from "./client";

interface RawChatRow {
  id: string;
  /** URL-friendly slug — present on chats created after the slug
   *  migration, null on legacy rows the daemon couldn't backfill. */
  slug?: string | null;
  work: string;
  template_id: string;
  status: Chat["status"];
  current_phase_idx?: number;
  yolo?: number | boolean;
  attached_files?: string | null;
  repo_path?: string | null;
  pr_url?: string | null;
  ship_error?: string | null;
  artifact?: string | null;
  verdict?: string | null;
  /** JSON-encoded Template snapshot captured at first run-fire. NULL on
   *  legacy rows. The daemon stores it as a string to keep list-page
   *  reads cheap; we parse here so the rest of the cockpit gets a
   *  ready-to-use Template object. */
  template_snapshot?: string | null;
  created_at: number;
  updated_at: number;
  finished_at?: number | null;
}

/**
 * Daemon stores chats with snake_case columns; the UI contract is camelCase.
 * Translate at the boundary so the rest of the app doesn't care.
 */
/**
 * Exported as a `_testing` seam — tests for the snapshot parse + zod
 * validation path need to drive `fromRow()` directly, not over HTTP.
 * Not part of the public API.
 * @internal
 */
export const _testing = {
  fromRow: (row: RawChatRow): Chat => fromRow(row),
};

function fromRow(row: RawChatRow): Chat {
  let attached: string[] | undefined;
  if (row.attached_files) {
    try {
      const parsed = JSON.parse(row.attached_files);
      if (Array.isArray(parsed)) attached = parsed;
    } catch {
      // ignore — leave undefined
    }
  }
  let templateSnapshot: Template | undefined;
  if (row.template_snapshot) {
    try {
      // Two layers of defense:
      //   1. JSON.parse — corrupt/malformed string (manual DB edit, FS hiccup).
      //   2. TemplateSchema.safeParse — schema drift between when this
      //      snapshot was captured and the current Template shape (new
      //      required field added in v0.x). Without this layer an unchecked
      //      cast would silently propagate structurally-incomplete objects
      //      to renderers, which then crash on missing fields. With it, old
      //      snapshots that no longer satisfy the current schema degrade
      //      cleanly to undefined → caller falls back to live template.
      //
      // Type note: the daemon-side `TemplateSchema` (runtime contract,
      // template-schema.ts) and the cockpit-side `Template` interface
      // (UI / marketplace shape, types.ts) overlap in the fields the run
      // page actually reads (id, name, phases). The cast bridges that
      // overlap; the schema validation above is the substantive check
      // that the data is well-formed.
      const parsed = JSON.parse(row.template_snapshot);
      const result = TemplateSchema.safeParse(parsed);
      if (result.success) {
        // Daemon-side TemplateSchema only carries `candidates` on each
        // ReviewerRule — the cockpit's Template type expects
        // `candidatesWithModels` populated (mirrors what
        // `lib/api/templates.ts:getTemplate` produces from the daemon's
        // /templates response). Without this derivation,
        // `enrichRounds` iterates zero reviewer slots from the snapshot
        // and no model name reaches the run-page cards. Regression
        // since chorus-101 (template snapshot, v0.8.26).
        const enriched = {
          ...result.data,
          phases: result.data.phases.map((p) => ({
            ...p,
            reviewer: p.reviewer
              ? {
                  ...p.reviewer,
                  candidatesWithModels:
                    // If a future daemon ever serialises this field
                    // directly, prefer it; otherwise derive from
                    // candidates.
                    (p.reviewer as { candidatesWithModels?: unknown[] })
                      .candidatesWithModels ??
                    (p.reviewer.candidates ?? []).map((c) => ({
                      lineage: c.lineage,
                      models: c.models ?? [],
                      ...(c.persona !== undefined ? { persona: c.persona } : {}),
                    })),
                }
              : p.reviewer,
          })),
        };
        templateSnapshot = enriched as unknown as Template;
      }
      // else: leave undefined — caller's fallback handles it
    } catch {
      // ignore — leave undefined
    }
  }
  return {
    id: row.id,
    slug: row.slug ?? undefined,
    work: row.work,
    templateId: row.template_id,
    status: row.status,
    currentPhaseIdx: row.current_phase_idx ?? 0,
    yolo: Boolean(row.yolo),
    attachedFiles: attached,
    repoPath: row.repo_path ?? undefined,
    prUrl: row.pr_url ?? undefined,
    shipError: row.ship_error ?? undefined,
    artifact: row.artifact ?? undefined,
    verdict: row.verdict ?? undefined,
    templateSnapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

export async function listChats(options?: {
  limit?: number;
  offset?: number;
  status?: string;
}): Promise<Chat[]> {
  const params = new URLSearchParams();
  if (options?.limit) params.append("limit", options.limit.toString());
  if (options?.offset) params.append("offset", options.offset.toString());
  if (options?.status) params.append("status", options.status);

  const query = params.toString();
  const env = await fetchFromDaemon<ListEnvelope<RawChatRow>>(
    `/chats${query ? `?${query}` : ""}`,
  );
  return env.items.map(fromRow);
}

export async function getChat(id: string): Promise<Chat> {
  const row = await fetchFromDaemon<RawChatRow>(`/chats/${id}`);
  return fromRow(row);
}

export async function createChat(options: {
  work: string;
  templateId: string;
  files?: string[];
  /** Optional absolute path to user's repo. Enables Ship phase. */
  repoPath?: string;
  /** Required when the chosen template's first phase is review_only.
   *  Capped at the template's phase.artifact.maxBytes (default 1 MiB) by
   *  the daemon — caller is expected to pre-check that. */
  artifact?: string;
  /** Skip every ask-user gate for this run. Today the daemon only honours
   *  this on the ship phase; safe to pass on review-only runs but with no
   *  effect there. */
  yolo?: boolean;
}): Promise<Chat> {
  const row = await fetchFromDaemon<RawChatRow>("/chats", {
    method: "POST",
    body: JSON.stringify(options),
  });
  return fromRow(row);
}

