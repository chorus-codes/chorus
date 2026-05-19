import { Command } from 'commander';
import fs from 'fs';
import { openBrowser } from './open-browser.js';
import os from 'os';
import path from 'path';
import { resolveCockpitUrl } from '../lib/daemon-discovery.js';
import { registerAuditCommand } from './commands/audit.js';
import { registerDiagnoseCommand } from './commands/diagnose.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerInitCommand } from './commands/init.js';
import { registerQuickstartCommand } from './commands/quickstart.js';
import { registerStartCommand } from './commands/start.js';
import { registerStatusCommand } from './commands/status.js';
import { registerStopCommand } from './commands/stop.js';
import { registerUpdateCommand } from './commands/update.js';
import { detectRuntimeEnv, shouldAutoOpenBrowser } from './runtime-env.js';
import { pkg } from './shared.js';
import { c, sym, tip } from './ui.js';

const program = new Command();

program
  .name('chorus')
  .description('Driver-agnostic multi-LLM peer review for code decisions')
  .version(pkg.version);

// Show a quick-start banner before the standard help so first-time
// users see the setup sequence even when npm's global install hides
// postinstall stdout. State-aware: chorus.db is the marker — dir alone
// is not enough, an empty ~/.chorus can exist from a prior aborted
// install.
program.addHelpText('beforeAll', () => {
  const chorusDir = path.join(os.homedir(), '.chorus');
  const dbFile = path.join(chorusDir, 'chorus.db');
  const daemonPid = path.join(chorusDir, 'daemon.pid');
  const initialised = fs.existsSync(dbFile);
  const running = fs.existsSync(daemonPid);

  if (!initialised) {
    return [
      '',
      `  ${sym.rocket} ${c.bold('Welcome to Chorus')} ${c.dim('— two commands to get going:')}`,
      '',
      `    ${c.cyan('1.')} ${c.bold('chorus init')}     ${c.dim('register MCP with your editors + seed templates + detect CLIs')}`,
      `    ${c.cyan('2.')} ${c.bold('chorus start')}    ${c.dim('bring up the daemon + cockpit')}`,
      '',
    ].join('\n');
  }
  if (!running) {
    return [
      '',
      `  ${sym.pointer} ${c.bold('Daemon is stopped.')} ${c.dim('Bring it back up:')}`,
      '',
      `    ${c.bold('chorus start')}`,
      '',
    ].join('\n');
  }
  return '';
});

registerInitCommand(program);
registerStartCommand(program);
registerStopCommand(program);
registerStatusCommand(program);
registerDoctorCommand(program);
registerDiagnoseCommand(program);
registerUpdateCommand(program);
registerQuickstartCommand(program);
registerAuditCommand(program);

program
  .command('ui')
  .description('Open the Chorus web UI in default browser')
  .action(async () => {
    try {
      const env = detectRuntimeEnv();
      const cockpitUrl = await resolveCockpitUrl();
      console.log('');
      console.log(`   ${c.gray('Open')}  ${c.cyan(cockpitUrl)}`);
      if (env.hint) {
        console.log('');
        console.log(tip(env.hint));
      }
      console.log('');
      if (shouldAutoOpenBrowser(env)) {
        await openBrowser(cockpitUrl);
        console.log(`\nOpening ${cockpitUrl}...`);
      }
    } catch (error) {
      console.error('Failed to open browser:', error);
      process.exit(1);
    }
  });

program
  .command('connect [orchestrator]')
  .description(
    'Pre-approve all Chorus MCP tools in your orchestrator (default: claude)',
  )
  .action(async (orchestrator?: string) => {
    const { runConnect } = await import('./connect.js');
    runConnect(orchestrator);
  });

program
  .command('mcp')
  .description('Run the MCP server on stdio (for orchestrators)')
  .action(async () => {
    // Hand off stdio to the MCP server. This call never returns under
    // normal operation — the orchestrator (Claude Code, Codex, Cursor)
    // holds the pipe open and pumps JSON-RPC messages until it shuts
    // the child down.
    await import('../mcp/index.js');
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
