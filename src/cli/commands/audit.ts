/**
 * `chorus audit <path>` — multi-LLM review of existing production code.
 *
 * The complement to `chorus review` / `/work`. Where review tools assume
 * a PR-shaped diff, audit takes any path (file or directory) and asks
 * the reviewer fleet to critique what's already there. Useful for
 * onboarding chorus on a legacy codebase or auditing a subsystem that
 * was never PR-reviewed.
 *
 * Substrate: existing review-only phase + `artifact` field on /chats.
 * Audit framing lives in the `work` brief; no runner or schema changes.
 */
import type { Command } from 'commander';
import * as path from 'path';
import { isDaemonHealthy, readDaemonInfo } from '../../lib/daemon-discovery.js';
import {
  assembleAuditArtifact,
  AuditPackError,
  buildAuditWork,
  focusParagraph,
  walkAuditPath,
} from '../../lib/audit-pack.js';
import { c, sym } from '../ui.js';

interface AuditOptions {
  scope?: string;
  focus?: string;
  template?: string;
  daemonUrl?: string;
}

const DEFAULT_TEMPLATE = 'review-only';
const VALID_FOCUS = new Set(['security', 'correctness', 'performance', 'maintainability', 'all']);

/**
 * Daemon HTTP timeout. Audit POSTs to /chats with the assembled
 * artifact — if the daemon stalls (libsql lock, OOM, etc.) the CLI
 * should fail fast with a clear message rather than hang. 30s matches
 * the project's "every external call has a timeout" rule.
 */
const DAEMON_FETCH_TIMEOUT_MS = 30_000;

async function runAudit(targetPath: string, opts: AuditOptions): Promise<void> {
  console.log('');
  console.log(`  ${sym.rocket} ${c.bold('chorus audit')} ${c.dim('— multi-LLM review of existing code')}`);
  console.log('');

  // 1. Daemon up?
  const info = readDaemonInfo();
  if (!info) {
    console.log(`  ${c.red('✗')} daemon not running`);
    console.log(`     run ${c.bold('chorus start')} first, then re-run audit`);
    process.exitCode = 1;
    return;
  }
  const healthy = await isDaemonHealthy(info.daemonPort, 1500);
  if (!healthy) {
    console.log(`  ${c.red('✗')} daemon not responding on :${info.daemonPort}`);
    console.log(`     run ${c.bold('chorus stop && chorus start')} to recycle`);
    process.exitCode = 1;
    return;
  }
  const baseUrl = opts.daemonUrl ?? `http://127.0.0.1:${info.daemonPort}`;

  // 2. Validate --focus before doing any filesystem work. A bad
  // --focus value should fail in milliseconds, not after a slow walk.
  const focus = opts.focus ?? 'all';
  if (!VALID_FOCUS.has(focus)) {
    console.log(`  ${c.red('✗')} --focus must be one of: ${[...VALID_FOCUS].join(', ')}`);
    process.exitCode = 1;
    return;
  }

  // 3. Resolve + validate path.
  const rootAbs = path.resolve(process.cwd(), targetPath);
  let files: string[];
  try {
    files = walkAuditPath(rootAbs);
  } catch (err) {
    if (err instanceof AuditPackError) {
      console.log(`  ${c.red('✗')} ${err.message}`);
    } else if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(`  ${c.red('✗')} path not found: ${rootAbs}`);
    } else {
      console.log(`  ${c.red('✗')} ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
    return;
  }

  // 4. Assemble the artifact.
  const scope = opts.scope ?? path.basename(rootAbs);
  const focusPara = focusParagraph(focus);
  let pack;
  try {
    pack = assembleAuditArtifact(rootAbs, files, { scope, focusParagraph: focusPara });
  } catch (err) {
    if (err instanceof AuditPackError) {
      console.log(`  ${c.red('✗')} ${err.message}`);
    } else {
      console.log(`  ${c.red('✗')} ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `  ${c.green('✓')} packed ${c.bold(String(pack.filesIncluded.length))} file${pack.filesIncluded.length === 1 ? '' : 's'} ${c.gray(`(${pack.totalBytes} bytes)`)}`,
  );
  if (pack.filesSkipped.length > 0) {
    console.log(`  ${c.gray('·')} skipped ${pack.filesSkipped.length} (extension / read failure)`);
  }

  // 5. Resolve template — must be review-only kind so audit framing
  // composes. Daemon will reject artifact on full-pipeline templates
  // anyway; this is a friendlier upfront message.
  const templateId = opts.template ?? DEFAULT_TEMPLATE;
  console.log(`  ${c.gray('·')} template: ${c.bold(templateId)}`);

  // 6. Build the audit-framed work brief.
  const work = buildAuditWork(scope, focusPara);

  // 7. Fire the chat. AbortSignal.timeout closes the connection if the
  // daemon hangs — failing fast beats blocking the terminal forever.
  let chatRes: Response;
  try {
    chatRes = await fetch(`${baseUrl}/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        work,
        templateId,
        artifact: pack.artifact,
      }),
      signal: AbortSignal.timeout(DAEMON_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    if (timedOut) {
      console.log(`  ${c.red('✗')} chat create timed out after ${DAEMON_FETCH_TIMEOUT_MS}ms (daemon hung?)`);
    } else {
      console.log(`  ${c.red('✗')} chat create failed: ${msg}`);
    }
    process.exitCode = 1;
    return;
  }

  if (!chatRes.ok) {
    const text = await chatRes.text().catch(() => '');
    console.log(`  ${c.red('✗')} chat create failed: ${chatRes.status} ${text.slice(0, 400)}`);
    if (chatRes.status === 400 && text.includes('review-only')) {
      console.log('');
      console.log(`     ${c.gray('hint: --template must point at a review_only template')}`);
      console.log(`     ${c.gray('the default ')}${c.bold(DEFAULT_TEMPLATE)}${c.gray(' is review_only; full-pipeline templates with a doer slot are not audit-compatible')}`);
    }
    process.exitCode = 1;
    return;
  }

  const chatEnv = (await chatRes.json()) as { data?: { id: string } };
  const chatId = chatEnv.data?.id;
  if (!chatId) {
    console.log(`  ${c.red('✗')} chat create returned no id`);
    process.exitCode = 1;
    return;
  }

  const cockpitUrl = `http://127.0.0.1:${info.cockpitPort}`;
  console.log('');
  console.log(`  ${c.green('✓')} audit fired ${c.gray('(id: ' + chatId + ')')}`);
  console.log(`     watch live: ${c.cyan(`${cockpitUrl}/runs/${chatId}`)}`);
  console.log('');
  console.log(`  ${c.gray('reviewers run in the background — close this terminal and check the cockpit later')}`);
  console.log('');
}

export function registerAuditCommand(program: Command): void {
  program
    .command('audit')
    .description(
      'Multi-LLM review of existing production code. Reads <path>, packs source files, fires a review-only chat.',
    )
    .argument('<path>', 'file or directory to audit')
    .option('--scope <name>', 'human label for the audit scope (defaults to path basename)')
    .option(
      '--focus <area>',
      'audit focus: security | correctness | performance | maintainability | all',
      'all',
    )
    .option('--template <id>', 'override the review-only template used for the fleet', DEFAULT_TEMPLATE)
    .action(async (targetPath: string, options: AuditOptions) => {
      try {
        await runAudit(targetPath, options);
      } catch (err) {
        console.error('audit failed:', err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}

export const _testing = {
  DEFAULT_TEMPLATE,
  VALID_FOCUS,
};
