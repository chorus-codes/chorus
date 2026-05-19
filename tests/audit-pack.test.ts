/**
 * Unit tests for src/lib/audit-pack.ts.
 *
 * Tests are pure: every fixture is built into a tmp dir per test, no
 * shared state across cases. Vitest's beforeEach + afterEach cleanup
 * keeps the tmp tree small.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  AUDIT_MAX_FILES,
  AUDIT_MAX_FILE_LINES,
  AUDIT_MAX_TOTAL_BYTES,
  AuditPackError,
  assembleAuditArtifact,
  buildAuditWork,
  focusParagraph,
  walkAuditPath,
} from '../src/lib/audit-pack.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = path.join(os.tmpdir(), 'chorus-audit-pack-' + randomUUID());
  fs.mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeFile(rel: string, content: string): string {
  const abs = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

describe('walkAuditPath', () => {
  it('returns a single-element list for a regular file', () => {
    const abs = writeFile('foo.ts', 'export const x = 1;');
    expect(walkAuditPath(abs)).toEqual([abs]);
  });

  it('walks a directory recursively, returning sorted absolute paths', () => {
    writeFile('a/one.ts', 'a');
    writeFile('b/two.ts', 'b');
    writeFile('c.ts', 'c');
    const result = walkAuditPath(tmpRoot);
    // Don't re-sort here — the function contract IS that output is
    // sorted. A test that calls .sort() before comparing would silently
    // pass even if the function returned files in random order, which
    // defeats the assertion. Convergent self-review (PR #58) flagged
    // this. Strip the tmp prefix but keep the function's own ordering.
    const rels = result.map((p) => path.relative(tmpRoot, p));
    expect(rels).toEqual(['a/one.ts', 'b/two.ts', 'c.ts']);
  });

  it('prunes node_modules / .git / dist / build / .next', () => {
    writeFile('keep.ts', 'k');
    writeFile('node_modules/junk.ts', 'n');
    writeFile('.git/objects/loose', 'g');
    writeFile('dist/bundle.ts', 'd');
    writeFile('build/output.ts', 'b');
    writeFile('.next/cache.ts', 'x');
    const result = walkAuditPath(tmpRoot);
    expect(result.map((p) => path.relative(tmpRoot, p))).toEqual(['keep.ts']);
  });

  it('skips hidden files at the leaf', () => {
    writeFile('visible.ts', 'v');
    writeFile('.hidden.ts', 'h');
    const result = walkAuditPath(tmpRoot);
    expect(result.map((p) => path.relative(tmpRoot, p))).toEqual(['visible.ts']);
  });

  it('rejects a symlinked root with AuditPackError', () => {
    const real = writeFile('real.ts', 'x');
    const linkPath = path.join(tmpRoot, 'link.ts');
    try {
      fs.symlinkSync(real, linkPath);
    } catch {
      // Skip on platforms where symlink creation needs admin (Windows CI)
      return;
    }
    expect(() => walkAuditPath(linkPath)).toThrow(AuditPackError);
  });

  it('does not follow symlinks during directory recursion', () => {
    const realDir = path.join(tmpRoot, 'real');
    fs.mkdirSync(realDir);
    writeFile('real/keep.ts', 'k');
    const outsideDir = path.join(os.tmpdir(), 'chorus-audit-outside-' + randomUUID());
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'leak.ts'), 'leak');
    try {
      fs.symlinkSync(outsideDir, path.join(tmpRoot, 'evil'));
    } catch {
      fs.rmSync(outsideDir, { recursive: true, force: true });
      return;
    }
    const result = walkAuditPath(tmpRoot);
    const rels = result.map((p) => path.relative(tmpRoot, p));
    expect(rels).toContain('real/keep.ts');
    expect(rels.some((r) => r.startsWith('evil/'))).toBe(false);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});

describe('assembleAuditArtifact', () => {
  it('builds a markdown artifact with file headers and language hints', () => {
    const a = writeFile('foo.ts', 'export const x = 1;\nexport const y = 2;\n');
    const b = writeFile('bar/baz.py', 'def f():\n    return 1\n');
    const result = assembleAuditArtifact(tmpRoot, [a, b], { scope: 'test-scope' });

    expect(result.artifact).toContain('# Audit: test-scope');
    expect(result.artifact).toContain('## `foo.ts`');
    expect(result.artifact).toContain('## `bar/baz.py`');
    expect(result.artifact).toContain('```ts');
    expect(result.artifact).toContain('```py');
    expect([...result.filesIncluded].sort()).toEqual(['bar/baz.py', 'foo.ts']);
  });

  it('injects focus paragraph when provided', () => {
    const a = writeFile('foo.ts', 'x');
    const result = assembleAuditArtifact(tmpRoot, [a], {
      scope: 's',
      focusParagraph: 'CUSTOM-FOCUS-MARKER',
    });
    expect(result.artifact).toContain('CUSTOM-FOCUS-MARKER');
  });

  it('omits focus block when undefined', () => {
    const a = writeFile('foo.ts', 'x');
    const result = assembleAuditArtifact(tmpRoot, [a], { scope: 's' });
    expect(result.artifact).not.toContain('Focus on');
  });

  it('skips files whose extension is not in the allowlist', () => {
    const ts = writeFile('foo.ts', 'x');
    const config = writeFile('config.json', '{}');
    const png = writeFile('logo.png', 'binary');
    const result = assembleAuditArtifact(tmpRoot, [ts, config, png], { scope: 's' });

    // .ts and .json IS in the allowlist; .png is not. Lockfile name-
    // based exclusion is exercised by its own dedicated test below.
    expect(result.filesIncluded).toContain('foo.ts');
    expect(result.filesIncluded).toContain('config.json');
    expect(result.filesSkipped.some((s) => s.includes('logo.png'))).toBe(true);
  });

  it('throws no_files_matched when input list is empty', () => {
    expect(() => assembleAuditArtifact(tmpRoot, [], { scope: 's' })).toThrow(AuditPackError);
  });

  it('throws no_files_matched when all files fail allowlist', () => {
    const png = writeFile('a.png', 'b');
    const jpg = writeFile('b.jpg', 'b');
    expect(() =>
      assembleAuditArtifact(tmpRoot, [png, jpg], { scope: 's' }),
    ).toThrow(AuditPackError);
  });

  it('throws too_many_files when file count exceeds AUDIT_MAX_FILES', () => {
    const files: string[] = [];
    for (let i = 0; i < AUDIT_MAX_FILES + 1; i++) {
      files.push(writeFile(`f${i}.ts`, 'x'));
    }
    expect(() => assembleAuditArtifact(tmpRoot, files, { scope: 's' }))
      .toThrow(/cap is 50/);
  });

  it('throws too_many_bytes when content would exceed total cap', () => {
    // Build a single file just over the cap.
    const big = 'x'.repeat(AUDIT_MAX_TOTAL_BYTES + 100);
    const file = writeFile('big.ts', big);
    expect(() => assembleAuditArtifact(tmpRoot, [file], { scope: 's' }))
      .toThrow(/byte cap/);
  });

  it('truncates files over AUDIT_MAX_FILE_LINES with elision marker', () => {
    const totalLines = AUDIT_MAX_FILE_LINES + 100;
    const lastLineIdx = totalLines - 1;
    const lines = Array.from({ length: totalLines }, (_, i) => `line ${i}`);
    const file = writeFile('long.ts', lines.join('\n'));
    const result = assembleAuditArtifact(tmpRoot, [file], { scope: 's' });

    expect(result.artifact).toContain('truncated');
    // Pin the exact elision count so a regression in truncateFileBody
    // arithmetic gets caught instead of passing under the loose
    // [\d+ lines elided] match.
    expect(result.artifact).toMatch(/\[100 lines elided\]/);
    expect(result.artifact).toMatch(/^line 0$/m);
    expect(result.artifact).toMatch(new RegExp(`^line ${lastLineIdx}$`, 'm'));
    // Middle lines must be gone. With HEAD=1500 (lines 0-1499) and
    // TAIL=500 (lines 1600-2099), the elided block is lines 1500-1599.
    // Pick a line solidly inside that range. Convergent self-review
    // (gemini-cli-1) flagged the missing negative assertion.
    expect(result.artifact).not.toContain('line 1550');
  });

  it('records skipped extensions in the trailing skipped section', () => {
    const ts = writeFile('foo.ts', 'x');
    const png = writeFile('logo.png', 'b');
    const result = assembleAuditArtifact(tmpRoot, [ts, png], { scope: 's' });

    expect(result.artifact).toContain('**Skipped');
    expect(result.artifact).toContain('logo.png');
  });

  it('rejects files outside rootAbs as path-traversal', () => {
    // Pinned by self-review: assembleAuditArtifact's docstring promised
    // "Files outside rootAbs are rejected" but the prior revision had
    // no implementation. A direct caller passing /etc/passwd with a
    // tmp rootAbs would have leaked it into the artifact. Now: throws.
    const inside = writeFile('foo.ts', 'x');
    const outsideDir = path.join(os.tmpdir(), 'chorus-audit-outside-' + randomUUID());
    fs.mkdirSync(outsideDir, { recursive: true });
    const outside = path.join(outsideDir, 'leak.ts');
    fs.writeFileSync(outside, 'leak');
    try {
      expect(() =>
        assembleAuditArtifact(tmpRoot, [inside, outside], { scope: 's' }),
      ).toThrow(/outside the audit root/);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('drops lockfiles by name even when extension is allowlisted', () => {
    // .json, .yaml, .yml all pass the extension allowlist, but
    // package-lock.json / pnpm-lock.yaml etc. are spec-banned. Pinned
    // by self-review: 3 reviewers flagged the spec-vs-code drift.
    const ts = writeFile('foo.ts', 'x');
    const npmLock = writeFile('package-lock.json', '{}');
    const pnpmLock = writeFile('pnpm-lock.yaml', 'lockfileVersion: 6');
    const yarnLock = writeFile('yarn.lock', '# yarn');
    const result = assembleAuditArtifact(
      tmpRoot,
      [ts, npmLock, pnpmLock, yarnLock],
      { scope: 's' },
    );
    expect(result.filesIncluded).toEqual(['foo.ts']);
    expect(result.filesSkipped.some((s) => s.includes('package-lock.json'))).toBe(true);
    expect(result.filesSkipped.some((s) => s.includes('pnpm-lock.yaml'))).toBe(true);
    expect(result.filesSkipped.some((s) => s.includes('yarn.lock'))).toBe(true);
  });

  it('walkAuditPath drops lockfiles during directory recursion', () => {
    writeFile('keep.ts', 'x');
    writeFile('package-lock.json', '{}');
    writeFile('pnpm-lock.yaml', 'lock');
    const result = walkAuditPath(tmpRoot);
    expect(result.map((p) => path.relative(tmpRoot, p))).toEqual(['keep.ts']);
  });

  it('totalBytes equals the actual artifact body size (header + fences included)', () => {
    // Convergent self-review (4/8 reviewers) flagged that counting only
    // the raw file body underreports artifact size. totalBytes must
    // reflect what's actually being POSTed.
    const a = writeFile('foo.ts', 'AAA');
    const b = writeFile('bar.py', 'BBB');
    const result = assembleAuditArtifact(tmpRoot, [a, b], { scope: 's' });

    // Sum of per-file block sizes. The artifact contains other framing
    // (heading, skip-note, separators) outside the per-file blocks,
    // so totalBytes lives below artifact.length but above raw-body sum.
    const rawBodySum = Buffer.byteLength('AAA', 'utf-8') + Buffer.byteLength('BBB', 'utf-8');
    expect(result.totalBytes).toBeGreaterThan(rawBodySum);
    expect(result.totalBytes).toBeLessThan(Buffer.byteLength(result.artifact, 'utf-8'));
  });

  it('handles symlinks by skipping (read failure) without throwing', () => {
    const real = writeFile('real.ts', 'x');
    const linkPath = path.join(tmpRoot, 'link.ts');
    try {
      fs.symlinkSync(real, linkPath);
    } catch {
      return;
    }
    // Caller (walkAuditPath) doesn't include symlinks; if one slips into
    // the file list manually, readFileSafe returns null and it's surfaced
    // as skipped — verify by passing the link directly.
    const result = assembleAuditArtifact(tmpRoot, [real, linkPath], { scope: 's' });
    // The real file lands in includes; the symlink lands in skipped.
    expect(result.filesIncluded).toContain('real.ts');
    expect(result.filesSkipped.some((s) => s.includes('link.ts'))).toBe(true);
  });
});

describe('focusParagraph', () => {
  it('returns the canonical text for each known focus', () => {
    expect(focusParagraph('security')).toContain('authentication');
    expect(focusParagraph('correctness')).toContain('off-by-one');
    expect(focusParagraph('performance')).toContain('N+1');
    expect(focusParagraph('maintainability')).toContain('maintainers');
  });

  it('returns undefined for "all" / "" / undefined', () => {
    expect(focusParagraph('all')).toBeUndefined();
    expect(focusParagraph('')).toBeUndefined();
    expect(focusParagraph(undefined as unknown as string)).toBeUndefined();
  });

  it('passes through unknown free-form focus values', () => {
    expect(focusParagraph('custom-thing')).toBe('custom-thing');
  });
});

describe('buildAuditWork', () => {
  it('includes scope label and verdict instruction', () => {
    const work = buildAuditWork('my-scope', undefined);
    expect(work).toContain('scope: my-scope');
    expect(work).toContain('approve');
    expect(work).toContain('request changes');
  });

  it('includes the focus paragraph when provided', () => {
    const work = buildAuditWork('s', 'FOCUS-X');
    expect(work).toContain('FOCUS-X');
  });

  it('omits a focus section when none provided', () => {
    const work = buildAuditWork('s', undefined);
    expect(work).not.toContain('Focus on');
  });
});
