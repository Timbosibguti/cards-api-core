/**
 * Единый аудит выпуска карт по провайдерам (multicards, adscards, далее — ecards и т.д.).
 * Канал: mqtt:sequoia/audit через outgoing_notifications.
 */

import { randomUUID } from 'node:crypto';
import { getConfig } from '../../../config/index.js';
import { createCorrelationId } from '../../../infra/correlation/index.js';
import { getDatabaseService, enqueueOutgoingNotification } from '../../../infra/index.js';
import { logger } from '../../../infra/logger.js';

export type CardProviderCreateBank = string;

export function cardCreateAuditUserEmail(requested: string | null | undefined): string {
  const t = requested?.trim();
  return t ? t : 'system@groscloud.com';
}

export function truncateCardCreateAuditText(msg: string, max = 4000): string {
  return msg.length <= max ? msg : `${msg.slice(0, max)}…`;
}

export async function enqueueCardProviderCreateAudit(params: {
  bank: CardProviderCreateBank;
  /** Уточнение источника в event_attributes (multicards_create, adscards_create, …). */
  source: string;
  eventType: string;
  logType: 'info' | 'log' | 'error' | 'warning';
  severity: number;
  userEmail: string;
  eventAttributes: Record<string, unknown>;
}): Promise<void> {
  try {
    const config = getConfig();
    const db = getDatabaseService(config);
    const now = new Date();
    const correlationId = createCorrelationId();
    const dedupKey = `audit:card_provider_create:${params.bank}:${params.eventType}:${randomUUID()}`;
    const payload = {
      id: randomUUID(),
      timestamp: now.toISOString(),
      division: 'finance' as const,
      user_email: params.userEmail,
      log_type: params.logType,
      severity: params.severity,
      event_type: params.eventType,
      event_attributes: {
        source: params.source,
        bank: params.bank,
        ...params.eventAttributes,
        correlation_id: correlationId,
        timestamp: now.toISOString(),
      },
      correlation_id: correlationId,
    };

    await db.withTransaction('main', async (client) => {
      await enqueueOutgoingNotification(client, {
        channel: 'mqtt:sequoia/audit',
        payload,
        dedupKey,
        correlationId,
      });
    });
  } catch (err) {
    logger.error('enqueueCardProviderCreateAudit failed', {
      bank: params.bank,
      eventType: params.eventType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
