import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { getConfig } from '../config/index.js';
import { getDatabaseService } from '../infra/index.js';
import { normalizeRawPayload } from '../modules/transactions/normalize.js';
import type { BankId } from '../modules/transactions/types.js';

dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local', override: true });

const START_AT = new Date('2026-03-01T00:00:00.000Z');
const END_AT = new Date();
const SUPPORTED_BANKS: BankId[] = ['ecards', 'adscards', 'multicards', 'stellarcards'];
const BATCH_SIZE = 100;
const PROGRESS_EVERY = 500;
const NON_TARGET_LOG_FILE = path.resolve('', 'merchant_non_googleads_tosspayments_2026_03_to_now.log');

type BankTransactionRow = {
  [key: string]: unknown;
  bank: string;
  ext_id: string;
  created_at: string | Date;
  raw: unknown;
  amount_usd?: unknown;
};

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isExcludedMerchantText(rawMerchant: string): boolean {
  const upper = rawMerchant.toUpperCase();
  return (
    upper.includes('TEMPORARY') ||
    upper.includes('GOOGLESERVIS') ||
    upper.includes('GOOGLEDIGITAL') ||
    upper.includes('GOOGLE DIGITAL') ||
    /GOOGLE\s*\*?\s*SERVICES/.test(upper) ||
    upper.includes('КОМИССИЯ ЗА ОТМЕНУ ПЛАТЕЖА') ||
    upper.includes('КОМИССИЯ ЗА КОНВЕРТАЦИЮ') ||
    upper.includes('КОМИССИЯ ЗА ПРОВЕДЕНИЕ ПЛАТЕЖА') ||
    upper.includes('(AUTHORIZATION)') ||
    upper.includes('CHARGE (REVERSAL)') ||
    upper.includes('DEBIT (DECLINED)') ||
    upper.includes('CHARGE (REFUND)') ||
    /^GOOGLE\*?$/.test(upper) ||
    upper.includes('GOOGLE*')
  );
}

function classifyMerchant(rawMerchant: string | null): string | null {
  if (!rawMerchant) return null;
  const text = normalizeSpaces(rawMerchant);
  if (!text) return null;
  if (isExcludedMerchantText(text)) return null;
  const upper = text.toUpperCase();

  // Синхронизировано с extractGoogleCode в modules/transactions/index.ts:
  // любой merchant с GOOGLE + изолированным 6-значным кодом считаем GoogleAds.
  if (upper.includes('GOOGLE') && /(?<!\d)\d{6}(?!\d)/.test(text)) return 'GoogleAds';
  if (/GOOGLE\s*\*?\s*ADS/.test(upper)) return 'GoogleAds';
  if (/TOSS\s*PAYMENTS?/.test(upper)) return 'TossPayments';

  return text;
}

function extractSourceMerchantText(normalizedMerchantDescription: string | null): string | null {
  if (!normalizedMerchantDescription) return null;
  return normalizeSpaces(normalizedMerchantDescription);
}

function sortStatsDesc(stats: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(stats).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    }),
  );
}

