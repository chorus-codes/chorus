/**
 * Tests for the codex stderr early-abort scanner.
 *
 * The scanner is the fix for the "codex hangs the fleet for 8 minutes on
 * a known auth failure" bug — when codex's refresh-token retry loop spins
 * internally, the daemon used to wait for the subprocess to give up on
 * its own. With this scanner the daemon SIGTERMs the subprocess the
 * moment the deterministic signature appears in stderr.
 *
 * Patterns mirror error-detector.ts patterns 2 + 3 (tmux path). Keep them
 * in sync — diverging signatures would make tmux and headless paths
 * disagree on what counts as a fast-fail.
 */
import { describe, expect, it } from 'vitest';
import { scanCodexStderr } from '../src/daemon/agents/parsers/codex-stderr-scan.js';

describe('scanCodexStderr', () => {
  it('returns null for empty buffer', () => {
    expect(scanCodexStderr('')).toBeNull();
  });

  it('returns null for benign stderr (progress, startup banners)', () => {
    expect(
      scanCodexStderr('codex v1.2.3 — initializing\nLoading config…\n'),
    ).toBeNull();
  });

  it('detects token_refresh_lost on the canonical phrase', () => {
    const stderr =
      'wss://chatgpt.com/backend-api/codex/responses\n' +
      'ERROR: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.\n';
    const hit = scanCodexStderr(stderr);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('token_refresh_lost');
    expect(hit!.message).toMatch(/access token could not be refreshed/i);
  });

  it('detects token_refresh_lost case-insensitively', () => {
    expect(
      scanCodexStderr('Access Token Could Not Be Refreshed'),
    ).not.toBeNull();
  });

  it('returns first matching pattern when several appear', () => {
    // The refresh-token line precedes MCP handshake noise in some runs.
    // Either match is fine — the goal is fast-fail with a structured kind.
    const stderr =
      'ERROR: access token could not be refreshed\n' +
      'WARNING: handshaking with MCP server failed too\n';
    const hit = scanCodexStderr(stderr);
    expect(hit!.kind).toBe('token_refresh_lost');
  });

  it('detects mcp_handshake_failed on the canonical phrase', () => {
    const hit = scanCodexStderr(
      '... codex error: handshaking with MCP server failed: connection refused\n',
    );
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('mcp_handshake_failed');
    expect(hit!.message).toMatch(/handshaking with MCP server failed/i);
  });

  it('does NOT match ambiguous "API error" or transient 5xx', () => {
    // These are recoverable via codex's internal retry — DON'T fast-fail
    // them, or we'd burn the user's fallback chain on a transient hiccup.
    expect(
      scanCodexStderr('API error 500: please retry\n'),
    ).toBeNull();
    expect(
      scanCodexStderr('Request timed out, retrying...\n'),
    ).toBeNull();
  });

  it('does NOT match echoed user prompts containing similar phrases', () => {
    // codex `exec -` reads the prompt from stdin and doesn't echo it,
    // but a prompt mentioning the error phrase routed elsewhere should
    // still be safe. This is belt-and-braces: stderr is for codex, not
    // for prompts.
    const prompt =
      'Review this code where I added a comment that says "// could not be refreshed"';
    // The scanner is matching on the stderr buffer, but if codex ever
    // started echoing prompts to stderr, the loose substring match would
    // false-positive. We accept that risk — scope is limited to known
    // codex stderr signatures, prompts elsewhere don't reach this path.
    // This test documents the regex breadth.
    expect(scanCodexStderr(prompt)).toBeNull();
  });
});
