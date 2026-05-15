/**
 * Voices seed + migration logic.
 *
 * Two phases per planning/voices.md:
 *   - Phase 1 (synchronous, pre-listen): seed single-model CLIs +
 *     auto-disable absent CLIs + first-boot migration from
 *     <lineage>.enabled_models settings.
 *   - Phase 2 (background warmup, post-listen): shell out to
 *     `opencode models`, seed gateway-prefixed multi-model voices.
 *     Allowed up to 10s timeout. Daemon doesn't block boot on this.
 *
 * Single-model CLIs use IMMUTABLE IDs. Versioned model upgrades rewrite
 * model_id+label without rotating the row's primary key (gem-2 round 1
 * BLOCKER 3).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectAllClis, type DetectableCli } from './cli-detect.js';
import { settings, voices, type VoiceUpsertInput } from './db/index.js';
import { UI_LINEAGE_AVAILABLE_MODELS } from './lineage-maps.js';

const run = promisify(execFile);

type DaemonLineage = 'anthropic' | 'openai' | 'google' | 'opencode' | 'moonshot' | 'grok';
type UiLineage = 'claude' | 'codex' | 'gemini' | 'opencode' | 'kimi' | 'grok';

/**
 * Daemon-side lineage → UI-side lineage (for UI_LINEAGE_AVAILABLE_MODELS
 * lookup, which is keyed by UI names — per round 2 cdx-1 BLOCKER).
 */
const LINEAGE_TO_UI: Record<DaemonLineage, UiLineage> = {
  anthropic: 'claude',
  openai: 'codex',
  google: 'gemini',
  opencode: 'opencode',
  moonshot: 'kimi',
  grok: 'grok',
};

/**
 * Single-model CLIs: each maps to (provider, daemon-lineage). Used by
 * Phase 1 seed. The provider IS the voice's immutable id.
 */
const SINGLE_MODEL_CLIS: ReadonlyArray<{
  cli: DetectableCli;
  provider: string;
  lineage: DaemonLineage;
}> = [
  { cli: 'claude-code', provider: 'claude-code', lineage: 'anthropic' },
  { cli: 'codex-cli', provider: 'codex-cli', lineage: 'openai' },
  { cli: 'gemini-cli', provider: 'gemini-cli', lineage: 'google' },
  { cli: 'kimi-cli', provider: 'kimi-cli', lineage: 'moonshot' },
  // Grok Build is single-model (grok-build) on first launch. xAI may
  // ship more model IDs in future; if/when `grok models` exposes them,
  // promote to a multi-model live-probe like opencode/codex.
  { cli: 'grok-cli', provider: 'grok-cli', lineage: 'grok' },
];

/**
 * OpenCode gateway model name → (lineage, vendor_family). The model name
 * suffix drives the mapping, not the gateway prefix — `opencode-go/kimi-*`
 * and `opencode-zen/kimi-*` are both lineage=moonshot. Diversity scoring
 * reads `lineage`; cost UX reads `vendor_family`.
 *
 * Reused for OpenRouter model ids (`anthropic/claude-...`,
 * `openai/gpt-...`, etc.) — the qualified prefix pattern is identical.
 */
