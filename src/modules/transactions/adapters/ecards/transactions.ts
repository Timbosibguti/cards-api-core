import { getConfig } from '../../../../config/index.js';
import {
  getDatabaseService,
  getPaymentHttpClient,
  recordAdapterPollingCycleError,
} from '../../../../infra/index.js';
import { logger } from '../../../../infra/logger.js';
import { acquirePollingLease } from '../../../../infra/pollingLease.js';
import { updatePollerStatus } from '../../../../infra/runtimeStatus.js';
import type { PoolClient } from 'pg';
import type { AdapterPollerHandle } from '../types.js';
import type { NormalizedTransaction } from '../../normalize.js';
import type { BankId } from '../../types.js';

function safeNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function safeStr(v: unknown): string | null {
  if (v == null) return null;
  return String(v).trim() || null;
}

function normalizeEcardsSignedAmount(rawAmount: number | null, method: string | null): number | null {
  if (rawAmount == null) return null;
  const absAmount = Math.abs(rawAmount);
  const normalizedMethod = (method ?? '').toLowerCase();

  if (normalizedMethod === 'add') {
    return absAmount;
  }
  if (normalizedMethod === 'sub') {
    return -absAmount;
  }

  // Без явного метода считаем операцию списанием.
  return -absAmount;
}

interface EcardsTransactionPage {
  data?: {
    content?: unknown[];
  };
}

interface EcardsTransactionsRequestContext {
  bank: 'ecards';
  method: 'GET';
  path: '/card-operation';
  query: {
    offset: number;
    limit: number;
    sortBy: 'id';
    sortDirection: 'desc';
  };
}

const DEFAULT_LIMIT = 100;
const SLEEP_BETWEEN_PAGES_MS = 300;
const SLEEP_BETWEEN_CYCLES_MS = 60_000;

function shouldMaskEcardsLogField(key: string): boolean {
  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return [
    'cvv',
    'cvv2',
    'cvc',
    'cvc2',
    'expiry',
    'expirydate',
    'expire',
    'expiredate',
    'expiration',
    'expirationdate',
    'expdate',
  ].includes(normalizedKey);
}

function sanitizeEcardsLogValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeEcardsLogValue(item));
  }

  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      sanitized[key] = shouldMaskEcardsLogField(key) ? '***' : sanitizeEcardsLogValue(nestedValue);
    }
    return sanitized;
  }

  return value;
}

export async function normalizeEcardsTransaction(
  _client: PoolClient,
  rawPayload: unknown,
): Promise<NormalizedTransaction | null> {
  if (rawPayload == null || typeof rawPayload !== 'object') return null;
  const o = rawPayload as Record<string, unknown>;

  const id = o.id != null ? String(o.id) : '';
  const value = safeNum(o.value) ?? safeNum((o as { value?: string }).value);
  const method = safeStr(o.method);
  const createdAt = safeStr(o.createdAt);
  const account = o.account as Record<string, unknown> | undefined;
  const accNo = account?.name != null ? String(account.name) : null;
  const card = o.card as Record<string, unknown> | undefined;
  const cardNumber = safeStr(card?.cardNumber);
  // Для Google OTP кодов критично поле merchantInfo (там есть "GOOGLE*...123456"),
  // а description часто содержит лишь общий текст операции.
  const merchantInfo = safeStr(o.merchantInfo) ?? safeStr((o as { description?: string }).description);

  return {
    bank: 'ecards',
    ext_id: id,
    acc_no: accNo,
    card_number: cardNumber,
    amount: normalizeEcardsSignedAmount(value, method),
    currency: safeStr(o.currency) ?? (card?.currency as string) ?? null,
    status: 'processed',
    occurred_at: createdAt,
    merchant_description: merchantInfo,
    raw: o,
  };
}

export async function resolveEcardsOwner(
  client: PoolClient,
  normalized: NormalizedTransaction,
): Promise<{ buyer: string | null; profileName: string | null }> {
  if (!normalized.card_number) {
    return { buyer: null, profileName: null };
  }
  const digits = String(normalized.card_number).replace(/\D/g, '');
  if (!digits) {
    return { buyer: null, profileName: null };
  }

  const res = await client.query<{ buyer: string | null; profile_name: string | null }>(
    `SELECT buyer, profile_name
     FROM public.bank_cards
     WHERE bank = $1 AND card_number = $2::bigint
     ORDER BY created_at DESC NULLS LAST
     LIMIT 1`,
    [normalized.bank, digits],
  );

  if (!res.rows[0]) {
    return { buyer: null, profileName: null };
  }

  return {
    buyer: res.rows[0].buyer ?? null,
    profileName: res.rows[0].profile_name ?? null,
  };
}

