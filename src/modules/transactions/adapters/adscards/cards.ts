/**
 * Поллинг карт AdsCard: POST /cards/list (status: 'A').
 * По аналогии с mqtt_adscards_transactions CardsPollingService.
 */

import { getConfig } from '../../../../config/index.js';
import {
  getDatabaseService,
  getPaymentHttpClient,
  recordAdapterPollingCycleError,
} from '../../../../infra/index.js';
import { logger } from '../../../../infra/logger.js';
import { acquirePollingLease } from '../../../../infra/pollingLease.js';
import { updatePollerStatus } from '../../../../infra/runtimeStatus.js';
import { encryptCardCredentials } from '../../../../infra/encryption/cardCredentials.js';
import type { AdapterPollerHandle } from '../types.js';
import { upsertProviderCard } from '../../../cards/index.js';
import {
  buyerEmailFromBinomRow,
  formatMulticardsAccNoFromBinom,
  getBinomByAffId,
} from '../../../binom/index.js';

/**
 * aff_id для Binom только из имени группы Ads (как при выпуске: `binom.username / aff_id` или строка `aff_id`).
 * id группы из API (`card.group`) не используем как aff_id.
 */
function extractAffIdFromAdsGroupName(groupName: string | undefined): number | null {
  if (groupName == null) return null;
  const s = groupName.trim();
  if (!s) return null;
  const slashMatch = s.match(/\s*\/\s*(\d+)$/);
  if (slashMatch?.[1]) return parseInt(slashMatch[1], 10) || null;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

function parseAdsCardDate(dateStr: string | undefined): Date {
  if (!dateStr) return new Date();
  const withTime = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (withTime) {
    const [, d, m, y, h, min, sec] = withTime;
    return new Date(parseInt(y!, 10), parseInt(m!, 10) - 1, parseInt(d!, 10), parseInt(h!, 10), parseInt(min!, 10), parseInt(sec!, 10));
  }
  const dateOnly = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dateOnly) {
    const [, d, m, y] = dateOnly;
    return new Date(parseInt(y!, 10), parseInt(m!, 10) - 1, parseInt(d!, 10));
  }
  return new Date();
}

interface AdsCardListItem {
  id?: number;
  number?: string;
  date_issued?: string;
  date_expired?: string;
  cvc?: string;
  cvv?: string;
  status?: string;
  group?: number;
  comment?: string;
  payment_info?: { card_holder?: string; address?: string; region?: string };
}

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 час

