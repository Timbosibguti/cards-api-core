/**
 * Воркер перепривязки карт при изменении auth_id в tbl_profiles (Farm DB).
 * Читает лог из farm_ext.tbl_profile_auth_changes (триггер на tbl_profiles), обновляет bank_cards
 * в main DB, ставит аудит в outgoing_notifications (слой доставки).
 * Multi-DC: polling + FOR UPDATE SKIP LOCKED вместо LISTEN/NOTIFY.
 */

import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../config/index.js';
import { getDatabaseService, recordIncident } from './index.js';
import { createCorrelationId } from './correlation/index.js';
import { logger } from './logger.js';
import { updateWorkerStatus } from './runtimeStatus.js';
import { enqueueOutgoingNotification } from './outgoingNotifications.js';
import { setCardOwnership } from './cardOwnership.js';
import * as farmDb from './farmDb.js';
import { getTransactionsAdapter } from '../modules/transactions/adapters/index.js';
import type { BankId } from '../modules/transactions/types.js';

const POLL_INTERVAL_MS = 30 * 1000; // 30 сек
const BATCH_SIZE = 50;
const CONNECTION_WARN_THROTTLE_MS = 5 * 60 * 1000; // не спамить лог при недоступности Farm DB

type WorkerHandle = { stop: () => Promise<void> };

interface ProfileAuthChangeRow {
  id: number;
  profile_name: string;
  old_auth_id: string | null;
  new_auth_id: string | null;
}

/**
 * Забрать и «зарезервировать» непроцессенные записи в одной транзакции Farm DB:
 * SELECT FOR UPDATE SKIP LOCKED + сразу UPDATE processed_at = NOW(), чтобы другой инстанс не взял те же строки (multi-DC).
 */
