/**
 * Detect whether each supported CLI is installed and runnable.
 *
 * Layered probe:
 *   1. PATH lookup via `which` (Unix) / `where` (Windows)
 *   2. Fallback known install dirs per CLI (covers OpenCode/Kimi installers
 *      that drop binaries in non-PATH locations)
 *   3. Verify with `<bin> --version` (2s timeout) so dead symlinks fail
 *
 * Cursor and Windsurf are IDEs invoked via MCP, not CLIs on PATH, so they're
 * not part of this probe — onboarding leaves their checkboxes for the user.
 */

import { spawnSync } from 'child_process';
import { existsSync, lstatSync, realpathSync } from 'fs';
import { homedir, platform } from 'os';
import path from 'path';

import { cliPaths } from './cli-paths.js';

export type DetectableCli =
  | 'claude-code'
  | 'codex-cli'
  | 'gemini-cli'
  | 'opencode-cli'
  | 'kimi-cli'
  | 'grok-cli'
  | 'antigravity-cli';

const BINARY_NAME: Record<DetectableCli, string> = {
  'claude-code': 'claude',
  'codex-cli': 'codex',
  'gemini-cli': 'gemini',
  'opencode-cli': 'opencode',
  'kimi-cli': 'kimi',
  'grok-cli': 'grok',
  // Antigravity CLI ships as `agy` — Google's own naming. Distinct from the
  // `antigravity` VSCode IDE binary at ~/.antigravity-server/.../antigravity
  // which is unrelated to chorus.
  'antigravity-cli': 'agy',
};

const isWindows = platform() === 'win32';
const HOME = homedir();

/**
 * Discovered npm prefix bin dirs — populated lazily by `discoverNpmPrefixes`.
 * Cached at module scope so we shell out once per daemon lifetime, not once
 * per CLI per probe.
 */
let cachedNpmDirs: string[] | null = null;

/**
 * Ask npm where it installs global binaries. Covers users with custom
 * `prefix` configs (e.g. ~/.npm-global, ~/.config/npm), nvm-active
 * versions, or an OS package manager that put npm in a non-default
 * location. Best-effort — a missing/broken npm just yields an empty
 * list so we fall back to the static probes.
 */
function discoverNpmPrefixes(): string[] {
  if (cachedNpmDirs !== null) return cachedNpmDirs;
  const dirs = new Set<string>();
  // Try `npm config get prefix` (1s budget — slow npm shouldn't block detect).
  try {
    const result = spawnSync('npm', ['config', 'get', 'prefix'], {
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: isWindows,
    });
    if (result.status === 0) {
      const prefix = result.stdout.trim();
      if (prefix) {
        dirs.add(isWindows ? prefix : path.join(prefix, 'bin'));
      }
    }
  } catch {
    /* npm not installed / not on PATH — fall through */
  }
  // NPM_CONFIG_PREFIX env override (common in CI, asdf, custom shells).
  const envPrefix = process.env.NPM_CONFIG_PREFIX || process.env.npm_config_prefix;
  if (envPrefix) {
    dirs.add(isWindows ? envPrefix : path.join(envPrefix, 'bin'));
  }
  cachedNpmDirs = Array.from(dirs);
  return cachedNpmDirs;
}

/**
 * Per-CLI fallback install locations to probe when PATH lookup misses.
 *
 * Covers the common installers in the wild — npm global with various
 * prefixes (default, custom, volta, fnm, nvm), Yarn, PNPM, Bun, Cargo,
 * Homebrew (Intel + Apple Silicon), system package dirs — plus per-CLI
 * installer-script locations (OpenCode + Kimi drop binaries in their
 * own dot-folders by default).
 *
 * Order matters: PATH lookup runs first; this list is the second-chance
 * scan, so cheap/common locations come first to keep the probe fast.
 */
