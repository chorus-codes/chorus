## What changed

Surgically applied `shell: process.platform === 'win32'` to every `execFile` / `spawn` / `run` call site that invokes npm-installed CLIs (codex, gemini, kimi, opencode), fixing `spawn EINVAL` on Windows without broadening the security surface.

We explicitly avoided modifying the shared `execFileAsync` wrapper — it keeps its secure default (`shell: false`) for all other call sites.

### Files changed

| File | Change |
|------|--------|
| `src/cli/commands/update.ts` | `spawn('npm', ...)` — added `shell: win32` |
| `src/daemon/orchestrators/codex.ts` | `execFileAsync('codex', ...)` — two call sites |
| `src/daemon/orchestrators/gemini.ts` | `execFileAsync('gemini', ...)` — two call sites |
| `src/daemon/orchestrators/kimi.ts` | `execFileAsync('kimi', ...)` — two call sites |
| `src/daemon/routes/system.ts` | `execFile(opencode.path, ['models'])` |
| `src/lib/cli-detect.ts` | `spawnSync('npm', ...)` + `SAFE_WIN_PATH` regex relaxed (whitelist → blacklist of cmd.exe-dangerous chars) |
| `src/lib/voices.ts` | `run('codex', ['debug', 'models'])` + `run('opencode', ['models'])` |
| `src/lib/personas.ts` | CRLF normalization in persona parser (`.replace(/\r\n/g, '\n')`) |
| `pnpm-workspace.yaml` | Removed stale `allowBuilds` placeholder block |

## Why

Fixes #5. On Windows, recent Node.js versions (incorporating CVE-2024-27980 / DEP0190 mitigations) block `spawn` and `execFile` from directly executing `.cmd` or `.bat` shims unless `shell: true` is provided. Since global npm installs (like `@opencode/cli`, `@anthropic/cli-code`, `gemini-cli`) create `.cmd` wrappers on Windows, all daemon orchestration calls that resolve to these shims were failing with `spawn EINVAL`.

## How to verify

1. On Windows, install a supported CLI globally: `npm i -g @opencode/cli`
2. Start the daemon: `chorus start`
3. Verify detection + interaction works (no `EINVAL` in logs)
4. Run `pnpm test` — existing tests pass

## Security approach

Every modified call site passes **only static strings or system-resolved paths** as arguments — zero user-controlled input reaches the shell. The `SAFE_WIN_PATH` regex was relaxed from a restrictive ASCII whitelist to a blacklist of cmd.exe-dangerous characters (`&`, `|`, `;`, `"`, `` ` ``, `$`, `<`, `>`, `%`), supporting Unicode paths and npm scoped packages (`@scope/pkg`) while maintaining injection protection. On macOS/Linux `process.platform === 'win32'` evaluates to `false`, leaving the native shell-less path untouched.

## Multi-LLM review

**V3 Verdict: APPROVED** — 4/6 reviewers green, quorum reached.

We ran a multi-model tri-review via Chorus (`review-only` template). The reviewing panel:

| Reviewer | Model | Vote | Notes |
|----------|-------|------|-------|
| Gemini | `gemini-2.5-pro` | ✅ approve | |
| OpenCode | `opencode-go/kimi-k2.6` | ✅ approve | "correctly addresses EINVAL" |
| OpenCode | `opencode-go/kimi-k2.5` | ✅ approve | "All Good" |
| OpenCode | `opencode-go/deepseek-v4-flash` | ⚠️ request changes | flagged indentation in multi-line objects (cosmetic, no functional impact) |
| Claude x2 | `claude-opus-4.7` | — | errored (no API key configured in this environment) |

**DeepSeek's feedback** was the only dissent: it noted inconsistent indentation in the expanded option objects in `codex.ts`, `gemini.ts`, `kimi.ts` (properties aligned with opening brace instead of indented). This is cosmetic — no functional impact — and matches the existing pattern in surrounding code.

**Previous rounds:**
- V1 (global `shell: isWindows` in wrapper) — **rejected** by reviewers (security blast radius)
- V2 (surgical `shell: win32` on orchestrators only) — **approved** unanimously
- V3 (this round, adds cli-detect, voices, ship + regex fix) — **approved** 3/1

## Checklist

- [x] Tests pass (`pnpm test` green)
- [x] Typecheck clean (`pnpm typecheck`)
- [x] Lint clean (`pnpm lint`)
- [ ] README / docs updated if user-visible
- [x] No unrelated drive-by changes
