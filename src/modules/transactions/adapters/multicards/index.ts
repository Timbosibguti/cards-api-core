import type { TransactionsAdapter } from '../types.js';
import { normalizeMulticardsTransaction, resolveMulticardsOwner, startMulticardsTransactionsPolling } from './transactions.js';
import { handleMulticardsWebhook } from './webhook.js';
import { createMulticardsCards } from './create.js';
import { startMulticardsCardsPolling } from './cards.js';
import { blockMulticardsCard } from '../../../cardBlock/providers/multicards.js';

async function blockMulticardsCardAdapter(params: {
  cardNumber: number;
  extId: string | null;
}): Promise<void> {
  if (params.extId == null || params.extId === '') {
    throw new Error('multicards: ext_id is required');
  }
  await blockMulticardsCard({ extId: params.extId });
}

export const multicardsAdapter: TransactionsAdapter = {
  bank: 'multicards',

  normalize: normalizeMulticardsTransaction,

  resolveOwner: resolveMulticardsOwner,

  startTransactionsPolling: startMulticardsTransactionsPolling,

  startCardsPolling: startMulticardsCardsPolling,

  handleWebhook: handleMulticardsWebhook,

  create: createMulticardsCards,

  blockCard: blockMulticardsCardAdapter,
};

