/**
 * Per-CLI stream-json parsers — barrel re-exports.
 *
 * Each parser is a pure function: takes a single line of stdout (or, for
 * codex/opencode-exit, the whole stdout once), returns zero or more
 * AgentEvents. No I/O, no state — unit-testable in isolation from the
 * spawn/transport layer.
 *
 * To add a new CLI: capture sample output, write the parser in its own
 * file under `parsers/`, add a vitest fixture under `tests/`, then have
 * the shim call `spawnHeadless({ parseLine: parseX })`.
 */

export { parseAntigravity, parseAntigravityExit } from './antigravity.js';
export { parseClaude } from './claude.js';
export { parseGemini, parseGeminiExit } from './gemini.js';
export { parseGrok, parseGrokExit } from './grok.js';
export { parseKimi } from './kimi.js';
export { parseOpencode, parseOpencodeExit } from './opencode.js';
export { parseCodex, parseCodexExit } from './codex.js';
export { parseOpenRouterSSE } from './openrouter.js';