async function claimPendingChanges(
  farmClient: PoolClient,
): Promise<ProfileAuthChangeRow[]> {
  const result = await farmClient.query<ProfileAuthChangeRow>(
    `SELECT id, profile_name, old_auth_id, new_auth_id
     FROM tbl_profile_auth_changes
     WHERE processed_at IS NULL
     ORDER BY id
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [BATCH_SIZE],
  );
  const rows = result.rows;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  await farmClient.query(
    `UPDATE tbl_profile_auth_changes SET processed_at = NOW() WHERE id = ANY($1::bigint[])`,
    [ids],
  );
  return rows;
}

/** Поставить аудит в outgoing_notifications (main DB). */
async function enqueueAudit(
  mainClient: PoolClient,
  params: {
    user_email: string;
    event_type: string;
    event_attributes: Record<string, string | number | null>;
    correlationId: string;
  },
): Promise<void> {
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
  const dedupAudit = `audit:profile_auth:${params.event_type}:${params.user_email}:${timeBucket}`;
  await enqueueOutgoingNotification(mainClient, {
    channel: 'mqtt:sequoia/audit',
    payload,
    dedupKey: dedupAudit,
    correlationId: params.correlationId,
  });
}

/** Поставить только аудит в outgoing_notifications (по владельцу карты, без Slack). */
async function enqueueAuditOnly(
  mainClient: PoolClient,
  params: {
    user_email: string;
    event_type: string;
    event_attributes: Record<string, string | number | null>;
    correlationId: string;
  },
): Promise<void> {
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
  const dedupAudit = `audit:${params.event_type}:${params.user_email}:${String(params.event_attributes.card_number ?? '')}:${timeBucket}`;
  await enqueueOutgoingNotification(mainClient, {
    channel: 'mqtt:sequoia/audit',
    payload,
    dedupKey: dedupAudit,
    correlationId: params.correlationId,
  });
}

/** Обработать одну запись: обновить bank_cards (main), bank_cards_history, аудит, снять лимиты при передаче. */
async function processOne(
  row: ProfileAuthChangeRow,
  farmClient: PoolClient,
  mainClient: PoolClient,
  db: ReturnType<typeof getDatabaseService>,
): Promise<void> {
  const correlationId = createCorrelationId();
  const profileName = row.profile_name?.trim() || '';
  if (!profileName) {
    logger.warn('ProfileAuthChangeWorker: empty profile_name, skipping', { id: row.id });
    return;
  }

  if (row.new_auth_id != null && row.new_auth_id !== '') {
    const email = await farmDb.getEmailByAuthId(farmClient, row.new_auth_id);
    if (!email) {
      logger.warn('ProfileAuthChangeWorker: no user for new_auth_id', {
        id: row.id,
        profile_name: profileName,
        new_auth_id: row.new_auth_id,
      });
      return;
    }

    const checkResult = await mainClient.query<{ card_number: string; bank: string; acc_no: string | null; ext_id: string | null; old_buyer: string | null }>(
      `SELECT card_number::text AS card_number, bank, acc_no, ext_id, buyer AS old_buyer
       FROM public.bank_cards
       WHERE profile_name = $1 AND (buyer IS NULL OR buyer = '' OR buyer <> $2)`,
      [profileName, email],
    );
    if (checkResult.rows.length === 0) {
      logger.debug('ProfileAuthChangeWorker: no cards to update', { profile_name: profileName, email });
      return;
    }

    await db.withTransaction('main', async (client) => {
      for (const card of checkResult.rows) {
        await setCardOwnership(client, {
          cardNumber: parseInt(card.card_number, 10),
          bank: card.bank,
          buyer: email,
          profileName,
          is_buying: true,
        });
      }
    });

    const isTransfer = checkResult.rows.some((r) => r.old_buyer && r.old_buyer !== email);
    const eventType = isTransfer ? 'card_transferred' : 'card_linked';
    await enqueueAudit(mainClient, {
      user_email: email,
      event_type: eventType,
      event_attributes: {
        profile_name: profileName,
        new_buyer: email,
        old_auth_id: row.old_auth_id,
        new_auth_id: row.new_auth_id,
        cards_updated: checkResult.rows.length,
      },
      correlationId,
    });

    // При передаче/привязке карты снимаем лимиты через адаптер и пишем аудит по владельцу (buyer).
    for (const card of checkResult.rows) {
      const adapter = getTransactionsAdapter(card.bank as BankId);
      if (adapter?.removeLimits) {
        try {
          const cardNumber = parseInt(card.card_number, 10);
          if (!Number.isFinite(cardNumber)) continue;
          await adapter.removeLimits({
            cardNumber,
            extId: card.ext_id,
            buyerEmail: email,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error('ProfileAuthChangeWorker: removeLimits failed', {
            card_number: card.card_number,
            bank: card.bank,
            email,
            err,
          });
          try {
            await db.withTransaction('main', async (client) => {
              await recordIncident(client, {
                source: 'profile_auth_change_worker',
                kind: 'remove_limits_provider_error',
                severity: 'error',
                summary: `removeLimits failed (${card.bank}): ${msg}`.slice(0, 1000),
                detail: {
                  bank: card.bank,
                  card_number: card.card_number,
                  ext_id: card.ext_id,
                  buyer_email: email,
                  profile_name: profileName,
                  profile_auth_change_id: row.id,
                  error_message: msg,
                },
                correlation_id: correlationId,
              });
            });
          } catch (recordErr) {
            logger.error(
              'ProfileAuthChangeWorker: recordIncident failed after removeLimits',
              recordErr as Error,
            );
          }
        }
      }
      // Аудит по владельцу карты (buyer) — обязательно.
      await enqueueAuditOnly(mainClient, {
        user_email: email,
        event_type: 'card_limits_removed',
        event_attributes: {
          card_number: card.card_number,
          bank: card.bank,
          buyer_email: email,
        },
        correlationId,
      });
    }

    logger.info('ProfileAuthChangeWorker: updated buyer for profile', {
      profile_name: profileName,
      email,
      rowCount: checkResult.rows.length,
      isTransfer,
    });
  } else {
    const checkResult = await mainClient.query<{ card_number: string; bank: string; old_buyer: string | null }>(
      `SELECT card_number::text, bank, buyer AS old_buyer
       FROM public.bank_cards WHERE profile_name = $1 AND buyer IS NOT NULL`,
      [profileName],
    );
    if (checkResult.rows.length === 0) {
      logger.debug('ProfileAuthChangeWorker: no cards with buyer to clear', { profile_name: profileName });
      return;
    }

    await db.withTransaction('main', async (client) => {
      for (const card of checkResult.rows) {
        await setCardOwnership(client, {
          cardNumber: parseInt(card.card_number, 10),
          bank: card.bank,
          buyer: null,
          profileName,
          is_buying: false,
        });
      }
    });
    const oldBuyers = [...new Set(checkResult.rows.map((r) => r.old_buyer).filter(Boolean))] as string[];
    await enqueueAudit(mainClient, {
      user_email: 'system@groscloud.com',
      event_type: 'card_returned_to_farm',
      event_attributes: {
        profile_name: profileName,
        old_buyers: oldBuyers.join(','),
        cards_cleared: checkResult.rows.length,
      },
      correlationId,
    });
    logger.info('ProfileAuthChangeWorker: cleared buyer for profile (returned to farm)', {
      profile_name: profileName,
      cards_cleared: checkResult.rows.length,
    });
  }
}

export async function startProfileAuthChangeWorker(): Promise<WorkerHandle> {
  const config = getConfig();
  const db = getDatabaseService(config);
  let stopped = false;
  let lastConnectionWarnAt = 0;

  const run = async (): Promise<void> => {
    try {
      const rows = await db.withTransaction('farm', (farmClient) => claimPendingChanges(farmClient));
      if (rows.length === 0) return;

      const mainClient = await db.getClient('main');
      try {
        for (const row of rows) {
          try {
            const farmClient = await db.getClient('farm');
            try {
              await processOne(row, farmClient, mainClient, db);
              updateWorkerStatus('profileAuthChange', {
                lastRunAt: new Date().toISOString(),
                lastBatchCount: rows.length,
                lastError: undefined,
              });
            } finally {
              farmClient.release();
            }
          } catch (err) {
            logger.error('ProfileAuthChangeWorker: failed to process row', {
              id: row.id,
              profile_name: row.profile_name,
              error: err instanceof Error ? err.message : err,
            });
          }
        }
      } finally {
        mainClient.release();
      }
    } catch (err) {
      const isConnectionRefused =
        err instanceof Error &&
        (err.message.includes('ECONNREFUSED') ||
          (err as NodeJS.ErrnoException).code === 'ECONNREFUSED' ||
          (err as Error & { cause?: Error }).cause?.message?.includes('ECONNREFUSED'));
      if (isConnectionRefused) {
        const now = Date.now();
        if (now - lastConnectionWarnAt >= CONNECTION_WARN_THROTTLE_MS) {
          lastConnectionWarnAt = now;
          logger.warn(
            'ProfileAuthChangeWorker: Farm DB unreachable (ECONNREFUSED). Check FARM_DB_* and that PostgreSQL is running. Will retry.',
          );
        }
        updateWorkerStatus('profileAuthChange', {
          lastRunAt: new Date().toISOString(),
          lastError: 'Farm DB ECONNREFUSED',
        });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      logger.error('ProfileAuthChangeWorker run error', {
        error: msg || '(no message)',
        stack,
        raw: String(err),
      });
      updateWorkerStatus('profileAuthChange', {
        lastRunAt: new Date().toISOString(),
        lastError: msg || '(no message)',
      });
    }
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      await run();
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  };

  void loop();

  return {
    async stop() {
      stopped = true;
    },
  };
}