function toNumberOrZero(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

async function main(): Promise<void> {
  console.error('[START] build merchant stats from card transactions');
  console.error(
    `[CONFIG] range=${START_AT.toISOString()}..${END_AT.toISOString()} banks=${SUPPORTED_BANKS.join(',')}`,
  );
  console.error(`[CONFIG] non_target_log_file=${NON_TARGET_LOG_FILE}`);

  const config = getConfig();
  const db = getDatabaseService(config);
  const mainClient = await db.getClient('main');

  fs.mkdirSync(path.dirname(NON_TARGET_LOG_FILE), { recursive: true });
  fs.writeFileSync(NON_TARGET_LOG_FILE, '', 'utf8');
  const nonTargetLogStream = fs.createWriteStream(NON_TARGET_LOG_FILE, { flags: 'a' });

  try {
    const countRes = await mainClient.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
       FROM public.bank_transactions bt
       WHERE bt.created_at >= $1
         AND bt.created_at < $2`,
      [START_AT.toISOString(), END_AT.toISOString()],
    );
    const totalRows = Number(countRes.rows[0]?.cnt ?? 0);
    console.error(`[FETCH] total bank_transactions rows in range=${totalRows}`);

    let scanned = 0;
    let normalizedOk = 0;
    let cardTransactions = 0;
    let withMerchant = 0;
    let nonTargetLogged = 0;
    let skippedUnsupportedBank = 0;
    let skippedNormalizeFailed = 0;
    let skippedNotCard = 0;
    let skippedNoMerchant = 0;
    let skippedTemporary = 0;
    let skippedExcludedMerchant = 0;
    let nonTargetAmountUsdSum = 0;

    const stats: Record<string, number> = {};

    for (let offset = 0; ; offset += BATCH_SIZE) {
      const txRes = await mainClient.query<BankTransactionRow>(
        `SELECT bt.*
         FROM public.bank_transactions bt
         WHERE bt.created_at >= $1
           AND bt.created_at < $2
         ORDER BY bt.created_at ASC, bt.bank ASC, bt.ext_id ASC
         LIMIT $3 OFFSET $4`,
        [START_AT.toISOString(), END_AT.toISOString(), BATCH_SIZE, offset],
      );
      if (txRes.rows.length === 0) break;

      console.error(`[BATCH] offset=${offset} size=${txRes.rows.length} scanned_before=${scanned}`);

      for (const tx of txRes.rows) {
        scanned += 1;
        if (scanned % PROGRESS_EVERY === 0) {
          console.error(
            `[PROGRESS] scanned=${scanned}/${totalRows} normalized=${normalizedOk} card_transactions=${cardTransactions} with_merchant=${withMerchant} non_target_logged=${nonTargetLogged}`,
          );
        }

        if (!SUPPORTED_BANKS.includes(tx.bank as BankId)) {
          skippedUnsupportedBank += 1;
          continue;
        }

        let normalized = null;
        try {
          normalized = await normalizeRawPayload(mainClient, tx.bank as BankId, tx.raw);
        } catch {
          normalized = null;
        }
        if (!normalized) {
          skippedNormalizeFailed += 1;
          continue;
        }
        normalizedOk += 1;

        if (!normalized.card_number) {
          skippedNotCard += 1;
          continue;
        }
        cardTransactions += 1;

        const sourceMerchant = extractSourceMerchantText(normalized.merchant_description ?? null);
        if (!sourceMerchant) {
          skippedNoMerchant += 1;
          continue;
        }
        withMerchant += 1;

        const merchantKey = classifyMerchant(sourceMerchant);
        if (!merchantKey) {
          if (sourceMerchant.toUpperCase().includes('TEMPORARY')) {
            skippedTemporary += 1;
            continue;
          }
          if (isExcludedMerchantText(sourceMerchant)) {
            skippedExcludedMerchant += 1;
            continue;
          }
          skippedNoMerchant += 1;
          continue;
        }

        stats[merchantKey] = (stats[merchantKey] ?? 0) + 1;

        if (merchantKey !== 'GoogleAds' && merchantKey !== 'TossPayments') {
          const createdAtValue = tx.created_at instanceof Date ? tx.created_at.toISOString() : String(tx.created_at);
          const fullCardNumber = normalized.card_number ? String(normalized.card_number).replace(/\D/g, '') || null : null;
          const amountValue = normalized.amount ?? null;
          const amountUsdValue = toNumberOrZero(tx.amount_usd);
          nonTargetAmountUsdSum += amountUsdValue;
          const line =
            `[NON_TARGET] bank=${tx.bank} ext_id=${tx.ext_id} created_at=${createdAtValue} merchant_key=${merchantKey} source_merchant="${sourceMerchant}" amount=${amountValue ?? 'null'} amount_usd=${amountUsdValue} full_card_number=${fullCardNumber ?? 'null'}`;
          console.error(line);
          nonTargetLogStream.write(`${line}\n`);
          nonTargetLogged += 1;
        }
      }
    }

    const sortedStats = sortStatsDesc(stats);
    console.error(
      `[DONE] scanned=${scanned} normalized=${normalizedOk} card_transactions=${cardTransactions} with_merchant=${withMerchant} unique_keys=${Object.keys(sortedStats).length} non_target_logged=${nonTargetLogged}`,
    );
    console.error(`[DONE] non_target_sum_amount_usd=${nonTargetAmountUsdSum.toFixed(2)}`);
    console.error(
      `[DONE] skipped_unsupported_bank=${skippedUnsupportedBank} skipped_normalize_failed=${skippedNormalizeFailed} skipped_not_card=${skippedNotCard} skipped_no_merchant=${skippedNoMerchant} skipped_temporary=${skippedTemporary} skipped_excluded_merchant=${skippedExcludedMerchant}`,
    );
    console.error(`[DONE] non_target_log_file=${NON_TARGET_LOG_FILE}`);

    console.log(JSON.stringify(sortedStats, null, 2));
  } finally {
    await new Promise<void>((resolve) => {
      nonTargetLogStream.end(() => resolve());
    });
    mainClient.release();
    await db.shutdown();
  }
}

void main().catch((err) => {
  console.error('Script failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
