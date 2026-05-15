/**
 * Grok Build streaming-json parser tests.
 *
 * Schema reference: ~/.grok/docs/user-guide/13-headless-mode.md
 * (Grok 0.1.210, captured 2026-05-15).
 *
 * Without a SuperGrok Heavy subscription we can't observe real `text`/`end`
 * events at runtime, so these fixtures are constructed from the official
 * spec. The error/exit paths ARE empirically verified — that's the failure
 * mode unpaid users actually hit.
 */

import { describe, expect, it } from 'vitest';
import { parseGrok, parseGrokExit } from '@/daemon/agents/parsers/grok';

describe('parseGrok — happy path (schema-spec)', () => {
  it('emits text_delta for {"type":"text","data":"..."}', () => {
    const events = parseGrok('{"type":"text","data":"Hello, "}');
    expect(events).toEqual([{ type: 'text_delta', text: 'Hello, ' }]);
  });

  it('preserves multiple sequential text events', () => {
    const a = parseGrok('{"type":"text","data":"Hello"}');
    const b = parseGrok('{"type":"text","data":" world"}');
    expect(a).toEqual([{ type: 'text_delta', text: 'Hello' }]);
    expect(b).toEqual([{ type: 'text_delta', text: ' world' }]);
  });

  it('drops empty text data — no zero-length text_delta noise', () => {
    expect(parseGrok('{"type":"text","data":""}')).toEqual([]);
  });

  it('drops thought events (internal reasoning) — they aren\'t part of answer.md', () => {
    expect(parseGrok('{"type":"thought","data":"Analyzing..."}')).toEqual([]);
  });

  it('emits message_done on end event with empty finalText (runner accumulator wins)', () => {
    const events = parseGrok(
      '{"type":"end","stopReason":"EndTurn","sessionId":"abc","requestId":"xyz"}',
    );
    expect(events).toEqual([{ type: 'message_done', finalText: '' }]);
  });
});

describe('parseGrok — error path (empirically verified 2026-05-15)', () => {
  it('classifies SuperGrok subscription error as quota_exhausted', () => {
    const line = JSON.stringify({
      type: 'error',
      message:
        'Internal error: {\n  "message": "API error (status 403 Forbidden): SuperGrok Heavy subscription required",\n  "http_status": 403\n}',
    });
    const events = parseGrok(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    if (events[0].type === 'error') {
      expect(events[0].kind).toBe('quota_exhausted');
    }
  });

  it('classifies bare 403 as auth_invalid', () => {
    const line = JSON.stringify({
      type: 'error',
      message: 'API error (status 403 Forbidden): unknown',
    });
    const events = parseGrok(line);
    // Length assertion first — without it, an empty events array would
    // make the type-narrowing guard below silently skip the kind check.
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    if (events[0].type === 'error') {
      expect(events[0].kind).toBe('auth_invalid');
    }
  });

  it('uses generic kind for unknown error shapes', () => {
    const line = JSON.stringify({
      type: 'error',
      message: 'Network timeout',
    });
    const events = parseGrok(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    if (events[0].type === 'error') {
      expect(events[0].kind).toBe('grok_stream_error');
    }
  });

  it('handles error with non-string message gracefully', () => {
    // Defensive: spec says message is a string, but a future Grok bump
    // could emit something different. Don't crash.
    const events = parseGrok('{"type":"error","message":null}');
    expect(events).toHaveLength(1);
    if (events[0].type === 'error') {
      expect(events[0].message).toBe('Grok stream error');
    }
  });
});

describe('parseGrok — robustness', () => {
  it('returns empty on non-JSON input', () => {
    expect(parseGrok('not json')).toEqual([]);
  });

  it('returns empty on null/undefined-shaped JSON', () => {
    expect(parseGrok('null')).toEqual([]);
    expect(parseGrok('"string"')).toEqual([]);
    expect(parseGrok('42')).toEqual([]);
  });

  it('returns empty on unknown type discriminators', () => {
    expect(parseGrok('{"type":"unexpected","payload":"x"}')).toEqual([]);
  });

  it('returns empty on missing type field', () => {
    expect(parseGrok('{"data":"orphan"}')).toEqual([]);
  });
});

describe('parseGrokExit — stderr classification', () => {
  it('no events on exit code 0', () => {
    expect(parseGrokExit('', '', 0)).toEqual([]);
  });

  it('detects SuperGrok Heavy subscription pattern in stderr (with ANSI)', () => {
    // Real stderr observed empirically 2026-05-15 — includes ANSI color codes.
    const stderr =
      '\x1b[2m2026-05-15T07:38:38.066871Z\x1b[0m \x1b[31mERROR\x1b[0m responses API error \x1b[3mstatus\x1b[0m\x1b[2m=\x1b[0m403 Forbidden \x1b[3merror_message\x1b[0m\x1b[2m=\x1b[0mSuperGrok Heavy subscription required';
    const events = parseGrokExit('', stderr, 1);
    expect(events).toHaveLength(1);
    if (events[0].type === 'error') {
      expect(events[0].kind).toBe('quota_exhausted');
      expect(events[0].message).toMatch(/SuperGrok Heavy/);
    }
  });

  it('detects bare 403 Forbidden in stderr as auth_invalid', () => {
    const stderr = 'ERROR HTTP 403 Forbidden';
    const events = parseGrokExit('', stderr, 1);
    expect(events).toHaveLength(1);
    if (events[0].type === 'error') {
      expect(events[0].kind).toBe('auth_invalid');
    }
  });

  it('detects browser-OAuth attempt as auth_missing', () => {
    // Defensive: chorus's precheck SHOULD prevent grok from reaching
    // this branch (auth file is checked first). But if the daemon
    // bypasses precheck somehow, we catch the browser-flow attempt
    // and surface it cleanly instead of letting the daemon hang.
    const stderr =
      'Signing in with Grok...\n\nOpen this URL to sign in:\n  https://auth.x.ai/oauth2/...';
    const events = parseGrokExit('', stderr, 1);
    expect(events).toHaveLength(1);
    if (events[0].type === 'error') {
      expect(events[0].kind).toBe('auth_missing');
    }
  });

  it('returns empty when stderr does not match any known pattern (non-zero exit)', () => {
    // Generic exit code with unrecognised stderr — the higher-level
    // spawn machinery surfaces the raw exit code; the parser stays
    // silent.
    expect(parseGrokExit('', 'some unrelated error', 1)).toEqual([]);
  });
});
