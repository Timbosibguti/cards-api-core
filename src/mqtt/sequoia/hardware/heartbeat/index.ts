/**
 * Обработчик топика sequoia/hardware/heartbeat.
 * Heartbeat устройства: upsert в public.ota_devices.
 * При dev=true в payload — событие пишется в dev_inbox_events (spec §12), production flow не выполняется.
 */

import { getConfig } from '../../../../config/index.js';
import { getDatabaseService } from '../../../../infra/index.js';
import { upsertDevice } from '../../../../infra/hardwareDb.js';
import { ingestToDevInbox } from '../../../../infra/devInboxIngest.js';
import { logger } from '../../../../infra/logger.js';

interface HeartbeatPayload {
  imei: string;
  phone: string;
  version: string;
  uptime: number;
  type?: string;
  stats?: { sms?: number; call?: number };
  config?: { answer?: number; play?: number; hang?: number; play_answer?: number };
  board?: string;
  creg?: string;
  csq?: string;
  dev?: boolean;
}

export default async function handleMessage(_topic: string, payload: Buffer): Promise<void> {
  const payloadStr = payload.toString('utf8');
  let data: HeartbeatPayload;
  try {
    data = JSON.parse(payloadStr) as HeartbeatPayload;
  } catch {
    logger.error('Failed to parse heartbeat as JSON', { payload: payloadStr });
    return;
  }

  const config = getConfig();
  if (config.devSimulation.enabled && data.dev === true) {
    const result = await ingestToDevInbox('taurus', 'taurus_heartbeat', data);
    if (result) {
      logger.info('Taurus heartbeat (dev=true) written to dev_inbox_events', { id: result.id, imei: data.imei });
      return;
    }
  }

  if (
    !data.imei ||
    !data.phone ||
    data.uptime === undefined ||
    !data.stats ||
    !data.version
  ) {
    logger.warn('Heartbeat missing required fields', { data });
    return;
  }

  if (data.type !== undefined && data.type !== 'heartbeat') {
    logger.warn('Heartbeat message has incorrect type', { type: data.type });
    return;
  }

  const db = getDatabaseService(config);
  const stats = data.stats ?? { sms: 0, call: 0 };
  await db.withTransaction('main', async (client) => {
    await upsertDevice(client, {
      imei: data.imei,
      phone: data.phone,
      version: data.version,
      uptime: data.uptime,
      stats: { sms: stats.sms ?? 0, call: stats.call ?? 0 },
      config: data.config,
      board: data.board,
      creg: data.creg,
      csq: data.csq,
    });
  });

  logger.info('Device heartbeat processed', { imei: data.imei });
}
