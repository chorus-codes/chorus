/**
 * Contract tests for the agent ↔ UI lineage map.
 *
 * Failure mode this test exists for: when a new CLI lineage was added
 * (most recently Antigravity in v0.8.45), the cockpit's AGENT_LABEL got
 * the entry but the API route's AGENT_TO_LINEAGE did NOT. The run page
 * then synthesised a slot with lineage='antigravity' while the real
 * on-disk participant resolved to lineage='antigravity-cli' — no match
 * in enrich-rounds, two cards rendered forever (phantom queued + real
 * working). Same class as PR #28's OpenRouter phantom card.
 *
 * Both directions live in one module now; this test locks the
 * round-trip contract so the next CLI lineage can't ship half-wired.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_TO_UI_LINEAGE,
  UI_LINEAGE_TO_AGENT,
} from '../src/lib/agent-name-map.js';

describe('agent-name-map', () => {
  it('every CLI shim name round-trips through both directions', () => {
    for (const [agent, lineage] of Object.entries(AGENT_TO_UI_LINEAGE)) {
      expect(UI_LINEAGE_TO_AGENT[lineage]).toBe(agent);
    }
  });

  it('includes every CLI lineage chorus ships with', () => {
    // Update this list when adding a new CLI shim. The test will fail
    // until both directions of the map are wired and exercises caught
    // the same gap that put a phantom antigravity card on the run page.
    const required = [
      'claude',
      'codex',
      'gemini',
      'opencode',
      'kimi',
      'grok',
      'antigravity',
    ];
    for (const lineage of required) {
      expect(
        UI_LINEAGE_TO_AGENT[lineage],
        `Missing entry for UI lineage "${lineage}" — every CLI shim must round-trip.`,
      ).toBeDefined();
    }
  });

  it('shim names follow the <ui-lineage>-cli convention except claude-code', () => {
    // Claude Code is the only shim that breaks the *-cli convention
    // because Anthropic's package is published as `@anthropic-ai/claude-code`.
    // Document the special-case here so a future contributor doesn't
    // try to "fix" the naming and break the on-disk dir matching.
    expect(AGENT_TO_UI_LINEAGE['claude-code']).toBe('claude');
    for (const agent of Object.keys(AGENT_TO_UI_LINEAGE)) {
      if (agent === 'claude-code') continue;
      expect(agent.endsWith('-cli')).toBe(true);
    }
  });
});
