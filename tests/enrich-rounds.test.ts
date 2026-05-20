/**
 * enrichRounds — placeholder card synthesis for the run page.
 *
 * The function decorates `rounds` with model lookups and synthesises
 * "pending" placeholder cards for every reviewer candidate the
 * template declares but the runner hasn't spawned a dir for yet.
 * That keeps queued reviewers visible from t=0 instead of having
 * cards appear one-by-one as the daemon-wide CLI semaphore drains
 * (chorus-102).
 */

import { describe, expect, it } from 'vitest';
import { enrichRounds } from '@/components/live-run-real/enrich-rounds';
import type { Template } from '@/lib/types';
import type { RoundSnapshot } from '@/components/run-viewer/types';

function reviewOnlyTemplate(candidates: Array<{ lineage: string; model: string }>): Template {
  return {
    id: 'review-only',
    name: 'Review Only',
    description: '',
    category: 'review',
    phases: [
      {
        id: 'review',
        name: 'review',
        description: '',
        kind: 'review_only',
        gate: 'auto',
        doer: { lineage: 'openai', models: [] },
        reviewer: {
          require: 2,
          crossLineage: true,
          candidates: candidates.map((c) => c.lineage as never),
          candidatesWithModels: candidates.map((c) => ({
            lineage: c.lineage as never,
            models: [c.model],
          })),
        },
        inputs: { include: [], exclude: [] },
        iterate: { max: 1, onMax: 'ask-user' },
        blindSpots: [],
        execution: 'parallel',
        builtin: true,
      },
    ],
    agreementThreshold: 'majority',
    onThresholdMet: 'auto-finalize',
    maxRounds: 1,
    driver: 'external',
    yoloDefault: false,
  } as unknown as Template;
}

const eightReviewerTemplate = reviewOnlyTemplate([
  { lineage: 'openai', model: 'gpt-5.5' },
  { lineage: 'google', model: 'gemini-3.1-pro-preview' },
  { lineage: 'opencode', model: 'opencode-go/deepseek-v4-pro' },
  { lineage: 'opencode', model: 'opencode-go/kimi-k2.6' },
  { lineage: 'opencode', model: 'opencode-go/qwen3.6-plus' },
  { lineage: 'opencode', model: 'opencode-go/minimax-m2.7' },
  { lineage: 'opencode', model: 'opencode-go/mimo-v2.5-pro' },
  { lineage: 'opencode', model: 'opencode-go/glm-5.1' },
]);

describe('enrichRounds', () => {
  it('passes through unchanged when template is null', () => {
    const rounds: RoundSnapshot[] = [
      { round: 1, participants: [] },
    ];
    expect(enrichRounds(rounds, null, {})).toBe(rounds);
  });

  it('synthesises a round-1 with all-pending placeholders when rounds is empty', () => {
    // Reproduction of the "8 reviewers but only N visible" UX bug —
    // before this fix, .map() over empty rounds returned [] and the
    // run page showed no cards until the first reviewer dir landed.
    const enriched = enrichRounds([], eightReviewerTemplate, {});
    expect(enriched).toHaveLength(1);
    expect(enriched[0].round).toBe(1);
    expect(enriched[0].participants).toHaveLength(8);
    for (const p of enriched[0].participants) {
      expect(p.role).toBe('reviewer');
      expect(p.pending).toBe(true);
      expect(p.hasAnswer).toBe(false);
      expect(typeof p.model).toBe('string');
    }
  });

  it('every placeholder carries its declared model so the card can show the badge', () => {
    const enriched = enrichRounds([], eightReviewerTemplate, {});
    const models = enriched[0].participants.map((p) => p.model);
    expect(models).toContain('gpt-5.5');
    expect(models).toContain('gemini-3.1-pro-preview');
    expect(models).toContain('opencode-go/kimi-k2.6');
    expect(models).toContain('opencode-go/glm-5.1');
  });

  it('keeps real participant data and adds placeholders for not-yet-spawned slots', () => {
    const partialRound: RoundSnapshot = {
      round: 1,
      participants: [
        {
          participant: 'reviewer-codex-cli-0',
          role: 'reviewer',
          agentName: 'codex-cli',
          lineage: 'codex',
          hasAnswer: true,
          answer: 'lgtm',
        },
      ],
    };
    const enriched = enrichRounds([partialRound], eightReviewerTemplate, {});
    expect(enriched[0].participants).toHaveLength(8);
    const real = enriched[0].participants.find((p) => p.participant === 'reviewer-codex-cli-0');
    expect(real?.pending).toBeUndefined();
    expect(real?.hasAnswer).toBe(true);
    const pendingCount = enriched[0].participants.filter((p) => p.pending).length;
    expect(pendingCount).toBe(7);
  });

  it('does not synthesise round-1 when chat already has rounds (e.g. multi-round)', () => {
    // Defensive: if rounds is non-empty, the existing per-round loop
    // owns synthesis. The seed-empty branch must not double up.
    const r1: RoundSnapshot = { round: 1, participants: [] };
    const r2: RoundSnapshot = { round: 2, participants: [] };
    const enriched = enrichRounds([r1, r2], eightReviewerTemplate, {});
    expect(enriched).toHaveLength(2);
    expect(enriched[0].round).toBe(1);
    expect(enriched[1].round).toBe(2);
  });

  it('suppresses doer-artifact phantom cards in review-only templates', () => {
    // In review-only chats the runner creates a synthetic doer-artifact
    // dir whose answer.md holds the user's input artifact (the audit
    // prompt). Before the fix, the leftover loop appended that as a
    // standalone DONE card on the run grid — confusing because the
    // artifact IS the prompt being reviewed, not a participant.
    const round: RoundSnapshot = {
      round: 1,
      participants: [
        {
          participant: 'doer-artifact',
          role: 'doer',
          agentName: 'artifact',
          lineage: 'artifact' as never,
          hasAnswer: true,
          answer: '# Audit prompt body\n\n## DONE\n',
        },
      ],
    };
    const enriched = enrichRounds([round], eightReviewerTemplate, {});
    // 8 reviewer placeholders, NOT 9 (no leftover doer-artifact card).
    expect(enriched[0].participants).toHaveLength(8);
    expect(
      enriched[0].participants.find((p) => p.participant === 'doer-artifact'),
    ).toBeUndefined();
  });

  it('still appends defensive unexpected reviewer leftovers (not filtered)', () => {
    // Suppression is scoped to role='doer' on review-only chats. A
    // reviewer participant that doesn't match any expected slot (e.g.
    // an old chat dir with a since-removed lineage) still gets a card
    // so the user can see "something ran here" instead of silent gap.
    const round: RoundSnapshot = {
      round: 1,
      participants: [
        {
          participant: 'reviewer-someoldcli-99',
          role: 'reviewer',
          agentName: 'someoldcli',
          lineage: 'someoldcli' as never,
          hasAnswer: true,
        },
      ],
    };
    const enriched = enrichRounds([round], eightReviewerTemplate, {});
    expect(
      enriched[0].participants.find(
        (p) => p.participant === 'reviewer-someoldcli-99',
      ),
    ).toBeDefined();
  });
});
