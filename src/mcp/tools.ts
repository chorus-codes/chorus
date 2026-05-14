/**
 * Chorus MCP tools — 7 tools wrapping daemon REST API.
 * Each tool has a Zod input schema and calls daemonFetch.
 */

import os from "node:os";
import { z } from "zod";
import yaml from "yaml";
import {
  DEFAULT_COCKPIT_URL,
  readDaemonInfo,
} from "../lib/daemon-discovery.js";
import { daemonFetch, streamChat } from "./client";

/**
 * `process.cwd()` throws ENOENT when the working directory has been
 * deleted between process start and the call (e.g. tmpdir cleanup,
 * `rm -rf` on the project dir while a long-lived MCP server runs).
 * Fall back to homedir so the daemon can still accept the request —
 * downstream repo detection will surface a clearer error than an
 * unhandled ENOENT exception.
 */
function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return os.homedir();
  }
}

/**
 * Resolve the cockpit URL the run links should point at. Sync read from
 * daemon.json (no health probe — the link is informational; if the
 * cockpit is dead the user finds out when they click it). CHORUS_WEB_URL
 * env override remains the explicit escape hatch.
 */
function cockpitBase(): string {
  if (process.env.CHORUS_WEB_URL) return process.env.CHORUS_WEB_URL;
  const info = readDaemonInfo();
  if (info) return `http://127.0.0.1:${info.cockpitPort}`;
  return DEFAULT_COCKPIT_URL;
}

// Daemon stores chats with snake_case `id` + `current_phase_idx`; MCP contract
// is camelCase `chatId` + `phase`. Single source of truth for the mapping so
// every tool returns the same shape.
interface DaemonChatRow {
  id: string;
  status: string;
  current_phase_idx?: number;
  updated_at?: number;
  /** Optional slug — present on chats created after the slug migration. */
  slug?: string | null;
}
function chatRowToRef(row: DaemonChatRow) {
  const webBase = cockpitBase();
  // Prefer slug for the user-visible URL (it's what the cockpit uses
  // too). Falls back to ULID for legacy rows the daemon couldn't
  // backfill — both forms resolve identically server-side.
  const segment = row.slug || row.id;
  return {
    chatId: row.id,
    status: row.status,
    url: `${webBase}/runs/${segment}`,
  };
}
function chatRowToStatus(row: DaemonChatRow) {
  return {
    chatId: row.id,
    status: row.status,
    phase: row.current_phase_idx,
    blocked: row.status === "blocked",
  };
}

interface RawTemplateRow {
  id: string;
  source?: string;
  yaml?: string;
}

interface ParsedTemplateYaml {
  name?: string;
  description?: string;
  phases?: Array<{
    doer?: { lineage?: string };
    reviewer?: { candidates?: Array<{ lineage?: string }> };
  }>;
}

function parseTemplateRow(row: RawTemplateRow): {
  id: string;
  name: string;
  description: string;
  lineages: string[];
} {
  let parsed: ParsedTemplateYaml = {};
  if (row.yaml) {
    try {
      parsed = (yaml.parse(row.yaml) as ParsedTemplateYaml) ?? {};
    } catch {
      // ignore — fall through to id-only fallback
    }
  }
  const lineages = new Set<string>();
  for (const p of parsed.phases ?? []) {
    if (p.doer?.lineage) lineages.add(p.doer.lineage);
    for (const c of p.reviewer?.candidates ?? []) {
      if (c.lineage) lineages.add(c.lineage);
    }
  }
  return {
    id: row.id,
    name: parsed.name ?? row.id,
    description: parsed.description ?? "",
    lineages: Array.from(lineages),
  };
}

// ─── Input schemas ───────────────────────────────────────────────────────

/**
 * Pre-launch (v0.7) naming sweep landed `templateId` as the canonical
 * field — matches the REST POST /chats body shape and the
 * `<resource>Id` pattern used elsewhere (`chatId`, `personaId`).
 * The legacy `template` alias is accepted so existing scripts keep
 * working through v0.7; will be dropped in v0.8.
 */
export const CreateChatSchema = z
  .object({
    work: z.string().min(1, "work prompt is required"),
    templateId: z.string().optional(),
    template: z.string().optional(),
    files: z.array(z.string()).optional(),
    /**
     * Artifact text for review-only templates (e.g. `templateId: "review-only"`).
     * Required when the chosen template's first phase has `kind: review_only`.
     * Ignored for full-pipeline templates. Capped by the template's
     * artifact.maxBytes (default 1 MiB).
     */
    artifact: z.string().optional(),
    repoPath: z.string().optional(),
  })
  .transform((input) => ({
    ...input,
    // `??` only falls through on null/undefined; an empty string would
    // pass through and the daemon would reject it. Treat empty as
    // missing so the legacy alias / default fires.
    templateId:
      (input.templateId && input.templateId.length > 0
        ? input.templateId
        : undefined) ??
      (input.template && input.template.length > 0
        ? input.template
        : undefined) ??
      "code-review",
  }));

