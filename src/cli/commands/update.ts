import { spawn } from 'child_process';
import type { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { isPidAlive, readDaemonInfo } from '../../lib/daemon-discovery.js';
import { pkg } from '../shared.js';
import { c, header, sym } from '../ui.js';

/**
 * `chorus update` — self-locating npm install.
 *
 * Why this exists: a substantial fraction of users hit a PATH/install-
 * location mismatch when they run `sudo npm install -g chorus-codes`.
 * Their `chorus` command resolves to a per-user nvm/fnm prefix, but
 * `sudo npm install` writes to root's prefix. The new version is on
 * disk somewhere, but PATH never sees it. They debug for 20 minutes,
 * give up, file an issue.
 *
 * The cure: `chorus update` derives the npm prefix from the *running*
 * binary's path (process.argv[1] / __dirname), then runs
 * `npm install -g chorus-codes@latest --prefix <derived>`. The update
 * always lands in the same install location PATH already points at,
 * regardless of whether the original install was via sudo, nvm, brew,
 * or system npm. No manual prefix wrangling.
 */
export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description('Update chorus to the latest version on npm')
    .option('--check', 'Only check for updates; do not install')
    .action(async (options: { check?: boolean }) => {
      try {
        const current = pkg.version;
        const latest = await fetchLatestVersion();

        if (latest === null) {
          console.log('');
          console.log(
            header(
              sym.err,
              "Couldn't reach npm registry",
              'check your network connection and retry',
            ),
          );
          console.log('');
          process.exit(1);
        }

        if (options.check) {
          if (versionGreater(latest, current)) {
            console.log('');
            console.log(
              header(
                sym.info,
                `chorus ${latest} is available`,
                `you have ${current}`,
              ),
            );
            console.log(`   Run ${c.cyan('chorus update')} to upgrade`);
            console.log('');
          } else {
            console.log('');
            console.log(
              header(sym.ok, `chorus ${current} is up to date`),
            );
            console.log('');
          }
          return;
        }

        if (!versionGreater(latest, current)) {
          console.log('');
          console.log(
            header(sym.ok, `chorus ${current} is already up to date`),
          );
          console.log('');
          return;
        }

        const prefix = detectNpmPrefix();

        // Pre-flight writability check. npm's atomic-install algorithm
        // renames the existing chorus-codes/ folder before unpacking the
        // new tarball; the rename fails with EACCES whenever a Windows
        // process (Windows Defender, VSCode indexer, Search) holds a
        // handle into the folder. WSL users with nvm installed on a
        // Windows drive (/mnt/c, /mnt/d, etc.) hit this every time.
        // Surfacing a clear message + migration steps before we even
        // shell out to npm beats the cryptic stack trace npm prints.
        if (prefix) {
          const probe = checkPrefixUsable(prefix);
          if (!probe.ok) {
            console.log('');
            console.log(
              header(
                sym.err,
                "Can't update chorus at this prefix",
                probe.reason,
              ),
            );
            console.log('');
            console.log(c.dim('   Migrate to a Linux-side npm prefix:'));
            console.log(`     mkdir -p ~/.npm-global`);
            console.log(`     npm config set prefix ~/.npm-global`);
            console.log(
              `     echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc`,
            );
            console.log(`     source ~/.bashrc`);
            console.log(`     npm install -g chorus-codes`);
            console.log('');
            console.log(c.dim('   After that, future `chorus update` calls work normally.'));
            console.log('');
            process.exit(1);
          }
        }

        console.log('');
        console.log(
          header(
            sym.pointer,
            `Updating chorus ${current} → ${latest}`,
            prefix ? `prefix ${prefix}` : 'using npm default prefix',
          ),
        );
        console.log('');

        const args = ['install', '-g', `chorus-codes@${latest}`];
        if (prefix) {
          args.push('--prefix', prefix);
        }

        // Snapshot whether a daemon was running BEFORE install. After
        // npm replaces the binary on disk, the in-process pkg.version
        // is still the old one but spawn() of `chorus` will resolve to
        // the new file. Capture daemon state first so we know whether
        // to restart.
        const preInstallDaemon = readDaemonInfo();
        const daemonWasRunning = !!(
          preInstallDaemon && isPidAlive(preInstallDaemon.daemonPid)
        );
        const cockpitWasRunning = !!(
          preInstallDaemon?.cockpitPid &&
          isPidAlive(preInstallDaemon.cockpitPid)
        );

        // Hand stdio to npm so the user sees its progress + any errors
        // (EACCES, network, etc.). spawn rather than execFile so we can
        // stream output as it happens.
        const child = spawn('npm', args, { stdio: 'inherit', shell: process.platform === 'win32' });
        await new Promise<void>((resolve, reject) => {
          child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`npm install exited with code ${code}`));
          });
          child.on('error', reject);
        });

        // Auto-restart the daemon if it was running before the install.
        // Without this, the user sees "Updated to v0.8.43" but `chorus
        // start` still reports the old daemon running on the prior
        // version (the reported UX bug this PR exists to fix).
        //
        // Spawn the absolute path to the newly-installed binary rather
        // than `chorus` from PATH. PATH ordering is unreliable on hosts
        // with multiple chorus installs (sudo prefix vs nvm prefix);
        // start.ts has drift detection as a backstop, but spawning the
        // right binary the first time avoids a confusing double-restart.
        if (daemonWasRunning) {
          console.log('');
          console.log(
            header(
              sym.pointer,
              `Restarting daemon on v${latest}`,
              cockpitWasRunning ? 'cockpit will come back up' : 'daemon-only',
            ),
          );
          const installedBinary = resolveInstalledChorusBinary(prefix);
          // `stop` is tolerant: if the daemon died during the npm
          // install window (~30-90s; OOM kill, manual stop), the stop
          // step would otherwise reject and abort the restart with a
          // confusing "exit code 1" after we already printed the
          // "Restarting daemon" header.
          await runChorusSubcommand(['stop'], { binaryPath: installedBinary, tolerant: true });
          const startArgs = cockpitWasRunning ? ['start'] : ['start', '--daemon-only'];
          await runChorusSubcommand(startArgs, { binaryPath: installedBinary });
        }

        console.log('');
        console.log(
          header(
            sym.ok,
            `Updated to chorus ${latest}`,
            daemonWasRunning
              ? 'daemon restarted on the new version'
              : 'no daemon was running',
          ),
        );
        console.log('');
      } catch (error) {
        console.log('');
        const message = error instanceof Error ? error.message : String(error);
        console.error(`${sym.err} ${c.red('Update failed:')} ${message}`);
        console.log('');
        console.log(
          c.dim('   If this is a permissions error, your npm prefix may not be writable.'),
        );
        console.log(
          c.dim(
            '   Try: npm config set prefix ~/.npm-global, then add ~/.npm-global/bin to PATH.',
          ),
        );
        console.log('');
        process.exit(1);
      }
    });
}

