import dotenv from 'dotenv';
import type { PoolClient } from 'pg';
import { getConfig } from '../config/index.js';
import { getDatabaseService, getPaymentHttpClient } from '../infra/index.js';
import { getCurrentUserByProfileName } from '../infra/farmDb.js';
import { logger } from '../infra/logger.js';
import type { BankId } from '../modules/transactions/types.js';
import {
  normalizeRawPayload,
  type NormalizedTransaction,
} from '../modules/transactions/normalize.js';
import { getTransactionsAdapter } from '../modules/transactions/adapters/index.js';
import {
  ensureMulticardsToken,
  loadMulticardsMediabuyerEmails,
} from '../modules/transactions/adapters/multicards/transactions.js';

dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local', override: true });

const BANKS: BankId[] = ['ecards', 'adscards', 'multicards', 'stellarcards'];
const START_AT = new Date('2026-03-01T00:00:00.000Z');
const END_AT = new Date('2026-03-29T23:59:59.999Z');
const IMPORT_CORRELATION_ID = 'script-import:bank-transactions:2026-03';

interface ImportStats {
  fetched: number;
  normalized: number;
  inRange: number;
  inserted: number;
  skippedExistingExtId: number;
  skippedInvalid: number;
  skippedNoOccurredAt: number;
  /** Самая «младшая» (минимальная) дата occurred_at среди обработанных в диапазоне транзакций. */
  oldestOccurredAt?: Date | null;
}

function toIsoNoZ(date: Date): string {
  return date.toISOString().slice(0, 19).replace('Z', '');
}

function isInRange(date: Date): boolean {
  const ts = date.getTime();
  return ts >= START_AT.getTime() && ts <= END_AT.getTime();
}

