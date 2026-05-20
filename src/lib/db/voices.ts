import { z } from 'zod';
import { getDb } from './connection.js';

const VoiceRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  source: z.enum(['cli', 'api']),
  provider: z.string(),
  model_id: z.string(),
  lineage: z.enum(['anthropic', 'openai', 'google', 'opencode', 'moonshot', 'grok', 'antigravity']),
  vendor_family: z.string().nullable(),
  input_cost_per_mtok: z.number().nullable(),
  output_cost_per_mtok: z.number().nullable(),
  enabled: z.coerce.boolean(),
  disabled_reason: z.enum(['user', 'auto_missing', 'auto_quota']).nullable().optional().default(null),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

export type VoiceRow = z.infer<typeof VoiceRowSchema>;
/**
 * Why a voice is disabled.
 *
 * - `user` — toggled off via the cockpit Connect page. Never auto-restored.
 * - `auto_missing` — CLI was not detected on a daemon boot. Auto-restored
 *   when the CLI is detected again on a future boot.
 * - `auto_quota` — repeated quota_exhausted failures with no resetAt
 *   (i.e. the upstream did not promise recovery). Issued for cases like
 *   "Pro Gemini model on a Flash-only account" where the model fails
 *   forever for that account. User can re-enable manually if they
 *   believe the account changed; chorus does not auto-restore.
 */
export type VoiceDisabledReason = 'user' | 'auto_missing' | 'auto_quota';

export interface VoiceUpsertInput {
  id: string;
  label: string;
  source: 'cli' | 'api';
  provider: string;
  model_id: string;
  lineage: 'anthropic' | 'openai' | 'google' | 'opencode' | 'moonshot' | 'grok' | 'antigravity';
  vendor_family?: string | null;
  input_cost_per_mtok?: number | null;
  output_cost_per_mtok?: number | null;
  enabled?: boolean;
  /**
   * Why this row is disabled. Pass `null` to clear, a value to set,
   * omit to preserve existing. The seed uses 'auto_missing' so the
   * re-detect path can safely re-enable transient drops.
   */
  disabled_reason?: VoiceDisabledReason | null;
}

export interface VoiceUpdateInput {
  label?: string;
  enabled?: boolean;
  input_cost_per_mtok?: number | null;
  output_cost_per_mtok?: number | null;
  /** Used by seed loops to rewrite the latest model on a stable-ID voice. */
  model_id?: string;
  disabled_reason?: VoiceDisabledReason | null;
}

export interface VoiceListFilter {
  lineage?: string;
  source?: 'cli' | 'api';
  provider?: string;
  /** When `undefined`, returns all voices (enabled + disabled). */
  enabled?: boolean;
}