/**
 * Compute the absolute path to the chorus binary at a known npm prefix.
 * Layout matches the install structure documented in detectNpmPrefix:
 *   POSIX:   <prefix>/lib/node_modules/chorus-codes/bin/chorus.mjs
 *            <prefix>/bin/chorus  (symlink to the .mjs)
 *   Windows: <prefix>/node_modules/chorus-codes/bin/chorus.mjs
 *            <prefix>/chorus.cmd  (shim)
 *
 * Returns null when the expected binary isn't found — caller falls
 * back to PATH resolution (best effort).
 *
 * Why this exists: convergent self-review (4/6 reviewers on PR #60)
 * flagged that spawning `chorus` from raw PATH after `npm install -g`
 * is unreliable in multi-install scenarios (sudo prefix + nvm prefix).
 * npm updates the binary at its target prefix but doesn't touch PATH
 * ordering — so a stale `chorus` earlier in PATH would be invoked
 * instead of the freshly-installed one. Ironic given this is the
 * exact bug PR #60 is fixing, just from the opposite direction.
 * Spawning the absolute path at the install prefix sidesteps PATH
 * entirely.
 */
function resolveInstalledChorusBinary(prefix: string | null): string | null {
  if (!prefix) return null;
  const win32 = process.platform === 'win32';
  const candidates = win32
    ? [
        path.join(prefix, 'chorus.cmd'),
        path.join(prefix, 'node_modules', 'chorus-codes', 'bin', 'chorus.mjs'),
      ]
    : [
        path.join(prefix, 'bin', 'chorus'),
        path.join(prefix, 'lib', 'node_modules', 'chorus-codes', 'bin', 'chorus.mjs'),
      ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Spawn a chorus subcommand (`stop`, `start`, etc.) using the
 * *just-installed* binary at the resolved prefix, falling back to PATH
 * when no prefix can be determined (dev checkouts).
 *
 * Tolerant flag: when `tolerant: true`, non-zero exits resolve instead
 * of reject. Used by the post-install restart for the `stop` step,
 * where the daemon may have died during the npm install window and
 * `chorus stop` would otherwise abort the restart sequence — leaving
 * the user staring at a "Restarting daemon" header followed by an
 * error. (Self-review finding from 4/6 reviewers on PR #60.)
 *
 * Stdio inherited so the user sees the same output as if they'd run
 * the subcommand directly.
 */
async function runChorusSubcommand(
  args: string[],
  opts: { binaryPath?: string | null; tolerant?: boolean } = {},
): Promise<void> {
  const resolved = opts.binaryPath ?? null;
  const win32 = process.platform === 'win32';
  // .mjs entrypoints need node; the symlink/cmd shim is self-executing.
  const isMjs = resolved !== null && resolved.endsWith('.mjs');
  const command = isMjs ? process.execPath : (resolved ?? (win32 ? 'chorus.cmd' : 'chorus'));
  const spawnArgs = isMjs && resolved ? [resolved, ...args] : args;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, spawnArgs, {
      stdio: 'inherit',
      shell: !isMjs && win32,
    });
    child.on('exit', (code) => {
      if (code === 0 || code === null) resolve();
      else if (opts.tolerant) {
        // Daemon was probably gone already; the subsequent `start`
        // will spawn a fresh one regardless.
        resolve();
      } else {
        reject(new Error(`chorus ${args.join(' ')} exited with code ${code}`));
      }
    });
    child.on('error', (err) => {
      if (opts.tolerant) resolve();
      else reject(err);
    });
  });
}

