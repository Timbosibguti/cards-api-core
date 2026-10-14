/**
 * Dev Inbox Dispatcher: source + event_type → вызов тех же сервисов, что и в проде (spec §7).
 * Воркер не пишет в доменные таблицы напрямую — только через эти вызовы.
 */

import { createCorrelationId } from './correlation/index.js';
import { ingestRawTransaction } from '../modules/transactions/index.js';
import type { BankId } from '../modules/transactions/types.js';
import {
  handleDevOtpOrSms,
  handleDevCardEvent,
  handleDevTaurusHeartbeat,
  handleDevSmsDeviceHeartbeat,
  handleDevDeviceOnlineOffline,
} from './devHandlers.js';
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

/**
 * Диспетчеризация по source + event_type. Вызывает те же сервисы, что и реальные адаптеры.
 * Неизвестные пары логируются и считаются успешно обработанными (no-op), чтобы не блокировать очередь.
 */
export async function dispatchDevInboxEvent(event: DevDispatchEvent): Promise<void> {
  const { source, event_type, payload, correlation_id } = event;
  const correlationId = correlation_id ?? createCorrelationId();

  // ——— Транзакции (платёжные источники) ———
  if (event_type === 'transaction_created' && isPaymentSource(source)) {
    await ingestRawTransaction({
      bank: source,
      payload: payload ?? {},
      correlationId,
    });
    return;
  }
  if (event_type === 'transaction_updated' && isPaymentSource(source)) {
    await ingestRawTransaction({
      bank: source,
      payload: payload ?? {},
      correlationId,
    });
    return;
  }
  if (event_type === 'provider_webhook' && isPaymentSource(source)) {
    const body = payload && typeof payload === 'object' && 'body' in payload
      ? (payload as { body: unknown }).body
      : payload;
    await ingestRawTransaction({
      bank: source,
      payload: body ?? payload ?? {},
      correlationId,
    });
    return;
  }

  // ——— OTP / SMS → mqtt:sequoia/otp ———
  if (event_type === 'otp_received' || event_type === 'sms_received' || event_type === 'sms_raw_received') {
    await handleDevOtpOrSms(event);
    return;
  }

  // ——— Карточные события → upsertProviderCard (платёжный source или farm_extension с payload.bank) ———
  if (event_type === 'card_issued' || event_type === 'card_updated' || event_type === 'card_reassigned') {
    const hasPaymentBank =
      isPaymentSource(source) ||
      (source === 'farm_extension' &&
        payload != null &&
        typeof payload === 'object' &&
        'bank' in payload &&
        isPaymentSource(String((payload as Record<string, unknown>).bank)));
    if (hasPaymentBank) {
      await handleDevCardEvent(event);
      return;
    }
  }

  // ——— Taurus heartbeat/status → ota_devices ———
  if (source === 'taurus' && (event_type === 'taurus_heartbeat' || event_type === 'taurus_status')) {
    await handleDevTaurusHeartbeat(event);
    return;
  }

  // ——— Sms_device heartbeat (SmsPhone) → sms_devices ———
  if (source === 'sms_device' && event_type === 'heartbeat') {
    await handleDevSmsDeviceHeartbeat(event);
    return;
  }

  // ——— Device online/offline — нет отдельного сервиса, no-op ———
  if (event_type === 'device_online' || event_type === 'device_offline') {
    handleDevDeviceOnlineOffline(event);
    return;
  }

  // Остальные пары: no-op (не блокируем очередь)
  logger.info('Dev dispatcher: no handler for source+event_type, marking as processed', {
    id: event.id,
    source,
    event_type,
  });
}
