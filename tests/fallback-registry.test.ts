/**
 * Per-chat/round in-flight fallback registry tests.
 *
 * The registry prevents two reviewer slots from picking the same
 * (lineage, model) target in parallel — the bug that surfaced
 * 2026-05-08 when a gemini slot AND an opencode/kimi slot both fell
 * back to anthropic/claude-sonnet-4-6 on the same run.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  tryClaim,
  release,
  resetRound,
  snapshot,
  _testing,
} from '@/daemon/runner/fallback-registry';

beforeEach(() => {
  _testing.reset();
});

describe('tryClaim', () => {
  it('first claim wins', () => {
    expect(tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6')).toBe(true);
  });

  it('second simultaneous claim of same target loses', () => {
    expect(tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6')).toBe(true);
    expect(tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6')).toBe(false);
  });

  it('different chat scopes do not collide', () => {
    expect(tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6')).toBe(true);
    expect(tryClaim('chat-2', 1, 'anthropic', 'claude-sonnet-4-6')).toBe(true);
  });

  it('different rounds in same chat do not collide', () => {
    // Round 2 reviewers are a fresh fan-out; their claims must be
    // independent of round 1's already-completed reviewers.
    expect(tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6')).toBe(true);
    expect(tryClaim('chat-1', 2, 'anthropic', 'claude-sonnet-4-6')).toBe(true);
  });

  it('different models in same lineage do not collide', () => {
    expect(tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6')).toBe(true);
    expect(tryClaim('chat-1', 1, 'anthropic', 'claude-haiku-4-5')).toBe(true);
  });

  it('lineage default (undefined model) gets its own canonical key', () => {
    // Two slots both falling through to the lineage default should
    // still collide — they'd dispatch to the same default model.
    expect(tryClaim('chat-1', 1, 'opencode', undefined)).toBe(true);
    expect(tryClaim('chat-1', 1, 'opencode', undefined)).toBe(false);
  });

  it('default and explicit model in same lineage are distinct keys', () => {
    expect(tryClaim('chat-1', 1, 'opencode', undefined)).toBe(true);
    expect(tryClaim('chat-1', 1, 'opencode', 'opencode-go/kimi-k2.6')).toBe(true);
  });
});

describe('release', () => {
  it('claimable again after release', () => {
    expect(tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6')).toBe(true);
    release('chat-1', 1, 'anthropic', 'claude-sonnet-4-6');
    expect(tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6')).toBe(true);
  });

  it('releasing an unclaimed target is a no-op', () => {
    // Defensive: a panic inside the attempt() may double-release on
    // the way out. Must not throw.
    release('chat-1', 1, 'anthropic', 'never-claimed');
    expect(tryClaim('chat-1', 1, 'anthropic', 'never-claimed')).toBe(true);
  });

  it('releasing one slot does not affect others', () => {
    expect(tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6')).toBe(true);
    expect(tryClaim('chat-1', 1, 'google', 'gemini-2.5-pro')).toBe(true);
    release('chat-1', 1, 'anthropic', 'claude-sonnet-4-6');
    // gemini still in flight
    expect(tryClaim('chat-1', 1, 'google', 'gemini-2.5-pro')).toBe(false);
    // anthropic free again
    expect(tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6')).toBe(true);
  });
});

describe('resetRound', () => {
  it('clears every claim for the given chat/round', () => {
    tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6');
    tryClaim('chat-1', 1, 'google', 'gemini-2.5-pro');
    resetRound('chat-1', 1);
    expect(tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6')).toBe(true);
    expect(tryClaim('chat-1', 1, 'google', 'gemini-2.5-pro')).toBe(true);
  });

  it('does not affect other chats or rounds', () => {
    tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6');
    tryClaim('chat-1', 2, 'anthropic', 'claude-sonnet-4-6');
    tryClaim('chat-2', 1, 'anthropic', 'claude-sonnet-4-6');
    resetRound('chat-1', 1);
    expect(tryClaim('chat-1', 2, 'anthropic', 'claude-sonnet-4-6')).toBe(false);
    expect(tryClaim('chat-2', 1, 'anthropic', 'claude-sonnet-4-6')).toBe(false);
  });
});

describe('release: opportunistic parent-Map cleanup', () => {
  it('parent map drops the round entry when all claims are released', () => {
    tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6');
    tryClaim('chat-1', 1, 'google', 'gemini-2.5-pro');
    expect(Object.keys(snapshot())).toContain('chat-1:1');
    release('chat-1', 1, 'anthropic', 'claude-sonnet-4-6');
    // One claim still held — entry survives.
    expect(Object.keys(snapshot())).toContain('chat-1:1');
    release('chat-1', 1, 'google', 'gemini-2.5-pro');
    // All released — round entry is gone, no empty-Set leak.
    expect(Object.keys(snapshot())).not.toContain('chat-1:1');
  });
});

describe('snapshot', () => {
  it('exposes currently in-flight tags for diagnostics', () => {
    tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6');
    tryClaim('chat-1', 1, 'google', 'gemini-2.5-pro');
    tryClaim('chat-2', 1, 'opencode', 'opencode-go/kimi-k2.6');
    const snap = snapshot();
    expect(snap['chat-1:1']).toEqual(
      expect.arrayContaining([
        'anthropic:claude-sonnet-4-6',
        'google:gemini-2.5-pro',
      ]),
    );
    expect(snap['chat-2:1']).toEqual(['opencode:opencode-go/kimi-k2.6']);
  });

  it('returns empty when nothing claimed', () => {
    expect(snapshot()).toEqual({});
  });
});

describe('user-reported scenario: two slots both falling back to claude-sonnet-4-6', () => {
  // Reproduces the exact incident from 2026-05-08 — gemini slot and
  // opencode/kimi slot both saw their primaries fail and tried to
  // dispatch the template fallback `anthropic/claude-sonnet-4-6` at
  // the same time. Pre-fix: both ran. Post-fix: only one wins; the
  // other gets `false` and the reviewer-driver advances its chain.
  it('only one reviewer claims the shared fallback target', () => {
    // Both slots' chains end with the same template fallback
    const slotA_claimed = tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6');
    const slotB_claimed = tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6');
    expect(slotA_claimed).toBe(true);
    expect(slotB_claimed).toBe(false);
    // Slot B's reviewer-driver would now advance to next chain entry
    // (or terminal-fail if no more diverse entries). Either way, no
    // duplicate claude-sonnet-4-6 reviewer fires.
  });

  it('slot B can claim the same target after slot A releases on failure', () => {
    // Per the new caller contract (reviewer-driver.ts), release fires
    // ONLY when slot A's attempt failed (returned null or threw). The
    // registry itself remains a simple in-flight tracker — its
    // release() behaviour is unchanged; the caller just decides when
    // to invoke it.
    expect(tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6')).toBe(true);
    expect(tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6')).toBe(false);
    release('chat-1', 1, 'anthropic', 'claude-sonnet-4-6');
    // Slot A failed — slot B is allowed to try this target since the
    // failure was a model-state problem, not a "model already covered"
    // condition.
    expect(tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6')).toBe(true);
  });

  it('sequential collision: slot A succeeds → slot B blocked all round', () => {
    // The 2026-05-14 incident — daemon-wide CLI semaphore serialised
    // reviewer dispatch, so slot A finished claude-sonnet-4-6 first
    // and released BEFORE slot B advanced its chain to the same
    // target. Pre-fix: B re-claimed and produced a duplicate output.
    // Post-fix: the caller only releases on failure; a successful
    // run holds the claim through the round.
    expect(tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6')).toBe(true);
    // Simulate the new caller behaviour: NO release because the
    // attempt succeeded. Slot B advancing its chain hits the same
    // target later in the round and gets back false → advances.
    expect(tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6')).toBe(false);
    expect(tryClaim('chat-1', 1, 'anthropic', 'claude-sonnet-4-6')).toBe(false);
    // resetRound at phase boundary clears the claim for round 2.
    resetRound('chat-1', 1);
    expect(tryClaim('chat-1', 2, 'anthropic', 'claude-sonnet-4-6')).toBe(true);
  });
});
