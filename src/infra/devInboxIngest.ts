/**
 * Маршрутизация запросов с dev=true в dev_inbox_events (processor_hub_dev_simulation_spec §11, §12).
 * Вызывается из HTTP-обработчиков и MQTT, когда запрос/сообщение помечено dev=true —
 * событие сохраняется в dev_inbox_events и не идёт в production flow.
 */

import { randomUUID } from 'node:crypto';
import { getConfig } from '../config/index.js';
import { getDatabaseService } from './index.js';
import { insertDevInboxEvent, type InsertDevInboxEventParams } from './devInboxDb.js';

export interface IngestToDevInboxOpts {
  correlation_id?: string | null;
  external_id?: string | null;
  created_by?: string | null;
}

/**
 * Если dev simulation включён — вставляет событие в dev_inbox_events и возвращает id.
 * Если выключен — возвращает null (вызывающий код не должен вызывать при отключённом dev).
 */
export async function ingestToDevInbox(
  source: string,
  event_type: string,
  payload: unknown,
  opts: IngestToDevInboxOpts = {},
): Promise<{ id: string } | null> {
  const config = getConfig();
  if (!config.devSimulation.enabled) return null;

  const id = randomUUID();
  const params: InsertDevInboxEventParams = {
    id,
    source,
    event_type,
    payload: payload ?? {},
    correlation_id: opts.correlation_id ?? null,
    external_id: opts.external_id ?? null,
    created_by: opts.created_by ?? null,
  };
  const db = getDatabaseService(config);
  await db.withTransaction('main', (client) => insertDevInboxEvent(client, params));
  return { id };
}

/** Проверка: передан ли флаг dev=true в query или в body. */
export function isDevRequest(query: Record<string, unknown> | undefined, body: unknown): boolean {
  if (query && query.dev === 'true') return true;
  if (body && typeof body === 'object' && 'dev' in body && (body as Record<string, unknown>).dev === true) return true;
  return false;
}
