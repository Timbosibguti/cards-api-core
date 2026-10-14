/**
 * Whitelist и валидация payload для dev_inbox_events (processor_hub_dev_simulation_spec §4, §5).
 * P1: допустимые source, event_type и schema validation по парам.
 */

/** Допустимые source (spec §4). */
export const ALLOWED_SOURCES = [
  'ecards',
  'stellarcards',
  'multicards',
  'adscards',
  'sms_device',
  'sms_gateway',
  'taurus',
  'farm_extension',
  'manual',
] as const;

export type AllowedSource = (typeof ALLOWED_SOURCES)[number];

/** Допустимые event_type (spec §5). */
export const ALLOWED_EVENT_TYPES = [
  'card_issued',
  'card_updated',
  'card_reassigned',
  'transaction_created',
  'transaction_updated',
  'transaction_completed',
  'transaction_failed',
  'otp_received',
  'sms_received',
  'sms_raw_received',
  'taurus_heartbeat',
  'taurus_status',
  'device_online',
  'device_offline',
  'provider_webhook',
  'heartbeat',
] as const;

export type AllowedEventType = (typeof ALLOWED_EVENT_TYPES)[number];

const SOURCE_SET = new Set<string>(ALLOWED_SOURCES);
const EVENT_TYPE_SET = new Set<string>(ALLOWED_EVENT_TYPES);

export function isAllowedSource(source: string): source is AllowedSource {
  return SOURCE_SET.has(source);
}

export function isAllowedEventType(eventType: string): eventType is AllowedEventType {
  return EVENT_TYPE_SET.has(eventType);
}

export interface ValidationResult {
  valid: boolean;
  message?: string;
}

/** Минимальная проверка payload по паре (source, event_type). */
export function validatePayload(
  source: string,
  event_type: string,
  payload: unknown,
): ValidationResult {
  if (payload == null || typeof payload !== 'object') {
    return { valid: true }; // пустой payload допустим для части типов
  }
  const p = payload as Record<string, unknown>;

  const paymentSources = ['ecards', 'stellarcards', 'multicards', 'adscards'];
  const isPayment = paymentSources.includes(source);

  switch (event_type) {
    case 'transaction_created':
    case 'transaction_updated':
    case 'provider_webhook':
      if (isPayment && (typeof p.amount !== 'number' && typeof p.amount !== 'undefined')) {
        // amount опционален для вебхука
      }
      return { valid: true };

    case 'card_issued':
    case 'card_updated':
    case 'card_reassigned': {
      const bank = p.bank ?? source;
      if (!paymentSources.includes(String(bank)) && source !== 'farm_extension') {
        return { valid: false, message: 'card events require bank (payment source) or source=farm_extension with payload.bank' };
      }
      const cn = p.card_number ?? p.cardNumber;
      if (cn === undefined || cn === null) {
        return { valid: false, message: 'payload.card_number or payload.cardNumber required' };
      }
      return { valid: true };
    }

    case 'otp_received':
    case 'sms_received':
    case 'sms_raw_received':
      // source в payload или в event; raw/otp опциональны (можно подставить в handler)
      return { valid: true };

    case 'taurus_heartbeat':
    case 'taurus_status':
      if (source !== 'taurus') {
        return { valid: false, message: 'taurus_heartbeat/taurus_status require source=taurus' };
      }
      if (typeof p.imei !== 'string' || !p.imei) {
        return { valid: false, message: 'payload.imei (string) required' };
      }
      if (typeof p.version !== 'string' && typeof p.version !== 'undefined') {
        return { valid: false, message: 'payload.version must be string if present' };
      }
      return { valid: true };

    case 'device_online':
    case 'device_offline':
      return { valid: true };

    case 'heartbeat':
      if (source === 'sms_device') {
        if (typeof p.imei !== 'string' || !p.imei) {
          return { valid: false, message: 'payload.imei required for sms_device heartbeat' };
        }
      }
      return { valid: true };

    default:
      return { valid: true };
  }
}
