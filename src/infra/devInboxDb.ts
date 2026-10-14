/**
 * Dev Inbox: таблица dev_inbox_events (processor_hub_dev_simulation_spec.md).
 * Доступ только при config.devSimulation.enabled.
 */

import type { PoolClient } from 'pg';

export interface DevInboxEventRow {
  id: string;
  source: string;
  event_type: string;
  external_id: string | null;
  correlation_id: string | null;
  aggregate_key: string | null;
  payload: unknown;
  meta: unknown;
  status: string;
  error: string | null;
  replay_of_event_id: string | null;
  scheduled_at: Date;
  created_at: Date;
  processed_at: Date | null;
  created_by: string | null;
}

export interface InsertDevInboxEventParams {
  id: string;
  source: string;
  event_type: string;
  payload: unknown;
  external_id?: string | null;
  correlation_id?: string | null;
  aggregate_key?: string | null;
  meta?: unknown;
  created_by?: string | null;
  replay_of_event_id?: string | null;
}

export async function insertDevInboxEvent(client: PoolClient, params: InsertDevInboxEventParams): Promise<void> {
  await client.query(
    `INSERT INTO dev_inbox_events (
      id, source, event_type, payload,
      external_id, correlation_id, aggregate_key, meta, created_by, replay_of_event_id
    ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9, $10)`,
    [
      params.id,
      params.source,
      params.event_type,
      JSON.stringify(params.payload ?? {}),
      params.external_id ?? null,
      params.correlation_id ?? null,
      params.aggregate_key ?? null,
      params.meta ? JSON.stringify(params.meta) : null,
      params.created_by ?? null,
      params.replay_of_event_id ?? null,
    ],
  );
}

/** Заблокировать и взять пачку pending (FOR UPDATE SKIP LOCKED), пометить processing. Возвращает id и строки. */
export async function takePendingDevInboxEvents(
  client: PoolClient,
  limit: number,
): Promise<{ id: string; source: string; event_type: string; payload: unknown; correlation_id: string | null }[]> {
  const sel = await client.query<{ id: string; source: string; event_type: string; payload: unknown; correlation_id: string | null }>(
    `SELECT id, source, event_type, payload, correlation_id
     FROM dev_inbox_events
     WHERE status = 'pending' AND scheduled_at <= NOW()
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT $1`,
    [limit],
  );
  const rows = sel.rows;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  await client.query(
    `UPDATE dev_inbox_events SET status = 'processing' WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return rows;
}

export async function markDevInboxProcessed(client: PoolClient, id: string): Promise<void> {
  await client.query(
    `UPDATE dev_inbox_events SET status = 'processed', processed_at = NOW(), error = NULL WHERE id = $1`,
    [id],
  );
}

export async function markDevInboxFailed(client: PoolClient, id: string, errorMessage: string): Promise<void> {
  await client.query(
    `UPDATE dev_inbox_events SET status = 'failed', processed_at = NOW(), error = $2 WHERE id = $1`,
    [id, errorMessage.slice(0, 2000)],
  );
}

export async function listDevInboxEvents(
  client: PoolClient,
  opts: { limit?: number; status?: string } = {},
): Promise<DevInboxEventRow[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);
  let q = `SELECT id, source, event_type, external_id, correlation_id, aggregate_key, payload, meta, status, error, replay_of_event_id, scheduled_at, created_at, processed_at, created_by FROM dev_inbox_events`;
  const args: unknown[] = [];
  if (opts.status) {
    args.push(opts.status);
    q += ` WHERE status = $1`;
  }
  q += ` ORDER BY created_at DESC LIMIT ${args.length + 1}`;
  args.push(limit);
  const res = await client.query<DevInboxEventRow>(q, args);
  return res.rows;
}

export async function getDevInboxEventById(client: PoolClient, id: string): Promise<DevInboxEventRow | null> {
  const res = await client.query<DevInboxEventRow>(
    `SELECT id, source, event_type, external_id, correlation_id, aggregate_key, payload, meta, status, error, replay_of_event_id, scheduled_at, created_at, processed_at, created_by
     FROM dev_inbox_events WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

/** Результат обработки события: созданные incoming_transactions и bank_transactions по correlation_id. */
export interface DevInboxOutcome {
  correlation_id: string | null;
  incoming_transactions: { id: number; bank: string; status: string }[];
  bank_transactions: { bank: string; ext_id: string; amount: number | null; currency: string | null; idempotency_key: string | null }[];
}

export async function getDevInboxOutcome(client: PoolClient, correlationId: string | null): Promise<DevInboxOutcome> {
  const corr = correlationId ?? '';
  if (!corr) {
    return { correlation_id: null, incoming_transactions: [], bank_transactions: [] };
  }
  const inc = await client.query<{ id: number; bank: string; status: string }>(
    `SELECT id, bank, status FROM incoming_transactions WHERE correlation_id = $1 ORDER BY id`,
    [corr],
  );
  const bt = await client.query<{ bank: string; ext_id: string; amount: number | null; currency: string | null; idempotency_key: string | null }>(
    `SELECT bank, ext_id, amount, currency, idempotency_key FROM bank_transactions WHERE correlation_id = $1`,
    [corr],
  );
  return {
    correlation_id: corr,
    incoming_transactions: inc.rows,
    bank_transactions: bt.rows,
  };
}
