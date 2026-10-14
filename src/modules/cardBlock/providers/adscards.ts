import { getConfig } from '../../../config/index.js';
import { getPaymentHttpClient } from '../../../infra/index.js';
import { logger } from '../../../infra/logger.js';

function applicationAuthorizationHeader(apiKey: string | undefined): string | undefined {
  if (apiKey == null || apiKey.trim() === '') return undefined;
  const t = apiKey.trim();
  return t.toLowerCase().startsWith('bearer ') ? t : `Bearer ${t}`;
}

export async function blockAdscardsCard(params: { extId: string }): Promise<void> {
  const config = getConfig();
  const provider = config.providers.adscards;
  if (!provider?.baseUrl) {
    throw new Error('adscards baseUrl is not configured');
  }

  const authToken = provider.authTokenForBody ?? provider.apiKey ?? '';
  if (!authToken) {
    throw new Error('adscards auth_token is not configured (authTokenForBody / apiKey)');
  }

  const cardId = parseInt(params.extId, 10);
  if (!Number.isFinite(cardId)) {
    throw new Error(`adscards: invalid ext_id for cards_id: ${params.extId}`);
  }

  const bearerSource = provider.apiKey ?? provider.authTokenForBody;
  const appAuth = applicationAuthorizationHeader(bearerSource);
  if (!appAuth) {
    throw new Error('adscards: Application-Authorization token is missing (apiKey / authTokenForBody)');
  }

  const http = getPaymentHttpClient(config);

  logger.info('cardBlock adscards: POST /cards/block', { cards_id: [cardId] });

  await http.request({
    bank: 'adscards',
    method: 'POST',
    path: '/cards/block',
    body: {
      auth_token: authToken,
      cards_id: [cardId],
    },
    headers: {
      'Application-Authorization': appAuth,
      'Content-Type': 'application/json',
    },
  });

  logger.info('cardBlock adscards: block done', { card_id: cardId });
}
