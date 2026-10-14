/**
 * Генерация correlation_id, idempotency_key, dedup_key (раздел 5.2 architecture_overview).
 * Единый модуль — все ключи генерируются здесь. Реализация полная — EP8 T8.5.
 */

import { randomUUID } from 'crypto';

const PREFIX = 'ph';

/** Трассировка одной цепочки обработки. */
export function createCorrelationId(): string {
  return `${PREFIX}-${randomUUID()}`;
}

/** Ключ идемпотентности для incoming_transactions: tx:<bank>:<acc_no>:<ext_id> */
export function createIncomingIdempotencyKey(bank: string, accNo: string, extId: string): string {
  return `tx:${bank}:${accNo}:${extId}`;
}

/** Ключ дедупликации для outgoing_notifications (OTP по карте). */
export function createOtpCardDedupKey(bank: string, accNo: string, cardNumber: string, otp: string, timeBucket: string): string {
  return `otp:card:${bank}:${accNo}:${cardNumber}:${otp}:${timeBucket}`;
}

/** Ключ дедупликации для MQTT публикации транзакции. */
export function createMqttTxDedupKey(bank: string, accNo: string, extId: string): string {
  return `mqtt:tx:${bank}:${accNo}:${extId}`;
}
