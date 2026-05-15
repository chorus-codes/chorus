/**
 * Grok Build (`grok -p <prompt> --output-format streaming-json --yolo`).
 *
 * Format documented in ~/.grok/docs/user-guide/13-headless-mode.md
 * (Grok 0.1.210, 2026-05-15). Newline-delimited JSON; each line is a
 * self-contained event with a `type` discriminator:
 *
 *   {"type":"text",    "data":"chunk of response"}
 *   {"type":"thought", "data":"internal reasoning"}   // skip — not output
 *   {"type":"end",     "stopReason":"EndTurn",
 *                      "sessionId":"...","requestId":"..."}
 *   {"type":"error",   "message":"..."}
 *
 * The end event has NO usage block — Grok Build (xAI's CLI) doesn't
 * expose token counts or cost in headless mode. We emit message_done
 * with no usage; the runner falls back to estimateCostUsd which
 * returns 0 (Grok is subscription-only — list price is unknown to
 * chorus).
 *
 * Verified empirically: only the `error` shape can be observed without
 * a SuperGrok Heavy subscription. Happy-path shape is from the official
 * headless-mode docs shipped with the binary.
 */
import type { AgentEvent } from '../types.js';
import { tryJson } from './shared.js';

export function parseGrok(line: string): AgentEvent[] {
  const obj = tryJson(line) as Record<string, unknown> | undefined;
  if (!obj || typeof obj !== 'object') return [];

  const t = obj.type;

  if (t === 'text') {
    const data = obj.data;
    if (typeof data === 'string' && data.length > 0) {
      return [{ type: 'text_delta', text: data }];
    }
    return [];
  }

  // Internal reasoning — not part of the assistant's externalised
  // response. Match parseClaude's handling of thinking tokens: drop
  // them so they don't pollute answer.md content.
  if (t === 'thought') return [];

  if (t === 'end') {
    // No usage block per Grok's headless-mode spec. Emit message_done
    // with empty finalText so the runner's accumulator (which holds
    // the assembled text_delta stream) wins.
    return [{ type: 'message_done', finalText: '' }];
  }

  if (t === 'error') {
    const message =
      typeof obj.message === 'string' ? obj.message : 'Grok stream error';
    // Classify the well-known subscription-tier error so the
    // error-detector can route this to quota_exhausted (not a
    // transient crash). Probed live 2026-05-15 against grok 0.1.210
    // with a free-tier OIDC token.
    const kind = message.includes('SuperGrok Heavy subscription required')
      ? 'quota_exhausted'
      : message.includes('403 Forbidden')
        ? 'auth_invalid'
        : 'grok_stream_error';
    return [{ type: 'error', kind, message }];
  }

  return [];
}

/**
 * Stderr parser for the headless-mode error path. The streaming-json
 * stdout path emits a typed `error` event for API failures, but the
 * CLI ALSO writes ANSI-coloured ERROR lines to stderr alongside the
 * JSON. parseGrokExit reads the captured stderr on non-zero exit and
 * surfaces a typed quota event when the subscription pattern matches.
 *
 * Mirrors parseGeminiExit's role: catch upstream errors that didn't
 * round-trip cleanly through the JSON stream.
 */
export function parseGrokExit(
  _stdout: string,
  stderr: string,
  code: number | null,
): AgentEvent[] {
  if (code === 0) return [];
  // Strip ANSI escape sequences before matching — grok ERROR lines
  // are decorated with `\x1b[31m...` etc. that wreck pattern matching.
  const clean = stderr.replace(/\x1b\[[0-9;]*m/g, '');
  if (clean.includes('SuperGrok Heavy subscription required')) {
    return [
      {
        type: 'error',
        kind: 'quota_exhausted',
        message:
          'Grok Build requires a SuperGrok Heavy subscription. Upgrade at console.x.ai or disable the grok voice in Settings.',
      },
    ];
  }
  if (clean.match(/403 Forbidden/)) {
    return [
      {
        type: 'error',
        kind: 'auth_invalid',
        message: 'Grok returned 403 Forbidden — check your auth or subscription tier.',
      },
    ];
  }
  if (clean.match(/Signing in with Grok|Open this URL to sign in/)) {
    return [
      {
        type: 'error',
        kind: 'auth_missing',
        message:
          'Grok needs authentication — run `grok login` interactively, or set GROK_CODE_XAI_API_KEY.',
      },
    ];
  }
  return [];
}
