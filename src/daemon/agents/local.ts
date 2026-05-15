/**
 * Local LLM HTTP shim — dispatches chat completions to any OpenAI-compatible
 * endpoint (ollama, llama-swap, LM Studio, vLLM, etc.) with `stream=true` and
 * parses the resulting SSE into AgentEvents.
 *
 * This is the v1.0 roadmap item: "Local-LLM adapter (Ollama / LM Studio / vLLM
 * via OpenAI-compatible base URL)". No external subscription or CLI binary
 * required — only a running local inference server.
 *
 * Configured via the 'local' secret in the secrets table.
 * Secret format: JSON with `base_url` (required) and optional `api_key`.
 * Example: {"base_url": "http://127.0.0.1:11434/v1", "api_key": ""}
 *
 * When no secret is saved, falls back to DEFAULT_BASE (Ollama default port).
 *
 * Lineage tag is 'local'. Dispatch: see pickShimForVoice in agents/index.ts.
 * When the model id starts with 'local:', this shim is selected regardless of
 * the slot's declared lineage. Precheck (CLI credential) is skipped — auth is
 * the base_url + api_key in the secrets table.
 */

import type {
  AgentShim,
  AgentSpawnOptions,
  AgentNudgeOptions,
  HeadlessSpawnOptions,
  AgentEvent,
} from './types.js';
import { secrets } from '../../lib/db/index.js';
import { recordHealth } from '../../lib/cli-health.js';
import { parseOpenRouterSSE } from './parsers/index.js';

const DEFAULT_BASE = 'http://127.0.0.1:11434/v1';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export const localShim: AgentShim = {
  lineage: 'local',
  name: 'local',

  buildLaunchCommand(_opts: AgentSpawnOptions): string {
    throw new Error(
      'localShim has no tmux launch path — runner must use runHeadless',
    );
  },

  formatPrompt(_opts: AgentNudgeOptions): string {
    throw new Error(
      'localShim does not use file-based prompt nudging — runHeadless ' +
        'passes promptText into the request body directly',
    );
  },

  runHeadless(opts: HeadlessSpawnOptions): AsyncIterable<AgentEvent> {
    return runLocalStream(opts);
  },

  estimateCostUsd(_input: number, _output: number, _model?: string): number {
    return 0; // Local inference has no API cost.
  },
};

async function* runLocalStream(
  opts: HeadlessSpawnOptions,
): AsyncIterable<AgentEvent> {
  const stored = await secrets.get('local');
  // Guard JSON.parse — a malformed secret (truncated write, manual edit)
  // would otherwise throw synchronously inside the async generator and
  // surface as an opaque "threw" with no structured event in the run log.
  // Yield a typed error so the cockpit can show "fix your Local LLM
  // settings" instead.
  let config: { base_url?: string; api_key?: string } = {};
  if (stored) {
    try {
      config = JSON.parse(stored.value) as { base_url?: string; api_key?: string };
    } catch {
      yield {
        type: 'error',
        kind: 'config_parse',
        message:
          'Local LLM secret is not valid JSON. Re-save the endpoint on Settings → Local LLM.',
      };
      return;
    }
  }
  const base = config.base_url ?? DEFAULT_BASE;
  const apiKey = config.api_key ?? '';

  const rawModel = opts.model;
  if (!rawModel) {
    yield { type: 'error', kind: 'validation', message: 'Local dispatch requires an explicit model — none supplied.' };
    return;
  }
  const model = rawModel.startsWith('local:') ? rawModel.slice('local:'.length) : rawModel;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutCtl = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutCtl.abort('timeout'), timeoutMs);
  const signals: AbortSignal[] = [timeoutCtl.signal];
  if (opts.abortSignal) signals.push(opts.abortSignal);
  const composed = AbortSignal.any(signals);

  let accumulated = '';
  let finishedNaturally = false;

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: opts.promptText }],
        stream: true,
      }),
      signal: composed,
    });

    if (!res.ok) {
      let errMessage = `Local endpoint returned ${res.status}`;
      let rawBody = '';
      try {
        rawBody = await res.text();
        const parsed = JSON.parse(rawBody) as { error?: { message?: string } };
        if (parsed.error?.message) errMessage = parsed.error.message;
        else if (rawBody.length > 0 && rawBody.length < 500) errMessage = rawBody;
      } catch { /* keep status-code message */ }
      console.warn(`[local] dispatch failed model=${model} status=${res.status} message=${errMessage}`);
      yield { type: 'error', kind: `local_${res.status}`, message: errMessage };
      return;
    }

    if (!res.body) {
      yield { type: 'error', kind: 'local_no_body', message: 'Local response had no body.' };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = findEventBoundary(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^[\r\n]+/, '');

        const dataLines = rawEvent
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice('data:'.length).replace(/^ /, ''));
        const payload = dataLines.join('\n');
        if (payload.length === 0) continue;

        for (const ev of parseOpenRouterSSE(payload)) {
          if (ev.type === 'text_delta') {
            accumulated += ev.text;
            yield ev;
          } else if (ev.type === 'message_done') {
            // Usage-bearing chunk — swallow, emit consolidated message_done at end.
          } else if (ev.type === 'error') {
            yield ev;
            return;
          } else {
            yield ev;
          }
        }
      }
    }

    finishedNaturally = true;
  } catch (err) {
    const aborted = composed.aborted;
    const reason = composed.aborted ? composed.reason : undefined;
    if (aborted && reason === 'timeout') {
      yield { type: 'error', kind: 'timeout', message: `Local dispatch exceeded ${Math.round(timeoutMs / 1000)}s.` };
    } else if (aborted) {
      yield { type: 'error', kind: 'aborted', message: 'Local dispatch was cancelled.' };
    } else {
      const message = err instanceof Error ? err.message : String(err);
      yield { type: 'error', kind: 'local_fetch_failed', message: `Network error: ${message}` };
    }
    return;
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (finishedNaturally) {
    recordHealth({ lineage: 'local', status: 'healthy' }).catch(() => {});
    yield { type: 'message_done', finalText: accumulated };
  }
}

function findEventBoundary(buf: string): number {
  const lf = buf.indexOf('\n\n');
  const crlf = buf.indexOf('\r\n\r\n');
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}
