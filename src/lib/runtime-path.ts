/**
 * Runtime PATH resolution for headless CLI subprocess spawns.
 *
 * Why this module exists
 * ----------------------
 * The chorus daemon spawns reviewer CLIs (claude, codex, gemini, opencode,
 * kimi) as headless subprocesses. Those subprocesses inherit the daemon's
 * PATH — which is whatever PATH was set for the process that launched the
 * daemon.
 *
 * That PATH is frequently INSUFFICIENT for finding the CLIs:
 *
 *   - Linux opencode installs to `~/.opencode/bin/`, exported via .bashrc.
 *     The daemon usually starts from a non-interactive shell that skips
 *     .bashrc (early-return on `[ -z "$PS1" ]`), so opencode is missing.
 *   - macOS Homebrew installs to /opt/homebrew/bin (Apple Silicon) or
 *     /usr/local/bin (Intel). LaunchAgent / tray-app starts inherit a
 *     minimal PATH that may exclude either.
 *   - asdf / volta / pnpm shim dirs live under $HOME/.tool-versions/...
 *     and only land on PATH via shellenv hooks.
 *
 * The fix has three layers, all stacked here:
 *
 *   1. **Captured interactive PATH** — `chorus init` and `chorus start`
 *      run `$SHELL -lic 'echo $PATH'` once and stash the result in the
 *      `runtime.captured_path` setting. Subsequent daemon spawns merge
 *      it in, so if the user can run `opencode` from their terminal, the
 *      daemon can run it too.
 *   2. **Known-install dirs** — common per-tool install locations
 *      (`~/.opencode/bin`, `~/.codex/bin`, `/opt/homebrew/bin`, …) are
 *      auto-prepended when they exist on disk. Belt-and-braces for tray-
 *      app launches that have no terminal to capture from.
 *   3. **Manual paths** — when the user pastes a custom path in the
 *      onboarding "I know where it is" affordance, the dirname of that
 *      path is added too. Ensures bare-binary spawns still work even when
 *      the binary lives in a fully custom location.
 *
 * This module is import-time stateful but reads `settings` lazily, so
 * tests can swap CHORUS_DB_PATH without restarting the process.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { settings } from './db/settings.js';

const SETTINGS_KEY_CAPTURED_PATH = 'runtime.captured_path';

/**
 * Per-tool install locations that live OUTSIDE the typical /usr/local/bin
 * default PATH. Order matters only when two contain the same binary; we
 * dedupe on output. macOS-only paths are kept on Linux too — fs.existsSync
 * filters them out so there's no harm in leaving them in the list.
 */
const KNOWN_INSTALL_DIRS = [
  '~/.opencode/bin',
  '~/.codex/bin',
  '~/.gemini/bin',
  '~/.kimi/bin',
  // Native Kimi Code (code.kimi.com) installs here, grok (xAI) here. Both
  // are probed by detection's fallbackPaths, so they must also reach the
  // spawn PATH or a fallback-detected binary ENOENTs on bare-name spawn.
  // Keep in sync with the per-CLI dirs in cli-detect.ts:fallbackPaths (#98).
  '~/.kimi-code/bin',
  '~/.grok/bin',
  '~/.claude/local',
  '~/.bun/bin',
  '~/.deno/bin',
  '~/.cargo/bin',
  '~/.local/bin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}

/**
 * Run the user's interactive login shell and ask for its PATH. Captures
 * everything PATH-modifying init scripts add — .bashrc, .zshrc, asdf
 * shims, fnm/nvm setup, fish abbreviations.
 *
 * Returns null when:
 *   - $SHELL is unset (e.g. some CI environments)
 *   - The shell exec itself fails (timeout, missing binary)
 *   - The shell prints something that doesn't look like a PATH
 *
 * Caller is expected to fall back gracefully on null — e.g. keep the
 * previously-saved value or use process.env.PATH as-is.
 */
export function captureInteractivePath(): string | null {
  const shell = process.env.SHELL;
  if (!shell) return null;
  if (process.platform === 'win32') return null; // PowerShell capture is a different code path; not implemented yet.

  try {
    // -l: login shell (loads .profile / .zprofile)
    // -i: interactive (loads .bashrc / .zshrc — most rc files early-return
    //     on non-interactive, so this flag is essential)
    // -c: command + exit
    const out = execSync(`${shell} -lic 'echo $PATH'`, {
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString('utf-8')
      .trim();
    if (!out || !out.includes('/')) return null;
    return out;
  } catch {
    // Common failure modes:
    //   - User's rc file errors on non-tty stdout
    //   - 5s timeout (rc does network I/O)
    //   - SHELL points at a binary that doesn't exist
    return null;
  }
}

/**
 * Persist the captured interactive PATH so the daemon can read it on
 * boot. Called from `chorus init` and `chorus start`. Best-effort:
 * settings write failures don't block startup — the daemon falls back
 * to known-install dirs + process.env.PATH.
 */
export async function persistCapturedPath(value: string): Promise<void> {
  await settings.set(SETTINGS_KEY_CAPTURED_PATH, value);
}

export async function loadCapturedPath(): Promise<string | null> {
  const raw = await settings.get(SETTINGS_KEY_CAPTURED_PATH);
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Build the merged PATH for a daemon-spawned subprocess. Composition,
 * front-to-back (front wins on duplicate binaries):
 *
 *   1. Existing process.env.PATH      — daemon's own runtime
 *   2. Captured interactive PATH      — what the user's shell sees
 *   3. Known install dirs (existing)  — ~/.opencode/bin, etc.
 *   4. Manual-path dirs               — dirnames of saved cli_paths
 *
 * Dedup on output. Caller is expected to pass `additionalDirs` from
 * `cli-paths.ts` — keeping the dependency one-way (this module doesn't
 * import from cli-paths to avoid a circular import on the settings
 * helpers).
 */
export async function buildRuntimePath(opts?: {
  additionalDirs?: string[];
}): Promise<string> {
  const parts: string[] = [];

  if (process.env.PATH) parts.push(process.env.PATH);

  const captured = await loadCapturedPath();
  if (captured) parts.push(captured);

  for (const dir of KNOWN_INSTALL_DIRS) {
    const expanded = expandHome(dir);
    if (fs.existsSync(expanded)) parts.push(expanded);
  }

  for (const dir of opts?.additionalDirs ?? []) {
    if (dir && fs.existsSync(dir)) parts.push(dir);
  }

  // Dedupe while preserving first-occurrence order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    for (const dir of part.split(path.delimiter)) {
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      out.push(dir);
    }
  }
  return out.join(path.delimiter);
}

/**
 * Convenience wrapper for the common spawn case — merge the runtime
 * PATH into a copy of process.env. Subprocess inherits everything else
 * unchanged.
 */
export async function buildRuntimeEnv(opts?: {
  additionalDirs?: string[];
}): Promise<NodeJS.ProcessEnv> {
  return {
    ...process.env,
    PATH: await buildRuntimePath(opts),
  };
}
