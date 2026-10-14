import type { BankId } from '../../types.js';
import { getConfig } from '../../../../config/index.js';
import { getDatabaseService, enqueueOutgoingNotification, createCorrelationId } from '../../../../infra/index.js';
import { logger } from '../../../../infra/logger.js';

interface MulticardsWebhookBody {
  event?: string;
  type?: 'transaction' | 'card3ds';
  transaction?: Record<string, unknown>;
  card3ds?: { userId?: number; cardId?: number; cardMask?: string; code?: string; password?: string };
}

export async function handleMulticardsWebhook(_kind: string, body: unknown, correlationId?: string): Promise<void> {
  logger.warn(`[MULTICARDS_HUB] kind=${_kind}`, { body });
  const raw = body as MulticardsWebhookBody;

  if (raw?.type === 'card3ds' && raw.card3ds?.code) {
    const card3ds = raw.card3ds;
    const config = getConfig();
    const db = getDatabaseService(config);
    const corrId = correlationId ?? createCorrelationId();
    await db.withTransaction('main', async (client) => {
      let fullCardNumber: string | null = null;

      if (card3ds.cardId != null) {
        const res = await client.query<{ card_number: string | null }>(
          `SELECT card_number::text AS card_number
           FROM public.bank_cards
           WHERE bank = 'multicards' AND ext_id = $1
           ORDER BY created_at DESC NULLS LAST
           LIMIT 1`,
          [String(card3ds.cardId)],
        );
        fullCardNumber = res.rows[0]?.card_number ?? null;
      }

      const payload = {
        source: 'multicards' as const,
        bank: 'multicards',
        card_id: card3ds.cardId ?? null,
        card_number: fullCardNumber ?? (card3ds.cardMask ?? ''),
        otp: card3ds.code,
        raw: JSON.stringify({ ...card3ds, type: 'card3ds' }),
      };
      const dedupKey = `otp:multicards:${card3ds.cardId ?? 'unknown'}:${card3ds.code}:${Date.now().toString(36)}`;
      await enqueueOutgoingNotification(client, {
        channel: 'mqtt:sequoia/otp',
        payload,
        dedupKey,
        correlationId: corrId,
      });
    });
    logger.info('Multicards OTP webhook enqueued', { cardId: card3ds.cardId });
    return;
  }

  const payload =
    raw?.type === 'transaction' && raw.transaction
      ? raw.transaction
      : typeof body === 'object' && body !== null && (('recieptId' in body) || ('id' in body))
        ? body
        : null;
  if (payload) {
    await import('../../index.js').then(({ ingestRawTransaction }) =>
      ingestRawTransaction({
        bank: 'multicards' as BankId,
        payload,
        correlationId,
      }),
    );
  }
}

