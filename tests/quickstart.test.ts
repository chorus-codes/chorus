/**
 * Quickstart command tests — focused on the pure helpers (YAML
 * builder + sample-artifact constants). The full `runQuickstart` flow
 * is integration-shaped (daemon + chat fire + poll) and exercised by
 * hand. These tests pin the contract that the YAML the command
 * generates passes the live template-schema validator, so a future
 * schema bump can't silently break the activation path.
 */
import { describe, it, expect } from 'vitest';
import { _testing } from '../src/cli/commands/quickstart';
import { TemplateSchema } from '../src/lib/template-schema';
import { parse as parseYaml } from 'yaml';

const { buildQuickstartYaml, QUICKSTART_TEMPLATE_ID, SAMPLE_ARTIFACT } = _testing;

describe('buildQuickstartYaml', () => {
  it('produces YAML that parses against the live TemplateSchema', () => {
    const text = buildQuickstartYaml('anthropic', 'claude-sonnet-4-6');
    const parsed = parseYaml(text);
    const result = TemplateSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('uses crossLineage=false so a single-CLI user can still run it', () => {
    const text = buildQuickstartYaml('opencode', 'opencode/claude-sonnet-4-6');
    const parsed = parseYaml(text) as Record<string, unknown>;
    const phases = parsed.phases as Array<{
      reviewer: { crossLineage: boolean; require: number };
    }>;
    expect(phases[0].reviewer.crossLineage).toBe(false);
    expect(phases[0].reviewer.require).toBe(1);
  });

  it('routes the reviewer slot to the supplied lineage', () => {
    const text = buildQuickstartYaml('google', 'gemini-2.5-pro');
    const parsed = parseYaml(text) as Record<string, unknown>;
    const phases = parsed.phases as Array<{
      reviewer: { candidates: Array<{ lineage: string; models: string[] }> };
    }>;
    expect(phases[0].reviewer.candidates).toHaveLength(1);
    expect(phases[0].reviewer.candidates[0].lineage).toBe('google');
    expect(phases[0].reviewer.candidates[0].models).toEqual(['gemini-2.5-pro']);
  });

  it('omits the models array when no model is supplied (lets the seed pick a default)', () => {
    const text = buildQuickstartYaml('anthropic');
    const parsed = parseYaml(text) as Record<string, unknown>;
    const phases = parsed.phases as Array<{
      reviewer: { candidates: Array<{ lineage: string; models?: string[] }> };
    }>;
    expect(phases[0].reviewer.candidates[0].models).toBeUndefined();
  });

  it('disables ship — the quickstart never opens a PR', () => {
    const text = buildQuickstartYaml('anthropic', 'claude-sonnet-4-6');
    const parsed = parseYaml(text) as Record<string, unknown>;
    expect((parsed.ship as { enabled: boolean }).enabled).toBe(false);
  });

  it('uses the stable QUICKSTART_TEMPLATE_ID so re-runs idempotently overwrite', () => {
    const a = parseYaml(buildQuickstartYaml('anthropic', 'claude-sonnet-4-6')) as Record<string, unknown>;
    const b = parseYaml(buildQuickstartYaml('opencode', 'opencode/claude-sonnet-4-6')) as Record<string, unknown>;
    expect(a.id).toBe(QUICKSTART_TEMPLATE_ID);
    expect(b.id).toBe(QUICKSTART_TEMPLATE_ID);
  });
});

describe('SAMPLE_ARTIFACT', () => {
  it('contains a real bug for the reviewer to find (off-by-one in the loop bound)', () => {
    // The `<=` is the bug — flagged so the reviewer has something
    // concrete to surface. A no-bug artifact would risk an empty
    // "looks good!" review that doesn't show value.
    expect(SAMPLE_ARTIFACT).toContain('i <= numbers.length');
  });

  it('stays under the 16 KiB cap declared in the YAML', () => {
    expect(SAMPLE_ARTIFACT.length).toBeLessThan(16 * 1024);
  });
});
