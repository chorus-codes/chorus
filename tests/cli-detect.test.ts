import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  buildVersionSpawn,
  detectAllClis,
  validateCliPath,
  type CliDetection,
  type DetectableCli,
} from '@/lib/cli-detect';

describe('cli-detect', () => {
  describe('detectAllClis', () => {
    it('returns array of 6 entries (one per DetectableCli)', () => {
      const clis = detectAllClis();
      expect(clis).toHaveLength(6);
    });

    it('each entry has id, found, optional path and source', () => {
      const clis = detectAllClis();
      const expectedIds: DetectableCli[] = [
        'claude-code',
        'codex-cli',
        'gemini-cli',
        'opencode-cli',
        'kimi-cli',
        'grok-cli',
      ];

      clis.forEach((cli: CliDetection) => {
        expect(cli.id).toBeDefined();
        expect(expectedIds).toContain(cli.id);
        expect(typeof cli.found).toBe('boolean');

        if (cli.found) {
          expect(cli.path).toBeDefined();
          expect(typeof cli.path).toBe('string');
          expect(cli.source).toBeDefined();
          expect(['path', 'fallback', 'manual']).toContain(cli.source);
        } else {
          expect(cli.path).toBeUndefined();
          expect(cli.source).toBeUndefined();
        }
      });
    });
  });

  describe('validateCliPath', () => {
    it('returns found:false for nonexistent path', () => {
      const result = validateCliPath('claude-code', '/nonexistent/path/to/claude');
      expect(result.id).toBe('claude-code');
      expect(result.found).toBe(false);
    });

    it('returns found:false for empty/whitespace-only path', () => {
      const result = validateCliPath('codex-cli', '   ');
      expect(result.id).toBe('codex-cli');
      expect(result.found).toBe(false);
    });

    it('returns source:manual when found:true', () => {
      // Depends on system state. validateCliPath uses the basename of
      // the user-pasted path for its name check (e.g. "claude" symlink
      // pointing at a versioned binary like "2.1.126" still validates
      // because the user-facing name is "claude"). We pass the
      // detected path AS-IS — typically a symlink — and expect
      // validation to accept it.
      const clis = detectAllClis();
      const found = clis.find((c) => c.found);

      if (found && found.path) {
        const result = validateCliPath(found.id, found.path);
        expect(result.id).toBe(found.id);
        expect(result.found).toBe(true);
        expect(result.source).toBe('manual');
      }
    });

    it('symlinks: accepts the link, persists the canonical target (TOCTOU defense)', () => {
      // Real-world installs (Homebrew, asdf, mise, npm-global, fnm,
      // volta) ship the user-facing binary as a symlink. Rejecting
      // them outright would break the majority of legit installs.
      // Instead, validateCliPath realpath-resolves and stores the
      // CANONICAL target, so a later swap of the symlink can't
      // redirect daemon spawns to a malicious binary.
      const clis = detectAllClis();
      const found = clis.find((c) => c.found);
      if (!found || !found.path) return;

      // Use the CLI's expected basename so the basename check passes.
      const expectedName = nodePath.basename(found.path);
      const linkDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'chorus-symlink-'));
      const linkPath = nodePath.join(linkDir, expectedName);
      fs.symlinkSync(fs.realpathSync(found.path), linkPath);

      try {
        const result = validateCliPath(found.id, linkPath);
        expect(result.found).toBe(true);
        expect(result.path).toBe(fs.realpathSync(found.path)); // canonical, not the symlink
        expect(result.source).toBe('manual');
      } finally {
        try {
          fs.unlinkSync(linkPath);
          fs.rmdirSync(linkDir);
        } catch {
          /* ignore */
        }
      }
    });
  });

  describe('buildVersionSpawn (issue #32 — Windows .cmd shim spawn)', () => {
    it('returns the bin path unchanged on non-Windows', () => {
      if (process.platform === 'win32') return;
      const spec = buildVersionSpawn('/usr/local/bin/claude');
      expect(spec.cmd).toBe('/usr/local/bin/claude');
      expect(spec.args).toEqual(['--version']);
      expect(spec.shell).toBeUndefined();
    });

    it('returns the bin path unchanged on non-Windows even for .cmd extension', () => {
      // A .cmd file on Linux is not a batch shim — pass through.
      if (process.platform === 'win32') return;
      const spec = buildVersionSpawn('/home/user/funny.cmd');
      expect(spec.cmd).toBe('/home/user/funny.cmd');
      expect(spec.args).toEqual(['--version']);
    });

    // Windows branch — testable on Linux via the isWin parameter.
    it('shell-wraps .cmd with quoted path on Windows so spaces survive', () => {
      // The canonical Windows npm install path contains "Program Files"
      // for some users. Without quoting, cmd.exe splits at the space
      // and looks for `C:\Program` which doesn't exist (issue #32-adjacent).
      const spec = buildVersionSpawn(
        'C:\\Program Files\\nodejs\\npm\\gemini.cmd',
        true,
      );
      expect(spec.shell).toBe(true);
      expect(spec.cmd).toBe('"C:\\Program Files\\nodejs\\npm\\gemini.cmd" --version');
      expect(spec.args).toEqual([]);
    });

    it('shell-wraps .cmd at a normal AppData path', () => {
      // This is the actual path from the #32 report.
      const spec = buildVersionSpawn(
        'C:\\Users\\u\\AppData\\Roaming\\npm\\gemini.cmd',
        true,
      );
      expect(spec.shell).toBe(true);
      expect(spec.cmd).toBe('"C:\\Users\\u\\AppData\\Roaming\\npm\\gemini.cmd" --version');
    });

    it('shell-wraps .bat the same way as .cmd', () => {
      const spec = buildVersionSpawn('C:\\tools\\codex.bat', true);
      expect(spec.shell).toBe(true);
      expect(spec.cmd).toBe('"C:\\tools\\codex.bat" --version');
    });

    it('does NOT shell-wrap .ps1 — PowerShell needs different invocation', () => {
      // cmd.exe /c foo.ps1 only works via file-type association and
      // may be blocked by ExecutionPolicy. Better to fail cleanly than
      // pretend to handle PowerShell scripts. A future PR can add real
      // .ps1 support via `powershell.exe -File`.
      const spec = buildVersionSpawn('C:\\tools\\kimi.ps1', true);
      expect(spec.shell).toBeUndefined();
      expect(spec.cmd).toBe('C:\\tools\\kimi.ps1');
    });

    it('leaves .exe binaries unwrapped on Windows', () => {
      const spec = buildVersionSpawn(
        'C:\\Users\\u\\AppData\\Local\\Programs\\Claude\\claude.exe',
        true,
      );
      expect(spec.shell).toBeUndefined();
      expect(spec.cmd).toBe(
        'C:\\Users\\u\\AppData\\Local\\Programs\\Claude\\claude.exe',
      );
      expect(spec.args).toEqual(['--version']);
    });

    it('leaves extension-less binaries unwrapped on Windows', () => {
      const spec = buildVersionSpawn('C:\\msys64\\usr\\bin\\opencode', true);
      expect(spec.shell).toBeUndefined();
      expect(spec.cmd).toBe('C:\\msys64\\usr\\bin\\opencode');
    });

    it('refuses to shell-wrap paths with metacharacters (shell-injection guard)', () => {
      // A malicious paste like `C:\foo & calc.exe & .cmd` should NOT
      // round-trip through cmd.exe. We fall back to direct exec which
      // fails cleanly with no execution risk.
      const evil = 'C:\\tools\\bar & calc.exe.cmd';
      const spec = buildVersionSpawn(evil, true);
      expect(spec.shell).toBeUndefined();
      // Falls back to the direct branch — spawn will produce ENOENT
      // or null status rather than execute the shell metacharacters.
      expect(spec.cmd).toBe(evil);
      expect(spec.args).toEqual(['--version']);
    });

    it('refuses to shell-wrap paths with quote characters', () => {
      const evil = 'C:\\tools\\foo".cmd';
      const spec = buildVersionSpawn(evil, true);
      expect(spec.shell).toBeUndefined();
    });

    it('refuses to shell-wrap paths with cmd.exe escape character (^)', () => {
      // `^` is cmd.exe's escape — `^"` is a literal quote inside a
      // quoted string, letting an attacker break out of the wrap.
      const evil = 'C:\\tools\\foo^" & calc.exe.cmd';
      const spec = buildVersionSpawn(evil, true);
      expect(spec.shell).toBeUndefined();
    });

    it('refuses to shell-wrap paths with delayed-expansion character (!)', () => {
      // `!` triggers cmd.exe delayed expansion when
      // `setlocal enabledelayedexpansion` is active. A path like
      // C:\foo\!USERNAME!.cmd would expand env vars at execution time.
      const evil = 'C:\\foo\\!COMSPEC!.cmd';
      const spec = buildVersionSpawn(evil, true);
      expect(spec.shell).toBeUndefined();
    });

    it('accepts a Windows path with @-scoped npm package', () => {
      // npm global scoped packages produce paths like
      // C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic\cli\bin.cmd
      // — the blacklist regex must allow `@`.
      const ok = 'C:\\Users\\u\\AppData\\Roaming\\npm\\@scope-foo.cmd';
      const spec = buildVersionSpawn(ok, true);
      expect(spec.shell).toBe(true);
    });
  });
});
