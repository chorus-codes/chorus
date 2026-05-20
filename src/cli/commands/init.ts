import type { Command } from 'commander';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveDbPath, templates } from '../../lib/db/index.js';
import { CHORUS_BIN_PATH } from '../shared.js';
import { c, header, sym } from '../ui.js';

interface ReviewerDetect {
  /** Detected CLI labels (empty when none found and detection succeeded). */
  clis: string[];
  /** True when the detector itself crashed; caller should surface a
   *  distinct warning rather than the regular "no CLIs found" message.
   *  Pre-fix, the crash was masked by returning a fake "(detection
   *  failed)" entry which the success branch then printed as if it
   *  were a real CLI. */
  detectFailed: boolean;
  detectError?: string;
}

/**
 * Detect which reviewer CLIs (claude/codex/gemini/opencode/kimi) are
 * usable on the host. Returns the list of human-friendly names that
 * passed the full detect-and-verify probe. Used by `chorus init` to
 * warn when zero are installed — the cockpit would otherwise look
 * healthy but every run would hang on first dispatch.
 */
async function detectReviewerClis(): Promise<ReviewerDetect> {
  try {
    const { detectAllClis } = await import('../../lib/cli-detect.js');
    const all = detectAllClis();
    const labelMap: Record<string, string> = {
      'claude-code': 'claude',
      'codex-cli': 'codex',
      'gemini-cli': 'gemini',
      'opencode-cli': 'opencode',
      'kimi-cli': 'kimi',
      'grok-cli': 'grok',
      'antigravity-cli': 'agy',
    };
    return {
      clis: all.filter((d) => d.found).map((d) => labelMap[d.id] ?? d.id),
      detectFailed: false,
    };
  } catch (err) {
    return {
      clis: [],
      detectFailed: true,
      detectError: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Detect Claude Code / Codex / Gemini / OpenCode and wire each one.
 * If the user passed `--connect <list>` we only touch those.
 */
async function runOrchestratorAutoConnect(connectFlag?: string): Promise<void> {
  const { autoConnectAll } = await import(
    '../../daemon/orchestrators/index.js'
  );
  const binPath = CHORUS_BIN_PATH;

  type Name =
    | 'claude'
    | 'codex'
    | 'gemini'
    | 'opencode'
    | 'kimi'
    | 'cursor'
    | 'windsurf';
  const ALL_NAMES = [
    'claude',
    'codex',
    'gemini',
    'opencode',
    'kimi',
    'cursor',
    'windsurf',
  ] as const;

  let only: Name[] | undefined;
  if (connectFlag) {
    const wanted = connectFlag.split(',').map((s) => s.trim().toLowerCase());
    only = [];
    for (const w of wanted) {
      if ((ALL_NAMES as readonly string[]).includes(w)) {
        only.push(w as Name);
      } else {
        console.error(
          `Unknown orchestrator '${w}' in --connect. Valid: ${ALL_NAMES.join(', ')}`,
        );
        process.exit(1);
      }
    }
  }

  console.log('');
  console.log(`  ${c.dim('Detecting orchestrators...')}`);

  const result = await autoConnectAll({ binPath, ...(only ? { only } : {}) });

  for (const step of result.steps) {
    if (!step.detected) {
      console.log(
        `  ${c.gray('○')} ${c.gray(step.label.padEnd(14))} ${c.dim('not detected')}`,
      );
      continue;
    }
    if (step.error) {
      console.log(
        `  ${c.yellow('!')} ${c.yellow(step.label.padEnd(14))} ${c.dim(step.error)}`,
      );
      continue;
    }
    const parts: string[] = [];
    if (step.registered) parts.push('MCP registered');
    else parts.push('MCP already registered');
    if (step.toolsAdded > 0) parts.push(`${step.toolsAdded} tool(s) approved`);
    else if (step.name === 'claude') parts.push('all tools approved');
    if (step.slashCommand === 'installed') parts.push('/chorus installed');
    else if (step.slashCommand === 'updated') parts.push('/chorus updated');
    console.log(
      `  ${sym.ok} ${c.bold(step.label.padEnd(14))} ${c.dim(parts.join(' · '))}`,
    );
  }

  if (!result.anyConnected) {
    console.log('');
    console.log(
      `  ${sym.info} ${c.dim('No supported editors found. Connect manually later with')} ${c.bold('chorus connect')}`,
    );
  }
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description(
      'Initialize Chorus: create ~/.chorus/, seed database, register MCP with detected editors',
    )
    .option('--no-register', 'Skip auto-detecting orchestrators')
    .option(
      '--connect <list>',
      'Comma-separated list of CLIs to connect (claude,codex,gemini,opencode,kimi,cursor,windsurf). Default: all detected.',
    )
    .action(async (opts: { register?: boolean; connect?: string }) => {
      try {
        const chorusDir = path.join(os.homedir(), '.chorus');

        console.log('');
        console.log(header(sym.pointer, 'Initializing Chorus...'));
        console.log('');

        if (!fs.existsSync(chorusDir)) {
          fs.mkdirSync(chorusDir, { recursive: true });
          console.log(`  ${sym.ok} ${c.dim('created')} ${chorusDir}`);
        }

        // Seed the DB. resolveDbPath() honours CHORUS_DB_PATH so the
        // line we print matches what the daemon will actually open —
        // hardcoding ~/.chorus/chorus.db here misled users who'd set
        // the env var and then asked "where's my DB?".
        const { getDb } = await import('../../lib/db/index.js');
        await getDb();
        console.log(
          `  ${sym.ok} ${c.dim('database ready at')} ${resolveDbPath()}`,
        );

        // Capture interactive PATH so the daemon can find CLIs in
        // ~/.opencode/bin etc. when it later spawns reviewers from a
        // non-interactive shell. Best-effort: skipped silently when
        // capture fails (CI, no $SHELL, exotic shells we don't model).
        try {
          const { captureInteractivePath, persistCapturedPath } = await import(
            '../../lib/runtime-path.js'
          );
          const captured = captureInteractivePath();
          if (captured) {
            await persistCapturedPath(captured);
            console.log(
              `  ${sym.ok} ${c.dim('captured shell PATH (')} ${captured.split(':').length} ${c.dim('dirs)')}`,
            );
          }
        } catch {
          /* non-fatal — daemon falls back to known-install probes */
        }

        const templatesDir = path.join(__dirname, '..', '..', '..', 'templates');
        if (fs.existsSync(templatesDir)) {
          const files = fs
            .readdirSync(templatesDir)
            .filter((f) => f.endsWith('.yaml'));
          const seeded: string[] = [];

          for (const file of files) {
            const id = file.replace('.yaml', '');
            const yamlPath = path.join(templatesDir, file);
            const yamlContent = fs.readFileSync(yamlPath, 'utf-8');

            const existing = await templates.getById(id);
            if (!existing) {
              await templates.create(id, yamlContent, 'builtin');
              seeded.push(id);
            }
          }
          if (seeded.length > 0) {
            console.log(
              `  ${sym.ok} ${c.dim('seeded templates:')} ${c.cyan(seeded.join(', '))}`,
            );
          } else {
            console.log(
              `  ${sym.ok} ${c.dim('templates already up to date')}`,
            );
          }
        }

        // Auto-detect & register every supported orchestrator. Skipped
        // if user passes --no-register; restricted via --connect <list>.
        if (opts.register !== false) {
          await runOrchestratorAutoConnect(opts.connect);
        }

        // Reviewer-CLI presence check — separate from orchestrator wiring
        // above. Without at least one of claude/codex/gemini/opencode/
        // kimi installed OR an OpenRouter API key configured, Chorus
        // has nothing to dispatch chats to.
        const detect = await detectReviewerClis();
        if (detect.detectFailed) {
          console.log('');
          console.log(
            `  ${c.yellow('!')} ${c.bold(c.yellow('CLI detection crashed:'))} ${detect.detectError ?? 'unknown error'}`,
          );
          console.log(
            c.dim(
              '    Init continued anyway — verify reviewers in Settings → Voices once you start the cockpit.',
            ),
          );
        } else if (detect.clis.length === 0) {
          console.log('');
          console.log(
            `  ${c.yellow('!')} ${c.bold(c.yellow('No AI CLIs detected on this machine.'))}`,
          );
          console.log(
            c.dim('    Chorus needs at least one of these (or an OpenRouter API key):'),
          );
          console.log(c.dim('      claude     — https://docs.anthropic.com/en/docs/claude-code'));
          console.log(c.dim('      codex      — https://github.com/openai/codex'));
          console.log(c.dim('      gemini     — https://github.com/google-gemini/gemini-cli'));
          console.log(c.dim('      opencode   — https://opencode.ai'));
          console.log(c.dim('      kimi       — https://github.com/MoonshotAI/kimi-cli'));
          console.log(c.dim('      grok       — https://x.ai/cli'));
          console.log(
            c.dim('      openrouter — Settings → Voices → Add OpenRouter (uses your API key)'),
          );
          console.log(
            c.dim('    Install at least one CLI, or add an OpenRouter voice after `chorus start`.'),
          );
        } else {
          console.log('');
          console.log(
            `  ${sym.ok} ${c.dim('AI CLIs ready:')} ${c.cyan(detect.clis.join(', '))}`,
          );
        }

        console.log('');
        console.log(header(sym.ok, 'Chorus initialized'));
        console.log('');
        console.log(
          `  ${c.dim('Next:')} ${c.bold('chorus start')} ${c.dim('— bring up the daemon and cockpit.')}`,
        );
        console.log(
          `  ${c.dim('Then restart any editor we just registered (Claude Code, etc.) so it picks up the MCP server.')}`,
        );
        console.log('');
      } catch (error) {
        console.error(`${sym.err} ${c.red('Initialization failed:')}`, error);
        process.exit(1);
      }
    });
}
