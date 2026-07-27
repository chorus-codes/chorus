/**
 * Fetch wrapper around the daemon REST API.
 *
 * Daemon location is resolved at runtime from `~/.chorus/daemon.json`
 * (v0.8+) with `CHORUS_DAEMON_URL` and `http://127.0.0.1:7707` as
 * fallbacks. See lib/daemon-discovery.ts for the resolution order.
 *
 * Auto-start: if the daemon isn't running when an MCP tool is called,
 * the shim spawns `chorus start` (daemon-only, no cockpit) detached
 * and waits up to 10 s for it to come up. Disable via
 * `CHORUS_AUTOSTART=0`. The auto-start path uses stderr for status
 * messages because stdout is reserved for the MCP JSON-RPC protocol.
 */

import { spawn } from "node:child_process";
import { z } from "zod";
import {
  DEFAULT_DAEMON_URL,
  isDaemonHealthy,
  readDaemonInfo,
  resolveDaemonUrl,
} from "../lib/daemon-discovery.js";

const API_PREFIX = "/api/v1";

/**
 * Prepend /api/v1 to a daemon path unless the caller already supplied
 * it. Normalise leading-slash first so `api/v1/foo` (no slash) doesn't
 * double-prefix to `/api/v1/api/v1/foo`. Exact-segment match required
 * — a naive startsWith would treat `/api/v10/...` or `/api/v1foo/...`
 * as already-prefixed.
 */
function v1(path: string): string {
  const normalised = path.startsWith("/") ? path : `/${path}`;
  if (normalised === API_PREFIX || normalised.startsWith(`${API_PREFIX}/`)) {
    return normalised;
  }
  return `${API_PREFIX}${normalised}`;
}

const ApiResponseSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

/**
 * Cache the resolved daemon URL once per MCP shim process so we don't
 * pay the readDaemonInfo + health-probe cost on every tool call. The
 * shim is a short-lived stdio process (one per editor session), so a
 * lifetime-of-process cache is safe — when the daemon shifts ports
 * the editor will spawn a new shim eventually.
 *
 * Reset to null on auto-start so the first post-start call re-resolves.
 */
let cachedDaemonUrl: string | null = null;

async function getDaemonUrl(): Promise<string> {
  if (cachedDaemonUrl) return cachedDaemonUrl;
  cachedDaemonUrl = await resolveDaemonUrl();
  return cachedDaemonUrl;
}

/**
 * Auto-start the daemon when an MCP tool call hits a dead daemon.
 * Best-effort: spawn `chorus start` detached, poll daemon.json for
 * up to 10 s, return true once a healthy daemon exists.
 *
 * Skipped entirely when `CHORUS_AUTOSTART=0` — for users who want to
 * manage the daemon lifecycle themselves and prefer a hard error.
 */
async function tryAutoStart(): Promise<boolean> {
  if (process.env.CHORUS_AUTOSTART === "0") return false;

  // Locate the chorus binary. process.execPath is `node`; argv[1] is
  // dist/mcp/index.js when launched via `chorus mcp`. The bin wrapper
  // sits two levels up at bin/chorus.mjs.
  //
  // The build emits CommonJS, so __dirname is the runtime-available
  // path to this file's directory (dist/mcp at install time, src/mcp
  // under tsx dev). Either way, packageRoot = __dirname/../...
  const path = await import("node:path");
  const fs = await import("node:fs");
  const packageRoot = path.resolve(__dirname, "..", "..");
  const binPath = path.resolve(packageRoot, "bin", "chorus.mjs");
  if (!fs.existsSync(binPath)) {
    process.stderr.write(
      `chorus: cannot auto-start — bin/chorus.mjs not found at ${binPath}\n`,
    );
    return false;
  }

  process.stderr.write("chorus: daemon not running, auto-starting...\n");

  try {
    // --daemon-only: MCP-triggered auto-start should NOT boot the
    // cockpit (Next.js). The user invoked us via tool call from their
    // editor; the cockpit UI isn't requested. Spec requirement, also
    // saves ~150 MB and several seconds of cold-start time.
    const child = spawn(process.execPath, [binPath, "start", "--daemon-only"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true, // #107 — auto-start must stay invisible to the editor
    });
    child.unref();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`chorus: failed to spawn chorus start: ${msg}\n`);
    return false;
  }

  // Poll for daemon.json + healthy status. 10 s deadline covers WSL
  // cold start (slow loopback) without making MCP calls hang forever.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const info = readDaemonInfo();
    if (info && (await isDaemonHealthy(info.daemonPort, 500))) {
      cachedDaemonUrl = `http://127.0.0.1:${info.daemonPort}`;
      process.stderr.write(`chorus: daemon ready on port ${info.daemonPort}\n`);
      return true;
    }
  }

  process.stderr.write(
    "chorus: auto-start timed out after 10s. Run `chorus start` manually and check ~/.chorus/logs/daemon.log.\n",
  );
  return false;
}