/**
 * Walk up from the running binary's location to find the npm install
 * prefix. Layout (Linux/macOS):
 *   <prefix>/lib/node_modules/chorus-codes/{dist,bin}/...
 * Layout (Windows):
 *   <prefix>/node_modules/chorus-codes/{dist,bin}/...
 *
 * Returns null when running from a dev checkout (no node_modules
 * ancestor) or when something exotic — caller passes no --prefix and
 * lets npm pick its default.
 */
export function detectNpmPrefix(): string | null {
  const start = __dirname;
  const segments = start.split(path.sep);
  const nmIdx = segments.lastIndexOf('node_modules');
  if (nmIdx === -1) return null;

  const parent = segments.slice(0, nmIdx).join(path.sep);
  // Normalise: on POSIX `lib/node_modules/...`, the prefix is up one
  // more from `lib`. On Windows there's no `lib` segment.
  if (parent.endsWith(path.sep + 'lib') || parent === 'lib') {
    const prefix = parent.slice(0, -('lib'.length + path.sep.length));
    return prefix.length > 0 ? prefix : null;
  }
  return parent;
}

/**
 * Hit the npm registry's lightweight metadata endpoint. The full
 * package metadata is large (~MB), so we use the `/-/package/<name>/dist-tags`
 * endpoint which is a tiny JSON map of tag→version.
 *
 * Returns null on any network error so callers can fall back to a
 * "couldn't check" message instead of crashing.
 */
