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

  it('walks a directory recursively, sorted', () => {
    writeFile('a/one.ts', 'a');
    writeFile('b/two.ts', 'b');
    writeFile('c.ts', 'c');
    const result = walkAuditPath(tmpRoot);
    const rels = result.map((p) => path.relative(tmpRoot, p)).sort();
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
    const lock = writeFile('package-lock.json', '{}');
    const png = writeFile('logo.png', 'binary');
    const result = assembleAuditArtifact(tmpRoot, [ts, lock, png], { scope: 's' });

    // JSON IS in the allowlist, png + lock-by-name is not (lock IS json
    // ext though — package-lock.json passes the allowlist by extension).
    expect(result.filesIncluded).toContain('foo.ts');
    expect(result.filesIncluded).toContain('package-lock.json');
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
    const lines = Array.from({ length: AUDIT_MAX_FILE_LINES + 100 }, (_, i) => `line ${i}`);
    const file = writeFile('long.ts', lines.join('\n'));
    const result = assembleAuditArtifact(tmpRoot, [file], { scope: 's' });

    expect(result.artifact).toContain('truncated');
    expect(result.artifact).toMatch(/\[\d+ lines elided\]/);
    // Head must contain early lines
    expect(result.artifact).toContain('line 0');
    expect(result.artifact).toContain(`line ${AUDIT_MAX_FILE_LINES - 1 + 100}`); // last line
  });

  it('records skipped extensions in the trailing skipped section', () => {
    const ts = writeFile('foo.ts', 'x');
    const png = writeFile('logo.png', 'b');
    const result = assembleAuditArtifact(tmpRoot, [ts, png], { scope: 's' });

    expect(result.artifact).toContain('**Skipped');
    expect(result.artifact).toContain('logo.png');
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
