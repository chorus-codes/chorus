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

---

## Level 3 — Full reviewer (shim)

For CLIs you want to dispatch TO as a doer/reviewer. **Do not skip the empirical probe** — without verified `-p` headless invocation, the shim will silently fail at runtime.

### 3.1 Verify headless invocation

The CLI must support **single-prompt mode**:

```bash
<cli> -p "what is 2+2"        # claude / gemini / kimi pattern
<cli> --single "what is 2+2"  # grok pattern
```

It must:
- Exit with code 0 on success, non-zero on failure
- Print the answer to stdout
- Honour a `--model <id>` flag
- Optionally support `--output-format json|streaming-json` for structured output

If any of these are missing, fall back to consumer-only (level 2).

### 3.2 Add a shim

`src/daemon/agents/<name>.ts` — implement the `AgentShim` interface. For HTTP-dispatched (OpenAI-compatible) shims, copy `local.ts` or `openrouter.ts`. For tmux/headless CLI shims, copy `claude.ts` or `gemini.ts`.

Key responsibilities:
- `buildLaunchCommand(opts)` — for tmux mode (single-line + `%q`-quoted args)
- `runHeadless(opts)` — async generator yielding `AgentEvent` (text_delta, message_done, error)
- `estimateCostUsd(input, output, model?)` — best-effort cost model

### 3.3 Lineage enum sweep (the painful part)

Every union and `Record<Lineage, T>` map needs the new lineage. Missing one = TypeScript error at the unused branch + runtime confusion when that lineage is selected. Audit checklist:

- `src/daemon/agents/types.ts` — `Lineage` union
- `src/daemon/agents/index.ts` — `SHIMS` Record + `pickShimForVoice` prefix routing + `isHttpDispatchedShim`
- `src/lib/cli-health.ts` — `CliLineage` union + `ALL_LINEAGES` array
- `src/lib/cli-precheck.ts` — `CRED_PATHS` + `LOGIN_HINT` + the precheck skip-list (HTTP shims skip cred probe)
- `src/lib/cockpit-types.ts` — `ReviewerLineage` union
- `src/lib/lineage-maps.ts` — `DaemonLineage`, `UILineage`, `LINEAGE_LABEL`, `LINEAGE_DOT`, `UI_LINEAGE_LABEL`, `UI_LINEAGE_DOT`, `UI_LINEAGE_DEFAULT_MODEL`, `UI_LINEAGE_AVAILABLE_MODELS`
- `src/lib/template-schema.ts` — `lineageEnum` + `reviewerLineageEnum` Zod enums
- `src/components/phase-editor/constants.ts` — `LINEAGES`, `DAEMON_TO_COCKPIT_LINEAGE`
- `src/components/template-dialog/constants.ts` — `COCKPIT_TO_DAEMON`, `DAEMON_TO_COCKPIT`, `DAEMON_DEFAULT_MODEL`, `FALLBACK_LINEAGES`

A complete reference: search for "openrouter" or "local" — those were the most recent additions and touched exactly this set.

### 3.4 Error-detector signatures

`src/daemon/error-detector.ts` — add patterns for the CLI's auth/quota/crash output. Without this, hung CLIs cost token budgets indefinitely (see `feedback_let_all_reviewers_finish.md`).

### 3.5 Voice seeding

`src/lib/voices.ts` — extend `seedCliVoices` to auto-populate voices when the new CLI is detected at daemon boot. Models can be hardcoded (claude/gemini have stable lists) or probed live (codex uses `codex debug models`, opencode uses `opencode models`).

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

- **Adding to lineage enums WITHOUT a shim.** TypeScript will be happy, but at runtime `pickShimForVoice` falls back to `claudeShim` (the `any` lineage default) and the CLI never actually runs. Reviewer cards will show "Claude" even though the template said something else.
- **Skipping `error-detector` signatures.** A CLI that prints "no API key" to stderr and hangs the REPL will burn through chorus's timeout budget per dispatch. The detector catches the auth/quota failure in <1s and short-circuits.
- **Adding to `FALLBACK_LINEAGES` without verifying the diversity story.** Cross-lineage `require:2` templates count lineages, not models. If two slots both fall back to the new lineage, they don't satisfy diversity. Document this in the lineage map or exclude from `FALLBACK_LINEAGES` until verified.
- **CRLF line endings.** Contributors editing on Windows can drop CRLF terminators into TypeScript files. `git diff` looks like 500-line rewrites for what are single-enum additions. Run `sed -i 's/\r$//' <file>` before committing (or add `.gitattributes` with `* text=auto eol=lf`).
- **Hardcoding model IDs in quickstart / templates.** Use `UI_LINEAGE_DEFAULT_MODEL` lookups; otherwise model bumps create drift.

---

## Verification matrix

Before opening a PR, every level should pass its corresponding row:

| Surface | Level 1 | Level 2 | Level 3 |
|---|---|---|---|
| `chorus diagnose` shows CLI | ✓ | ✓ | ✓ |
| `chorus init` lists CLI | ✓ | ✓ | ✓ |
| `/connect` shows orchestrator card | — | ✓ | ✓ |
| Onboarding picker offers CLI | ✓ | ✓ | ✓ |
| `/orchestrators` API reports `connected` correctly | — | ✓ | ✓ |
| Phase editor lineage dropdown includes lineage | — | — | ✓ |
| Template `lineage:` in YAML round-trips | — | — | ✓ |
| Reviewer card renders on `/runs/<id>` | — | — | ✓ |
| Voice auto-seeded on first detect | — | — | ✓ |
| Cross-lineage fallback math correct | — | — | ✓ |

---

## Reference implementations

- **Level 1 → 3 (HTTP-dispatched shim)**: `src/daemon/agents/local.ts` — Local LLM / Ollama. The most recent full-shim integration; touch points are well-documented in PR #42.
- **Level 1 → 3 (CLI/tmux shim)**: `src/daemon/agents/kimi.ts` — clean separation between tmux dispatch and headless invocation.
- **Level 2 (consumer-only, auto-pickup)**: `src/daemon/orchestrators/grok.ts` — Grok Build. Reads `~/.claude.json` natively; no MCP write of its own.
- **Level 2 (consumer-only, own config)**: `src/daemon/orchestrators/cursor-windsurf.ts` — Cursor/Windsurf. Writes its own MCP file.

When in doubt, copy the closest reference and grep for every place the analog CLI's name appears in the codebase.
