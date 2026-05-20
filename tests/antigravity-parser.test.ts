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

  it('drops empty lines so the accumulator does not stutter', () => {
    // The CLI's plain-text output uses blank lines for paragraph breaks.
    // spawnHeadless strips trailing \n; an empty string post-strip means
    // the original line was just \n. We restore via the next non-empty
    // line's trailing newline rather than appending a bare \n token.
    expect(parseAntigravity('')).toEqual([]);
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
  it('returns [] on clean exit (code 0)', () => {
    expect(parseAntigravityExit('out', '', 0)).toEqual([]);
  });

  it('classifies quota-exhausted stderr to quota_exhausted', () => {
    const stderr =
      'ERROR: 429 quota exhausted on gemini-3.5-flash this period';
    const events = parseAntigravityExit('', stderr, 1);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    if (events[0].type === 'error') {
      expect(events[0].kind).toBe('quota_exhausted');
      expect(events[0].message).toContain('quota');
    }
  });

  it('classifies resource-exhausted variant as quota_exhausted', () => {
    const stderr = 'RESOURCE_EXHAUSTED: rate limit hit';
    const events = parseAntigravityExit('', stderr, 1);
    expect(events).toHaveLength(1);
    if (events[0].type === 'error') {
      expect(events[0].kind).toBe('quota_exhausted');
    }
  });

  it('classifies missing OAuth token as auth_missing', () => {
    const stderr =
      'ERROR: antigravity-oauth-token not found — please login via `agy`';
    const events = parseAntigravityExit('', stderr, 1);
    expect(events).toHaveLength(1);
    if (events[0].type === 'error') {
      expect(events[0].kind).toBe('auth_missing');
    }
  });

  it('classifies sign-in prompt as auth_missing', () => {
    const stderr = 'Please sign in to continue. OAuth required.';
    const events = parseAntigravityExit('', stderr, 1);
    expect(events).toHaveLength(1);
    if (events[0].type === 'error') {
      expect(events[0].kind).toBe('auth_missing');
    }
  });

  it('classifies 401 unauthorized as auth_invalid', () => {
    const stderr = 'Error: 401 Unauthorized — token expired';
    const events = parseAntigravityExit('', stderr, 1);
    expect(events).toHaveLength(1);
    if (events[0].type === 'error') {
      expect(events[0].kind).toBe('auth_invalid');
    }
  });

  it('classifies 403 forbidden as auth_invalid', () => {
    const stderr = 'Error: 403 Forbidden — token revoked';
    const events = parseAntigravityExit('', stderr, 1);
    expect(events).toHaveLength(1);
    if (events[0].type === 'error') {
      expect(events[0].kind).toBe('auth_invalid');
    }
  });

  it('strips ANSI escape sequences before pattern matching', () => {
    // Real ERROR lines from CLI tools are colour-decorated. Without the
    // ANSI strip in parseAntigravityExit, this would fall through to the
    // generic cli_error bucket instead of quota_exhausted.
    const stderr = '\x1b[31mERROR:\x1b[0m 429 quota exhausted';
    const events = parseAntigravityExit('', stderr, 1);
    expect(events).toHaveLength(1);
    if (events[0].type === 'error') {
      expect(events[0].kind).toBe('quota_exhausted');
    }
  });

  it('falls back to cli_error with stderr tail when no pattern matches', () => {
    const stderr = 'Unexpected internal error: panic in goroutine';
    const events = parseAntigravityExit('', stderr, 1);
    expect(events).toHaveLength(1);
    if (events[0].type === 'error') {
      expect(events[0].kind).toBe('cli_error');
      expect(events[0].message).toContain('panic');
    }
  });

  it('falls back with a default message when stderr is empty', () => {
    const events = parseAntigravityExit('', '', 1);
    expect(events).toHaveLength(1);
    if (events[0].type === 'error') {
      expect(events[0].kind).toBe('cli_error');
      expect(events[0].message).toContain('exited with code 1');
    }
  });
});
