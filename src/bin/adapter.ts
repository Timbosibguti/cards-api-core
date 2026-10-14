import dotenv from 'dotenv';

// Порядок важен: .env.local перекрывает .env (как в bootstrap.ts)
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local', override: true });

import type { BankId } from '../modules/transactions/types.js';
import { probeEcardsCards } from '../modules/transactions/adapters/ecards/cards.js';
import { probeEcardsTransactions } from '../modules/transactions/adapters/ecards/transactions.js';
import { probeAdscardsCards } from '../modules/transactions/adapters/adscards/cards.js';
import { probeAdscardsTransactions } from '../modules/transactions/adapters/adscards/transactions.js';
import { probeStellarcardsCards } from '../modules/transactions/adapters/stellarcards/cards.js';
import { probeStellarcardsTransactions } from '../modules/transactions/adapters/stellarcards/transactions.js';
import { probeMulticardsTransactions } from '../modules/transactions/adapters/multicards/transactions.js';
import { probeMulticardsCards } from '../modules/transactions/adapters/multicards/cards.js';

async function main(): Promise<void> {
  const bankArg = process.argv[2] as string | undefined;
  const allowed: BankId[] = ['ecards', 'adscards', 'multicards', 'stellarcards'];

  if (!bankArg || !allowed.includes(bankArg as BankId)) {
    // eslint-disable-next-line no-console
    console.error(
      `Использование: npm run adapter <${allowed.join(
        '|',
      )}>\nНапример: npm run adapter ecards`,
    );
    process.exitCode = 1;
    return;
  }

  const bank = bankArg as BankId;
  try {
    switch (bank) {
      case 'ecards': {
        const [cards, tx] = await Promise.all([
          probeEcardsCards(),
          probeEcardsTransactions(),
        ]);
        // eslint-disable-next-line no-console
        console.log(`ecards: получено ${tx} транзакций, получено ${cards} карт`);
        break;
      }
      case 'adscards': {
        const [cards, tx] = await Promise.all([
          probeAdscardsCards(),
          probeAdscardsTransactions(),
        ]);
        // eslint-disable-next-line no-console
        console.log(`adscards: получено ${tx} транзакций, получено ${cards} карт`);
        break;
      }
      case 'stellarcards': {
        const [cards, tx] = await Promise.all([
          probeStellarcardsCards(),
          probeStellarcardsTransactions(),
        ]);
        // eslint-disable-next-line no-console
        console.log(`stellarcards: получено ${tx} транзакций, получено ${cards} карт`);
        break;
      }
      case 'multicards': {
      const [cards, tx] = await Promise.all([
        probeMulticardsCards(),
        probeMulticardsTransactions(),
      ]);
        // eslint-disable-next-line no-console
        console.log(
        `multicards: получено ${tx} транзакций, получено ${cards} карт`,
        );
        break;
      }
      default:
        // eslint-disable-next-line no-console
        console.error(`Банк ${bank} не поддерживается скриптом adapter`);
        process.exitCode = 1;
    }
  } catch (e) {
    const err = e as Error;
    // eslint-disable-next-line no-console
    console.error(
      `${bank}: ошибка получения данных от платёжной системы: ${err.message}`,
    );
    process.exitCode = 1;
  }
}

void main();

