/**
 * Создание карт через eCards API.
 * Совместимость с mqtt_ecards_transactions: POST /modern/account/v1/user/card.
 * Созданные карты подхватятся существующим поллингом карт, отдельно поллить не нужно.
 */

import { getConfig } from '../../../../config/index.js';
import { getPaymentHttpClient, recordDirectProviderHttpIncident } from '../../../../infra/index.js';
import { logger } from '../../../../infra/logger.js';
import {
  cardCreateAuditUserEmail,
  enqueueCardProviderCreateAudit,
  truncateCardCreateAuditText,
} from '../cardCreateAudit.js';

/** BIN → данные для API создания карт (accountId, productUniqueId, velocityControl). */
const ECARDS_BINS: Record<
  string,
  {
    accountId: number;
    productUniqueId: string;
    velocityControl: {
      limitDaily: string;
      limitWeekly: string;
      limitMonthly: string;
      limitAlltime: string;
    };
  }
> = {
  'ecards:479726': {
    accountId: 14697,
    productUniqueId: '5d34a054-06f8-44ee-a607-61950d2e2918',
    velocityControl: {
      limitDaily: '1000',
      limitWeekly: '1000',
      limitMonthly: '1000',
      limitAlltime: '',
    },
  },
  'ecards:450897': {
    accountId: 15270,
    productUniqueId: '87195ff3-c4c9-4613-a8da-d1a108054e65',
    velocityControl: {
      limitDaily: '',
      limitWeekly: '',
      limitMonthly: '',
      limitAlltime: '50',
    },
  },
  'ecards:428852': {
    accountId: 14920,
    productUniqueId: 'c896b710-9349-4f53-9a8e-40a965391c70',
    velocityControl: {
      limitDaily: '',
      limitWeekly: '',
      limitMonthly: '',
      limitAlltime: '1000',
    },
  },
  'ecards:428842': {
    accountId: 15933,
    productUniqueId: 'def23b51-7a43-4e03-a0f0-87b9ded1568d',
    velocityControl: {
      limitDaily: '',
      limitWeekly: '',
      limitMonthly: '',
      limitAlltime: '1000',
    },
  },
};

export function resolveEcardsBin(bin: number): {
  key: string;
  accountId: number;
  productUniqueId: string;
  velocityControl: { limitDaily: string; limitWeekly: string; limitMonthly: string; limitAlltime: string };
} | null {
  const key = `ecards:${bin}`;
  const mapped = ECARDS_BINS[key];
  if (!mapped) return null;
  return { key, ...mapped };
}

/** База URL аккаунта eCards (без api-external), как для /user/card и /user/card-group. */
export function getEcardsAccountBaseUrl(): string {
  const config = getConfig();
  const base = config.providers.ecards?.baseUrl ?? '';
  const marker = '/api/modern/api-external/v1';
  return base.includes(marker) ? base.split(marker)[0] : base;
}

interface EcardsAuthResponse {
  data?: {
    accessToken?: string;
    refreshToken?: string;
  };
}

export async function getEcardsAccessToken(): Promise<string> {
  const config = getConfig();
  const ecardsProvider = config.providers.ecards;
  if (!ecardsProvider?.baseUrl) {
    throw new Error('ECARDS_BASE_URL is not configured');
  }

  const authUrl = `https://ecardsnew.cab/api/modern/user/v1/guest/auth/sign-in`;

  if (!ecardsProvider.username || !ecardsProvider.password) {
    throw new Error('ECARDS_USERNAME/ECARDS_PASSWORD must be configured for eCards auth');
  }

  const operation = 'guest/auth/sign-in';

  let resp: Response;
  try {
    resp = await fetch(authUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: ecardsProvider.username,
        password: ecardsProvider.password,
      }),
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    await recordDirectProviderHttpIncident(config, {
      source: 'ecards_fetch',
      kind: 'psp_network_error',
      bank: 'ecards',
      operation,
      error: err,
    });
    throw err;
  }

  const text = await resp.text();

  if (!resp.ok) {
    logger.error('Ecards auth sign-in failed', {
      status: resp.status,
      statusText: resp.statusText,
      body: text,
    });
    const err = new Error(`Failed to obtain eCards access token: HTTP ${resp.status}`);
    await recordDirectProviderHttpIncident(config, {
      source: 'ecards_fetch',
      kind: 'psp_http_error',
      bank: 'ecards',
      operation,
      http_status: resp.status,
      error: err,
      detail: {
        response_body_snippet: text.slice(0, 2000),
      },
    });
    throw err;
  }

  let json: EcardsAuthResponse;
  try {
    json = text ? (JSON.parse(text) as EcardsAuthResponse) : {};
  } catch (parseErr) {
    const err =
      parseErr instanceof Error ? parseErr : new Error(String(parseErr));
    await recordDirectProviderHttpIncident(config, {
      source: 'ecards_fetch',
      kind: 'psp_response_parse_error',
      bank: 'ecards',
      operation,
      http_status: resp.status,
      error: err,
      detail: { response_body_snippet: text.slice(0, 2000) },
    });
    throw err;
  }

  const token = json?.data?.accessToken;
  if (!token) {
    logger.error('Ecards auth sign-in: accessToken missing in response', { response: json });
    const err = new Error('Ecards accessToken is missing in auth response');
    await recordDirectProviderHttpIncident(config, {
      source: 'ecards_fetch',
      kind: 'psp_response_invalid',
      bank: 'ecards',
      operation,
      http_status: resp.status,
      error: err,
      detail: { response_body_snippet: text.slice(0, 2000) },
    });
    throw err;
  }

  return token;
}

