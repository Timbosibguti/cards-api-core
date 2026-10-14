import { logger } from '../../../../infra/logger.js';
import type { BankId } from '../../types.js';

export async function handleEcardsWebhook(kind: string, body: unknown, correlationId?: string): Promise<void> {
  logger.warn(`[ECARDS_HUB] kind=${kind}`, { body });
  if (kind !== 'transaction') return;

  await import('../../index.js').then(({ ingestRawTransaction }) =>
    ingestRawTransaction({
      bank: 'ecards' as BankId,
      payload: body,
      correlationId,
    }),
  );
}

