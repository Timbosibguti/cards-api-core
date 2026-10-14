import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getConfig } from '../../config/index.js';
import { getDatabaseService, enqueueOutgoingNotification } from '../../infra/index.js';
import { createCorrelationId, createIncomingIdempotencyKey } from '../../infra/correlation/index.js';
import { logger } from '../../infra/logger.js';
import { ParserFactory } from '../statements_import/parsers/index.js';
import { getBuyerFromBinom } from '../binom/index.js';

export interface StatementImportJobRow {
  id: string;
  file_name: string;
  file_type: string | null;
  file_size: number | null;
  file_contents: Buffer;
}

export interface ImportedStatementTransaction {
  created_at: string;
  bank: string;
  ext_id: string;
  amount: number;
  currency: string;
  account_number?: string | null;
  aff_id?: number | null;
}

export interface StatementTransactionEnrichment {
  buyer: string | null;
  profile_name: string | null;
  matched_by: 'draft' | 'aff_id' | 'none';
  aff_id: number | null;
  draft_id: number | null;
}

function extractAffIdFromAmount(amount: number): number | null {
  if (amount >= 0) return null;
  const amountStr = Math.abs(amount).toFixed(2);
  const match = amountStr.match(/^(\d+)\.\d+$/);
  if (!match || !match[1]) return null;
  const fullNumber = match[1];
  const fullNumberInt = Number.parseInt(fullNumber, 10);
  if (Number.isNaN(fullNumberInt) || fullNumberInt <= 1000) return null;
  const rightmost3Str = fullNumber.slice(-3);
  const rightmost3Value = Number.parseInt(rightmost3Str, 10);
  let affIdStr: string;
  if (rightmost3Value < 300) {
    affIdStr = fullNumber.slice(-3);
  } else {
    affIdStr = fullNumber.slice(-2);
  }
  const affId = Number.parseInt(affIdStr, 10);
  if (!Number.isNaN(affId) && affId > 0) return affId;
  return null;
}

function resolveAffIdForEnrichment(tx: ImportedStatementTransaction): number | null {
  if (typeof tx.aff_id === 'number' && Number.isFinite(tx.aff_id)) {
    return tx.aff_id;
  }
  return extractAffIdFromAmount(tx.amount);
}

export async function parseStatementFile(
  fileName: string,
  contents: Buffer,
): Promise<ImportedStatementTransaction[]> {
  const name = fileName.toLowerCase();

  if (name.endsWith('.json')) {
    const text = contents.toString('utf8');
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed as ImportedStatementTransaction[];
    }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).transactions)) {
      return (parsed as any).transactions as ImportedStatementTransaction[];
    }
    throw new Error('Invalid JSON format for statements file: expected array or { transactions: [] }');
  }

  const result = await ParserFactory.parseFile(fileName, contents);
  if (result.errors?.length) {
    logger.warn('Statement parse warnings', { fileName, errors: result.errors });
  }
  if (result.transactions.length === 0) {
    const msg = result.errors?.length ? result.errors.join('; ') : 'No transactions parsed';
    throw new Error(msg);
  }

  return result.transactions.map((tx) => ({
    created_at: tx.created_at instanceof Date ? tx.created_at.toISOString() : String(tx.created_at),
    bank: tx.bank,
    ext_id: tx.ext_id,
    amount: tx.amount,
    currency: tx.currency,
    account_number: tx.account_number ?? null,
    aff_id: tx.aff_id ?? null,
  }));
}

async function insertStatementImportParsedRows(
  client: PoolClient,
  jobId: string,
  transactions: ImportedStatementTransaction[],
): Promise<void> {
  for (let i = 0; i < transactions.length; i++) {
    await client.query(
      `INSERT INTO public.statement_import_parsed_rows (
         job_id, row_index, parsed, bank_transactions_applied, bank_transactions_applied_at
       ) VALUES ($1, $2, $3::jsonb, false, NULL)
       ON CONFLICT (job_id, row_index) DO UPDATE SET
         parsed = EXCLUDED.parsed,
         enriched = NULL,
         bank_transactions_applied = false,
         bank_transactions_applied_at = NULL`,
      [jobId, i, JSON.stringify(transactions[i])],
    );
  }
}

