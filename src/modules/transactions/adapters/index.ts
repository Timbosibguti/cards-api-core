import type { BankId } from '../types.js';
import type { AdapterPollerHandle, TransactionsAdapter } from './types.js';
import { ecardsAdapter } from './ecards/index.js';
import { adscardsAdapter } from './adscards/index.js';
import { multicardsAdapter } from './multicards/index.js';
import { stellarcardsAdapter } from './stellarcards/index.js';

const registry: Record<BankId, TransactionsAdapter> = {
  ecards: ecardsAdapter,
  adscards: adscardsAdapter,
  multicards: multicardsAdapter,
  stellarcards: stellarcardsAdapter,
};

export function getTransactionsAdapter(bank: BankId): TransactionsAdapter | null {
  return registry[bank] ?? null;
}

export async function startAllTransactionAdapters(): Promise<{ stopAll(): Promise<void> }> {
  const handles: AdapterPollerHandle[] = [];

  for (const adapter of Object.values(registry)) {
    if (adapter.startTransactionsPolling) {
      const txHandle = await adapter.startTransactionsPolling();
      handles.push(txHandle);
    }
    if (adapter.startCardsPolling) {
      const cardsHandle = await adapter.startCardsPolling();
      handles.push(cardsHandle);
    }
    if (adapter.startOtpPolling) {
      const otpHandle = await adapter.startOtpPolling();
      handles.push(otpHandle);
    }
    if (adapter.startBalancePolling) {
      const balanceHandle = await adapter.startBalancePolling();
      handles.push(balanceHandle);
    }
  }

  return {
    async stopAll() {
      await Promise.all(handles.map((h) => h.stop()));
    },
  };
}

