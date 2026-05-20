# Integrating a new CLI into Chorus

This is the checklist for adding a CLI to Chorus's detection, onboarding, and (optionally) reviewer-dispatch surfaces. Written 2026-05-15 from real integration experience adding **Grok Build** (xAI, detection-only) on top of the existing 5-CLI fleet (Claude Code, Codex, Gemini, OpenCode, Kimi).

## TL;DR

A CLI can participate in chorus at three levels of depth. **Pick the deepest level you can verify**:

| Level | Scope | What it enables |
|---|---|---|
| **1. Detection** | `cli-detect.ts`, onboarding picker, /connect card, `chorus diagnose`, `chorus init` | UI shows the CLI is installed; user can wire it. **No dispatch.** |
| **2. Consumer-only** | Level 1 + orchestrator with no-op `connect()` that points at an existing MCP wire | The CLI can call chorus tools (via its own MCP loader). chorus does NOT dispatch to it. |
| **3. Full reviewer** | Level 2 + shim, lineage enum sweep, voices seed, error-detector signatures | Chorus dispatches to this CLI as a doer/reviewer. |

Grok Build landed at level 2 (consumer-only — it auto-picks chorus from `~/.claude.json`). Claude/Codex/Gemini/OpenCode/Kimi are all level 3.

---

## Level 1 — Detection

The minimum to make the CLI visible to users.

### 1.1 Add the id and binary name

`src/lib/cli-detect.ts` — extend the `DetectableCli` union and the `BINARY_NAME` map:

```ts
export type DetectableCli =
  | 'claude-code'
  // ...
  | 'grok-cli';

const BINARY_NAME: Record<DetectableCli, string> = {
  // ...
  'grok-cli': 'grok',
};
```

### 1.2 Add the CLI's installer fallback dir

If the CLI installs to a non-PATH location by default (Grok uses `~/.grok/bin`, OpenCode uses `~/.opencode/bin`, Kimi uses `~/.kimi/bin`), add it to `fallbackPaths()`:

```ts
if (cli === 'grok-cli') {
  dirs.push(path.join(HOME, '.grok', 'bin'));
}
```

### 1.3 Add a CLI signature regex

`CLI_SIGNATURES` matches the CLI's `--version` output. Prefer a name token (`/\bclaude\b/i`) over the bare-version regex when the CLI prints its name.

```ts
const CLI_SIGNATURES: Record<DetectableCli, RegExp> = {
  // ...
  'grok-cli': /\bgrok\b/i,
};
```

### 1.4 Extend `CliId` in `cli-paths.ts`

Same union, plus `ALL_CLI_IDS` array. This is what `chorus diagnose` and the manual-path UI use to store user-supplied binary locations.

### 1.5 Update the count assertion in tests

`tests/cli-detect.test.ts`:

```ts
expect(clis).toHaveLength(6); // was 5
```

And add the new id to `expectedIds`.

### 1.6 Add to onboarding helpers

`src/app/onboarding/helpers.ts` — extend the `CLIS` array and `manualBinaryName()` switch.

### 1.7 Update label/version maps used by CLI commands

- `src/cli/commands/init.ts` — the `labelMap` and the "AI CLIs ready" docs hint
- `src/cli/commands/doctor.ts` — the `labelMap` in `printReport()`

### 1.8 Verify end-to-end (Level 1 done)

```bash
pnpm typecheck
pnpm test
pnpm build:server
node bin/chorus.mjs stop && node bin/chorus.mjs start
node bin/chorus.mjs diagnose | grep grok      # should show smoke result
node bin/chorus.mjs init | grep grok          # should appear in CLI list
```

---

## Level 2 — Consumer-only orchestrator

For CLIs that can use chorus as an MCP client but can't (or shouldn't) be dispatched to as a reviewer. Cursor, Windsurf, and Grok Build are all level 2.

### 2.1 Add the orchestrator name

`src/daemon/orchestrators/shared.ts`:

```ts
export type OrchestratorName =
  | 'claude'
  // ...
  | 'grok';
```

### 2.2 Create the orchestrator file

`src/daemon/orchestrators/<name>.ts`. Follow the pattern in `grok.ts`:

