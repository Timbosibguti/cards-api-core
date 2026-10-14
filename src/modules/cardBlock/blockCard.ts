import { getConfig } from '../../config/index.js';
import { getDatabaseService, recordIncident } from '../../infra/index.js';
import { logger } from '../../infra/logger.js';
import { getTransactionsAdapter } from '../transactions/adapters/index.js';
import type { BankId } from '../transactions/types.js';
import { lookupBankCardForBlock } from './lookupCard.js';
import type { BlockCardResult } from './types.js';

export type BlockCardByCardNumberOptions = {
  /**
   * Записать инцидент при ошибке провайдера (`provider_error`).
   * Для ретраев промежуточные попытки передают `false`, чтобы не плодить строки в `ops_incidents`.
   * @default true
   */
  recordProviderFailureIncident?: boolean;
};

/** Первая попытка + 3 ретрая при ошибке провайдера. */
const DEFAULT_BLOCK_RETRY_MAX_ATTEMPTS = 4;
/** Паузы перед 2-й, 3-й и 4-й попыткой (после ошибки провайдера): 30 с → 1 мин → 3 мин. */
const DEFAULT_BLOCK_RETRY_DELAYS_MS = [30_000, 60_000, 180_000] as const;

export async function blockCardByCardNumber(
  cardNumberInput: string | number,
  options?: BlockCardByCardNumberOptions,
): Promise<BlockCardResult> {
  const config = getConfig();
  const db = getDatabaseService(config);

  const row = await db.withTransaction('main', async (client) => {
    return lookupBankCardForBlock(client, cardNumberInput);
  });

  if (!row) {
    return { ok: false, error: 'card_not_found', message: 'Card not found in bank_cards' };
  }

  const bank = row.bank.toLowerCase();
  const adapter = getTransactionsAdapter(bank as BankId);
  if (adapter?.blockCard == null) {
    return {
      ok: false,
      error: 'unsupported_bank',
      message: `Bank "${row.bank}" has no blockCard on the adapter`,
    };
  }

  const extId = row.ext_id;
  const parsed = parseInt(String(row.card_number).replace(/\D/g, ''), 10);
  if (!Number.isFinite(parsed)) {
    return { ok: false, error: 'provider_error', message: 'Invalid card_number in bank_cards' };
  }

  if (bank !== 'ecards' && (extId == null || extId === '')) {
    return {
      ok: false,
      error: 'missing_ext_id',
      message: 'ext_id is required for this payment system',
    };
  }

  try {
    await adapter.blockCard({ cardNumber: parsed, extId });

    await db.withTransaction('main', async (client) => {
      const accNo = `blocked at ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;
      await client.query(
        `UPDATE public.bank_cards
         SET is_bad = true, acc_no = $1
         WHERE card_number = $2::bigint AND bank = $3`,
        [accNo, String(parsed), bank],
      );
    });

    return { ok: true, bank: bank as BankId, profile_name: row.profile_name, buyer: row.buyer };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const shouldRecord = options?.recordProviderFailureIncident !== false;
    if (shouldRecord) {
      try {
        await db.withTransaction('main', async (client) => {
          await recordIncident(client, {
            source: 'card_block',
            kind: 'card_block_provider_error',
            severity: 'error',
            summary: `Block card failed (${bank}): ${msg}`.slice(0, 1000),
            detail: {
              bank,
              card_number: parsed,
              ext_id: extId,
              profile_name: row.profile_name,
              buyer: row.buyer,
              error_message: msg,
            },
          });
        });
      } catch (recordErr) {
        logger.error('cardBlock: recordIncident failed after provider error', recordErr as Error);
      }
    }
    return { ok: false, error: 'provider_error', message: msg };
  }
}

function isRetriableBlockFailure(result: BlockCardResult): result is Extract<BlockCardResult, { ok: false }> {
  return !result.ok && result.error === 'provider_error';
}

export type BlockCardByCardNumberRetryOptions = {
  maxAttempts?: number;
  /**
   * Задержки перед следующей попыткой (мс), по порядку: после 1-й неудачи, после 2-й, …
   * По умолчанию **30 с, 1 мин, 3 мин** (для четырёх попыток — три паузы).
   */
  delaysMsBeforeNextAttempt?: readonly number[];
};

/**
 * Блокировка у провайдера с повторными попытками при сетевых/сбойных ответах ПС (`provider_error`).
 * По умолчанию до **4** вызовов; перед следующей попыткой паузы **30 с → 1 мин → 3 мин**.
 * Ошибки `card_not_found`, `unsupported_bank`, `missing_ext_id` ретраю не подлежат.
 * В `ops_incidents` попадает только финальная неудача после исчерпания попыток.
 */
export async function blockCardByCardNumberWithRetries(
  cardNumberInput: string | number,
  retryOptions?: BlockCardByCardNumberRetryOptions,
): Promise<BlockCardResult> {
  const maxAttempts = Math.max(1, retryOptions?.maxAttempts ?? DEFAULT_BLOCK_RETRY_MAX_ATTEMPTS);
  const delays =
    retryOptions?.delaysMsBeforeNextAttempt != null && retryOptions.delaysMsBeforeNextAttempt.length > 0
      ? retryOptions.delaysMsBeforeNextAttempt
      : DEFAULT_BLOCK_RETRY_DELAYS_MS;
  let last: BlockCardResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const isLastAttempt = attempt === maxAttempts;
    last = await blockCardByCardNumber(cardNumberInput, {
      recordProviderFailureIncident: isLastAttempt,
    });
    if (last.ok) {
      return last;
    }
    if (!isRetriableBlockFailure(last)) {
      return last;
    }
    if (!isLastAttempt) {
      const delayIdx = attempt - 1;
      const waitMs = delays[delayIdx] ?? delays[delays.length - 1] ?? 30_000;
      logger.warn('blockCard: provider error, will retry after delay', {
        attempt,
        maxAttempts,
        delayMs: waitMs,
        cardNumberPrefix: String(cardNumberInput).replace(/\D/g, '').slice(0, 6),
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, waitMs);
      });
    }
  }

  return last!;
}
