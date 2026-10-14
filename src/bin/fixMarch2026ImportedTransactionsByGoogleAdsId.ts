import dotenv from 'dotenv';
import type { PoolClient } from 'pg';
import { getConfig } from '../config/index.js';
import { getDatabaseService } from '../infra/index.js';
import { getCurrentUserByProfileName } from '../infra/farmDb.js';
import { normalizeRawPayload } from '../modules/transactions/normalize.js';
import type { BankId } from '../modules/transactions/types.js';

dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local', override: true });

const SOURCE_CORRELATION_ID = 'script-import:bank-transactions:2026-03';
const FIXED_CORRELATION_ID = 'script-import:bank-transactions:2026-03:FIXED';
const SUPPORTED_BANKS: BankId[] = ['ecards', 'adscards', 'multicards', 'stellarcards'];

interface BankTxRow {
  bank: string;
  ext_id: string;
  raw: unknown;
  buyer: string | null;
  profile_name: string | null;
}

function extractGoogleAdsAccountId(merchantText: string | null): { digits: string; dashed: string } | null {
  if (!merchantText) return null;
  const upper = merchantText.toUpperCase();
  if (!upper.includes('GOOGLE')) return null;

  // Ищем 10-значный account_id в виде ADS2774064509 или просто 2774064509.
  const m = upper.match(/(?:ADS)?(\d{10})(?!\d)/);
  if (!m || !m[1]) return null;
  const digits = m[1];
  const dashed = `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
  return { digits, dashed };
}

async function resolveProfileNameByAccountId(syncClient: PoolClient, accountIdDigits: string, accountIdDashed: string): Promise<string | null> {
  const direct = await syncClient.query<{ profile_name: string | null }>(
    `SELECT profile_name
     FROM finance0_ext.funds_from_account
     WHERE account_id = $1
     LIMIT 1`,
    [accountIdDashed],
  );
  if (direct.rows[0]?.profile_name) return direct.rows[0].profile_name.trim();

  const byDigits = await syncClient.query<{ profile_name: string | null }>(
    `SELECT profile_name
     FROM finance0_ext.funds_from_account
     WHERE regexp_replace(account_id, '\\D', '', 'g') = $1
     LIMIT 1`,
    [accountIdDigits],
  );
  if (byDigits.rows[0]?.profile_name) return byDigits.rows[0].profile_name.trim();

  return null;
}

async function main(): Promise<void> {
  const config = getConfig();
  if (!config.syncDatabase) {
    throw new Error('syncDatabase is not configured. Required for finance0_ext.funds_from_account lookup.');
  }

  const db = getDatabaseService(config);
  const mainClient = await db.getClient('main');
  const farmClient = await db.getClient('farm');
  const syncClient = await db.getClient('sync');

  try {
    const rowsRes = await mainClient.query<BankTxRow>(
      `SELECT bank, ext_id, raw, buyer, profile_name
       FROM public.bank_transactions
       WHERE correlation_id = $1
       ORDER BY created_at`,
      [SOURCE_CORRELATION_ID],
    );

    let scanned = 0;
    let normalizedOk = 0;
    let googleFound = 0;
    let profileResolved = 0;
    let buyerResolved = 0;
    let updated = 0;

    for (const row of rowsRes.rows) {
      scanned += 1;
      if (!SUPPORTED_BANKS.includes(row.bank as BankId)) continue;

      const normalized = await normalizeRawPayload(mainClient, row.bank as BankId, row.raw);
      if (!normalized) continue;
      normalizedOk += 1;

      const accountId = extractGoogleAdsAccountId(normalized.merchant_description ?? null);
      if (!accountId) continue;
      googleFound += 1;

      const profileName = await resolveProfileNameByAccountId(syncClient, accountId.digits, accountId.dashed);
      if (!profileName) continue;
      profileResolved += 1;

      const owner = await getCurrentUserByProfileName(farmClient, profileName);
      if (!owner?.email) continue;
      buyerResolved += 1;

      await mainClient.query(
        `UPDATE public.bank_transactions
         SET buyer = $3,
             profile_name = $4,
             correlation_id = $5
         WHERE bank = $1
           AND ext_id = $2`,
        [row.bank, row.ext_id, owner.email, profileName, FIXED_CORRELATION_ID],
      );
      updated += 1;
    }

    console.log(
      `DONE: scanned=${scanned}, normalized=${normalizedOk}, google_found=${googleFound}, profile_resolved=${profileResolved}, buyer_resolved=${buyerResolved}, updated=${updated}`,
    );
  } finally {
    mainClient.release();
    farmClient.release();
    syncClient.release();
    await db.shutdown();
  }
}

void main().catch((err) => {
  console.error('Fix script failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

