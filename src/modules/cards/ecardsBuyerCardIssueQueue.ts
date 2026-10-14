import { randomUUID } from 'node:crypto';
import type { TransactionClient } from '../../infra/index.js';
import {
  formatMulticardsAccNoFromBinom,
  getAffIdFromBinomByBuyer,
  getBinomByAffId,
} from '../binom/index.js';

export type EcardsBuyerCardIssueQueueStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type ClaimBuyerQueueSlotResult =
  | { kind: 'claimed'; queueId: number; buyerEmail: string; affId: number; groupName: string }
  | { kind: 'none' }
  | { kind: 'binom_failed'; queueId: number };

function truncateQueueErr(msg: string, max = 4000): string {
  return msg.length <= max ? msg : `${msg.slice(0, max)}…`;
}

/**
 * Берёт одну строку очереди по BIN: pending → processing.
 * Если buyer_email нет в binom — строка сразу failed, слот не отдаётся для PATCH.
 */
export async function claimEcardsBuyerQueueSlotForBin(
  client: TransactionClient,
  bin6: number,
): Promise<ClaimBuyerQueueSlotResult> {
  const claim = await client.query<{ id: string; buyer_email: string }>(
    `WITH c AS (
       SELECT id
       FROM public.ecards_buyer_card_issue_queue
       WHERE bank = 'ecards' AND bin = $1 AND status = 'pending'
       ORDER BY id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE public.ecards_buyer_card_issue_queue q
     SET status = 'processing',
         updated_at = NOW()
     FROM c
     WHERE q.id = c.id
     RETURNING q.id, q.buyer_email`,
    [bin6],
  );
  if (claim.rows.length === 0) {
    return { kind: 'none' };
  }
  const row = claim.rows[0];
  const queueId = Number(row.id);
  const affId = await getAffIdFromBinomByBuyer(client, row.buyer_email);
  if (affId == null) {
    await client.query(
      `UPDATE public.ecards_buyer_card_issue_queue
       SET status = 'failed', error = $1, updated_at = NOW()
       WHERE id = $2`,
      [truncateQueueErr(`buyer_email not found in binom: ${row.buyer_email}`), queueId],
    );
    return { kind: 'binom_failed', queueId };
  }
  const binomRow = await getBinomByAffId(client, affId);
  const groupName = formatMulticardsAccNoFromBinom(binomRow, affId);
  return {
    kind: 'claimed',
    queueId,
    buyerEmail: row.buyer_email.trim(),
    affId,
    groupName,
  };
}

export async function completeEcardsBuyerQueueRow(
  client: TransactionClient,
  queueId: number,
): Promise<void> {
  await client.query(
    `UPDATE public.ecards_buyer_card_issue_queue
     SET status = 'completed',
         error = NULL,
         updated_at = NOW()
     WHERE id = $1 AND status = 'processing'`,
    [queueId],
  );
}

export async function failEcardsBuyerQueueRow(
  client: TransactionClient,
  queueId: number,
  errorMessage: string,
): Promise<void> {
  await client.query(
    `UPDATE public.ecards_buyer_card_issue_queue
     SET status = 'failed',
         error = $1,
         updated_at = NOW()
     WHERE id = $2 AND status = 'processing'`,
    [truncateQueueErr(errorMessage), queueId],
  );
}

export interface InsertEcardsBuyerCardIssueQueueParams {
  buyerEmail: string;
  bin: number;
  quantity: number;
  requestedByEmail: string | null;
}

export interface InsertEcardsBuyerCardIssueQueueResult {
  ids: number[];
  requestBatchId: string;
}

/** Вставляет quantity строк (по одной на карту) с общим request_batch_id. */
export async function insertEcardsBuyerCardIssueQueue(
  client: TransactionClient,
  params: InsertEcardsBuyerCardIssueQueueParams,
): Promise<InsertEcardsBuyerCardIssueQueueResult> {
  const buyer = params.buyerEmail.trim();
  const qty = Math.max(1, Math.floor(params.quantity));
  const requestBatchId = randomUUID();
  const requestedBy = params.requestedByEmail?.trim() || null;
  const ids: number[] = [];
  for (let i = 0; i < qty; i++) {
    const res = await client.query<{ id: string }>(
      `INSERT INTO public.ecards_buyer_card_issue_queue
         (buyer_email, bank, bin, status, requested_by_email, request_batch_id)
       VALUES ($1, 'ecards', $2, 'pending', $3, $4::uuid)
       RETURNING id`,
      [buyer, params.bin, requestedBy, requestBatchId],
    );
    const id = res.rows[0]?.id;
    if (id == null) {
      throw new Error('ecards_buyer_card_issue_queue: INSERT returned no id');
    }
    ids.push(Number(id));
  }
  return { ids, requestBatchId };
}
