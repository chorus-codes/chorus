/**
 * Antigravity CLI (`agy -p <prompt> --dangerously-skip-permissions`).
 *
 * Empirical probe 2026-05-20: agy emits plain UTF-8 text to stdout — no
 * streaming-json output mode is documented or exposed. The whole stdout
 * IS the response. So parseAntigravity treats each line as a text_delta
 * and emits a single message_done at exit time via parseAntigravityExit.
 *
 * Model is locked to Gemini 3.5 Flash (High) by the CLI — `--model` is
 * not a flag, the binary chooses. We surface this as a constant in the
 * shim's model field and the voice catalog.
 *
 * Cost: agy is a Google AI Pro subscription product. Per-call cost is
 * not exposed by the CLI. estimateCostUsd returns 0 — matches the
 * claude/gemini/grok subscription pattern.
 */
import type { AgentEvent } from '../types.js';

/**
 * Per-line parser. agy streams text in chunks (small writes from the Go
 * runtime); each chunk becomes a text_delta. The runner's accumulator
 * concatenates them into the final answer. No JSON, no thought-trace,
 * no tool-use events to filter — the CLI hides those internally.
 *
 * Returns an empty array for blank lines so the accumulator doesn't
 * stutter on empty newlines.
 */
export function parseAntigravity(line: string): AgentEvent[] {
  if (line.length === 0) return [];
  // Append a newline back — spawnHeadless splits on \n and strips it,
  // but the assistant's answer may legitimately need paragraph breaks.
  // Without this, the joined output collapses to one mega-paragraph.
  return [{ type: 'text_delta', text: line + '\n' }];
}

/**
 * Exit-time parser. Maps non-zero exits to typed error events so the
 * error-detector / voice-failure tracker route them correctly. The
 * three known empirical failure modes (probed against agy 1.0.0):
 *
 *   1. Missing auth token (`~/.gemini/antigravity-cli/antigravity-oauth-token`
 *      absent) → agy attempts to spawn a browser OAuth flow inline.
 *      Headless dispatch hangs until the daemon timeout fires; on
 *      timeout, stderr is empty. Precheck blocks this at chorus's
 *      cli-precheck layer (see cli-precheck.ts) — by the time exit
 *      fires here the lineage is auth_missing.
 *
 *   2. Quota exhausted (subscription out of Gemini 3.5 Flash quota
 *      for the period). agy prints a quota error to stderr. Pattern
 *      verified against the agy changelog + Google AI Pro docs.
 *
 *   3. Generic non-zero exit with no recognised pattern → cli_error
 *      with the raw tail of stderr for diagnostic context.
 *
 * ANSI sequences are stripped before matching per the Grok integration
 * rule (PR #46) — agy uses colored ERROR lines on stderr.
 */
export function parseAntigravityExit(
  _stdout: string,
  stderr: string,
  code: number | null,
): AgentEvent[] {
  if (code === 0) return [];
  const clean = stderr.replace(/\x1b\[[0-9;]*m/g, '');

  // Quota / rate limit signals (Google AI Pro period quota).
  if (
    /quota[\s-]?exhausted|rate[\s-]?limit|resource[\s-]?exhausted|429/i.test(clean)
  ) {
    return [
      {
        type: 'error',
        kind: 'quota_exhausted',
        message:
          'Antigravity (Gemini 3.5 Flash) quota exhausted on your Google AI Pro subscription. Upgrade your plan or wait for the period reset.',
      },
    ];
  }

  // Auth-flow signals — if precheck somehow missed (token file gone
  // between precheck and dispatch), the agy CLI prints an OAuth-flow
  // line before hanging. Catch it on exit so the run-page card shows
  // a useful "needs login" prompt.
  if (
    /sign in|oauth|authenticate|antigravity-oauth-token|please.*login/i.test(clean)
  ) {
    return [
      {
        type: 'error',
        kind: 'auth_missing',
        message:
          'Antigravity CLI is not signed in. Run `agy` interactively to complete the OAuth flow, or check ~/.gemini/antigravity-cli/antigravity-oauth-token.',
      },
    ];
  }

  // 401 / 403 — likely an expired/invalid token.
  if (/401\s+Unauthorized|403\s+Forbidden|invalid[_-]token/i.test(clean)) {
    return [
      {
        type: 'error',
        kind: 'auth_invalid',
        message:
          'Antigravity CLI auth was rejected by Google — token expired or revoked. Re-run `agy` interactively to refresh.',
      },
    ];
  }

  // Generic non-zero fallthrough. Tail of stderr keeps the message
  // bounded — full stderr lives in the daemon log.
  const tail = clean.split('\n').filter((l) => l.trim()).slice(-3).join(' ');
  return [
    {
      type: 'error',
      kind: 'cli_error',
      message: tail || `Antigravity CLI exited with code ${code}.`,
    },
  ];
}
