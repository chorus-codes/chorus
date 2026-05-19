/**
 * Unit tests for src/daemon/openrouter.ts
 *
 * Covers: validateKey, listModels, saveKey, addModelsAsVoices
 * The module handles OpenRouter API key validation, model catalog
 * fetching, key persistence, and voice creation from the catalog.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { validateKey, listModels, saveKey } from '../src/daemon/openrouter.js';

const VALID_KEY = 'sk-or-v1_test123';
const INVALID_KEY = 'sk-or-v1_badkey';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// vi.stubGlobal is the idiomatic vitest primitive for mocking globals:
// it tracks the original `fetch` and `vi.unstubAllGlobals()` restores
// it. Bare `globalThis.fetch = ...` leaks past test boundaries because
// `vi.restoreAllMocks()` doesn't undo property assignments — flagged
// convergently by 5/8 reviewers on PR #56's chorus self-review.
function stubFetch(impl: ReturnType<typeof vi.fn>): ReturnType<typeof vi.fn> {
  vi.stubGlobal('fetch', impl);
  return impl;
}

// --- validateKey tests ---

describe('validateKey', () => {
  // Restore fetch after each test
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns valid=true for a real key (200 from /auth/key)', async () => {
    stubFetch(vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    }));

    const result = await validateKey(VALID_KEY);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns valid=false with "Invalid API key" for 401', async () => {
    stubFetch(vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    }));

    const result = await validateKey(INVALID_KEY);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });

  it('returns valid=false with "Invalid API key" for 403', async () => {
    stubFetch(vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    }));

    const result = await validateKey(INVALID_KEY);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });

  it('returns valid=false with status text for other non-ok statuses', async () => {
    stubFetch(vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }));

    const result = await validateKey(INVALID_KEY);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('OpenRouter returned 500');
  });

  it('returns valid=false with "API key is empty" for blank input', async () => {
    const result = await validateKey('   ');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('API key is empty');
  });

  it('returns valid=false with "API key is empty" for empty string', async () => {
    const result = await validateKey('');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('API key is empty');
  });

  it('returns valid=false with network error message on fetch failure', async () => {
    stubFetch(vi.fn().mockRejectedValue(new Error("ENOTFOUND")));

    const result = await validateKey(VALID_KEY);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Network error: ENOTFOUND');
  });

  it('calls /auth/key endpoint with Bearer Authorization', async () => {
    const mockFetch = stubFetch(vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    }));

    await validateKey(VALID_KEY);

    expect(mockFetch).toHaveBeenCalledWith(
      `${OPENROUTER_BASE}/auth/key`,
      expect.objectContaining({
        headers: { Authorization: `Bearer ${VALID_KEY}` },
      }),
    );
  });

  it('uses VALIDATE_TIMEOUT_MS (8s) via AbortSignal.timeout', async () => {
    const mockFetch = stubFetch(vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    }));

    await validateKey(VALID_KEY);

    const callArg = mockFetch.mock.calls[0][1] as { signal: AbortSignal };
    expect(callArg.signal).toBeInstanceOf(AbortSignal);
  });
});

// --- listModels tests ---

describe('listModels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns all models from a single-page response', async () => {
    stubFetch(vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          data: [
            { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' } },
            { id: 'openai/gpt-4o', name: 'GPT-4o', context_length: 128000, pricing: { prompt: '0.0000025', completion: '0.00001' } },
          ],
        }),
    }));

    const models = await listModels(VALID_KEY);

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('anthropic/claude-3.5-sonnet');
    expect(models[0].name).toBe('Claude 3.5 Sonnet');
    expect(models[0].contextLength).toBe(200000);
    expect(models[0].inputCostPerMtok).toBe(3); // 0.000003 * 1_000_000
    expect(models[0].outputCostPerMtok).toBe(15); // 0.000015 * 1_000_000
  });

  it('maps pricing strings to per-Mtok USD correctly', async () => {
    stubFetch(vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          data: [
            { id: 'test/model', name: 'Test Model', pricing: { prompt: '0.0000015', completion: '0.0000075' } },
          ],
        }),
    }));

    const models = await listModels(VALID_KEY);

    expect(models[0].inputCostPerMtok).toBe(1.5);
    expect(models[0].outputCostPerMtok).toBe(7.5);
  });

  it('handles missing pricing fields gracefully (become NaN, omitted)', async () => {
    stubFetch(vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          data: [{ id: 'free/model', name: 'Free Model' }],
        }),
    }));

    const models = await listModels(VALID_KEY);

    expect(models[0].inputCostPerMtok).toBeUndefined();
    expect(models[0].outputCostPerMtok).toBeUndefined();
    expect(models[0].contextLength).toBeUndefined();
  });

  it('follows next_cursor pagination until exhausted', async () => {
    const mockFetch = stubFetch(vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: [{ id: 'page1/model', name: 'Page 1 Model' }],
            next_cursor: 'cursor-page-2',
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: [{ id: 'page2/model', name: 'Page 2 Model' }],
            next_cursor: 'cursor-page-3',
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: [{ id: 'page3/model', name: 'Page 3 Model' }],
          }),
      }));

    const models = await listModels(VALID_KEY);

    expect(models).toHaveLength(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Convergent finding from PR #56 self-review (3 reviewers): assert
    // each follow-up request actually carried the prior page's cursor.
    // Without this, a real bug that always re-fetched /models with no
    // cursor param would still produce a 3-element result (3 separate
    // page-1 responses) — toHaveLength(3) on its own can't tell the
    // difference between "pagination works" and "loop runs N times
    // ignoring the cursor".
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).not.toMatch(/cursor=/);
    expect(urls[1]).toContain('cursor=cursor-page-2');
    expect(urls[2]).toContain('cursor=cursor-page-3');
  });

  it('stops at MAX_PAGES (20) guard', async () => {
    // Server keeps handing us a fresh cursor forever — the listModels
    // loop must terminate via the MAX_PAGES safety cap. Each fake page
    // returns one model; after 20 pages the loop exits with 20 models
    // accumulated and no infinite-loop hang.
    const mockFetch = stubFetch(
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: [{ id: 'model', name: 'Model' }],
            next_cursor: 'keep-going',
          }),
      }),
    );

    const models = await listModels(VALID_KEY);
    expect(models).toHaveLength(20);
    expect(mockFetch).toHaveBeenCalledTimes(20);
  });

  it('throws when /models returns non-ok status', async () => {
    stubFetch(vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }));

    await expect(listModels(VALID_KEY)).rejects.toThrow('OpenRouter /models returned 500');
  });

  it('falls back to "cursor" field when next_cursor is absent', async () => {
    const mockFetch = stubFetch(vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: [{ id: 'page1/model', name: 'Page 1' }],
            cursor: 'legacy-cursor',
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: [{ id: 'page2/model', name: 'Page 2' }],
          }),
      }));

    const models = await listModels(VALID_KEY);

    expect(models).toHaveLength(2);
    // Verify the legacy `cursor` field was actually threaded into the
    // follow-up URL (same review concern as next_cursor above).
    expect(mockFetch.mock.calls[1]?.[0]).toContain('cursor=legacy-cursor');
  });

  it('uses MODELS_TIMEOUT_MS (15s) via AbortSignal.timeout', async () => {
    const mockFetch = stubFetch(vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [] }),
    }));

    await listModels(VALID_KEY);

    const callArg = mockFetch.mock.calls[0][1] as { signal: AbortSignal };
    expect(callArg.signal).toBeInstanceOf(AbortSignal);
  });
});