/**
 * Нормализация сырого payload платёжных систем в единую структуру для upsert в bank_transactions.
 * Соответствует docs/payment_providers_transaction_formats.md и architecture processes 2.6.
 *
 * Конкретная нормализация по банкам делегируется адаптерам в modules/transactions/adapters.
 */

import type { PoolClient } from 'pg';
import type { BankId } from './types.js';
import { getTransactionsAdapter } from './adapters/index.js';

export interface NormalizedTransaction {
  bank: string;
  ext_id: string;
  acc_no: string | null;
  /** Полный номер карты (до цифр, без масок) или null, если его нельзя восстановить из payload. */
  card_number: string | null;
  amount: number | null;
  currency: string | null;
  status: string;
  occurred_at: string | null; // ISO8601
  merchant_description: string | null;
  raw: unknown; // сохраняем как JSON для поля raw в bank_transactions
}

export async function normalizeRawPayload(
  client: PoolClient,
  bank: BankId,
  rawPayload: unknown,
): Promise<NormalizedTransaction | null> {
  const adapter = getTransactionsAdapter(bank);
  if (!adapter) return null;
  return adapter.normalize(client, rawPayload);
}
