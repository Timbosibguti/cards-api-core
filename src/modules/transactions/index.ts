/**
 * Модуль transactions: ingest транзакций (incoming_transactions → bank_transactions), нормализация.
 * Реализация — EP5.1, воркер T1.4, processes.md 2.6.
 */

import { createHash, randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { getConfig } from '../../config/index.js';
import {
  getDatabaseService,
  createCorrelationId,
  createMqttTxDedupKey,
  enqueueOutgoingNotification,
  type TransactionEventPayload,
} from '../../infra/index.js';
import { setIncomingStatusToProcessed, setIncomingStatusToFailed } from '../../infra/stateTransitions.js';
import { logger } from '../../infra/logger.js';
import { getCurrentUserByProfileName } from '../../infra/farmDb.js';
import { normalizeRawPayload, type NormalizedTransaction } from './normalize.js';
import type { BankId } from './types.js';
import { getTransactionsAdapter } from './adapters/index.js';

export type { NormalizedTransaction } from './normalize.js';
export { normalizeRawPayload } from './normalize.js';
export type { BankId };

export interface RawTransactionEnvelope {
  bank: BankId;
  payload: unknown;
  correlationId?: string;
}

function computeIdempotencyKey(bank: BankId, payload: unknown): string {

  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;

    if (bank === 'ecards') {
      const rawId = obj.id;
      const extId =
        rawId === null || rawId === undefined ? '' : String(rawId).trim();

      if (extId.length > 0) {
        return `tx:${bank}:${extId}`;
      }
    }
  }

  const json = JSON.stringify(payload ?? {});
  const hash = createHash('sha256').update(json).digest('hex');
  return `tx:${bank}:${hash}`;

  /*
  // Временная реализация: хеш всего payload.
  // Позже будет заменено на tx:<bank>:<acc_no>:<ext_id> по архитектуре.
  const json = JSON.stringify(payload ?? {});
  const hash = createHash('sha256').update(json).digest('hex');
  return `tx:${bank}:${hash}`;*/
}

function extractGoogleCode(text: string | null): string | null {
  if (!text) return null;
  const upper = text.toUpperCase();
  if (!upper.includes('GOOGLE')) return null;
  // Берём только изолированный 6-значный код (не часть более длинного числа).
  // Пример "ADS2630053219" больше НЕ матчит.
  const match = text.match(/(?<!\d)(\d{6})(?!\d)/);
  return match ? match[1] : null;
}

function extractGoogleAdsAccountId(text: string | null): string | null {
  if (!text) return null;
  const upper = text.toUpperCase();
  if (!upper.includes('GOOGLE') || !upper.includes('ADS')) return null;
  // Ищем 10 подряд идущих цифр (пример: GOOGLE*ADS0123456789).
  const match = upper.match(/(?<!\d)(\d{10})(?!\d)/);
  return match ? match[1] : null;
}

async function resolveOwnerViaGoogleAdsId(
  client: PoolClient,
  normalized: NormalizedTransaction,
): Promise<{ buyer: string | null; profileName: string | null }> {
  const googleAdsDigits = extractGoogleAdsAccountId(normalized.merchant_description ?? null);
  if (!googleAdsDigits) {
    return { buyer: null, profileName: null };
  }

  const profileFromGoogleLogsRes = await client.query<{ profile_name: string | null }>(
    `SELECT profile_name
     FROM public.google_account_logs
     WHERE profile_name IS NOT NULL
       AND regexp_replace(COALESCE(account_id, ''), '[^0-9]', '', 'g') = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [googleAdsDigits],
  );

  let profileName = profileFromGoogleLogsRes.rows[0]?.profile_name?.trim() || null;
  if (!profileName) {
    const profileFromRefundsRes = await client.query<{ profile_name: string | null }>(
      `SELECT profile_name
       FROM finance0_ext.funds_from_account
       WHERE profile_name IS NOT NULL
         AND regexp_replace(COALESCE(account_id, ''), '[^0-9]', '', 'g') = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [googleAdsDigits],
    );
    profileName = profileFromRefundsRes.rows[0]?.profile_name?.trim() || null;
    if (!profileName) {
      return { buyer: null, profileName: null };
    }
  }

  const config = getConfig();
  const db = getDatabaseService(config);
  const owner = await db.withTransaction('farm', async (farmClient) =>
    getCurrentUserByProfileName(farmClient, profileName),
  );

  logger.warn('[GOOGLE_ACCOUNT] [PAYMENT] resolveOwnerViaGoogleAdsId { profileName, owner, transaction }: ' + JSON.stringify({ profileName, owner, transaction: normalized }));

  return {
    buyer: owner?.email ?? null,
    profileName,
  };
}

