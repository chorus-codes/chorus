/**
 * fromRow() tests for the cockpit-side chat mapper.
 *
 * Specifically locks in the safeParse-on-read contract for
 * `template_snapshot`: malformed JSON, structurally-invalid templates,
 * and absent values must all degrade to `templateSnapshot: undefined`
 * so the run page can fall back to live-template lookup.
 */

import { describe, expect, it } from 'vitest';
import { _testing } from '@/lib/api/chats';
import { TemplateSchema } from '@/lib/template-schema';

const baseRow = {
  id: '019E0000000000000000000000000000',
  slug: null,
  work: 'w',
  template_id: 'code-review',
  status: 'drafting' as const,
  current_phase_idx: 0,
  yolo: 0,
  attached_files: null,
  repo_path: null,
  pr_url: null,
  ship_error: null,
  artifact: null,
  verdict: null,
  template_snapshot: null,
  created_at: 1000,
  updated_at: 1000,
  finished_at: null,
};

// Minimum Template that satisfies TemplateSchema. Built via parse so any
// future schema change auto-keeps the fixture valid (or fails the test).
function validTemplate() {
  return TemplateSchema.parse({
    id: 'code-review',
    name: 'Code Review',
    description: 'Single-phase review.',
    phases: [
      {
        id: 'review',
        kind: 'review',
        title: 'Review',
        description: 'review the diff',
        doer: { lineage: 'anthropic', models: ['claude-opus-4-7'] },
        reviewer: {
          require: 1,
          crossLineage: false,
          candidates: [{ lineage: 'openai', models: ['gpt-5.5'] }],
        },
      },
    ],
  });
}

describe('fromRow — template_snapshot parsing', () => {
  it('null snapshot → templateSnapshot undefined', () => {
    const chat = _testing.fromRow({ ...baseRow, template_snapshot: null });
    expect(chat.templateSnapshot).toBeUndefined();
  });

  it('valid snapshot JSON → parsed Template object', () => {
    const tmpl = validTemplate();
    const chat = _testing.fromRow({
      ...baseRow,
      template_snapshot: JSON.stringify(tmpl),
    });
    expect(chat.templateSnapshot).toBeDefined();
    expect(chat.templateSnapshot?.id).toBe('code-review');
    expect(chat.templateSnapshot?.phases?.length).toBe(1);
  });

  it('malformed JSON → templateSnapshot undefined (graceful)', () => {
    // Crucial: must NOT throw. The run page would 500 and the user
    // would see a broken page for chats with corrupt rows.
    const chat = _testing.fromRow({
      ...baseRow,
      template_snapshot: 'not-json{{{',
    });
    expect(chat.templateSnapshot).toBeUndefined();
  });

  it('structurally-invalid template (zod fails) → templateSnapshot undefined', () => {
    // Schema-drift simulation: an "old snapshot" that's missing
    // required fields the current TemplateSchema requires. The cast
    // would have silently accepted this; safeParse rejects it so the
    // run page falls back to live-template lookup instead of crashing
    // when a renderer accesses the missing field.
    const chat = _testing.fromRow({
      ...baseRow,
      template_snapshot: JSON.stringify({
        id: 'code-review',
        // missing name, description, phases — current schema rejects.
      }),
    });
    expect(chat.templateSnapshot).toBeUndefined();
  });

  it('non-object JSON (string, number, null) → templateSnapshot undefined', () => {
    for (const garbage of ['"a string"', '42', 'null', 'true']) {
      const chat = _testing.fromRow({
        ...baseRow,
        template_snapshot: garbage,
      });
      expect(chat.templateSnapshot).toBeUndefined();
    }
  });

  it('snapshot derives candidatesWithModels from candidates so cards can show model name', () => {
    // Regression — the daemon writes template_snapshot in the runtime
    // TemplateSchema shape (only `candidates`), but the cockpit Template
    // type expects `candidatesWithModels` populated. Without deriving it
    // here, enrichRounds iterates zero reviewer slots and no model name
    // shows on any card. User-reported 2026-05-08: "model names have
    // disappeared in card titles, they used to be there".
    const tmpl = validTemplate();
    const chat = _testing.fromRow({
      ...baseRow,
      template_snapshot: JSON.stringify(tmpl),
    });
    const reviewer = chat.templateSnapshot?.phases?.[0]?.reviewer;
    expect(reviewer).toBeDefined();
    expect(reviewer?.candidatesWithModels).toBeDefined();
    expect(reviewer?.candidatesWithModels?.length).toBe(1);
    expect(reviewer?.candidatesWithModels?.[0]?.lineage).toBe('openai');
    expect(reviewer?.candidatesWithModels?.[0]?.models?.[0]).toBe('gpt-5.5');
  });

  it('preserves candidatesWithModels when snapshot already carries it (idempotent)', () => {
    // If a future daemon version starts including candidatesWithModels
    // in the snapshot directly, fromRow must not double-derive or
    // clobber. Round-trip should be a no-op.
    const tmpl = validTemplate();
    // Forge a snapshot that has BOTH candidates and candidatesWithModels
    // (as cockpit-side getTemplate would produce).
    const enriched = {
      ...tmpl,
      phases: tmpl.phases.map((p) => ({
        ...p,
        reviewer: p.reviewer
          ? {
              ...p.reviewer,
              candidatesWithModels: (p.reviewer.candidates ?? []).map((c) => ({
                lineage: c.lineage,
                models: c.models ?? [],
              })),
            }
          : p.reviewer,
      })),
    };
    const chat = _testing.fromRow({
      ...baseRow,
      template_snapshot: JSON.stringify(enriched),
    });
    const reviewer = chat.templateSnapshot?.phases?.[0]?.reviewer;
    expect(reviewer?.candidatesWithModels?.length).toBe(1);
    expect(reviewer?.candidatesWithModels?.[0]?.models?.[0]).toBe('gpt-5.5');
  });
});
