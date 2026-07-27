/**
 * Reading the kimi CLI's own model configuration.
 *
 * The kimi CLI does NOT accept vendor model ids on `-m`. Its lookup is an
 * exact key match against the `[models]` table in `~/.kimi/config.toml`
 * (kimi_cli/app.py: `if model_name and model_name in config.models`), and
 * those keys are minted as `<platform-id>/<model-id>` — `kimi-code/k2.6`,
 * `kimi-code/k3`, `moonshot-ai/kimi-k2-thinking`, … — by the `/login` flow,
 * which fetches the model list from the platform API. There is no static
 * list to hardcode: the set is per-account and server-driven.
 *
 * Worse, a `-m` that misses is not a soft failure. The CLI takes the
 * `model_name` branch, finds nothing, and constructs an EMPTY model rather
 * than falling back to `default_model` — so it exits 0, prints "LLM not
 * set", and writes no answer. Passing a wrong `-m` is strictly worse than
 * passing none at all, which is why `resolveKimiModel` returns null (omit
 * the flag) instead of guessing.
 *
 * Templates carry vendor-shaped names (`kimi-k2.6`, `moonshotai/kimi-k3`,
 * `opencode-go/kimi-k2.6`) because those are what the OTHER transports and
 * the pricing catalog use. This module bridges the two namespaces.
 */

import fs from 'fs';
import path from 'path';

/**
 * `[models.<key>]` section headers. TOML quotes any key containing a dot or
 * slash, so the real-world shapes are `[models."kimi-code/k2.6"]` (managed
 * platform entries) and `[models.my-local]` (hand-written bare keys).
 */
const MODELS_SECTION = /^\s*\[models\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]\s*$/gm;

const DEFAULT_MODEL = /^\s*default_model\s*=\s*["']([^"']*)["']/m;

/**
 * Both config locations, in precedence order. The Python kimi-cli uses
 * `~/.kimi/config.toml`; the native Kimi Code build (code.kimi.com) keeps
 * its state under `~/.kimi-code`. A machine can have both installed — #98.
 */
function configPaths(homeDir: string): string[] {
  return [
    path.join(homeDir, '.kimi', 'config.toml'),
    path.join(homeDir, '.kimi-code', 'config.toml'),
  ];
}

function readIfPresent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null; // ENOENT / perm-denied — treated as "no config here"
  }
}

/**
 * Every model key the kimi CLI would accept on `-m`, across both config
 * locations. Deduped and sorted so callers (dropdowns, resolution
 * tie-breaks) get a stable order regardless of file layout.
 */
export function readKimiModelKeys(homeDir: string): string[] {
  const keys = new Set<string>();
  for (const configPath of configPaths(homeDir)) {
    const body = readIfPresent(configPath);
    if (body === null) continue;
    // matchAll on a /g regex is stateless per call — no lastIndex leakage
    // between files.
    for (const m of body.matchAll(MODELS_SECTION)) {
      const key = m[1] ?? m[2] ?? m[3];
      if (key) keys.add(key);
    }
  }
  return [...keys].sort();
}

/** The CLI's own `default_model`, or null when unset/empty. */
export function readKimiDefaultModel(homeDir: string): string | null {
  for (const configPath of configPaths(homeDir)) {
    const body = readIfPresent(configPath);
    if (body === null) continue;
    const m = DEFAULT_MODEL.exec(body);
    if (m && m[1].length > 0) return m[1];
  }
  return null;
}

/**
 * Reduce a model name from either namespace to a comparable core.
 *
 * Drops the platform/vendor prefix (`kimi-code/`, `moonshotai/`,
 * `opencode-go/`), the redundant `kimi-` product prefix, and the
 * punctuation the two namespaces disagree about (`k2.6` vs `k2-6`).
 *
 *   moonshotai/kimi-k3        → k3
 *   kimi-code/k3              → k3
 *   kimi-k2.6                 → k26
 *   kimi-code/k2.6            → k26
 *   kimi-k2-thinking-turbo    → k2thinkingturbo
 */
function normalise(name: string): string {
  const tail = name.slice(name.lastIndexOf('/') + 1);
  return tail.toLowerCase().replace(/^kimi-/, '').replace(/[.\-_]/g, '');
}

/**
 * Map a template's model name onto a key the kimi CLI actually knows.
 *
 * Returns null when nothing matches — meaning "omit `-m` and let the CLI
 * use its own `default_model`". That is the correct fallback, not a
 * defeat: the user picked that default when they logged in, whereas an
 * unmatched `-m` guarantees a "LLM not set" no-op run.
 */
export function resolveKimiModel(
  requested: string | undefined,
  configured: readonly string[],
): string | null {
  if (!requested) return null;
  if (configured.includes(requested)) return requested;

  const want = normalise(requested);
  if (!want) return null;
  // Sorted input in, first match out — deterministic when a user has the
  // same model wired under two platforms (kimi-code/k3 + moonshot-ai/k3).
  const match = [...configured].sort().find((key) => normalise(key) === want);
  return match ?? null;
}
