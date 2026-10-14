import type { TransactionClient } from '../../infra/index.js';
import { logger } from '../../infra/logger.js';

export async function getAffIdFromBinomByBuyer(client: TransactionClient, buyerEmail: string): Promise<number | null> {
  const trimmed = buyerEmail.trim();
  if (!trimmed) return null;
  try {
    const result = await client.query<{ aff_id: number }>(
      'SELECT aff_id FROM public.binom WHERE buyer IS NOT NULL AND lower(trim(buyer)) = lower($1) LIMIT 1',
      [trimmed],
    );
    const id = result.rows[0]?.aff_id;
    return id != null && Number.isFinite(Number(id)) ? Number(id) : null;
  } catch (err) {
    logger.error('Failed to get aff_id from binom by buyer', {
      buyerEmail: trimmed,
      error:
        err instanceof Error
          ? { message: err.message, stack: err.stack, name: err.name }
          : String(err),
    });
    return null;
  }
}

export async function getBuyerFromBinom(client: TransactionClient, affId: number): Promise<string | null> {
  try {
    const result = await client.query<{ buyer: string | null }>(
      'SELECT buyer FROM public.binom WHERE aff_id = $1 LIMIT 1',
      [affId],
    );

    if (!result.rows.length) {
      return null;
    }

    const buyer = result.rows[0].buyer;
    if (buyer && !buyer.toLowerCase().includes('not found')) {
      return buyer;
    }

    return null;
  } catch (err) {
    logger.error('Failed to get buyer from binom', {
      affId,
      error:
        err instanceof Error
          ? { message: err.message, stack: err.stack, name: err.name }
          : String(err),
    });
    return null;
  }
}

export interface BinomRowByAffId {
  buyer: string | null;
  username: string | null;
  aff_id: number;
}

export async function getBinomByAffId(
  client: TransactionClient,
  affId: number,
): Promise<BinomRowByAffId | null> {
  try {
    const result = await client.query<{ buyer: string | null; username: string | null; aff_id: number }>(
      'SELECT buyer, username, aff_id FROM public.binom WHERE aff_id = $1 LIMIT 1',
      [affId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const id = row.aff_id;
    if (id == null || !Number.isFinite(Number(id))) return null;
    return {
      buyer: row.buyer,
      username: row.username,
      aff_id: Number(id),
    };
  } catch (err) {
    logger.error('Failed to get binom row by aff_id', {
      affId,
      error:
        err instanceof Error
          ? { message: err.message, stack: err.stack, name: err.name }
          : String(err),
    });
    return null;
  }
}

export function buyerEmailFromBinomRow(row: BinomRowByAffId | null): string | null {
  if (!row) return null;
  const buyer = row.buyer;
  if (buyer && !buyer.toLowerCase().includes('not found')) {
    return buyer;
  }
  return null;
}

export function formatMulticardsAccNoFromBinom(row: BinomRowByAffId | null, affId: number): string {
  if (row) {
    const u = row.username != null ? String(row.username).trim() : '';
    const id = row.aff_id;
    return u ? `${u} / ${id}` : String(id);
  }
  return String(affId);
}
