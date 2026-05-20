/**
 * Detect where chorus is running so the CLI can print the right URL hint.
 *
 * The cockpit binds to 127.0.0.1:5050. On a native install that opens fine in
 * the local browser. On remote-dev setups (VSCode/Cursor Remote-SSH,
 * Codespaces, dev containers, plain SSH), the user's browser lives on a
 * different host — they need their editor to forward the port.
 *
 * Detection is best-effort and read-only. We never guess; if no signal is
 * present we report 'native' and let `open()` handle it.
 */

export type RuntimeEnv =
  | 'native'         // Mac/Linux/Windows desktop — localhost works
  | 'wsl'            // WSL2 — Windows host auto-forwards loopback
  | 'vscode-remote'  // VSCode Remote-SSH / WSL / dev container
  | 'cursor-remote'  // Cursor (VSCode fork) Remote-SSH
  | 'codespaces'     // GitHub Codespaces
  | 'ssh';           // Plain SSH session, no editor integration

export interface RuntimeEnvInfo {
  kind: RuntimeEnv;
  /** Hint sentence printed under the URL — empty for native. */
  hint: string;
}

export function detectRuntimeEnv(): RuntimeEnvInfo {
  const env = process.env;

  if (env.CODESPACES === 'true') {
    return {
      kind: 'codespaces',
      hint:
        'Codespaces will auto-forward port 5050. Open the Ports tab and click 5050.',
    };
  }

  // VSCode and Cursor both set VSCODE_IPC_HOOK_CLI when running through
  // their integrated terminal. We tell them apart by the binary name in
  // TERM_PROGRAM (Cursor sets 'cursor', VSCode sets 'vscode').
  if (env.VSCODE_IPC_HOOK_CLI || env.TERM_PROGRAM === 'vscode') {
    const isCursor = env.TERM_PROGRAM === 'cursor' || env.CURSOR_TRACE_ID;
    return {
      kind: isCursor ? 'cursor-remote' : 'vscode-remote',
      hint: `${isCursor ? 'Cursor' : 'VSCode'} should auto-forward 5050 — open the Ports tab in the bottom panel and click "Open in Browser" next to the row for 5050. If you don't see it, click "Forward a Port" and enter 5050.`,
    };
  }

  if (env.WSL_DISTRO_NAME) {
    // WSL2 forwards 127.0.0.1 to the Windows host automatically.
    return {
      kind: 'wsl',
      hint: 'On WSL2, http://localhost:5050 in your Windows browser should just work.',
    };
  }

  if (env.SSH_CONNECTION || env.SSH_TTY) {
    return {
      kind: 'ssh',
      hint:
        'Plain SSH session detected — no auto-forwarding. Either:\n' +
        '    • Run `ssh -L 5050:127.0.0.1:5050 <host>` from your laptop and visit http://localhost:5050, or\n' +
        '    • Use VSCode/Cursor Remote-SSH which forwards ports automatically.',
    };
  }

  return { kind: 'native', hint: '' };
}

/**
 * Should `chorus start --ui` actually try to spawn a browser?
 * On remote-dev hosts there's usually no graphical browser; calling `open()`
 * just emits an `xdg-open` error. Skip it and rely on the printed URL +
 * the editor's own port-forwarding UI.
 */
export function shouldAutoOpenBrowser(env: RuntimeEnvInfo): boolean {
  return env.kind === 'native' || env.kind === 'wsl';
}

/**
 * "Remote-dev" = an editor manages a tunnel to localhost on the user's
 * laptop. VSCode Remote-SSH, Cursor Remote-SSH and Codespaces all cache
 * port→PID bindings in their proxy layer. Plain `ssh -L` is user-managed
 * and doesn't suffer from this — the user owns the lifecycle.
 */
export function isRemoteDevEnv(env: RuntimeEnvInfo): boolean {
  return (
    env.kind === 'vscode-remote' ||
    env.kind === 'cursor-remote' ||
    env.kind === 'codespaces'
  );
}

/**
 * Extra hint to print after a daemon restart on remote-dev hosts.
 *
 * Symptom we're catching: after `chorus stop && chorus start` (or the
 * auto-drift restart in `chorus update`), the editor's port-forward
 * proxy can keep routing :5050 at the *old* dead next-server PID. The
 * browser then shows a blank page or "this site can't be reached" even
 * though `curl localhost:5050` from the same shell works fine — the
 * forwarded socket is bound, just to a corpse.
 *
 * The fix on the user's side is two clicks: open the editor's Ports
 * panel, click the refresh / re-forward button on the 5050 row. We
 * can't trigger that automatically (no editor API), but we CAN nudge
 * the user toward it the moment they're most likely to hit the bug.
 */
export function remoteRestartHint(env: RuntimeEnvInfo): string {
  if (!isRemoteDevEnv(env)) return '';
  const editor =
    env.kind === 'cursor-remote'
      ? 'Cursor'
      : env.kind === 'codespaces'
        ? 'Codespaces'
        : 'VSCode';
  return (
    `If the cockpit URL shows a blank page or "can't reach this site",\n` +
    `    ${editor} is forwarding 5050 to the previous daemon's PID. In the\n` +
    `    Ports panel, click the refresh icon (or "Stop Forwarding" then\n` +
    `    "Forward a Port" → 5050) to rebind to the new daemon.`
  );
}
