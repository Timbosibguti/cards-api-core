import dotenv from 'dotenv';

// Порядок важен: .env.local перекрывает .env (как в других bin‑скриптах)
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local', override: true });

import { createEcardsCards } from '../modules/transactions/adapters/ecards/create.js';

async function main(): Promise<void> {
  // const [, , binArg, qtyArg] = process.argv;
  const binArg = '428842';
  const qtyArg = '1';

  const bin = Number.parseInt(binArg, 10);
  const quantity = Number.parseInt(qtyArg, 10);

  if (!Number.isFinite(bin) || bin <= 0) {
    // eslint-disable-next-line no-console
    console.error(`BIN должен быть положительным числом, получено: ${binArg}`);
    process.exitCode = 1;
    return;
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    // eslint-disable-next-line no-console
    console.error(`quantity должен быть положительным числом, получено: ${qtyArg}`);
    process.exitCode = 1;
    return;
  }

  try {
    const result = await createEcardsCards(bin, quantity);
    // eslint-disable-next-line no-console
    console.log(
      `Ecards: запрос на выпуск карт по BIN ${bin} (${quantity} шт.), создано по ответу провайдера: ${result.created}`,
    );
  } catch (err) {
    const e = err as Error;
    // eslint-disable-next-line no-console
    console.error(`Ошибка выпуска карт eCards по BIN ${bin}: ${e.message}`);
    process.exitCode = 1;
  }
}

void main();

