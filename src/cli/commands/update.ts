import { spawn } from 'child_process';
import type { Command } from 'commander';
import fs from 'fs';
import path from 'path';
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

        console.log('');
        console.log(
          header(
            sym.ok,
            `Updated to chorus ${latest}`,
            'restart any running daemon: chorus stop && chorus start',
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