export function classifyOpencodeModel(qualified: string): {
  lineage: DaemonLineage;
  vendor_family: string | null;
} {
  // Strip gateway prefix; everything after the first slash is the model name.
  const slash = qualified.indexOf('/');
  const gateway = slash >= 0 ? qualified.slice(0, slash) : '';
  const tail = slash >= 0 ? qualified.slice(slash + 1) : qualified;
  const t = tail.toLowerCase();

  // opencode-go gateway: every voice here runs through the `opencode`
  // binary (no separate kimi/anthropic/openai CLI invocation). Lineage is
  // 'opencode' regardless of model family — otherwise template editor
  // renders impossible combos like (lineage=Kimi, model=opencode-go/kimi-k2.6),
  // implying a kimi-CLI subscription that may not exist. Model family
  // moves into `vendor_family` so diversity scoring and cost UX still
  // see "moonshot" / "deepseek" / "anthropic" / etc.
  if (gateway === 'opencode-go') {
    if (t.includes('kimi')) return { lineage: 'opencode', vendor_family: 'moonshot' };
    if (t.includes('claude')) return { lineage: 'opencode', vendor_family: 'anthropic' };
    if (t.includes('gpt') || /(?:^|[^a-z])o[1-9](?:$|[^a-z0-9])/.test(t)) {
      return { lineage: 'opencode', vendor_family: 'openai' };
    }
    if (t.includes('gemini')) return { lineage: 'opencode', vendor_family: 'google' };
    if (t.includes('deepseek')) return { lineage: 'opencode', vendor_family: 'deepseek' };
    if (t.includes('llama') || t.includes('meta')) return { lineage: 'opencode', vendor_family: 'meta' };
    if (t.includes('mistral') || t.includes('mixtral')) return { lineage: 'opencode', vendor_family: 'mistral' };
    if (t.includes('grok') || t.includes('xai')) return { lineage: 'opencode', vendor_family: 'xai' };
    return { lineage: 'opencode', vendor_family: null };
  }

  // Native lineage matching (OpenRouter `anthropic/...`, `openai/...`,
  // `google/...`, `moonshotai/...`, etc.) — the qualified prefix doesn't
  // route through opencode binary, so lineage tracks the model family.
  if (t.includes('kimi')) return { lineage: 'moonshot', vendor_family: null };
  if (t.includes('claude')) return { lineage: 'anthropic', vendor_family: null };
  if (t.includes('gpt') || /(?:^|[^a-z])o[1-9](?:$|[^a-z0-9])/.test(t)) {
    return { lineage: 'openai', vendor_family: null };
  }
  if (t.includes('gemini')) return { lineage: 'google', vendor_family: null };
  if (t.includes('deepseek')) return { lineage: 'opencode', vendor_family: 'deepseek' };
  if (t.includes('llama') || t.includes('meta')) return { lineage: 'opencode', vendor_family: 'meta' };
  if (t.includes('mistral') || t.includes('mixtral')) return { lineage: 'opencode', vendor_family: 'mistral' };
  if (t.includes('grok') || t.includes('xai')) return { lineage: 'opencode', vendor_family: 'xai' };
  return { lineage: 'opencode', vendor_family: null };
}

/**
 * Live model probe for Codex CLI — `codex debug models` renders the raw
 * model catalog as JSON. Filter to `visibility=='list'` so we don't seed
 * hidden internals (`codex-auto-review`, `gpt-oss-*`).
 *
 * Returns null on any failure (CLI absent, JSON parse, schema mismatch,
 * timeout) so the caller falls back to the static catalog.
 */
