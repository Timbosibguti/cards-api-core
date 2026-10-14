/**
 * Dev Inbox handlers: вызов тех же сервисов, что и реальные адаптеры (spec §7).
 * Каждый handler принимает событие из dev_inbox и вызывает доменный слой (transactions, cards, outgoing, hardware, sms_devices).
 */

import { getConfig } from '../config/index.js';
import { getDatabaseService, enqueueOutgoingNotification } from './index.js';
import { createCorrelationId } from './correlation/index.js';
import { upsertProviderCard, type ProviderCardInput } from '../modules/cards/index.js';
import type { BankId } from '../modules/transactions/types.js';
import { upsertDevice } from './hardwareDb.js';
import { upsertSmsDevice } from './smsDevicesDb.js';
import { logger } from './logger.js';

const PAYMENT_SOURCES: BankId[] = ['ecards', 'stellarcards', 'multicards', 'adscards'];

function isPaymentSource(source: string): source is BankId {
  return (PAYMENT_SOURCES as string[]).includes(source);
}

export interface DevDispatchEvent {
  id: string;
  source: string;
  event_type: string;
  payload: unknown;
  correlation_id: string | null;
}

/** Поставить OTP/SMS в outgoing (mqtt:sequoia/otp). Payload должен содержать source и при необходимости raw (для sms) или otp/bank/acc_no/card_number (для карт). */
export async function handleDevOtpOrSms(event: DevDispatchEvent): Promise<void> {
  const correlationId = event.correlation_id ?? createCorrelationId();
  const payload = (event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {}) as Record<string, unknown>;
  const source = (typeof payload.source === 'string' ? payload.source : event.source) as string;
  const otpPayload = {
    ...payload,
    source: source === 'sms_gateway' || source === 'sms_device' ? 'sms' : source,
    correlation_id: correlationId,
    idempotency_key: payload.idempotency_key ?? `otp:dev:${event.id}`,
  };
  const dedupKey = (payload.dedup_key as string) ?? `otp:dev:${event.id}`;
  const config = getConfig();
  const db = getDatabaseService(config);
  await db.withTransaction('main', (client) =>
    enqueueOutgoingNotification(client, {
      channel: 'mqtt:sequoia/otp',
      payload: otpPayload,
      dedupKey,
      correlationId,
    }),
  );
  logger.info('Dev OTP/SMS enqueued to mqtt:sequoia/otp', { id: event.id, source: event.source });
}

/** Нормализовать payload из dev в ProviderCardInput. Ожидаемые поля: bank (или source), card_number, acc_no, created_at/createdAt, note, ext_id/extId, buyer. */
function toProviderCardInput(source: string, payload: unknown): ProviderCardInput | null {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const bank = (typeof p.bank === 'string' ? p.bank : source) as string;
  if (!isPaymentSource(bank)) return null;
  const cardNumberRaw = p.card_number ?? p.cardNumber;
  const cardNumber = typeof cardNumberRaw === 'number' && Number.isFinite(cardNumberRaw)
    ? cardNumberRaw
    : typeof cardNumberRaw === 'string'
      ? parseInt(cardNumberRaw.replace(/\D/g, ''), 10)
      : NaN;
  if (!Number.isFinite(cardNumber)) return null;
  const accNo = typeof p.acc_no === 'string' ? p.acc_no : (typeof p.accNo === 'string' ? p.accNo : null);
  const createdAtRaw = p.created_at ?? p.createdAt ?? new Date();
  const createdAt = createdAtRaw instanceof Date ? createdAtRaw : new Date(String(createdAtRaw));
  const note = typeof p.note === 'string' ? p.note : null;
  const creds = typeof p.creds === 'string' ? p.creds : (p.creds != null ? JSON.stringify(p.creds) : null);
  const extId = typeof p.ext_id === 'string' ? p.ext_id : (typeof p.extId === 'string' ? p.extId : null);
  const buyer = typeof p.buyer === 'string' ? p.buyer : null;
  return {
    bank,
    cardNumber,
    accNo,
    createdAt,
    note,
    creds: creds ?? undefined,
    extId: extId ?? undefined,
    buyer: buyer ?? undefined,
    source: `dev:${source}`,
  };
}

