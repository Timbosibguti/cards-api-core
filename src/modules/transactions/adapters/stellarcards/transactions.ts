import type { PoolClient } from 'pg';
import type { AdapterPollerHandle } from '../types.js';
import type { NormalizedTransaction } from '../../normalize.js';
import type { BankId } from '../../types.js';
import { getConfig } from '../../../../config/index.js';
import {
  getPaymentHttpClient,
  getDatabaseService,
  recordAdapterPollingCycleError,
} from '../../../../infra/index.js';
import { logger } from '../../../../infra/logger.js';
import { updatePollerStatus } from '../../../../infra/runtimeStatus.js';
import { acquirePollingLease } from '../../../../infra/pollingLease.js';

function safeNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function safeStr(v: unknown): string | null {
  if (v == null) return null;
  return String(v).trim() || null;
}

function normalizeStellarcardsSignedAmount(rawAmount: number | null, status: string | null): number | null {
  if (rawAmount == null) return null;
  const absAmount = Math.abs(rawAmount);
  const normalizedStatus = (status ?? '').toLowerCase();

  if (normalizedStatus === 'declined' || normalizedStatus === 'failed') {
    return 0;
  }
  if (
    normalizedStatus === 'refund' ||
    normalizedStatus === 'reversed' ||
    normalizedStatus === 'reversal' ||
    normalizedStatus === 'chargeback'
  ) {
    return absAmount;
  }

  return -absAmount;
}

export async function normalizeStellarcardsTransaction(
  client: PoolClient,
  rawPayload: unknown,
): Promise<NormalizedTransaction | null> {
  if (rawPayload == null || typeof rawPayload !== 'object') return null;
  const o = rawPayload as Record<string, unknown>;

  const id = o.id != null ? String(o.id) : '';
  const rawAmount = safeNum(o.amount_usd) ?? safeNum(o.amount);
  const statusRaw = safeStr(o.status);
  const status = statusRaw === 'pending' ? 'pending' : 'processed';
  const amount = normalizeStellarcardsSignedAmount(rawAmount, statusRaw);
  const occurred = safeStr(o.authorize_at_utc);
  const merchant = safeStr(o.merchant);
  const cardGuid = safeStr((o as { card_guid?: unknown }).card_guid);

  let cardNumber: string | null = null;
  if (cardGuid) {
    const res = await client.query<{ card_number: string | null }>(
      `SELECT card_number::text AS card_number
       FROM public.bank_cards
       WHERE bank = $1 AND ext_id = $2
       ORDER BY created_at DESC NULLS LAST
       LIMIT 1`,
      ['stellarcards', cardGuid],
    );
    cardNumber = res.rows[0]?.card_number ?? null;
  }

  return {
    bank: 'stellarcards',
    ext_id: id,
    acc_no: safeStr(o.account_guid) ?? null,
    card_number: cardNumber,
    amount,
    currency: safeStr(o.currency_code) ?? null,
    status,
    occurred_at: occurred,
    merchant_description: merchant,
    raw: o,
  };
}

export async function resolveStellarcardsOwner(
  client: PoolClient,
  normalized: NormalizedTransaction,
): Promise<{ buyer: string | null; profileName: string | null }> {
  const raw = normalized.raw as { card_guid?: unknown } | null;
  const cardGuid = raw && raw.card_guid != null ? String(raw.card_guid) : null;
  if (!cardGuid) {
    return { buyer: null, profileName: null };
  }

  const res = await client.query<{ buyer: string | null; profile_name: string | null }>(
    `SELECT buyer, profile_name
     FROM public.bank_cards
     WHERE bank = $1 AND ext_id = $2
     ORDER BY created_at DESC NULLS LAST
     LIMIT 1`,
    [normalized.bank, cardGuid],
  );

  if (!res.rows[0]) {
    return { buyer: null, profileName: null };
  }

  return {
    buyer: res.rows[0].buyer ?? null,
    profileName: res.rows[0].profile_name ?? null,
  };
}

