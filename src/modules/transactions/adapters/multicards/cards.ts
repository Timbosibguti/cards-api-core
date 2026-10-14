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
import { upsertProviderCard } from '../../../cards/index.js';
import {
  buyerEmailFromBinomRow,
  formatMulticardsAccNoFromBinom,
  getBinomByAffId,
} from '../../../binom/index.js';
import { ensureMulticardsToken } from './transactions.js';
import { encryptCardCredentials } from '../../../../infra/encryption/cardCredentials.js';

interface MulticardsCardGroup {
  id?: number;
  name?: string | null;
  owner?: string | null;
}

interface MulticardsCard {
  id?: number;
  cardNumber?: string;
  issued_at?: string;
  status?: string;
  currency?: string;
  cardGroup?: MulticardsCardGroup | null;
  cardGroupName?: string | null;
  bankId?: number;
  note?: string | null;
  cardCvv?: string;
  cardExpiryMonth?: string;
  cardExpiryYear?: string;
}

const MULTICARDS_CARDS_POLL_INTERVAL_MS = 60 * 1000; // 1 минута

function parseMulticardsAffId(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  const n = Number.parseInt(trimmed, 10);
  return Number.isNaN(n) ? null : n;
}

/** Поллинг карт Multicards (GET /v1/card/list). */
export async function startMulticardsCardsPolling(): Promise<AdapterPollerHandle> {
  const config = getConfig();
  const http = getPaymentHttpClient(config);
  const db = getDatabaseService(config);

  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        const hasLease = await acquirePollingLease(db, 'multicards.cards', 60);
        if (!hasLease) {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          continue;
        }

        updatePollerStatus('multicards.cards', {
          entity: 'cards',
          bank: 'multicards',
          lastCycleStartedAt: new Date().toISOString(),
          processedInLastCycle: 0,
          lastError: undefined,
        });

        const accessToken = await ensureMulticardsToken(config, http);

        logger.info('Multicards adapter: starting cards polling cycle');

        const resp = await http.request<MulticardsCard[]>({
          bank: 'multicards',
          method: 'GET',
          path: '/v1/card/list',
          headers: {
            'x-auth-token': accessToken,
            'Content-Type': 'application/json',
          },
        });

        const cards = Array.isArray(resp) ? resp : [];
        let processed = 0;

        for (const card of cards) {
          if (stopped) break;

          const cardId = typeof card.id === 'number' ? card.id : null;
          if (!cardId) continue;

          const affRaw = (card.cardGroup?.name ?? card.cardGroupName) ?? null;
          const affId = parseMulticardsAffId(affRaw);

          try {
            await db.withTransaction('main', async (client) => {
              const binomRow = affId != null ? await getBinomByAffId(client, affId) : null;
              const buyer = buyerEmailFromBinomRow(binomRow);
              const accNo =
                affId != null
                  ? formatMulticardsAccNoFromBinom(binomRow, affId)
                  : 'FEBRUARY';

              const issuedAt =
                (card.issued_at && !Number.isNaN(Date.parse(card.issued_at)))
                  ? new Date(card.issued_at)
                  : new Date();

                let encryptedCreds: string | null = null;
                if (card.cardNumber && card.cardCvv && card.cardExpiryMonth && card.cardExpiryYear) {
                  try {
                    encryptedCreds = encryptCardCredentials({
                      cardNumber: card.cardNumber,
                      cardCvv: card.cardCvv,
                      cardExpire: `${card.cardExpiryMonth}/${card.cardExpiryYear}`,
                    });
                  } catch (err) {
                    logger.error('Multicards adapter: failed to encrypt card credentials', {
                      cardNumber: card.cardNumber,
                      error: err instanceof Error ? err.message : String(err),
                    });
                    encryptedCreds = null;
                  }
                }
      
              await upsertProviderCard(client, {
                bank: 'multicards',
                cardNumber: card.cardNumber ? parseInt(card.cardNumber, 10) : cardId,
                accNo,
                createdAt: issuedAt,
                note: '',
                extId: String(cardId),
                buyer,
                source: 'multicards_polling',
                creds: encryptedCreds ?? undefined,
              });
            });

            processed += 1;
            updatePollerStatus('multicards.cards', {
              entity: 'cards',
              bank: 'multicards',
              processedInLastCycle: processed,
            });
          } catch (err) {
            logger.error('Multicards adapter: failed to upsert card', {
              cardId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        updatePollerStatus('multicards.cards', {
          entity: 'cards',
          bank: 'multicards',
          processedInLastCycle: processed,
          lastCycleFinishedAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.warn('Multicards adapter cards polling error', err as Error);
        await recordAdapterPollingCycleError(config, 'multicards', 'multicards.cards', err);
        updatePollerStatus('multicards.cards', {
          entity: 'cards',
          bank: 'multicards',
          lastError: err instanceof Error ? err.message : String(err),
          lastCycleFinishedAt: new Date().toISOString(),
        });
      }

      if (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, MULTICARDS_CARDS_POLL_INTERVAL_MS));
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

/** Одноразовая проверка интеграции: один запрос /v1/card/list, вернуть количество карт. */
export async function probeMulticardsCards(): Promise<number> {
  const config = getConfig();
  if (!config.providers.multicards) {
    throw new Error('MULTICARDS_BASE_URL не задан, провайдер multicards не сконфигурирован');
  }
  const http = getPaymentHttpClient(config);
  const accessToken = await ensureMulticardsToken(config, http);

  const resp = await http.request<MulticardsCard[]>({
    bank: 'multicards',
    method: 'GET',
    path: '/v1/card/list',
    headers: {
      'x-auth-token': accessToken,
      'Content-Type': 'application/json',
    },
  });

  const cards = Array.isArray(resp) ? resp : [];
  return cards.length;
}

