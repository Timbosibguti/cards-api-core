/**
 * Воркер истечения очереди на банк (queue).
 * Следит за expires_at: предупреждает сотрудника за 10 мин, по истечении — уведомляет и снимает с очереди.
 * Все уведомления и аудит — через outgoing_notifications (слой доставки), без прямого Slack.
 * Совместимость с mqtt_otp_transactions_service QueueNotificationService.
 */

import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../config/index.js';
import { getDatabaseService } from './index.js';
import { createCorrelationId } from './correlation/index.js';
import { logger } from './logger.js';
import { enqueueOutgoingNotification } from './outgoingNotifications.js';
import { invalidateQueueStatusCache } from './queueStatusCache.js';

const INTERVAL_MS = 60 * 1000; // 1 минута

type WorkerHandle = { stop: () => Promise<void> };

interface ReservationRow {
  id: number;
  email: string;
  bank: string;
  acc_no: string;
  account_name: string;
  expires_at: Date;
  minutes_remaining: number;
}

async function getExpiredReservations(client: PoolClient): Promise<ReservationRow[]> {
  const result = await client.query<{
    id: number;
    email: string;
    bank: string;
    acc_no: string;
    name: string;
    expires_at: Date;
  }>(
    `SELECT q.id, q.email, q.bank, q.acc_no, ba.name, q.expires_at
     FROM public.queue q
     JOIN public.bank_accounts ba ON q.bank = ba.bank AND q.acc_no = ba.acc_no
     WHERE q.expires_at <= NOW()
     ORDER BY q.expires_at ASC`,
  );
  const now = new Date();
  return result.rows.map((r) => ({
    id: r.id,
    email: r.email,
    bank: r.bank,
    acc_no: r.acc_no,
    account_name: r.name,
    expires_at: new Date(r.expires_at),
    minutes_remaining: Math.ceil((new Date(r.expires_at).getTime() - now.getTime()) / (1000 * 60)),
  }));
}

async function getExpiringReservations(client: PoolClient): Promise<ReservationRow[]> {
  const result = await client.query<{
    id: number;
    email: string;
    bank: string;
    acc_no: string;
    name: string;
    expires_at: Date;
  }>(
    `SELECT q.id, q.email, q.bank, q.acc_no, ba.name, q.expires_at
     FROM public.queue q
     JOIN public.bank_accounts ba ON q.bank = ba.bank AND q.acc_no = ba.acc_no
     WHERE q.expires_at <= NOW() + INTERVAL '10 minutes'
       AND q.expires_at > NOW()
       AND (q.notification_sent IS NULL OR q.notification_sent = FALSE)
     ORDER BY q.expires_at ASC`,
  );
  const now = new Date();
  return result.rows.map((r) => ({
    id: r.id,
    email: r.email,
    bank: r.bank,
    acc_no: r.acc_no,
    account_name: r.name,
    expires_at: new Date(r.expires_at),
    minutes_remaining: Math.max(0, Math.ceil((new Date(r.expires_at).getTime() - now.getTime()) / (1000 * 60))),
  }));
}

/** Поставить в очередь Slack DM (slack:dm) и аудит (mqtt:sequoia/audit). */
async function enqueueSlackDm(client: PoolClient, params: {
  recipient: string;
  message: string;
  dedupKey: string;
  correlationId: string;
}): Promise<void> {
  const payload = {
    kind: 'queue_notification' as const,
    message: params.message,
    email: params.recipient,
    timestamp: new Date().toISOString(),
    correlation_id: params.correlationId,
  };
  await enqueueOutgoingNotification(client, {
    channel: 'slack:dm',
    payload,
    dedupKey: params.dedupKey,
    correlationId: params.correlationId,
    recipient: params.recipient,
  });
}

async function enqueueAudit(client: PoolClient, params: {
  user_email: string;
  event_type: string;
  event_attributes: Record<string, string>;
  correlationId: string;
}): Promise<void> {
  const payload = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    division: 'finance' as const,
    user_email: params.user_email,
    log_type: 'info' as const,
    severity: 1,
    event_type: params.event_type,
    event_attributes: params.event_attributes,
    correlation_id: params.correlationId,
  };
  const timeBucket = new Date().toISOString().slice(0, 16);
  const dedupKey = `audit:queue:${params.event_type}:${params.user_email}:${params.event_attributes.bank ?? ''}:${params.event_attributes.acc_no ?? ''}:${timeBucket}`;
  await enqueueOutgoingNotification(client, {
    channel: 'mqtt:sequoia/audit',
    payload,
    dedupKey,
    correlationId: params.correlationId,
  });
}

export async function startQueueNotificationWorker(): Promise<WorkerHandle> {
  const config = getConfig();
  const db = getDatabaseService(config);
  let stopped = false;

  const checkAndNotify = async (): Promise<void> => {
    try {
      let removedExpiredSlots = false;
      await db.withTransaction('main', async (client) => {
        const expired = await getExpiredReservations(client);
        for (const r of expired) {
          const correlationId = createCorrelationId();
          const message = `${r.account_name} истек и освобожден`;
          await enqueueSlackDm(client, {
            recipient: r.email,
            message,
            dedupKey: `queue:expired:${r.id}`,
            correlationId,
          });
          await enqueueAudit(client, {
            user_email: r.email,
            event_type: 'queue_slot_expired',
            event_attributes: {
              email: r.email,
              bank: r.bank,
              acc_no: r.acc_no,
              account_name: r.account_name,
            },
            correlationId,
          });
          await client.query('DELETE FROM public.queue WHERE id = $1', [r.id]);
          removedExpiredSlots = true;
          logger.info('Queue slot expired and removed', {
            email: r.email,
            bank: r.bank,
            acc_no: r.acc_no,
            account_name: r.account_name,
          });
        }

        const expiring = await getExpiringReservations(client);
        for (const r of expiring) {
          const correlationId = createCorrelationId();
          const message = `${r.account_name} истекает через ${r.minutes_remaining} мин`;
          await enqueueSlackDm(client, {
            recipient: r.email,
            message,
            dedupKey: `queue:expiring:${r.id}`,
            correlationId,
          });
          await client.query('UPDATE public.queue SET notification_sent = TRUE WHERE id = $1', [r.id]);
          logger.info('Queue expiration warning sent', {
            email: r.email,
            account_name: r.account_name,
            minutes_remaining: r.minutes_remaining,
          });
        }
      });
      if (removedExpiredSlots) {
        invalidateQueueStatusCache();
      }
    } catch (err) {
      logger.error('QueueNotificationWorker check failed', { error: err instanceof Error ? err.message : err });
    }
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      await checkAndNotify();
      await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    }
  };

  // первый проход сразу
  checkAndNotify().catch((e) => logger.error('QueueNotificationWorker initial check failed', e));
  void loop();

  return {
    async stop() {
      stopped = true;
    },
  };
}
