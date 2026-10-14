/**
 * Запись строки в `public.ops_incidents`.
 */

import type { PoolClient } from 'pg';
import type { RecordIncidentParams, RecordIncidentResult } from './types.js';

export async function recordIncident(
  client: PoolClient,
  params: RecordIncidentParams,
): Promise<RecordIncidentResult> {
  const severity = params.severity ?? 'info';
  const detailJson = JSON.stringify(params.detail ?? {});
  const occurredAt = params.occurred_at ?? new Date();
  const dedupKeyRaw = params.dedup_key?.trim() ?? '';
  const dedupKey = dedupKeyRaw.length > 0 ? dedupKeyRaw : null;

  const res = await client.query<{ id: number }>(
    `INSERT INTO public.ops_incidents (
       occurred_at, source, kind, severity, summary, detail, correlation_id, dedup_key
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING id`,
    [
      occurredAt,
      params.source,
      params.kind,
      severity,
      params.summary,
      detailJson,
      params.correlation_id ?? null,
      dedupKey,
    ],
  );
  return { id: res.rows[0]?.id ?? null };
}
