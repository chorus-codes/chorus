/**
 * CLI Failure Detector
 *
 * Pattern-matches tmux pane snapshots to detect known failure modes from
 * codex/claude/gemini/opencode CLIs. Returns structured CliError events
 * the runner emits as `cli_error` SSE messages.
 */

export type CliErrorKind =
  | 'quota_exhausted'        // codex: "You've hit your usage limit. ... try again at <time>."
  | 'token_refresh_lost'     // codex: "access token could not be refreshed because your refresh token was already used"
  | 'mcp_handshake_failed'   // codex: "failed: handshaking with MCP server failed"
  | 'opencode_db_corrupt'    // opencode: "Provider returned error" repeating with no successful response in last N seconds
  | 'permission_prompt'      // any CLI: "Allow this tool? / Always allow" dialog. Recoverable via shim.recoverKeys (Layer 2 of perm model)
  | 'cold_start_timeout'     // CLI never showed its prompt within cold_start_timeout_s
  | 'tmux_dead'              // session no longer exists per tmux has-session
  | 'unknown';               // catch-all

export interface CliError {
  kind: CliErrorKind;
  lineage: string;           // 'anthropic' | 'openai' | 'google' | 'opencode' | 'moonshot'
  message: string;           // user-friendly one-liner for the run header
  cta?: string;              // recommended action (e.g. 'Re-authenticate codex')
  detail?: string;           // raw line that triggered the match
  resetAt?: number;          // ms-epoch when retry is plausible (quota only)
}

/**
 * Parse human-readable reset time like "Apr 30th, 2026 10:05 PM" to ms-epoch.
 * Returns undefined on parse failure (UI hides the timer in that case).
 */
