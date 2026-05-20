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
 * Empty lines emit a bare `\n` text_delta — paragraph breaks in the
 * assistant's response are double-newlines in stdout, which spawnHeadless
 * splits as `["para1", "", "para2"]`. Returning `[]` for the empty
 * middle would collapse paragraph structure into a single block; convergent
 * self-review (5/8 reviewers on PR #62) flagged this as data corruption
 * for every multi-paragraph response.
 */
export function parseAntigravity(line: string): AgentEvent[] {
  // Restore the \n that spawnHeadless stripped — for empty input that
  // produces a paragraph-break \n; for non-empty input it terminates
  // the line. Either way the accumulator sees the same byte sequence
  // the CLI originally emitted.
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
  // Signal-kill path: Node reports code=null when the child was killed
  // by signal. The fallback below would otherwise emit "exited with
  // code null" which is meaningless to users. Treat as cli_error with
  // an explicit signal message. Caught by self-review (PR #62, ocg-7).
  if (code === null) {
    return [
      {
        type: 'error',
        kind: 'cli_error',
        message: 'Antigravity CLI was killed by signal (likely timeout or chat cancel).',
      },
    ];
  }
  // Broader ANSI stripper — covers all CSI sequences (SGR, cursor
  // movement, line clear), not just `\x1b[...m`. Self-review found the
  // narrow `m`-only pattern would leave erasure / cursor codes embedded
  // in stderr and break downstream pattern matches.
  const clean = stderr.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

  // Quota / rate limit signals (Google AI Pro period quota). Multiple
  // phrasings: Google's docs use both `quota-exhausted` and `quota
  // exceeded`; `\b429\b` is anchored to avoid matching `4290` /
  // `port 14290` / etc.
  if (
    /quota[\s-]?(?:exhausted|exceeded)|rate[\s-]?limit|resource[\s-]?exhausted|\b429\b/i.test(
      clean,
    )
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
  // a useful "needs login" prompt. Tightened from the original
  // `please.*login` (would match `please don't login to third-party
  // services` per self-review).
  if (
    /sign[\s-]?in|\boauth\b|authenticate|antigravity-oauth-token|please\s+(?:run\s+)?(?:agy\s+)?login\b/i.test(
      clean,
    )
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

  // 401 / 403 — likely an expired/invalid token. Includes both the
  // machine-readable `invalid_token` / `invalid-token` and the
  // human-readable `invalid token` phrasings.
  if (
    /401\s+Unauthorized|403\s+Forbidden|invalid(?:[_-]|\s+)token/i.test(clean)
  ) {
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
