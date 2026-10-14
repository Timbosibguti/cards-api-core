/**
 * Обработчик топика sequoia/hardware/ota_devicelog.
 * Лог устройства: извлечение IMEI и запись в public.ota_device_logs.
 */

import { getConfig } from '../../../../config/index.js';
import { getDatabaseService } from '../../../../infra/index.js';
import { insertDeviceLog } from '../../../../infra/hardwareDb.js';
import { logger } from '../../../../infra/logger.js';

export default async function handleMessage(_topic: string, payload: Buffer): Promise<void> {
  const payloadStr = payload.toString('utf8');
  let imei: string | undefined;
  let parsed: { imei?: string } | null = null;

  try {
    parsed = JSON.parse(payloadStr) as { imei?: string };
    imei = parsed?.imei;
  } catch {
    logger.debug('Device log payload is not JSON', { length: payloadStr.length });
  }

  if (!imei) {
    const match = payloadStr.match(/IMEI[^0-9]*([0-9]{10,20})/i);
    if (match) imei = match[1];
  }

  if (!imei) {
    logger.warn('Device log message missing IMEI', { payloadLength: payloadStr.length });
    return;
  }

  const config = getConfig();
  const db = getDatabaseService(config);

  await db.withTransaction('main', async (client) => {
    await insertDeviceLog(client, imei, payloadStr, parsed);
  });

  logger.info('Device log stored', { imei });
}
