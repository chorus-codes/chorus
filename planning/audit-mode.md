# `chorus audit` — onboard chorus on existing codebases

## Problem

Chorus today is PR-shaped. Every chat assumes a future-tense change: doer
produces an artifact, reviewers critique it. Users adopting Chorus on a
mature repo have a different question — *"what did we already ship that
we should worry about?"* — and the only way to ask it today is to fake
a synthetic PR against `main` and run review-only over it.

That works but it's friction at the worst moment (first impression).
Every team has pre-Chorus code; "we just installed this, what about
the rest of the repo?" is a day-one question.

## Approach

Add `chorus audit <path>` — a thin CLI shim that:

1. Walks `<path>` (file, dir, or `--since <ref>` for changed-since semantics)
2. Reads files, applies caps, builds a concatenated artifact with file
   headers (`## src/foo.ts` + fenced body)
3. Resolves a template (default: built-in `review-only`; override with
   `--template <id>`)
4. POSTs `/chats` with `artifact`, `work` (audit-framed brief), `templateId`
5. Prints the cockpit URL — same UX as `chorus quickstart` tail

No runner changes, no schema migration, no new phase kind. The
substrate (review-only phase + `artifact` field) already does the
heavy lifting. The audit framing lives entirely in the `work` text —
reviewers read `work` prominently in their `ask.md`, so audit-style
output ("findings, not verdict") falls out of well-worded prompting.

## CLI surface

```
chorus audit <path>
  [--scope <name>]
  [--focus security|correctness|performance|maintainability|all]
  [--template <id>]
  [--since <ref>]
```

Examples:

```
chorus audit src/daemon/runner.ts
chorus audit apps/workers/recon/ --focus security
chorus audit src/lib/ --scope "auth subsystem"
chorus audit . --since main
chorus audit src/cli/ --template my-custom-audit-template
```

### Flag semantics

- `--scope <name>` — human label that appears in the `work` brief and
  becomes the chat title. Defaults to the path basename.
- `--focus <area>` — adds a focus paragraph to the brief. `all` is the
  default (no focus paragraph). Five values, no enum schema — the brief
  text is what the reviewers see, not the flag.
