/**
 * Bidirectional map between CLI shim names (what the runner uses for
 * subprocess dispatch and on-disk reviewer dir names) and the cockpit's
 * UI lineage tags (what the run page renders as the card identity).
 *
 * Single source of truth so a new CLI lineage can never ship with the
 * map updated in some places but not others — the bug class that put
 * a phantom "ANTIGRAVITY · gemini-3.5-flash" QUEUED card next to the
 * real ANTIGRAVITY-CLI working card on the run page (because the
 * cockpit's enrich-rounds synthesised a slot with lineage='antigravity'
 * while the route's per-dir lookup returned 'antigravity-cli'). Same
 * root cause as the PR #28 OpenRouter phantom card, fixed here at the
 * type/constant boundary instead of one Record at a time.
 */

/** CLI shim name → UI lineage tag. */
export const AGENT_TO_UI_LINEAGE: Record<string, string> = {
  'claude-code': 'claude',
  'codex-cli': 'codex',
  'gemini-cli': 'gemini',
  'opencode-cli': 'opencode',
  'kimi-cli': 'kimi',
  'grok-cli': 'grok',
  'antigravity-cli': 'antigravity',
};

/** Inverse map: UI lineage tag → CLI shim name (the placeholder card uses it). */
export const UI_LINEAGE_TO_AGENT: Record<string, string> = Object.fromEntries(
  Object.entries(AGENT_TO_UI_LINEAGE).map(([agent, lineage]) => [lineage, agent]),
);