export async function startEcardsTransactionsPolling(): Promise<AdapterPollerHandle> {
  const config = getConfig();
  const http = getPaymentHttpClient(config);
  const db = getDatabaseService(config);
  const pollingWindowMs = config.processingRuntime.transactionsPollingWindowHours * 60 * 60 * 1000;

  let stopped = false;

  const loop = async () => {
    let lastRequestContext: EcardsTransactionsRequestContext | null = null;

    while (!stopped) {
      try {
        const hasLease = await acquirePollingLease(db, 'ecards.transactions', 60);
        if (!hasLease) {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          continue;
        }

        updatePollerStatus('ecards.transactions', {
          entity: 'transactions',
          bank: 'ecards',
          lastCycleStartedAt: new Date().toISOString(),
          processedInLastCycle: 0,
          totalInLastCycle: undefined,
          lastError: undefined,
        });
        const cutoffTs = Date.now() - pollingWindowMs;

        let txOffset = 0;
        let txShouldStop = false;

        logger.info('Ecards adapter: starting transactions polling cycle');

        while (!txShouldStop && !stopped) {
          lastRequestContext = {
            bank: 'ecards',
            method: 'GET',
            path: '/card-operation',
            query: {
              offset: txOffset,
              limit: DEFAULT_LIMIT,
              sortBy: 'id',
              sortDirection: 'desc',
            },
          };
          logger.info('Ecards transactions polling request', lastRequestContext);

          // Используем card-operations, как в mqtt_ecards_transactions (EcardsService.fetchCardOperations).
          const page = await http.request<EcardsTransactionPage>({
            bank: 'ecards',
            method: 'GET',
            path: '/card-operation',
            query: lastRequestContext.query,
          });
          const content = page.data?.content ?? [];
          const firstTx = content[0] as Record<string, unknown> | undefined;
          const lastTx = content[content.length - 1] as Record<string, unknown> | undefined;

          logger.info('Ecards transactions polling response', {
            request: lastRequestContext,
            contentCount: content.length,
            firstTransactionId: firstTx?.id ?? null,
            lastTransactionId: lastTx?.id ?? null,
            firstCreatedAt: firstTx?.createdAt ?? firstTx?.issued_at ?? null,
            lastCreatedAt: lastTx?.createdAt ?? lastTx?.issued_at ?? null,
            firstTransaction: firstTx ? sanitizeEcardsLogValue(firstTx) : null,
            lastTransaction: lastTx ? sanitizeEcardsLogValue(lastTx) : null,
          });

          if (content.length === 0) {
            txShouldStop = true;
            break;
          }

          let processedHere = 0;
          for (const tx of content) {
            if (stopped) break;
            const anyTx = tx as Record<string, unknown>;
            const createdAtStr = (anyTx.createdAt as string | undefined) ?? (anyTx.issued_at as string | undefined);
            if (createdAtStr) {
              const createdTs = Date.parse(createdAtStr);
              if (!Number.isNaN(createdTs) && createdTs < cutoffTs) {
                txShouldStop = true;
                break;
              }
            }
            try {
              await import('../../index.js').then(({ ingestRawTransaction }) =>
                ingestRawTransaction({
                  bank: 'ecards' as BankId,
                  payload: tx,
                }),
              );
              processedHere += 1;
              updatePollerStatus('ecards.transactions', {
                entity: 'transactions',
                bank: 'ecards',
                processedInLastCycle:
                  (processedHere +
                    (txOffset / DEFAULT_LIMIT) * DEFAULT_LIMIT) || processedHere,
                lastItemCreatedAt: createdAtStr ?? undefined,
              });
            } catch (err) {
              logger.error('Ecards adapter: failed to ingest transaction', {
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
                txId: anyTx.id != null ? String(anyTx.id) : null,
                createdAt: createdAtStr ?? null,
                payload: sanitizeEcardsLogValue(anyTx),
              });
            }
          }

          if (content.length < DEFAULT_LIMIT) {
            txShouldStop = true;
          } else {
            txOffset += DEFAULT_LIMIT;
          }

          if (!txShouldStop && !stopped) {
            await new Promise((resolve) => setTimeout(resolve, SLEEP_BETWEEN_PAGES_MS));
          }
        }
        updatePollerStatus('ecards.transactions', {
          entity: 'transactions',
          bank: 'ecards',
          lastCycleFinishedAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.error('Ecards transactions polling catch triggered', {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          request: lastRequestContext,
        });
        logger.warn('Ecards adapter transactions polling error', err as Error);
        await recordAdapterPollingCycleError(config, 'ecards', 'ecards.transactions', err);
        updatePollerStatus('ecards.transactions', {
          entity: 'transactions',
          bank: 'ecards',
          lastError: err instanceof Error ? err.message : String(err),
          lastCycleFinishedAt: new Date().toISOString(),
        });
      }

      if (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, SLEEP_BETWEEN_CYCLES_MS));
      }
    }
  };

  void loop();

  return {
    async stop() {
      stopped = true;
    },
  };
}

/** Одноразовая проверка интеграции: один запрос /transaction, вернуть количество транзакций. */
export async function probeEcardsTransactions(): Promise<number> {
  const config = getConfig();
  if (!config.providers.ecards) {
    throw new Error('ECARDS_BASE_URL не задан, провайдер ecards не сконфигурирован');
  }
  const http = getPaymentHttpClient(config);

  const page = await http.request<EcardsTransactionPage>({
    bank: 'ecards',
    method: 'GET',
    path: '/transaction',
    query: {
      offset: 0,
      limit: DEFAULT_LIMIT,
      sortBy: 'id',
      sortDirection: 'desc',
    },
  });

  const content = page.data?.content ?? [];
  return Array.isArray(content) ? content.length : 0;
}