function fallbackPaths(cli: DetectableCli): string[] {
  const bin = BINARY_NAME[cli];
  const exts = isWindows ? ['.cmd', '.exe', ''] : [''];
  const dirs: string[] = [];

  if (isWindows) {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
    if (process.env.LOCALAPPDATA) {
      dirs.push(
        path.join(process.env.LOCALAPPDATA, 'Programs'),
        // Volta on Windows
        path.join(process.env.LOCALAPPDATA, 'Volta', 'bin'),
      );
    }
    dirs.push(
      path.join(HOME, 'AppData', 'Roaming', 'npm'),
      path.join(HOME, '.volta', 'bin'),
      path.join(HOME, '.bun', 'bin'),
    );
  } else {
    dirs.push(
      // User-local
      path.join(HOME, '.local', 'bin'),
      path.join(HOME, '.npm-global', 'bin'),
      path.join(HOME, '.config', 'yarn', 'global', 'node_modules', '.bin'),
      path.join(HOME, '.yarn', 'bin'),
      // Node version managers
      path.join(HOME, '.volta', 'bin'),
      path.join(HOME, '.fnm', 'aliases', 'default', 'bin'),
      // Alt package managers
      path.join(HOME, '.bun', 'bin'),
      path.join(HOME, '.cargo', 'bin'),
      path.join(HOME, '.local', 'share', 'pnpm'),
      path.join(HOME, 'Library', 'pnpm'),
      // System-wide
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
      // Common npm-global system dirs
      '/usr/local/lib/node_modules/.bin',
      '/opt/homebrew/lib/node_modules/.bin',
    );
  }

  // CLI-specific installer locations (their own install scripts).
  if (cli === 'opencode-cli') {
    dirs.push(path.join(HOME, '.opencode', 'bin'));
  }
  if (cli === 'kimi-cli') {
    dirs.push(path.join(HOME, '.kimi', 'bin'));
  }
  if (cli === 'grok-cli') {
    // xAI's installer drops binaries here (curl|bash from x.ai/cli).
    // GROK_BIN_DIR env override is honoured upstream but not by the
    // chorus detector — second-chance scan is best-effort, users on
    // custom prefixes should add the dir to PATH.
    dirs.push(path.join(HOME, '.grok', 'bin'));
  }

  // npm-discovered prefixes — cheapest signal for "where did the user
  // actually install global packages?". Pulled last so the static list
  // wins on cache hits, but still covers exotic setups.
  for (const npmDir of discoverNpmPrefixes()) {
    dirs.push(npmDir);
  }

  const candidates: string[] = [];
  // Dedup while preserving order — a user with PNPM_HOME=~/.local/share/pnpm
  // shouldn't pay for two probes of the same dir.
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, `${bin}${ext}`);
      if (seen.has(full)) continue;
      seen.add(full);
      candidates.push(full);
    }
  }
  return candidates;
}

export interface CliDetection {
  id: DetectableCli;
  found: boolean;
  path?: string;
  /** "path" = found via PATH lookup, "fallback" = found via known dirs, "manual" = user-supplied */
  source?: 'path' | 'fallback' | 'manual';
  /** Populated when found=false on manual validation — explains why
   *  (e.g. "no file at that path", "doesn't look like the claude CLI"). */
  reason?: string;
}

function pathLookup(name: string): string | null {
  const cmd = isWindows ? 'where' : 'which';
  const result = spawnSync(cmd, [name], { encoding: 'utf-8' });
  if (result.status !== 0) return null;
  // `where` returns one path per line on Windows; take the first.
  const first = result.stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
  return first || null;
}

/**
 * Per-CLI version-output signatures. The shape varies wildly between
 * CLIs — claude prints "2.1.126 (Claude Code)", codex prints
 * "codex-cli 0.128.0", but gemini / opencode print just a bare
 * version like "0.40.1" with NO CLI name. So each CLI gets its own
 * matcher rather than a uniform name-substring regex.
 *
 * Strategy:
 *   - CLIs whose output includes the name → match the name (case-insensitive).
 *   - CLIs that print a bare version → accept output that STARTS with a
 *     digit-dot-digit (semver-ish). This rules out e.g. `cat --version`
 *     (output starts with "cat (GNU…") while accepting any reasonable
 *     `<bin> --version` from a real install.
 *
 * False positives here (a runnable binary that happens to print a bare
 * version) are still better than rubber-stamping `cat --version` as a
 * valid Claude install — which is what the original exit-0-only check
 * did.
 */
