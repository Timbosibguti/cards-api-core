import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import type { PoolClient } from 'pg';
import { getConfig } from '../config/index.js';
import { getDatabaseService } from '../infra/index.js';
import { normalizeRawPayload } from '../modules/transactions/normalize.js';
import type { BankId } from '../modules/transactions/types.js';

dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local', override: true });

const START_AT = new Date('2026-03-01T00:00:00.000Z');
const END_AT = new Date('2026-05-01T00:00:00.000Z');
const SUPPORTED_BANKS: BankId[] = ['ecards', 'adscards', 'multicards', 'stellarcards'];
const PROGRESS_EVERY = 500;
const BATCH_SIZE = 100;
const MATCH_LOG_FILE = path.resolve('', 'missing_google_ads_matches_2026_03_04.log');

type BankTransactionRow = {
  [key: string]: unknown;
  bank: string;
  ext_id: string;
  created_at: string | Date;
  raw: unknown;
};

function extractGoogleAdsAccountId(merchantText: string | null): string | null {
  if (!merchantText) return null;
  const upper = merchantText.toUpperCase();
  if (!upper.includes('GOOGLE') || !upper.includes('ADS')) return null;
  const match = upper.match(/(?<!\d)(\d{10})(?!\d)/);
  return match ? match[1] : null;
}

function normalizeDigits(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

async function hasFundsAccountId(
  syncClient: PoolClient,
  googleAdsIdDigits: string,
  txProfileName: string | null,
): Promise<boolean> {
  const res = await syncClient.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM finance0_ext.funds_from_account
       WHERE regexp_replace(COALESCE(account_id, ''), '[^0-9]', '', 'g') = $1
          OR (
            $2::text IS NOT NULL
            AND btrim(COALESCE(account_id, '')) <> ''
            AND lower(btrim(account_id)) = lower(btrim($2::text))
          )
     ) AS exists`,
    [googleAdsIdDigits, txProfileName],
  );
  return Boolean(res.rows[0]?.exists);
}

async function isKnownBuyer(mainClient: PoolClient, email: string): Promise<boolean> {
  const res = await mainClient.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM public.binom
       WHERE lower(buyer) = lower($1)
       LIMIT 1
     ) AS exists`,
    [email],
  );
  return Boolean(res.rows[0]?.exists);
}

async function main(): Promise<void> {
  console.error('[START] find missing Google Ads transactions');
  console.error(`[CONFIG] range=${START_AT.toISOString()}..${END_AT.toISOString()} banks=${SUPPORTED_BANKS.join(',')}`);
  console.error(`[CONFIG] match_log_file=${MATCH_LOG_FILE}`);

  const config = getConfig();
  if (!config.syncDatabase) {
    throw new Error('syncDatabase is not configured. Required for finance0_ext.funds_from_account lookup.');
  }

  const db = getDatabaseService(config);
  const mainClient = await db.getClient('main');
  const syncClient = await db.getClient('sync');
  fs.mkdirSync(path.dirname(MATCH_LOG_FILE), { recursive: true });
  fs.writeFileSync(MATCH_LOG_FILE, '', 'utf8');
  const matchLogStream = fs.createWriteStream(MATCH_LOG_FILE, { flags: 'a' });

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
    let withGoogleAdsId = 0;
    let missingInFunds = 0;
    let skippedUnsupportedBank = 0;
    let skippedNormalizeFailed = 0;
    let skippedWithoutGoogleAdsId = 0;
    let skippedExistsInFunds = 0;
    let skippedNonBuyer = 0;
    const buyerExistsCache = new Map<string, boolean>();

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

      console.error(
        `[BATCH] offset=${offset} size=${txRes.rows.length} scanned_before=${scanned}`,
      );

      for (const tx of txRes.rows) {
        scanned += 1;
        if (scanned % PROGRESS_EVERY === 0) {
          console.error(
            `[PROGRESS] scanned=${scanned}/${totalRows} normalized=${normalizedOk} with_google_ads_id=${withGoogleAdsId} missing=${missingInFunds}`,
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

        const googleAdsId = extractGoogleAdsAccountId(normalized.merchant_description ?? null);
        if (!googleAdsId) {
          skippedWithoutGoogleAdsId += 1;
          continue;
        }
        withGoogleAdsId += 1;

        const txProfileName =
          typeof tx.profile_name === 'string' && tx.profile_name.trim().length > 0
            ? tx.profile_name
            : null;
        const existsInFunds = await hasFundsAccountId(syncClient, googleAdsId, txProfileName);
        if (existsInFunds) {
          skippedExistsInFunds += 1;
          continue;
        }
        missingInFunds += 1;

        const txBuyer =
          typeof tx.buyer === 'string' && tx.buyer.trim().length > 0
            ? tx.buyer.trim()
            : null;
        if (txBuyer) {
          const cacheKey = txBuyer.toLowerCase();
          let buyerExists = buyerExistsCache.get(cacheKey);
          if (buyerExists === undefined) {
            buyerExists = await isKnownBuyer(mainClient, txBuyer);
            buyerExistsCache.set(cacheKey, buyerExists);
          }
          if (!buyerExists) {
            skippedNonBuyer += 1;
            continue;
          }
        }

        const fullCardNumber = normalizeDigits(normalized.card_number);
        const createdAtValue = tx.created_at instanceof Date ? tx.created_at.toISOString() : String(tx.created_at);
        const matchLine =
          `AMOUNT=${tx.amount};USD=${tx.amount_usd};bank=${tx.bank};ext_id=${tx.ext_id};created_at=${createdAtValue};google_ads_id=${googleAdsId};full_card_number=${fullCardNumber ?? 'null'};profile_name=${txProfileName ?? 'null'}`;
        console.error(matchLine);
        matchLogStream.write(`${matchLine}\n`);
        const outputRow = {
          ...tx, // 1) bank_transactions.* все поля транзакции
          google_ads_id: googleAdsId, // 2) google ads id
          full_card_number: fullCardNumber, // 3) отдельно полный номер карты
        };
        console.log(JSON.stringify(outputRow));
      }
    }

    console.error(
      `[DONE] scanned=${scanned} normalized=${normalizedOk} with_google_ads_id=${withGoogleAdsId} missing_in_funds=${missingInFunds}`,
    );
    console.error(
      `[DONE] skipped_unsupported_bank=${skippedUnsupportedBank} skipped_normalize_failed=${skippedNormalizeFailed} skipped_without_google_ads_id=${skippedWithoutGoogleAdsId} skipped_exists_in_funds=${skippedExistsInFunds} skipped_non_buyer=${skippedNonBuyer}`,
    );
    console.error(`[DONE] match_log_file=${MATCH_LOG_FILE}`);
  } finally {
    await new Promise<void>((resolve) => {
      matchLogStream.end(() => resolve());
    });
    mainClient.release();
    syncClient.release();
    await db.shutdown();
  }
}

void main().catch((err) => {
  console.error('Script failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
