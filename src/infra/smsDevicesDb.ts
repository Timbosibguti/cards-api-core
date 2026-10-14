/**
 * Операции БД для мобильных устройств (sms_devices).
 * Используются вебхуком мобильного приложения.
 */

import type { PoolClient } from 'pg';
import { logger } from './logger.js';

export interface SmsDeviceRow {
  imei: string;
  phones: string[];
  battery: number;
  charging: boolean;
  info: Record<string, unknown>;
  tg_chat: string | null;
  updated_at: Date;
}

export interface UpsertSmsDeviceInput {
  imei: string;
  phones: string[];
  battery: number;
  charging: boolean;
  info: Record<string, unknown>;
  tg_chat?: string | null;
}

export async function upsertSmsDevice(client: PoolClient, device: UpsertSmsDeviceInput): Promise<void> {
  await client.query(
    `INSERT INTO public.sms_devices (imei, phones, battery, charging, info, tg_chat, updated_at)
     VALUES ($1, $2::text[], $3, $4, $5::jsonb, $6, NOW())
     ON CONFLICT (imei) DO UPDATE SET
       phones = EXCLUDED.phones,
       battery = EXCLUDED.battery,
       charging = EXCLUDED.charging,
       info = EXCLUDED.info,
       tg_chat = EXCLUDED.tg_chat,
       updated_at = NOW()`,
    [
      device.imei,
      device.phones,
      device.battery,
      device.charging,
      JSON.stringify(device.info),
      device.tg_chat ?? null,
    ],
  );
  logger.debug('SmsDevice upserted', { imei: device.imei });
}

export async function findSmsDeviceByRecipient(
  client: PoolClient,
  recipient: string,
): Promise<SmsDeviceRow | null> {
  const res = await client.query<SmsDeviceRow>(
    `SELECT imei, phones, battery, charging, info, tg_chat, updated_at
     FROM public.sms_devices
     WHERE phones @> ARRAY[$1]::text[]`,
    [recipient],
  );
  return res.rows[0] ?? null;
}

