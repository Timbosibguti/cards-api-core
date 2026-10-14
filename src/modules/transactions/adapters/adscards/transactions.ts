import type { PoolClient } from 'pg';
import type { NormalizedTransaction } from '../../normalize.js';
import { getConfig } from '../../../../config/index.js';
import {
  getDatabaseService,
  getPaymentHttpClient,
  recordAdapterPollingCycleError,
} from '../../../../infra/index.js';
import { logger } from '../../../../infra/logger.js';
import { acquirePollingLease } from '../../../../infra/pollingLease.js';
import { updatePollerStatus } from '../../../../infra/runtimeStatus.js';
import type { AdapterPollerHandle } from '../types.js';
import type { BankId } from '../../types.js';

function safeStr(v: unknown): string | null {
  if (v == null) return null;
  return String(v).trim() || null;
}

function parseAdscardsDate(raw: string | null): string | null {
  if (!raw) return null;

  // Формат AdsCards: "DD-MM-YYYY HH:mm:ss"
  const m = raw.match(/^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) {
    // Fallback: пусть парсит движок как может
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const [, dd, mm, yyyy, hh, mi, ss] = m;
  const year = Number(yyyy);
  const month = Number(mm);
  const day = Number(dd);
  const hour = Number(hh);
  const minute = Number(mi);
  const second = Number(ss);

  // Месяц в JS 0–11
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function normalizeAdscardsSignedAmount(rawAmount: number | null, type: string | null): number | null {
  if (rawAmount == null) return null;
  const absAmount = Math.abs(rawAmount);
  const normalizedType = (type ?? '').toLowerCase();

  if (normalizedType === 'failed' || normalizedType === 'declined') {
    return 0;
  }
  if (
    normalizedType === 'replenishment' ||
    normalizedType === 'refund' ||
    normalizedType === 'reversed' ||
    normalizedType === 'reversal' ||
    normalizedType === 'chargeback'
  ) {
    return absAmount;
  }

  // pending/withdrawal и прочие типы трактуем как расход.
  return -absAmount;
}

export async function normalizeAdscardsTransaction(
  _client: PoolClient,
  rawPayload: unknown,
): Promise<NormalizedTransaction | null> {
  if (rawPayload == null || typeof rawPayload !== 'object') return null;
  const o = rawPayload as Record<string, unknown>;

  const src = (o.data as Record<string, unknown> | undefined) ?? o;
  const id = o.id != null ? String(o.id) : '';
  const rawCardNumber = safeStr(src.card_number);
  const cardNumber = rawCardNumber ? rawCardNumber.replace(/\s+/g, '') : null;
  const sumStr = safeStr((src as { transaction_sum?: string }).transaction_sum) ?? safeStr(o.amount);
  const parsedAmount = sumStr != null ? parseFloat(sumStr.replace(',', '.')) : null;
  const rawAmount = parsedAmount != null && !Number.isNaN(parsedAmount) ? parsedAmount : null;
  const operationType = safeStr(o.type);
  const statusRaw = safeStr((src as { transaction_status?: string }).transaction_status) ?? operationType;
  const status = statusRaw === 'failed' ? 'failed' : 'processed';
  const recipient = safeStr((src as { transaction_recipient?: string }).transaction_recipient) ?? safeStr(o.merchant);
  const accNo = safeStr((src as { card_group?: unknown }).card_group);

  return {
    bank: 'adscards',
    ext_id: id,
    acc_no: accNo,
    card_number: cardNumber,
    amount: normalizeAdscardsSignedAmount(rawAmount, operationType),
    currency: safeStr((src as { card_currency?: string }).card_currency) ?? safeStr(o.currency),
    status,
    occurred_at: parseAdscardsDate(safeStr(o.date)) ?? new Date().toISOString(),
    merchant_description: recipient,
    raw: o,
  };
}

export async function resolveAdscardsOwner(
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

const ADSCARDS_TX_POLL_INTERVAL_MS = 60 * 1000; // 1 минута между циклами

/** Поллинг транзакций AdsCards через /cards/transactions (time='day'). */
export async function startAdscardsTransactionsPolling(): Promise<AdapterPollerHandle> {
  const config = getConfig();
  const http = getPaymentHttpClient(config);
  const provider = config.providers.adscards;
  const db = getDatabaseService(config);

  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        const hasLease = await acquirePollingLease(db, 'adscards.transactions', 60);
        if (!hasLease) {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          continue;
        }

        if (!provider?.authTokenForBody) {
          logger.warn('Adscards transactions polling skipped: authTokenForBody not configured');
          updatePollerStatus('adscards.transactions', {
            entity: 'transactions',
            bank: 'adscards',
            lastCycleStartedAt: new Date().toISOString(),
            lastCycleFinishedAt: new Date().toISOString(),
            processedInLastCycle: 0,
            lastError: 'authTokenForBody not configured (ADSCARD_AUTH_TOKEN)',
          });
          if (!stopped) {
            await new Promise((resolve) => setTimeout(resolve, ADSCARDS_TX_POLL_INTERVAL_MS));
          }
          continue;
        }

        const cycleStartedAt = new Date().toISOString();
        updatePollerStatus('adscards.transactions', {
          entity: 'transactions',
          bank: 'adscards',
          lastCycleStartedAt: cycleStartedAt,
          processedInLastCycle: 0,
          lastError: undefined,
        });

        // Окно по времени: последние N часов (по конфигу), через time='period'.
        const hours = config.processingRuntime.transactionsPollingWindowHours;
        const now = new Date();
        const from = new Date(now.getTime() - hours * 60 * 60 * 1000);
        const fromDate = from.toISOString().slice(0, 10);
        const toDate = now.toISOString().slice(0, 10);
        const period = `${fromDate}|${toDate}`;

        const resp = await http.request<{ data?: unknown }>({
          bank: 'adscards',
          method: 'POST',
          path: '/teams/cards_transactions',
          body: {
            auth_token: provider.authTokenForBody,
            time: 'period',
            period,
          },
        });

        let items: unknown[] = [];
        const data = (resp as { data?: unknown }).data;
        if (Array.isArray(data)) {
          items = data;
        } else if (data && typeof data === 'object') {
          items = Object.values(data as Record<string, unknown>);
        }

        let processed = 0;
        let lastDate: string | undefined;

        if (items.length > 0) {
          logger.info('Adscards adapter: transactions polling batch', {
            count: items.length,
          });
        }

        for (const raw of items) {
          if (stopped) break;
          try {
            // raw может быть:
            // - объектом вида { data: { ... } } (как в webhook-примере)
            // - «плоским» объектом транзакции (как в /cards/transactions)
            // - строкой с JSON внутри
            let txObj: any = raw;
            if (typeof txObj === 'string') {
              try {
                txObj = JSON.parse(txObj);
              } catch {
                // оставляем как есть
              }
            }

            const inner = txObj && typeof txObj === 'object' && 'data' in txObj ? txObj.data : txObj;

            const txDate = typeof inner?.date === 'string' ? inner.date : undefined;
            if (txDate) {
              lastDate = txDate;
            }

            // Идемпотентный ingest через общий модуль transactions.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mod = await import('../../index.js');
            await mod.ingestRawTransaction({
              bank: 'adscards' as BankId,
              payload: raw,
            });
            processed += 1;
            updatePollerStatus('adscards.transactions', {
              entity: 'transactions',
              bank: 'adscards',
              processedInLastCycle: processed,
              lastItemCreatedAt: lastDate,
            });
          } catch (err) {
            logger.error('Adscards adapter: failed to ingest transaction', err as Error);
          }
        }

        updatePollerStatus('adscards.transactions', {
          entity: 'transactions',
          bank: 'adscards',
          processedInLastCycle: processed,
          lastCycleFinishedAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.warn('Adscards adapter transactions polling error', err as Error);
        await recordAdapterPollingCycleError(config, 'adscards', 'adscards.transactions', err);
        updatePollerStatus('adscards.transactions', {
          entity: 'transactions',
          bank: 'adscards',
          lastError: err instanceof Error ? err.message : String(err),
          lastCycleFinishedAt: new Date().toISOString(),
        });
      }

      if (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, ADSCARDS_TX_POLL_INTERVAL_MS));
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

/** Одноразовая проверка интеграции: один запрос /cards/transactions, вернуть количество транзакций. */
export async function probeAdscardsTransactions(): Promise<number> {
  const config = getConfig();
  const provider = config.providers.adscards;
  if (!provider || !provider.baseUrl) {
    throw new Error('ADSCARD_API_URL/ADSCARDS_BASE_URL не заданы, провайдер adscards не сконфигурирован');
  }
  if (!provider.authTokenForBody) {
    throw new Error('authTokenForBody не сконфигурирован для adscards (ADSCARD_AUTH_TOKEN)');
  }

  const http = getPaymentHttpClient(config);
  const hours = config.processingRuntime.transactionsPollingWindowHours;
  const now = new Date();
  const from = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const fromDate = from.toISOString().slice(0, 10);
  const toDate = now.toISOString().slice(0, 10);
  const period = `${fromDate}|${toDate}`;

  const resp = await http.request<{ data?: unknown }>({
    bank: 'adscards',
    method: 'POST',
    path: '/cards/transactions',
    body: {
      auth_token: provider.authTokenForBody,
      time: 'period',
      period,
    },
  });

  const data = (resp as { data?: unknown }).data;
  if (Array.isArray(data)) {
    return data.length;
  }
  if (data && typeof data === 'object') {
    return Object.keys(data as Record<string, unknown>).length;
  }
  return 0;
}


