import { getConfig } from '../../../../config/index.js';
import {
  getDatabaseService,
  getPaymentHttpClient,
  recordAdapterPollingCycleError,
} from '../../../../infra/index.js';
import { logger } from '../../../../infra/logger.js';
import { acquirePollingLease } from '../../../../infra/pollingLease.js';
import type { AdapterPollerHandle } from '../types.js';
import { encryptCardCredentials } from '../../../../infra/encryption/cardCredentials.js';
import {
  claimEcardsBuyerQueueSlotForBin,
  completeEcardsBuyerQueueRow,
  failEcardsBuyerQueueRow,
  type ClaimBuyerQueueSlotResult,
} from '../../../cards/ecardsBuyerCardIssueQueue.js';
import { getBuyerFromBinom } from '../../../binom/index.js';
import { upsertProviderCard } from '../../../cards/index.js';
import { getEcardsAccessToken, resolveEcardsBin } from './create.js';
import {
  createEcardsCardGroup,
  fetchEcardsCardGroupList,
  findEcardsCardGroupIdByName,
  patchEcardsCardCardGroups,
} from './ecardsCardGroupAssign.js';

interface EcardsCardPage {
  data?: {
    content?: EcardsRawCard[];
  };
}

interface EcardsRawCard {
  id?: number;
  cardNumber?: string;
  cardCvv?: string | null;
  cardExpire?: string | null;
  account?: { name?: string | null } | null;
  createdAt?: string;
  note?: string | null;
  status?: string;
  groupsRelations?:
    | {
        cardGroup?: {
          name?: string | null;
        } | null;
      }[]
    | null;
}

