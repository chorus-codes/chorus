/**
 * OpenCode agent shim (Kimi/DeepSeek via OpenCode Go plan).
 * Single-line prompts, plain text paths (see feedback_gemini_multiline_prompts.md).
 * Always /clear between rounds (see feedback_opencode_clear_always.md).
 * Never lead with `/` (slash-command) or `@` (file-attach popup).
 */

import type {
  AgentShim,
  AgentSpawnOptions,
  AgentNudgeOptions,
  HeadlessSpawnOptions,
  AgentEvent,
} from './types.js';
import { quotePath, validateValue } from './quote.js';
import { spawnHeadless } from '../headless.js';
import { parseOpencode, parseOpencodeExit } from './parsers/index.js';
import { assertSandboxSupported, sandboxFailClosed } from './sandbox-guard.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Wrap a command in a PTY using `script` so the child sees stdout as a TTY.
 *
 * Why opencode needs this: opencode 1.14.x's `run --format json` calls
 * isatty(stdout) before emitting any output. When stdout is a pipe (which
 * is always true under our spawnHeadless path), it produces zero bytes —
 * the model still runs to completion (visible in opencode's debug log)
 * but nothing reaches our parser. PTY wrapping is the only known fix
 * short of upstream patching opencode.
 *
 * Cross-platform notes:
 *   - Linux (util-linux script ≥2.39): `script -qfec "<quoted>" /dev/null`
 *     -q suppresses header/footer, -f flushes after every write (no JSON
 *     buffering), -e forwards the child's exit code so cli_failed
 *     detection still works, -c runs a single command instead of a shell.
 *   - macOS (BSD script): `script -q /dev/null <cmd> <args...>` — the
 *     command is positional, no -c, no -f (BSD script always flushes).
 *   - Anywhere else (Windows, missing `script`): pass through unwrapped.
 *     The reviewer runner's "no events at all" safety net (added in the
 *     same fix) will surface a `## REVIEWER FAILED · no_output` instead
 *     of a silent 0-byte answer.
 */
