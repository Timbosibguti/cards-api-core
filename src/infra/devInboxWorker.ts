/**
 * DevInboxWorker: обрабатывает события из dev_inbox_events (processor_hub_dev_simulation_spec.md §6).
 * Только при config.devSimulation.enabled. Вызывает диспетчер → те же сервисы, что и прод.
 */

import { getConfig } from '../config/index.js';
import { getDatabaseService } from './DatabaseService.js';
import {
  takePendingDevInboxEvents,
  markDevInboxProcessed,
  markDevInboxFailed,
} from './devInboxDb.js';
import { dispatchDevInboxEvent } from './devDispatcher.js';
import { logger } from './logger.js';

export interface DevInboxWorkerHandle {
  stop(): Promise<void>;
}

export function startDevInboxWorker(): DevInboxWorkerHandle {
  const config = getConfig();
  if (!config.devSimulation.enabled) {
    return { async stop() {} };
  }

  const db = getDatabaseService(config);
  let stopped = false;

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const rows = await db.withTransaction('main', (client) => takePendingDevInboxEvents(client, 10));
        if (rows.length === 0) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }

        for (const row of rows) {
          try {
            await dispatchDevInboxEvent({
              id: row.id,
              source: row.source,
              event_type: row.event_type,
              payload: row.payload,
              correlation_id: row.correlation_id,
            });
            await db.withTransaction('main', (client) => markDevInboxProcessed(client, row.id));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error('DevInboxWorker dispatch error', { id: row.id, source: row.source, event_type: row.event_type, error: msg });
            await db.withTransaction('main', (client) => markDevInboxFailed(client, row.id, msg));
          }
        }
      } catch (err) {
        logger.error('DevInboxWorker loop error', err as Error);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };

  void loop();
  return {
    async stop() {
      stopped = true;
    },
  };
}
