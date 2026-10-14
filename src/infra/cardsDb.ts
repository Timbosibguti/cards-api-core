/**
 * Операции с картами для farm-extension API (/api/cards/*).
 * bank_cards, cards_info, bank_cards_shown, cards_access.
 * Совместимость с mqtt_ecards_transactions DatabaseService.
 */

import type { PoolClient } from 'pg';
import { getConfig } from '../config/index.js';
import { getDatabaseService } from './index.js';
import { setCardOwnership } from './cardOwnership.js';
import { logger } from './logger.js';

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const db = getDatabaseService(getConfig());
  const client = await db.getClient('main');
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** BIN из номера карты: ecards — первые 6 цифр, остальные — 4–6. */
export function extractBin(cardNumber: number, bank: string): number {
  const s = String(cardNumber);
  if (bank.toLowerCase() === 'ecards') {
    return parseInt(s.substring(0, 6), 10);
  }
  if (s.length >= 6) return parseInt(s.substring(0, 6), 10);
  if (s.length >= 4) return parseInt(s.substring(0, 4), 10);
  return parseInt(s, 10);
}

export async function getCardInfo(
  client: PoolClient,
  bank: string,
  bin: number,
): Promise<{ geo: string | null; info: string | null }> {
  let result = await client.query<{ geo: string | null; info: string | null }>(
    `SELECT geo, info FROM public.cards_info WHERE bank = $1 AND bin = $2 LIMIT 1`,
    [bank.toLowerCase(), bin],
  );
  if (result.rows.length > 0) {
    return { geo: result.rows[0].geo ?? null, info: result.rows[0].info ?? null };
  }
  const binStr = String(bin);
  if (binStr.length === 6) {
    const bin4 = parseInt(binStr.substring(0, 4), 10);
    result = await client.query<{ geo: string | null; info: string | null }>(
      `SELECT geo, info FROM public.cards_info WHERE bank = $1 AND bin = $2 LIMIT 1`,
      [bank.toLowerCase(), bin4],
    );
    if (result.rows.length > 0) {
      return { geo: result.rows[0].geo ?? null, info: result.rows[0].info ?? null };
    }
  }
  return { geo: null, info: null };
}

/** Карта по profile_name (любой банк). */
export async function getCardByProfileName(
  client: PoolClient,
  profileName: string,
): Promise<{ creds: string | null; card_number: number; bank: string } | null> {
  const result = await client.query<{ creds: string | null; card_number: number; bank: string }>(
    `SELECT creds, card_number, bank FROM public.bank_cards WHERE profile_name = $1 LIMIT 1`,
    [profileName.trim()],
  );
  return result.rows.length > 0 ? result.rows[0] : null;
}

/** Все карты, привязанные к email баера (bank_cards.buyer), без creds. */
export async function listBankCardsByBuyerEmail(
  client: PoolClient,
  buyerEmail: string,
): Promise<Array<{ card_number: string; bank: string; profile_name: string | null; is_bad: boolean }>> {
  const normalized = buyerEmail.trim().toLowerCase();
  const result = await client.query<{
    card_number: string;
    bank: string;
    profile_name: string | null;
    is_bad: boolean | null;
  }>(
    `SELECT card_number::text AS card_number,
            bank,
            profile_name,
            COALESCE(is_bad, false) AS is_bad
     FROM public.bank_cards
     WHERE buyer IS NOT NULL AND LOWER(TRIM(buyer)) = $1
     ORDER BY bank ASC, card_number ASC`,
    [normalized],
  );
  return result.rows.map((r) => ({
    card_number: r.card_number,
    bank: r.bank,
    profile_name: r.profile_name ?? null,
    is_bad: r.is_bad ?? false,
  }));
}

/**
 * Карта по номеру и email баера (проверка владения). creds — строка для decryptCardCredentials, если в БД иначе — null.
 */
