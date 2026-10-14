/**
 * Entrypoint Processor-Hub.
 * Чистый Node.js: HTTP (Fastify) + фоновые воркеры стартуют здесь.
 * DatabaseService и MqttClient создаются при первом обращении (синглтоны).
 */

import dotenv from 'dotenv';
import { getConfig } from './config/index.js';
import { createServer, startServer } from './api/server.js';
import { getDatabaseService, getMqttPublisher, getMqttSubscriber, getProcessingRuntime } from './infra/index.js';
import { logger } from './infra/logger.js';
import { subscribeAll } from './mqtt/index.js';
import { startAllTransactionAdapters } from './modules/transactions/adapters/index.js';
import { startDevInboxWorker } from './infra/devInboxWorker.js';
import { startCardBlockQueueWorker } from './infra/cardBlockQueueWorker.js';

// Load .env files for local/dev runs (node/VSCode "Run").
// Order matters: .env.local overrides .env.
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local', override: true });

async function main(): Promise<void> {
  const config = getConfig(); // fail-fast при отсутствии обязательных env

  // Диагностика при старте: почему может не доходить до Slack / не появляться bank_transactions
  const slackCh = config.slack.allToChannel?.trim() || null;
  const slackUrl = (config.slack.appUrl ?? '').trim();
  const slackKey = !!(config.slack.apiKey || config.slack.apiToken);
  logger.info('Slack config at startup', {
    allToChannel: slackCh ?? '(not set — сообщения в реальные каналы)',
    appUrlSet: !!slackUrl,
    apiKeySet: slackKey,
    hint: !slackUrl || !slackKey ? 'Сообщения в Slack не отправятся: задайте SLACK_APP_URL и SLACK_APP_API_KEY (или SLACK_ALL_TO_CHANNEL=dev-hub для редиректа)' : undefined,
  });
  logger.info('bank_transactions заполняются воркером из incoming_transactions. Источники incoming: вебхуки (POST /api/webhooks/.../transaction), адаптеры (ecards/stellarcards polling), dev inbox. Если bank_transactions пустая — проверьте наличие записей в incoming_transactions и их статус.');
  logger.info('MQTT: два коннекта (publish / subscribe) с разными clientId — подписчик получает наши публикации в sequoia/otp и др.');

  const db = getDatabaseService(config);
  const mqttSubscriber = getMqttSubscriber(config);
  const runtime = getProcessingRuntime();
  const adaptersRuntime = await startAllTransactionAdapters();

  const server = await createServer();
  const url = await startServer(server);
  logger.info(`HTTP server listening at ${url}`);

  await runtime.start();
  logger.info('Processing runtime (workers + stuck job) started');

  const cardBlockQueueWorker = startCardBlockQueueWorker();
  logger.info('Card block queue worker started');

  const devInboxWorker = startDevInboxWorker();
  if (config.devSimulation.enabled) {
    logger.info('Dev simulation enabled: DevInboxWorker started, /dev/* routes registered');
  }

  await subscribeAll(mqttSubscriber, config);
  logger.info('MQTT handlers subscribed');

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down...`);
    await devInboxWorker.stop();
    await cardBlockQueueWorker.stop();
    await adaptersRuntime.stopAll();
    await runtime.stop();
    await server.close();
    await mqttSubscriber.disconnect();
    await getMqttPublisher(config).disconnect();
    await db.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Fatal error', err);
  process.exit(1);
});