export async function fetchLatestVersion(
  packageName = 'chorus-codes',
): Promise<string | null> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const res = await fetch(
      `https://registry.npmjs.org/-/package/${packageName}/dist-tags`,
      { signal: ac.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { latest?: string };
    return typeof data.latest === 'string' ? data.latest : null;
  } catch {
    return null;
  }
}

/**
 * SemVer-aware "a > b" comparison. Sufficient for our use case
 * (release tags are always plain semver, no pre-release suffixes
 * shipped on npm latest); a stale comparison just falls back to "no
 * update available" which is the safe default.
 */
export function versionGreater(a: string, b: string): boolean {
  const parse = (v: string): number[] =>
    v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const aa = parse(a);
  const bb = parse(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i += 1) {
    const ai = aa[i] ?? 0;
    const bi = bb[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

/**
 * Pre-flight check before `npm install -g`. Two failure modes worth
 * catching with a friendly message instead of an opaque npm stack:
 *
 *   1. Prefix is on a Windows-mounted drive in WSL (/mnt/<letter>/...).
 *      Windows-side processes hold handles into the install dir and
 *      refuse npm's rename-on-update. Confirmed by user reports —
 *      EACCES every time, even after stopping chorus.
 *   2. Prefix isn't writable by the current user (corporate
 *      /usr/local lockdowns, sudo'd install vs nvm-managed user
 *      prefix).
 *
 * Both have the same remediation: migrate to an unprivileged prefix
 * on the Linux ext4 filesystem.
 */
export function checkPrefixUsable(
  prefix: string,
): { ok: true } | { ok: false; reason: string } {
  // Windows-mounted drive detection. /mnt/c, /mnt/d, etc. — covers
  // the canonical WSL drvfs mount points. /mnt/wsl is internal WSL
  // and not affected, so explicit single-letter match keeps the
  // false-positive rate at zero.
  const lower = prefix.toLowerCase();
  if (/^\/mnt\/[a-z]\//.test(lower) || /^\/mnt\/[a-z]$/.test(lower)) {
    return {
      ok: false,
      reason: `prefix is on a Windows-mounted drive (${prefix}). Windows file handles block npm's rename-on-update.`,
    };
  }

  // Direct write probe in <prefix>/lib/node_modules. node_modules may
  // not exist yet on a fresh prefix; mkdir + write + unlink is the
  // safest test.
  try {
    const targetDir = path.join(prefix, 'lib', 'node_modules');
    fs.mkdirSync(targetDir, { recursive: true });
    const probePath = path.join(
      targetDir,
      `.chorus-update-probe-${process.pid}-${Date.now()}`,
    );
    fs.writeFileSync(probePath, 'probe');
    fs.unlinkSync(probePath);
    return { ok: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      return {
        ok: false,
        reason: `prefix isn't writable by the current user (${code} on ${prefix}/lib/node_modules).`,
      };
    }
    // Other errors (ENOENT on non-existent ancestor, EISDIR weirdness)
    // — let npm try and surface the real cause if our probe was wrong.
    return { ok: true };
  }
}

/**
 * Path of the chorus binary that's currently executing. Used in the
 * start-up version banner so users can verify they're running the
 * binary they think they are — critical when sudo/nvm dual-install
 * has them confused about which copy is in PATH.
 *
 * Source of truth: process.argv[1] is the CLI entrypoint Node was
 * invoked with. Resolve through symlinks because `npm install -g`
 * writes a symlink at <prefix>/bin/chorus pointing into
 * <prefix>/lib/node_modules/chorus-codes/bin/chorus.mjs — the
 * realpath surfaces the install root, which is the actionable bit.
 */
export function resolveChorusBinaryPath(): string | null {
  const entry = process.argv[1];
  if (!entry) return null;
  try {
    return fs.realpathSync(entry);
  } catch {
    return entry;
  }
}

