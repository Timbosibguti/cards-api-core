/**
 * HTTP-сервер (Fastify). Роуты подключаются здесь.
 * Entrypoint для API — запуск из index.ts.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { getConfig } from '../config/index.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerPaymentWebhooks } from './routes/payments.js';
import { registerMobileSmsWebhooks } from './routes/mobileSms.js';
import { registerQueueRoutes } from './routes/queue.js';
import { registerDraftRoutes } from './routes/draft.js';
import { registerStatementsRoutes } from './routes/statements.js';
import { registerBalancesRoutes } from './routes/balances.js';
import { registerCardsRoutes } from './routes/cards.js';
import { registerBankRoutes } from './routes/bank.js';
import { registerDevRoutes } from './routes/dev.js';
import { registerFarmRoutes } from './routes/farm.js';
import { registerTaurusRoutes } from './routes/taurus.js';
import { registerEventsIngestRoutes } from './routes/eventsIngest.js';
import { registerGoogleRoutes } from './routes/google.js';
import { registerSpendRoutes } from './routes/spend.js';
import { registerCardBlockRoutes } from './routes/cardBlock.js';
import { registerCardBlockBulkRoutes } from './routes/cardBlockBulk.js';

export async function createServer(): Promise<FastifyInstance> {
  const config = getConfig();
  const server = Fastify({ logger: config.nodeEnv !== 'test' });

  await registerHealthRoutes(server);
  await registerPaymentWebhooks(server);
  await registerMobileSmsWebhooks(server);
  await registerQueueRoutes(server);
  await registerDraftRoutes(server);
  await registerStatementsRoutes(server);
  await registerBalancesRoutes(server);
  await registerCardsRoutes(server);
  await registerBankRoutes(server);
  await registerTaurusRoutes(server);
  await registerEventsIngestRoutes(server);
  await registerFarmRoutes(server);
  await registerGoogleRoutes(server);
  await registerSpendRoutes(server);
  await registerCardBlockRoutes(server);
  await registerCardBlockBulkRoutes(server);
  if (config.devSimulation.enabled) {
    await registerDevRoutes(server);
  }

  return server;
}

function getPortOverrideFromArgs(): number | null {
  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') {
      const value = argv[i + 1];
      if (!value) break;
      const n = Number(value);
      if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    }
    if (arg.startsWith('--port=')) {
      const value = arg.slice('--port='.length);
      const n = Number(value);
      if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    }
  }

  return null;
}

export async function startServer(server: FastifyInstance): Promise<string> {
  const config = getConfig();
  const host = '0.0.0.0';
  const override = getPortOverrideFromArgs();
  const port = override ?? config.httpPort;
  await server.listen({ host, port });
  return `http://${host}:${port}`;
}
