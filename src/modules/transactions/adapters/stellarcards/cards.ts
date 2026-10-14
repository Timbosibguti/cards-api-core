/**
 * Поллинг карт StellarCards: GET /api/card, GET /api/card/:id (guid).
 * По аналогии с mqtt_stellarcards CardsPollingService.
 */

import { getConfig } from '../../../../config/index.js';
import {
  getDatabaseService,
  getPaymentHttpClient,
  recordAdapterPollingCycleError,
} from '../../../../infra/index.js';
import type { AdapterPollerHandle } from '../types.js';
import { logger } from '../../../../infra/logger.js';
import { encryptCardCredentials } from '../../../../infra/encryption/cardCredentials.js';
import { acquirePollingLease } from '../../../../infra/pollingLease.js';
import { upsertProviderCard } from '../../../cards/index.js';

interface StellarCardListResponse {
  count?: number;
  next?: string | null;
  results?: Array<{ id: number; guid?: string; number?: string }>;
}

interface StellarCardById {
  id?: number;
  guid?: string;
  number?: string;
  bin?: string;
  billing_address?: string;
}

const POLL_INTERVAL_MS = 60 * 1000; // 1 мин между циклами
const PAGE_SIZE = 100;

function formatDateForApi(date: Date): string {
  return date.toISOString();
}

/** Детерминированный числовой id из guid для bank_cards.card_number (UNIQUE); полный номер может быть только из proxy. */
function guidToCardNumber(guid: string): number {
  const hex = guid.replace(/-/g, '').slice(0, 12);
  const n = parseInt(hex, 16);
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

export async function startStellarcardsCardsPolling(): Promise<AdapterPollerHandle> {
  const config = getConfig();
  const http = getPaymentHttpClient(config);
  const db = getDatabaseService(config);

  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        const hasLease = await acquirePollingLease(db, 'stellarcards.cards', 60);
        if (!hasLease) {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          continue;
        }

        const now = new Date();
        const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const date_start = formatDateForApi(from);
        const date_end = formatDateForApi(now);

        let page = 1;
        let hasMore = true;

        while (hasMore && !stopped) {
          const listRes = await http.request<StellarCardListResponse>({
            bank: 'stellarcards',
            method: 'GET',
            path: '/api/card',
            query: {
              date_start,
              date_end,
              ordering: '-id',
              page,
              page_size: PAGE_SIZE,
            },
          });

          const results = listRes?.results ?? [];
          if (results.length === 0) break;

          for (const card of results) {
            if (stopped) break;
            try {
              // Шаг 1: полная информация по карте (без кредов)
              const full = await http.request<StellarCardById>({
                bank: 'stellarcards',
                method: 'GET',
                path: `/api/card/${card.id}`,
              });

              const guid = full?.guid ?? card.guid;
              if (!guid) {
                logger.warn('Stellarcards card missing guid', { cardId: card.id });
                continue;
              }

              // Шаг 2: если карта уже есть в bank_cards по ext_id=guid — пропускаем креды и карту
              const existsRes = await db.withTransaction('main', async (client) => {
                const r = await client.query<{ exists: boolean }>(
                  `SELECT EXISTS (
                     SELECT 1 FROM public.bank_cards
                     WHERE bank = 'stellarcards' AND ext_id = $1
                   ) AS exists`,
                  [guid],
                );
                return r.rows[0]?.exists ?? false;
              });
              if (existsRes) {
                logger.info('Stellarcards card already exists, skipping', { guid, cardId: card.id });
                continue;
              }

              // Шаг 3: запрос деталей карты через proxy (cvv, expiration_date, полный номер).
              let encryptedCreds: string | null = null;
              let cardNumberStr: string | null = null;
              try {
                const detail = await http.request<{
                  card_number?: string;
                  cvv?: string;
                  expiration_date?: string;
                }>({
                  bank: 'stellarcards',
                  method: 'GET',
                  // Детальный proxy: STELLARCARDS_DETAIL_PROXY_URL в baseUrlOverride, путь /api/card/:id/detail
                  baseUrlOverride: config.providers.stellarcards?.detailProxyUrl,
                  path: `/api/card/${card.id}/detail`,
                });

                if (detail?.card_number && detail?.cvv && detail?.expiration_date) {
                  cardNumberStr = String(detail.card_number);
                  encryptedCreds = encryptCardCredentials({
                    cardNumber: String(detail.card_number),
                    cardCvv: String(detail.cvv),
                    cardExpire: String(detail.expiration_date),
                  });
                } else {
                  logger.warn('Stellarcards card detail missing fields, skipping creds', { cardId: card.id });
                }
              } catch (err) {
                logger.error('Stellarcards adapter: failed to get card detail, skipping creds', {
                  cardId: card.id,
                  error: err instanceof Error ? err.message : String(err),
                });
              }

              // Шаг 4: если детальный номер не получили, используем номер из full/list или guidToCardNumber.
              if (!cardNumberStr) {
                const fallbackNum = full?.number ?? card.number;
                cardNumberStr = fallbackNum ? String(fallbackNum) : null;
              }

              const parsedNumber = cardNumberStr ? parseInt(cardNumberStr.replace(/\D/g, ''), 10) : null;
              const cardNumber = Number.isFinite(parsedNumber)
                ? (parsedNumber as number)
                : guidToCardNumber(guid);

              const accNo = 'FEBRUARY';

              await db.withTransaction('main', async (client) => {
                await upsertProviderCard(client, {
                  bank: 'stellarcards',
                  cardNumber,
                  accNo,
                  createdAt: new Date(),
                  note: null,
                  creds: encryptedCreds ?? undefined,
                  extId: guid,
                  source: 'stellarcards_polling',
                });
              });
            } catch (err) {
              logger.error('Stellarcards adapter: failed to upsert card', {
                cardId: card.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          if (!listRes?.next || results.length < PAGE_SIZE) hasMore = false;
          else page += 1;
        }
      } catch (err) {
        logger.warn('Stellarcards adapter cards polling error', err as Error);
        await recordAdapterPollingCycleError(config, 'stellarcards', 'stellarcards.cards', err);
      }

      if (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    }
  };

  void loop();
  return { async stop() { stopped = true; } };
}

/** Одноразовая проверка интеграции: один запрос /api/card, вернуть количество карт. */
export async function probeStellarcardsCards(): Promise<number> {
  const config = getConfig();
  if (!config.providers.stellarcards) {
    throw new Error('STELLARCARDS_BASE_URL не задан, провайдер stellarcards не сконфигурирован');
  }
  const http = getPaymentHttpClient(config);

  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const date_start = formatDateForApi(from);
  const date_end = formatDateForApi(now);

  const listRes = await http.request<StellarCardListResponse>({
    bank: 'stellarcards',
    method: 'GET',
    path: '/api/card',
    query: {
      date_start,
      date_end,
      ordering: '-id',
      page: 1,
      page_size: PAGE_SIZE,
    },
  });

  const results = listRes?.results ?? [];
  return Array.isArray(results) ? results.length : 0;
}
