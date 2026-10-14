import type { TransactionsAdapter } from '../types.js';
import { normalizeStellarcardsTransaction, resolveStellarcardsOwner, startStellarcardsTransactionsPolling } from './transactions.js';
import { startStellarcardsCardsPolling } from './cards.js';
import { handleStellarcardsWebhook } from './webhook.js';
import { blockStellarcardsCard } from '../../../cardBlock/providers/stellarcards.js';

async function blockStellarcardsCardAdapter(params: {
  cardNumber: number;
  extId: string | null;
}): Promise<void> {
  if (params.extId == null || params.extId === '') {
    throw new Error('stellarcards: ext_id is required');
  }
  await blockStellarcardsCard({ extId: params.extId });
}

export const stellarcardsAdapter: TransactionsAdapter = {
  bank: 'stellarcards',

  normalize: normalizeStellarcardsTransaction,

  resolveOwner: resolveStellarcardsOwner,

  startTransactionsPolling: startStellarcardsTransactionsPolling,

  startCardsPolling: startStellarcardsCardsPolling,

  handleWebhook: handleStellarcardsWebhook,

  blockCard: blockStellarcardsCardAdapter,
};

