/**
 * Запись в ops_incidents для прямых fetch к ПС (вне PaymentHttpClient).
 */

import type { AppConfig } from '../../config/index.js';
import { getDatabaseService } from '../DatabaseService.js';
import { logger } from '../logger.js';
import { recordIncident } from './recordIncident.js';
import type { IncidentSeverity } from './types.js';

export async function recordDirectProviderHttpIncident(
  config: AppConfig,
  params: {
    source: string;
    kind: string;
    bank: string;
    operation: string;
    severity?: IncidentSeverity;
    correlation_id?: string | null;
    http_status?: number | null;
    error: Error;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  const httpStatus = params.http_status;
  const severity =
    params.severity ??
    (httpStatus != null && httpStatus >= 400 && httpStatus < 500 ? 'warning' : 'error');
  const summary = `${params.bank} ${params.operation}: ${params.error.message}`.slice(0, 1000);

  try {
    const db = getDatabaseService(config);
    const client = await db.getClient('main');
    try {
      await recordIncident(client, {
        source: params.source,
        kind: params.kind,
        severity,
        summary,
        detail: {
          bank: params.bank,
          operation: params.operation,
          http_status: httpStatus ?? null,
          error_name: params.error.name,
          error_message: params.error.message,
          correlation_id: params.correlation_id ?? null,
          ...params.detail,
        },
        correlation_id: params.correlation_id ?? null,
      });
    } finally {
      client.release();
    }
  } catch (recordErr) {
    logger.error('recordDirectProviderHttpIncident failed', recordErr as Error);
  }
}

/** Внешний catch цикла поллинга адаптера (дополняет инциденты из PaymentHttpClient на уровне «цикл упал»). */
export async function recordAdapterPollingCycleError(
  config: AppConfig,
  bank: string,
  pollerId: string,
  error: unknown,
): Promise<void> {
  const err = error instanceof Error ? error : new Error(String(error));
  await recordDirectProviderHttpIncident(config, {
    source: `${bank}_adapter_poll`,
    kind: 'adapter_polling_cycle_error',
    bank,
    operation: pollerId,
    error: err,
    detail: { poller_id: pollerId },
  });
}