```ts
function get<Name>Status(): OrchestratorStatus {
  const detected = fs.existsSync(BIN_PATH) || fs.existsSync(CONFIG_DIR);
  const connected = detected && hasChorusInClaudeJson();   // or its own config
  return {
    name: 'grok',
    label: 'Grok Build',
    connected,
    approvedTools: connected ? 1 : 0,
    totalTools: 1,
    note: connected
      ? '<happy-path message>'
      : '<how to get connected>',
    supported: detected,
    firstCallBehavior: 'inherits_global',
  };
}

export const grokOrchestrator: OrchestratorDefinition = {
  name: 'grok',
  label: 'Grok Build',
  getStatus: get<Name>Status,
  detect: () => fs.existsSync(BIN_PATH) || fs.existsSync(CONFIG_DIR),
  connect: async (_opts: ConnectOpts) => {
    // For an auto-pickup CLI, return without doing the JSON write —
    // just verify the source-of-truth (~/.claude.json) has chorus.
    if (!hasChorusInClaudeJson()) {
      throw new Error('Run `chorus connect claude` first — Grok reads from there.');
    }
    return {
      registered: false,
      toolsAdded: 0,
      slashCommand: 'skipped' as const,
      full: {
        added: [],
        alreadyPresent: ['mcpServers.chorus (via ~/.claude.json)'],
        configPath: path.join(os.homedir(), '.claude.json'),
        slashCommand: 'skipped' as const,
        slashCommandPath: '',
      },
    };
  },
};
```

For CLIs that DO need their own MCP config file (Kimi writes `~/.kimi/mcp.json`, Codex writes `~/.codex/config.toml`), follow `kimi.ts` / `codex.ts` — they shell out to `<cli> mcp add ...`.

### 2.3 Register in the orchestrators index

`src/daemon/orchestrators/index.ts` — import + push to the `ORCHESTRATORS` array.

### 2.4 Wire into the connect page

`src/app/connect/page.tsx` — extend `ORCHESTRATOR_TO_PROVIDER`:

```ts
const ORCHESTRATOR_TO_PROVIDER: Record<string, string> = {
  // ...
  grok: "grok-cli",
};
```

### 2.5 Quickstart filter

`src/cli/commands/quickstart.ts` — the `cliToLineage` map only includes CLIs with shims. Adding to detection alone is fine here; quickstart will skip the new CLI (filter is `cliToLineage[d.id] !== undefined`).

### 2.6 Verify Level 2

```bash
curl -sf http://127.0.0.1:7707/orchestrators | jq '.data.items[] | select(.name == "grok")'
# expect: connected: true, supported: true (assuming claude is wired)

node bin/chorus.mjs init | grep -A1 "Grok"
# expect: "MCP already registered" (when claude has chorus wired)
```

Open `/connect` in the browser — the Grok card should appear.