/**
 * Создать карты в eCards по BIN и количеству.
 * Вызов POST /modern/account/v1/user/card; созданные карты появятся при поллинге карт.
 */
export async function createEcardsCards(
  bin: number,
  quantity: number,
  _context?: { requestedByEmail?: string | null },
): Promise<{ created: number }> {
  const requestedBy = cardCreateAuditUserEmail(_context?.requestedByEmail);

  const ecardsBin = resolveEcardsBin(bin);
  logger.info('Ecards createEcardsCards', { bin, ecardsBinKey: ecardsBin?.key, requestedBy });
  if (!ecardsBin) {
    const err = new Error(`Invalid eCards BIN: ${bin}. Supported keys: ${Object.keys(ECARDS_BINS).join(', ')}`);
    logger.error('Ecards: validation failed', { bin, error: err.message });
    await enqueueCardProviderCreateAudit({
      bank: 'ecards',
      source: 'ecards_create',
      eventType: 'ecards_cards_create_failed',
      logType: 'error',
      severity: 2,
      userEmail: requestedBy,
      eventAttributes: { stage: 'validation', reason: 'invalid_bin', bin },
    });
    throw err;
  }

  const qty = Math.floor(quantity);
  if (qty < 1) {
    const err = new Error('Quantity must be at least 1');
    logger.error('Ecards: validation failed', { quantity: qty, error: err.message });
    await enqueueCardProviderCreateAudit({
      bank: 'ecards',
      source: 'ecards_create',
      eventType: 'ecards_cards_create_failed',
      logType: 'error',
      severity: 2,
      userEmail: requestedBy,
      eventAttributes: {
        stage: 'validation',
        reason: 'invalid_quantity',
        bin,
        ecards_bin_key: ecardsBin.key,
        quantity: qty,
      },
    });
    throw err;
  }

  const config = getConfig();
  const ecardsProvider = config.providers.ecards;
  if (!ecardsProvider?.baseUrl?.trim()) {
    const err = new Error('ECARDS_BASE_URL is not configured');
    logger.error('Ecards: config', { error: err.message });
    await enqueueCardProviderCreateAudit({
      bank: 'ecards',
      source: 'ecards_create',
      eventType: 'ecards_cards_create_failed',
      logType: 'error',
      severity: 2,
      userEmail: requestedBy,
      eventAttributes: {
        stage: 'validation',
        reason: 'missing_base_url',
        bin,
        ecards_bin_key: ecardsBin.key,
        quantity: qty,
      },
    });
    throw err;
  }

  const http = getPaymentHttpClient(config);
  const accountBase = getEcardsAccountBaseUrl();

  await enqueueCardProviderCreateAudit({
    bank: 'ecards',
    source: 'ecards_create',
    eventType: 'ecards_cards_create_requested',
    logType: 'info',
    severity: 1,
    userEmail: requestedBy,
    eventAttributes: {
      bin,
      ecards_bin_key: ecardsBin.key,
      account_id: ecardsBin.accountId,
      product_unique_id: ecardsBin.productUniqueId,
      quantity: qty,
    },
  });

  let accessToken: string;
  try {
    accessToken = await getEcardsAccessToken();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('Ecards: auth sign-in failed', { bin: ecardsBin.key, quantity: qty, error: msg });
    await enqueueCardProviderCreateAudit({
      bank: 'ecards',
      source: 'ecards_create',
      eventType: 'ecards_cards_create_failed',
      logType: 'error',
      severity: 3,
      userEmail: requestedBy,
      eventAttributes: {
        stage: 'auth_login',
        bin,
        ecards_bin_key: ecardsBin.key,
        quantity: qty,
        error: truncateCardCreateAuditText(msg),
      },
    });
    throw e;
  }

  const createPayload = {
    quantity: qty,
    accountId: ecardsBin.accountId,
    productUniqueId: ecardsBin.productUniqueId,
    options: {
      velocityControl: {
        limitDaily: ecardsBin.velocityControl.limitDaily,
        limitWeekly: ecardsBin.velocityControl.limitWeekly,
        limitMonthly: ecardsBin.velocityControl.limitMonthly,
        limitAlltime: ecardsBin.velocityControl.limitAlltime,
      },
    },
  };

  logger.info('Ecards create cards request', {
    bin: ecardsBin.key,
    quantity: qty,
  });

  let response: { data?: { content?: unknown[] }; content?: unknown[] };
  try {
    response = await http.request<{ data?: { content?: unknown[] }; content?: unknown[] }>({
      bank: 'ecards',
      method: 'POST',
      baseUrlOverride: accountBase || undefined,
      path: '/api/modern/account/v1/user/card',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: createPayload,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('Ecards create cards API failed', {
      bin: ecardsBin.key,
      quantity: qty,
      error: truncateCardCreateAuditText(msg),
    });
    await enqueueCardProviderCreateAudit({
      bank: 'ecards',
      source: 'ecards_create',
      eventType: 'ecards_cards_create_failed',
      logType: 'error',
      severity: 3,
      userEmail: requestedBy,
      eventAttributes: {
        stage: 'create_api',
        bin,
        ecards_bin_key: ecardsBin.key,
        quantity: qty,
        error: truncateCardCreateAuditText(msg),
      },
    });
    throw e;
  }

  const content = response?.data?.content ?? response?.content;
  const createdCount = Array.isArray(content) ? content.length : qty;

  logger.info('Ecards create cards done', {
    bin: ecardsBin.key,
    requested: qty,
    created: createdCount,
  });

  await enqueueCardProviderCreateAudit({
    bank: 'ecards',
    source: 'ecards_create',
    eventType: 'ecards_cards_create_succeeded',
    logType: 'info',
    severity: 1,
    userEmail: requestedBy,
    eventAttributes: {
      bin,
      ecards_bin_key: ecardsBin.key,
      account_id: ecardsBin.accountId,
      quantity_requested: qty,
      quantity_created: createdCount,
    },
  });

  return { created: createdCount };
}

/**
 * Снять лимиты с карты eCards при передаче профиля сотруднику.
 * POST /modern/account/v1/user/card/set-velocity-control с пустыми лимитами.
 * id карты — ext_id из bank_cards (или card_number как fallback).
 */
export async function removeEcardsLimits(params: {
  cardNumber: number;
  extId?: string | null;
  buyerEmail: string;
}): Promise<void> {
  const { cardNumber, extId, buyerEmail } = params;
  const cardId = extId != null && extId !== '' ? parseInt(String(extId), 10) : cardNumber;
  const id = Number.isFinite(cardId) ? cardId : cardNumber;

  const config = getConfig();
  const http = getPaymentHttpClient(config);

  const ecardsProvider = config.providers.ecards;
  const base = ecardsProvider?.baseUrl ?? '';
  const marker = '/api/modern/api-external/v1';
  const accountBase =
    base && base.includes(marker) ? base.split(marker)[0] : base;

  const payload = {
    cardsLimits: [
      {
        id,
        daily: '',
        weekly: '',
        monthly: '',
        alltime: '',
      },
    ],
  };

  logger.info('Ecards remove limits request', { card_number: cardNumber, id, buyer_email: buyerEmail });

  // eCards endpoint /set-velocity-control expects the same guest bearer token
  // as used in createEcardsCards() (/user/v1/guest/auth/sign-in).
  const accessToken = await getEcardsAccessToken();

  await http.request({
    bank: 'ecards',
    method: 'POST',
    baseUrlOverride: accountBase || undefined,
    path: '/api/modern/account/v1/user/card/set-velocity-control',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: payload,
  });

  logger.info('Ecards remove limits done', { card_number: cardNumber, buyer_email: buyerEmail });
}
