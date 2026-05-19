/**
 * Audit-pack assembly.
 *
 * Pure helpers for `chorus audit <path>`. Walk a path, read files,
 * concatenate into a single artifact string the existing review-only
 * substrate can consume.
 *
 * No HTTP, no daemon, no subprocess — only fs reads from a user-supplied
 * path with the same defence-in-depth checks used by `packAttachedFiles`
 * (no symlinks, no traversal, regular files only).
 *
 * Caps are intentionally aggressive. Audit's job is to narrow scope
 * enough that a 5-reviewer fleet can produce useful findings on a
 * single subsystem — not to scan a whole repo. Refuse early with a
 * clear "narrow scope further" message when limits are exceeded.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Max number of files surveyed in one audit. */
export const AUDIT_MAX_FILES = 50;

/** Max total bytes (across all files) emitted into the artifact. */
export const AUDIT_MAX_TOTAL_BYTES = 200 * 1024;

/** Max lines retained per file before head+tail truncation kicks in. */
export const AUDIT_MAX_FILE_LINES = 2000;

/** Lines retained from the head when a file is truncated. */
const TRUNCATION_HEAD_LINES = 1500;

/** Lines retained from the tail when a file is truncated. */
const TRUNCATION_TAIL_LINES = 500;

/**
 * Extensions audit will read. Everything else is skipped silently and
 * surfaced in the trailing "skipped" section. Lockfiles and binary
 * formats are never useful in an audit artifact.
 */
/**
 * Filename-based exclusions that run after the extension check.
 * Lockfiles pass the .json / .yaml / .yml extension filter but are
 * spec-banned ("Lockfiles and binary formats are never useful in an
 * audit artifact" — planning/audit-mode.md). Convergent self-review
 * (3/8 reviewers on PR #58) caught the divergence between spec and
 * implementation. Match case-insensitively for cross-platform safety.
 */
const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'cargo.lock',
  'composer.lock',
  'gemfile.lock',
  'poetry.lock',
  'go.sum',
]);

const ALLOWED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.rb',
  '.php',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.sql',
  '.sh',
  '.bash',
  '.yaml',
  '.yml',
  '.toml',
  '.json',
  '.md',
]);

/**
 * Directories pruned at walk time. Keeps node_modules and build output
 * out of the artifact even when the user points audit at a project
 * root.
 */
const PRUNE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'vendor',
  '.turbo',
  'coverage',
  '.cache',
]);

export interface AuditPackOptions {
  /** Human label for the audited scope; appears in artifact heading. */
  scope: string;
  /** Optional focus paragraph inserted before the file list. */
  focusParagraph?: string;
}

export interface AuditPackResult {
  /** Full markdown artifact ready to POST as the chat's `artifact` field. */
  artifact: string;
  /** Files actually included (relative to the input root). */
  filesIncluded: string[];
  /** Files skipped because their extension isn't in the allowlist. */
  filesSkipped: string[];
  /** Total bytes of file content emitted (post-truncation). */
  totalBytes: number;
}

/** Pure-error class for distinguishable failure modes in tests + callers. */
export class AuditPackError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'AuditPackError';
  }
}

/**
 * Walk a path and return absolute file paths under it. Resolves a single
 * file to a one-element list; a directory is recursively walked with
 * PRUNE_DIRS removed. Symlinks are rejected. Never crosses out of the
 * input root.
 */
export function walkAuditPath(rootAbs: string): string[] {
  const stat = fs.lstatSync(rootAbs);
  if (stat.isSymbolicLink()) {
    throw new AuditPackError(
      'symlink_root',
      `audit path is a symlink — refusing to follow: ${rootAbs}`,
    );
  }
  if (stat.isFile()) return [rootAbs];
  if (!stat.isDirectory()) {
    throw new AuditPackError(
      'not_a_file_or_dir',
      `audit path is not a file or directory: ${rootAbs}`,
    );
  }

  const out: string[] = [];
  const stack: string[] = [rootAbs];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        // PRUNE_DIRS match is case-insensitive — Windows / macOS have
        // case-insensitive filesystems and a folder named `Node_modules`
        // should still get pruned. readdirSync never returns `.` or `..`
        // as Dirent.name, so no `!== '.'` guard is needed.
        if (PRUNE_DIRS.has(entry.name.toLowerCase())) continue;
        if (entry.name.startsWith('.')) continue;
        stack.push(full);
        continue;
      }
      if (entry.isFile()) {
        if (entry.name.startsWith('.')) continue;
        if (LOCKFILE_NAMES.has(entry.name.toLowerCase())) continue;
        out.push(full);
      }
    }
  }
  out.sort();
  return out;
}

