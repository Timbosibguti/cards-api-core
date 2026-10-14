import type { TransactionsAdapter } from '../types.js';
import { normalizeAdscardsTransaction, resolveAdscardsOwner, startAdscardsTransactionsPolling } from './transactions.js';
import { startAdscardsCardsPolling } from './cards.js';
import { handleAdscardsWebhook } from './webhook.js';
import { createAdscardsCards } from './create.js';
import { blockAdscardsCard } from '../../../cardBlock/providers/adscards.js';

async function blockAdscardsCardAdapter(params: {
  cardNumber: number;
  extId: string | null;
}): Promise<void> {
  if (params.extId == null || params.extId === '') {
    throw new Error('adscards: ext_id is required');
  }
  await blockAdscardsCard({ extId: params.extId });
}

export const adscardsAdapter: TransactionsAdapter = {
  bank: 'adscards',

  normalize: normalizeAdscardsTransaction,

  resolveOwner: resolveAdscardsOwner,

  startTransactionsPolling: startAdscardsTransactionsPolling,

  startCardsPolling: startAdscardsCardsPolling,

  handleWebhook: handleAdscardsWebhook,

  create: createAdscardsCards,

  blockCard: blockAdscardsCardAdapter,
};