export async function ingestRawTransaction(envelope: RawTransactionEnvelope): Promise<void> {
  const config = getConfig();
  const db = getDatabaseService(config);

  const correlationId = envelope.correlationId ?? createCorrelationId();
  const idempotencyKey = computeIdempotencyKey(envelope.bank, envelope.payload);
  const rawJson = JSON.stringify(envelope.payload ?? {});

  await db.withTransaction('main', async (client) => {
    await client.query(
      `INSERT INTO public.incoming_transactions (bank, raw_payload, status, idempotency_key, correlation_id, created_at)
       VALUES ($1, $2::jsonb, 'pending', $3, $4, NOW())
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [envelope.bank, rawJson, idempotencyKey, correlationId],
    );
  });

  logger.info('Incoming transaction ingested', {
    bank: envelope.bank,
    correlationId,
  });
}

/** Строка incoming_transactions после захвата воркером (status = processing). */
export interface IncomingRow {
  id: number;
  bank: string;
  raw_payload: unknown;
  idempotency_key: string;
  correlation_id: string | null;
}

async function resolveOwnerViaBankCards(
  client: PoolClient,
  normalized: NormalizedTransaction,
): Promise<{ buyer: string | null; profileName: string | null }> {
  const bank = normalized.bank;
  const cardNumber = normalized.card_number ?? null;
  const accNo = normalized.acc_no ?? null;

  if (!cardNumber && !accNo) {
    return { buyer: null, profileName: null };
  }

  const digits = cardNumber ? String(cardNumber).replace(/\D/g, '') : null;

  const res = await client.query<{ buyer: string | null; profile_name: string | null }>(
    `SELECT buyer, profile_name
     FROM public.bank_cards
     WHERE bank = $1
       AND (
         ($2::bigint IS NOT NULL AND card_number = $2::bigint)
         OR ($3::text IS NOT NULL AND acc_no = $3::text)
       )
     ORDER BY created_at DESC NULLS LAST
     LIMIT 1`,
    [bank, digits, accNo],
  );

  if (!res.rows[0]) {
    return { buyer: null, profileName: null };
  }

  return {
    buyer: res.rows[0].buyer,
    profileName: res.rows[0].profile_name,
  };
}

async function resolveIsPostpayViaBankCards(
  client: PoolClient,
  normalized: NormalizedTransaction,
): Promise<boolean> {
  const cardNumber = normalized.card_number ?? null;
  if (!cardNumber) {
    return false;
  }

  const digits = String(cardNumber).replace(/\D/g, '');
  if (!digits) {
    return false;
  }

  const res = await client.query<{ is_postpay: boolean }>(
    `SELECT (profile_name IS NOT NULL) AS is_postpay
     FROM public.bank_cards
     WHERE bank = $1
       AND card_number = $2::bigint
     ORDER BY created_at DESC NULLS LAST
     LIMIT 1`,
    [normalized.bank, digits],
  );

  return Boolean(res.rows[0]?.is_postpay);
}

async function resolveOwnerViaDraftsCardOtp(
  client: PoolClient,
  normalized: NormalizedTransaction,
): Promise<{ buyer: string | null; profileName: string | null }> {
  const bank = normalized.bank;
  const cardNumber = normalized.card_number ?? null;

  if (!cardNumber) {
    return { buyer: null, profileName: null };
  }

  const digits = String(cardNumber).replace(/\D/g, '');
  if (!digits) {
    return { buyer: null, profileName: null };
  }

  const res = await client.query<{ buyer_email: string | null; profile_name: string | null }>(
    `SELECT buyer_email, profile_name
     FROM public.drafts
     WHERE kind = 'card_otp'
       AND status = 'pending'
       AND bank = $1
       AND card_number = $2::bigint
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [bank, digits],
  );

  if (!res.rows[0]) {
    return { buyer: null, profileName: null };
  }

  return {
    buyer: res.rows[0].buyer_email,
    profileName: res.rows[0].profile_name,
  };
}

/**
 * Обрабатывает батч записей incoming_transactions: нормализация, upsert в bank_transactions,
 * постановка в outgoing_notifications для mqtt:sequoia/transaction. Вызывается из воркера в той же транзакции.
 * processes.md 2.6.
 */
export async function processIncomingBatch(client: PoolClient, rows: IncomingRow[]): Promise<void> {
  const successIds: number[] = [];
  const failIds: number[] = [];

  for (const row of rows) {
    const bank = row.bank as BankId;
    const normalized = await normalizeRawPayload(client, bank, row.raw_payload);
    if (!normalized) {
      logger.warn('Normalization failed, marking incoming as failed', { id: row.id, bank: row.bank });
      failIds.push(row.id);
      continue;
    }

    const occurredAt = normalized.occurred_at ? new Date(normalized.occurred_at) : new Date();
    const rawJson = JSON.stringify(normalized.raw);

    try {
      // Определение buyer/profile_name:
      // 1) приоритетно по GOOGLE*ADS########## -> google_account_logs -> Farm DB
      // 2) затем адаптер и существующие fallback.
      let buyer: string | null = null;
      let profileName: string | null = null;
      const viaGoogleAds = await resolveOwnerViaGoogleAdsId(client, normalized);
      if (!buyer) buyer = viaGoogleAds.buyer;
      if (!profileName) profileName = viaGoogleAds.profileName;
      const adapter = getTransactionsAdapter(bank);
      if ((!buyer || !profileName) && adapter && adapter.resolveOwner) {
        const owner = await adapter.resolveOwner(client, normalized);
        if (!buyer) buyer = owner.buyer;
        if (!profileName) profileName = owner.profileName;
      }
      if (!buyer || !profileName) {
        const viaCards = await resolveOwnerViaBankCards(client, normalized);
        if (!buyer) buyer = viaCards.buyer;
        if (!profileName) profileName = viaCards.profileName;
      }
      if ((!buyer || !profileName) && normalized.card_number) {
        const viaDrafts = await resolveOwnerViaDraftsCardOtp(client, normalized);
        if (!buyer) buyer = viaDrafts.buyer;
        if (!profileName) profileName = viaDrafts.profileName;
      }
      const isPostpay = await resolveIsPostpayViaBankCards(client, normalized);

      // Upsert bank_transactions. Существующая схема: (bank, ext_id) PK; поля raw, idempotency_key, correlation_id добавлены миграцией.
      await client.query(
        `INSERT INTO public.bank_transactions (
           ext_id, created_at, bank, amount, currency, acc_no, raw,
           buyer, profile_name, idempotency_key, correlation_id, is_postpay
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
         ON CONFLICT (bank, ext_id) DO UPDATE SET
           amount = EXCLUDED.amount,
           currency = EXCLUDED.currency,
           acc_no = COALESCE(EXCLUDED.acc_no, bank_transactions.acc_no),
           raw = EXCLUDED.raw,
           buyer = COALESCE(EXCLUDED.buyer, bank_transactions.buyer),
           profile_name = COALESCE(EXCLUDED.profile_name, bank_transactions.profile_name),
           idempotency_key = EXCLUDED.idempotency_key,
           correlation_id = EXCLUDED.correlation_id,
           is_postpay = EXCLUDED.is_postpay`,
        [
          normalized.ext_id,
          occurredAt,
          normalized.bank,
          normalized.amount,
          normalized.currency,
          normalized.acc_no,
          rawJson,
          buyer,
          profileName,
          row.idempotency_key,
          row.correlation_id,
          isPostpay,
        ],
      );

      // Постановка в очередь публикации в MQTT (processes 2.6 п.7)
      const dedupKey = createMqttTxDedupKey(
        normalized.bank,
        normalized.acc_no ?? '',
        normalized.ext_id,
      );
      const payload: TransactionEventPayload = {
        bank: normalized.bank,
        ext_id: normalized.ext_id,
        acc_no: normalized.acc_no,
        card_number: normalized.card_number ?? undefined,
        amount: normalized.amount,
        currency: normalized.currency,
        status: normalized.status,
        occurred_at: normalized.occurred_at ?? undefined,
        merchant_description: normalized.merchant_description ?? undefined,
        correlation_id: row.correlation_id ?? undefined,
        buyer: buyer ?? undefined,
        profile_name: profileName ?? undefined,
      };
      await enqueueOutgoingNotification(client, {
        channel: 'mqtt:sequoia/transaction',
        payload,
        dedupKey,
        correlationId: row.correlation_id,
      });

      // Аудит: постановка в очередь для mqtt:sequoia/audit (processes 2.6 п.6).
      // Если не удалось определить ни buyer, ни profile_name — аудит по этой транзакции не пишем.
      if (buyer || profileName) {
        /*const userEmail = buyer ?? 'system@groscloud.com';
        const auditDedupKey = `audit:tx:${row.idempotency_key}`;
        const auditPayload = {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          division: 'finance',
          user_email: userEmail,
          log_type: 'info' as const,
          severity: 3,
          event_type: 'bank_transaction_upserted',
          event_attributes: {
            bank: normalized.bank,
            ext_id: normalized.ext_id,
            acc_no: normalized.acc_no,
            amount: normalized.amount,
            correlation_id: row.correlation_id,
          },
          correlation_id: row.correlation_id,
        };
        await enqueueOutgoingNotification(client, {
          channel: 'mqtt:sequoia/audit',
          payload: auditPayload,
          dedupKey: auditDedupKey,
          correlationId: row.correlation_id,
        });*/
      }

      // Google-коды из описания транзакции (processes.md 2.3)
      const googleCode = extractGoogleCode(normalized.merchant_description ?? null);
      if (googleCode) {
        const bucket = new Date(occurredAt);
        bucket.setSeconds(0, 0);
        const bucketIso = bucket.toISOString();
        const digits = normalized.card_number ? String(normalized.card_number).replace(/\D/g, '') : '';
        const raw = (normalized.raw ?? {}) as Record<string, unknown>;
        const cardGuid = raw.card_guid != null ? String(raw.card_guid) : '';
        const cardKey = digits || cardGuid || normalized.ext_id;
        const otpBaseKey = `otp:card:${normalized.bank}:${normalized.acc_no ?? ''}:${cardKey}:${googleCode}:${bucketIso}`;
        const dmDedupKey = `${otpBaseKey}:dm`;
        const chanDedupKey = `${otpBaseKey}:channel`;

        const otpPayloadBase = {
          kind: 'google_code' as const,
          message: `Google-код: ${googleCode}\nБанк: ${normalized.bank}\nСчёт: ${normalized.acc_no ?? '—'}\nКарта: ${digits || '—'}\nПрофиль: ${profileName ?? '—'}`,
          bank: normalized.bank,
          acc_no: normalized.acc_no,
          card_number: digits || null,
          otp: googleCode,
          buyer,
          profile_name: profileName,
          correlation_id: row.correlation_id,
        };

        // DM владельцу
        if (buyer) {
          await enqueueOutgoingNotification(client, {
            channel: 'slack:dm',
            payload: otpPayloadBase,
            dedupKey: dmDedupKey,
            correlationId: row.correlation_id,
            recipient: buyer,
          });
        }

        // Сообщение в канал farm-otp
        await enqueueOutgoingNotification(client, {
          channel: 'slack:#farm-otp',
          payload: otpPayloadBase,
          dedupKey: chanDedupKey,
          correlationId: row.correlation_id,
        });

        // Аудит google_code_received
        const auditGoogleDedupKey = `audit:google_code:${row.idempotency_key}:${googleCode}`;
        const auditGooglePayload = {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          division: 'finance',
          user_email: buyer,
          log_type: 'info' as const,
          severity: 3,
          event_type: 'google_code_received',
          event_attributes: {
            bank: normalized.bank,
            acc_no: normalized.acc_no,
            card_number: digits || null,
            card_guid: cardGuid || null,
            otp: googleCode,
            correlation_id: row.correlation_id,
          },
          correlation_id: row.correlation_id,
        };
        await enqueueOutgoingNotification(client, {
          channel: 'mqtt:sequoia/audit',
          payload: auditGooglePayload,
          dedupKey: auditGoogleDedupKey,
          correlationId: row.correlation_id,
        });
      }

      successIds.push(row.id);
    } catch (err) {
      logger.error('processIncomingBatch row error', {
        error: err instanceof Error ? err.message : String(err),
        id: row.id,
        bank: row.bank,
      });
      failIds.push(row.id);
    }
  }

  if (successIds.length > 0) {
    await setIncomingStatusToProcessed(client, successIds);
  }
  if (failIds.length > 0) {
    await setIncomingStatusToFailed(client, failIds);
  }
}

export const transactionsModule = {
  name: 'transactions',
} as const;