- `--template <id>` — picks the fleet. Must be a template whose first
  phase is `kind: review_only` (we error out otherwise — full-pipeline
  templates with doer slots don't compose with audit). Defaults to the
  built-in `review-only` template.
- `--since <ref>` — Phase 2. Skipped in Phase 1.

### Defaults rationale

- **Default template = `review-only`** — already ships, already 5
  reviewer lineages, already proven via `quickstart` and direct usage.
- **No `--reviewers N` flag** — the template encodes the fleet; a
  count alone would force chorus to silently pick lineages (diversity
  gone). Earlier draft of this spec had `--reviewers N`; dropped in
  favour of `--template`.

## File-pack assembly

The audit command reads files and concatenates them into a single
artifact string. Cap policy:

| Limit | Value | Behaviour at limit |
|---|---|---|
| Max files per audit | 50 | Refuse with `narrow scope further` |
| Max total bytes | 200 KB | Refuse, same message |
| Max per-file lines | 2000 | Truncate head+tail, marker in middle |
| Allowed extensions | source-code allowlist | Skip silently, list at end |

**Extension allowlist:** `.ts .tsx .js .jsx .mjs .cjs .py .go .rs .java
.kt .swift .rb .php .c .cpp .h .hpp .cs .sql .sh .bash .yaml .yml .toml
.json .md`. Binary / image / lock files always skipped.

**Skip rules:**
- `node_modules/`, `.git/`, `dist/`, `build/`, `.next/`, `__pycache__/`,
  `.venv/`, `target/`, `vendor/` directories pruned at walk time
- Hidden files (`.foo`) skipped unless explicitly named
- Symlinks rejected (TOCTOU defence, same rule as `packAttachedFiles`)
- Files larger than the per-file truncation cap get a head+tail slice
  with `\n... [N lines elided] ...\n` marker so reviewers know to flag
  the truncation

**Artifact format:** Markdown with one section per file:

```markdown
# Audit: <scope label>

<focus paragraph if --focus given>

---

## `src/daemon/runner.ts` (412 lines)

```typescript
<file body>
```

## `src/daemon/openrouter.ts` (180 lines, truncated to 2000 lines)

```typescript
<file head>

... [N lines elided] ...

<file tail>
```

<additional files...>

---

**Skipped (extension not in allowlist):**
- `assets/logo.png`
- `package-lock.json`
```

This format reads naturally in reviewer `ask.md` and gives them clear
file boundaries to cite.

## Work brief (the audit framing)

The `work` field sent with the chat is what makes this an audit vs.
review. Template stays the same; brief changes.

Brief structure:

```
You are auditing existing production code (scope: <scope label>).

This code already ships. Your job is to find real bugs, security
risks, and correctness issues — not style nits. Be specific:
file:line, what's wrong, what would fix it.

<optional focus paragraph from --focus>

End your review with "approve" if you found nothing high-severity,
or "request changes" if you did. List your findings as a markdown
list before the verdict, sorted high → low severity.
```

`--focus security` adds:

> Focus on: authentication, authorization, input validation, secret
> handling, injection vectors, SSRF, race conditions, and any place
> the code trusts external input.

`--focus correctness` adds:

> Focus on: off-by-one errors, null/undefined handling, race
> conditions, error swallowing, and edge cases the happy path
> obscures.

`--focus performance` adds:

> Focus on: N+1 patterns, unnecessary work in hot paths, blocking
> I/O on event loops, and unbounded memory growth.

`--focus maintainability` adds:

> Focus on: code that future maintainers will struggle with — unclear
> naming, hidden coupling, missing types, dead branches, and
> abstractions that don't pay rent.

The `## DONE` + approve/request-changes convention from review-only
stays — the existing `verdictFromReviewerText` heuristic interprets it
the same way for audits, which keeps chat lifecycle code unchanged.

## Output

Phase 1: same as any review-only chat. Reviewers' `answer.md` files
land in `~/.chorus/chats/<chat-id>/round-1/reviewer-*/answer.md`.
Cockpit `/runs/<chat-id>` renders them as today.

Phase 2 (deferred):
- Dedicated `/audits` cockpit route with findings-list UI
- CONSOLIDATED.md per-audit doc merging findings across reviewers
- Severity clustering by `file:line` proximity

We ship Phase 1 with the existing run page. The audit framing is
fully in `work`, so reviewers naturally produce file:line findings
and the run page renders them like any other reviewer output.

## Non-goals

- Whole-repo scanning (`chorus audit .` works but is bounded by the
  200KB total cap — narrow it manually)
- Continuous / scheduled audits (later, if demand)
- Per-finding action buttons ("open issue", "open PR with fix")
- Audit-only template kind (no schema change; framing via `work`)
- Replacement for `chorus review` on real PRs

## Tests

Unit:
- `assembleAuditArtifact(paths, opts)` — pure function, exercise:
  - 50-file cap exceeded → throws specific error
  - 200KB total cap exceeded → throws specific error
  - 2000-line file → head+tail truncation with marker
  - extension filtering (allowlist works, lockfile skipped)
  - directory recursion respects skip-list (`node_modules`, etc.)
  - symlink rejection
  - empty path → throws "no files matched"

Manual smoke:
- `chorus audit src/cli/commands/audit.ts` — single file
- `chorus audit src/cli/` — small directory
- `chorus audit src/daemon/ --focus security` — focus paragraph appears
- `chorus audit nonexistent` — clear error

## Risk register

- **Daemon must be running.** Audit is a CLI → daemon HTTP client.
  Same failure mode as quickstart; reuse the same daemon-not-running
  message and `chorus start` hint.
- **Large repos blow the 200KB cap.** Refuse early with a clear
  "narrow scope further" message; don't truncate silently.
- **Reviewer drift.** Without an explicit audit-mode prompt block in
  `buildReviewerAsk`, audit framing depends on the LLM following the
  `work` text. If reviewers still emit approve/request-changes without
  findings, that's a brief-tuning problem — iterate on the brief, not
  the runner.
- **Symlink TOCTOU.** Reuse the `O_NOFOLLOW` pattern from
  `packAttachedFiles`. Skip silently with a count at the end.

## Phasing

**Phase 1 (this PR):**
- `src/cli/commands/audit.ts` + register in `src/cli/index.ts`
- `assembleAuditArtifact` helper in same file (or `src/lib/audit-pack.ts`
  if it grows)
- `tests/audit-pack.test.ts` for the pure-function part
- Reuse `review-only` template; allow `--template <id>` override
- Reuse existing `/chats` endpoint, no daemon code changes
- Docs: README section + `chorus audit --help`

**Phase 2 (later):**
- `--since <ref>` for git-diff scoping
- Dedicated `/audits` cockpit route
- Severity clustering / dedup across reviewers
- MCP `chorus_audit` tool

## Estimated effort

~3-4 hours focused. Bounded by:
- ~200 LOC in `audit.ts` (file walk + cap enforcement + HTTP client)
- ~150 LOC in `audit-pack.test.ts`
- Brief text iteration during manual smoke
