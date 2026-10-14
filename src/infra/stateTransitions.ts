/**
 * Переходы состояний для incoming_transactions, outbox_events, outgoing_notifications.
 * Единственная точка описания допустимых переходов (см. docs/state_machines.md).
 * Воркеры выполняют UPDATE здесь через set*StatusBatch; допустимые переходы экспортируются для тестов и валидации.
 */

import type { PoolClient } from 'pg';

/** Допустимые переходы: from -> to[] */
export const INCOMING_ALLOWED: Record<string, string[]> = {
  pending: ['processing'],
  processing: ['processed', 'failed', 'pending'],
  processed: [],
  failed: [],
};

export const OUTBOX_ALLOWED: Record<string, string[]> = {
  pending: ['processing'],
  processing: ['processed', 'failed', 'pending'],
  processed: [],
  failed: [],
};

export const OUTGOING_ALLOWED: Record<string, string[]> = {
  pending: ['sending'],
  sending: ['sent', 'failed', 'pending', 'rate_limited'],
  sent: [],
  failed: [],
  rate_limited: ['pending'],
};

function isAllowed(allowed: Record<string, string[]>, from: string, to: string): boolean {
  const next = allowed[from];
  if (!next) return false;
  return next.includes(to);
}

export function isAllowedIncomingTransition(from: string, to: string): boolean {
  return isAllowed(INCOMING_ALLOWED, from, to);
}

export function isAllowedOutboxTransition(from: string, to: string): boolean {
  return isAllowed(OUTBOX_ALLOWED, from, to);
}

export function isAllowedOutgoingTransition(from: string, to: string): boolean {
  return isAllowed(OUTGOING_ALLOWED, from, to);
}

/** Incoming: пометить пачку pending → processing (воркер взял в работу). */
export async function setIncomingStatusToProcessing(client: PoolClient, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await client.query(
    `UPDATE public.incoming_transactions
     SET status = 'processing', processing_started_at = NOW()
     WHERE id = ANY($1::int[]) AND status = 'pending'`,
    [ids],
  );
}

/** Incoming: пометить пачку processing → processed. Обновляются только строки с допустимым переходом (guard). */
export async function setIncomingStatusToProcessed(client: PoolClient, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const res = await client.query<{ id: number; status: string }>(
    `SELECT id, status FROM public.incoming_transactions WHERE id = ANY($1::int[])`,
    [ids],
  );
  const allowedIds = res.rows.filter((r) => isAllowedIncomingTransition(r.status, 'processed')).map((r) => r.id);
  if (allowedIds.length === 0) return;
  await client.query(
    `UPDATE public.incoming_transactions SET status = 'processed', processed_at = NOW() WHERE id = ANY($1::int[])`,
    [allowedIds],
  );
}

/** Incoming: пометить пачку processing → failed. Обновляются только строки с допустимым переходом (guard). */
export async function setIncomingStatusToFailed(client: PoolClient, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const res = await client.query<{ id: number; status: string }>(
    `SELECT id, status FROM public.incoming_transactions WHERE id = ANY($1::int[])`,
    [ids],
  );
  const allowedIds = res.rows.filter((r) => isAllowedIncomingTransition(r.status, 'failed')).map((r) => r.id);
  if (allowedIds.length === 0) return;
  await client.query(
    `UPDATE public.incoming_transactions SET status = 'failed' WHERE id = ANY($1::int[])`,
    [allowedIds],
  );
}

/** Incoming: reclaim — processing → pending, увеличить attempts (StuckProcessingJob). */
export async function setIncomingReclaimPending(
  client: PoolClient,
  opts: { timeoutMinutes: number; maxAttempts: number },
): Promise<void> {
  await client.query(
    `UPDATE public.incoming_transactions
     SET status = 'pending', processing_started_at = NULL, processing_attempts = processing_attempts + 1
     WHERE status = 'processing'
       AND processing_started_at < NOW() - ($1 || ' minutes')::interval
       AND processing_attempts < $2`,
    [opts.timeoutMinutes, opts.maxAttempts],
  );
}

/** Incoming: processing → failed по лимиту попыток (StuckProcessingJob). */
export async function setIncomingStuckToFailed(
  client: PoolClient,
  opts: { timeoutMinutes: number; maxAttempts: number },
): Promise<void> {
  await client.query(
    `UPDATE public.incoming_transactions SET status = 'failed'
     WHERE status = 'processing'
       AND processing_started_at < NOW() - ($1 || ' minutes')::interval
       AND processing_attempts >= $2`,
    [opts.timeoutMinutes, opts.maxAttempts],
  );
}