export function wrapWithPty(
  cmd: string,
  args: readonly string[],
): { command: string; args: string[] } {
  const platform = os.platform();
  if (platform === 'linux') {
    // Shell-quote each arg; util-linux script -c parses the string with shell rules.
    const quoted = [cmd, ...args]
      .map((a) => `'${a.replace(/'/g, `'\\''`)}'`)
      .join(' ');
    return { command: 'script', args: ['-qfec', quoted, '/dev/null'] };
  }
  if (platform === 'darwin') {
    return { command: 'script', args: ['-q', '/dev/null', cmd, ...args] };
  }
  return { command: cmd, args: [...args] };
}

export const opencodeShim: AgentShim = {
  lineage: 'opencode',
  name: 'opencode-cli',

  // clearKeys are sent by the runner via mgr.sendKeys() before nudging.
  // Pattern: Escape twice to dismiss overlays, then /clear + Enter.
  clearKeys: ['Escape', 'Escape', '/clear', 'Enter'] as const,

  // Auto-recovery for OpenCode's permission dialog (bash command, file read,
  // subagent spawn — same dialog shape, different triggers).
  //
  // OpenCode 1.14.x shows a TWO-STEP dialog when the user picks "Allow always":
  //   1. First dialog (3 buttons, default = leftmost "Allow once"):
  //          Allow once   Allow always   Reject
  //      → `Right` moves the highlight from "Allow once" to "Allow always".
  //      → `Enter` confirms and pops the second dialog.
  //   2. Nested confirm (2 buttons, default = leftmost "Confirm"):
  //          △ Always allow
  //          This will allow the following patterns until OpenCode is restarted:
  //          - cat *
  //          Confirm   Cancel
  //      → `Enter` confirms (default selection is "Confirm"). Dialog dismisses.
  //
  // Earlier `[Right, Enter]` only cleared step 1; step 2 sat there forever, the
  // detector's dedup suppressed re-emission of `permission_prompt` (same kind),
  // and the reviewer phase eventually timed out with no answer. Worse: if the
  // dedup ever cleared (e.g. pane redraw scrolled "Always allow" off-screen)
  // and a fresh recovery fired on dialog 2, `Right` would move "Confirm" →
  // "Cancel" and `Enter` would REJECT the command. This sequence sends all
  // three keys atomically via a single `tmux send-keys` call — bubbletea
  // queues them and processes one at a time, so even if dialog 2 hasn't
  // rendered yet when the third Enter arrives, it's queued and consumed when
  // the input loop next polls.
  //
  // Same dialog shape covers every recoverable opencode prompt we've seen
  // (git diff, Read on external path, Task subagent spawn). If a future
  // opencode reorders buttons or adds a step 3, this sequence may fail
  // safely (extra Enters land as harmless newlines in chat input) — phase
  // timeout will catch it. See error-detector.ts for the matching narrowed
  // regex that prevents false-positives on the nested step-2 heading.
  recoverKeys: {
    permission_prompt: ['Right', 'Enter', 'Enter'] as const,
  },

  buildLaunchCommand(opts: AgentSpawnOptions): string {
    validateValue('model', opts.model);

    // Fail-closed when the user requested strict sandbox: the opencode
    // CLI doesn't expose a read-only flag we can map to. Pre-fix we
    // silently spawned anyway and the "Strict" label became decorative
    // for any opencode-routed reviewer (Audit D1 BLOCKER). Throwing
    // here surfaces in the runner as a `cli_error` with an actionable
    // message; the user can switch to a lineage that supports strict
    // (claude / codex / gemini) or fall back to workspace.
    assertSandboxSupported(opts.sandbox, 'opencode');

    const cwd = quotePath(opts.cwd);
    let cmd = `cd ${cwd} && opencode`;

    if (opts.model) {
      cmd += ` --model ${opts.model}`;
    }

    return cmd;
  },

  formatPrompt(opts: AgentNudgeOptions): string {
    // CRITICAL: Single-line only. Never lead with `/` or `@`.
    // Plain text path reference: "at /abs/path" form.
    const sentinel = opts.expectDoneSentinel ? ' End with ## DONE.' : '';

    return (
      `Open the file at this absolute path using your read tool: ${opts.promptFile} ` +
      `— follow the <ask> block, write your full answer to ${opts.answerFile}.${sentinel}`
    );
  },

  /**
   * Headless mode (`opencode run --format json "<tiny argv> @prompt.md"`).
   *
   * OpenCode `run` is one-shot — emits a single JSON blob at the end with
   * the final message. parseOpencode returns [] on every line; the on-exit
   * handler parses the full blob into a message_done event. Heartbeat is on
   * so the UI shows the agent is alive during the silent run.
   *
   * Argv-overflow guard: opencode's `run` only accepts the prompt as a
   * positional argv (no stdin support — verified 2026-05-02 with `opencode
   * run --help`). For chorus self-reviews on real PR diffs the prompt
   * crosses 100KB and shell-quoting / ARG_MAX bites. Workaround mirrors
   * the tmux path: write the prompt to `<cwd>/prompt.md` and pass a tiny
   * directive on argv telling opencode to read that file using its read
   * tool. The chat dir is always the cwd, so the relative path resolves
   * inside opencode's allowed workspace.
   */
  runHeadless(opts: HeadlessSpawnOptions): AsyncIterable<AgentEvent> {
    // Same fail-closed gate as the tmux path. See buildLaunchCommand
    // above for rationale. Returns a single-shot async iterable that
    // yields one error event so the runner records cli_error and the
    // cockpit shows the user a clear "switch lineage" message instead
    // of pretending the run completed normally.
    const sandboxError = sandboxFailClosed(opts.sandbox, 'opencode');
    if (sandboxError) return sandboxError;

    // Sidestep both ARG_MAX and shell-escape pitfalls by stashing the prompt
    // on disk. The chat dir already exists (the runner creates it before
    // spawning), so this never fails on first call.
    const promptPath = path.join(opts.cwd, 'prompt.md');
    fs.writeFileSync(promptPath, opts.promptText, 'utf-8');

    // CRITICAL: Single-line message. Never lead with `/` or `@`.
    // Plain text path reference matches the tmux formatPrompt pattern.
    // Don't tell opencode to write answer.md — the runner captures stdout
    // JSON via parseOpencodeExit and writes the file itself; a tool-side
    // write would race with the runner's clobber on message_done.
    const directive =
      `Open the file at this absolute path using your read tool: ${promptPath} ` +
      `— follow the instructions inside exactly and respond with your full answer in this conversation, ending with ## DONE.`;

    const opencodeArgs = ['run', '--format', 'json'];
    if (opts.model) opencodeArgs.push('--model', opts.model);
    opencodeArgs.push(directive);

    // PTY wrapping is non-optional: opencode 1.14.x's `run --format json`
    // checks isatty(stdout) and refuses to emit JSON when stdout is a pipe.
    // The headless path here always pipes stdout (spawn child_process), so
    // without a PTY the child runs the model to completion (visible in the
    // opencode log under `service=bus type=message.part.delta publishing`)
    // but never writes a single byte to our pipe. The watcher then sees an
    // empty stream, no message_done, no error — answer.md ends up 0 bytes
    // and the reviewer card renders "errored — didn't produce any output".
    //
    // util-linux `script -qfec "<cmd>" /dev/null` allocates a PTY on stdout
    // for the wrapped command; -q suppresses script's header/footer; -f
    // flushes after every write so JSON-Lines arrive in real time; -e
    // forwards the child exit code so cli_failed detection still works.
    // Header/footer are absent under -q, so parseOpencode (which already
    // tryJson's every line and discards non-JSON) needs no change.
    const { command, args } = wrapWithPty('opencode', opencodeArgs);

    const run = spawnHeadless({
      command,
      args,
      cwd: opts.cwd,
      parseLine: parseOpencode,
      onExit: (fullStdout) => parseOpencodeExit(fullStdout),
      cli: 'opencode',
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
      heartbeat: true, // one-shot — heartbeat keeps UI alive
    });

    return run.events;
  },

  estimateCostUsd(): number {
    // OpenCode Go subscription plan (Kimi/DeepSeek), not per-call API
    return 0;
  },

  // Opencode-go's gateway has two well-documented transient failure
  // modes that look terminal at the runner layer:
  //   - empty-stdout exit: subprocess exits 0 with no output -> the
  //     runner synthesises kind:'no_output' (universally terminal),
  //     but for opencode-go a second attempt typically succeeds with
  //     the same prompt (gateway boot race).
  //   - events-but-no-content: subprocess emits progress/tool events
  //     then closes without a message_done and without any error
  //     event -> kind stays undefined, content is empty.
  // Both should be retried once. The original PR #87 attempted to
  // address the second case with a lineage dispatch in the central
  // classifier; the no_output case slipped through because no_output
  // is in the universal terminal list. Moved here as part of the
  // shim-owned retry refactor (PR #87 self-audit follow-up).
  retryPolicy: {
    onNullKind: true,
    onNoOutput: true,
  },
};
