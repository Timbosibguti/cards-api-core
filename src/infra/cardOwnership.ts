/**
 * Единая точка смены владения картой: обновление bank_cards и запись в bank_cards_history.
 * Архитектура: architecture_overview.md §4.2 — один активный интервал на карту (valid_to IS NULL).
 * Все операции в одной транзакции: UPDATE bank_cards → закрыть текущий интервал → INSERT новый.
 */

import type { PoolClient } from 'pg';

export interface SetCardOwnershipParams {
  cardNumber: number;
  bank: string;
  buyer: string | null;
  profileName: string | null;
  is_buying: boolean;
  is_bad?: boolean;
  lastUsedAt?: Date | null;
}

/**
 * Устанавливает владельца карты и пишет интервал в bank_cards_history.
 * Вызывать в той же транзакции, что и остальные изменения по карте.
 */
export async function setCardOwnership(
  client: PoolClient,
  params: SetCardOwnershipParams,
): Promise<void> {
  const { cardNumber, bank, buyer, profileName, is_buying, is_bad, lastUsedAt } = params;
  const bankNorm = bank.toLowerCase();
  const isBadValue = is_bad ?? false;

  await client.query(
    `UPDATE public.bank_cards
     SET buyer = $1,
         profile_name = $2,
         is_buying = $3,
         is_bad = $4,
         last_used_at = CASE
           WHEN $7::timestamptz IS NULL THEN last_used_at
           ELSE COALESCE(last_used_at, $7::timestamptz)
         END
     WHERE card_number = $5 AND bank = $6`,
    [buyer, profileName, is_buying, isBadValue, cardNumber, bankNorm, lastUsedAt ?? null],
  );

  // 2) Закрыть текущий активный интервал (если есть)
  await client.query(
    `UPDATE public.bank_cards_history
     SET valid_to = NOW()
     WHERE card_number = $1 AND valid_to IS NULL`,
    [cardNumber],
  );

  // 3) Вставить новый интервал
  await client.query(
    `INSERT INTO public.bank_cards_history
     (card_number, bank, buyer_email, profile_name, is_buying, valid_from, valid_to)
     VALUES ($1, $2, $3, $4, $5, NOW(), NULL)`,
    [cardNumber, bankNorm, buyer, profileName, is_buying],
  );
}
