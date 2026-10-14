/**
 * Event Contract: типы и валидаторы для MQTT-сообщений (envelope, payload по топикам).
 * См. architecture/event_contract.md. Реализация типов/валидаторов — EP8.
 */

/** Payload для топика sequoia/transaction (schema_version: 1). event_contract.md 2.2 */
export interface TransactionEventPayload {
  bank: string;
  ext_id: string;
  acc_no?: string | null;
  card_number?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  status?: string;
  occurred_at?: string;
  merchant_description?: string | null;
  card_id?: number | null;
  buyer?: string | null;
  profile_name?: string | null;
  is_buying?: boolean | null;
  correlation_id?: string | null;
}

export interface EventEnvelope {
  schema_version: number;
  producer: string;
  occurred_at: string; // ISO8601
  idempotency_key?: string;
  correlation_id?: string;
  payload: unknown;
}

export function createEnvelope(payload: unknown, options: { producer: string; correlation_id?: string; idempotency_key?: string }): EventEnvelope {
  return {
    schema_version: 1,
    producer: options.producer,
    occurred_at: new Date().toISOString(),
    idempotency_key: options.idempotency_key,
    correlation_id: options.correlation_id,
    payload,
  };
}

export function parseEnvelope(raw: unknown): EventEnvelope | null {
  if (raw && typeof raw === 'object' && 'schema_version' in raw && 'payload' in raw) {
    return raw as EventEnvelope;
  }
  return null;
}
