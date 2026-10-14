/**
 * Processing runtime: воркеры incoming_transactions, outbox_events, outgoing_notifications
 * и единый StuckProcessingJob (сброс зависших processing/sending).
 * Реализация — EP1 T1.4–T1.7.
 *
 * На первом шаге добавляем воркер incoming_transactions по паттерну
 * SELECT ... FOR UPDATE SKIP LOCKED + статус pending/processing/processed.
 */

import { getConfig } from '../../config/index.js';
import { getDatabaseService } from '../DatabaseService.js';
import { createEnvelope } from '../eventContract/index.js';
import { getMqttPublisher } from '../MqttClient.js';
import handleOtpMessage from '../../mqtt/sequoia/otp/index.js';
import { getNextRetryAt } from '../outgoingBackoff.js';
import { sendSlackDm, sendSlackToChannel } from '../slackDelivery.js';
import { logger } from '../logger.js';
import { processIncomingBatch, type IncomingRow } from '../../modules/transactions/index.js';
import {
  processSingleStatementJob,
  processOneStatementImportBankTransactionRow,
} from '../../modules/statementsImport/index.js';
import { startQueueNotificationWorker } from '../queueNotificationWorker.js';
import { startProfileAuthChangeWorker } from '../profileAuthChangeWorker.js';
import { startUnlinkDeadWorker } from '../unlinkDeadWorker.js';
import { startFarmNewGeoReportWorker } from '../farmNewGeoReportWorker.js';
import { processOutboxEvent, type OutboxRow } from '../outboxHandlers.js';
import {
  setIncomingStatusToProcessing,
  setIncomingReclaimPending,
  setIncomingStuckToFailed,
  setOutboxStatusToProcessing,
  setOutboxStatusToProcessed,
  setOutboxStatusToFailed,
  setOutboxReclaimPending,
  setOutboxStuckToFailed,
  setOutgoingStatusToSent,
  setOutgoingStatusAfterSend,
  setOutgoingReclaimPending,
} from '../stateTransitions.js';

export interface ProcessingRuntime {
  /** Запустить все воркеры и stuck job. */
  start(): Promise<void>;
  /** Остановить воркеры и job (graceful). */
  stop(): Promise<void>;
}

type WorkerHandle = {
  stop: () => Promise<void>;
};

