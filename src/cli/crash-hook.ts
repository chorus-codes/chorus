/**
 * Crash hook — last-resort uncaught error capture for the CLI.
 *
 * Goals:
 *   1. When the bin entry crashes (uncaught exception or unhandled
 *      rejection), write a single self-contained log file to
 *      ~/.chorus/crashes/<ISO>.log so the user has something concrete
 *      to attach to a bug report.
 *   2. Print a one-line nudge to stderr pointing at the file + the
 *      issues URL. Do NOT dump the full stack — most users panic at
 *      raw stack traces; the file is for the maintainer.
 *   3. NEVER throw from inside the hook — a hook that itself crashes
 *      is the worst failure mode (silently lost diagnostic).
 *
 * Why this lives in its own tiny module:
 *   - Must be installable BEFORE any other import in bin/chorus.mjs so
 *     it catches early-startup crashes (e.g. the Node 25 + Windows
 *     ESM URL scheme issue that motivated this work — bin's
 *     `await import(distEntry)` fails with `Received protocol 'c:'`
 *     before any CLI code runs).
 *   - Therefore can't depend on commander, ui.ts, libsql, or any
 *     compiled module that itself might fail to load.
 *
 * Plain `node:` builtins only — same reason. Module is loaded by the
 * .mjs bin in raw-ESM mode, no tsx, no transpile.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ISSUE_URL = 'https://github.com/chorus-codes/chorus/issues/new';

interface InstallOptions {
  /** Override crash dir. Tests use this; production reads ~/.chorus/crashes. */
  crashDir?: string;
  /** Override stderr writer. Tests capture; production uses process.stderr.write. */
  stderr?: (msg: string) => void;
  /** Override exit. Tests assert; production exits 1 after the hook fires. */
  exit?: (code: number) => void;
  /** Pass the package version through. The hook can't `import { pkg }` —
   *  pkg.ts uses fs+path with __dirname, which means tsx/dist resolution.
   *  bin/chorus.mjs already knows the version implicitly via package.json
   *  in its parent dir; we leave it optional and fall back to "(unknown)". */
  version?: string;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function buildCrashLog(
  err: unknown,
  source: 'uncaughtException' | 'unhandledRejection',
  version: string,
): string {
  const stack =
    err instanceof Error
      ? `${err.name}: ${err.message}\n${err.stack ?? '(no stack)'}`
      : String(err);
  return [
    '# Chorus crash report',
    '',
    `timestamp:    ${new Date().toISOString()}`,
    `source:       ${source}`,
    `chorus:       ${version}`,
    `node:         ${process.versions.node}`,
    `platform:     ${process.platform} ${process.arch}`,
    `argv:         ${process.argv.slice(1).join(' ')}`,
    `cwd:          ${process.cwd()}`,
    `uptime_ms:    ${Math.round(process.uptime() * 1000)}`,
    '',
    '## Error',
    '',
    stack,
    '',
  ].join('\n');
}

function writeCrashFile(dir: string, body: string): string | null {
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${timestamp()}.log`);
    writeFileSync(file, body, { encoding: 'utf-8' });
    return file;
  } catch {
    // mkdir or write failed (read-only home, ENOSPC, ...). The hook
    // must still print SOMETHING useful to stderr — the user's
    // diagnostic value here is "chorus crashed at <stack>", not "we
    // couldn't write a file."
    return null;
  }
}

/**
 * Install crash handlers on process. Idempotent — calling twice is a
 * no-op. We track the registered listeners so `_testing.reset()` (and
 * a hypothetical re-install in production) can detach them, otherwise
 * each test that runs install spawns a new listener and the next
 * uncaughtException fires the cumulative chain N times.
 */
let installed = false;
let activeUncaught: ((err: unknown) => void) | null = null;
let activeUnhandled: ((err: unknown) => void) | null = null;

export function installCrashHook(opts: InstallOptions = {}): void {
  if (installed) return;
  installed = true;

  const crashDir = opts.crashDir ?? join(homedir(), '.chorus', 'crashes');
  const stderr = opts.stderr ?? ((msg: string) => process.stderr.write(msg));
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const version = opts.version ?? '(unknown)';

  const handle = (err: unknown, source: 'uncaughtException' | 'unhandledRejection'): void => {
    const body = buildCrashLog(err, source, version);
    const file = writeCrashFile(crashDir, body);

    const headline =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    stderr('\n');
    stderr(`✗ Chorus crashed (${source}): ${headline}\n`);
    if (file) {
      stderr(`  Crash log saved to: ${file}\n`);
      stderr(`  Please attach it to a new issue: ${ISSUE_URL}\n`);
      stderr('  Or run: chorus diagnose\n');
    } else {
      // File write failed — give the user the stack inline as a
      // last-resort fallback so they have something to paste.
      stderr(`  (could not write crash log to ${crashDir})\n`);
      stderr(`  Please file an issue at ${ISSUE_URL} with this stack:\n`);
      stderr(body + '\n');
    }
    stderr('\n');
    exit(1);
  };

  activeUncaught = (err) => handle(err, 'uncaughtException');
  activeUnhandled = (err) => handle(err, 'unhandledRejection');
  process.on('uncaughtException', activeUncaught);
  process.on('unhandledRejection', activeUnhandled);
}

// Exported for tests.
export const _testing = {
  buildCrashLog,
  writeCrashFile,
  reset: (): void => {
    if (activeUncaught) {
      process.off('uncaughtException', activeUncaught);
      activeUncaught = null;
    }
    if (activeUnhandled) {
      process.off('unhandledRejection', activeUnhandled);
      activeUnhandled = null;
    }
    installed = false;
  },
};
