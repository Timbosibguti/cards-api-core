import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getConfig } from '../../config/index.js';
import { getDatabaseService } from '../../infra/index.js';
import { createCorrelationId } from '../../infra/correlation/index.js';
import { enqueueOutgoingNotification } from '../../infra/outgoingNotifications.js';
import { generateFarmNewGeoReport } from '../../infra/farmNewGeoReportWorker.js';

interface FarmQuery {
  prod?: string;
}

export async function registerFarmRoutes(server: FastifyInstance): Promise<void> {
  server.get<{ Querystring: FarmQuery }>('/farm', async (req: FastifyRequest<{ Querystring: FarmQuery }>, reply: FastifyReply) => {
    const prodFlag = req.query?.prod === 'true';
    const config = getConfig();
    const db = getDatabaseService(config);
    const correlationId = createCorrelationId();

    const { message, cutoffTomorrow00, rowsCount, blocks } = await generateFarmNewGeoReport();
    const dayKey = cutoffTomorrow00.toISOString().slice(0, 10);
    const dedupKey = `http:farm:${dayKey}:${prodFlag ? 'prod' : 'dev'}:${Date.now()}`;

    await db.withTransaction('main', async (client) => {
      await enqueueOutgoingNotification(client, {
        channel: prodFlag ? 'slack:#farm-new-geo' : 'slack:dm',
        recipient: prodFlag ? null : 'rpkoturbach@groscloud.com',
        payload: { kind: 'farm_new_geo_report', message, ...(blocks ? { blocks } : {}) },
        dedupKey,
        correlationId,
      });
    });

    return reply.send({
      ok: true,
      prod: prodFlag,
      dayKey,
      rows: rowsCount,
    });
  });
}

