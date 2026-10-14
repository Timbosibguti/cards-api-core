import { type TransactionClient, enqueueOutgoingNotification } from '../../infra/index.js';

export interface ProviderCardInput {
  bank: string;
  cardNumber: number;
  accNo: string | null;
  createdAt: Date;
  note: string | null;
  creds?: string | null;
  extId?: string | null;
  /** Email владельца карты (buyer) на момент события. */
  buyer?: string | null;
  /** Источник события (ecards_polling, adscards_webhook и т.д.). */
  source: string;
}

/**
 * Единая точка upsert карты от внешнего провайдера:
 * - upsert в bank_cards;
 * - аудит card_issued при первом появлении buyer для карты.
 * Вызов всегда должен происходить внутри транзакции DatabaseService.
 */
export async function upsertProviderCard(
  client: TransactionClient,
  input: ProviderCardInput,
): Promise<void> {
  const { bank, cardNumber, accNo, createdAt, note, creds, extId, buyer, source } = input;

  let hadBuyerBefore = false;
  if (Number.isFinite(cardNumber)) {
    const existing = await client.query<{ buyer: string | null }>(
      'SELECT buyer FROM public.bank_cards WHERE card_number = $1 LIMIT 1',
      [cardNumber],
    );
    hadBuyerBefore = !!(existing.rows[0]?.buyer);
  }

  await client.query(
    `INSERT INTO public.bank_cards (buyer, card_number, bank, acc_no, created_at, note, creds, ext_id, is_buying)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (card_number) DO UPDATE SET
       buyer = CASE
         WHEN bank_cards.buyer IS NULL AND bank_cards.profile_name IS NULL
           THEN COALESCE(EXCLUDED.buyer, bank_cards.buyer)
         ELSE bank_cards.buyer
       END,
       is_buying = CASE
         WHEN COALESCE(EXCLUDED.buyer, bank_cards.buyer) IS NOT NULL THEN TRUE
         ELSE bank_cards.is_buying
       END,
       bank = EXCLUDED.bank,
       acc_no = EXCLUDED.acc_no,
       created_at = LEAST(bank_cards.created_at, EXCLUDED.created_at),
       note = COALESCE(EXCLUDED.note, bank_cards.note),
       creds = COALESCE(EXCLUDED.creds, bank_cards.creds),
       ext_id = COALESCE(EXCLUDED.ext_id, bank_cards.ext_id)`,
    [buyer ?? null, cardNumber, bank, accNo, createdAt, note, creds ?? null, extId ?? null, buyer ? true : null],
  );

  if (buyer && !hadBuyerBefore) {
    const auditDedupKey = `audit:card_issued:${bank}:${cardNumber}`;
    const auditPayload = {
      id: undefined,
      timestamp: new Date().toISOString(),
      division: 'finance',
      user_email: buyer,
      log_type: 'info' as const,
      severity: 2,
      event_type: 'card_issued',
      event_attributes: {
        bank,
        card_number: String(cardNumber),
        acc_no: accNo ?? null,
        ext_id: extId ?? null,
        note: note ?? null,
        source,
      },
    };

    await enqueueOutgoingNotification(client, {
      channel: 'mqtt:sequoia/audit',
      payload: auditPayload,
      dedupKey: auditDedupKey,
      correlationId: null,
    });
  }
}

