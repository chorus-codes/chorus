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

  describe('opencode-null special case (PR #85)', () => {
    it('returns TRUE for undefined kind when lineage is opencode', () => {
      // Opencode-go's gateway has known transport flakes where the
      // subprocess exits 0 with empty output (no errorKind, no message)
      // but a second attempt succeeds. Without this the qwen-style
      // null-with-no-kind failure goes straight to fallback chain
      // advance, wasting the cheap save.
      expect(isRetryableErrorKind(undefined, 'opencode')).toBe(true);
    });

    it('keeps the conservative default for other lineages on undefined kind', () => {
      // codex/claude/gemini null-with-no-kind usually means the model
      // genuinely produced nothing — retry would produce nothing again.
      expect(isRetryableErrorKind(undefined, 'openai')).toBe(false);
      expect(isRetryableErrorKind(undefined, 'anthropic')).toBe(false);
      expect(isRetryableErrorKind(undefined, 'google')).toBe(false);
      expect(isRetryableErrorKind(undefined, 'antigravity')).toBe(false);
    });

    it('the lineage hint does NOT override an explicit non-retryable kind', () => {
      // Even on opencode, an auth/quota/db-corrupt kind is still
      // terminal — retry would just produce the same error.
      expect(isRetryableErrorKind('quota_exhausted', 'opencode')).toBe(false);
      expect(isRetryableErrorKind('opencode_db_corrupt', 'opencode')).toBe(false);
      expect(isRetryableErrorKind('no_output', 'opencode')).toBe(false);
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