async function enrichImportedTransaction(
  client: PoolClient,
  tx: ImportedStatementTransaction,
): Promise<StatementTransactionEnrichment> { const bank = tx.bank.toLowerCase(); const extId = tx.ext_id; const amount = tx.amount; const affIdResolved = resolveAffIdForEnrichment(tx);

  const LARGE_TRANSFER_THRESHOLD = 100000;
  if (Math.abs(amount) > LARGE_TRANSFER_THRESHOLD) {
    return {buyer: null, profile_name: null, matched_by: 'none', aff_id: affIdResolved, draft_id: null,};
  }

  let buyer: string | null = null;
  let profileName: string | null = null;
  let matchedBy: 'draft' | 'aff_id' | 'none' = 'none';
  let draftId: number | null = null;

  // Primary: matching with drafts (kind = bank_pre)
  try {
    const draftRes = await client.query<{ id: number; buyer_email: string | null; profile_name: string | null }>(
      `SELECT id, buyer_email, profile_name
       FROM public.drafts
       WHERE kind = 'bank_pre'
         AND status = 'pending'
         AND bank = $1
         AND transaction_id = $2
         AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [bank, extId],
    );

    if (draftRes.rows[0]) {
      const d = draftRes.rows[0];
      buyer = d.buyer_email;
      profileName = d.profile_name;
      matchedBy = 'draft';
      draftId = d.id;
      await client.query(
        `UPDATE public.drafts
         SET status = 'confirmed'
         WHERE id = $1
           AND kind = 'bank_pre'
           AND status = 'pending'`,
        [d.id],
      );
    }
  } catch (err) {
    logger.error('Failed to match draft for imported transaction', {
      bank,
      extId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Fallback: aff_id -> binom
  if (!buyer && affIdResolved) {
    try {
      const binomBuyer = await getBuyerFromBinom(client, affIdResolved);
      if (binomBuyer) {
        buyer = binomBuyer;
        matchedBy = 'aff_id';
      }
    } catch (err) {
      logger.error('Failed to resolve buyer via binom for imported transaction', {
        bank,
        extId,
        affId: affIdResolved,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    buyer,
    profile_name: profileName,
    matched_by: matchedBy,
    aff_id: affIdResolved,
    draft_id: draftId,
  };
}

async function updateStatementImportParsedRowEnriched(
  client: PoolClient,
  jobId: string,
  rowIndex: number,
  enriched: StatementTransactionEnrichment,
): Promise<void> {
  await client.query(
    `UPDATE public.statement_import_parsed_rows
     SET enriched = $3::jsonb
     WHERE job_id = $1 AND row_index = $2`,
    [jobId, rowIndex, JSON.stringify(enriched)],
  );
}

async function ensureBankAccountsForTransactions(
  client: PoolClient,
  transactions: ImportedStatementTransaction[],
): Promise<void> {
  const accountMap = new Map<string, { bank: string; acc_no: string }>();
  for (const tx of transactions) {
    const bank = tx.bank.toLowerCase();
    const accNo = tx.account_number ?? null;
    if (!accNo) continue;
    const key = `${bank}:${accNo}`;
    if (!accountMap.has(key)) accountMap.set(key, { bank, acc_no: accNo });
  }

  for (const { bank, acc_no } of accountMap.values()) {
    await client.query(
      `INSERT INTO public.bank_accounts (bank, acc_no, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (bank, acc_no) DO NOTHING`,
      [bank, acc_no, acc_no],
    );
  }
}

/** Отдельный шаг очереди: INSERT bank_transactions + audit + bank_transactions_applied (аналог «воркер увидел запись в очереди»). */
async function applyStatementImportParsedRowToBankTransactions(
  client: PoolClient,
  jobId: string,
  rowIndex: number,
  tx: ImportedStatementTransaction,
  enrichment: StatementTransactionEnrichment,
): Promise<void> {
  const bank = tx.bank.toLowerCase();
  const createdAt = new Date(tx.created_at);
  const extId = tx.ext_id;
  const amount = tx.amount;
  const currency = tx.currency || 'USD';
  const accNo = tx.account_number ?? null;
  const { buyer, profile_name, matched_by: matchedBy } = enrichment;
  const correlationId = createCorrelationId();
  const idempotencyKey = createIncomingIdempotencyKey(bank, accNo ?? '', extId);

  const raw = {
    created_at: tx.created_at,
    bank: tx.bank,
    ext_id: tx.ext_id,
    amount: tx.amount,
    currency: tx.currency,
    account_number: tx.account_number,
    aff_id: tx.aff_id ?? null,
    aff_id_enriched: enrichment.aff_id,
    buyer,
    profile_name,
    matched_by: matchedBy,
    draft_id: enrichment.draft_id,
    source: 'file_import',
    job_id: jobId,
  };


  await client.query(
    `INSERT INTO public.bank_transactions (
       ext_id, created_at, bank, amount, currency, acc_no, raw,
       buyer, profile_name, idempotency_key, correlation_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
     ON CONFLICT (bank, ext_id) DO UPDATE SET
       created_at = EXCLUDED.created_at,
       amount = EXCLUDED.amount,
       currency = EXCLUDED.currency,
       acc_no = COALESCE(EXCLUDED.acc_no, bank_transactions.acc_no),
       raw = EXCLUDED.raw,
       buyer = COALESCE(EXCLUDED.buyer, bank_transactions.buyer),
       profile_name = COALESCE(EXCLUDED.profile_name, bank_transactions.profile_name),
       idempotency_key = EXCLUDED.idempotency_key,
       correlation_id = EXCLUDED.correlation_id`,
    [
      extId,
      createdAt,
      bank,
      amount,
      currency,
      accNo,
      JSON.stringify(raw),
      buyer,
      profile_name,
      idempotencyKey,
      correlationId,
    ],
  );

  const nowIso = new Date().toISOString();
  const auditEventType =
    matchedBy === 'draft'
      ? 'bank_transaction_confirmed'
      : matchedBy === 'aff_id'
        ? 'bank_transaction_fallback_matched'
        : 'bank_transaction_imported';

  const auditPayload = {
    id: randomUUID(),
    timestamp: nowIso,
    division: 'finance' as const,
    user_email: buyer ?? 'system@groscloud.com',
    log_type: 'info' as const,
    severity: 3,
    event_type: auditEventType,
    event_attributes: {
      ext_id: extId,
      bank,
      amount,
      currency,
      acc_no: accNo,
      profile_name,
      aff_id: enrichment.aff_id,
      draft_id: enrichment.draft_id,
      source: 'file_import',
      matched_by: matchedBy,
      job_id: jobId,
    },
    correlation_id: correlationId,
  };

  const dedupKey = `audit:statement_import:${bank}:${extId}:${jobId}`;
  await enqueueOutgoingNotification(client, {
    channel: 'mqtt:sequoia/audit',
    payload: auditPayload,
    dedupKey,
    correlationId,
  });

  await client.query(
    `UPDATE public.statement_import_parsed_rows
     SET bank_transactions_applied = true, bank_transactions_applied_at = NOW()
     WHERE job_id = $1 AND row_index = $2`,
    [jobId, rowIndex],
  );
}

/**
 * Старое поведение (полный inline-путь, не удалять): в той же транзакции что и job — обогащение, bank_transactions, audit, флаг applied.
 * Сейчас из processImportedTransactionsForJob не вызывается.
 */
export async function processImportedTransactionsForJobLegacy(
  client: PoolClient,
  job: StatementImportJobRow,
  transactions: ImportedStatementTransaction[],
): Promise<void> {
  await ensureBankAccountsForTransactions(client, transactions);

  const nowIso = new Date().toISOString();

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    const bank = tx.bank.toLowerCase();
    const createdAt = new Date(tx.created_at);
    const extId = tx.ext_id;
    const amount = tx.amount;
    const currency = tx.currency || 'USD';
    const accNo = tx.account_number ?? null;

    const enrichment = await enrichImportedTransaction(client, tx);
    await updateStatementImportParsedRowEnriched(client, job.id, i, enrichment);

    const { buyer, profile_name, matched_by: matchedBy } = enrichment;

    const correlationId = createCorrelationId();
    const idempotencyKey = createIncomingIdempotencyKey(bank, accNo ?? '', extId);

    const raw = {
      created_at: tx.created_at,
      bank: tx.bank,
      ext_id: tx.ext_id,
      amount: tx.amount,
      currency: tx.currency,
      account_number: tx.account_number,
      aff_id: tx.aff_id ?? null,
      aff_id_enriched: enrichment.aff_id,
      buyer,
      profile_name,
      matched_by: matchedBy,
      draft_id: enrichment.draft_id,
      source: 'file_import',
      job_id: job.id,
    };

    // Upsert into bank_transactions (is_postpay не пишем — колонки может не быть в старых БД)
    await client.query(
      `INSERT INTO public.bank_transactions (
         ext_id, created_at, bank, amount, currency, acc_no, raw,
         buyer, profile_name, idempotency_key, correlation_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
       ON CONFLICT (bank, ext_id) DO UPDATE SET
         created_at = EXCLUDED.created_at,
         amount = EXCLUDED.amount,
         currency = EXCLUDED.currency,
         acc_no = COALESCE(EXCLUDED.acc_no, bank_transactions.acc_no),
         raw = EXCLUDED.raw,
         buyer = COALESCE(EXCLUDED.buyer, bank_transactions.buyer),
         profile_name = COALESCE(EXCLUDED.profile_name, bank_transactions.profile_name),
         idempotency_key = EXCLUDED.idempotency_key,
         correlation_id = EXCLUDED.correlation_id`,
      [
        extId,
        createdAt,
        bank,
        amount,
        currency,
        accNo,
        JSON.stringify(raw),
        buyer,
        profile_name,
        idempotencyKey,
        correlationId,
      ],
    );

    // Audit via outgoing_notifications
    const auditEventType =
      matchedBy === 'draft'
        ? 'bank_transaction_confirmed'
        : matchedBy === 'aff_id'
          ? 'bank_transaction_fallback_matched'
          : 'bank_transaction_imported';

    const auditPayload = {
      id: randomUUID(),
      timestamp: nowIso,
      division: 'finance' as const,
      user_email: buyer ?? 'system@groscloud.com',
      log_type: 'info' as const,
      severity: 3,
      event_type: auditEventType,
      event_attributes: {
        ext_id: extId,
        bank,
        amount,
        currency,
        acc_no: accNo,
        profile_name,
        aff_id: enrichment.aff_id,
        draft_id: enrichment.draft_id,
        source: 'file_import',
        matched_by: matchedBy,
        job_id: job.id,
      },
      correlation_id: correlationId,
    };

    const dedupKey = `audit:statement_import:${bank}:${extId}:${job.id}`;
    await enqueueOutgoingNotification(client, {
      channel: 'mqtt:sequoia/audit',
      payload: auditPayload,
      dedupKey,
      correlationId,
    });

    await client.query(
      `UPDATE public.statement_import_parsed_rows
       SET bank_transactions_applied = true, bank_transactions_applied_at = NOW()
       WHERE job_id = $1 AND row_index = $2`,
      [job.id, i],
    );
  }
}

/** Staging только: bank_accounts + обогащение + enriched; bank_transactions пишет воркер. */
async function processImportedTransactionsForJobStageOnly(
  client: PoolClient,
  job: StatementImportJobRow,
  transactions: ImportedStatementTransaction[],
): Promise<void> {
  await ensureBankAccountsForTransactions(client, transactions);

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    const enrichment = await enrichImportedTransaction(client, tx);
    await updateStatementImportParsedRowEnriched(client, job.id, i, enrichment);
  }
}

export async function processImportedTransactionsForJob(
  client: PoolClient,
  job: StatementImportJobRow,
  transactions: ImportedStatementTransaction[],
): Promise<void> {
  await processImportedTransactionsForJobStageOnly(client, job, transactions);
}

/** Одна строка очереди statement_import_parsed_rows → bank_transactions (режим без SYNC). */
export async function processOneStatementImportBankTransactionRow(): Promise<boolean> {
  const config = getConfig();
  const db = getDatabaseService(config);
  let did = false;
  await db.withTransaction('main', async (client) => {
    const res = await client.query<{
      job_id: string;
      row_index: number;
      parsed: ImportedStatementTransaction;
      enriched: StatementTransactionEnrichment;
    }>(
      `SELECT pr.job_id, pr.row_index, pr.parsed, pr.enriched
       FROM public.statement_import_parsed_rows pr
       WHERE pr.bank_transactions_applied = false
         AND pr.enriched IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM public.statement_import_jobs j
           WHERE j.id = pr.job_id AND j.status = 'processed'
         )
       ORDER BY pr.created_at
       LIMIT 1
       FOR UPDATE OF pr SKIP LOCKED`,
    );
    if (!res.rows[0]) {
      return;
    }
    did = true;
    const row = res.rows[0];
    await applyStatementImportParsedRowToBankTransactions(
      client,
      row.job_id,
      row.row_index,
      row.parsed,
      row.enriched,
    );
  });
  return did;
}

export async function processSingleStatementJob(jobId: string): Promise<void> {
  const config = getConfig();
  const db = getDatabaseService(config);

  await db.withTransaction('main', async (client) => {
    const res = await client.query<StatementImportJobRow>(
      `SELECT id, file_name, file_type, file_size, file_contents
       FROM public.statement_import_jobs
       WHERE id = $1
         AND status = 'processing'
       FOR UPDATE`,
      [jobId],
    );

    if (!res.rows[0]) {
      return;
    }

    const job = res.rows[0];

    try {
      const transactions = await parseStatementFile(job.file_name, job.file_contents);
      await insertStatementImportParsedRows(client, job.id, transactions);
      await processImportedTransactionsForJob(client, job, transactions);

      await client.query(
        `UPDATE public.statement_import_jobs
         SET status = 'processed', finished_at = NOW(), error = NULL
         WHERE id = $1`,
        [job.id],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to process statement import job', { jobId: job.id, error: msg });
      await client.query(
        `UPDATE public.statement_import_jobs
         SET status = 'failed', finished_at = NOW(), error = $2
         WHERE id = $1`,
        [job.id, msg.slice(0, 1000)],
      );
    }
  });
}

