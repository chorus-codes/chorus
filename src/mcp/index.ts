#!/usr/bin/env node

/**
 * Chorus MCP stdio server.
 * Exposes 9 tools to orchestrators (Claude Code, Codex, Cursor).
 * Each tool calls the daemon REST API on http://127.0.0.1:7707.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import path from "node:path";
import {
  createChat,
  waitForChat,
  getChatStatus,
  listBlocked,
  resumeChat,
  cancelChat,
  listTemplates,
  listPersonas,
  invokePersona,
  CreateChatSchema,
  WaitForChatSchema,
  GetChatStatusSchema,
  ListBlockedSchema,
  ResumeChatSchema,
  CancelChatSchema,
  ListTemplatesSchema,
  ListPersonasSchema,
  InvokePersonaSchema,
} from "./tools.js";

// Read version from the shipped package.json — single source of truth,
// per feedback_version_from_package_json. __dirname is dist/mcp (built)
// or src/mcp (tsx dev); ../../package.json resolves to the package root
// in both layouts.
const mcpVersion: string = (() => {
  try {
    const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const mcpServer = new McpServer({
  name: "chorus",
  version: mcpVersion,
});

/**
 * Register the 7 MCP tools.
 */

mcpServer.registerTool(
  "create_chat",
  {
    description:
      "Create a new chat. Returns immediately with chatId, status, and URL. Reviewers run async. " +
      "For review-only templates (e.g. template='review-only'), supply `artifact` with the text/diff to review — `work` becomes the framing brief.",
    inputSchema: CreateChatSchema,
  },
  async (input) => {
    const result = await createChat(input);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

mcpServer.registerTool(
  "wait_for_chat",
  {
    description:
      "Long-poll a chat until terminal state. Blocks until status is approved, merged, blocked, cancelled, or failed.",
    inputSchema: WaitForChatSchema,
  },
  async (input, extra) => {
    const progressEvents: Record<string, unknown>[] = [];
    // The MCP SDK enforces a 60s default request timeout (DEFAULT_REQUEST_TIMEOUT_MSEC).
    // Long chorus chats routinely exceed that — we previously surfaced as
    // "Connection closed -32000" on the client. The MCP spec's progress
    // notification mechanism resets the timeout per `resetTimeoutOnProgress`
    // when the client opted into it AND we send `notifications/progress`
    // referencing the request's progressToken (passed in via _meta).
    //
    // We send a progress notification on every chat event AND on a fixed
    // ~25s heartbeat so a stalled chat (mid-LLM-stream, low SSE event
    // density) still keeps the client awake. The progress field is a
    // monotonically-increasing counter — the spec mandates monotonicity
    // even though most clients don't enforce it.
    const progressToken = extra._meta?.progressToken;
    let progressCounter = 0;
    const sendProgress = async (message?: string): Promise<void> => {
      if (progressToken === undefined || progressToken === null) return;
      progressCounter += 1;
      try {
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: progressCounter,
            ...(message ? { message } : {}),
          },
        });
      } catch {
        // Notification delivery is best-effort. A failed send doesn't
        // imply the request is dead — let the await on the chat finish.
      }
    };

    // Heartbeat keeps the timer alive between real chat events. 25s sits
    // comfortably under the SDK default 60s; even if the SDK timeout is
    // tuned tighter on a specific client, the heartbeat will land before
    // most reasonable thresholds.
    const heartbeat = setInterval(() => {
      void sendProgress(`waiting on ${input.chatId}…`);
    }, 25_000);

    try {
      const result = await waitForChat(input, (event) => {
        progressEvents.push(event);
        // Fire progress immediately for every state-changing event the
        // chat emits — most clients display the message field, which
        // gives the user "still alive" feedback during a long review.
        const status =
          typeof event === "object" && event !== null
            ? ((event as Record<string, unknown>).status as string | undefined)
            : undefined;
        const phase =
          typeof event === "object" && event !== null
            ? ((event as Record<string, unknown>).phase as string | undefined)
            : undefined;
        const msg =
          status && phase
            ? `${status} · ${phase}`
            : status ?? "chat event";
        void sendProgress(msg);
      });

      // Do NOT embed `progressEvents` in the response. Every event was
      // already streamed live via `notifications/progress` (see sendProgress
      // above); duplicating them here only inflates the tool result.
      // An 8-reviewer chat routinely produced 50KB+ payloads that exceeded
      // the MCP client's per-result token budget — the client then spills
      // the whole blob to a file and forces a chunked re-read. `eventCount`
      // gives callers the cardinality for debug without the bloat.
      const response = {
        ...(result as Record<string, unknown>),
        eventCount: progressEvents.length,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response) }],
      };
    } finally {
      clearInterval(heartbeat);
    }
  }
);

mcpServer.registerTool(
  "get_chat_status",
  {
    description:
      "Get current chat status without blocking. Returns status, phase, progress, and blocked flag.",
    inputSchema: GetChatStatusSchema,
  },
  async (input) => {
    const result = await getChatStatus(input);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

mcpServer.registerTool(
  "list_blocked",
  {
    description:
      "List all chats currently waiting on user input. Lets you surface them in one prompt.",
    inputSchema: ListBlockedSchema,
  },
  async (input) => {
    const result = await listBlocked(input);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

mcpServer.registerTool(
  "resume_chat",
  {
    description:
      "Unblock a chat after the user has decided. Same effect as clicking the dashboard button.",
    inputSchema: ResumeChatSchema,
  },
  async (input) => {
    const result = await resumeChat(input);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

mcpServer.registerTool(
  "cancel_chat",
  {
    description:
      "Hard cancel — kills the tmux session, stops reviewers, marks chat cancelled.",
    inputSchema: CancelChatSchema,
  },
  async (input) => {
    const result = await cancelChat(input);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

mcpServer.registerTool(
  "list_templates",
  {
    description:
      "List all available templates (built-in and user-created). Use to discover templates for create_chat.",
    inputSchema: ListTemplatesSchema,
  },
  async (input) => {
    const result = await listTemplates(input);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

mcpServer.registerTool(
  "list_personas",
  {
    description:
      "List all reviewer personas (built-in and user-defined). Each persona is a worldview/role: e.g. Sentinel (security), Cartographer (cross-platform), Translator (UX). Use to discover the personaId for invoke_persona.",
    inputSchema: ListPersonasSchema,
  },
  async (input) => {
    const result = await listPersonas(input);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

mcpServer.registerTool(
  "invoke_persona",
  {
    description:
      "Fire a chat that wears a chosen persona. The persona's system prompt is prepended to your brief so the reviewer audits with that worldview (security / cross-platform / UX / cost / etc.). Use list_personas to discover ids. Returns chatId, status, and URL — work runs async.",
    inputSchema: InvokePersonaSchema,
  },
  async (input) => {
    const result = await invokePersona(input);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

/**
 * Main entry point.
 * Creates stdio transport and connects server.
 */
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

main().catch((error: unknown) => {
  console.error("MCP server error:", error);
  process.exit(1);
});
