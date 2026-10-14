/**
 * POST /api/events?dev=true — ingest событий от farm extension и др. в dev_inbox_events (spec §11).
 * Работает только при dev=true (query или body) и включённом dev simulation.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getConfig } from '../../config/index.js';
import { ingestToDevInbox, isDevRequest } from '../../infra/devInboxIngest.js';

interface EventsBody {
  source?: string;
  event_type: string;
  payload?: unknown;
  dev?: boolean;
}

export async function registerEventsIngestRoutes(server: FastifyInstance): Promise<void> {
  server.post<{ Querystring: { dev?: string }; Body: EventsBody }>(
    '/api/events',
    async (req: FastifyRequest<{ Querystring: { dev?: string }; Body: EventsBody }>, reply: FastifyReply) => {
      const body = req.body ?? {};
      if (!isDevRequest(req.query as Record<string, unknown>, body)) {
        return reply.code(400).send({ error: 'dev=true required (query or body) to ingest events' });
      }
      const config = getConfig();
      if (!config.devSimulation.enabled) {
        return reply.code(400).send({ error: 'Dev simulation is disabled' });
      }
      const event_type = typeof body.event_type === 'string' ? body.event_type : '';
      if (!event_type) {
        return reply.code(400).send({ error: 'event_type is required' });
      }
      const source = typeof body.source === 'string' ? body.source : 'farm_extension';
      const result = await ingestToDevInbox(source, event_type, body.payload ?? {}, {
        correlation_id: (req.headers['x-correlation-id'] as string) ?? undefined,
      });
      if (!result) {
        return reply.code(400).send({ error: 'Dev simulation is disabled' });
      }
      return reply.code(202).send({ status: 'accepted', id: result.id, dev_inbox: true });
    },
  );
}
