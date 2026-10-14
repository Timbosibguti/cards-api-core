/**
 * Операции БД для hardware-устройств (ota_devices, ota_device_logs).
 * Используются обработчиками MQTT топиков sequoia/hardware/*.
 */

import type { PoolClient } from 'pg';
import { logger } from './logger.js';

function otaDeviceCregCellularOk(creg: string | null | undefined): boolean {
  if (creg == null || typeof creg !== 'string') return false;
  const parts = creg.split(',');
  if (parts.length < 2) return false;
  const n = parseInt(parts[1].trim(), 10);
  return n === 1 || n === 5;
}

export interface OtaDeviceRow {
  imei: string;
  phone: bigint | null;
  version: string | null;
  uptime: bigint | null;
  stats: Record<string, unknown> | null;
  config: Record<string, unknown> | null;
  board: string | null;
  creg: string | null;
  csq: string | null;
  note: string | null;
}

export interface UpsertDeviceInput {
  imei: string;
  phone: string;
  version: string;
  uptime: number;
  stats: { sms: number; call: number };
  config?: { answer?: number; play?: number; hang?: number; play_answer?: number };
  board?: string;
  creg?: string;
  csq?: string;
}

/**
 * Вставка/обновление устройства по данным heartbeat.
 */
export async function upsertDevice(client: PoolClient, device: UpsertDeviceInput): Promise<void> {
  let phoneBigInt: bigint | null = null;
  if (device.phone) {
    const phoneStr = device.phone.replace(/^\+/, '');
    phoneBigInt = BigInt(phoneStr);
  }
  const config = {
    answer: device.config?.answer ?? 0,
    play: device.config?.play ?? 32,
    hang: device.config?.hang ?? 60,
    play_answer: device.config?.play_answer ?? 2,
  };
  const cellularOk = otaDeviceCregCellularOk(device.creg);

  await client.query(
    `INSERT INTO public.ota_devices (imei, phone, version, uptime, stats, config, board, creg, csq, updated_at, sim_last_network_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, NOW(), CASE WHEN $10::boolean THEN NOW() ELSE NULL END)
     ON CONFLICT (imei) DO UPDATE SET
       phone = CASE
         WHEN EXCLUDED.phone IN (0, -1) OR EXCLUDED.phone IS NULL THEN public.ota_devices.phone
         ELSE EXCLUDED.phone
       END,
       version = EXCLUDED.version,
       uptime = EXCLUDED.uptime,
       stats = EXCLUDED.stats,
       config = EXCLUDED.config,
       board = EXCLUDED.board,
       creg = EXCLUDED.creg,
       csq = EXCLUDED.csq,
       updated_at = NOW(),
       sim_last_network_at = CASE WHEN $10::boolean THEN NOW() ELSE public.ota_devices.sim_last_network_at END`,
    [
      device.imei,
      phoneBigInt,
      device.version,
      device.uptime,
      JSON.stringify(device.stats),
      JSON.stringify(config),
      device.board ?? null,
      device.creg ?? null,
      device.csq ?? null,
      cellularOk,
    ]
  );
  logger.debug('Device upserted', { imei: device.imei });
}

/**
 * Получить устройство по IMEI.
 */
export async function getDevice(client: PoolClient, imei: string): Promise<OtaDeviceRow | null> {
  const result = await client.query<OtaDeviceRow>(
    'SELECT imei, phone, version, uptime, stats, config, board, creg, csq, note FROM public.ota_devices WHERE imei = $1',
    [imei]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (!row.config || typeof row.config !== 'object') {
    row.config = { answer: 0, play: 32, hang: 60, play_answer: 2 };
  } else {
    row.config = {
      answer: (row.config as Record<string, unknown>).answer ?? 0,
      play: (row.config as Record<string, unknown>).play ?? 32,
      hang: (row.config as Record<string, unknown>).hang ?? 60,
      play_answer: (row.config as Record<string, unknown>).play_answer ?? 2,
    };
  }
  return row;
}

/**
 * Записать лог устройства (OTA devicelog).
 */
export async function insertDeviceLog(
  client: PoolClient,
  imei: string,
  raw: string,
  payload: Record<string, unknown> | null
): Promise<void> {
  await client.query(
    'INSERT INTO public.ota_device_logs (imei, payload, raw) VALUES ($1, $2, $3)',
    [imei, payload ? JSON.stringify(payload) : null, raw]
  );
  logger.debug('Device log inserted', { imei });
}
