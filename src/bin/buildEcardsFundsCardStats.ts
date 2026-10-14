import dotenv from 'dotenv';
import { getConfig } from '../config/index.js';
import { getDatabaseService } from '../infra/index.js';
import { getCurrentUserByProfileName } from '../infra/farmDb.js';

dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local', override: true });

interface FundsFromAccountRow {
  id: string | number;
  profile_name: string | null;
  payment_method: string | null;
  amount_usd: string | number | null;
  created_at: string | Date;
}

interface BankCardRow {
  card_number: string;
  bank: string;
  buyer: string | null;
}

interface TxAggregateRow {
  total_amount_usd: string | number | null;
  debit_amount_usd: string | number | null;
  refund_amount_usd: string | number | null;
  tx_count: string | number | null;
}

interface SpendUpsertRow {
  card_number: string;
  buyer: string;
  funds_profiles: string[];
  funds_amount_usd_total: string | number | null;
}

interface CardStats {
  card_number: string;
  buyer: string;
  bank_transactions_total_amount_usd: number;
  bank_transactions_debit_amount_usd: number;
  bank_transactions_refund_amount_usd: number;
  bank_transactions_count: number;
  funds_profiles: string[];
  funds_amount_usd_total: number;
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function extractLast4(paymentMethod: string | null): string | null {
  if (!paymentMethod) return null;
  const text = paymentMethod.trim();
  if (!text) return null;

  // Основной кейс: "Visa • • • • 7334" (с возможным хвостом после точки).
  const maskedMatch = text.match(/[•*]\s*[•*]\s*[•*]\s*[•*]\s*(\d{4})(?!\d)/u);
  if (maskedMatch?.[1]) return maskedMatch[1];

  // Фоллбек: берем первые 4 цифры после бренда карты (до служебного хвоста/суммы).
  const brandPrefixed = text.match(/^(?:visa|mastercard)\D+(\d{4})(?!\d)/iu);
  if (brandPrefixed?.[1]) return brandPrefixed[1];

  // Последний фоллбек для нестандартных форматов.
  const firstGroup = text.match(/(\d{4})(?!\d)/);
  return firstGroup?.[1] ?? null;
}

async function main(): Promise<void> {
  console.error('[START] build ecards funds card stats');
  const config = getConfig();
  if (!config.syncDatabase) {
    throw new Error('syncDatabase is not configured. Required for finance0_ext.funds_from_account.');
  }

  const db = getDatabaseService(config);
  const syncClient = await db.getClient('sync');
  const mainClient = await db.getClient('main');
  const farmClient = await db.getClient('farm');

  try {
    console.error('[FETCH] loading active funds_from_account rows');
    const fundsRes = await syncClient.query<FundsFromAccountRow>(
      `SELECT id,
              profile_name,
              payment_method,
              amount_usd,
              created_at
       FROM finance0_ext.funds_from_account
       WHERE active = true and payment_method is not null and length(payment_method) > 0
       AND created_at >= '2026-03-01'
       ORDER BY created_at DESC`,
      [],
    );
    console.error(`[FETCH] loaded rows=${fundsRes.rows.length}`);

    const profileBuyerCache = new Map<string, string | null>();
    const cardByBuyerLast4Cache = new Map<string, string | null>();
    const ambiguousBuyerLast4Cache = new Set<string>();
    const txAggregateByCardCache = new Map<string, Omit<CardStats, 'buyer' | 'funds_profiles' | 'funds_amount_usd_total'>>();
    const resultsByKey = new Map<string, CardStats>();

    let scannedFundsRows = 0;
    let skippedNoProfile = 0;
    let skippedNoBuyer = 0;
    let skippedNoPaymentMethod = 0;
    let skippedNoLast4 = 0;
    let skippedNoEcardsCard = 0;
    let skippedMultipleEcardsCards = 0;
    let upsertedCards = 0;
    const PROGRESS_EVERY = 100;

    for (const row of fundsRes.rows) {
      scannedFundsRows += 1;
      if (scannedFundsRows % PROGRESS_EVERY === 0) {
        console.error(
          `[PROGRESS] scanned=${scannedFundsRows}/${fundsRes.rows.length} upserted_cards=${upsertedCards} skipped_no_profile=${skippedNoProfile} skipped_no_buyer=${skippedNoBuyer} skipped_no_payment_method=${skippedNoPaymentMethod} skipped_no_last4=${skippedNoLast4} skipped_no_ecards_card=${skippedNoEcardsCard} skipped_multiple_ecards_cards=${skippedMultipleEcardsCards}`,
        );
      }
      const profileName = row.profile_name?.trim() ?? '';
      if (!profileName) {
        skippedNoProfile += 1;
        continue;
      }

      let buyer = profileBuyerCache.get(profileName) ?? null;
      if (!profileBuyerCache.has(profileName)) {
        const owner = await getCurrentUserByProfileName(farmClient, profileName);
        buyer = owner?.email?.trim().toLowerCase() ?? null;
        profileBuyerCache.set(profileName, buyer);
      }
      if (!buyer) {
        skippedNoBuyer += 1;
        continue;
      }

      const paymentMethod = row.payment_method?.trim() ?? '';
      if (!paymentMethod) {
        skippedNoPaymentMethod += 1;
        continue;
      }
      const last4 = extractLast4(paymentMethod);
      if (!last4) {
        skippedNoLast4 += 1;
        continue;
      }

      const cacheKey = `${buyer}::${last4}`;
      if (ambiguousBuyerLast4Cache.has(cacheKey)) {
        skippedMultipleEcardsCards += 1;
        continue;
      }
      let cardNumber = cardByBuyerLast4Cache.get(cacheKey) ?? null;
      if (!cardByBuyerLast4Cache.has(cacheKey)) {
        console.error(`[CARD_LOOKUP] buyer=${buyer} last4=${last4}`);
        const cardRes = await mainClient.query<BankCardRow>(
          `SELECT card_number::text AS card_number, bank::text AS bank, buyer
           FROM public.bank_cards
           WHERE card_number % 10000 = $1::int
             AND lower(coalesce(buyer, '')) = lower($2)
             AND lower(bank) = 'ecards'
           ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
           LIMIT 2`,
          [last4, buyer],
        );
        if (cardRes.rows.length > 1) {
          console.error(`[CARD_LOOKUP] ambiguous cards for buyer=${buyer} last4=${last4}, skipping`);
          ambiguousBuyerLast4Cache.add(cacheKey);
          skippedMultipleEcardsCards += 1;
          continue;
        }
        cardNumber = cardRes.rows[0]?.card_number ?? null;
        if (cardNumber) {
          console.error(`[CARD_LOOKUP] resolved card=${cardNumber} buyer=${buyer} last4=${last4}`);
        }
        cardByBuyerLast4Cache.set(cacheKey, cardNumber);
      }
      if (!cardNumber) {
        skippedNoEcardsCard += 1;
        continue;
      }

      let txAgg = txAggregateByCardCache.get(cardNumber);
      if (!txAgg) {
        console.error(`[AGGREGATE] card=${cardNumber} buyer=${buyer}`);
        const txAggRes = await mainClient.query<TxAggregateRow>(
          `SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN amount_usd ELSE 0 END), 0) AS total_amount_usd,
                  COALESCE(SUM(CASE WHEN amount < 0 THEN amount_usd ELSE 0 END), 0) AS debit_amount_usd,
                  COALESCE(SUM(CASE WHEN amount_usd > 0 THEN amount_usd ELSE 0 END), 0) AS refund_amount_usd,
                  COUNT(*) FILTER (WHERE amount < 0)::text AS tx_count
           FROM public.bank_transactions
           WHERE bank = 'ecards'
             AND (raw->'card'->>'cardNumber') = $1`,
          [cardNumber],
        );
        const agg = txAggRes.rows[0];
        txAgg = {
          card_number: cardNumber,
          bank_transactions_total_amount_usd: toFiniteNumber(agg?.total_amount_usd),
          bank_transactions_debit_amount_usd: toFiniteNumber(agg?.debit_amount_usd),
          bank_transactions_refund_amount_usd: toFiniteNumber(agg?.refund_amount_usd),
          bank_transactions_count: toFiniteNumber(agg?.tx_count),
        };
        txAggregateByCardCache.set(cardNumber, txAgg);
      }

      const rowFundsAmountUsd = Number(toFiniteNumber(row.amount_usd).toFixed(4));
      const upsertRes = await mainClient.query<SpendUpsertRow>(
        `INSERT INTO public.spends (
           card_number,
           buyer,
           bank,
           bank_transactions_total_amount_usd,
           bank_transactions_debit_amount_usd,
           bank_transactions_refund_amount_usd,
           bank_transactions_count,
           funds_profiles,
           funds_amount_usd_total,
           payload,
           created_at,
           updated_at
         )
         VALUES (
           $1::bigint,
           $2,
           'ecards',
           $3::numeric,
           $4::numeric,
           $5::numeric,
           $6::int,
           $7::text[],
           $8::numeric,
           $9::jsonb,
           NOW(),
           NOW()
         )
         ON CONFLICT (card_number, buyer, bank) DO UPDATE
         SET bank_transactions_total_amount_usd = EXCLUDED.bank_transactions_total_amount_usd,
             bank_transactions_debit_amount_usd = EXCLUDED.bank_transactions_debit_amount_usd,
             bank_transactions_refund_amount_usd = EXCLUDED.bank_transactions_refund_amount_usd,
             bank_transactions_count = EXCLUDED.bank_transactions_count,
             funds_amount_usd_total = COALESCE(public.spends.funds_amount_usd_total, 0) + COALESCE(EXCLUDED.funds_amount_usd_total, 0),
             funds_profiles = (
               SELECT ARRAY(
                 SELECT DISTINCT profile_name
                 FROM unnest(
                   COALESCE(public.spends.funds_profiles, ARRAY[]::text[]) ||
                   COALESCE(EXCLUDED.funds_profiles, ARRAY[]::text[])
                 ) AS profile_name
                 ORDER BY profile_name
               )
             ),
             payload = jsonb_build_object(
               'card_number', EXCLUDED.card_number::text,
               'buyer', EXCLUDED.buyer,
               'bank_transactions_total_amount_usd', EXCLUDED.bank_transactions_total_amount_usd,
               'bank_transactions_debit_amount_usd', EXCLUDED.bank_transactions_debit_amount_usd,
               'bank_transactions_refund_amount_usd', EXCLUDED.bank_transactions_refund_amount_usd,
               'bank_transactions_count', EXCLUDED.bank_transactions_count,
               'funds_profiles', (
                 SELECT ARRAY(
                   SELECT DISTINCT profile_name
                   FROM unnest(
                     COALESCE(public.spends.funds_profiles, ARRAY[]::text[]) ||
                     COALESCE(EXCLUDED.funds_profiles, ARRAY[]::text[])
                   ) AS profile_name
                   ORDER BY profile_name
                 )
               ),
               'funds_amount_usd_total', COALESCE(public.spends.funds_amount_usd_total, 0) + COALESCE(EXCLUDED.funds_amount_usd_total, 0)
             ),
             updated_at = NOW()
         RETURNING card_number::text AS card_number, buyer, funds_profiles, funds_amount_usd_total`,
        [
          txAgg.card_number,
          buyer,
          txAgg.bank_transactions_total_amount_usd,
          txAgg.bank_transactions_debit_amount_usd,
          txAgg.bank_transactions_refund_amount_usd,
          txAgg.bank_transactions_count,
          [profileName],
          rowFundsAmountUsd,
          JSON.stringify({
            card_number: txAgg.card_number,
            buyer,
            bank_transactions_total_amount_usd: txAgg.bank_transactions_total_amount_usd,
            bank_transactions_debit_amount_usd: txAgg.bank_transactions_debit_amount_usd,
            bank_transactions_refund_amount_usd: txAgg.bank_transactions_refund_amount_usd,
            bank_transactions_count: txAgg.bank_transactions_count,
            funds_profiles: [profileName],
            funds_amount_usd_total: rowFundsAmountUsd,
          }),
        ],
      );

      const persisted = upsertRes.rows[0];
      if (!persisted) continue;
      const resultRow: CardStats = {
        card_number: txAgg.card_number,
        buyer,
        bank_transactions_total_amount_usd: txAgg.bank_transactions_total_amount_usd,
        bank_transactions_debit_amount_usd: txAgg.bank_transactions_debit_amount_usd,
        bank_transactions_refund_amount_usd: txAgg.bank_transactions_refund_amount_usd,
        bank_transactions_count: txAgg.bank_transactions_count,
        funds_profiles: [...(persisted.funds_profiles ?? [])].sort((a, b) => a.localeCompare(b)),
        funds_amount_usd_total: Number(toFiniteNumber(persisted.funds_amount_usd_total).toFixed(4)),
      };

      upsertedCards += 1;
      console.error(
        `[UPSERT] card=${resultRow.card_number} buyer=${resultRow.buyer} profiles=${resultRow.funds_profiles.length} funds_amount_usd_total=${resultRow.funds_amount_usd_total} tx_count=${resultRow.bank_transactions_count}`,
      );
      resultsByKey.set(`${resultRow.card_number}::${resultRow.buyer}`, resultRow);
    }

    const results = Array.from(resultsByKey.values());
    results.sort((a, b) => b.funds_amount_usd_total - a.funds_amount_usd_total);

    console.error(
      `[DONE] funds_rows=${fundsRes.rows.length} scanned=${scannedFundsRows} cards=${results.length} upserted_cards=${upsertedCards} skipped_no_profile=${skippedNoProfile} skipped_no_buyer=${skippedNoBuyer} skipped_no_payment_method=${skippedNoPaymentMethod} skipped_no_last4=${skippedNoLast4} skipped_no_ecards_card=${skippedNoEcardsCard} skipped_multiple_ecards_cards=${skippedMultipleEcardsCards}`,
    );
    console.log(JSON.stringify(results, null, 2));
  } finally {
    syncClient.release();
    mainClient.release();
    farmClient.release();
    await db.shutdown();
  }
}

void main().catch((err) => {
  console.error('Script failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
