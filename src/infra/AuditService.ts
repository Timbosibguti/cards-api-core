/**
 * Базовый сервис аудита: отправка событий в внешний audit-сервис через MQTT (`sequoia/audit`).
 * В этом проекте мы НЕ пишем напрямую в таблицу audit_events — только публикуем события.
 */

import { randomUUID } from 'crypto';
import { getConfig } from '../config/index.js';
import { getMqttClient } from './MqttClient.js';
import { logger } from './logger.js';

export type AuditLogType = 'info' | 'log' | 'error' | 'warning';

export interface AuditEvent {
  id: string;
  timestamp: string;
  division: string;
  user_email: string;
  log_type: AuditLogType;
  severity: number;
  event_type: string;
  event_attributes?: Record<string, unknown>;
  correlation_id?: string;
  /** Расследовательский стандарт: субъект операции (card_number, profile_name, job_id и т.д.). */
  subject?: string;
  /** Состояние до операции (для переходов статусов, смены владельца). */
  before_state?: Record<string, unknown>;
  /** Состояние после операции. */
  after_state?: Record<string, unknown>;
  /** Итог: success | failed | duplicate_ignored | no_op. */
  result?: string;
  /** Причина no-op (например duplicate_ignored, acquire_denied). */
  no_op_reason?: string;
}

export type AuditWriteInput = Partial<AuditEvent> & {
  division: string;
  user_email: string;
  log_type: AuditLogType;
  severity: number;
  event_type: string;
};

export interface AuditService {
  /** Отправить событие аудита в MQTT-топик `sequoia/audit`. */
  writeAudit(event: AuditWriteInput): Promise<void>;
}

let instance: AuditService | null = null;

function sanitizeAttributes(attrs: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!attrs) return undefined;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'bigint') {
      cleaned[key] = value.toString();
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      cleaned[key] = value;
    } else if (Array.isArray(value) || typeof value === 'object') {
      // Плоский объект: сложные структуры пропускаем
      continue;
    } else {
      cleaned[key] = String(value);
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

function createAuditService(): AuditService {
  const config = getConfig();
  const mqtt = getMqttClient(config);
  const topic = 'sequoia/audit';

  return {
    async writeAudit(event: AuditWriteInput): Promise<void> {
      const fullEvent: AuditEvent = {
        id: event.id ?? randomUUID(),
        timestamp: event.timestamp ?? new Date().toISOString(),
        division: event.division,
        user_email: event.user_email,
        log_type: event.log_type,
        severity: event.severity,
        event_type: event.event_type,
        event_attributes: sanitizeAttributes(event.event_attributes),
        correlation_id: event.correlation_id,
        subject: event.subject,
        before_state: event.before_state ? sanitizeAttributes(event.before_state as Record<string, unknown>) : undefined,
        after_state: event.after_state ? sanitizeAttributes(event.after_state as Record<string, unknown>) : undefined,
        result: event.result,
        no_op_reason: event.no_op_reason,
      };

      try {
        await mqtt.publish(topic, JSON.stringify(fullEvent), { qos: 1 });
        logger.info(`Audit event published: ${fullEvent.event_type}`, { id: fullEvent.id });
      } catch (err) {
        logger.error('Failed to publish audit event', err as Error);
        // Не пробрасываем ошибку дальше, чтобы аудит не ломал бизнес-поток
      }
    },
  };
}

/**
 * Возвращает синглтон AuditService.
 */
export function getAuditService(): AuditService {
  if (!instance) {
    instance = createAuditService();
  }
  return instance;
}

export function resetAuditService(): void {
  instance = null;
}