async function probeCodexModelsLive(): Promise<string[] | null> {
  try {
    const { stdout } = await run('codex', ['debug', 'models'], {
      timeout: 5_000,
      shell: process.platform === 'win32',
    });
    const parsed = JSON.parse(stdout) as unknown;
    if (
      typeof parsed !== 'object' || parsed === null ||
      !Array.isArray((parsed as { models?: unknown }).models)
    ) {
      return null;
    }
    const models = (parsed as { models: Array<{ slug?: unknown; visibility?: unknown }> }).models;
    const out: string[] = [];
    for (const m of models) {
      if (typeof m.slug === 'string' && m.visibility === 'list') out.push(m.slug);
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Phase 1 — synchronous seed for single-model CLIs.
 *
 * - For each detected single-model CLI: upsert immutable voice row
 *   (id = provider) with the latest model from
 *   UI_LINEAGE_AVAILABLE_MODELS[ui_lineage][0].
 * - For each previously-detected single-model CLI now absent: set
 *   enabled=0 (auto-disable, NOT delete) — phase composition shouldn't
 *   dispatch to a CLI the user uninstalled.
 * - First-boot migration: if voices table is empty AND <lineage>.enabled_models
 *   settings exist, seed disabled rows for non-enabled curated models so
 *   the user's prior toggles are preserved.
 * - First-install (no migration data, no existing voices): seed every
 *   curated/discovered model row as enabled so the user can opt out of
 *   anything they don't want — vs. the prior "default model only enabled"
 *   which left the home page looking sparse.
 *
 * Returns counts for logging.
 */
export async function seedCliVoices(): Promise<{
  added: number;
  updated: number;
  disabled: number;
}> {
  const detect = detectAllClis();
  const detectedById = new Map(detect.map((d) => [d.id, d]));

  // First-boot migration: only fires when voices table is completely empty
  // AND at least one <lineage>.enabled_models setting exists (i.e. the user
  // is upgrading from v0.7 hardening cycle, not starting fresh).
  const existingVoices = await voices.list();
  const isFirstBoot = existingVoices.length === 0;
  const migrationData = isFirstBoot ? await readMigrationSettings() : null;

  // Live model discovery for CLIs that expose a programmatic catalog.
  // Codex is the only single-model CLI that does (`codex debug models`).
  // Claude / Gemini / Kimi don't, so they always use the static catalog.
  const codexLive = detectedById.get('codex-cli')?.found
    ? await probeCodexModelsLive()
    : null;

  let added = 0;
  let updated = 0;
  let disabled = 0;

  // === Phase 1a: single-model CLIs ===
  // Two cases per CLI:
  //   - DETECTED: upsert the immutable provider row with the latest model
  //     + (on first boot) seed curated non-default rows so fleet cards
  //     can list them.
  //   - NOT DETECTED on first boot but settings exist: migrate anyway
  //     (round 1 cdx-1 BLOCKER — otherwise the user's gemini.enabled_models
  //     would never migrate if gemini-cli isn't installed yet, and once
  //     voices table is non-empty the migration won't re-fire). Rows seed
  //     with the migrated enabled state; later when the CLI installs,
  //     voices.upsert preserves enabled and just rewrites model_id+label.
  //   - NOT DETECTED on regular boot (existing row enabled): auto-disable.
  for (const { cli, provider, lineage } of SINGLE_MODEL_CLIS) {
    const detected = detectedById.get(cli);
    const existingRow = existingVoices.find((v) => v.id === provider);
    const uiLineage = LINEAGE_TO_UI[lineage];
    // Prefer live probe over static catalog; fall back to static when the
    // CLI doesn't expose model listing or the probe failed.
    const liveModels = cli === 'codex-cli' ? codexLive : null;
    const staticModels = UI_LINEAGE_AVAILABLE_MODELS[uiLineage] ?? [];
    const models = liveModels ?? staticModels;
    const latestModel = models[0] ?? `${cli}-default`;
    const label = `${humanLineageLabel(lineage)} (${latestModel})`;

    if (detected?.found) {
      // Default-enabled rule:
      //   - With migration data → respect the user's prior setting per
      //     migrationFor() (absent setting → default-only enabled).
      //   - First install (no migration, fresh voices table) → ALL curated
      //     models start enabled so the user can opt out, not opt in. Per
      //     v0.8 onboarding UX request.
      //   - Subsequent boots → voices.upsert preserves existing `enabled`
      //     so user toggles are sticky.
      //   - Re-detect of a previously auto_missing row → re-enable +
      //     clear disabled_reason. One flaky boot used to leave the row
      //     silently off forever; this restores it the moment detection
      //     succeeds again, while still respecting deliberate user toggles
      //     (disabled_reason='user' rows are NOT auto-restored).
      const wasAutoMissing =
        existingRow?.enabled === false &&
        existingRow?.disabled_reason === 'auto_missing';
      const enabledOverride = wasAutoMissing
        ? true
        : migrationData
          ? migrationFor(migrationData, uiLineage, latestModel)
          : (isFirstBoot ? true : undefined);

      const before = await voices.getById(provider);
      await voices.upsert({
        id: provider,
        label,
        source: 'cli',
        provider,
        model_id: latestModel,
        lineage,
        ...(enabledOverride !== undefined ? { enabled: enabledOverride } : {}),
        // Clear the auto_missing tombstone when re-enabling. For all other
        // paths leave disabled_reason untouched (omitted → preserved).
        ...(wasAutoMissing ? { disabled_reason: null } : {}),
      });
      if (before) updated++;
      else added++;

      // Reconcile non-default curated/discovered models on EVERY boot —
      // not just first boot. Why: when the catalog changes (new model
      // added in lineage-maps.ts, codex live probe surfaces a new slug),
      // existing installs should pick up the additions automatically.
      // The previous "first-boot only" guard left users stuck on the
      // catalog snapshot from when they first installed.
      const catalogIds = new Set(models.map((m) => `${provider}:${m}`));
      for (const m of models.slice(1)) {
        const id = `${provider}:${m}`;
        const exists = await voices.getById(id);
        if (exists) {
          // Row already there — voices.upsert preserves enabled state, so
          // don't pass `enabled` (would silently re-enable user-disabled
          // rows on every boot). Just refresh the label in case
          // humanLineageLabel changed.
          await voices.upsert({
            id,
            label: `${humanLineageLabel(lineage)} (${m})`,
            source: 'cli',
            provider,
            model_id: m,
            lineage,
          });
          updated++;
          continue;
        }
        // Net-new row. enabled state:
        //   - migration data present → respect user's prior intent
        //   - first install → opt-out (enabled=true)
        //   - subsequent boot picking up a NEW catalog entry → enabled=true
        //     so users see "we added Sonnet 4.5" without having to opt in
        const enabled = migrationData
          ? (migrationFor(migrationData, uiLineage, m) ?? false)
          : true;
        await voices.upsert({
          id,
          label: `${humanLineageLabel(lineage)} (${m})`,
          source: 'cli',
          provider,
          model_id: m,
          lineage,
          enabled,
        });
        added++;
      }

      // Catalog drift: delete rows whose model is no longer in the
      // current catalog (deprecated entries cleaned out of
      // lineage-maps.ts or vanished from a live probe). Hard delete,
      // not disable — leaving deprecated model names like
      // "claude-sonnet-4" hanging in the fleet UI confuses new users
      // ("is this Sonnet 4.6?"). The immutable provider-id row at
      // `id === provider` is intentionally skipped — that one rotates
      // its model_id forward to the latest model and never gets dropped.
      const sameProviderRows = existingVoices.filter(
        (v) => v.provider === provider && v.id !== provider,
      );
      for (const row of sameProviderRows) {
        if (catalogIds.has(row.id)) continue;
        await voices.delete(row.id);
        disabled++;
      }
    } else if (existingRow && existingRow.enabled) {
      // Regular boot, CLI was present last boot but is now absent —
      // auto-disable (not delete). Per round 1 deepseek MED.
      //
      // Stamp disabled_reason='auto_missing' so the re-detect branch above
      // can safely re-enable when the CLI returns. Without the reason flag
      // a transient PATH/detection miss would silently disable forever
      // (the bug that led gemini-3.1-pro-preview to stay off across boots).
      await voices.update(provider, {
        enabled: false,
        disabled_reason: 'auto_missing',
      });
      disabled++;
    } else if (isFirstBoot && migrationData && hasMigrationDataFor(migrationData, uiLineage)) {
      // First boot, CLI not currently detected, but the user has a prior
      // <lineage>.enabled_models setting — migrate the rows now so the
      // intent isn't lost. When the CLI later installs, voices.upsert
      // preserves the enabled state. Per round 1 cdx-1 BLOCKER.
      const enabledOverride = migrationFor(migrationData, uiLineage, latestModel);
      await voices.upsert({
        id: provider,
        label,
        source: 'cli',
        provider,
        model_id: latestModel,
        lineage,
        ...(enabledOverride !== undefined ? { enabled: enabledOverride } : {}),
      });
      added++;
      for (const m of models.slice(1)) {
        const id = `${provider}:${m}`;
        const enabled = migrationFor(migrationData, uiLineage, m) ?? false;
        await voices.upsert({
          id,
          label: `${humanLineageLabel(lineage)} (${m})`,
          source: 'cli',
          provider,
          model_id: m,
          lineage,
          enabled,
        });
        added++;
      }
    }
  }

  return { added, updated, disabled };
}

/**
 * Whether the migration data has an EXPLICIT setting (not absent) for
 * this lineage. Empty array still counts — that's the user explicitly
 * disabling everything in v0.7. Absent (undefined value) means the
 * user never touched this lineage; in that case we don't seed anything
 * for an undetected CLI (no migration intent to preserve).
 */
function hasMigrationDataFor(data: MigrationData, ui: UiLineage): boolean {
  return data.byUiLineage.get(ui) !== undefined;
}

/**
 * Phase 2 — background warmup for OpenCode multi-model voices. Called
 * AFTER `fastify.listen()` so a slow/broken `opencode models` shell-out
 * doesn't add up to 10s of boot latency. Best-effort; logs but never
 * crashes the daemon.
 */
export async function seedOpencodeVoicesAsync(): Promise<{
  added: number;
  updated: number;
  disabled: number;
} | null> {
  const detect = detectAllClis();
  const opencode = detect.find((d) => d.id === 'opencode-cli');
  const existingOpencode = await voices.list({ provider: 'opencode-cli' });

  if (!opencode?.found) {
    // CLI not detected — auto-disable any existing opencode voices.
    // Stamp disabled_reason so the next successful boot can auto-restore
    // (mirrors the SINGLE_MODEL_CLIS branch above).
    let disabled = 0;
    for (const v of existingOpencode) {
      if (v.enabled) {
        await voices.update(v.id, {
          enabled: false,
          disabled_reason: 'auto_missing',
        });
        disabled++;
      }
    }
    return { added: 0, updated: 0, disabled };
  }

  let modelList: string[];
  try {
    const { stdout } = await run('opencode', ['models'], {
      timeout: 10_000,
      shell: process.platform === 'win32',
    });
    modelList = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    // Shell-out failed (timeout, ENOENT after path mutation, etc.) — log
    // and skip. Existing voices stay as-is until the next successful boot.
    return null;
  }

  // First-install default rule for OpenCode: enable every model in the
  // user's Go plan (opencode-go/*) and leave the other gateways
  // (opencode/*, opencode-zen/*) disabled. The Go plan is the paid tier
  // most users will be on; other gateways are pay-as-you-go and shouldn't
  // bill silently from a fresh install.
  const isOpencodeGoModel = (qualified: string): boolean =>
    qualified.startsWith('opencode-go/');

  const migration = await readOpencodeMigration();
  const isFirstBoot = existingOpencode.length === 0;

  let added = 0;
  let updated = 0;
  const disabled = 0;

  const seenIds = new Set<string>();

  // Iterate the FULL discovered list so disabled-but-discoverable models
  // get rows for the user to re-enable (cdx-1 round 1 MED).
  for (const qualified of modelList) {
    const id = `opencode-cli:${qualified}`;
    seenIds.add(id);
    const { lineage, vendor_family } = classifyOpencodeModel(qualified);
    const label = qualified;

    const before = await voices.getById(id);
    const wasAutoMissing =
      before?.enabled === false && before?.disabled_reason === 'auto_missing';

    // enabled state policy:
    //   - Existing row, auto_missing tombstone → re-enable + clear reason
    //     (the opencode CLI was absent on a prior boot and is now back).
    //   - Existing row, anything else → preserve (omit enabled).
    //   - Net-new row + migration data → user's prior intent.
    //   - Net-new row, first install → opencode-go/* enabled, others off.
    //   - Net-new row, mid-life new model → off (user opts in via fleet).
    let enabledOverride: boolean | undefined;
    if (wasAutoMissing) {
      enabledOverride = true;
    } else if (!before) {
      if (migration) {
        enabledOverride = migrationFor(migration, 'opencode', qualified) ?? false;
      } else if (isFirstBoot) {
        enabledOverride = isOpencodeGoModel(qualified);
      } else {
        enabledOverride = false;
      }
    }

    await voices.upsert({
      id,
      label,
      source: 'cli',
      provider: 'opencode-cli',
      model_id: qualified,
      lineage,
      vendor_family,
      ...(enabledOverride !== undefined ? { enabled: enabledOverride } : {}),
      ...(wasAutoMissing ? { disabled_reason: null } : {}),
    });

    if (before) updated++;
    else added++;
  }

  return { added, updated, disabled };
}

// ============================================================
// Migration helpers — read v0.7 <lineage>.enabled_models settings.
// ============================================================

interface MigrationData {
  /** undefined: setting absent (use default-model fallback per cdx-1 MED).
   *  string[]: explicit list (empty = none enabled; populated = exact set). */
  byUiLineage: Map<UiLineage, string[] | undefined>;
}

async function readMigrationSettings(): Promise<MigrationData | null> {
  const byUiLineage = new Map<UiLineage, string[] | undefined>();
  let anySet = false;
  const lineages: UiLineage[] = ['claude', 'codex', 'gemini', 'kimi', 'opencode'];
  for (const ui of lineages) {
    const raw = await settings.get(`${ui}.enabled_models`);
    if (raw === null || raw === undefined) {
      byUiLineage.set(ui, undefined);
    } else if (Array.isArray(raw)) {
      byUiLineage.set(ui, raw.filter((x): x is string => typeof x === 'string'));
      anySet = true;
    } else {
      byUiLineage.set(ui, undefined);
    }
  }
  // Returning null when zero settings exist is what makes the "fresh install
  // = enable everything" branch fire in seedCliVoices. Any explicit setting
  // (including empty array) means the user touched the config and we
  // respect the prior intent.
  return anySet ? { byUiLineage } : null;
}

async function readOpencodeMigration(): Promise<MigrationData | null> {
  const raw = await settings.get('opencode.enabled_models');
  if (raw === null || raw === undefined) return null;
  const list = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : undefined;
  const byUiLineage = new Map<UiLineage, string[] | undefined>([['opencode', list]]);
  return { byUiLineage };
}

/**
 * Migration semantics (per cdx-1 round 1 MED):
 *   - Setting absent → undefined → "default model only" (return undefined
 *     here; caller treats undefined as "use the default = enabled").
 *   - Empty array → return false (no models enabled).
 *   - Populated array → return whether `model` is in the list.
 *
 * Special-case for the latest/default model: when the setting is absent,
 * we want default model = enabled and other curated models = disabled. The
 * caller (seedCliVoices) checks `migrationFor(... defaultModel)` separately
 * from non-default models and applies this fallback for the default only.
 */
function migrationFor(
  data: MigrationData,
  uiLineage: UiLineage,
  model: string,
): boolean | undefined {
  const list = data.byUiLineage.get(uiLineage);
  if (list === undefined) {
    // Absent: use the default-model rule. The first model in
    // UI_LINEAGE_AVAILABLE_MODELS[uiLineage] is the default; everything
    // else is disabled. For OpenCode the "default" is determined by the
    // FLEET_DEFAULTS set, not this function — caller handles that.
    if (uiLineage === 'opencode') return undefined;
    const models = UI_LINEAGE_AVAILABLE_MODELS[uiLineage] ?? [];
    return models[0] === model;
  }
  if (list.length === 0) return false;
  return list.includes(model);
}

function humanLineageLabel(l: DaemonLineage): string {
  switch (l) {
    case 'anthropic': return 'Claude';
    case 'openai': return 'Codex';
    case 'google': return 'Gemini';
    case 'opencode': return 'OpenCode';
    case 'moonshot': return 'Kimi';
    case 'grok': return 'Grok';
  }
}

/** @internal — exported for unit tests. */
export const _internals = {
  classifyOpencodeModel,
  migrationFor,
  LINEAGE_TO_UI,
  SINGLE_MODEL_CLIS,
};
