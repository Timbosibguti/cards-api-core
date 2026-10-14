/**
 * Health-check эндпоинты для мониторинга и оркестрации (K8s, load balancers).
 * P1.6 Production Readiness: /health, /readiness (проверка БД), /liveness.
 */

import type { FastifyInstance } from 'fastify';
import { getConfig } from '../../config/index.js';
import { getDatabaseService } from '../../infra/index.js';
import { getRuntimeStatusSnapshot } from '../../infra/runtimeStatus.js';

const SERVICE_NAME = 'processor-hub';

export async function registerHealthRoutes(server: FastifyInstance): Promise<void> {
  /** Базовый health: сервис жив, без проверки зависимостей. */
  server.get('/health', async (_request, reply) => {
    const now = new Date().toISOString();
    const runtime = getRuntimeStatusSnapshot();

    const pollersSummary = runtime.pollers.map((p) => ({
      id: p.id,
      bank: p.bank,
      entity: p.entity,
      lastCycleStartedAt: p.lastCycleStartedAt,
      lastCycleFinishedAt: p.lastCycleFinishedAt,
      processedInLastCycle: p.processedInLastCycle,
      totalInLastCycle: p.totalInLastCycle,
      lastItemCreatedAt: p.lastItemCreatedAt,
      lastError: p.lastError,
    }));

    const workersSummary = runtime.workers.map((w) => ({
      id: w.id,
      lastRunAt: w.lastRunAt,
      lastBatchCount: w.lastBatchCount,
      lastError: w.lastError,
    }));

    await reply.send({
      status: 'ok',
      service: SERVICE_NAME,
      timestamp: now,
      runtime: {
        pollers: pollersSummary,
        workers: workersSummary,
      },
    });
  });

  /**
   * Liveness: процесс жив. Оркестратор перезапускает под при не-200.
   * Зависимости не проверяем.
   */
  server.get('/liveness', async (_request, reply) => {
    await reply.send({ status: 'ok', service: SERVICE_NAME });
  });

  /**
   * Readiness: готов принимать трафик. При недоступности БД — 503.
   * Оркестратор не шлёт трафик до 200.
   */
  server.get('/readiness', async (_request, reply) => {
    const config = getConfig();
    const db = getDatabaseService(config);
    try {
      await db.withTransaction('main', async (client) => {
        await client.query('SELECT 1');
      });
      await reply.send({ status: 'ok', service: SERVICE_NAME });
    } catch (err) {
      server.log.error(err, 'Readiness check failed');
      await reply.status(503).send({
        status: 'unavailable',
        service: SERVICE_NAME,
        error: err instanceof Error ? err.message : 'Database check failed',
      });
    }
  });
}
