import { getConfig } from '../../../config/index.js';
import { getPaymentHttpClient } from '../../../infra/index.js';
import { logger } from '../../../infra/logger.js';
import { ensureMulticardsToken } from '../../transactions/adapters/multicards/transactions.js';

const MULTICARDS_API_BASE = 'https://api.multicards.io';

export async function blockMulticardsCard(params: { extId: string }): Promise<void> {
  const config = getConfig();
  const http = getPaymentHttpClient(config);

  const cardId = parseInt(params.extId, 10);
  if (!Number.isFinite(cardId)) {
    throw new Error(`multicards: invalid ext_id (numeric card id): ${params.extId}`);
  }

  const accessToken = await ensureMulticardsToken(config, http);
  const path = `/v1/card/${cardId}/close`;

  logger.info('cardBlock multicards: POST freeze', { path, cardId });

  await http.request({
    bank: 'multicards',
    method: 'POST',
    path,
    baseUrlOverride: MULTICARDS_API_BASE,
    headers: {
      'x-auth-token': accessToken,
      'Content-Type': 'application/json',
    },
  });

  logger.info('cardBlock multicards: freeze done', { cardId });
}