/** Outbox: pending → processing (воркер взял в работу; attempts +1 для reclaim). */
export async function setOutboxStatusToProcessing(client: PoolClient, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await client.query(
    `UPDATE public.outbox_events
     SET status = 'processing', processing_started_at = NOW(), processing_attempts = processing_attempts + 1
     WHERE id = ANY($1::int[]) AND status = 'pending'`,
    [ids],
  );
}

/** Outbox: reclaim и stuck→failed (аналогично incoming). */
export async function setOutboxReclaimPending(
  client: PoolClient,
  opts: { timeoutMinutes: number; maxAttempts: number },
): Promise<void> {
  await client.query(
    `UPDATE public.outbox_events
     SET status = 'pending', processing_started_at = NULL, processing_attempts = processing_attempts + 1
     WHERE status = 'processing'
       AND processing_started_at < NOW() - ($1 || ' minutes')::interval
       AND processing_attempts < $2`,
    [opts.timeoutMinutes, opts.maxAttempts],
  );
}

export async function setOutboxStuckToFailed(
  client: PoolClient,
  opts: { timeoutMinutes: number; maxAttempts: number },
): Promise<void> {
  await client.query(
    `UPDATE public.outbox_events SET status = 'failed'
     WHERE status = 'processing'
       AND processing_started_at < NOW() - ($1 || ' minutes')::interval
       AND processing_attempts >= $2`,
    [opts.timeoutMinutes, opts.maxAttempts],
  );
}

/** Outbox: processing → processed. Только допустимые переходы (guard). */
export async function setOutboxStatusToProcessed(client: PoolClient, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const res = await client.query<{ id: number; status: string }>(
    `SELECT id, status FROM public.outbox_events WHERE id = ANY($1::int[])`,
    [ids],
  );
  const allowedIds = res.rows.filter((r) => isAllowedOutboxTransition(r.status, 'processed')).map((r) => r.id);
  if (allowedIds.length === 0) return;
  await client.query(
    `UPDATE public.outbox_events SET status = 'processed', processed_at = NOW() WHERE id = ANY($1::int[])`,
    [allowedIds],
  );
}

/** Outbox: processing → failed. Только допустимые переходы (guard). */
export async function setOutboxStatusToFailed(client: PoolClient, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const res = await client.query<{ id: number; status: string }>(
    `SELECT id, status FROM public.outbox_events WHERE id = ANY($1::int[])`,
    [ids],
  );
  const allowedIds = res.rows.filter((r) => isAllowedOutboxTransition(r.status, 'failed')).map((r) => r.id);
  if (allowedIds.length === 0) return;
  await client.query(
    `UPDATE public.outbox_events SET status = 'failed' WHERE id = ANY($1::int[])`,
    [allowedIds],
  );
}

/** Outgoing: sending → sent. Только допустимые переходы (guard). */
export async function setOutgoingStatusToSent(client: PoolClient, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const res = await client.query<{ id: number; status: string }>(
    `SELECT id, status FROM public.outgoing_notifications WHERE id = ANY($1::int[])`,
    [ids],
  );
  const allowedIds = res.rows.filter((r) => isAllowedOutgoingTransition(r.status, 'sent')).map((r) => r.id);
  if (allowedIds.length === 0) return;
  await client.query(
    `UPDATE public.outgoing_notifications
     SET status = 'sent', attempts = attempts + 1, sent_at = NOW()
     WHERE id = ANY($1::int[])`,
    [allowedIds],
  );
}

/** Outgoing: sending → failed или pending после попытки отправки. По одному id (разные attempts/next_retry_at). */
export async function setOutgoingStatusAfterSend(
  client: PoolClient,
  item: { id: number; status: 'failed' | 'pending'; attempts: number; last_error: string; next_retry_at: Date | null },
): Promise<void> {
  const res = await client.query<{ status: string }>(
    `SELECT status FROM public.outgoing_notifications WHERE id = $1`,
    [item.id],
  );
  const row = res.rows[0];
  if (!row || !isAllowedOutgoingTransition(row.status, item.status)) return;
  await client.query(
    `UPDATE public.outgoing_notifications
     SET status = $1, attempts = $2, last_error = $3, next_retry_at = $4
     WHERE id = $5`,
    [item.status, item.attempts, item.last_error, item.next_retry_at, item.id],
  );
}

/** Outgoing: sending → pending (reclaim по таймауту). */
export async function setOutgoingReclaimPending(
  client: PoolClient,
  opts: { timeoutMinutes: number },
): Promise<void> {
  await client.query(
    `UPDATE public.outgoing_notifications
     SET status = 'pending', sending_started_at = NULL
     WHERE status = 'sending' AND sending_started_at < NOW() - ($1 || ' minutes')::interval`,
    [opts.timeoutMinutes],
  );
}
