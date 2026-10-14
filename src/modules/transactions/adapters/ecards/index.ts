import type { TransactionsAdapter } from '../types.js';
import { normalizeEcardsTransaction, resolveEcardsOwner, startEcardsTransactionsPolling } from './transactions.js';
import { startEcardsCardsPolling } from './cards.js';
import { handleEcardsWebhook } from './webhook.js';
import { startEcardsOtpPolling } from './otp.js';
import { startEcardsBalancePolling } from './balances.js';
import { createEcardsCards, removeEcardsLimits } from './create.js';
import { blockEcardsCard } from '../../../cardBlock/providers/ecards.js';

export const ecardsAdapter: TransactionsAdapter = {
  bank: 'ecards',

  normalize: normalizeEcardsTransaction,

  resolveOwner: resolveEcardsOwner,

  startTransactionsPolling: startEcardsTransactionsPolling,

  startCardsPolling: startEcardsCardsPolling,

  startOtpPolling: startEcardsOtpPolling,

  startBalancePolling: startEcardsBalancePolling,

  handleWebhook: handleEcardsWebhook,

  create: createEcardsCards,

  removeLimits: removeEcardsLimits,

  blockCard: blockEcardsCard,
};

