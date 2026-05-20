/**
 * Agent shim registry: lineage → shim implementation.
 * Each CLI lineage (anthropic, openai, google, xai) has a corresponding shim
 * that handles launch commands, prompt formatting, and cost estimation.
 */

import type { AgentRegistry, AgentShim, Lineage } from './types.js';
import { antigravityShim } from './antigravity.js';
import { claudeShim } from './claude.js';
import { codexShim } from './codex.js';
import { geminiShim } from './gemini.js';
import { grokShim } from './grok.js';
import { opencodeShim } from './opencode.js';
import { kimiShim } from './kimi.js';
import { openrouterShim } from './openrouter.js';
import { localShim } from './local.js';

const SHIMS: Record<Lineage, AgentShim> = {
  anthropic: claudeShim,
  openai: codexShim,
  google: geminiShim,
  opencode: opencodeShim,
  moonshot: kimiShim,
  openrouter: openrouterShim,
  local: localShim,
  grok: grokShim,
  antigravity: antigravityShim,
  any: claudeShim, // Fallback to Claude
};

const registry: AgentRegistry = {
  pickShim(lineage: Lineage): AgentShim {
    return SHIMS[lineage] ?? SHIMS.any;
  },

  listAvailable(): AgentShim[] {
    return Object.values(SHIMS);
  },
};

/**
 * Pick a shim taking the model id into account.
 *
 * - `openrouter:*` model ids → openrouterShim (HTTP, regardless of lineage)
 * - `local:*` model ids → localShim (HTTP, regardless of lineage)
 * - everything else → registry lookup by lineage
 *
 * Callers that have a model hint (runner doer + reviewer dispatch) should
 * use this; callers that don't (legacy paths) can keep using registry.pickShim.
 */
export function pickShimForVoice(lineage: Lineage, model?: string): AgentShim {
  if (model && model.startsWith('openrouter:')) return openrouterShim;
  if (model && model.startsWith('local:')) return localShim;
  return registry.pickShim(lineage);
}

/** True when this voice should bypass CLI-credential precheck (HTTP-auth instead). */
export function isHttpDispatchedShim(shim: AgentShim): boolean {
  return shim === openrouterShim || shim === localShim;
}

// Re-export shims for direct access if needed
export { antigravityShim, claudeShim, codexShim, geminiShim, grokShim, opencodeShim, kimiShim, openrouterShim, localShim };
