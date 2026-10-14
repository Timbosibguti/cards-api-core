/**
 * Модуль drafts: создание pre‑transactions из расширения Taurus (/draft).
 * Реализует только тип A (bank_pre), тип B (card_pre/card_otp) будет добавлен позже.
 */

import { createHash, randomUUID } from 'node:crypto';
import { getConfig } from '../../config/index.js';
import { getDatabaseService, enqueueOutgoingNotification } from '../../infra/index.js';
import * as farmDb from '../../infra/farmDb.js';
import { createCorrelationId } from '../../infra/correlation/index.js';
import { logger } from '../../infra/logger.js';

export interface TaurusDraftRequest {
  profileId: string;
  profileName: string;
  transactionId?: string;
  bank?: string;
  otp?: string;
  [key: string]: unknown;
}

function computePayloadHash(body: unknown): string {
  const json = JSON.stringify(body ?? {});
  return createHash('sha256').update(json).digest('hex');
}

export async function createBankPreDraftFromTaurus(body: TaurusDraftRequest, version: string | null): Promise<void> {
  const config = getConfig();
  const db = getDatabaseService(config);

  const profileName = body.profileName;
  const bank = body.bank ?? 'card_operation';
  const transactionId =
    body.transactionId ?? `${body.profileId}-${body.profileName}-${Date.now().toString(10)}`;

  // Текущий пользователь профиля — только из Farm DB (JWT не содержит email). См. architecture/profile_current_user.md.
  let buyerEmail: string | null = null;
  const farmClient = await db.getClient('farm');
  try {
    const currentUser = await farmDb.getCurrentUserByProfileName(farmClient, profileName);
    buyerEmail = currentUser?.email ?? null;
  } finally {
    farmClient.release();
  }

  const raw = {
    ...body,
    transactionId,
    bank,
    version,
  };
  const rawJson = JSON.stringify(raw);
  const payloadHash = computePayloadHash(raw);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days TTL
  const timeBucket = new Date(now);
  timeBucket.setSeconds(0, 0);

  const correlationId = createCorrelationId();

  await db.withTransaction('main', async (client) => {
    // Сначала пробуем обновить существующий draft для (bank, transaction_id, kind=bank_pre, status=pending).
    logger.info('[TAURUS] Trying to update existing draft', { bank, transactionId, profileName, buyerEmail, otp: body.otp });
    const updateRes = await client.query(
      `UPDATE public.drafts
       SET
         profile_name = COALESCE($3, drafts.profile_name),
         buyer_email  = COALESCE($4, drafts.buyer_email),
         otp          = COALESCE($5, drafts.otp),
         raw          = $7::jsonb,
         payload_hash = $8,
         expires_at   = $9,
         time_bucket  = $6
       WHERE kind = 'bank_pre'
         AND status = 'pending'
         AND bank = $1
         AND transaction_id = $2`,
      [
        bank,
        transactionId,
        profileName,
        buyerEmail,
        body.otp ?? null,
        timeBucket.toISOString(),
        rawJson,
        payloadHash,
        expiresAt.toISOString(),
      ],
    );

    // Если обновлять нечего — вставляем новый draft.
    if (updateRes.rowCount === 0) {
      logger.info('[TAURUS] No existing draft found, inserting new one', { bank, transactionId, profileName, buyerEmail, otp: body.otp });
      await client.query(
        `INSERT INTO public.drafts (
           kind, status,
           bank, transaction_id, profile_name, buyer_email,
           otp, amount, currency,
           time_bucket, raw, payload_hash,
           expires_at, created_at
         ) VALUES (
           'bank_pre', 'pending',
           $1, $2, $3, $4,
           $5, NULL, NULL,
           $6, $7::jsonb, $8,
           $9, NOW()
         )`,
        [
          bank,
          transactionId,
          profileName,
          buyerEmail,
          body.otp ?? null,
          timeBucket.toISOString(),
          rawJson,
          payloadHash,
          expiresAt.toISOString(),
        ],
      );
    }

    // Аудит pre_transaction_created/pre_transaction_upserted через outgoing_notifications.
    const auditEventType = 'pre_transaction_created';
    const auditPayload = {
      id: randomUUID(),
      timestamp: now.toISOString(),
      division: 'finance' as const,
      user_email: buyerEmail ?? 'system@groscloud.com',
      log_type: 'info' as const,
      severity: 2,
      event_type: auditEventType,
      event_attributes: {
        bank,
        transaction_id: transactionId,
        profile_name: profileName,
        otp_present: Boolean(body.otp),
        version,
      },
      correlation_id: correlationId,
    };

    const dedupKey = `audit:pre_tx:bank_pre:${bank}:${transactionId}`;
    await enqueueOutgoingNotification(client, {
      channel: 'mqtt:sequoia/audit',
      payload: auditPayload,
      dedupKey,
      correlationId,
    });
  });

  logger.info('Bank pre-transaction draft created/updated', {
    bank,
    transactionId,
    profileName,
  });
}

/**
 * Модуль drafts: pre-transaction / OTP-draft (bank_pre, card_pre, card_otp), TTL, state machine.
 * Реализация — EP5.2.
 */

export const draftsModule = {
  name: 'drafts',
} as const;