const POLL_INTERVAL_MS = 10 * 1000; // 10 сек между циклами (как в mqtt_stellarcards)

function formatDateForApi(date: Date): string {
  return date.toISOString().slice(0, 19).replace('Z', '');
}

interface StellarTransactionsResponse {
  count?: number;
  start_index?: number;
  end_index?: number;
  has_more?: boolean;
  data?: unknown[];
}

export async function startStellarcardsTransactionsPolling(): Promise<AdapterPollerHandle> {
  const config = getConfig();
  const http = getPaymentHttpClient(config);
  const db = getDatabaseService(config);

  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        const hasLease = await acquirePollingLease(db, 'stellarcards.transactions', 60);
        if (!hasLease) {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          continue;
        }

        updatePollerStatus('stellarcards.transactions', {
          entity: 'transactions',
          bank: 'stellarcards',
          lastCycleStartedAt: new Date().toISOString(),
          processedInLastCycle: 0,
          totalInLastCycle: undefined,
          lastError: undefined,
        });
        const now = new Date();
        const windowMs = config.processingRuntime.transactionsPollingWindowHours * 60 * 60 * 1000;
        const from = new Date(now.getTime() - windowMs);
        const datetime_from = formatDateForApi(from);
        const datetime_to = formatDateForApi(now);

        let startIndex = 0;
        const limit = 100;

        let processedHere = 0;
        while (!stopped) {
          const response = await http.request<StellarTransactionsResponse>({
            bank: 'stellarcards',
            method: 'GET',
            path: '/v1/transactions',
            query: { datetime_from, datetime_to, limit, start_index: startIndex },
          });

          const data = response?.data ?? [];
          if (!Array.isArray(data) || data.length === 0) break;

          for (const tx of data) {
            if (stopped) break;
            try {
              await import('../../index.js').then(({ ingestRawTransaction }) =>
                ingestRawTransaction({
                  bank: 'stellarcards' as BankId,
                  payload: tx,
                }),
              );
              processedHere += 1;
              updatePollerStatus('stellarcards.transactions', {
                entity: 'transactions',
                bank: 'stellarcards',
                processedInLastCycle: processedHere,
              });
            } catch (err) {
              logger.error('Stellarcards adapter: failed to ingest transaction', err as Error);
            }
          }

          if (!response?.has_more) break;
          startIndex = (response?.end_index ?? startIndex) + 1;
        }
        updatePollerStatus('stellarcards.transactions', {
          entity: 'transactions',
          bank: 'stellarcards',
          lastCycleFinishedAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.warn('Stellarcards adapter transactions polling error', err as Error);
        await recordAdapterPollingCycleError(config, 'stellarcards', 'stellarcards.transactions', err);
        updatePollerStatus('stellarcards.transactions', {
          entity: 'transactions',
          bank: 'stellarcards',
          lastError: err instanceof Error ? err.message : String(err),
          lastCycleFinishedAt: new Date().toISOString(),
        });
      }
      if (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    }
  };

  void loop();
  return { async stop() { stopped = true; } };
}

/** Одноразовая проверка интеграции: один запрос /v1/transactions, вернуть количество транзакций. */
export async function probeStellarcardsTransactions(): Promise<number> {
  const config = getConfig();
  if (!config.providers.stellarcards) {
    throw new Error('STELLARCARDS_BASE_URL не задан, провайдер stellarcards не сконфигурирован');
  }
  const http = getPaymentHttpClient(config);

  const now = new Date();
  const windowMs = config.processingRuntime.transactionsPollingWindowHours * 60 * 60 * 1000;
  const from = new Date(now.getTime() - windowMs);
  const datetime_from = formatDateForApi(from);
  const datetime_to = formatDateForApi(now);

  const response = await http.request<StellarTransactionsResponse>({
    bank: 'stellarcards',
    method: 'GET',
    path: '/v1/transactions',
    query: { datetime_from, datetime_to, limit: 100, start_index: 0 },
  });

  const data = response?.data ?? [];
  return Array.isArray(data) ? data.length : 0;
}

