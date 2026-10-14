import type { BankId } from '../../types.js';
import { getConfig } from '../../../../config/index.js';
import { getDatabaseService, enqueueOutgoingNotification, createCorrelationId } from '../../../../infra/index.js';
import { logger } from '../../../../infra/logger.js';

export async function handleAdscardsWebhook(kind: string, body: unknown, correlationId?: string): Promise<void> {
  logger.warn(`[ADSCARDS_HUB] kind=${kind}`, { body });

  // Для совместимости: если пришёл webhook от внешнего сервиса, сам решаем,
  // это OTP или транзакция, по полю webhook_event. Путь (/transaction или /otp)
  // и переданный kind используются только как подсказка.
  const event =
    body && typeof body === 'object' && 'webhook_event' in body
      ? String((body as any).webhook_event ?? '')
      : '';

  if (event === 'card_sms_code' || event === 'card_sms_codeV2' || kind === 'otp') {
    const raw = body as {
      webhook_event?: string;
      data?: { card_number?: string; code?: string; card_id?: number; card_group?: string };
    };
    const data = raw?.data;
    if (!data?.card_number || !data?.code) {
      logger.warn('Adscards OTP webhook: missing card_number or code', { hasData: !!data });
      return;
    }

    const config = getConfig();
    const db = getDatabaseService(config);
    const corrId = correlationId ?? createCorrelationId();

    let buyer: string | null = null;
    let profileName: string | null = null;
    let resolvedCardNumberDigits: string | null = null;
    await db.withTransaction('main', async (client) => {
      // Пытаемся сопоставить по card_id с ext_id в bank_cards и взять оттуда buyer/profile_name/полный номер карты.
      if (data.card_id != null) {
        const res = await client.query<{ card_number: string | null; buyer: string | null; profile_name: string | null }>(
          `SELECT card_number::text AS card_number, buyer, profile_name
           FROM public.bank_cards
           WHERE bank = 'adscards' AND ext_id = $1
           ORDER BY created_at DESC NULLS LAST
           LIMIT 1`,
          [String(data.card_id)],
        );
        if (res.rows[0]) {
          const row = res.rows[0];
          if (row.card_number) {
            resolvedCardNumberDigits = row.card_number.replace(/\D/g, '');
          }
          if (row.buyer) {
            buyer = row.buyer;
          }
          if (row.profile_name) {
            profileName = row.profile_name;
          }
        }
      }
    });

    const maskedDigits = String(data.card_number)
      .replace(/\D/g, '')
      .trim();
    const cardNumberForPayload =
      resolvedCardNumberDigits ??
      (maskedDigits || data.card_number);

    const payload = {
      source: 'adscards' as const,
      bank: 'adscards',
      card_number: cardNumberForPayload,
      code: data.code,
      card_id: data.card_id ?? null,
      card_group: data.card_group ?? null,
      raw: JSON.stringify({ webhook_event: raw.webhook_event ?? 'card_sms_codeV2', data }),
      buyer: buyer ?? null,
      profile_name: profileName ?? null,
    };
    const dedupKey = `otp:adscards:${String(cardNumberForPayload).replace(/\D/g, '')}:${data.code}:${Date.now().toString(36)}`;
    await db.withTransaction('main', async (client) => {
      await enqueueOutgoingNotification(client, {
        channel: 'mqtt:sequoia/otp',
        payload,
        dedupKey,
        correlationId: corrId,
      });
    });
    return;
  }

  if (
    event === 'transaction_add' ||
    event === 'transaction_change' ||
    event === 'balance_change' ||
    event === 'cardlimit_change' ||
    kind === 'transaction'
  ) {
    await import('../../index.js').then(({ ingestRawTransaction }) =>
      ingestRawTransaction({
        bank: 'adscards' as BankId,
        payload: body,
        correlationId,
      }),
    );
    return;
  }
}