export const WaitForChatSchema = z.object({
  chatId: z.string().min(1, "chatId is required"),
  timeoutSec: z.number().int().positive().optional().default(600),
});

export const GetChatStatusSchema = z.object({
  chatId: z.string().min(1, "chatId is required"),
});

export const ListBlockedSchema = z.object({});

export const ResumeChatSchema = z.object({
  chatId: z.string().min(1, "chatId is required"),
  answer: z.string().min(1, "answer is required"),
});

export const CancelChatSchema = z.object({
  chatId: z.string().min(1, "chatId is required"),
});

export const ListTemplatesSchema = z.object({});

export const ListPersonasSchema = z.object({});

export const InvokePersonaSchema = z
  .object({
    personaId: z.string().min(1, "personaId is required"),
    brief: z.string().min(1, "brief is required"),
    files: z.array(z.string()).optional(),
    templateId: z.string().optional(),
    template: z.string().optional(),
    repoPath: z.string().optional(),
  })
  .transform((input) => ({
    ...input,
    // `??` only falls through on null/undefined; an empty string would
    // pass through and the daemon would reject it. Treat empty as
    // missing so the legacy alias / default fires.
    templateId:
      (input.templateId && input.templateId.length > 0
        ? input.templateId
        : undefined) ??
      (input.template && input.template.length > 0
        ? input.template
        : undefined) ??
      "code-review",
  }));

// ─── Output schemas ─────────────────────────────────────────────────────

const ChatRefSchema = z.object({
  chatId: z.string(),
  status: z.string(),
  url: z.string(),
});

const ChatStatusSchema = z.object({
  chatId: z.string(),
  status: z.string(),
  phase: z.number().optional(),
  progress: z.number().optional(),
  blocked: z.boolean().optional(),
});

const ChatResultSchema = z.object({
  status: z.string(),
  verdict: z.string().optional(),
  summary: z.string().optional(),
  blocked: z.boolean().optional(),
});

const BlockedChatSchema = z.object({
  chatId: z.string(),
  work: z.string(),
  blockedReason: z.string(),
  since: z.number(),
});

const TemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  lineages: z.array(z.string()).optional(),
});

const PersonaSchema = z.object({
  id: z.string(),
  label: z.string(),
  oneLiner: z.string(),
  recommendedLineage: z.string().nullable().optional(),
  builtin: z.boolean(),
});

interface DaemonPersonaRow {
  id: string;
  label: string;
  one_liner: string;
  system_prompt: string;
  recommended_lineage: string | null;
  builtin: boolean | number;
}

function personaRowToRef(row: DaemonPersonaRow) {
  return {
    id: row.id,
    label: row.label,
    oneLiner: row.one_liner,
    recommendedLineage: row.recommended_lineage,
    builtin: Boolean(row.builtin),
  };
}

// ─── Tools ──────────────────────────────────────────────────────────────

/**
 * Create a new chat.
 * Returns immediately with chatId and status.
 */
export async function createChat(input: unknown) {
  const parsed = CreateChatSchema.parse(input);

  const repoPath = parsed.repoPath ?? safeCwd();

  const result = await daemonFetch<DaemonChatRow>("/chats", {
    method: "POST",
    body: JSON.stringify({
      work: parsed.work,
      templateId: parsed.templateId,
      files: parsed.files,
      repoPath,
      ...(parsed.artifact !== undefined ? { artifact: parsed.artifact } : {}),
    }),
  });

  return ChatRefSchema.parse(chatRowToRef(result));
}

/**
 * Long-poll a chat until terminal state.
 * Emits progress events via SSE stream.
 * Resolves when status flips to terminal.
 */
export async function waitForChat(
  input: unknown,
  onProgress: (event: Record<string, unknown>) => void
) {
  const parsed = WaitForChatSchema.parse(input);

  for await (const event of streamChat(parsed.chatId, parsed.timeoutSec)) {
    onProgress(event);

    // Check if we've reached a terminal state
    if (event && typeof event === "object") {
      const status = (event as Record<string, unknown>).status;
      if (
        status === "approved" ||
        status === "merged" ||
        status === "blocked" ||
        status === "cancelled" ||
        status === "failed"
      ) {
        return ChatResultSchema.parse(event);
      }
    }
  }

  // If stream closed without reaching terminal, fetch final status
  const result = await daemonFetch<unknown>(`/chats/${parsed.chatId}`);
  return ChatResultSchema.parse(result);
}

