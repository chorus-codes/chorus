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
      scanCodexStderr('ERROR: Access Token Could Not Be Refreshed'),
    ).not.toBeNull();
  });

  it('returns first matching pattern when several appear', () => {
    // The refresh-token line precedes MCP handshake noise in some runs.
    // Either match is fine — the goal is fast-fail with a structured kind.
    const stderr =
      'ERROR: access token could not be refreshed\n' +
      'ERROR: handshaking with MCP server failed too\n';
    const hit = scanCodexStderr(stderr);
    expect(hit!.kind).toBe('token_refresh_lost');
  });

  it('detects mcp_handshake_failed on the canonical phrase', () => {
    const hit = scanCodexStderr(
      'ERROR: handshaking with MCP server failed: connection refused\n',
    );
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('mcp_handshake_failed');
    expect(hit!.message).toMatch(/handshaking with MCP server failed/i);
  });

  it('does NOT match without the ERROR: / failed prefix anchor', () => {
    // A warning or docstring mentioning the phrase shouldn't kill the
    // subprocess (audit reviewer raised this risk — false-positives
    // here would re-introduce a worse failure mode than the bug we're
    // trying to fix).
    expect(
      scanCodexStderr(
        'INFO: access token could not be refreshed mechanism is deprecated\n',
      ),
    ).toBeNull();
    expect(
      scanCodexStderr('See docs at https://example.com/access-tokens\n'),
    ).toBeNull();
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
    // The anchor on `ERROR:` means even if codex started echoing prompts
    // to stderr, a prompt mentioning the error phrase wouldn't trip the
    // fast-fail unless prefixed by the literal codex error tag.
    const prompt =
      'Review this code where I added a comment that says "// could not be refreshed"';
    expect(scanCodexStderr(prompt)).toBeNull();
  });
});
