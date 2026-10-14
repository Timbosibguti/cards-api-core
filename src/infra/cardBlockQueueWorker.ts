import { randomUUID } from 'node:crypto';
import { getConfig } from '../config/index.js';
import { createCorrelationId } from './correlation/index.js';
import { enqueueOutgoingNotification, getDatabaseService } from './index.js';
import { logger } from './logger.js';
import { blockCardByCardNumberWithRetries } from '../modules/cardBlock/index.js';
import {
  buildAlreadyBlockedHubQueueMessage,
  isBankCardAlreadyBlockedByHub,
} from '../modules/cardBlock/lookupCard.js';

const INTERVAL_MS = 60_000;
/** Максимум карт за один тик (всего). */
const MAX_PER_TICK = 100;
/** Не больше 25 карт одного банка за один тик. */
const MAX_PER_BANK_PER_TICK = 25;
/** Сколько строк очереди за раз подгружаем для поиска следующей подходящей карты. */
const BATCH_SCAN = 150;
/**
 * После COMMIT первой транзакции воркер вызывает ПС с паузами 30s/60s/180s и возможными долгими HTTP.
 * Пока lease в будущем, другие инстансы не берут строку (FOR UPDATE … AND lease истёк или NULL).
 */
const PROCESSING_LEASE_MS = 20 * 60 * 1000;

type WorkerHandle = { stop: () => Promise<void> };

type QueueRowWithBank = { id: number; card_number: string; bank: string | null; email: string | null; profile_name: string | null; };

async function enqueueBankCardBlockedAudit(
  db: ReturnType<typeof getDatabaseService>,
  params: {
    queueId: number;
    cardNumber: string;
    bank: string;
    userEmail: string | null;
    profileName: string | null;
    buyer: string | null;
  },
): Promise<void> {
  const now = new Date();
  const correlationId = createCorrelationId();
  const userEmail = params.userEmail?.trim() ? params.userEmail.trim() : 'system@groscloud.com';
  const dedupKey = `audit:bank_card_blocked:queue:${params.queueId}`;
  const payload = {
    id: randomUUID(),
    timestamp: now.toISOString(),
    division: 'finance' as const,
    user_email: userEmail,
    log_type: 'info' as const,
    severity: 1,
    event_type: 'bank_card_blocked',
    event_attributes: {
      source: 'card_block_queue_worker',
      card_number: params.cardNumber,
      bank: params.bank,
      profile_name: params.profileName ?? null,
      buyer: params.buyer ?? null,
      queue_id: params.queueId,
      correlation_id: correlationId,
      timestamp: now.toISOString(),
      result: 'blocked',
    },
    correlation_id: correlationId,
  };

  await db.withTransaction('main', async (client) => {
    await enqueueOutgoingNotification(client, {
      channel: 'mqtt:sequoia/audit',
      payload,
      dedupKey,
      correlationId,
    });
  });
}

async function enqueueBankCardBlockedSlackNotifications(
  db: ReturnType<typeof getDatabaseService>,
  params: {
    queueId: number;
    cardNumber: string;
    profileName: string | null;
    buyer: string | null;
  },
): Promise<void> {
  const correlationId = createCorrelationId();
  const prof = params.profileName?.trim() ? params.profileName.trim() : 'не указан';
  const message = `На профиле ${prof} заблокирована карта ${params.cardNumber}`;
  await db.withTransaction('main', async (client) => {
    await enqueueOutgoingNotification(client, {
      channel: 'slack:#farm-otp',
      payload: { message },
      dedupKey: `slack:bank_card_blocked_user_notify:farm_otp:${params.queueId}`,
      correlationId,
    });
    const buyer = params.buyer?.trim();
    if (buyer) {
      await enqueueOutgoingNotification(client, {
        channel: 'slack:dm',
        payload: { message, email: buyer },
        dedupKey: `slack:bank_card_blocked_user_notify:dm:${params.queueId}`,
        correlationId,
        recipient: buyer,
      });
    }
  });
}

function truncateErr(msg: string, max = 4000): string {
  return msg.length <= max ? msg : `${msg.slice(0, max)}…`;
}

function bankKey(bank: string | null): string {
  const t = (bank ?? '_unknown').trim().toLowerCase();
  return t || '_unknown';
}

async function fetchQueueBatch(
  db: ReturnType<typeof getDatabaseService>,
  offset: number,
): Promise<QueueRowWithBank[]> {
  return db.withTransaction('main', async (client) => {
    const res = await client.query<QueueRowWithBank>(
      `SELECT q.id,
              q.card_number::text AS card_number,
              q.email::text AS email,
              q.profile_name::text AS profile_name,
              bc.bank::text AS bank
       FROM public.card_block_queue q
       LEFT JOIN public.bank_cards bc ON bc.card_number = q.card_number::bigint
       WHERE q.blocked_at IS NULL AND q.error IS NULL
         AND (q.processing_lease_until IS NULL OR q.processing_lease_until < NOW())
       ORDER BY q.id ASC
       OFFSET $1
       LIMIT $2`,
      [offset, BATCH_SCAN],
    );
    return res.rows;
  });
}