function parseOccurredAt(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function cardDigits(cardNumber: string | null): string | null {
  if (!cardNumber) return null;
  const digits = cardNumber.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

async function resolveIsPostpayViaBankCards(
  client: PoolClient,
  normalized: NormalizedTransaction,
): Promise<boolean> {
  const digits = cardDigits(normalized.card_number);
  if (!digits) return false;
  const res = await client.query<{ is_postpay: boolean }>(
    `SELECT (profile_name IS NOT NULL) AS is_postpay
     FROM public.bank_cards
     WHERE bank = $1
       AND card_number = $2::bigint
     ORDER BY created_at DESC NULLS LAST
     LIMIT 1`,
    [normalized.bank, digits],
  );
  return Boolean(res.rows[0]?.is_postpay);
}

async function resolveOwnerViaBankCards(
  mainClient: PoolClient,
  normalized: NormalizedTransaction,
): Promise<{ buyer: string | null; profileName: string | null }> {
  const digits = cardDigits(normalized.card_number);
  if (!digits) return { buyer: null, profileName: null };

  if (digits.length >= 12) {
    const exact = await mainClient.query<{ buyer: string | null; profile_name: string | null }>(
      `SELECT buyer, profile_name
       FROM public.bank_cards
       WHERE bank = $1 AND card_number = $2::bigint
       ORDER BY created_at DESC NULLS LAST
       LIMIT 1`,
      [normalized.bank, digits],
    );
    if (exact.rows[0]) {
      return {
        buyer: exact.rows[0].buyer ?? null,
        profileName: exact.rows[0].profile_name ?? null,
      };
    }
  } else {
    const last4 = digits.slice(-4);
    const fallback = await mainClient.query<{ buyer: string | null; profile_name: string | null }>(
      `SELECT buyer, profile_name
       FROM public.bank_cards
       WHERE right(card_number::text, 4) = $1
       ORDER BY created_at DESC NULLS LAST
       LIMIT 1`,
      [last4],
    );
    if (fallback.rows[0]) {
      return {
        buyer: fallback.rows[0].buyer ?? null,
        profileName: fallback.rows[0].profile_name ?? null,
      };
    }
  }

  return { buyer: null, profileName: null };
}

async function resolveOwnerViaBankCardsHistory(
  mainClient: PoolClient,
  normalized: NormalizedTransaction,
  occurredAt: Date,
): Promise<{ buyer: string | null; profileName: string | null }> {
  const digits = cardDigits(normalized.card_number);
  if (!digits || digits.length < 12) {
    return { buyer: null, profileName: null };
  }

  const res = await mainClient.query<{ buyer_email: string | null; profile_name: string | null }>(
    `SELECT buyer_email, profile_name
     FROM public.bank_cards_history
     WHERE card_number = $1::bigint
       AND valid_from <= $2::timestamptz
       AND (valid_to IS NULL OR valid_to > $2::timestamptz)
     ORDER BY valid_from DESC
     LIMIT 1`,
    [digits, occurredAt.toISOString()],
  );

  if (!res.rows[0]) return { buyer: null, profileName: null };
  return {
    buyer: res.rows[0].buyer_email ?? null,
    profileName: res.rows[0].profile_name ?? null,
  };
}

async function resolveOwnerViaBankCardsShown(
  mainClient: PoolClient,
  farmClient: PoolClient,
  normalized: NormalizedTransaction,
  occurredAt: Date,
): Promise<{ buyer: string | null; profileName: string | null }> {
  const digits = cardDigits(normalized.card_number);
  if (!digits || digits.length < 12) {
    return { buyer: null, profileName: null };
  }

  const shown = await mainClient.query<{ profile_name: string | null }>(
    `SELECT profile_name
     FROM public.bank_cards_shown
     WHERE card_number = $1::bigint
       AND created_at <= $2::timestamptz
     ORDER BY created_at DESC
     LIMIT 20`,
    [digits, occurredAt.toISOString()],
  );

  for (const row of shown.rows) {
    const profileName = row.profile_name?.trim() ?? null;
    if (!profileName) continue;
    const current = await getCurrentUserByProfileName(farmClient, profileName);
    if (current?.email) {
      return { buyer: current.email, profileName };
    }
  }

  return { buyer: null, profileName: null };
}

async function resolveOwner(
  mainClient: PoolClient,
  farmClient: PoolClient,
  normalized: NormalizedTransaction,
  occurredAt: Date,
): Promise<{ buyer: string | null; profileName: string | null }> {
  const adapter = getTransactionsAdapter(normalized.bank as BankId);
  if (adapter?.resolveOwner) {
    const owner = await adapter.resolveOwner(mainClient, normalized);
    if (owner.buyer || owner.profileName) {
      return owner;
    }
  }

  const fromHistory = await resolveOwnerViaBankCardsHistory(mainClient, normalized, occurredAt);
  if (fromHistory.buyer || fromHistory.profileName) return fromHistory;

  const fromCards = await resolveOwnerViaBankCards(mainClient, normalized);
  if (fromCards.buyer || fromCards.profileName) return fromCards;

  return resolveOwnerViaBankCardsShown(mainClient, farmClient, normalized, occurredAt);
}

async function fetchEcardsPage(offset: number, limit: number): Promise<unknown[]> {
  const config = getConfig();
  const http = getPaymentHttpClient(config);
  const page = await http.request<{ data?: { content?: unknown[] } }>({
    bank: 'ecards',
    method: 'GET',
    path: '/card-operation',
    query: {
      offset,
      limit,
      sortBy: 'id',
      sortDirection: 'desc',
    },
  });
  const items = page.data?.content ?? [];
  return Array.isArray(items) ? items : [];
}

async function fetchAdscardsAllForMonth(): Promise<unknown[]> {
  const config = getConfig();
  const http = getPaymentHttpClient(config);
  const authToken = config.providers.adscards?.authTokenForBody;
  if (!authToken) {
    throw new Error('ADSCARD_AUTH_TOKEN is required for adscards import');
  }
  const period = '2026-03-01|2026-03-31';

  const response = await http.request<{ data?: unknown }>({
    bank: 'adscards',
    method: 'POST',
    path: '/teams/cards_transactions',
    body: {
      auth_token: authToken,
      time: 'period',
      period,
    },
  });

  const data = response.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return Object.values(data as Record<string, unknown>);
  return [];
}

async function fetchMulticardsPage(
  accessToken: string,
  emails: string[],
  offset: number,
  limit: number,
): Promise<{ items: unknown[]; total: number }> {
  const config = getConfig();
  const http = getPaymentHttpClient(config);
  const periodStart = Math.floor(START_AT.getTime() / 1000);
  const periodEnd = Math.floor(END_AT.getTime() / 1000);

  const page = await http.request<{ items?: unknown[]; total?: number }>({
    bank: 'multicards',
    method: 'POST',
    path: '/v1/transaction/pageable',
    headers: {
      'x-auth-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: {
      textQuery: '',
      periodStart,
      periodEnd,
      userEmails: emails,
      cardIds: [],
      cardGroupIds: [],
      receiptIds: [],
      currencies: [],
      types: [],
      statuses: [],
      sort: [],
      limit,
      offset,
    },
  });

  const items = Array.isArray(page.items) ? page.items : [];
  const total = typeof page.total === 'number' ? page.total : offset + items.length;
  return { items, total };
}

async function fetchStellarcardsPage(startIndex: number, limit: number): Promise<{
  items: unknown[];
  hasMore: boolean;
  nextIndex: number;
}> {
  const config = getConfig();
  const http = getPaymentHttpClient(config);

  const page = await http.request<{
    data?: unknown[];
    has_more?: boolean;
    end_index?: number;
  }>({
    bank: 'stellarcards',
    method: 'GET',
    path: '/v1/transactions',
    query: {
      datetime_from: toIsoNoZ(START_AT),
      datetime_to: toIsoNoZ(END_AT),
      limit,
      start_index: startIndex,
    },
  });

  const items = Array.isArray(page.data) ? page.data : [];
  const hasMore = Boolean(page.has_more);
  const nextIndex = (typeof page.end_index === 'number' ? page.end_index : startIndex) + 1;
  return { items, hasMore, nextIndex };
}

async function processSinglePayload(
  bank: BankId,
  payload: unknown,
  mainClient: PoolClient,
  farmClient: PoolClient,
  stats: ImportStats,
  options?: { stopWhenBeforeStart?: boolean },
): Promise<boolean> {
  let normalized: NormalizedTransaction | null = null;
  try {
    normalized = await normalizeRawPayload(mainClient, bank, payload);
  } catch (err) {
    logger.warn('Import script: normalize failed', {
      bank,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!normalized || !normalized.ext_id) {
    stats.skippedInvalid += 1;
    return false;
  }
  stats.normalized += 1;

  const occurredAt = parseOccurredAt(normalized.occurred_at);
  if (!occurredAt) {
    stats.skippedNoOccurredAt += 1;
    return false;
  }
  stats.oldestOccurredAt = occurredAt;

  if (!isInRange(occurredAt)) {
    console.log('not in range', occurredAt);
    if (options?.stopWhenBeforeStart && occurredAt.getTime() < START_AT.getTime()) {
      // для ecards можно завершить импорт, когда дошли до более ранней даты
      return true;
    }
    return false;
  }
  stats.inRange += 1;

  const existingAny = await mainClient.query<{ bank: string }>(
    `SELECT bank
     FROM public.bank_transactions
     WHERE ext_id = $1
     LIMIT 1`,
    [normalized.ext_id],
  );
  if ((existingAny.rowCount ?? 0) > 0) {
    stats.skippedExistingExtId += 1;
    console.log('skip existing', normalized.ext_id);
    return false;
  }

  const owner = await resolveOwner(mainClient, farmClient, normalized, occurredAt);
  const isPostpay = await resolveIsPostpayViaBankCards(mainClient, normalized);
  const raw = {
    ...(typeof normalized.raw === 'object' && normalized.raw !== null
      ? (normalized.raw as Record<string, unknown>)
      : { payload: normalized.raw }),
    _import: {
      source: 'manual_script_march_2026',
      imported_at: new Date().toISOString(),
    },
  };

  await mainClient.query(
    `INSERT INTO public.bank_transactions (
       ext_id, created_at, bank, amount, currency, acc_no, raw,
       buyer, profile_name, idempotency_key, correlation_id, is_postpay
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
     ON CONFLICT (bank, ext_id) DO NOTHING`,
    [
      normalized.ext_id,
      occurredAt,
      normalized.bank,
      normalized.amount,
      normalized.currency,
      normalized.acc_no,
      JSON.stringify(raw),
      owner.buyer,
      owner.profileName,
      `script-import:${bank}:${normalized.ext_id}`,
      IMPORT_CORRELATION_ID,
      isPostpay,
    ],
  );

  stats.inserted += 1;
  return false;
}

async function runBankImport(
  bank: BankId,
  mainClient: PoolClient,
  farmClient: PoolClient,
): Promise<ImportStats> {
  const stats: ImportStats = {
    fetched: 0,
    normalized: 0,
    inRange: 0,
    inserted: 0,
    skippedExistingExtId: 0,
    skippedInvalid: 0,
    skippedNoOccurredAt: 0,
  };

  const pageLimit = 100;

  if (bank === 'adscards') {
    const payloads = await fetchAdscardsAllForMonth();
    stats.fetched = payloads.length;
    for (const payload of payloads) {
      await processSinglePayload(bank, payload, mainClient, farmClient, stats);
    }
    return stats;
  }

  if (bank === 'ecards') {
    let offset = 24800;
    while (true) {
      const payloads = await fetchEcardsPage(offset, pageLimit);
      if (payloads.length === 0) break;
      stats.fetched += payloads.length;
      for (const payload of payloads) {
        const stop = await processSinglePayload(
          bank,
          payload,
          mainClient,
          farmClient,
          stats,
          { stopWhenBeforeStart: true },
        );
        if (stop) return stats;
      }
      console.log('######################################################################');
      console.log(
        `[${bank}] page at offset=${offset}, fetched_total=${stats.fetched}, inserted_total=${stats.inserted}, oldest_occurred_at=${stats.oldestOccurredAt ? stats.oldestOccurredAt.toISOString() : 'n/a'}`,
      );
      if (payloads.length < pageLimit) break;
      offset += pageLimit;
    }
    return stats;
  }

  if (bank === 'multicards') {
    const config = getConfig();
    const http = getPaymentHttpClient(config);
    const accessToken = await ensureMulticardsToken(config, http);
    const emails = await loadMulticardsMediabuyerEmails(config, http, accessToken);

    let offset = 0;
    while (true) {
      const { items, total } = await fetchMulticardsPage(accessToken, emails, offset, pageLimit);
      if (items.length === 0) break;
      stats.fetched += items.length;
      for (const payload of items) {
        await processSinglePayload(bank, payload, mainClient, farmClient, stats);
      }
      console.log('######################################################################');
      console.log(
        `[${bank}] page at offset=${offset}, fetched_total=${stats.fetched}, inserted_total=${stats.inserted}, oldest_occurred_at=${stats.oldestOccurredAt ? stats.oldestOccurredAt.toISOString() : 'n/a'}`,
      );
      if (offset + pageLimit >= total) break;
      offset += pageLimit;
    }
    return stats;
  }

  if (bank === 'stellarcards') {
    let startIndex = 0;
    while (true) {
      const { items, hasMore, nextIndex } = await fetchStellarcardsPage(startIndex, pageLimit);
      if (items.length === 0) break;
      stats.fetched += items.length;
      for (const payload of items) {
        await processSinglePayload(bank, payload, mainClient, farmClient, stats);
      }
      console.log('######################################################################');
      console.log(
        `[${bank}] page at start_index=${startIndex}, fetched_total=${stats.fetched}, inserted_total=${stats.inserted}, oldest_occurred_at=${stats.oldestOccurredAt ? stats.oldestOccurredAt.toISOString() : 'n/a'}`,
      );
      if (!hasMore) break;
      startIndex = nextIndex;
    }
    return stats;
  }

  return stats;
}

async function main(): Promise<void> {
  const config = getConfig();
  const db = getDatabaseService(config);
  const mainClient = await db.getClient('main');
  const farmClient = await db.getClient('farm');

  // Предотвращаем падение процесса из‑за необработанных ошибок pg-клиента (например, 57P01).
  mainClient.on('error', (err) => {
    console.error('[import] main DB client error:', err?.message ?? String(err));
  });
  farmClient.on('error', (err) => {
    console.error('[import] farm DB client error:', err?.message ?? String(err));
  });
  try {
    const bankArg = process.argv[2] as string | undefined;
    const banksToProcess: BankId[] =
      bankArg && (BANKS as string[]).includes(bankArg)
        ? [bankArg as BankId]
        : BANKS;

    if (bankArg && banksToProcess.length === 1) {
      console.log(`Bank filter is set, processing only bank=${bankArg}`);
    }

    console.log(`Starting import for range ${START_AT.toISOString()} .. ${END_AT.toISOString()}`);
    console.log(`correlation_id flag: ${IMPORT_CORRELATION_ID}`);

    const totals: ImportStats = {
      fetched: 0,
      normalized: 0,
      inRange: 0,
      inserted: 0,
      skippedExistingExtId: 0,
      skippedInvalid: 0,
      skippedNoOccurredAt: 0,
    };

    for (const bank of banksToProcess) {
      try {
        console.log(`\n=== Importing bank=${bank} ===`);
        const stats = await runBankImport(bank, mainClient, farmClient);
        totals.fetched += stats.fetched;
        totals.normalized += stats.normalized;
        totals.inRange += stats.inRange;
        totals.inserted += stats.inserted;
        totals.skippedExistingExtId += stats.skippedExistingExtId;
        totals.skippedInvalid += stats.skippedInvalid;
        totals.skippedNoOccurredAt += stats.skippedNoOccurredAt;
        console.log(
          `${bank}: fetched=${stats.fetched}, normalized=${stats.normalized}, inRange=${stats.inRange}, inserted=${stats.inserted}, skippedExistingExtId=${stats.skippedExistingExtId}, skippedInvalid=${stats.skippedInvalid}, skippedNoOccurredAt=${stats.skippedNoOccurredAt}`,
        );
      } catch (err) {
        const e = err as Error;
        console.error(
          `[import] bank=${bank} failed: ${e.message}`,
        );
      }
    }

    console.log(
      `TOTAL: fetched=${totals.fetched}, normalized=${totals.normalized}, inRange=${totals.inRange}, inserted=${totals.inserted}, skippedExistingExtId=${totals.skippedExistingExtId}, skippedInvalid=${totals.skippedInvalid}, skippedNoOccurredAt=${totals.skippedNoOccurredAt}`,
    );
  } finally {
    mainClient.release();
    farmClient.release();
    await db.shutdown();
  }
}

void main().catch((err) => {
  const e = err as Error;
  console.error(
    'Import failed:',
    e && e.message ? e.message : String(err),
  );
  process.exitCode = 1;
});
