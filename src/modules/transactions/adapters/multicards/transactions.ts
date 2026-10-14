import type { PoolClient } from 'pg';
import type { NormalizedTransaction } from '../../normalize.js';
import { getConfig } from '../../../../config/index.js';
import {
  getPaymentHttpClient,
  getDatabaseService,
  recordAdapterPollingCycleError,
} from '../../../../infra/index.js';
import { logger } from '../../../../infra/logger.js';
import { updatePollerStatus } from '../../../../infra/runtimeStatus.js';
import { acquirePollingLease } from '../../../../infra/pollingLease.js';
import type { AdapterPollerHandle } from '../types.js';
import type { BankId } from '../../types.js';
import type { AppConfig } from '../../../../config/index.js';
import type { PaymentHttpClient } from '../../../../infra/index.js';

function safeNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function safeStr(v: unknown): string | null {
  if (v == null) return null;
  return String(v).trim() || null;
}

function normalizeMulticardsSignedAmount(rawAmount: number | null, status: string | null): number | null {
  if (rawAmount == null) return null;
  const absAmount = Math.abs(rawAmount);
  const normalizedStatus = (status ?? '').toUpperCase();

  if (normalizedStatus === 'DECLINED' || normalizedStatus === 'FAILED') {
    return 0;
  }
  if (
    normalizedStatus === 'REFUND' ||
    normalizedStatus === 'REFUNDED' ||
    normalizedStatus === 'REVERSED' ||
    normalizedStatus === 'REVERSAL' ||
    normalizedStatus === 'CHARGEBACK'
  ) {
    return absAmount;
  }

  // Для остальных статусов считаем расходом (списание).
  return -absAmount;
}

export async function normalizeMulticardsTransaction(
  client: PoolClient,
  rawPayload: unknown,
): Promise<NormalizedTransaction | null> {
  if (rawPayload == null || typeof rawPayload !== 'object') return null;
  const o = rawPayload as Record<string, unknown>;

  const id = o.recieptId != null ? String(o.recieptId) : (o.receiptNo != null ? String(o.receiptNo) : '');
  const amount = safeNum(o.amount) ?? safeNum((o as { authAmount?: unknown }).authAmount);
  const createdAt = safeStr(o.createdAt) ?? safeStr(o.issued_at);
  const description = safeStr(o.description);
  const statusRaw = safeStr(o.status);
  const status = statusRaw === 'PENDING' ? 'pending' : 'processed';

  // В payload Multicards хранит только маску cardNumber; полный номер берём из bank_cards по cardId.
  let cardNumber: string | null = o.cardNumber as string | null;
  const cardId = (o as { cardId?: number | string }).cardId;
  if (cardId != null) {
    const res = await client.query<{ card_number: string | null }>(
      `SELECT card_number::text AS card_number
       FROM public.bank_cards
       WHERE bank = 'multicards' AND ext_id = $1
       ORDER BY created_at DESC NULLS LAST
       LIMIT 1`,
      [String(cardId)],
    );
    cardNumber = res.rows[0]?.card_number ?? null;
  }

  return {
    bank: 'multicards',
    ext_id: id,
    acc_no: null,
    card_number: cardNumber,
    amount: normalizeMulticardsSignedAmount(amount, statusRaw),
    currency: safeStr(o.currency) ?? null,
    status,
    occurred_at: createdAt,
    merchant_description: description,
    raw: o,
  };
}

export async function resolveMulticardsOwner(
  client: PoolClient,
  normalized: NormalizedTransaction,
): Promise<{ buyer: string | null; profileName: string | null }> {
  const raw = normalized.raw as { cardId?: number; id?: number } | null;
  const cardId = raw?.cardId ?? raw?.id;
  if (cardId == null) return { buyer: null, profileName: null };
  const res = await client.query<{ buyer: string | null; profile_name: string | null }>(
    `SELECT buyer, profile_name FROM public.bank_cards WHERE bank = 'multicards' AND ext_id = $1 ORDER BY created_at DESC NULLS LAST LIMIT 1`,
    [String(cardId)],
  );
  const row = res.rows[0];
  return { buyer: row?.buyer ?? null, profileName: row?.profile_name ?? null };
}

const MULTICARDS_TX_POLL_INTERVAL_MS = 60 * 1000; // 1 минута
const MULTICARDS_TX_LIMIT = 100;

