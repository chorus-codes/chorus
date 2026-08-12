/**
 * Antigravity model selection (agy 1.1.7).
 *
 * `agy` used to be a single locked model, and the shim was written to
 * match: it dropped `opts.model` on the floor. The CLI has since grown a
 * `--model` flag and an `agy models` catalog spanning three vendors —
 * gemini-*, claude-* and gpt-oss-*.
 *
 * Two rules under test:
 *   1. A named model reaches the CLI; an unnamed one leaves the flag off
 *      entirely, so the CLI keeps its own default rather than us guessing
 *      at a model this account may not be entitled to.
 *   2. The model's real vendor is recorded separately from the lineage.
 *      An Antigravity subscriber running claude-sonnet-4-6 is making a
 *      legitimate choice — possibly their only route to that model — but
 *      the reviewer answering IS anthropic-family, and quorum fallback
 *      has to see that.
 */
import { describe, expect, it } from 'vitest';

import { antigravityShim, buildHeadlessArgs } from '@/daemon/agents/antigravity';
import type { HeadlessSpawnOptions } from '@/daemon/agents/types';
import { vendorFamilyForModel, classifyOpencodeModel } from '@/lib/voices';

const baseOpts: HeadlessSpawnOptions = {
  accountId: 'test-account',
  cwd: '/tmp/chorus-test',
  promptText: 'review this',
  timeoutMs: 60_000,
};

describe('buildHeadlessArgs (agy -p)', () => {
  it('passes --model when the slot names one', () => {
    const args = buildHeadlessArgs({ ...baseOpts, model: 'claude-sonnet-4-6' });
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('claude-sonnet-4-6');
  });

  it('omits --model entirely when it does not', () => {
    // Not "passes the default" — omitting is the point. Naming a model
    // the account lacks is worse than letting the CLI choose.
    expect(buildHeadlessArgs(baseOpts)).not.toContain('--model');
  });

  it('keeps the headless flags that make dispatch work at all', () => {
    const args = buildHeadlessArgs({ ...baseOpts, model: 'gemini-3.6-flash-low' });
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('review this');
    // Without this, dispatch hangs on the first tool-approval prompt.
    expect(args).toContain('--dangerously-skip-permissions');
  });
});

describe('antigravityShim — interactive launch command', () => {
  it('passes --model through to the tmux session', () => {
    const cmd = antigravityShim.buildLaunchCommand({
      cwd: '/tmp/run',
      model: 'claude-sonnet-4-6',
    } as Parameters<typeof antigravityShim.buildLaunchCommand>[0]);
    expect(cmd).toContain('--model');
    expect(cmd).toContain('claude-sonnet-4-6');
  });

  it('omits --model when the slot names none', () => {
    const cmd = antigravityShim.buildLaunchCommand({
      cwd: '/tmp/run',
    } as Parameters<typeof antigravityShim.buildLaunchCommand>[0]);
    expect(cmd).not.toContain('--model');
    expect(cmd.trimEnd().endsWith('agy')).toBe(true);
  });

  it('rejects a model string carrying shell metacharacters', () => {
    expect(() =>
      antigravityShim.buildLaunchCommand({
        cwd: '/tmp/run',
        model: 'gemini-3.6-flash-high; rm -rf /',
      } as Parameters<typeof antigravityShim.buildLaunchCommand>[0]),
    ).toThrow();
  });
});

describe('vendorFamilyForModel', () => {
  it('reads the vendor off agy\'s cross-vendor catalog', () => {
    // Verbatim ids from `agy models` on 1.1.7.
    expect(vendorFamilyForModel('gemini-3.6-flash-high')).toBe('google');
    expect(vendorFamilyForModel('claude-opus-4-6-thinking')).toBe('anthropic');
    expect(vendorFamilyForModel('gpt-oss-120b-medium')).toBe('openai');
  });

  it('returns null for a name from no known vendor', () => {
    expect(vendorFamilyForModel('some-future-model')).toBeNull();
  });

  it('still backs the opencode-go gateway classification unchanged', () => {
    // The helper was extracted from classifyOpencodeModel; the gateway
    // contract (lineage stays opencode, family tracks the model) must hold.
    expect(classifyOpencodeModel('opencode-go/kimi-k2.6')).toEqual({
      lineage: 'opencode',
      vendor_family: 'moonshot',
    });
    expect(classifyOpencodeModel('opencode-go/claude-sonnet-4-6')).toEqual({
      lineage: 'opencode',
      vendor_family: 'anthropic',
    });
    expect(classifyOpencodeModel('opencode-go/some-future-model')).toEqual({
      lineage: 'opencode',
      vendor_family: null,
    });
  });
});