async function startIncomingTransactionsWorker(): Promise<WorkerHandle> {
  const config = getConfig();
  const db = getDatabaseService(config);

  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        // Берём небольшую порцию pending-записей и помечаем их processing в одной транзакции
        const processedIds = await db.withTransaction('main', async (client) => {
          const selectRes = await client.query<{ id: number }>(
            `SELECT id
             FROM public.incoming_transactions
             WHERE status = 'pending'
             ORDER BY id
             FOR UPDATE SKIP LOCKED
             LIMIT 10`,
          );

          const ids = selectRes.rows.map((r) => r.id);
          if (ids.length === 0) {
            return ids;
          }

          await setIncomingStatusToProcessing(client, ids);

          return ids;
        });

        if (processedIds.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        const rowsRes = await db.withTransaction('main', async (client) => {
          const r = await client.query<IncomingRow>(
            `SELECT id, bank, raw_payload, idempotency_key, correlation_id
             FROM public.incoming_transactions WHERE id = ANY($1::int[])`,
            [processedIds],
          );
          return r.rows;
        });

        await db.withTransaction('main', async (client) => {
          await processIncomingBatch(client, rowsRes);
        });
      } catch (err) {
        logger.error('IncomingTransactionsWorker loop error', err as Error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  };

  // Запускаем фоновый цикл (fire-and-forget)
  void loop();

  return {
    async stop() {
      stopped = true;
    },
  };
}

async function startOutboxEventsWorker(): Promise<WorkerHandle> {
  const config = getConfig();
  const db = getDatabaseService(config);

  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        const processedIds = await db.withTransaction('main', async (client) => {
          const selectRes = await client.query<{ id: number }>(
            `SELECT id
             FROM public.outbox_events
             WHERE status = 'pending'
             ORDER BY id
             FOR UPDATE SKIP LOCKED
             LIMIT 10`,
          );

          const ids = selectRes.rows.map((r) => r.id);
          if (ids.length === 0) {
            return ids;
          }

          await setOutboxStatusToProcessing(client, ids);
          return ids;
        });

        if (processedIds.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        const rows = await db.withTransaction('main', async (client) => {
          const r = await client.query<OutboxRow>(
            `SELECT id, event_type, payload, correlation_id
             FROM public.outbox_events WHERE id = ANY($1::int[])`,
            [processedIds],
          );
          return r.rows;
        });

        const processed: number[] = [];
        const failed: number[] = [];

        for (const row of rows) {
          const payload = (row.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<string, unknown>;
          try {
            await processOutboxEvent({
              id: row.id,
              event_type: row.event_type,
              payload,
              correlation_id: row.correlation_id,
            });
            processed.push(row.id);
          } catch (err) {
            logger.error('OutboxEventsWorker process error', {
              id: row.id,
              event_type: row.event_type,
              error: err instanceof Error ? err.message : err,
            });
            failed.push(row.id);
          }
        }

        await db.withTransaction('main', async (client) => {
          if (processed.length > 0) {
            await setOutboxStatusToProcessed(client, processed);
          }
          if (failed.length > 0) {
            await setOutboxStatusToFailed(client, failed);
          }
        });
      } catch (err) {
        logger.error('OutboxEventsWorker loop error', err as Error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  };

  void loop();

  return {
    async stop() {
      stopped = true;
    },
  };
}

async function startOutgoingNotificationsWorker(): Promise<WorkerHandle> {
  const config = getConfig();
  const db = getDatabaseService(config);

  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        const sendingIds = await db.withTransaction('main', async (client) => {
          const selectRes = await client.query<{ id: number }>(
            `SELECT id
             FROM public.outgoing_notifications
             WHERE status = 'pending'
               AND (next_retry_at IS NULL OR next_retry_at <= NOW())
             ORDER BY id
             FOR UPDATE SKIP LOCKED
             LIMIT 20`,
          );

          const ids = selectRes.rows.map((r) => r.id);
          if (ids.length === 0) {
            return ids;
          }

          await client.query(
            `UPDATE public.outgoing_notifications
             SET status = 'sending', sending_started_at = NOW()
             WHERE id = ANY($1::int[])`,
            [ids],
          );

          return ids;
        });

        if (sendingIds.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        const rows = await db.withTransaction('main', async (client) => {
          const r = await client.query<{
            id: number;
            channel: string;
            recipient: string | null;
            payload: unknown;
            attempts: number;
            max_attempts: number;
            correlation_id: string | null;
          }>(
            `SELECT id, channel, recipient, payload, attempts, max_attempts, correlation_id
             FROM public.outgoing_notifications WHERE id = ANY($1::int[])`,
            [sendingIds],
          );
          return r.rows;
        });

        const mqtt = getMqttPublisher(config);
        const sentIds: number[] = [];
        const failUpdates: { id: number; last_error: string; attempts: number; max_attempts: number }[] = [];

        logger.info('OutgoingNotificationsWorker processing batch', {
          count: rows.length,
          ids: rows.map((r) => r.id),
          channels: rows.map((r) => r.channel),
        });

        for (const row of rows) {
          if (row.channel === 'mqtt:sequoia/otp') {
            // OTP обрабатываем напрямую (без публикации в MQTT): вызываем тот же обработчик,
            // который создаёт slack:dm, slack:#finance-otp и mqtt:sequoia/audit.
            try {
              const payloadBuffer = Buffer.from(
                JSON.stringify(row.payload ?? {}),
                'utf8',
              );
              await handleOtpMessage('sequoia/otp', payloadBuffer);
              sentIds.push(row.id);
              logger.info('OutgoingNotificationsWorker OTP handled (direct)', { id: row.id });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              logger.error('OutgoingNotificationsWorker OTP handler failed', { id: row.id, error: msg });
              failUpdates.push({
                id: row.id,
                last_error: msg.slice(0, 1000),
                attempts: row.attempts + 1,
                max_attempts: row.max_attempts,
              });
            }
          } else if (row.channel.startsWith('mqtt:')) {
            const baseTopic = row.channel.slice(5);
            const topic =
              config.mqtt.topicPrefix && config.mqtt.topicPrefix.length > 0
                ? `${config.mqtt.topicPrefix}${baseTopic}`
                : baseTopic;
            const payloadObj =
              row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : {};

            // Для audit-сервиса ожидается "голый" AuditEvent без envelope.
            const messagePayload =
              baseTopic === 'sequoia/audit'
                ? JSON.stringify(payloadObj)
                : createEnvelope(row.payload, {
                    producer: 'processor-hub',
                    correlation_id: row.correlation_id ?? (payloadObj.correlation_id as string | undefined),
                    idempotency_key: payloadObj.idempotency_key as string | undefined,
                  });

            try {
              await mqtt.connect();
              await mqtt.publish(topic, messagePayload);
              sentIds.push(row.id);
              logger.info('OutgoingNotificationsWorker sent', { id: row.id, channel: row.channel, topic });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              logger.error('OutgoingNotificationsWorker send failed', { id: row.id, channel: row.channel, error: msg });
              failUpdates.push({
                id: row.id,
                last_error: msg.slice(0, 1000),
                attempts: row.attempts + 1,
                max_attempts: row.max_attempts,
              });
            }
          } else if (row.channel.startsWith('slack:')) {
            const payloadObj =
              row.payload && typeof row.payload === 'object'
                ? (row.payload as Record<string, unknown>)
                : {};
            const message =
              typeof payloadObj.message === 'string'
                ? payloadObj.message
                : typeof payloadObj.text === 'string'
                  ? payloadObj.text
                  : JSON.stringify(row.payload ?? {});
            const blocks = Array.isArray((payloadObj as { blocks?: unknown[] }).blocks)
              ? ((payloadObj as { blocks?: unknown[] }).blocks as unknown[])
              : undefined;

            if (row.channel === 'slack:dm') {
              const email = (row.recipient ?? payloadObj.email ?? payloadObj.recipient) as string | null | undefined;
              const ok = await sendSlackDm(message, email ?? undefined, true);
              if (ok) {
                sentIds.push(row.id);
                logger.info('OutgoingNotificationsWorker sent', { id: row.id, channel: row.channel, recipient: email ?? '(none)' });
              } else {
                logger.warn('OutgoingNotificationsWorker Slack DM failed', { id: row.id, channel: row.channel, recipient: email ?? '(none)' });
                failUpdates.push({
                  id: row.id,
                  last_error: 'Slack DM delivery failed or not configured',
                  attempts: row.attempts + 1,
                  max_attempts: row.max_attempts,
                });
              }
            } else if (row.channel.startsWith('slack:#')) {
              const channelName = row.channel.slice('slack:#'.length).trim() || 'finance-otp';
              const ok = await sendSlackToChannel(channelName, message, blocks);
              if (ok) {
                sentIds.push(row.id);
                logger.info('OutgoingNotificationsWorker sent', { id: row.id, channel: row.channel, channelName });
              } else {
                logger.warn('OutgoingNotificationsWorker Slack channel failed', { id: row.id, channel: row.channel, channelName });
                failUpdates.push({
                  id: row.id,
                  last_error: 'Slack channel delivery failed or not configured',
                  attempts: row.attempts + 1,
                  max_attempts: row.max_attempts,
                });
              }
            } else {
              failUpdates.push({
                id: row.id,
                last_error: `Unknown Slack channel format: ${row.channel}`,
                attempts: row.attempts + 1,
                max_attempts: row.max_attempts,
              });
            }
          } else {
            failUpdates.push({
              id: row.id,
              last_error: `Unsupported channel: ${row.channel}`,
              attempts: row.attempts + 1,
              max_attempts: row.max_attempts,
            });
          }
        }

        if (sentIds.length > 0 || failUpdates.length > 0) {
          logger.info('OutgoingNotificationsWorker batch result', {
            sent: sentIds.length,
            sentIds: sentIds.slice(0, 20),
            failed: failUpdates.length,
            failures: failUpdates.map((f) => ({ id: f.id, error: f.last_error.slice(0, 80) })),
          });
        }

        await db.withTransaction('main', async (client) => {
          if (sentIds.length > 0) {
            await setOutgoingStatusToSent(client, sentIds);
          }
          for (const f of failUpdates) {
            const status = f.attempts >= f.max_attempts ? 'failed' : 'pending';
            const nextRetryAt = status === 'pending' ? getNextRetryAt(Math.max(0, f.attempts - 1)) : null;
            await setOutgoingStatusAfterSend(client, {
              id: f.id,
              status,
              attempts: f.attempts,
              last_error: f.last_error,
              next_retry_at: nextRetryAt,
            });
          }
        });
      } catch (err) {
        logger.error('OutgoingNotificationsWorker loop error', {
          error: err instanceof Error ? err.message : String(err),
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  };

  void loop();

  return {
    async stop() {
      stopped = true;
    },
  };
}

async function startStatementImportWorker(): Promise<WorkerHandle> {
  const config = getConfig();
  const db = getDatabaseService(config);

  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        const jobIds = await db.withTransaction('main', async (client) => {
          const selectRes = await client.query<{ id: string }>(
            `SELECT id
             FROM public.statement_import_jobs
             WHERE status = 'pending'
             ORDER BY created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 5`,
          );

          const ids = selectRes.rows.map((r) => r.id);
          if (ids.length === 0) {
            return ids;
          }

          await client.query(
            `UPDATE public.statement_import_jobs
             SET status = 'processing', started_at = NOW()
             WHERE id = ANY($1::uuid[])`,
            [ids],
          );

          return ids;
        });

        if (jobIds.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }

        for (const jobId of jobIds) {
          try {
            await processSingleStatementJob(jobId);
          } catch (err) {
            logger.error('StatementImportWorker job error', {
              jobId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        logger.error('StatementImportWorker loop error', {
          error: err instanceof Error ? err.message : String(err),
        });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  };

  void loop();

  return {
    async stop() {
      stopped = true;
    },
  };
}

/** Очередь statement_import_parsed_rows → bank_transactions + outgoing audit (как отдельный проход после processed job). */
async function startStatementImportBankTransactionsWorker(): Promise<WorkerHandle> {
  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        const did = await processOneStatementImportBankTransactionRow();
        if (!did) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      } catch (err) {
        logger.error('StatementImportBankTransactionsWorker loop error', {
          error: err instanceof Error ? err.message : String(err),
        });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  };

  void loop();

  return {
    async stop() {
      stopped = true;
    },
  };
}

/** Reclaim/requeue semantics (Priority 1.5): зависшие processing/sending возвращаются в pending или failed по таймауту и лимиту попыток. */
async function startStuckProcessingJob(): Promise<WorkerHandle> {
  const config = getConfig();
  const db = getDatabaseService(config);
  const timeouts = config.processingRuntime;

  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        await db.withTransaction('main', async (client) => {
          await setIncomingReclaimPending(client, {
            timeoutMinutes: timeouts.stuckIncomingTimeoutMinutes,
            maxAttempts: timeouts.incomingMaxProcessingAttempts,
          });
          await setIncomingStuckToFailed(client, {
            timeoutMinutes: timeouts.stuckIncomingTimeoutMinutes,
            maxAttempts: timeouts.incomingMaxProcessingAttempts,
          });

          await setOutboxReclaimPending(client, {
            timeoutMinutes: timeouts.stuckOutboxTimeoutMinutes,
            maxAttempts: timeouts.outboxMaxProcessingAttempts,
          });
          await setOutboxStuckToFailed(client, {
            timeoutMinutes: timeouts.stuckOutboxTimeoutMinutes,
            maxAttempts: timeouts.outboxMaxProcessingAttempts,
          });

          await setOutgoingReclaimPending(client, {
            timeoutMinutes: timeouts.stuckOutgoingTimeoutMinutes,
          });
        });
      } catch (err) {
        logger.error('StuckProcessingJob loop error', err as Error);
      }

      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  };

  void loop();

  return {
    async stop() {
      stopped = true;
    },
  };
}

let instance: ProcessingRuntime | null = null;

export function getProcessingRuntime(): ProcessingRuntime {
  if (instance) return instance;

  let workers: WorkerHandle[] = [];

  instance = {
    async start() {
      logger.info('ProcessingRuntime starting...');
      const incoming = await startIncomingTransactionsWorker();
      const outbox = await startOutboxEventsWorker();
      const outgoing = await startOutgoingNotificationsWorker();
      const queueNotification = await startQueueNotificationWorker();
      const profileAuthChange = await startProfileAuthChangeWorker();
      const unlinkDead = await startUnlinkDeadWorker();
      const farmNewGeo = await startFarmNewGeoReportWorker();
      const stuck = await startStuckProcessingJob();
      const statements = await startStatementImportWorker();
      const statementBankTx = await startStatementImportBankTransactionsWorker();
      workers = [incoming, outbox, outgoing, queueNotification, profileAuthChange, unlinkDead, farmNewGeo, stuck, statements, statementBankTx];
      logger.info('ProcessingRuntime started');
    },
    async stop() {
      logger.info('ProcessingRuntime stopping...');
      await Promise.all(workers.map((w) => w.stop()));
      workers = [];
      logger.info('ProcessingRuntime stopped');
    },
  };

  return instance;
}

export function resetProcessingRuntime(): void {
  instance = null;
}