let multicardsToken: string | null = null;
let multicardsTokenExpiresAt: number | null = null;
let multicardsMediabuyerEmails: string[] = [];

export async function getMulticardsAccessToken(config: AppConfig, http: PaymentHttpClient): Promise<string> {
  const provider = config.providers.multicards;
  if (!provider?.baseUrl) {
    throw new Error('Multicards baseUrl is not configured (MULTICARDS_BASE_URL)');
  }
  const email = provider.username;
  const password = provider.password;
  if (!email || !password) {
    throw new Error('Multicards credentials are not configured (MULTICARDS_EMAIL/MULTICARDS_PASSWORD)');
  }

  logger.info('Multicards adapter: requesting access token');
  // Логин без авторизационного хэдера — только email/password.
  const resp = await http.request<{
    token?: string;
    expires?: number;
  }>({
    bank: 'multicards',
    method: 'POST',
    path: '/v1/auth/login',
    headers: {
      'Content-Type': 'application/json',
    },
    body: {
      email,
      password,
      secondFactorCode: '',
      captcha: '',
    },
  });

  const newToken = resp.token;
  if (!newToken) {
    throw new Error('Multicards auth: token is missing in response');
  }
  const expiresSec = typeof resp.expires === 'number' ? resp.expires : 0;
  multicardsToken = newToken;
  multicardsTokenExpiresAt = expiresSec > 0 ? Date.now() + expiresSec * 1000 : null;

  logger.info('Multicards adapter: obtained access token', {
    tokenLength: newToken.length,
    expiresIn: expiresSec,
    expiresAt: multicardsTokenExpiresAt ? new Date(multicardsTokenExpiresAt).toISOString() : null,
  });

  return newToken;
}

export async function ensureMulticardsToken(config: AppConfig, http: PaymentHttpClient): Promise<string> {
  const now = Date.now();
  if (!multicardsToken || !multicardsTokenExpiresAt || now >= multicardsTokenExpiresAt - 5 * 60 * 1000) {
    return getMulticardsAccessToken(config, http);
  }
  return multicardsToken;
}

export async function loadMulticardsMediabuyerEmails(
  config: AppConfig,
  http: PaymentHttpClient,
  accessToken: string,
): Promise<string[]> {
  // Уже загружали — повторять не обязательно (список меняется редко).
  if (multicardsMediabuyerEmails.length > 0) return multicardsMediabuyerEmails;

  if (!config.providers.multicards?.baseUrl) {
    throw new Error('Multicards baseUrl is not configured (MULTICARDS_BASE_URL)');
  }

  logger.info('Multicards adapter: fetching MEDIABUYER team members');
  const resp = await http.request<{
    members?: Array<{ email?: string; role?: string }>;
  }>({
    bank: 'multicards',
    method: 'GET',
    path: '/v1/team/info',
    headers: {
      'x-auth-token': accessToken,
      'Content-Type': 'application/json',
    },
  });

  const members = Array.isArray(resp.members) ? resp.members : [];
  multicardsMediabuyerEmails = members
    .filter((m) => m.role === 'ROLE_MEDIABUYER' && m.email)
    .map((m) => String(m.email));

  logger.info('Multicards adapter: MEDIABUYER emails loaded', {
    count: multicardsMediabuyerEmails.length,
  });

  return multicardsMediabuyerEmails;
}

interface MulticardsTransactionPage {
  items?: Array<{
    id: number;
    createdAt?: string;
  }>;
  offset?: number;
  limit?: number;
  total?: number;
}