async function processLockedRow(
  db: ReturnType<typeof getDatabaseService>,
  row: QueueRowWithBank,
): Promise<boolean> {
  const client = await db.getClient('main');
  let cardRow: { id: number; card_number: string; email: string | null; profile_name: string | null };

  try {
    await client.query('BEGIN');
    const locked = await client.query<{ id: number; card_number: string; email: string | null; profile_name: string | null; }>(
      `SELECT id, card_number::text AS card_number, email::text AS email, profile_name::text AS profile_name
       FROM public.card_block_queue
       WHERE id = $1 AND blocked_at IS NULL AND error IS NULL
         AND (processing_lease_until IS NULL OR processing_lease_until < NOW())
       FOR UPDATE SKIP LOCKED`,
      [row.id],
    );
    if (locked.rows.length === 0) {
      await client.query('COMMIT');
      return false;
    }

    cardRow = locked.rows[0];

    const flagsRes = await client.query<{ is_bad: boolean; acc_no: string | null }>(
      `SELECT COALESCE(bc.is_bad, false) AS is_bad, bc.acc_no
       FROM public.bank_cards bc
       WHERE bc.card_number = $1::bigint
       LIMIT 1`,
      [cardRow.card_number],
    );
    const flags = flagsRes.rows[0];
    if (flags && isBankCardAlreadyBlockedByHub(flags)) {
      const msg = truncateErr(buildAlreadyBlockedHubQueueMessage(flags));
      await client.query(`UPDATE public.card_block_queue SET error = $1 WHERE id = $2`, [msg, cardRow.id]);
      await client.query('COMMIT');
      logger.info('cardBlockQueueWorker: skip PSP, card already blocked in hub', {
        id: cardRow.id,
        card_number: cardRow.card_number,
      });
      return true;
    }

    await client.query(
      `UPDATE public.card_block_queue
       SET processing_lease_until = NOW() + ($1::bigint * INTERVAL '1 millisecond')
       WHERE id = $2`,
      [PROCESSING_LEASE_MS, cardRow.id],
    );

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* empty */
    }
    throw err;
  } finally {
    client.release();
  }

  const result = await blockCardByCardNumberWithRetries(cardRow.card_number);

  const client2 = await db.getClient('main');
  try {
    await client2.query('BEGIN');
    const rowStill = await client2.query<{ blocked_at: Date | string | null; error: string | null }>(
      `SELECT blocked_at, error FROM public.card_block_queue WHERE id = $1 FOR UPDATE`,
      [cardRow.id],
    );
    if (rowStill.rows.length === 0) {
      await client2.query('ROLLBACK');
      return true;
    }
    const st = rowStill.rows[0];
    if (st.blocked_at != null || st.error != null) {
      await client2.query('ROLLBACK');
      logger.info('cardBlockQueueWorker: queue row finalized while PSP retries ran, skipping update', {
        id: cardRow.id,
        our_ok: result.ok,
      });
      return true;
    }

    if (result.ok) {
      await client2.query(
        `UPDATE public.card_block_queue
         SET blocked_at = NOW(), error = NULL, processing_lease_until = NULL
         WHERE id = $1`,
        [cardRow.id],
      );
      logger.info('cardBlockQueueWorker: card blocked', {
        id: cardRow.id,
        card_number: cardRow.card_number,
        bank: result.bank,
      });
    } else {
      await client2.query(
        `UPDATE public.card_block_queue
         SET error = $1, processing_lease_until = NULL
         WHERE id = $2`,
        [truncateErr(result.message), cardRow.id],
      );
      logger.warn('cardBlockQueueWorker: block failed', {
        id: cardRow.id,
        card_number: cardRow.card_number,
        error: result.error,
        message: result.message,
      });
    }

    await client2.query('COMMIT');
  } catch (err) {
    try {
      await client2.query('ROLLBACK');
    } catch {
      /* empty */
    }
    throw err;
  } finally {
    client2.release();
  }

  if (result.ok) {
    try {
      await enqueueBankCardBlockedAudit(db, {
        queueId: cardRow.id,
        cardNumber: cardRow.card_number,
        bank: result.bank,
        userEmail: cardRow.email,
        profileName: cardRow.profile_name ?? result.profile_name ?? null,
        buyer: result.buyer ?? null,
      });
    } catch (auditErr) {
      logger.error('cardBlockQueueWorker: audit outbox enqueue failed', {
        queue_id: cardRow.id,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }
    try {
      await enqueueBankCardBlockedSlackNotifications(db, {
        queueId: cardRow.id,
        cardNumber: cardRow.card_number,
        profileName: cardRow.profile_name ?? result.profile_name,
        buyer: result.buyer,
      });
    } catch (slackErr) {
      logger.error('cardBlockQueueWorker: slack notify enqueue failed', {
        queue_id: cardRow.id,
        error: slackErr instanceof Error ? slackErr.message : String(slackErr),
      });
    }
  }

  return true;
}

export function startCardBlockQueueWorker(): WorkerHandle {
  const config = getConfig();
  const db = getDatabaseService(config);

  let stopped = false;

  const tick = async (): Promise<void> => {
    const bankCounts = new Map<string, number>();
    let processed = 0;
    let scanOffset = 0;

    while (!stopped && processed < MAX_PER_TICK) {
      const batch = await fetchQueueBatch(db, scanOffset);
      if (batch.length === 0) {
        break;
      }

      let foundInBatch = false;
      for (const candidate of batch) {
        if (stopped) break;
        const key = bankKey(candidate.bank);
        if ((bankCounts.get(key) ?? 0) >= MAX_PER_BANK_PER_TICK) {
          continue;
        }

        const ok = await processLockedRow(db, candidate);
        if (ok) {
          bankCounts.set(key, (bankCounts.get(key) ?? 0) + 1);
          processed += 1;
          foundInBatch = true;
          scanOffset = 0;
          break;
        }
      }

      if (!foundInBatch) {
        if (batch.length < BATCH_SCAN) {
          break;
        }
        scanOffset += batch.length;
      }
    }
  };

  const loop = async () => {
    while (!stopped) {
      try {
        await tick();
      } catch (err) {
        logger.error('cardBlockQueueWorker tick error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (stopped) break;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, INTERVAL_MS);
      });
    }
  };

  void loop();

  return {
    async stop() {
      stopped = true;
    },
  };
}