> ⚠ **Skipping 2.1–2.4 is the most common integration miss.** A CLI can pass detection (Level 1) and even ship a working shim + voice seed (Level 3) while remaining invisible on the Home page Reviewer Fleet panel because `/orchestrators` doesn't know about it. The `chorus doctor` output shows the CLI as detected; `/voices` shows the voice seeded; but the Home card doesn't render. Always verify the curl above before declaring an integration done. (PR #62 antigravity hit this — see the v0.8.50 fix.)

---

## Level 3 — Full reviewer (shim)

For CLIs you want to dispatch TO as a doer/reviewer. **Do not skip the empirical probe** — without verified `-p` headless invocation, the shim will silently fail at runtime.

### 3.1 Verify headless invocation

The CLI must support **single-prompt mode**:

```bash
<cli> -p "what is 2+2"        # claude / gemini / kimi / grok pattern
<cli> --single "what is 2+2"  # grok alias
```

It must:
- Exit with code 0 on success, non-zero on failure
- Print the answer to stdout
- Honour a `--model <id>` flag
- **Auto-approve tool executions** via a `--yolo` / `--dangerously-skip-permissions` / `-y` / `--approval-mode auto_edit` flag. Without this, the CLI will hang on tool-approval prompts that have no TTY in headless mode.
- **Cap agentic turns** — `--max-turns 1` (Grok) or equivalent. Reviewer slots are single-shot; without a cap, a multi-turn loop can burn subscription quota or produce non-deterministic output.
- Optionally support `--output-format json|streaming-json` for structured output. NDJSON is easiest to parse safely (one event per line, line-buffered by `spawnHeadless`).

The auto-approval flag list, by CLI:

| CLI | Headless auto-approval flag |
|---|---|
| Claude Code | `--dangerously-skip-permissions` |
| Codex | `-y` / `--yolo` |
| Gemini | `--approval-mode auto_edit` (NEVER `--yolo` — see `feedback_gemini_yolo_dangerous.md`) |
| OpenCode | (via per-tool approval config) |
| Kimi | `--dangerously-skip-permissions` (Claude-compatible) |
| Grok Build | `--yolo` |

If your CLI doesn't have a single-prompt mode, doesn't support a model flag, or can't auto-approve tools, **fall back to consumer-only (Level 2)** — don't try to fake it.

### 3.1.1 Probe the unauthenticated failure path

This is the single most important verification you do without a paid subscription. Run the CLI without credentials and capture exactly what it prints — that's what `error-detector.ts` and `parseXExit` will pattern-match on.

```bash
# Wipe local auth then run
mv ~/.<cli>/auth.json ~/.<cli>/auth.json.bak 2>/dev/null
<cli> -p "hi" --output-format json 2>&1 | tee /tmp/<cli>-noauth.txt
mv ~/.<cli>/auth.json.bak ~/.<cli>/auth.json
```

Then look for:
- A pattern in stderr that identifies the auth/quota state (e.g. `"403 Forbidden"`, `"SuperGrok Heavy subscription required"`)
- Whether the CLI tries to spawn a browser flow (`"Open this URL to sign in"`) — if yes, the daemon **must** precheck-block before spawn (§3.2 below)
- The structured-error event shape (e.g. `{"type":"error","message":"..."}` for Grok streaming-json)

ANSI escape sequences will be in stderr — strip with `/\x1b\[[0-9;]*m/g` before pattern matching.

### 3.2 Auth precheck — dual-gate pattern (mandatory for OAuth-flow CLIs)

If the CLI launches a browser OAuth flow when invoked without credentials, **chorus must precheck-block before spawn** or the daemon's headless dispatch will hang forever.

The pattern (proven on Grok PR #46):

1. **File probe** — `CRED_PATHS[<lineage>]` returns one or more paths under `~/.<cli>/`. Precheck checks `fs.existsSync` for each.
2. **Env-var override** — if the CLI accepts `<CLI>_API_KEY` for CI use, add a branch in `precheckLineage`:
   ```typescript
   if (lineage === '<lineage>' && process.env.<CLI>_API_KEY) {
     return { ok: true };
   }
   ```
3. **Both gates fall through** → return `{ ok: false, reason: 'auth_missing', cta: LOGIN_HINT[lineage] }`. Spawn never happens.

Existence-only is sufficient. Validating that the token isn't expired requires spawning the CLI (the "spawn tax" precheck is designed to avoid). Token-expired then gets caught at runtime by the error-detector / exit parser as `auth_invalid` or `quota_exhausted` → voice auto-disables. Three-layer coverage (env → file → runtime) handles every failure mode.

### 3.2 Add a shim

`src/daemon/agents/<name>.ts` — implement the `AgentShim` interface. For HTTP-dispatched (OpenAI-compatible) shims, copy `local.ts` or `openrouter.ts`. For tmux/headless CLI shims, copy `claude.ts` or `gemini.ts`.

Key responsibilities:
- `buildLaunchCommand(opts)` — for tmux mode (single-line + `%q`-quoted args)
- `runHeadless(opts)` — async generator yielding `AgentEvent` (text_delta, message_done, error)
- `estimateCostUsd(input, output, model?)` — best-effort cost model

### 3.3 Lineage enum sweep (the painful part)

Every union and `Record<Lineage, T>` map needs the new lineage. Missing one = TypeScript error at the unused branch + runtime confusion when that lineage is selected. **The list below is the actual full sweep — verified against the Grok L3 integration (PR #46), which touched 14 lineage-typed declarations.**

**Daemon-side types and registries:**
- `src/daemon/agents/types.ts` — `Lineage` union
- `src/daemon/agents/index.ts` — `SHIMS` Record + `pickShimForVoice` prefix routing + `isHttpDispatchedShim`
- `src/daemon/agents/parsers/index.ts` — re-export the new parser
- `src/lib/cli-health.ts` — `CliLineage` union + `ALL_LINEAGES` array
- `src/lib/cli-precheck.ts` — `CRED_PATHS` + `LOGIN_HINT` + the precheck skip-list (HTTP shims skip cred probe) + env-var override branch if applicable

**Cockpit / UI types:**
- `src/lib/cockpit-types.ts` — `ReviewerLineage` union
- `src/lib/types.ts` — **SEPARATE** `ReviewerLineage` union. Both need updating; they should match but don't share imports today.
- `src/lib/lineage-maps.ts` — `DaemonLineage`, `UILineage`, `LINEAGE_LABEL`, `LINEAGE_DOT`, `UI_LINEAGE_LABEL`, `UI_LINEAGE_DOT`, `UI_LINEAGE_DEFAULT_MODEL`, `UI_LINEAGE_AVAILABLE_MODELS`, `UI_LINEAGE_BRAND`
- `src/lib/template-schema.ts` — `lineageEnum` + `reviewerLineageEnum` Zod enums

**Voice seeding (don't miss these — caught by typecheck only after wiring):**
- `src/lib/voices.ts` — has its **own** local `DaemonLineage` + `UiLineage` types (separate from lineage-maps.ts!), `LINEAGE_TO_UI` map, `SINGLE_MODEL_CLIS` array (this is where you register the voice for auto-seed), and `humanLineageLabel()` switch (TS exhaustiveness check fires if a case is missing).
- `src/lib/db/voices.ts` — `VoiceRowSchema.lineage` Zod enum + the explicit `lineage` field on `VoiceUpsertInput` type union (both need updating; they don't share a single source).

**Component-level maps:**
- `src/components/phase-editor/constants.ts` — `LINEAGES`, `DAEMON_TO_COCKPIT_LINEAGE`
- `src/components/template-dialog/constants.ts` — `COCKPIT_TO_DAEMON`, `DAEMON_TO_COCKPIT`, `DAEMON_DEFAULT_MODEL`, `FALLBACK_LINEAGES`
- `src/components/live-run-real/helpers.ts` — `AGENT_LABEL` (matches on-disk reviewer dir naming) + `TEMPLATE_TO_UI_LINEAGE`
- `src/components/cli-status-panel.tsx` — `ORCHESTRATOR_TO_LINEAGE` + `ORCHESTRATOR_TO_PROVIDER`

**CLI-side maps:**
- `src/cli/commands/init.ts` — `labelMap` + the docs hint
- `src/cli/commands/doctor.ts` — `labelMap` in `printReport()`
- `src/cli/commands/quickstart.ts` — `cliToLineage` (gate that determines whether quickstart will pick this CLI as the doer)
- `src/app/onboarding/helpers.ts` — `CLIS` array + `manualBinaryName()` switch

**Error detector:**
- `src/daemon/error-detector.ts` — extend the auth-prompt regex's lineage gate and login-command alternation. **Pattern ordering matters** — see anti-pattern §3 below.

A complete reference: search for "openrouter" or "local" — those were the most recent additions and touched exactly this set. For Level 3 with a brand-new lineage (not aliased to an existing one), follow the **Grok L3 PR (#46)** as the worked example — it's the only one in the codebase that exercises the full sweep including the secondary `voices.ts` type declarations and the legacy-alias guard.

### 3.3.5 Legacy lineage names — audit before reuse

If your new daemon lineage name has any history in the codebase, audit it before picking. Real example: `xai` was the original Grok lineage tag in v0.5, then renamed to `opencode` in v0.6 (chorus-031 — opencode-go became the umbrella). The legacy `xai → opencode` mapping is **preserved** in `DAEMON_TO_COCKPIT` so old YAML templates still render. When we added the first-party Grok CLI in PR #46, we picked `grok` as the new daemon lineage **specifically to avoid colliding with the legacy `xai` alias** — old templates with `lineage: xai` still route to opencode-go-routed grok models, new templates with `lineage: grok` route to the first-party CLI.

**Heuristic:** grep `DAEMON_TO_COCKPIT` for the name you're considering. If it appears, pick a different name.

### 3.4 Error-detector signatures

`src/daemon/error-detector.ts` — add patterns for the CLI's auth/quota/crash output. Without this, hung CLIs cost token budgets indefinitely (see `feedback_let_all_reviewers_finish.md`).

### 3.5 Voice seeding

`src/lib/voices.ts` — extend `seedCliVoices` to auto-populate voices when the new CLI is detected at daemon boot. Two patterns:

- **Single-model CLIs** (claude, codex, gemini, kimi, grok): add an entry to `SINGLE_MODEL_CLIS` — provider, daemon lineage, and that's it. The seed picks `UI_LINEAGE_AVAILABLE_MODELS[ui_lineage][0]` as the model_id.
- **Multi-model CLIs** (opencode): probe live via `<cli> models`. See `seedOpencodeVoicesAsync` for the pattern.

**Default `enabled` state — always `true`.** Even for subscription-gated CLIs where most installs won't have access:
- Disabled-by-default voices are invisible dead weight — users won't discover them.
- Failed dispatches auto-disable via the voice-failure tracker (chorus-106 — `voice-failure-tracker.ts`).
- The orchestrator's `note` field warns about subscription requirements; that's the discovery surface, not the disabled state.
- Verified by the 8-reviewer panel on PR #46 — unanimous "ship enabled" for Grok despite SuperGrok Heavy requirement.

### 3.6 Cost-model entry

If you have OpenRouter rate sheets or vendor pricing, add to `src/lib/voices.ts` cost mapping. Otherwise `estimateCostUsd` returns 0 (acceptable for free local/CLI-backed models).

### 3.7 Verify Level 3

```bash
pnpm test
pnpm build:server
node bin/chorus.mjs stop && node bin/chorus.mjs start

# Build a template that uses the new lineage as a reviewer
# Fire it via MCP create_chat
# Verify on /runs/<id> that the reviewer card shows the new lineage's
# dot colour, label, and produces output without an "auth_missing" or
# "REVIEWER FAILED" summary.
```

---

## Anti-patterns

Things that look like shortcuts but break things downstream:

1. **Adding to lineage enums WITHOUT a shim.** TypeScript will be happy, but at runtime `pickShimForVoice` falls back to `claudeShim` (the `any` lineage default) and the CLI never actually runs. Reviewer cards will show "Claude" even though the template said something else.

2. **Skipping `error-detector` signatures.** A CLI that prints "no API key" to stderr and hangs the REPL will burn through chorus's timeout budget per dispatch. The detector catches the auth/quota failure in <1s and short-circuits.

3. **Bundling CLI-specific error patterns into the generic auth regex.** When you add a CLI-specific failure signature (e.g. `"SuperGrok Heavy subscription required"`), put it in its own branch **above** the generic auth-prompt match — not as another alternation inside the regex. The generic regex routes to `token_refresh_lost` by default, and an inline override mid-match creates category ambiguity. From PR #46 chorus-self-review: a bundled pattern technically worked but created fragility for future rules that route on `kind` alone. **Pattern**: CLI-specific patterns first (early return with the right `kind`), then the generic catch-all. Verified in `src/daemon/error-detector.ts` Pattern 1f → 1e ordering.

4. **Vacuous test assertions when narrowing event types.** When parser tests use TypeScript type guards to inspect event shapes:
   ```typescript
   const events = parseGrok(line);
   if (events[0].type === 'error') {        // ⚠ silent pass if events is []
     expect(events[0].kind).toBe('auth_invalid');
   }
   ```
   If the parser returns `[]`, the guard short-circuits and the test passes without exercising the `expect`. **Always assert length first:**
   ```typescript
   expect(events).toHaveLength(1);
   expect(events[0].type).toBe('error');
   if (events[0].type === 'error') {
     expect(events[0].kind).toBe('auth_invalid');
   }
   ```
   This caught a real silent-pass in PR #46 — codex-cli reviewer flagged it.

5. **Adding to `FALLBACK_LINEAGES` without verifying the diversity story.** Cross-lineage `require:2` templates count lineages, not models. If two slots both fall back to the new lineage, they don't satisfy diversity. Document this in the lineage map or exclude from `FALLBACK_LINEAGES` until verified.

6. **No auth-file precheck on a CLI that browser-OAuths inline.** If the CLI prints something like `"Open this URL to sign in:"` and waits for a callback when invoked without credentials, headless dispatch will hang the daemon indefinitely. Always gate with `precheckLineage` — file probe (`~/.<cli>/auth.json`) **OR** env-var override. The exec **must not** be the first thing that detects missing auth. Grok PR #46 verified this by running `grok -p ...` unauthenticated — observed the OAuth-flow attempt — added the file-probe gate to block before spawn.

7. **Not stripping ANSI escape sequences before pattern-matching stderr.** Most CLIs colour-decorate their ERROR lines (`\x1b[31m...`). Pattern matches against raw stderr will miss the auth-error signature half the time. **Strip first:**
   ```typescript
   const clean = stderr.replace(/\x1b\[[0-9;]*m/g, '');
   if (clean.includes('SuperGrok Heavy subscription required')) { ... }
   ```
   The regex `/\x1b\[[0-9;]*m/g` matches SGR (Select Graphic Rendition) sequences — colours, bold, italic. It won't match cursor-movement or erase sequences, but those almost never appear in error output.

8. **CRLF line endings.** Contributors editing on Windows can drop CRLF terminators into TypeScript files. `git diff` looks like 500-line rewrites for what are single-enum additions. Run `sed -i 's/\r$//' <file>` before committing (or add `.gitattributes` with `* text=auto eol=lf`).

9. **Hardcoding model IDs in quickstart / templates.** Use `UI_LINEAGE_DEFAULT_MODEL` lookups; otherwise model bumps create drift. Five reviewers flagged this in a prior PR — model strings inside `quickstart.ts` are explicitly forbidden.

10. **Trusting `stopReason` to be a fixed value.** Parsers that emit `message_done` unconditionally in the `end` branch will treat `stopReason: "max_tokens"`, `"tool_use"`, or `"Error"` as a clean completion. If the CLI's spec documents multiple stop reasons, switch on them; if it only documents one (Grok docs only mention `EndTurn`), the conservative move is to log unrecognised values so a future contributor with paid access can file a useful bug report.

11. **Assuming the CLI binary name matches the user-facing brand.** Antigravity ships as `agy` (Google's choice — short, distinct). The Antigravity IDE binary (`antigravity` at `~/.antigravity-server/.../remote-cli/antigravity`) is the VSCode-fork IDE, unrelated to the chat CLI. Map `BINARY_NAME['antigravity-cli'] = 'agy'`; do NOT match on the brand name. Probe `<bin> --help` to confirm the actual binary before wiring detection.

12. **Same-vendor lineage collisions.** Google ships TWO first-party coding CLIs as of 2026-05: gemini-cli and Antigravity CLI. Both lineages should coexist (a user with both installed gets two Google voices in the reviewer fleet). Picking `google` as the daemon lineage for both would collapse them into one entry. The Antigravity integration uses a separate `antigravity` lineage so the two CLIs are distinguishable in the picker, on run-page cards, and for diversity scoring. Apply the same heuristic to any future second-CLI-from-same-vendor: separate lineage, separate brand colour, shared dot-family if visually appropriate (gemini=blue-400, antigravity=sky-400).

13. **Locked-model CLIs.** Some CLIs (Antigravity is the canonical example) don't expose a `--model` flag — the binary picks the model. Still register a `gemini-3.5-flash`-style id in `UI_LINEAGE_DEFAULT_MODEL` and `UI_LINEAGE_AVAILABLE_MODELS` so the voices catalog and template dropdown stay consistent with single-model CLIs (claude, kimi, grok). The chorus-side model id is INFORMATIONAL for these; the runner doesn't pass it as an argv flag. Note this clearly in the shim's `runHeadless` comment so a future contributor doesn't add a `-m` argv.

---

## Verification matrix

Before opening a PR, every level should pass its corresponding row:

| Surface | Level 1 | Level 2 | Level 3 |
|---|---|---|---|
| `chorus diagnose` shows CLI | ✓ | ✓ | ✓ |
| `chorus init` lists CLI | ✓ | ✓ | ✓ |
| `chorus doctor` labelMap includes CLI | ✓ | ✓ | ✓ |
| `/connect` shows orchestrator card | — | ✓ | ✓ |
| Onboarding picker offers CLI | ✓ | ✓ | ✓ |
| `/orchestrators` API reports `connected` correctly | — | ✓ | ✓ |
| Phase editor lineage dropdown includes lineage | — | — | ✓ |
| Template `lineage:` in YAML round-trips | — | — | ✓ |
| Reviewer card renders on `/runs/<id>` with proper dot colour + label | — | — | ✓ |
| Voice auto-seeded on first detect (enabled by default) | — | — | ✓ |
| Cross-lineage fallback math correct (collision detection holds) | — | — | ✓ |
| Auth precheck blocks spawn before OAuth-flow hangs daemon | — | — | ✓ |
| Unauthenticated failure path tested with empirical stderr fixtures | — | — | ✓ |
| Parser test assertions check `events.length` before type-guards | — | — | ✓ |
| `humanLineageLabel()` switch has a case (TS exhaustiveness) | — | — | ✓ |
| CLI-specific error patterns ordered ABOVE generic auth regex | — | — | ✓ |

---

## Reference implementations

- **Level 3 (subscription-gated CLI shim with verified failure path)**: `src/daemon/agents/grok.ts` + `src/daemon/agents/parsers/grok.ts` — Grok Build. Streaming-json output, env-var OR file-based auth, empirically-verified error path (`SuperGrok Heavy subscription required` → quota_exhausted), happy path inferred from official spec docs. Promoted from Level 2 in PR #46.
- **Level 3 (plain-text CLI, locked model, subscription)**: `src/daemon/agents/antigravity.ts` + `src/daemon/agents/parsers/antigravity.ts` — Antigravity CLI (`agy`). NO streaming-json output mode exists — each stdout line is a text_delta. NO `--model` flag (locked to Gemini 3.5 Flash by Google). Subscription via `~/.gemini/antigravity-cli/antigravity-oauth-token`. Probed live 2026-05-20 on Google AI Pro. Shows the minimum-shim pattern for a CLI that doesn't expose structured output.
- **Level 1 → 3 (HTTP-dispatched shim)**: `src/daemon/agents/local.ts` — Local LLM / Ollama. The most recent HTTP-shim integration; touch points are well-documented in PR #42.
- **Level 1 → 3 (CLI/tmux shim)**: `src/daemon/agents/kimi.ts` — clean separation between tmux dispatch and headless invocation.
- **Level 2 (consumer-only, auto-pickup)**: `src/daemon/orchestrators/grok.ts` (orchestrator side) — keep this when the CLI reads `~/.claude.json` natively even though you're also shipping a shim. Two-way wiring is OK.
- **Level 2 (consumer-only, own config)**: `src/daemon/orchestrators/cursor-windsurf.ts` — Cursor/Windsurf. Writes its own MCP file.

When in doubt, copy the closest reference and grep for every place the analog CLI's name appears in the codebase.

---

## Shipping a Level 3 shim without a paid subscription

It's tempting to wait until you can verify happy-path. Don't — the costs are higher than the benefits:

**You CAN ship safely without paid auth if:**
1. The CLI ships docs with an explicit streaming-json schema (e.g. `~/.grok/docs/user-guide/13-headless-mode.md`). Code to the spec, not your guess.
2. You can empirically reproduce the failure path. Run the CLI unauthenticated, capture stderr, encode it in the error-detector. That's the path 100% of unpaid users hit — verifying it matters more than the happy path.
3. The failure mode is `auth_missing` / `quota_exhausted`, which chorus's existing health machinery handles cleanly (voice auto-disables after N strikes, no infinite loops).

**You CAN'T ship safely without paid auth if:**
1. The CLI's docs are missing or contradict empirical behavior.
2. The failure path is "spawn a browser flow" — chorus's headless dispatch will hang. Either gate at precheck (file probe + env var) or skip the integration.
3. Cost accounting is critical. No usage block in success events = no per-call cost. Set `estimateCostUsd` to 0 and call it out in the orchestrator note.

The Grok Build integration is a worked example: spec-driven happy path, empirically-verified failure path, env-var bypass at precheck, error-detector signatures for the three known failure shapes. If a SuperGrok Heavy user files a parsing-bug issue, the fix is one parser-line in `grok.ts`; the structural code stays put.
