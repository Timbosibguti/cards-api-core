/**
 * Dev API: inbox-events (processor_hub_dev_simulation_spec.md §8) и сценарный replay-слой.
 * Регистрируется только при config.devSimulation.enabled.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../../config/index.js';
import { getDatabaseService } from '../../infra/index.js';
import { createCorrelationId } from '../../infra/correlation/index.js';
import {
  insertDevInboxEvent,
  listDevInboxEvents,
  getDevInboxEventById,
  getDevInboxOutcome,
  type InsertDevInboxEventParams,
} from '../../infra/devInboxDb.js';
import {
  ALLOWED_SOURCES,
  ALLOWED_EVENT_TYPES,
  isAllowedSource,
  isAllowedEventType,
  validatePayload,
} from '../../infra/devInboxWhitelist.js';

const FIXTURES_DIR = path.join(process.cwd(), 'dev-fixtures');

function devEventTraceResponse(
  id: string,
  source: string,
  event_type: string,
  correlation_id: string,
  extra?: Record<string, unknown>,
) {
  return {
    id,
    source,
    event_type,
    status: 'pending' as const,
    correlation_id,
    created_at: new Date().toISOString(),
    trace: {
      event_url: `/dev/inbox-events/${id}`,
      outcome_url: `/dev/inbox-events/${id}/outcome`,
    },
    ...extra,
  };
}

interface PostInboxBody {
  source: string;
  event_type: string;
  payload?: unknown;
  correlation_id?: string | null;
  external_id?: string | null;
  aggregate_key?: string | null;
  meta?: unknown;
  created_by?: string | null;
}

function safeFileName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+\.json$/.test(name) && !name.includes('..');
}

export async function registerDevRoutes(server: FastifyInstance): Promise<void> {
  const config = getConfig();
  if (!config.devSimulation.enabled) return;

  server.post<{ Body: PostInboxBody }>('/dev/inbox-events', async (req: FastifyRequest<{ Body: PostInboxBody }>, reply: FastifyReply) => {
    const body = req.body ?? {};
    const source = typeof body.source === 'string' ? body.source.trim() : '';
    const event_type = typeof body.event_type === 'string' ? body.event_type.trim() : '';
    if (!source || !event_type) {
      return reply.status(400).send({ error: 'source and event_type are required' });
    }
    if (!isAllowedSource(source)) {
      return reply.status(400).send({ error: 'source not allowed', source, allowed: 'ecards, stellarcards, multicards, adscards, sms_device, sms_gateway, taurus, farm_extension, manual' });
    }
    if (!isAllowedEventType(event_type)) {
      return reply.status(400).send({ error: 'event_type not allowed', event_type, allowed: 'card_issued, card_updated, transaction_created, otp_received, sms_received, taurus_heartbeat, device_online, device_offline, ...' });
    }
    const payload = body.payload ?? {};
    const validation = validatePayload(source, event_type, payload);
    if (!validation.valid) {
      return reply.status(400).send({ error: 'payload validation failed', message: validation.message });
    }
    const id = randomUUID();
    const correlationId = body.correlation_id ?? createCorrelationId();
    const params: InsertDevInboxEventParams = {
      id,
      source,
      event_type,
      payload,
      correlation_id: correlationId,
      external_id: body.external_id ?? null,
      aggregate_key: body.aggregate_key ?? null,
      meta: body.meta ?? null,
      created_by: body.created_by ?? null,
    };
    const db = getDatabaseService(config);
    await db.withTransaction('main', (client) => insertDevInboxEvent(client, params));
    return reply.status(201).send(devEventTraceResponse(id, source, event_type, correlationId));
  });

  server.get('/dev/whitelist', async (_req, reply: FastifyReply) => {
    return reply.send({
      sources: [...ALLOWED_SOURCES],
      event_types: [...ALLOWED_EVENT_TYPES],
    });
  });

  server.get<{ Querystring: { status?: string; limit?: string } }>(
    '/dev/inbox-events',
    async (req: FastifyRequest<{ Querystring: { status?: string; limit?: string } }>, reply: FastifyReply) => {
      const status = typeof req.query?.status === 'string' ? req.query.status : undefined;
      const limitRaw = typeof req.query?.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
      const limit = Number.isNaN(limitRaw) ? undefined : limitRaw;
      const db = getDatabaseService(config);
      const rows = await db.withTransaction('main', (client) => listDevInboxEvents(client, { status, limit }));
      return reply.send(rows);
    },
  );

  server.get<{ Params: { id: string } }>('/dev/fixtures', async (_req, reply: FastifyReply) => {
    try {
      const files = await readdir(FIXTURES_DIR);
      const json = files.filter((f) => f.endsWith('.json') && safeFileName(f)).sort();
      return reply.send({ fixtures: json });
    } catch {
      return reply.send({ fixtures: [] });
    }
  });

  server.post<{ Body: { fixture: string } }>('/dev/inbox-events/from-fixture', async (req: FastifyRequest<{ Body: { fixture: string } }>, reply: FastifyReply) => {
    const name = typeof req.body?.fixture === 'string' ? req.body.fixture.trim() : '';
    if (!name || !safeFileName(name)) {
      return reply.status(400).send({ error: 'fixture name required (e.g. stellarcards.transaction-created.json)' });
    }
    let raw: string;
    try {
      raw = await readFile(path.join(FIXTURES_DIR, name), 'utf-8');
    } catch {
      return reply.status(404).send({ error: 'Fixture not found', fixture: name });
    }
    let body: PostInboxBody;
    try {
      body = JSON.parse(raw) as PostInboxBody;
    } catch {
      return reply.status(400).send({ error: 'Invalid JSON in fixture', fixture: name });
    }
    const source = typeof body.source === 'string' ? body.source.trim() : '';
    const event_type = typeof body.event_type === 'string' ? body.event_type.trim() : '';
    if (!source || !event_type) {
      return reply.status(400).send({ error: 'Fixture must contain source and event_type', fixture: name });
    }
    if (!isAllowedSource(source)) {
      return reply.status(400).send({ error: 'source not allowed in fixture', source, fixture: name });
    }
    if (!isAllowedEventType(event_type)) {
      return reply.status(400).send({ error: 'event_type not allowed in fixture', event_type, fixture: name });
    }
    const payload = body.payload ?? {};
    const validation = validatePayload(source, event_type, payload);
    if (!validation.valid) {
      return reply.status(400).send({ error: 'payload validation failed', message: validation.message, fixture: name });
    }
    const id = randomUUID();
    const correlationId = body.correlation_id ?? createCorrelationId();
    const params: InsertDevInboxEventParams = {
      id,
      source,
      event_type,
      payload,
      correlation_id: correlationId,
      external_id: body.external_id ?? null,
      aggregate_key: body.aggregate_key ?? null,
      meta: body.meta ?? null,
      created_by: body.created_by ?? null,
    };
    const db = getDatabaseService(config);
    await db.withTransaction('main', (client) => insertDevInboxEvent(client, params));
    return reply.status(201).send(devEventTraceResponse(id, source, event_type, correlationId, { fixture: name }));
  });

  server.post<{ Body: { ids?: string[] } }>('/dev/inbox-events/replay-batch', async (req: FastifyRequest<{ Body: { ids?: string[] } }>, reply: FastifyReply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x): x is string => typeof x === 'string') : [];
    if (ids.length === 0) {
      return reply.status(400).send({ error: 'ids array required (non-empty)' });
    }
    if (ids.length > 50) {
      return reply.status(400).send({ error: 'Max 50 ids per batch' });
    }
    const db = getDatabaseService(config);
    const results: { id: string; new_id: string; source: string; event_type: string }[] = [];
    for (const id of ids) {
      const existing = await db.withTransaction('main', (client) => getDevInboxEventById(client, id));
      if (!existing) {
        results.push({ id, new_id: '', source: '', event_type: '' });
        continue;
      }
      const newId = randomUUID();
      const params: InsertDevInboxEventParams = {
        id: newId,
        source: existing.source,
        event_type: existing.event_type,
        payload: existing.payload,
        correlation_id: existing.correlation_id ?? createCorrelationId(),
        external_id: existing.external_id,
        aggregate_key: existing.aggregate_key,
        meta: existing.meta,
        created_by: existing.created_by,
        replay_of_event_id: existing.id,
      };
      await db.withTransaction('main', (client) => insertDevInboxEvent(client, params));
      results.push({ id, new_id: newId, source: existing.source, event_type: existing.event_type });
    }
    return reply.status(201).send({ replayed: results });
  });

  server.get<{ Params: { id: string } }>('/dev/inbox-events/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const id = req.params?.id;
    if (!id) return reply.status(400).send({ error: 'id required' });
    const db = getDatabaseService(config);
    const row = await db.withTransaction('main', (client) => getDevInboxEventById(client, id));
    if (!row) return reply.status(404).send({ error: 'Event not found', id });
    return reply.send(row);
  });

  server.get<{ Params: { id: string } }>('/dev/inbox-events/:id/outcome', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const id = req.params?.id;
    if (!id) return reply.status(400).send({ error: 'id required' });
    const db = getDatabaseService(config);
    const event = await db.withTransaction('main', (client) => getDevInboxEventById(client, id));
    if (!event) return reply.status(404).send({ error: 'Event not found', id });
    const corr = event.correlation_id != null ? String(event.correlation_id) : null;
    const outcome = await db.withTransaction('main', (client) => getDevInboxOutcome(client, corr));
    return reply.send({ event_id: id, status: event.status, ...outcome });
  });

  server.post<{ Params: { id: string } }>(
    '/dev/inbox-events/:id/replay',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = req.params?.id;
      if (!id) return reply.status(400).send({ error: 'id is required' });
      const db = getDatabaseService(config);
      const existing = await db.withTransaction('main', (client) => getDevInboxEventById(client, id));
      if (!existing) return reply.status(404).send({ error: 'Event not found' });
      const newId = randomUUID();
      const params: InsertDevInboxEventParams = {
        id: newId,
        source: existing.source,
        event_type: existing.event_type,
        payload: existing.payload,
        correlation_id: existing.correlation_id ?? createCorrelationId(),
        external_id: existing.external_id,
        aggregate_key: existing.aggregate_key,
        meta: existing.meta,
        created_by: existing.created_by,
        replay_of_event_id: existing.id,
      };
      await db.withTransaction('main', (client) => insertDevInboxEvent(client, params));
      return reply.status(201).send({ id: newId, source: existing.source, event_type: existing.event_type, status: 'pending', replay_of_event_id: existing.id });
    },
  );
}
