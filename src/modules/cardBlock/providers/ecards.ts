/**
 * eCards: токен через getEcardsAccessToken (create.ts), затем POST …/user/card/close { cardsIds }.
 * При error::unauthorized — повторный getEcardsAccessToken и второй close.
 */

import { getConfig } from '../../../config/index.js';
import { recordDirectProviderHttpIncident } from '../../../infra/index.js';
import { logger } from '../../../infra/logger.js';
import { getEcardsAccessToken } from '../../transactions/adapters/ecards/create.js';

function ecardsAccountBase(): string {
  const config = getConfig();
  const ecardsProvider = config.providers.ecards;
  const base = ecardsProvider?.baseUrl ?? '';
  const marker = '/api/modern/api-external/v1';
  const accountBase =
    base && base.includes(marker) ? base.split(marker)[0] : base;
  return (accountBase || 'https://ecardsnew.cab').replace(/\/+$/, '');
}

interface CloseResponse {
  meta?: unknown;
  data?: { success?: boolean };
  errors?: Array<{ code?: string }>;
}

function isUnauthorizedBody(json: CloseResponse): boolean {
  return json.errors?.some((e) => e.code === 'error::unauthorized') ?? false;
}

async function postCardClose(accessToken: string, cardsIds: number[]): Promise<CloseResponse> {
  const config = getConfig();
  const base = ecardsAccountBase();
  const url = `${base}/api/modern/account/v1/user/card/close`;
  const operation = 'user/card/close';

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ cardsIds }),
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    await recordDirectProviderHttpIncident(config, {
      source: 'ecards_card_block_fetch',
      kind: 'psp_network_error',
      bank: 'ecards',
      operation,
      error: err,
      detail: { cards_ids: cardsIds },
    });
    throw err;
  }

  const text = await res.text();
  let json: CloseResponse = {};
  try {
    json = text ? (JSON.parse(text) as CloseResponse) : {};
  } catch (parseErr) {
    const err = new Error(`ecards close: invalid JSON (${res.status}): ${text.slice(0, 200)}`);
    await recordDirectProviderHttpIncident(config, {
      source: 'ecards_card_block_fetch',
      kind: 'psp_response_parse_error',
      bank: 'ecards',
      operation,
      http_status: res.status,
      error: err,
      detail: { cards_ids: cardsIds, response_body_snippet: text.slice(0, 2000) },
    });
    throw err;
  }
  if (!res.ok || isUnauthorizedBody(json)) {
    if (isUnauthorizedBody(json) || res.status === 401) {
      return { ...json, errors: json.errors ?? [{ code: 'error::unauthorized' }] };
    }
    const err = new Error(`ecards close failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    await recordDirectProviderHttpIncident(config, {
      source: 'ecards_card_block_fetch',
      kind: 'psp_http_error',
      bank: 'ecards',
      operation,
      http_status: res.status,
      error: err,
      detail: { cards_ids: cardsIds, response_body_snippet: text.slice(0, 2000) },
    });
    throw err;
  }
  return json;
}

export async function blockEcardsCard(params: {
  cardNumber: number;
  extId?: string | null;
}): Promise<void> {
  const { cardNumber, extId } = params;
  const parsed =
    extId != null && extId !== '' ? parseInt(String(extId), 10) : cardNumber;
  const cardId = Number.isFinite(parsed) ? parsed : cardNumber;

  logger.info('cardBlock ecards: card/close', { card_number: cardNumber, cardsIds: [cardId] });

  let token = await getEcardsAccessToken();
  let out = await postCardClose(token, [cardId]);
  if (isUnauthorizedBody(out)) {
    logger.warn('cardBlock ecards: unauthorized, get token again and retry close');
    token = await getEcardsAccessToken();
    out = await postCardClose(token, [cardId]);
    if (isUnauthorizedBody(out)) {
      const config = getConfig();
      const err = new Error('ecards: close failed after second token (unauthorized)');
      await recordDirectProviderHttpIncident(config, {
        source: 'ecards_card_block_fetch',
        kind: 'psp_auth_failed',
        bank: 'ecards',
        operation: 'user/card/close',
        error: err,
        detail: { card_number: cardNumber, cards_ids: [cardId] },
      });
      throw err;
    }
  }

  logger.info('cardBlock ecards: close done', { cardsIds: [cardId] });
}
