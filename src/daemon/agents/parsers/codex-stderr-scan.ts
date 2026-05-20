/**
 * Stream-time stderr scanner for the `codex exec` subprocess.
 *
 * The codex CLI retries internally on certain failure modes — auth-token
 * refresh races spin for ~8 minutes before the CLI exits 1. Without this
 * scanner, the daemon waits for the subprocess to give up on its own,
 * blocking the whole reviewer slot and (by extension) the whole audit on
 * one bad reviewer. With it, we detect the deterministic signature in
 * stderr the moment it appears and SIGTERM the subprocess immediately so
 * the fallback chain advances.
 *
 * Scope intentionally tight:
 *   - Only matches signatures codex emits to stderr (NOT prompts).
 *   - Only matches signatures with 100% deterministic recovery (auth lost
 *     → reauth, MCP handshake → reauth, quota → wait/switch).
 *   - Does NOT scan for ambiguous patterns like "API error" or "500" —
 *     those can be transient and benefit from codex's internal retry.
 *
 * Mirrors patterns in src/daemon/error-detector.ts patterns 2 + 3 (used by
 * the tmux path on pane snapshots every 2s). Kept in this small module so
 * the headless path doesn't pay the import cost of the full ErrorDetector
 * class (it carries per-session state for opencode that doesn't apply
 * here).
 */

// Anchored to codex's literal `ERROR:` prefix so warnings or docs that
// merely mention the phrase ("access token could not be refreshed
// mechanism is deprecated") never trip the fast-fail. False-positive
// here means a healthy session gets SIGTERMed mid-stream, so the
// anchor matters. Same anchoring discipline as parseCodex's quota
// regex (CODEX_QUOTA_LINE).
const REFRESH_TOKEN_LINE =
  /ERROR:[^\n]*access token could not be refreshed[^\n]*/i;
const MCP_HANDSHAKE_LINE =
  /(?:ERROR|failed)[^\n]*handshaking with MCP server failed[^\n]*/i;

export function scanCodexStderr(
  stderrSoFar: string,
): { kind: string; message: string } | null {
  // Pattern: auth refresh lost — codex's "ERROR: Your access token could
  // not be refreshed because your refresh token was already used."
  // Single occurrence is enough; codex always exits eventually but
  // takes ~8 min on this path.
  const refresh = REFRESH_TOKEN_LINE.exec(stderrSoFar);
  if (refresh) {
    return {
      kind: 'token_refresh_lost',
      message: refresh[0],
    };
  }

  // Pattern: MCP handshake failure — codex tried to attach to an MCP
  // server (often user-config'd, even with --ignore-user-config) and
  // bailed. Same fast-fail story; reauth recovers.
  const handshake = MCP_HANDSHAKE_LINE.exec(stderrSoFar);
  if (handshake) {
    return {
      kind: 'mcp_handshake_failed',
      message: handshake[0],
    };
  }

  return null;
}
