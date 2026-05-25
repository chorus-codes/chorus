/**
 * isRetryableErrorKind classifier tests.
 *
 * The retry policy in reviewer-driver / doer-driver depends entirely
 * on this classifier — a single false positive turns a deterministic
 * auth failure into wasted spend; a single false negative loses the
 * cheap save on a transient blip. Lock the taxonomy explicitly.
 */

import { describe, expect, it } from 'vitest';
import { isRetryableErrorKind } from '@/daemon/error-detector';

describe('isRetryableErrorKind', () => {
  it('returns false for undefined kind (no lineage)', () => {
    // Happy-path null result with no recorded errorSummary — no retry.
    expect(isRetryableErrorKind(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isRetryableErrorKind('')).toBe(false);
  });

  describe('shim-owned retry policy (PR #87 follow-up)', () => {
    // Shape matches `Pick<AgentShim, 'retryPolicy'>`. Building tiny
    // shim stubs keeps the classifier tests independent of the full
    // AgentShim contract (formatPrompt, runHeadless, etc.).
    const opencodeShim = {
      retryPolicy: { onNullKind: true, onNoOutput: true },
    };
    const codexShim = { retryPolicy: undefined };
    const claudeShim = {};
    const customShim = {
      retryPolicy: { extraKinds: ['shim_specific_blip' as string] },
    };

    it('retries on null kind when shim opts in via onNullKind', () => {
      // Opencode-go gateway flake: events emitted but no usable content
      // and no error event.
      expect(isRetryableErrorKind(undefined, opencodeShim)).toBe(true);
    });

    it('does NOT retry on null kind when shim has no retryPolicy', () => {
      // Codex/claude/gemini null-with-no-kind = model genuinely produced
      // nothing. Retry would produce the same nothing.
      expect(isRetryableErrorKind(undefined, codexShim)).toBe(false);
      expect(isRetryableErrorKind(undefined, claudeShim)).toBe(false);
      expect(isRetryableErrorKind(undefined)).toBe(false);
    });

    it('retries on no_output when shim opts in via onNoOutput', () => {
      // THE bug the original PR #87 missed: empty-stdout exit
      // synthesises no_output (universally terminal), so the opencode
      // null-kind path was unreachable for the most common opencode
      // failure mode. onNoOutput closes that bypass.
      expect(isRetryableErrorKind('no_output', opencodeShim)).toBe(true);
    });

    it('keeps no_output terminal for shims that did NOT opt in', () => {
      expect(isRetryableErrorKind('no_output', codexShim)).toBe(false);
      expect(isRetryableErrorKind('no_output', claudeShim)).toBe(false);
      expect(isRetryableErrorKind('no_output')).toBe(false);
    });

    it('shim extraKinds list adds shim-specific retryable kinds', () => {
      expect(isRetryableErrorKind('shim_specific_blip', customShim)).toBe(true);
      // Same kind, no shim: stays terminal.
      expect(isRetryableErrorKind('shim_specific_blip')).toBe(false);
    });

    it('shim policy does NOT override universal-terminal kinds', () => {
      // Even an opencode shim with both flags on does NOT retry
      // quota_exhausted / token_refresh_lost / opencode_db_corrupt —
      // these are deterministic, retry would produce the same error.
      expect(isRetryableErrorKind('quota_exhausted', opencodeShim)).toBe(false);
      expect(isRetryableErrorKind('token_refresh_lost', opencodeShim)).toBe(false);
      expect(isRetryableErrorKind('opencode_db_corrupt', opencodeShim)).toBe(false);
    });

    it('verdict_ambiguous is terminal even on opencode shim (PR #91 audit catch)', () => {
      // A reviewer that wrote non-empty prose but no approve/reject
      // keyword is NOT a transport flake. The runner now sets
      // lastError.kind='verdict_ambiguous' so the opencode shim's
      // onNullKind=true policy can't accidentally retry it.
      expect(isRetryableErrorKind('verdict_ambiguous', opencodeShim)).toBe(false);
      expect(isRetryableErrorKind('verdict_ambiguous')).toBe(false);
    });

    it('universal transient kinds retry regardless of shim presence', () => {
      // The opt-in is for ADDITIONAL retries, not a gate on the
      // universal set. A shim with no retryPolicy still gets the full
      // universal transient behaviour.
      expect(isRetryableErrorKind('stream_failure')).toBe(true);
      expect(isRetryableErrorKind('stream_failure', codexShim)).toBe(true);
      expect(isRetryableErrorKind('openrouter_503', codexShim)).toBe(true);
    });
  });

  describe('terminal kinds (never retry)', () => {
    it('quota_exhausted is terminal', () => {
      // Quota windows are server-scheduled; retry within the same
      // second hits the same 429.
      expect(isRetryableErrorKind('quota_exhausted')).toBe(false);
    });

    it('token_refresh_lost is terminal', () => {
      // Refresh tokens are single-use; retry produces the same error.
      // Needs human "codex login" to recover.
      expect(isRetryableErrorKind('token_refresh_lost')).toBe(false);
    });

    it('opencode_db_corrupt is terminal', () => {
      // Local DB corruption persists across retries.
      expect(isRetryableErrorKind('opencode_db_corrupt')).toBe(false);
    });

    it('permission_prompt is terminal', () => {
      // Needs the shim's recoverKeys to advance, not a blind retry.
      expect(isRetryableErrorKind('permission_prompt')).toBe(false);
    });

    it('no_output is terminal', () => {
      // CLI exited cleanly with no events — usually a transport bug
      // (opencode TTY-only output). A retry hits the same transport.
      expect(isRetryableErrorKind('no_output')).toBe(false);
    });
  });

  describe('transient kinds (retry once)', () => {
    it('cold_start_timeout is retryable', () => {
      // First cold start was slow; the second hits a warm process
      // cache often enough to be worth the gamble.
      expect(isRetryableErrorKind('cold_start_timeout')).toBe(true);
    });

    it('tmux_dead is retryable', () => {
      // Session crashed; respawn may succeed.
      expect(isRetryableErrorKind('tmux_dead')).toBe(true);
    });

    it('stream_failure is retryable', () => {
      // Catch-all from reviewer.ts when the stream ends with no
      // recognised kind — usually a brief upstream blip.
      expect(isRetryableErrorKind('stream_failure')).toBe(true);
    });

    it('unknown is retryable', () => {
      // Same treatment as stream_failure.
      expect(isRetryableErrorKind('unknown')).toBe(true);
    });

    it('mcp_handshake_failed is retryable (codex MCP boot race)', () => {
      // Was originally terminal (lumped with auth) but real auth
      // surfaces as token_refresh_lost. mcp_handshake_failed is
      // almost always codex's bundled MCP server booting racily —
      // catches the cheap save without compounding cost on genuine
      // misconfig. Caught when codex hit this on the PR #87 audit
      // chat and went straight to claude fallback with no recovery.
      expect(isRetryableErrorKind('mcp_handshake_failed')).toBe(true);
    });
  });

  describe('OpenRouter shim error kinds', () => {
    it('openrouter_fetch_failed is retryable (pre-HTTP network error)', () => {
      // Emitted when the fetch itself throws — DNS, ECONNRESET,
      // ETIMEDOUT. Exactly what retry is designed to catch.
      expect(isRetryableErrorKind('openrouter_fetch_failed')).toBe(true);
    });

    it('openrouter_no_body is retryable (2xx with empty body)', () => {
      // Anomalous edge state — second request normally succeeds.
      expect(isRetryableErrorKind('openrouter_no_body')).toBe(true);
    });
  });

  describe('OpenRouter HTTP codes', () => {
    it('5xx codes are retryable', () => {
      // Upstream outage; retry has a real chance.
      expect(isRetryableErrorKind('openrouter_500')).toBe(true);
      expect(isRetryableErrorKind('openrouter_502')).toBe(true);
      expect(isRetryableErrorKind('openrouter_503')).toBe(true);
      expect(isRetryableErrorKind('openrouter_504')).toBe(true);
      expect(isRetryableErrorKind('openrouter_599')).toBe(true);
    });

    it('4xx codes are NOT retryable', () => {
      // 401/403 = auth; 402 = out of credits; 429 = rate-limited
      // (retrying immediately just compounds the rate limit).
      expect(isRetryableErrorKind('openrouter_400')).toBe(false);
      expect(isRetryableErrorKind('openrouter_401')).toBe(false);
      expect(isRetryableErrorKind('openrouter_402')).toBe(false);
      expect(isRetryableErrorKind('openrouter_403')).toBe(false);
      expect(isRetryableErrorKind('openrouter_429')).toBe(false);
    });

    it('non-numeric openrouter_ suffix is NOT retryable', () => {
      // Defensive — a malformed kind shouldn't accidentally enable
      // retries on something we didn't classify.
      expect(isRetryableErrorKind('openrouter_unknown')).toBe(false);
      expect(isRetryableErrorKind('openrouter_')).toBe(false);
    });

    it('openrouter prefix is required', () => {
      // Bare "500" — no provider context, treat as not retryable
      // since we don't know what produced it.
      expect(isRetryableErrorKind('500')).toBe(false);
      expect(isRetryableErrorKind('http_500')).toBe(false);
    });
  });
});