/** card_issued / card_updated / card_reassigned → upsertProviderCard. */
export async function handleDevCardEvent(event: DevDispatchEvent): Promise<void> {
  const input = toProviderCardInput(event.source, event.payload);
  if (!input) {
    throw new Error(`Invalid card payload for dev event ${event.id}: missing or invalid bank/card_number`);
  }
  const config = getConfig();
  const db = getDatabaseService(config);
  await db.withTransaction('main', (client) => upsertProviderCard(client, input));
  logger.info('Dev card event applied (upsertProviderCard)', { id: event.id, source: event.source, event_type: event.event_type });
}

/** taurus_heartbeat → ota_devices (upsertDevice). Ожидаемые поля: imei, phone, version, uptime, stats (sms, call). */
export async function handleDevTaurusHeartbeat(event: DevDispatchEvent): Promise<void> {
  const p = event.payload && typeof event.payload === 'object' ? (event.payload as Record<string, unknown>) : {};
  const imei = typeof p.imei === 'string' ? p.imei : '';
  const phone = typeof p.phone === 'string' ? p.phone : (typeof p.phone === 'number' ? String(p.phone) : '');
  const version = typeof p.version === 'string' ? p.version : '0';
  const uptime = typeof p.uptime === 'number' ? p.uptime : 0;
  const statsObj = p.stats && typeof p.stats === 'object' ? (p.stats as Record<string, unknown>) : {};
  const stats = {
    sms: typeof statsObj.sms === 'number' ? statsObj.sms : 0,
    call: typeof statsObj.call === 'number' ? statsObj.call : 0,
  };
  if (!imei || !version) {
    throw new Error(`Invalid taurus_heartbeat payload: imei and version required`);
  }
  const config = getConfig();
  const db = getDatabaseService(config);
  await db.withTransaction('main', (client) =>
    upsertDevice(client, {
      imei,
      phone,
      version,
      uptime,
      stats,
      config: p.config as { answer?: number; play?: number; hang?: number; play_answer?: number } | undefined,
      board: typeof p.board === 'string' ? p.board : undefined,
      creg: typeof p.creg === 'string' ? p.creg : undefined,
      csq: typeof p.csq === 'string' ? p.csq : undefined,
    }),
  );
  logger.info('Dev taurus_heartbeat applied (ota_devices)', { id: event.id, imei });
}

/** sms_device heartbeat (SmsPhone) → sms_devices (upsertSmsDevice). Ожидаемые поля: imei, phones[], battery, charging, info{}. */
export async function handleDevSmsDeviceHeartbeat(event: DevDispatchEvent): Promise<void> {
  const p = event.payload && typeof event.payload === 'object' ? (event.payload as Record<string, unknown>) : {};
  const imei = typeof p.imei === 'string' ? p.imei : '';
  const phones = Array.isArray(p.phones) ? (p.phones as unknown[]).map((x) => String(x)) : [];
  const battery = typeof p.battery === 'number' ? p.battery : 0;
  const charging = Boolean(p.charging);
  const info = p.info && typeof p.info === 'object' ? (p.info as Record<string, unknown>) : {};
  if (!imei) {
    throw new Error(`Invalid sms_device heartbeat payload: imei required`);
  }
  const config = getConfig();
  const db = getDatabaseService(config);
  await db.withTransaction('main', (client) =>
    upsertSmsDevice(client, {
      imei,
      phones,
      battery,
      charging,
      info,
      tg_chat: typeof p.tg_chat === 'number' ? String(p.tg_chat) : (typeof p.tg_chat === 'string' ? p.tg_chat : null),
    }),
  );
  logger.info('Dev sms_device heartbeat applied (sms_devices)', { id: event.id, imei });
}

/** device_online / device_offline: в текущей реализации нет отдельного сервиса — логируем и считаем обработанным. */
export function handleDevDeviceOnlineOffline(event: DevDispatchEvent): void {
  logger.info('Dev device_online/offline (no-op, processed)', {
    id: event.id,
    source: event.source,
    event_type: event.event_type,
    payload: event.payload,
  });
}
