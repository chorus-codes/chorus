/**
 * Pre-spawn hooks: prepare each CLI's local config so it doesn't stop on
 * first-launch interactive prompts that would block the runner.
 *
 * Currently handles:
 *   - Claude Code: ~/.claude.json projects.<cwd>.hasTrustDialogAccepted = true
 *   - Codex CLI: <CODEX_HOME>/config.toml [projects."<cwd>"] trust_level = "trusted"
 *
 * Gemini and OpenCode have auth-on-first-launch flows we can't paper over with
 * config; the user sets those up once during onboarding.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Pre-suppress every Claude Code first-launch prompt that would block a
 * spawned doer/reviewer. Currently:
 *   - projects.<cwd>.hasTrustDialogAccepted (workspace trust dialog)
 *   - hasCompletedClaudeInChromeOnboarding (top-level "Claude in Chrome (Beta)" splash)
 *
 * Add new keys here as Claude Code releases new one-time popups. Each fix is
 * a small global tax we pay once, vs. one stuck-doer per missed splash.
 *
 * Idempotent. Returns early if config is corrupt rather than wiping it.
 */
export function preTrustClaudeWorkspace(cwd: string): void {
  const configPath = path.join(os.homedir(), '.claude.json');
  let config: Record<string, unknown> = {};

  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      config = JSON.parse(raw);
    } catch {
      // Corrupt config — skip rather than wipe the user's file.
      return;
    }
  }

  const projects = (config.projects && typeof config.projects === 'object'
    ? (config.projects as Record<string, Record<string, unknown>>)
    : {});

  const existing = projects[cwd] ?? {};
  const trustOk = existing.hasTrustDialogAccepted === true;
  const chromeOk = config.hasCompletedClaudeInChromeOnboarding === true;
  if (trustOk && chromeOk) return; // nothing to write

  projects[cwd] = {
    ...existing,
    hasTrustDialogAccepted: true,
  };

  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        ...config,
        projects,
        hasCompletedClaudeInChromeOnboarding: true,
      },
      null,
      2,
    ),
    'utf-8',
  );
}

/**
 * Mark `cwd` as trusted in <CODEX_HOME>/config.toml so Codex skips its
 * trust prompt. Appends a [projects."<cwd>"] block if missing.
 */
export function preTrustCodexWorkspace(codexHome: string, cwd: string): void {
  const configPath = path.join(codexHome, 'config.toml');
  let body = '';

  if (fs.existsSync(configPath)) {
    body = fs.readFileSync(configPath, 'utf-8');
  } else {
    fs.mkdirSync(codexHome, { recursive: true });
  }

  // TOML basic strings (double-quoted) interpret \U/\u as unicode escapes.
  // Windows paths like "C:\Users\..." trip "too few unicode value digits"
  // when codex parses its config. Both Codex and Node accept forward slashes
  // on Windows, so we normalize at write time.
  const normalizedCwd = cwd.replace(/\\/g, '/');
  const marker = `[projects."${normalizedCwd}"]`;
  if (body.includes(marker)) return; // already present

  const block = `\n${marker}\ntrust_level = "trusted"\n`;
  fs.writeFileSync(configPath, body + block, 'utf-8');
}