/**
 * Fetch JSON from daemon, parse response, handle errors.
 * On the first failure (connection refused), attempt one auto-start
 * and retry once. Subsequent failures throw.
 */
export async function daemonFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  return await daemonFetchWithRetry<T>(path, options, true);
}

async function daemonFetchWithRetry<T>(
  path: string,
  options: RequestInit | undefined,
  allowAutoStart: boolean,
): Promise<T> {
  const base = await getDaemonUrl();
  const url = `${base}${v1(path)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const looksConnRefused =
      message.includes("ECONNREFUSED") ||
      message.includes("fetch failed") ||
      message.includes("ENOTFOUND");
    if (looksConnRefused && allowAutoStart) {
      // Invalidate cached URL — daemon may come up on a different port.
      cachedDaemonUrl = null;
      const started = await tryAutoStart();
      if (started) {
        return daemonFetchWithRetry<T>(path, options, false);
      }
      throw new Error(
        "Chorus daemon not running and auto-start failed. Run 'chorus start' first " +
          "(set CHORUS_AUTOSTART=0 to disable auto-start prompts).",
      );
    }
    throw error;
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error(
      `Daemon returned ${response.status} ${response.statusText} with non-JSON body`,
    );
  }

  const parsed = ApiResponseSchema.parse(json);

  if (!parsed.ok) {
    throw new Error(
      parsed.error?.message || "Daemon returned an error with no message",
    );
  }

  return parsed.data as T;
}

/**
 * Consume SSE stream and emit progress events.
 * Yields one item per event until the stream closes or timeout expires.
 *
 * No auto-start retry here — long-running streams shouldn't restart
 * the daemon mid-flight. If the user closes the daemon during a
 * stream, we let the abort propagate.
 */
export async function* streamChat(
  chatId: string,
  timeoutSec: number = 600,
): AsyncGenerator<Record<string, unknown>> {
  const base = await getDaemonUrl();
  const url = `${base}${v1(`/chats/${chatId}/stream`)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutSec * 1000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Stream returned ${response.status}: ${response.statusText}`,
      );
    }

    if (!response.body) {
      throw new Error("Stream response has no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data) {
            try {
              yield JSON.parse(data);
            } catch {
              // Ignore malformed lines
            }
          }
        }
      }
    }

    if (buffer) {
      if (buffer.startsWith("data: ")) {
        const data = buffer.slice(6);
        if (data) {
          try {
            yield JSON.parse(data);
          } catch {
            // Ignore malformed lines
          }
        }
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

// Exported for tests.
export const __test = {
  resetCache: (): void => {
    cachedDaemonUrl = null;
  },
  getCache: (): string | null => cachedDaemonUrl,
  setCache: (url: string | null): void => {
    cachedDaemonUrl = url;
  },
  defaultUrl: DEFAULT_DAEMON_URL,
};
