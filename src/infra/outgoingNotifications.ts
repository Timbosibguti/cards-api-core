/**
 * Единая точка постановки записей в public.outgoing_notifications.
 * Все каналы: mqtt:sequoia/audit, mqtt:sequoia/transaction, mqtt:sequoia/otp,
 * slack:dm, slack:#card-link, slack:#farm-otp, slack:#finance-otp и т.д.
 * Вызывать только внутри транзакции (передавать PoolClient).
 */

import type { PoolClient } from 'pg';

export interface EnqueueOutgoingParams {
  /** Канал доставки: mqtt:sequoia/audit, slack:dm, slack:#channel и т.п. */
  channel: string;
  /** Тело уведомления (сериализуется в JSONB). */
  payload: object;
  /** Ключ дедупликации (UNIQUE). При конфликте вставка пропускается (ON CONFLICT DO NOTHING). */
  dedupKey: string;
  /** ID корреляции для трассировки. Может быть null. */
  correlationId: string | null;
  /** Получатель (email/userId) для slack:dm; для остальных каналов — null/не передавать. */
  recipient?: string | null;
}

/**
 * Ставит одну запись в очередь outgoing_notifications (status = 'pending').
 * Вызывать из кода, уже имеющего PoolClient (в транзакции main DB).
 */
export async function enqueueOutgoingNotification(
  client: PoolClient,
  params: EnqueueOutgoingParams,
): Promise<void> {
  await client.query(
    `INSERT INTO public.outgoing_notifications (channel, recipient, payload, dedup_key, status, correlation_id)
     VALUES ($1, $2, $3::jsonb, $4, 'pending', $5)
     ON CONFLICT (dedup_key) DO NOTHING`,
    [
      params.channel,
      params.recipient ?? null,
      JSON.stringify(params.payload),
      params.dedupKey,
      params.correlationId,
    ],
  );
}