export async function getBankCardForBuyerByCardNumber(
  client: PoolClient,
  buyerEmail: string,
  cardNumberDigits: string,
): Promise<{ creds: string | null; card_number: string; bank: string; profile_name: string | null } | null> {
  const normalizedBuyer = buyerEmail.trim().toLowerCase();
  if (!/^\d+$/.test(cardNumberDigits)) return null;
  const result = await client.query<{
    creds: unknown;
    card_number: string;
    bank: string;
    profile_name: string | null;
  }>(
    `SELECT creds, card_number::text AS card_number, bank, profile_name
     FROM public.bank_cards
     WHERE card_number = $1::bigint
       AND buyer IS NOT NULL
       AND LOWER(TRIM(buyer)) = $2
     LIMIT 1`,
    [cardNumberDigits, normalizedBuyer],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  let creds: string | null = null;
  if (row.creds != null) {
    creds = typeof row.creds === 'string' ? row.creds : null;
  }
  return {
    creds,
    card_number: row.card_number,
    bank: row.bank,
    profile_name: row.profile_name ?? null,
  };
}

function getBinRange(binPrefix?: number | null): { binFrom: string | null; binTo: string | null } {
  if (typeof binPrefix !== 'number' || isNaN(binPrefix)) {
    return { binFrom: null, binTo: null };
  }
  const prefixStr = String(binPrefix);
  const digits = prefixStr.length;
  const scale = 10n ** BigInt(Math.max(0, 16 - digits));
  const prefix = BigInt(binPrefix);
  return {
    binFrom: (prefix * scale).toString(),
    binTo: ((prefix + 1n) * scale).toString(),
  };
}

export const ACC_NO_FARM = `( (LOWER(acc_no) LIKE '%farm%' OR acc_no = 'FEBRUARY' OR acc_no = 'Для БИНа 450897 с общим балансом') AND acc_no NOT LIKE '%/%' ) AND (released_at IS NULL OR released_at < NOW() - INTERVAL '24 hours')`;
const ACC_NO_FARM_BC = `( (LOWER(bc.acc_no) LIKE '%farm%' OR bc.acc_no = 'FEBRUARY' OR bc.acc_no = 'Для БИНа 450897 с общим балансом') AND bc.acc_no NOT LIKE '%/%' ) AND (bc.released_at IS NULL OR bc.released_at < NOW() - INTERVAL '24 hours')`;

/** Атомарно резервирует свободную карту по BIN и привязывает к profile_name. */
export async function reserveFreeCardByBin(
  client: PoolClient,
  params: { bank: string; binPrefix?: number | null; profileName: string; body: any },
): Promise<{ creds: string | null; card_number: number; bank: string } | null> {
  const { binFrom, binTo } = getBinRange(params.binPrefix);
  const result = await client.query<{ creds: string | null; card_number: number; bank: string }>(
    `WITH c AS (
       SELECT card_number FROM public.bank_cards
       WHERE bank = $1
         AND (buyer IS NULL OR buyer = '')
         AND (profile_name IS NULL OR profile_name = '')
         AND last_used_at IS NULL
         AND (${ACC_NO_FARM})
         AND ($2::bigint IS NULL OR (card_number >= $2 AND card_number < $3))
         AND NOT is_bad
       ORDER BY RANDOM() LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE public.bank_cards b
     SET profile_name = $4
     FROM c WHERE b.card_number = c.card_number
     RETURNING b.creds, b.card_number, b.bank`,
    [params.bank.toLowerCase(), binFrom, binTo, params.profileName.trim()],
  );
  logger.warn('[LINK_CARD] reserveFreeCardByBin', { params, body: params.body, result });
  return result.rows.length > 0 ? result.rows[0] : null;
}

/** Количество свободных карт по банку и опционально BIN. */
export async function countFreeCardsByBin(
  client: PoolClient,
  params: { bank: string; binPrefix?: number | null },
): Promise<number> {
  const { binFrom, binTo } = getBinRange(params.binPrefix);
  const result = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM public.bank_cards
     WHERE bank = $1
       AND (buyer IS NULL OR buyer = '')
       AND (profile_name IS NULL OR profile_name = '')
       AND last_used_at IS NULL
       AND NOT is_bad
       AND (${ACC_NO_FARM})
       AND ($2::bigint IS NULL OR (card_number >= $2 AND card_number < $3))`,
    [params.bank.toLowerCase(), binFrom, binTo],
  );
  return parseInt(result.rows[0]?.count ?? '0', 10) || 0;
}

/** Запись в bank_cards_shown. */
export async function recordCardShown(
  client: PoolClient,
  params: { cardNumber: number; email: string | null; profileName?: string | null },
): Promise<void> {
  await client.query(
    `INSERT INTO public.bank_cards_shown (created_at, card_number, email, profile_name)
     VALUES (NOW(), $1, $2, $3)`,
    [params.cardNumber, params.email, params.profileName ?? null],
  );
}

/** Есть ли email в cards_access. */
export async function checkCardAccess(client: PoolClient, email: string | null): Promise<boolean> {
  if (!email) return false;
  const result = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM public.cards_access WHERE email = $1`,
    [email.toLowerCase()],
  );
  return parseInt(result.rows[0]?.count ?? '0', 10) > 0;
}

