import { getConfig } from '../../../config/index.js';
import { getPaymentHttpClient } from '../../../infra/index.js';
import { logger } from '../../../infra/logger.js';

const STELLAR_CARD_API_BASE = 'https://api.stellarcard.io';

export async function blockStellarcardsCard(params: { extId: string }): Promise<void> {
  const guid = params.extId.trim();
  if (!guid) {
    throw new Error('stellarcards: empty ext_id (guid)');
  }

  const config = getConfig();
  const provider = config.providers.stellarcards;
  const bearer = provider?.apiKey ?? provider?.tokenForCards;
  if (!bearer) {
    throw new Error(
      'stellarcards: configure STELLARCARDS_API_KEY (Bearer) or token for freeze',
    );
  }

  const http = getPaymentHttpClient(config);
  const path = `/v1/cards/${encodeURIComponent(guid)}/close`;

  logger.info('cardBlock stellarcards: POST freeze (public API)', { path, guid });

  await http.request({
    bank: 'stellarcards',
    method: 'POST',
    path,
    baseUrlOverride: STELLAR_CARD_API_BASE,
    headers: {
      Authorization: `Bearer ${bearer}`,
    },
  });

  logger.info('cardBlock stellarcards: freeze done', { guid });
}