/**
 * Read a file safely (O_NOFOLLOW on POSIX, lstat-then-read on Windows).
 * Returns null on any failure or skip condition — callers decide whether
 * to surface that as a skipped file or hard error.
 *
 * TOCTOU note: the read goes through the same fd we opened with
 * O_NOFOLLOW, not the path string. A prior revision opened a fd, ran
 * fstat, then re-read via readFileSync(path) — convergent self-review
 * (5/8 reviewers on PR #58) flagged that a symlink swap between the
 * stat and the re-read would defeat the O_NOFOLLOW guard. Reading from
 * the fd closes the window.
 */
function readFileSafe(abs: string): string | null {
  try {
    if (process.platform !== 'win32') {
      let fd = -1;
      try {
        fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) return null;
        return fs.readFileSync(fd, 'utf-8');
      } finally {
        if (fd >= 0) fs.closeSync(fd);
      }
    } else {
      // Windows fallback: lstat-then-read. The race window here is wider
      // (no atomic O_NOFOLLOW equivalent) but Windows isn't the primary
      // target for chorus audits. Documented as best-effort.
      const lstat = fs.lstatSync(abs);
      if (lstat.isSymbolicLink() || !lstat.isFile()) return null;
      return fs.readFileSync(abs, 'utf-8');
    }
  } catch {
    return null;
  }
}

/** Truncate a file's content head+tail with an elision marker. */
function truncateFileBody(body: string): { body: string; truncated: boolean; originalLines: number } {
  const lines = body.split('\n');
  if (lines.length <= AUDIT_MAX_FILE_LINES) {
    return { body, truncated: false, originalLines: lines.length };
  }
  const head = lines.slice(0, TRUNCATION_HEAD_LINES).join('\n');
  const tail = lines.slice(lines.length - TRUNCATION_TAIL_LINES).join('\n');
  const elided = lines.length - TRUNCATION_HEAD_LINES - TRUNCATION_TAIL_LINES;
  return {
    body: `${head}\n\n... [${elided} lines elided] ...\n\n${tail}`,
    truncated: true,
    originalLines: lines.length,
  };
}

/** Strip leading dot from extension; empty extension returns ''. */
function extLangHint(ext: string): string {
  return ext.startsWith('.') ? ext.slice(1) : ext;
}

/**
 * Build the audit artifact from a list of absolute file paths under a
 * root. Files outside `rootAbs` are rejected. Enforces all caps and
 * surfaces both included and skipped files in the result.
 */