/** Отвязать карту от профиля (profile_name = NULL, buyer = NULL, acc_no = 'FEBRUARY') и записать интервал в bank_cards_history. */
export async function unlinkCardFromProfile(
  client: PoolClient,
  cardNumber: number,
  profileName?: string | null,
): Promise<boolean> {
  const result = await client.query<{ bank: string; profile_name: string | null }>(
    `SELECT bank, profile_name FROM public.bank_cards WHERE card_number = $1 LIMIT 1`,
    [cardNumber],
  );
  if (result.rows.length === 0) return false;
  const row = result.rows[0];
  if (profileName != null && profileName.trim() !== '' && row.profile_name?.trim() !== profileName.trim()) {
    return false;
  }
  await setCardOwnership(client, {
    cardNumber,
    bank: row.bank,
    buyer: null,
    profileName: null,
    is_buying: false,
  });
  await client.query(
    `UPDATE public.bank_cards
     SET released_at = NOW()
     WHERE card_number = $1 AND bank = $2`,
    [cardNumber, row.bank],
  );
  /*await client.query(
    `UPDATE public.bank_cards SET acc_no = 'FEBRUARY' WHERE card_number = $1 AND bank = $2`,
    [cardNumber, row.bank],
  );*/
  return true;
}

/** cards_info + количество свободных карт по BIN (для get-bins). */
export async function getAllCardsInfoWithFreeCounts(): Promise<
  Array<{ bank: string; bin: string; geo: string | null; info: string | null; free_count: number }>
> {
  return withClient(async (client) => {
    const result = await client.query<{
      bank: string;
      bin: number;
      geo: string | null;
      info: string | null;
      free_count: string;
    }>(
      `SELECT ci.bank, ci.bin, ci.geo, ci.info,
              COUNT(bc.card_number)::text AS free_count
       FROM public.cards_info ci
       LEFT JOIN public.bank_cards bc
         ON bc.bank = ci.bank
         AND (bc.buyer IS NULL OR bc.buyer = '')
         AND (bc.profile_name IS NULL OR bc.profile_name = '')
         AND bc.last_used_at IS NULL
         AND NOT bc.is_bad
         AND (${ACC_NO_FARM_BC})
         AND bc.card_number >= ci.bin::bigint * POWER(10, 16 - LENGTH(ci.bin::text))::bigint
         AND bc.card_number < (ci.bin + 1)::bigint * POWER(10, 16 - LENGTH(ci.bin::text))::bigint
       GROUP BY ci.bank, ci.bin, ci.geo, ci.info
       HAVING COUNT(bc.card_number) > 0
       ORDER BY ci.bank, ci.bin`,
    );
    return result.rows.map((r) => ({
      bank: r.bank,
      bin: String(r.bin),
      geo: r.geo ?? null,
      info: r.info ?? null,
      free_count: parseInt(r.free_count, 10) || 0,
    }));
  });
}

/** Данные карты перед отвязкой (для аудита). */
export async function getCardDataBeforeUnlink(
  client: PoolClient,
  cardNumber: number,
): Promise<{ profile_name: string | null; bank: string | null; buyer: string | null }> {
  const result = await client.query<{
    profile_name: string | null;
    bank: string | null;
    buyer: string | null;
  }>(
    `SELECT profile_name, bank, buyer FROM public.bank_cards WHERE card_number = $1 LIMIT 1`,
    [cardNumber],
  );
  const row = result.rows[0];
  return {
    profile_name: row?.profile_name ?? null,
    bank: row?.bank ?? null,
    buyer: row?.buyer ?? null,
  };
}
