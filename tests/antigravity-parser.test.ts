/**
 * Antigravity CLI (`agy`) parser tests.
 *
 * agy 1.0.0 has no structured output mode — stdout is plain UTF-8 text.
 * parseAntigravity treats each non-empty line as a text_delta with a
 * trailing newline restored (spawnHeadless strips the \n). parseAntigravityExit
 * pattern-matches stderr on non-zero exits.
 *
 * Happy-path text shape: empirically probed 2026-05-20 against agy 1.0.0
 * on a Google AI Pro subscription. Error patterns are derived from the
 * agy --help error catalog + Google AI Pro docs (auth flow not directly
 * reproducible without revoking the user's token).
 */

import { describe, expect, it } from 'vitest';
import {
  parseAntigravity,
  parseAntigravityExit,
} from '@/daemon/agents/parsers/antigravity';

describe('parseAntigravity — text streaming', () => {
  it('emits a text_delta with a restored newline for each non-empty line', () => {
    expect(parseAntigravity('hello world')).toEqual([
      { type: 'text_delta', text: 'hello world\n' },
    ]);
  });

  it('preserves paragraph breaks — empty line emits a bare \\n', () => {
    // The CLI's plain-text output uses blank lines for paragraph breaks.
    // spawnHeadless splits on \n: "para1\n\npara2" → ["para1", "", "para2"].
    // The empty middle MUST emit \n; returning [] collapsed every
    // multi-paragraph response into one block (PR #62 self-review caught
    // this — 5/8 reviewers flagged it as data corruption).
    expect(parseAntigravity('')).toEqual([{ type: 'text_delta', text: '\n' }]);
  });

  it('preserves paragraph structure across an empty line', () => {
    // End-to-end shape: "Hello\n\nWorld" should accumulate exactly as written.
    const a = parseAntigravity('Hello');
    const b = parseAntigravity('');
    const c = parseAntigravity('World');
    const joined = [...a, ...b, ...c]
      .filter((e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(joined).toBe('Hello\n\nWorld\n');
  });

  it('preserves whitespace inside the line (markdown / indented code)', () => {
    expect(parseAntigravity('  - bullet item')).toEqual([
      { type: 'text_delta', text: '  - bullet item\n' },
    ]);
  });

  it('handles unicode (emoji + non-ascii) without mangling', () => {
    expect(parseAntigravity('résumé 🚀')).toEqual([
      { type: 'text_delta', text: 'résumé 🚀\n' },
    ]);
  });
});

describe('parseAntigravityExit — error classification', () => {
  // Helper that asserts the canonical {length:1, type:'error', kind:X}
  // shape WITHOUT a type-guard wrapper. Self-review (PR #62, 2/8 reviewers)
  // flagged the original `if (events[0].type === 'error')` pattern as
  // vacuous: a future regression that returned `text_delta` instead of
  // `error` would silently pass because the if-block would never run.
  // Now: type is asserted unconditionally, kind is read via narrowing
  // after the assert (TS still requires the narrow for the kind read).
  function assertError(
    events: ReturnType<typeof parseAntigravityExit>,
    expectedKind: string,
  ): { type: 'error'; kind: string; message: string } {
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    if (events[0].type !== 'error') {
      throw new Error('unreachable — preceding expect failed');
    }
    expect(events[0].kind).toBe(expectedKind);
    return events[0];
  }

  it('returns [] on clean exit (code 0)', () => {
    expect(parseAntigravityExit('out', '', 0)).toEqual([]);
  });

  it('treats signal-kill (code=null) as cli_error with explicit message', () => {
    // Node yields code=null when a child is killed by signal (timeout,
    // chat cancel, SIGKILL). The fallback would otherwise emit "exited
    // with code null" — meaningless to users.
    const err = assertError(parseAntigravityExit('', '', null), 'cli_error');
    expect(err.message).toMatch(/killed by signal/);
  });

  it('classifies quota-exhausted stderr to quota_exhausted', () => {
    const err = assertError(
      parseAntigravityExit('', 'ERROR: 429 quota exhausted on gemini-3.5-flash this period', 1),
      'quota_exhausted',
    );
    expect(err.message).toContain('quota');
  });

  it('classifies "quota exceeded" (Google variant) as quota_exhausted', () => {
    assertError(
      parseAntigravityExit('', 'ERROR: Your quota exceeded for this period', 1),
      'quota_exhausted',
    );
  });

  it('classifies resource-exhausted variant as quota_exhausted', () => {
    assertError(
      parseAntigravityExit('', 'RESOURCE_EXHAUSTED: rate limit hit', 1),
      'quota_exhausted',
    );
  });

  it('classifies "rate-limit" phrasing as quota_exhausted', () => {
    assertError(
      parseAntigravityExit('', 'ERROR: rate-limit reached on flash-3.5', 1),
      'quota_exhausted',
    );
  });

  it('does not match 429 as substring (e.g. inside 14290)', () => {
    // \b429\b prevents false positive on numbers like 14290, 4291, etc.
    assertError(
      parseAntigravityExit('', 'connection failed on port 14290', 1),
      'cli_error',
    );
  });

  it('classifies missing OAuth token as auth_missing', () => {
    assertError(
      parseAntigravityExit('', 'ERROR: antigravity-oauth-token not found — please login via `agy`', 1),
      'auth_missing',
    );
  });

  it('classifies sign-in prompt as auth_missing', () => {
    assertError(
      parseAntigravityExit('', 'Please sign in to continue. OAuth required.', 1),
      'auth_missing',
    );
  });

  it('tightened auth pattern does NOT match unrelated "login" mentions', () => {
    // Self-review flagged that `please.*login` matched
    // "please don't login to third-party services". Tightened regex
    // requires `please (run )?(agy )?login` adjacency.
    assertError(
      parseAntigravityExit('', 'Note: please contact admin for login credentials', 1),
      'cli_error',
    );
  });

  it('classifies 401 unauthorized as auth_invalid', () => {
    assertError(
      parseAntigravityExit('', 'Error: 401 Unauthorized — token expired', 1),
      'auth_invalid',
    );
  });

  it('classifies 403 forbidden as auth_invalid', () => {
    assertError(
      parseAntigravityExit('', 'Error: 403 Forbidden — token revoked', 1),
      'auth_invalid',
    );
  });

  it('classifies "invalid token" (space-separated) as auth_invalid', () => {
    // Self-review caught that `invalid[_-]token` missed the
    // human-readable phrasing.
    assertError(
      parseAntigravityExit('', 'Error: invalid token from upstream', 1),
      'auth_invalid',
    );
  });

  it('strips ANSI SGR sequences before pattern matching', () => {
    assertError(
      parseAntigravityExit('', '\x1b[31mERROR:\x1b[0m 429 quota exhausted', 1),
      'quota_exhausted',
    );
  });

  it('strips ANSI cursor / line-erase sequences (broader regex)', () => {
    // Broader stripper handles SGR + CSI cursor codes. Without it, a
    // cursor-hide sequence would leave embedded chars and break the
    // quota match.
    assertError(
      parseAntigravityExit('', '\x1b[?25l\x1b[2KError: quota exhausted\x1b[?25h', 1),
      'quota_exhausted',
    );
  });

  it('falls back to cli_error with stderr tail when no pattern matches', () => {
    const err = assertError(
      parseAntigravityExit('', 'Unexpected internal error: panic in goroutine', 1),
      'cli_error',
    );
    expect(err.message).toContain('panic');
  });

  it('falls back with a default message when stderr is empty', () => {
    const err = assertError(parseAntigravityExit('', '', 1), 'cli_error');
    expect(err.message).toContain('exited with code 1');
  });
});