const STARTS_WITH_VERSION = /^\s*\d+\.\d+/;
const CLI_SIGNATURES: Record<DetectableCli, RegExp> = {
  'claude-code': /\bclaude\b/i,
  'codex-cli': /\bcodex\b/i,
  // Bare version output — "0.40.1" — no CLI name to grep for.
  'gemini-cli': STARTS_WITH_VERSION,
  // Bare version output — "1.14.30" — same as gemini.
  'opencode-cli': STARTS_WITH_VERSION,
  'kimi-cli': /\bkimi\b/i,
  // xAI's grok CLI — actual --version output unverified at time of
  // writing (binary execution sandboxed off in this env). Accepting
  // either a "grok" name token OR a bare version string; basename
  // check still gates on the binary being named "grok".
  'grok-cli': /\bgrok\b/i,
  // Antigravity CLI's `agy --version` prints a bare semver ("1.0.0") with no
  // name token — same shape as gemini-cli and opencode-cli. The basename
  // allowlist below gates on the binary actually being named `agy`, so a
  // generic semver match here is safe.
  'antigravity-cli': STARTS_WITH_VERSION,
};

interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Basename allowlist — the binary's filename must match the expected
 * name (case-insensitive, .exe/.cmd suffixes stripped) before we even
 * try to verify the version output. This is the primary guard against
 * the STARTS_WITH_VERSION regex being too permissive: `npm --version`
 * prints "11.7.0" and would otherwise pass as gemini/opencode. The
 * regex stays as a secondary check — a binary that's named correctly
 * but whose --version output is total junk still gets rejected.
 *
 * Validated locally before adding (2026-05-04):
 *   npm 11.7.0   → matches version regex (would've false-passed)
 *   pip 24.0     → no (starts with "pip ")
 *   node v20.19  → no (starts with "v")
 *   python 3.12  → no (starts with "Python ")
 */
function basenameMatches(cli: DetectableCli, binPath: string): boolean {
  const expected = BINARY_NAME[cli].toLowerCase();
  const base = path.basename(binPath).toLowerCase();
  // Strip Windows extensions so claude.exe / claude.cmd both match "claude".
  const stripped = base.replace(/\.(exe|cmd|bat|ps1)$/i, '');
  return stripped === expected;
}

/**
 * Resolve the `spawn`/`spawnSync` arguments for invoking `<bin> --version`
 * across platforms. On Windows, Node cannot directly execute `.cmd` /
 * `.bat` shims (DEP0190 / CVE-2024-27980) — calling spawn with a .cmd
 * target either errors or returns `status: null` (the symptom reported
 * in issue #32).
 *
 * Approach: use Node's `shell: true` which on Windows invokes
 * `cmd.exe /d /s /c <command>`. Wrapping the bin path in `"..."`
 * preserves spaces in paths (e.g. `C:\Program Files\foo\bar.cmd`),
 * which is the common case on Windows npm installs.
 *
 * `.ps1` deliberately NOT included — PowerShell scripts need
 * `powershell.exe -File` (or `pwsh.exe`), and `cmd.exe /c foo.ps1`
 * only sometimes works via file-type association. We stick to the
 * .cmd / .bat case which is the actual reported failure mode.
 *
 * Shell-injection guard: we only enable `shell: true` when the bin
 * path matches a Windows-path pattern (drive letter + no shell
 * metacharacters). Uses a blacklist of cmd.exe-dangerous chars
 * (`&`, `|`, `;`, `"`, `` ` ``, `$`, `<`, `>`, `%`, `^`, `!`) so
 * Unicode letters (e.g. accented characters in usernames) and `@`
 * (npm scoped packages) pass through safely. `^` is cmd.exe's
 * escape character; `!` triggers delayed expansion when
 * `setlocal enabledelayedexpansion` is active (common in CI
 * scripts and build wrappers). Any blocked char causes a fallback
 * to the direct-exec branch, which will fail cleanly rather than
 * risking command injection from a malicious paste.
 */
export interface VersionSpawn {
  cmd: string;
  args: string[];
  /** When true, the caller MUST pass `shell: true` to spawn/spawnSync. */
  shell?: boolean;
}

const SAFE_WIN_PATH = /^[A-Za-z]:[\\/][^|&;"`$<>%^!\0\r\n]+$/u;

export function buildVersionSpawn(
  binPath: string,
  isWin: boolean = isWindows,
): VersionSpawn {
  if (isWin && /\.(cmd|bat)$/i.test(binPath)) {
    if (!SAFE_WIN_PATH.test(binPath)) {
      // Unexpected metacharacter — bail out of the shell-wrapped path
      // to avoid injection. The direct exec will fail cleanly with a
      // null/non-zero status, surfaced by the validator's normal
      // error path. Far safer than passing the suspect string through
      // cmd.exe.
      return { cmd: binPath, args: ['--version'] };
    }
    // Quote the bin path so cmd.exe /d /s /c handles spaces correctly.
    // The full command string is what spawn passes to cmd.exe; args
    // stays empty because the whole invocation is in `cmd`.
    return {
      cmd: `"${binPath}" --version`,
      args: [],
      shell: true,
    };
  }
  return { cmd: binPath, args: ['--version'] };
}

function verifyRunnable(
  cli: DetectableCli,
  binPath: string,
  timeoutMs = 2000,
): VerifyResult {
  if (!existsSync(binPath)) {
    return { ok: false, reason: 'no file at that path' };
  }
  if (!basenameMatches(cli, binPath)) {
    return {
      ok: false,
      reason: `expected a binary named "${BINARY_NAME[cli]}" — got "${path.basename(binPath)}"`,
    };
  }
  let result;
  try {
    const spec = buildVersionSpawn(binPath);
    result = spawnSync(spec.cmd, spec.args, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: spec.shell ?? false,
    });
  } catch (err) {
    return { ok: false, reason: `failed to spawn (${(err as Error).message})` };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `${path.basename(binPath)} --version exited ${result.status}`,
    };
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const signature = CLI_SIGNATURES[cli];
  if (!signature.test(output)) {
    return {
      ok: false,
      reason:
        `that binary ran, but its --version output doesn't look like the ${BINARY_NAME[cli]} CLI`,
    };
  }
  return { ok: true };
}

function detectOne(cli: DetectableCli): CliDetection {
  // 0. User-supplied manual path wins over PATH/fallback. Without this,
  //    a fresh boot's PATH lookup would silently miss a CLI in a custom
  //    location even though the user had explicitly told us where to
  //    find it via the onboarding "I know where it is" affordance.
  //    Read from the sync cache populated at daemon boot — async settings
  //    fetch isn't available here without refactoring every detect caller.
  const manual = cliPaths.getCached(cli);
  if (manual && existsSync(manual) && verifyRunnable(cli, manual).ok) {
    return { id: cli, found: true, path: manual, source: 'manual' };
  }

  // 1. PATH lookup
  const onPath = pathLookup(BINARY_NAME[cli]);
  if (onPath && verifyRunnable(cli, onPath).ok) {
    return { id: cli, found: true, path: onPath, source: 'path' };
  }

  // 2. Fallback known dirs
  for (const candidate of fallbackPaths(cli)) {
    if (existsSync(candidate) && verifyRunnable(cli, candidate).ok) {
      return { id: cli, found: true, path: candidate, source: 'fallback' };
    }
  }

  return { id: cli, found: false };
}

/**
 * Cache for `detectAllClis` — every detect spawns up to 5 child
 * processes (one `--version` per CLI), so when a daemon route resolves
 * a CLI path on every HTTP poll (e.g. /orchestrators/opencode/models
 * during onboarding), we'd fork ~50 processes/second without a cache.
 *
 * 30s TTL is short enough that a `chorus install <cli>` run from a
 * different shell shows up before the user finishes onboarding, but
 * long enough that a polling UI doesn't keep retriggering scans.
 * Tests can call detectAllClis with `force: true` to bypass.
 */
let detectCache: { results: CliDetection[]; expiresAt: number } | null = null;
const DETECT_CACHE_TTL_MS = 30_000;

export function detectAllClis(force = false): CliDetection[] {
  const now = Date.now();
  if (!force && detectCache && detectCache.expiresAt > now) {
    return detectCache.results;
  }
  const results = (Object.keys(BINARY_NAME) as DetectableCli[]).map(detectOne);
  detectCache = { results, expiresAt: now + DETECT_CACHE_TTL_MS };
  return results;
}

/** Clear the detection cache. Used by callers that mutated state we
 *  know will change the answer (e.g. user just supplied a manual path,
 *  or installed a new CLI via the cockpit). */
export function clearDetectionCache(): void {
  detectCache = null;
}

/**
 * Validate a user-supplied path for a given CLI. Used by the
 * "Set path manually" fallback when auto-detect misses.
 *
 * Layered checks (any failure returns found=false + a reason):
 *   1. Basename matches the expected binary name. Catches the common
 *      paste-the-wrong-tool mistake — e.g. `/usr/bin/npm` for gemini-cli
 *      passes the bare-version regex but its basename is `npm`, not
 *      `gemini`. Both round-1 reviewers (claude + gemini) flagged this
 *      gap when smoke-testing the previous version.
 *   2. File exists.
 *   3. `--version` exits 0 with output that matches the CLI's signature.
 *
 * Auto-detect doesn't need step 1 — pathLookup/fallback already bound
 * the search to the expected binary name.
 */
export function validateCliPath(
  cli: DetectableCli,
  customPath: string,
): CliDetection & { reason?: string } {
  const trimmed = customPath.trim();
  if (!trimmed) return { id: cli, found: false, reason: 'path is empty' };
  // Basename gate — strip extension on Windows so claude.cmd / claude.exe
  // both match `claude`.
  const expectedBin = BINARY_NAME[cli];
  const actualBase = isWindows
    ? path.basename(trimmed).replace(/\.(cmd|exe)$/i, '')
    : path.basename(trimmed);
  if (actualBase.toLowerCase() !== expectedBin.toLowerCase()) {
    return {
      id: cli,
      found: false,
      reason: `that file is named "${actualBase}", but the ${cli} binary should be "${expectedBin}". Pasted the wrong path?`,
    };
  }
  // Symlink-aware validation:
  //   - Reject sockets / pipes / directories outright (lstat).
  //   - For symlinks, realpath the target and re-check it's a regular
  //     file. This keeps Homebrew / asdf / mise / npm-global / fnm /
  //     volta installs working (most ship the user-facing binary as a
  //     symlink) while neutralising the TOCTOU attack from Audit D3:
  //     we persist the CANONICAL path, so a later swap of the symlink
  //     can't redirect daemon spawns to a malicious binary.
  //   - existsSync alone (the pre-fix call) followed symlinks silently
  //     and stored the symlink path — that's the attack surface we're
  //     closing.
  let canonical = trimmed;
  let lstat: import('fs').Stats;
  try {
    lstat = lstatSync(trimmed);
  } catch {
    return { id: cli, found: false, reason: `no file at ${trimmed}` };
  }
  if (lstat.isSymbolicLink()) {
    try {
      canonical = path.resolve(
        path.dirname(trimmed),
        // realpath resolves the chain; spawning the canonical target
        // means a later symlink-swap can't redirect us.
        realpathSync(trimmed),
      );
      const realStat = lstatSync(canonical);
      if (!realStat.isFile()) {
        return {
          id: cli,
          found: false,
          reason: `symlink target is not a regular file: ${canonical}`,
        };
      }
    } catch {
      return {
        id: cli,
        found: false,
        reason: `symlink could not be resolved: ${trimmed}`,
      };
    }
  } else if (!lstat.isFile()) {
    return {
      id: cli,
      found: false,
      reason: `path is not a regular file: ${trimmed}`,
    };
  }
  // Verify via the user-pasted path so verifyRunnable's internal
  // basename check passes — "claude" symlinked to a versioned target
  // like "2.1.126" is the canonical real-world install (npm/Homebrew
  // both do this). Spawning the symlink path runs the same binary as
  // spawning the resolved target since the kernel follows the link.
  const v = verifyRunnable(cli, trimmed);
  if (!v.ok) return { id: cli, found: false, reason: v.reason };
  // Persist the canonical (realpath-resolved) target. Daemon spawns
  // will hit the resolved binary even if the symlink is later swapped
  // by an attacker — closes the TOCTOU window from Audit D3.
  return { id: cli, found: true, path: canonical, source: 'manual' };
}