export const voices = {
  /**
   * Upsert a voice row. Updates label/model_id/cost/vendor_family on
   * existing rows. `enabled` and `disabled_reason` follow this precedence:
   *
   *   1. Caller passes the field explicitly → use it (caller intent wins).
   *      For disabled_reason, an explicit `null` means "clear".
   *   2. Caller omits the field on an existing row → preserve current value.
   *   3. Caller omits on a fresh row → default (`enabled=true`,
   *      `disabled_reason=null`).
   *
   * The previous "existing always wins on enabled" behaviour silently
   * dropped seed overrides — meaning auto_missing rows could never be
   * re-enabled when the CLI returned, and migration-data overrides were
   * dead code on existing installs.
   */
  async upsert(input: VoiceUpsertInput): Promise<VoiceRow> {
    const db = await getDb();
    const now = Date.now();
    const existing = await voices.getById(input.id);

    const enabledExplicit = input.enabled !== undefined;
    const reasonExplicit = 'disabled_reason' in input;

    let enabledValue: number;
    if (enabledExplicit) enabledValue = input.enabled ? 1 : 0;
    else if (existing) enabledValue = existing.enabled ? 1 : 0;
    else enabledValue = 1;

    let reasonValue: string | null;
    if (reasonExplicit) reasonValue = input.disabled_reason ?? null;
    else if (existing) reasonValue = existing.disabled_reason ?? null;
    else reasonValue = null;

    await db.execute({
      sql: `
        INSERT OR REPLACE INTO voices
          (id, label, source, provider, model_id, lineage, vendor_family,
           input_cost_per_mtok, output_cost_per_mtok, enabled,
           disabled_reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        input.id,
        input.label,
        input.source,
        input.provider,
        input.model_id,
        input.lineage,
        input.vendor_family ?? null,
        input.input_cost_per_mtok ?? null,
        input.output_cost_per_mtok ?? null,
        enabledValue,
        reasonValue,
        existing?.created_at ?? now,
        now,
      ],
    });

    const row = await voices.getById(input.id);
    if (!row) throw new Error(`voices.upsert: row vanished: ${input.id}`);
    return row;
  },

  async list(filter?: VoiceListFilter): Promise<VoiceRow[]> {
    const db = await getDb();
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter?.lineage) {
      where.push('lineage = ?');
      args.push(filter.lineage);
    }
    if (filter?.source) {
      where.push('source = ?');
      args.push(filter.source);
    }
    if (filter?.provider) {
      where.push('provider = ?');
      args.push(filter.provider);
    }
    if (filter?.enabled !== undefined) {
      where.push('enabled = ?');
      args.push(filter.enabled ? 1 : 0);
    }
    const sql =
      'SELECT * FROM voices' +
      (where.length > 0 ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY provider ASC, label ASC';
    const result = await db.execute({ sql, args: args as never });
    return result.rows.map((row) => VoiceRowSchema.parse(row));
  },

  async getById(id: string): Promise<VoiceRow | null> {
    const db = await getDb();
    const result = await db.execute({
      sql: 'SELECT * FROM voices WHERE id = ?',
      args: [id],
    });
    if (result.rows.length === 0) return null;
    return VoiceRowSchema.parse(result.rows[0]);
  },

  async update(id: string, partial: VoiceUpdateInput): Promise<VoiceRow> {
    const db = await getDb();
    const existing = await voices.getById(id);
    if (!existing) throw new Error(`Voice ${id} not found`);

    const enabledChanged =
      partial.enabled !== undefined && partial.enabled !== existing.enabled;
    const reasonExplicit = 'disabled_reason' in partial;

    // Default reason policy: when the caller flips enabled without
    // touching disabled_reason, we record intent automatically.
    //   - enabled true→false → 'user' (cockpit/API toggle counts as user
    //     intent unless caller says otherwise)
    //   - enabled false→true → null (re-enabling clears any stale auto/user)
    let nextReason: string | null;
    if (reasonExplicit) {
      nextReason = partial.disabled_reason ?? null;
    } else if (enabledChanged) {
      nextReason = partial.enabled ? null : 'user';
    } else {
      nextReason = existing.disabled_reason ?? null;
    }

    const next = {
      label: partial.label ?? existing.label,
      enabled: partial.enabled ?? existing.enabled,
      input_cost_per_mtok:
        partial.input_cost_per_mtok !== undefined
          ? partial.input_cost_per_mtok
          : existing.input_cost_per_mtok,
      output_cost_per_mtok:
        partial.output_cost_per_mtok !== undefined
          ? partial.output_cost_per_mtok
          : existing.output_cost_per_mtok,
      model_id: partial.model_id ?? existing.model_id,
      disabled_reason: nextReason,
    };

    await db.execute({
      sql: `
        UPDATE voices
        SET label = ?, enabled = ?, input_cost_per_mtok = ?, output_cost_per_mtok = ?, model_id = ?,
            disabled_reason = ?, updated_at = ?
        WHERE id = ?
      `,
      args: [
        next.label,
        next.enabled ? 1 : 0,
        next.input_cost_per_mtok,
        next.output_cost_per_mtok,
        next.model_id,
        next.disabled_reason,
        Date.now(),
        id,
      ],
    });

    const row = await voices.getById(id);
    if (!row) throw new Error(`voices.update: row vanished: ${id}`);
    return row;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute({ sql: 'DELETE FROM voices WHERE id = ?', args: [id] });
  },
};