/**
 * Get current chat status without blocking.
 */
export async function getChatStatus(input: unknown) {
  const parsed = GetChatStatusSchema.parse(input);

  const result = await daemonFetch<DaemonChatRow>(`/chats/${parsed.chatId}`);
  return ChatStatusSchema.parse(chatRowToStatus(result));
}

/**
 * List all blocked chats.
 */
export async function listBlocked(input: unknown) {
  ListBlockedSchema.parse(input);
  // input is empty object, but we validate it anyway for schema consistency

  const result = await daemonFetch<unknown>("/blocked");
  // Daemon now returns the canonical list envelope `{items, total, hasMore}`.
  // Array fallback covers legacy callers; `.chats` fallback covers an even
  // older shape that lived briefly during the v0.6 daemon refactor.
  const obj = (result as Record<string, unknown>) || {};
  const rows = Array.isArray(result)
    ? (result as Array<Record<string, unknown>>)
    : Array.isArray(obj.items)
      ? (obj.items as Array<Record<string, unknown>>)
      : Array.isArray(obj.chats)
        ? (obj.chats as Array<Record<string, unknown>>)
        : [];

  const chats = z.array(BlockedChatSchema).parse(
    rows.map((row) => ({
      chatId: row.id,
      work: row.work,
      blockedReason: row.ship_error ?? "Awaiting user input",
      since: row.updated_at,
    }))
  );

  return { chats };
}

/**
 * Resume a blocked chat with a user answer.
 */
export async function resumeChat(input: unknown) {
  const parsed = ResumeChatSchema.parse(input);

  const result = await daemonFetch<DaemonChatRow>(
    `/chats/${parsed.chatId}/resume`,
    {
      method: "POST",
      body: JSON.stringify({ answer: parsed.answer }),
    }
  );

  return { ok: true, status: ChatStatusSchema.parse(chatRowToStatus(result)) };
}

/**
 * Cancel a chat.
 */
export async function cancelChat(input: unknown) {
  const parsed = CancelChatSchema.parse(input);

  await daemonFetch<unknown>(`/chats/${parsed.chatId}/cancel`, {
    method: "POST",
  });

  return { ok: true };
}

/**
 * List all available templates.
 */
export async function listTemplates(input: unknown) {
  ListTemplatesSchema.parse(input);

  const result = await daemonFetch<unknown>("/templates");
  const obj = (result as Record<string, unknown>) || {};
  const rows = Array.isArray(result)
    ? (result as RawTemplateRow[])
    : Array.isArray(obj.items)
      ? (obj.items as RawTemplateRow[])
      : Array.isArray(obj.templates)
        ? (obj.templates as RawTemplateRow[])
        : [];

  const templates = z.array(TemplateSchema).parse(rows.map(parseTemplateRow));
  return { templates };
}

/**
 * List all personas (built-in + user-defined).
 * Returns enough metadata for a picker — full system prompt is fetched
 * via /personas/:id when needed.
 */
export async function listPersonas(input: unknown) {
  ListPersonasSchema.parse(input);

  const result = await daemonFetch<unknown>("/personas");
  const obj = (result as Record<string, unknown>) || {};
  const rows = Array.isArray(result)
    ? (result as DaemonPersonaRow[])
    : Array.isArray(obj.items)
      ? (obj.items as DaemonPersonaRow[])
      : Array.isArray(obj.personas)
        ? (obj.personas as DaemonPersonaRow[])
        : [];

  const personas = z.array(PersonaSchema).parse(rows.map(personaRowToRef));

  return { personas };
}

/**
 * Fire a chat that wears a chosen persona.
 *
 * The persona's `system_prompt` is prepended to the user's brief so the
 * downstream CLI sees both the worldview and the request. Voice routing is
 * handled by the existing template machinery (template's `doer.lineage`
 * decides which CLI runs); v0.7 keeps voice selection implicit via template
 * choice and v0.8 will add explicit per-phase voice override.
 */
export async function invokePersona(input: unknown) {
  const parsed = InvokePersonaSchema.parse(input);

  // Pull full persona so we have the system_prompt.
  const persona = await daemonFetch<DaemonPersonaRow>(
    `/personas/${encodeURIComponent(parsed.personaId)}`,
  );

  const composedBrief = [
    `# Persona: ${persona.label}`,
    persona.system_prompt.trim(),
    `---`,
    `# User request`,
    parsed.brief.trim(),
  ].join("\n\n");

  const result = await daemonFetch<DaemonChatRow>("/chats", {
    method: "POST",
    body: JSON.stringify({
      work: composedBrief,
      templateId: parsed.templateId,
      files: parsed.files,
      repoPath: parsed.repoPath,
    }),
  });

  return ChatRefSchema.parse(chatRowToRef(result));
}