export function assembleAuditArtifact(
  rootAbs: string,
  files: string[],
  opts: AuditPackOptions,
): AuditPackResult {
  if (files.length === 0) {
    throw new AuditPackError(
      'no_files_matched',
      `no files matched under ${rootAbs} — check the path or extension allowlist`,
    );
  }

  // Filter by extension allowlist + lockfile blocklist; keep the
  // rejected ones for surfacing. Also enforces root-containment:
  // every file must live under `rootAbs` (closing the docstring
  // promise that a prior revision left unimplemented — 4/8 reviewers
  // on PR #58 flagged this as a path-traversal hole when callers
  // bypass walkAuditPath).
  const eligible: string[] = [];
  const skipped: string[] = [];
  for (const abs of files) {
    if (!abs.startsWith(rootAbs + path.sep) && abs !== rootAbs) {
      throw new AuditPackError(
        'outside_root',
        `file is outside the audit root (rootAbs=${rootAbs}, file=${abs})`,
      );
    }
    const base = path.basename(abs).toLowerCase();
    if (LOCKFILE_NAMES.has(base)) {
      skipped.push(abs);
      continue;
    }
    if (ALLOWED_EXTENSIONS.has(path.extname(abs).toLowerCase())) {
      eligible.push(abs);
    } else {
      skipped.push(abs);
    }
  }

  if (eligible.length === 0) {
    throw new AuditPackError(
      'no_files_matched',
      `no files matched the extension allowlist under ${rootAbs} — audit reads source code only`,
    );
  }

  if (eligible.length > AUDIT_MAX_FILES) {
    throw new AuditPackError(
      'too_many_files',
      `audit matched ${eligible.length} files; cap is ${AUDIT_MAX_FILES}. Narrow the scope (point at a subdirectory or specific file).`,
    );
  }

  // Read + truncate. Build content blocks and tally bytes.
  const blocks: string[] = [];
  const includedRel: string[] = [];
  const skippedRel: string[] = skipped.map((abs) => toDisplay(rootAbs, abs));
  let totalBytes = 0;

  for (const abs of eligible) {
    const display = toDisplay(rootAbs, abs);
    const body = readFileSafe(abs);
    if (body === null) {
      skippedRel.push(`${display} (read failed)`);
      continue;
    }
    const { body: bodyOut, truncated, originalLines } = truncateFileBody(body);

    // Build the full markdown block before measuring. Counting only the
    // raw file body underestimated the artifact size by header + fence
    // overhead (~80-120 bytes per file). Convergent self-review (3/8 on
    // PR #58) flagged that AuditPackResult.totalBytes — documented as
    // "bytes of file content emitted into the artifact" — must reflect
    // what actually gets POSTed, not just the body, so the cap and the
    // reported number stay apples-to-apples.
    const ext = extLangHint(path.extname(display));
    const header = truncated
      ? `## \`${display}\` (${originalLines} lines, truncated)`
      : `## \`${display}\` (${originalLines} lines)`;
    const block = `${header}\n\n\`\`\`${ext}\n${bodyOut}\n\`\`\``;
    const bytes = Buffer.byteLength(block, 'utf-8');

    if (totalBytes + bytes > AUDIT_MAX_TOTAL_BYTES) {
      const after = includedRel.length === 0
        ? 'before including any files'
        : `after ${includedRel.length} file${includedRel.length === 1 ? '' : 's'}`;
      throw new AuditPackError(
        'too_many_bytes',
        `audit content would exceed ${AUDIT_MAX_TOTAL_BYTES}-byte cap ${after}. Narrow the scope.`,
      );
    }

    blocks.push(block);
    totalBytes += bytes;
    includedRel.push(display);
  }

  if (includedRel.length === 0) {
    throw new AuditPackError(
      'all_files_unreadable',
      `every candidate file under ${rootAbs} failed to read — check permissions or symlink layout`,
    );
  }

  const heading = `# Audit: ${opts.scope}`;
  const intro = opts.focusParagraph ? `\n${opts.focusParagraph.trim()}\n` : '';
  const skipNote = skippedRel.length > 0
    ? `\n---\n\n**Skipped (${skippedRel.length} file${skippedRel.length === 1 ? '' : 's'} — extension not in allowlist or read failed):**\n${skippedRel.map((p) => `- \`${p}\``).join('\n')}\n`
    : '';

  const artifact = `${heading}\n${intro}\n---\n\n${blocks.join('\n\n')}\n${skipNote}`;

  return {
    artifact,
    filesIncluded: includedRel,
    filesSkipped: skippedRel,
    totalBytes,
  };
}

/** Display path: relative to root if under it, else basename. */
function toDisplay(rootAbs: string, fileAbs: string): string {
  const rel = path.relative(rootAbs, fileAbs);
  if (!rel || rel.startsWith('..')) return path.basename(fileAbs);
  return rel;
}

/**
 * Focus-paragraph map. Pure data so the CLI flag handler and tests
 * stay aligned. `all` returns undefined — no paragraph injected.
 */
export function focusParagraph(focus: string): string | undefined {
  switch (focus) {
    case 'security':
      return 'Focus on: authentication, authorization, input validation, secret handling, injection vectors, SSRF, race conditions, and any place the code trusts external input.';
    case 'correctness':
      return 'Focus on: off-by-one errors, null/undefined handling, race conditions, error swallowing, and edge cases the happy path obscures.';
    case 'performance':
      return 'Focus on: N+1 patterns, unnecessary work in hot paths, blocking I/O on event loops, and unbounded memory growth.';
    case 'maintainability':
      return 'Focus on: code that future maintainers will struggle with — unclear naming, hidden coupling, missing types, dead branches, and abstractions that do not pay rent.';
    case 'all':
    case '':
    case undefined:
      return undefined;
    default:
      // Unknown focus value — caller validates upstream; here we just
      // pass it through as a free-form paragraph so power users can
      // pipe arbitrary framing in if they want.
      return focus;
  }
}

/**
 * Build the audit `work` brief — the framing reviewers see in their
 * ask.md before the artifact. This is what turns review-only into
 * audit-mode without any runner changes.
 */
export function buildAuditWork(scope: string, focusPara: string | undefined): string {
  const lines: string[] = [];
  lines.push(`You are auditing existing production code (scope: ${scope}).`);
  lines.push('');
  lines.push(
    'This code already ships. Your job is to find real bugs, security risks, and correctness issues — not style nits. Be specific: file:line, what is wrong, what would fix it.',
  );
  if (focusPara) {
    lines.push('');
    lines.push(focusPara);
  }
  lines.push('');
  lines.push(
    'List your findings as a markdown list sorted high → low severity, then end your review with "approve" if you found nothing high-severity, or "request changes" if you did.',
  );
  return lines.join('\n');
}