/** Поллинг транзакций Multicards (POST /v1/transaction/pageable, окно ~30 дней). */
export async function startMulticardsTransactionsPolling(): Promise<AdapterPollerHandle> {
  const config = getConfig();
  const http = getPaymentHttpClient(config);
  const db = getDatabaseService(config);

  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        const hasLease = await acquirePollingLease(db, 'multicards.transactions', 60);
        if (!hasLease) {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          continue;
        }

        const accessToken = await ensureMulticardsToken(config, http);
        const mediabuyerEmails = await loadMulticardsMediabuyerEmails(config, http, accessToken);
        const nowSec = Math.floor(Date.now() / 1000);
        const thirtyDaysAgo = nowSec - 30 * 24 * 60 * 60;

        let offset = 0;
        const limit = MULTICARDS_TX_LIMIT;
        let processed = 0;

        updatePollerStatus('multicards.transactions', {
          entity: 'transactions',
          bank: 'multicards',
          lastCycleStartedAt: new Date().toISOString(),
          processedInLastCycle: 0,
          lastError: undefined,
        });

        // Пагинация по /v1/transaction/pageable
        // dedup/идемпотентность обеспечиваются ingestRawTransaction по ext_id.
        const requestBodyBase: {
          textQuery: string;
          periodStart: number;
          periodEnd: number;
          userEmails: string[];
          cardIds: number[];
          cardGroupIds: number[];
          receiptIds: string[];
          currencies: string[];
          types: string[];
          statuses: string[];
          sort: string[];
        } = {
          textQuery: '',
          periodStart: thirtyDaysAgo,
          periodEnd: nowSec,
          // Критично: без userEmails платёжная система возвращает 0 транзакций.
          userEmails: mediabuyerEmails,
          cardIds: [],
          cardGroupIds: [],
          receiptIds: [],
          currencies: [],
          types: [],
          statuses: [],
          sort: [],
        };

        // eslint-disable-next-line no-constant-condition
        while (!stopped) {
          const page = await http.request<MulticardsTransactionPage>({
            bank: 'multicards',
            method: 'POST',
            path: '/v1/transaction/pageable',
            headers: {
              'x-auth-token': accessToken,
              'Content-Type': 'application/json',
            },
            body: {
              ...requestBodyBase,
              limit,
              offset,
            },
          });

          const items = Array.isArray(page.items) ? page.items : [];
          if (items.length === 0) {
            break;
          }

          logger.info('Multicards adapter: transactions polling batch', {
            offset,
            limit,
            count: items.length,
          });

          for (const tx of items) {
            if (stopped) break;
            try {
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              const mod = await import('../../index.js');
              await mod.ingestRawTransaction({
                bank: 'multicards' as BankId,
                payload: tx,
              });
              processed += 1;
              updatePollerStatus('multicards.transactions', {
                entity: 'transactions',
                bank: 'multicards',
                processedInLastCycle: processed,
                lastItemCreatedAt: tx.createdAt,
              });
            } catch (err) {
              logger.error('Multicards adapter: failed to ingest transaction', err as Error);
            }
          }

          const total = page.total ?? offset + items.length;
          if (offset + limit >= total) {
            break;
          }
          offset += limit;
        }

        updatePollerStatus('multicards.transactions', {
          entity: 'transactions',
          bank: 'multicards',
          processedInLastCycle: processed,
          lastCycleFinishedAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.warn('Multicards adapter transactions polling error', err as Error);
        await recordAdapterPollingCycleError(config, 'multicards', 'multicards.transactions', err);
        updatePollerStatus('multicards.transactions', {
          entity: 'transactions',
          bank: 'multicards',
          lastError: err instanceof Error ? err.message : String(err),
          lastCycleFinishedAt: new Date().toISOString(),
        });
      }

      if (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, MULTICARDS_TX_POLL_INTERVAL_MS));
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

/** Одноразовая проверка интеграции: один запрос /v1/transaction/pageable, вернуть количество транзакций. */
export async function probeMulticardsTransactions(): Promise<number> {
  const config = getConfig();
  if (!config.providers.multicards) {
    throw new Error('MULTICARDS_BASE_URL не задан, провайдер multicards не сконфигурирован');
  }
  const http = getPaymentHttpClient(config);

  const nowSec = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = nowSec - 30 * 24 * 60 * 60;

  const accessToken = await ensureMulticardsToken(config, http);
  const mediabuyerEmails = await loadMulticardsMediabuyerEmails(config, http, accessToken);

  const page = await http.request<MulticardsTransactionPage>({
    bank: 'multicards',
    method: 'POST',
    path: '/v1/transaction/pageable',
    headers: {
      'x-auth-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: {
      textQuery: '',
      periodStart: thirtyDaysAgo,
      periodEnd: nowSec,
      userEmails: mediabuyerEmails,
      cardIds: [],
      cardGroupIds: [],
      receiptIds: [],
      currencies: [],
      types: [],
      statuses: [],
      sort: [],
      limit: MULTICARDS_TX_LIMIT,
      offset: 0,
    },
  });

  const items = Array.isArray(page.items) ? page.items : [];
  return items.length;
}