export function extractAffIdFromGroupName(name: string | null | undefined): number | null {
  if (!name) return null;
  const trimmed = String(name).trim();
  if (!trimmed) return null;
  const slashMatch = trimmed.match(/\s*\/\s*(\d+)\s*$/);
  if (slashMatch?.[1]) {
    const n = Number.parseInt(slashMatch[1], 10);
    return Number.isNaN(n) ? null : n;
  }
  const spaceMatch = trimmed.match(/(\d+)\s*$/);
  if (spaceMatch?.[1]) {
    const n = Number.parseInt(spaceMatch[1], 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/** Разбор aff_id из всего текста заметки: сегменты через `;` (как после склейки note + группы). */
export function extractAffIdFromNoteText(text: string | null | undefined): number | null {
  if (text == null) return null;
  const full = String(text).trim();
  if (!full) return null;
  const segments = full
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.replace(/[\s;]+/g, '').length > 0);
  const toScan = segments.length > 0 ? segments : [full];
  for (const seg of toScan) {
    const id = extractAffIdFromGroupName(seg);
    if (id != null) return id;
  }
  return null;
}

const DEFAULT_LIMIT = 100;
const SLEEP_BETWEEN_PAGES_MS = 300;
const SLEEP_BETWEEN_CYCLES_MS = 60_000;

const ECARDS_CARD_GROUP_THEME_ID = Number.parseInt(process.env.ECARDS_CARD_GROUP_THEME_ID ?? '1', 10) || 1;

function ecardsCardHasAssignedGroup(card: EcardsRawCard): boolean {
  const gr = card.groupsRelations;
  if (!Array.isArray(gr) || gr.length === 0) {
    return false;
  }
  return gr.some((rel) => {
    const n = rel?.cardGroup?.name;
    return n != null && String(n).trim() !== '';
  });
}

export async function startEcardsCardsPolling(): Promise<AdapterPollerHandle> {
  const config = getConfig();
  const http = getPaymentHttpClient(config);
  const db = getDatabaseService(config);

  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        const hasLease = await acquirePollingLease(db, 'ecards.cards', 60);
        if (!hasLease) {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          continue;
        }

        logger.info('Ecards adapter: starting cards polling cycle');
        let cardOffset = 0;

        while (true) {
          const cardPage = await http.request<EcardsCardPage>({
            bank: 'ecards',
            method: 'GET',
            path: '/card',
            query: {
              offset: String(cardOffset),
              limit: String(DEFAULT_LIMIT),
              sortBy: 'id',
              sortDirection: 'desc',
              'filterStatus[]': 'active',
            },
          });

          const cards = cardPage.data?.content ?? [];
          if (cards.length === 0) {
            logger.info('Ecards adapter: no more cards to process in this polling cycle', {
              lastOffset: cardOffset,
            });
            break;
          }

          for (const card of cards) {
            if (stopped) break;
            const numberStr = card.cardNumber ? String(card.cardNumber).replace(/\s+/g, '') : null;
            if (!numberStr) continue;
            const cardNumber = Number.parseInt(numberStr, 10);
            if (!Number.isFinite(cardNumber)) continue;

            let encryptedCreds: string | null = null;
            if (card.cardNumber && card.cardCvv && card.cardExpire) {
              try {
                encryptedCreds = encryptCardCredentials({
                  cardNumber: card.cardNumber,
                  cardCvv: card.cardCvv,
                  cardExpire: card.cardExpire,
                });
              } catch (err) {
                logger.error('Ecards adapter: failed to encrypt card credentials', {
                  cardNumber: numberStr,
                  error: err instanceof Error ? err.message : String(err),
                });
                encryptedCreds = null;
              }
            }

            const accNo = card.account?.name ?? null;
            const createdAt = card.createdAt ? new Date(card.createdAt) : new Date();
            let note = card.note != null ? String(card.note).trim() : '';

            const groups = Array.isArray(card.groupsRelations) ? card.groupsRelations : [];
            if (groups.length > 0) {
              const groupNames = groups
                .map((rel) => rel?.cardGroup?.name)
                .filter((name): name is string => !!name)
                .map((name) => String(name).trim())
                .filter((name) => name.replace(/[\s;]+/g, '').length > 0);

              if (groupNames.length > 0) {
                note = note ? `${note};${groupNames.join(';')}` : groupNames.join(';');
              }
            }

            const bin6 =
              numberStr.length >= 6 ? Number.parseInt(numberStr.slice(0, 6), 10) : Number.NaN;
            let queueGroupAffSuffix: string | null = null;
            if (
              Number.isFinite(bin6) &&
              resolveEcardsBin(bin6) != null &&
              card.id != null &&
              !ecardsCardHasAssignedGroup(card)
            ) {
              let queueClaim: ClaimBuyerQueueSlotResult | undefined;
              try {
                queueClaim = await db.withTransaction('main', async (client) =>
                  claimEcardsBuyerQueueSlotForBin(client, bin6),
                );
                if (queueClaim.kind === 'claimed') {
                  const qid = queueClaim.queueId;
                  try {
                    const accessToken = await getEcardsAccessToken();
                    const groupName = queueClaim.groupName;
                    const groupList = await fetchEcardsCardGroupList(http, accessToken);
                    let groupId = findEcardsCardGroupIdByName(groupList, groupName);
                    if (groupId == null) {
                      groupId = await createEcardsCardGroup(
                        http,
                        accessToken,
                        groupName,
                        ECARDS_CARD_GROUP_THEME_ID,
                      );
                    }
                    await patchEcardsCardCardGroups(http, accessToken, card.id, [groupId]);
                    queueGroupAffSuffix = groupName;
                    await db.withTransaction('main', async (client) =>
                      completeEcardsBuyerQueueRow(client, qid),
                    );
                    logger.info('Ecards adapter: card assigned to buyer queue card-group', {
                      queue_id: qid,
                      ecards_card_id: card.id,
                      group_id: groupId,
                      aff_id: queueClaim.affId,
                      group_name: groupName,
                      bin: bin6,
                    });
                  } catch (assignErr) {
                    const msg = assignErr instanceof Error ? assignErr.message : String(assignErr);
                    try {
                      await db.withTransaction('main', async (client) =>
                        failEcardsBuyerQueueRow(client, qid, msg),
                      );
                    } catch (failDbErr) {
                      logger.error('Ecards adapter: failed to persist buyer queue row failure', {
                        queue_id: qid,
                        error: failDbErr instanceof Error ? failDbErr.message : String(failDbErr),
                      });
                    }
                    logger.error('Ecards adapter: buyer queue card-group assign failed', {
                      card_id: card.id,
                      bin: bin6,
                      error: msg,
                    });
                  }
                }
              } catch (claimErr) {
                logger.error('Ecards adapter: buyer queue claim failed', {
                  bin: bin6,
                  error: claimErr instanceof Error ? claimErr.message : String(claimErr),
                });
              }
            }

            if (queueGroupAffSuffix) {
              note = note ? `${note};${queueGroupAffSuffix}` : queueGroupAffSuffix;
            }

            const affId = extractAffIdFromNoteText(note);
            const finalNote = note || null;
            const extId = card.id != null ? String(card.id) : null;

            try {
              await db.withTransaction('main', async (client) => {
                let buyer: string | null = null;

                if (affId != null) {
                  buyer = await getBuyerFromBinom(client, affId);
                }

                await upsertProviderCard(client, {
                  bank: 'ecards',
                  cardNumber,
                  accNo,
                  createdAt,
                  note: finalNote,
                  creds: encryptedCreds ?? undefined,
                  extId: extId ?? undefined,
                  buyer: buyer ?? undefined,
                  source: 'ecards_polling',
                });
              });
            } catch (err) {
              logger.error('Ecards adapter: failed to upsert bank_cards for card', {
                cardNumber: numberStr,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          if (stopped) break;
          cardOffset += cards.length;
          await new Promise((resolve) => setTimeout(resolve, SLEEP_BETWEEN_PAGES_MS));
        }
      } catch (err) {
        logger.warn('Ecards adapter cards polling error', err as Error);
        await recordAdapterPollingCycleError(config, 'ecards', 'ecards.cards', err);
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

/** Одноразовая проверка интеграции: один запрос /card, вернуть количество карт. */
export async function probeEcardsCards(): Promise<number> {
  const config = getConfig();
  if (!config.providers.ecards) {
    throw new Error('ECARDS_BASE_URL не задан, провайдер ecards не сконфигурирован');
  }
  const http = getPaymentHttpClient(config);

  const cardPage = await http.request<EcardsCardPage>({
    bank: 'ecards',
    method: 'GET',
    path: '/card',
    query: {
      offset: String(0),
      limit: String(DEFAULT_LIMIT),
      sortBy: 'id',
      sortDirection: 'desc',
      'filterStatus[]': 'active',
    },
  });

  return cardPage.data?.content?.length ?? 0;
}