export async function startAdscardsCardsPolling(): Promise<AdapterPollerHandle> {
  const config = getConfig();
  const http = getPaymentHttpClient(config);
  const db = getDatabaseService(config);
  const provider = config.providers?.adscards;
  const authToken = provider?.authTokenForBody ?? provider?.apiKey ?? '';

  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        const hasLease = await acquirePollingLease(db, 'adscards.cards', 60);
        if (!hasLease) {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          continue;
        }

        updatePollerStatus('adscards.cards', {
          entity: 'cards',
          bank: 'adscards',
          lastCycleStartedAt: new Date().toISOString(),
          processedInLastCycle: 0,
          lastError: undefined,
        });

        const groups = await http.request<{ data?: Array<{ id: number; name: string | null }> }>({
          bank: 'adscards',
          method: 'POST',
          path: '/cards/groups',
          body: { auth_token: authToken },
        });
        const groupsData = (Array.isArray(groups?.data) ? groups.data : Object.values(groups?.data ?? {})) as Array<{
          id: number;
          name: string | null;
        }>;
        
        const listRes = await http.request<{ data?: AdsCardListItem[] | Record<string, AdsCardListItem> }>({
          bank: 'adscards',
          method: 'POST',
          path: '/teams/cards_list',
          body: { auth_token: authToken, status: 'A' },
        });

        let cards: AdsCardListItem[] = [];
        const data = listRes?.data;
        if (Array.isArray(data)) {
          cards = data;
        } else if (data && typeof data === 'object') {
          cards = Object.values(data);
        }

        let processed = 0;
        for (const card of cards) {
          if (stopped) break;
          const numberStr = card.number?.replace(/[\s-]/g, '');
          if (!numberStr) continue;
          const cardNumber = parseInt(numberStr, 10);
          if (!Number.isFinite(cardNumber)) continue;

          const group =
            card.group != null && groupsData.length > 0
              ? groupsData.find((g) => String(g.id) === String(card.group))
              : undefined;
          const groupName = (group?.name ?? '').trim();

          const affId = extractAffIdFromAdsGroupName(groupName || undefined);
          const createdAt = parseAdsCardDate(card.date_issued);
          const noteParts: string[] = [];
          if (card.payment_info?.card_holder) noteParts.push(`holder: ${card.payment_info.card_holder}`);
          if (card.payment_info?.region) noteParts.push(`region: ${card.payment_info.region}`);
          if (card.comment) noteParts.push(card.comment);
          const note = noteParts.length > 0 ? noteParts.join('; ') : null;
          const cardCvv = (card.cvc ?? card.cvv ?? '').trim();
          const cardExpire = (card.date_expired ?? '').trim();

          let encryptedCreds: string | null = null;
          if (numberStr && cardCvv && cardExpire) {
            try {
              encryptedCreds = encryptCardCredentials({
                cardNumber: numberStr,
                cardCvv,
                cardExpire,
              });
            } catch (err) {
              logger.error('Adscards adapter: failed to encrypt card credentials', {
                cardNumber: numberStr,
                error: err instanceof Error ? err.message : String(err),
              });
              encryptedCreds = null;
            }
          } else {
            logger.warn('Adscards adapter: card received without full credentials payload', {
              cardId: card.id ?? null,
              cardNumberLast4: numberStr.slice(-4),
              hasCvv: Boolean(cardCvv),
              hasExpire: Boolean(cardExpire),
            });
          }

          try {
            await db.withTransaction('main', async (client) => {
              let accNo: string;
              let buyer: string | null = null;
              if (affId != null) {
                const binomRow = await getBinomByAffId(client, affId);
                buyer = buyerEmailFromBinomRow(binomRow);
                accNo = formatMulticardsAccNoFromBinom(binomRow, affId);
              } else {
                accNo = groupName || 'FEBRUARY';
              }
              await upsertProviderCard(client, {
                bank: 'adscards',
                cardNumber,
                accNo,
                createdAt,
                note,
                extId: card.id != null ? String(card.id) : undefined,
                buyer: buyer ?? undefined,
                source: 'adscards_polling',
                creds: encryptedCreds ?? undefined,
              });
            });
            processed += 1;
            updatePollerStatus('adscards.cards', {
              entity: 'cards',
              bank: 'adscards',
              processedInLastCycle: processed,
              lastItemCreatedAt: createdAt.toISOString(),
            });
          } catch (err) {
            logger.error('Adscards adapter: failed to upsert card', {
              cardNumber: numberStr.slice(-4),
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        logger.warn('Adscards adapter cards polling error', err as Error);
        await recordAdapterPollingCycleError(config, 'adscards', 'adscards.cards', err);
        updatePollerStatus('adscards.cards', {
          entity: 'cards',
          bank: 'adscards',
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

/** Одноразовая проверка интеграции: один запрос /cards/list, вернуть количество карт. */
export async function probeAdscardsCards(): Promise<number> {
  const config = getConfig();
  const provider = config.providers.adscards;
  if (!provider || !provider.baseUrl) {
    throw new Error('ADSCARD_API_URL/ADSCARDS_BASE_URL не заданы, провайдер adscards не сконфигурирован');
  }

  const authToken = provider.authTokenForBody ?? provider.apiKey;
  if (!authToken) {
    throw new Error(
      'не установлен authTokenForBody/apiKey для adscards (переменные ADSCARD_AUTH_TOKEN / ADSCARDS_API_KEY)',
    );
  }

  const http = getPaymentHttpClient(config);
  const listRes = await http.request<{ data?: AdsCardListItem[] | Record<string, AdsCardListItem> }>({
    bank: 'adscards',
    method: 'POST',
    path: '/cards/list',
    body: { auth_token: authToken, status: 'A' },
  });

  const data = listRes?.data;
  if (Array.isArray(data)) {
    return data.length;
  }
  if (data && typeof data === 'object') {
    return Object.keys(data).length;
  }
  return 0;
}