function parseResetTime(humanTime?: string): number | undefined {
  if (!humanTime) return undefined;
  // Strip ordinal suffixes: "1st" → "1", "2nd" → "2", "3rd" → "3", "4th" → "4", etc.
  const cleaned = humanTime.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
  const t = Date.parse(cleaned);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Per-session state for detecting opencode DB corruption.
 * Tracks error count and timing of last error + success.
 */
interface OpenCodeState {
  errCount: number;
  lastErrAt: number;
  lastSuccessAt: number;
}

/**
 * ErrorDetector — stateful pattern-matching for CLI failure modes.
 *
 * Patterns 1-3 (quota, token-refresh, MCP) are stateless — matched inline.
 * Pattern 4 (opencode DB corruption) is stateful — tracks error frequency.
 *
 * Per-session dedup: the runner polls capture-pane every ~2s, so the same
 * quota text sits in the buffer and would emit on every poll. We track the
 * last-emitted error kind per session and suppress repeats of the same kind
 * until a different kind (or no error) appears.
 */
export class ErrorDetector {
  private openCodeState = new Map<string, OpenCodeState>();
  private lastEmittedKind = new Map<string, CliErrorKind>();

  /**
   * Inspect a tmux pane snapshot for known failure patterns.
   * Returns a CliError if a pattern matched, null otherwise.
   *
   * For opencode_db_corrupt: tracks state internally. Call reset() when
   * the session is killed or restarted to clear per-session counters.
   */
  inspect(sessionName: string, lineage: string, paneText: string): CliError | null {
    const result = this.detect(sessionName, lineage, paneText);
    if (!result) {
      // No error currently visible — clear dedup so a recurring kind
      // (e.g. a *second* permission_prompt after we recovered the first) can
      // re-fire later. Without this, recoverable+recurring events are silently
      // suppressed for the rest of the session.
      this.lastEmittedKind.delete(sessionName);
      return null;
    }

    // Dedup: skip if we already emitted this exact kind for this session.
    // The user's experience: one quota error event per quota event, not 149.
    const lastKind = this.lastEmittedKind.get(sessionName);
    if (lastKind === result.kind) return null;
    this.lastEmittedKind.set(sessionName, result.kind);
    return result;
  }

  /** Inner pattern matcher — see inspect() for the dedup wrapper. */
  private detect(sessionName: string, lineage: string, paneText: string): CliError | null {
    // Pattern 1: Codex quota exhausted
    if (lineage === 'openai') {
      const quotaMatch = /You've hit your usage limit\.[\s\S]*?try again at\s+([^\n.]+)/i.exec(paneText);
      if (quotaMatch) {
        const resetAtStr = quotaMatch[1];
        return {
          kind: 'quota_exhausted',
          lineage,
          message: resetAtStr
            ? `Codex quota exhausted. Resets ${resetAtStr.trim()}.`
            : 'Codex quota exhausted.',
          cta: 'Switch to a different codex account, or wait & retry.',
          resetAt: parseResetTime(resetAtStr),
          detail: quotaMatch[0],
        };
      }

      // Pattern 2: Codex token refresh lost
      if (/access token could not be refreshed/i.test(paneText)) {
        const match = /access token could not be refreshed[^\n]*/i.exec(paneText);
        return {
          kind: 'token_refresh_lost',
          lineage,
          message: 'Codex auth invalidated (token refresh race).',
          cta: 'Re-authenticate codex.',
          detail: match?.[0],
        };
      }

      // Pattern 3: Codex MCP handshake failed
      if (/handshaking with MCP server failed/i.test(paneText)) {
        const match = /handshaking with MCP server failed[^\n]*/i.exec(paneText);
        return {
          kind: 'mcp_handshake_failed',
          lineage,
          message: 'Codex MCP startup failed.',
          cta: 'Re-authenticate codex.',
          detail: match?.[0],
        };
      }
    }

    // Pattern 1b: Anthropic Claude usage limit (Pro/Max subscriptions
    // have rolling 5-hour message caps). Phrasing covers both the
    // older "Claude usage limit reached" and the explicit reset variant.
    if (lineage === 'anthropic') {
      const claudeQuota =
        /(?:Claude (?:AI )?usage limit reached|5-hour (?:message|usage) limit|message limit reached)[\s\S]*?(?:reset|try again)\s*(?:at)?\s*([^\n.]+)?/i.exec(paneText);
      if (claudeQuota) {
        const reset = claudeQuota[1]?.trim();
        return {
          kind: 'quota_exhausted',
          lineage,
          message: reset
            ? `Claude usage limit reached. Resets ${reset}.`
            : 'Claude usage limit reached.',
          cta: 'Switch to a different Claude account, or wait for reset.',
          resetAt: parseResetTime(reset),
          detail: claudeQuota[0].slice(0, 200),
        };
      }
    }

    // Pattern 1c: Gemini RESOURCE_EXHAUSTED — the Google API's standard
    // quota signal across the free tier and paid tiers. Surfaces in the
    // Gemini CLI as either the raw code or the friendlier "Quota exceeded".
    if (lineage === 'google') {
      const geminiQuota =
        /(RESOURCE_EXHAUSTED|429.*Quota exceeded|Quota exceeded for quota metric|"code"\s*:\s*429)/i.exec(paneText);
      if (geminiQuota) {
        return {
          kind: 'quota_exhausted',
          lineage,
          message: 'Gemini quota exhausted (free-tier or daily cap).',
          cta: 'Wait for the daily reset, switch projects, or use a different model.',
          detail: geminiQuota[0].slice(0, 200),
        };
      }
      // ModelNotFoundError — bad model id (e.g. user picked a model that
      // got deprecated). Surface as auth_invalid-equivalent so the run
      // card shows a clear CTA rather than silent 0-byte answer.md.
      if (/ModelNotFoundError|404\s*Not Found.*model/i.test(paneText)) {
        return {
          kind: 'mcp_handshake_failed', // reuses auth_invalid status mapping
          lineage,
          message: 'Gemini rejected the requested model id.',
          cta: 'Pick a different Gemini model on the Connect page.',
        };
      }
    }

    // Pattern 1d: OpenCode-Go subscription out of credits. opencode-go's
    // `/usage` endpoint returns "Out of credits" / "subscription quota
    // exceeded"; the TUI surfaces the same string. Distinct from
    // opencode_db_corrupt (Pattern 4) which is a session-replay failure.
    if (lineage === 'opencode') {
      if (/subscription quota exceeded|Out of credits|insufficient credits/i.test(paneText)) {
        return {
          kind: 'quota_exhausted',
          lineage,
          message: 'OpenCode subscription is out of credits.',
          cta: 'Top up at opencode.ai/billing or switch to a different model.',
          detail: 'opencode-go subscription quota signal in pane.',
        };
      }
    }

    // Pattern 1e: Generic "please log in" auth signal across every
    // interactive CLI we drive. Catches the common phrasings:
    //   - claude: "Please run `claude login`"
    //   - codex:  "Run `codex login` to sign in"
    //   - gemini: "Authentication required" / "gcloud auth"
    //   - opencode: "opencode auth login"
    //   - kimi:   "kimi: not logged in"
    // Done after the per-CLI patterns above so the more-specific
    // detectors (token_refresh_lost, mcp_handshake_failed) take priority.
    // Pattern 1f: Grok-specific subscription-tier check. Must run BEFORE
    // the generic auth-prompt regex below so it doesn't get misclassified
    // as token_refresh_lost. SuperGrok Heavy is a billing-tier failure,
    // not an auth-token-refresh failure — they have different recovery
    // CTAs and route to different health states (quota_exhausted vs
    // auth_invalid). Keeping the patterns separate avoids category
    // ambiguity for future rules that route on `kind` alone.
    if (lineage === 'grok') {
      if (/SuperGrok Heavy subscription required/i.test(paneText)) {
        return {
          kind: 'quota_exhausted',
          lineage,
          message: 'Grok Build requires a SuperGrok Heavy subscription.',
          cta: 'Upgrade at console.x.ai or disable the grok voice in Settings.',
          detail: 'SuperGrok Heavy subscription required',
        };
      }
    }

    // Pattern 3b: Antigravity CLI specific signatures (ordering rule
    // from the integration doc — CLI-specific patterns BEFORE the
    // generic auth-prompt regex so they route to the right `kind`).
    if (lineage === 'antigravity') {
      // Match the same alternations as parseAntigravityExit so the pane-
      // scraper and exit-handler agree on what counts as a quota error
      // (self-review caught the drift between the two).
      if (
        /quota[\s-]?(?:exhausted|exceeded)|rate[\s-]?limit|resource[\s-]?exhausted|\b429\b/i.test(
          paneText,
        )
      ) {
        return {
          kind: 'quota_exhausted',
          lineage,
          message: 'Antigravity (Gemini 3.5 Flash) quota exhausted on your Google AI Pro subscription.',
          cta: 'Wait for the period reset or upgrade your Google AI plan.',
          detail: 'quota_exhausted',
        };
      }
    }

    if (
      lineage === 'anthropic' ||
      lineage === 'openai' ||
      lineage === 'google' ||
      lineage === 'opencode' ||
      lineage === 'moonshot' ||
      lineage === 'grok' ||
      lineage === 'antigravity'
    ) {
      const authPrompt =
        /(?:please (?:run|log\s*in|sign\s*in)|run\s+`?(?:claude|codex|gemini|opencode|kimi|grok|agy)\s+login|to\s+sign\s+in|not logged in|not authenticated|no active session|authentication required|api key (?:invalid|missing|expired|revoked|not (?:found|set))|(?:[A-Z_]+_)?API_KEY\s+(?:environment variable\s+)?not\s+(?:found|set)|Signing in with Grok|Open this URL to sign in|antigravity-oauth-token)/i.exec(
          paneText,
        );
      if (authPrompt) {
        return {
          kind: 'token_refresh_lost', // maps to auth_invalid health status
          lineage,
          message: `${lineage} CLI is asking you to re-authenticate.`,
          cta: 'Re-run the CLI login (e.g. `claude login`, `codex login`, `gemini` interactive setup).',
          detail: authPrompt[0].slice(0, 200),
        };
      }
    }

    // Pattern 4: Opencode DB corruption (stateful)
    // Accept both 'opencode' (current) and 'xai' (legacy alias) lineage tags
    // so older templates / sessions don't silently lose detection.
    //
    // NOTE: must NOT short-circuit when corruption isn't found — the original
    // code returned the corruption result unconditionally and silently masked
    // the permission_prompt detection (Pattern 5) for the entire opencode
    // family. Fall through on null so the dialog detector below can still run.
    if (lineage === 'opencode' || lineage === 'xai') {
      const corruption = this.inspectOpenCodeCorruption(sessionName, paneText);
      if (corruption) return corruption;
    }

    // Pattern 5: Permission prompt — lineage-agnostic.
    //
    // Catches "Always allow" / "Allow this tool?" / approval dialogs across
    // every CLI we drive (opencode, kimi, claude, codex, gemini). Layer 1 of
    // the permission model (config-file pre-approval) makes this rare; this
    // pattern is Layer 2 — defense-in-depth. The runner consults the shim's
    // `recoverKeys.permission_prompt` to navigate the dialog (e.g. opencode
    // needs `['Right', 'Enter']` to pick "Always allow") and emits a
    // `cli_warning` rather than failing the chat.
    //
    // Filtered to interactive CLIs only — sentinel like 'any' has no UI.
    const isInteractiveCli =
      lineage === 'anthropic' ||
      lineage === 'openai' ||
      lineage === 'google' ||
      lineage === 'opencode' ||
      lineage === 'moonshot';
    if (isInteractiveCli) {
      // Lineage-aware matching:
      //
      //   opencode/xai (and moonshot/kimi-standalone, same upstream code):
      //     OpenCode 1.14.x's permission UI is a TWO-STEP dialog. Step 1 has
      //     three buttons in a row ("Allow once   Allow always   Reject");
      //     step 2 is a nested confirm ("△ Always allow … Confirm   Cancel").
      //     Tight regex pinned to the step-1 button row prevents the detector
      //     from re-firing on step 2's "Always allow" heading. That's load-
      //     bearing: the shim's recoverKeys sends `[Right, Enter, Enter]` to
      //     clear BOTH dialogs in one shot; if step 2 also matched here and
      //     a recovery fired against it, `Right` would move the highlight
      //     "Confirm" → "Cancel" and `Enter` would REJECT the command. The
      //     dedup guard at the inspect() layer mostly hides this hazard, but
      //     a single buffer-redraw window where step-2 matches alone can
      //     re-arm it. Solving it at the regex level removes the failure
      //     mode entirely instead of relying on dedup timing.
      //
      //   anthropic/openai/google:
      //     Generic phrasings — Claude's "Approve and run", Codex's "Approve
      //     this call", Gemini's "[a]llow" / "Always allow". Broad regex
      //     keeps the existing coverage; these CLIs don't have the nested-
      //     confirm hazard.
      //
      // Both sub-patterns refuse to match free-form chat content like
      // "approve this PR" by anchoring on TUI markers (the △ glyph, the
      // bracketed letter, or the multi-button row layout).
      const isOpenCodeFamily = lineage === 'opencode' || lineage === 'moonshot';
      const promptMatch = isOpenCodeFamily
        ? /Allow once\s+(?:Always allow|Allow always)\s+Reject/i.exec(paneText)
        : /(\b|△ ?)(Always allow|Allow always|Allow this|Allow once|Approve this call|Approve and run|\[a\]llow)\b/i.exec(paneText);
      if (promptMatch) {
        return {
          kind: 'permission_prompt',
          lineage,
          message: `${lineage} is showing an approval dialog.`,
          cta: 'Runner auto-recovers via shim.recoverKeys; if missing, click "Always allow" manually.',
          detail: promptMatch[0],
        };
      }
    }

    return null;
  }

  /**
   * Stateful opencode detector: tracks "Provider returned error" frequency.
   *
   * Rules:
   * - Increment errCount if "Provider returned error" appears
   * - Reset errCount to 0 if we see "## DONE" (successful completion)
   * - Trigger opencode_db_corrupt when errCount >= 3 AND no success in last 60s
   */
  private inspectOpenCodeCorruption(sessionName: string, paneText: string): CliError | null {
    // Initialize state if first call for this session
    let state = this.openCodeState.get(sessionName);
    if (!state) {
      state = { errCount: 0, lastErrAt: 0, lastSuccessAt: Date.now() };
      this.openCodeState.set(sessionName, state);
    }

    const now = Date.now();

    // Check for successful completion sentinel
    if (/## DONE\b/i.test(paneText)) {
      state.errCount = 0;
      state.lastSuccessAt = now;
      return null;
    }

    // Count "Provider returned error" occurrences in this snapshot
    const errorMatches = paneText.match(/Provider returned error/gi);
    if (errorMatches) {
      state.errCount += errorMatches.length;
      state.lastErrAt = now;
    }

    // Trigger corruption error when:
    // - errCount >= 3 (multiple repeated errors)
    // - AND last success was >60 seconds ago (sustained failure, not transient)
    if (state.errCount >= 3 && now - state.lastSuccessAt > 60000) {
      return {
        kind: 'opencode_db_corrupt',
        lineage: 'opencode',
        message: 'Opencode session DB likely corrupted (Kimi rejecting empty msgs).',
        cta: 'Run `work-fleet-restart kimi deepseek` after wiping ~/.local/share/opencode/opencode.db',
        detail: 'Multiple Provider-returned-error responses in window.',
      };
    }

    return null;
  }

  /**
   * Reset per-session state (call when a session is killed or restarted).
   * Clears the error counter so a fresh retry doesn't auto-trigger on old errors.
   */
  reset(sessionName: string): void {
    this.openCodeState.delete(sessionName);
    this.lastEmittedKind.delete(sessionName);
  }

  /**
   * Periodic cleanup of stale state. Removes sessions idle >maxIdleMs.
   * Call every 5 minutes from the reaper.
   */
  cleanup(maxIdleMs: number): void {
    const now = Date.now();
    for (const [sessionName, state] of this.openCodeState.entries()) {
      const lastActivity = Math.max(state.lastErrAt, state.lastSuccessAt);
      if (now - lastActivity > maxIdleMs) {
        this.openCodeState.delete(sessionName);
      }
    }
  }
}

