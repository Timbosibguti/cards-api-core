/**
 * Создание карт через прямой вызов Multicards API /v1/card/batchIssue
 * по мотивам MulticardsService.batchIssueCards из mqtt_multicards_transactions.
 * bin = bankId в Multicards (например 73 для BIN 534786).
 */

import { getConfig, type AppConfig } from '../../../../config/index.js';
import { getDatabaseService, recordDirectProviderHttpIncident } from '../../../../infra/index.js';
import { logger } from '../../../../infra/logger.js';
import {
  cardCreateAuditUserEmail,
  enqueueCardProviderCreateAudit,
  truncateCardCreateAuditText,
} from '../cardCreateAudit.js';
import { getAffIdFromBinomByBuyer } from '../../../binom/index.js';

interface MulticardsCardGroupRow {
  id: number;
  name?: string;
  owner?: string;
}

interface MulticardsAuthResponse {
  token?: string;
  expires?: number;
}

async function ensureMulticardsIssueToken(): Promise<string> {
  const config = getConfig();
  const provider = config.providers.multicards;
  const baseUrl = provider?.baseUrl;
  const issueEmail = process.env.MULTICARDS_ISSUE_EMAIL ?? process.env.MULTICARDS_EMAIL ?? provider?.username;
  const issuePassword = process.env.MULTICARDS_ISSUE_PASSWORD ?? provider?.password;

  if (!baseUrl) {
    throw new Error('MULTICARDS_BASE_URL is not configured');
  }
  if (!issueEmail || !issuePassword) {
    throw new Error('MULTICARDS_ISSUE_EMAIL / MULTICARDS_ISSUE_PASSWORD (или MULTICARDS_EMAIL/PASSWORD) not configured');
  }

  logger.info('Multicards issue: requesting token', { email: issueEmail });

  const loginUrl = `${baseUrl.replace(/\/+$/, '')}/v1/auth/login`;
  const loginOp = 'v1/auth/login';

  let response: Response;
  try {
    response = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: issueEmail,
        password: issuePassword,
        secondFactorCode: '',
        captcha: '',
      }),
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    await recordDirectProviderHttpIncident(config, {
      source: 'multicards_fetch',
      kind: 'psp_network_error',
      bank: 'multicards',
      operation: loginOp,
      error: err,
    });
    throw err;
  }

  const loginText = await response.text();

  if (!response.ok) {
    const err = new Error(`Multicards issue login failed: ${response.status} — ${loginText}`);
    await recordDirectProviderHttpIncident(config, {
      source: 'multicards_fetch',
      kind: 'psp_http_error',
      bank: 'multicards',
      operation: loginOp,
      http_status: response.status,
      error: err,
      detail: { response_body_snippet: loginText.slice(0, 2000) },
    });
    throw err;
  }

  let json: MulticardsAuthResponse;
  try {
    json = loginText ? (JSON.parse(loginText) as MulticardsAuthResponse) : {};
  } catch (parseErr) {
    const err = parseErr instanceof Error ? parseErr : new Error(String(parseErr));
    await recordDirectProviderHttpIncident(config, {
      source: 'multicards_fetch',
      kind: 'psp_response_parse_error',
      bank: 'multicards',
      operation: loginOp,
      http_status: response.status,
      error: err,
      detail: { response_body_snippet: loginText.slice(0, 2000) },
    });
    throw err;
  }

  const token = json.token ?? null;
  if (!token) {
    const err = new Error('Multicards issue login: token is missing in response');
    await recordDirectProviderHttpIncident(config, {
      source: 'multicards_fetch',
      kind: 'psp_response_invalid',
      bank: 'multicards',
      operation: loginOp,
      http_status: response.status,
      error: err,
      detail: { response_body_snippet: loginText.slice(0, 2000) },
    });
    throw err;
  }

  logger.info('Multicards issue: token obtained', {
    tokenLength: token.length,
    expiresIn: json.expires,
  });

  return token;
}

export const MULTICARDS_BINS: Record<
  number,
  { bin: string; name: string; currency: string }
> = {
  50:  { bin: '539502', name: 'HK USD',  currency: 'usd' },
  51:  { bin: '238003', name: 'GB USD',  currency: 'usd' },
  53:  { bin: '235019', name: 'GB USD',  currency: 'usd' },
  54:  { bin: '223600', name: 'HK USD',  currency: 'usd' },
  56:  { bin: '525797', name: 'HK USD',  currency: 'usd' },
  64:  { bin: '553370', name: 'US USD',  currency: 'usd' },
  67:  { bin: '559292', name: 'US USD',  currency: 'usd' },
  70:  { bin: '440238', name: 'EU USD',  currency: 'usd' },
  71:  { bin: '531993', name: 'US USD',  currency: 'usd' },
  73:  { bin: '534786', name: 'US USD',  currency: 'usd' },
  77:  { bin: '519075', name: 'US USD',  currency: 'usd' },
  85:  { bin: '428803', name: 'EU USD',  currency: 'usd' },
  86:  { bin: '401994', name: 'US USD',  currency: 'usd' },
  91:  { bin: '539186', name: 'HK USD',  currency: 'usd' },
  92:  { bin: '434932', name: 'US USD',  currency: 'usd' },
  93:  { bin: '556371', name: 'US USD',  currency: 'usd' },
  122: { bin: '53602586', name: 'US USD', currency: 'usd' },
  123: { bin: '53602505', name: 'US USD', currency: 'usd' },
  124: { bin: '53602595', name: 'US USD', currency: 'usd' },
  126: { bin: '53602591', name: 'US USD', currency: 'usd' },
  127: { bin: '53602544', name: 'US USD', currency: 'usd' },
  128: { bin: '53602524', name: 'Surprise NEW (USD)', currency: 'usd' },
  129: { bin: '53602570', name: 'US USD', currency: 'usd' },
  130: { bin: '53602523', name: 'US USD', currency: 'usd' },
  131: { bin: '53602560', name: 'US USD', currency: 'usd' },
  139: { bin: '536025896', name: 'US USD', currency: 'usd' },
  145: { bin: '426289', name: 'EU USD',  currency: 'usd' },
};

function resolveMulticardsBankId(bin: number): number | null {
  const direct = MULTICARDS_BINS[bin];
  if (direct) return bin;

  const binStr = String(bin);
  const entry = Object.entries(MULTICARDS_BINS).find(
    ([, info]) => info.bin === binStr,
  );
  return entry ? Number(entry[0]) : null;
}

function findMulticardsCardGroupId(
  groups: MulticardsCardGroupRow[],
  affId: number,
  buyerEmail: string,
): number | null {
  const affStr = String(affId);
  const buyerLower = buyerEmail.trim().toLowerCase();
  for (const g of groups) {
    if (g.id == null || !Number.isFinite(Number(g.id))) continue;
    const name = g.name != null ? String(g.name).trim() : '';
    if (name === affStr) return Number(g.id);
  }
  for (const g of groups) {
    if (g.id == null || !Number.isFinite(Number(g.id))) continue;
    const owner = g.owner != null ? String(g.owner).trim().toLowerCase() : '';
    if (owner && owner === buyerLower) return Number(g.id);
  }
  return null;
}

async function fetchMulticardsCardGroupList(
  config: AppConfig,
  baseUrl: string,
  token: string,
): Promise<MulticardsCardGroupRow[]> {
  const listOp = 'v1/card/group/list';
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/card/group/list?includeTeamGroups=false`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: '*/*',
        'x-auth-token': token,
      },
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    await recordDirectProviderHttpIncident(config, {
      source: 'multicards_fetch',
      kind: 'psp_network_error',
      bank: 'multicards',
      operation: listOp,
      error: err,
    });
    throw err;
  }

  const text = await response.text();
  if (!response.ok) {
    const msg = `Multicards card group list failed: ${response.status} — ${text}`;
    await recordDirectProviderHttpIncident(config, {
      source: 'multicards_fetch',
      kind: 'psp_http_error',
      bank: 'multicards',
      operation: listOp,
      http_status: response.status,
      error: new Error(msg),
      detail: { response_body_snippet: text.slice(0, 2000) },
    });
    throw new Error(msg);
  }

  let data: unknown;
  try {
    data = text ? JSON.parse(text) : [];
  } catch (parseErr) {
    const err = parseErr instanceof Error ? parseErr : new Error(String(parseErr));
    await recordDirectProviderHttpIncident(config, {
      source: 'multicards_fetch',
      kind: 'psp_response_parse_error',
      bank: 'multicards',
      operation: listOp,
      http_status: response.status,
      error: err,
      detail: { response_body_snippet: text.slice(0, 2000) },
    });
    throw err;
  }

  return Array.isArray(data) ? (data as MulticardsCardGroupRow[]) : [];
}

async function createMulticardsCardGroup(
  config: AppConfig,
  baseUrl: string,
  token: string,
  name: string,
): Promise<number> {
  const createOp = 'v1/card/group/create';
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/card/group/create`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: '*/*',
        'Content-Type': 'application/json',
        'x-auth-token': token,
      },
      body: JSON.stringify({ name }),
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    await recordDirectProviderHttpIncident(config, {
      source: 'multicards_fetch',
      kind: 'psp_network_error',
      bank: 'multicards',
      operation: createOp,
      error: err,
      detail: { group_name: name },
    });
    throw err;
  }

  const text = await response.text();
  if (!response.ok) {
    const msg = `Multicards card group create failed: ${response.status} — ${text}`;
    await recordDirectProviderHttpIncident(config, {
      source: 'multicards_fetch',
      kind: 'psp_http_error',
      bank: 'multicards',
      operation: createOp,
      http_status: response.status,
      error: new Error(msg),
      detail: {
        group_name: name,
        response_body_snippet: text.slice(0, 2000),
      },
    });
    throw new Error(msg);
  }

  let json: { id?: number };
  try {
    json = text ? (JSON.parse(text) as { id?: number }) : {};
  } catch (parseErr) {
    const err = parseErr instanceof Error ? parseErr : new Error(String(parseErr));
    await recordDirectProviderHttpIncident(config, {
      source: 'multicards_fetch',
      kind: 'psp_response_parse_error',
      bank: 'multicards',
      operation: createOp,
      http_status: response.status,
      error: err,
      detail: { response_body_snippet: text.slice(0, 2000) },
    });
    throw err;
  }

  const id = json.id;
  if (id == null || !Number.isFinite(Number(id))) {
    const err = new Error('Multicards card group create: id is missing in response');
    await recordDirectProviderHttpIncident(config, {
      source: 'multicards_fetch',
      kind: 'psp_response_invalid',
      bank: 'multicards',
      operation: createOp,
      http_status: response.status,
      error: err,
      detail: { response_body_snippet: text.slice(0, 2000) },
    });
    throw err;
  }

  return Number(id);
}

/**
 * Выпуск карт через Multicards /v1/card/batchIssue.
 * bin: bankId в Multicards (положительное целое). quantity: 1–100.
 */
export async function createMulticardsCards(
  bin: number,
  quantity: number,
  context?: { requestedByEmail?: string | null; buyerEmail?: string | null },
): Promise<{ created: number }> {
  const requestedBy = cardCreateAuditUserEmail(context?.requestedByEmail);
  const bankId = resolveMulticardsBankId(bin);
  logger.info('Multicards batchIssue createMulticardsCards', { bin, quantity, bankId, requestedBy });
  if (bankId == null) {
    const err = new Error(`Invalid Multicards batchIssue bankId: ${bin}. Use bankId from get-bins (e.g. 73).`);
    logger.error('Multicards batchIssue: validation failed', { bin, error: err.message });
    await enqueueCardProviderCreateAudit({
      bank: 'multicards',
      source: 'multicards_create',
      eventType: 'multicards_batch_issue_failed',
      logType: 'error',
      severity: 2,
      userEmail: requestedBy,
      eventAttributes: {
        stage: 'validation',
        reason: 'invalid_bank_id',
        bin,
      },
    });
    throw err;
  }

  const qty = Math.floor(quantity);
  if (qty < 1 || qty > 100) {
    const err = new Error('Multicards batchIssue quantity must be between 1 and 100');
    logger.error('Multicards batchIssue: validation failed', { quantity: qty, error: err.message });
    await enqueueCardProviderCreateAudit({
      bank: 'multicards',
      source: 'multicards_create',
      eventType: 'multicards_batch_issue_failed',
      logType: 'error',
      severity: 2,
      userEmail: requestedBy,
      eventAttributes: {
        stage: 'validation',
        reason: 'invalid_quantity',
        bin,
        bank_id: bankId,
        quantity: qty,
      },
    });
    throw err;
  }

  const config = getConfig();
  const provider = config.providers.multicards;
  const baseUrl = provider?.baseUrl;
  if (!baseUrl) {
    const err = new Error('MULTICARDS_BASE_URL is not configured');
    logger.error('Multicards batchIssue: config', { error: err.message });
    await enqueueCardProviderCreateAudit({
      bank: 'multicards',
      source: 'multicards_create',
      eventType: 'multicards_batch_issue_failed',
      logType: 'error',
      severity: 2,
      userEmail: requestedBy,
      eventAttributes: {
        stage: 'validation',
        reason: 'missing_base_url',
        bin,
        bank_id: bankId,
        quantity: qty,
      },
    });
    throw err;
  }

  const binInfo = MULTICARDS_BINS[bankId];
  const buyerEmailTrimmed = context?.buyerEmail?.trim() ?? '';
  await enqueueCardProviderCreateAudit({
    bank: 'multicards',
    source: 'multicards_create',
    eventType: 'multicards_batch_issue_requested',
    logType: 'info',
    severity: 1,
    userEmail: requestedBy,
    eventAttributes: {
      bin,
      bank_id: bankId,
      bin_label: binInfo?.name ?? null,
      bin_prefix: binInfo?.bin ?? null,
      currency: binInfo?.currency ?? null,
      quantity: qty,
      ...(buyerEmailTrimmed ? { buyer_email: buyerEmailTrimmed } : {}),
    },
  });

  let token: string;
  try {
    token = await ensureMulticardsIssueToken();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('Multicards batchIssue: auth login failed', { bankId, quantity: qty, error: msg });
    await enqueueCardProviderCreateAudit({
      bank: 'multicards',
      source: 'multicards_create',
      eventType: 'multicards_batch_issue_failed',
      logType: 'error',
      severity: 3,
      userEmail: requestedBy,
      eventAttributes: {
        stage: 'auth_login',
        bin,
        bank_id: bankId,
        quantity: qty,
        error: truncateCardCreateAuditText(msg),
      },
    });
    throw e;
  }

  let cardGroupId: number | undefined;
  let buyerAffId: number | undefined;
  if (buyerEmailTrimmed) {
    const db = getDatabaseService(config);
    const affId = await db.withTransaction('main', (client) =>
      getAffIdFromBinomByBuyer(client, buyerEmailTrimmed),
    );
    if (affId == null) {
      const err = new Error(`Multicards: buyer email not found in binom: ${buyerEmailTrimmed}`);
      logger.error('Multicards batchIssue: binom buyer lookup failed', {
        buyerEmail: buyerEmailTrimmed,
        error: err.message,
      });
      await enqueueCardProviderCreateAudit({
        bank: 'multicards',
        source: 'multicards_create',
        eventType: 'multicards_batch_issue_failed',
        logType: 'error',
        severity: 2,
        userEmail: requestedBy,
        eventAttributes: {
          stage: 'binom_buyer_lookup',
          reason: 'buyer_not_found',
          bin,
          bank_id: bankId,
          quantity: qty,
          buyer_email: buyerEmailTrimmed,
        },
      });
      throw err;
    }
    buyerAffId = affId;
    const groups = await fetchMulticardsCardGroupList(config, baseUrl, token);
    let gid = findMulticardsCardGroupId(groups, affId, buyerEmailTrimmed);
    if (gid == null) {
      gid = await createMulticardsCardGroup(config, baseUrl, token, String(affId));
    }
    cardGroupId = gid;
  }

  const numCards = qty;
  const payload: Record<string, unknown> = { numCards };

  payload.bankId = bankId;
  payload.note = `BIN bankId: ${bin}`;
  if (cardGroupId != null) {
    payload.cardGroupId = cardGroupId;
  }

  logger.info('Multicards create cards (batchIssue) request', {
    bankId,
    quantity: numCards,
    cardGroupId: cardGroupId ?? null,
    buyerAffId: buyerAffId ?? null,
    payload,
  });

  const batchUrl = `${baseUrl.replace(/\/+$/, '')}/v1/card/batchIssue`;
  const batchOp = 'v1/card/batchIssue';

  let response: Response;
  try {
    response = await fetch(batchUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-auth-token': token,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    await recordDirectProviderHttpIncident(config, {
      source: 'multicards_fetch',
      kind: 'psp_network_error',
      bank: 'multicards',
      operation: batchOp,
      error: err,
      detail: { bank_id: bankId, quantity: numCards },
    });
    throw err;
  }

  if (!response.ok) {
    const errorText = await response.text();
    const msg = `Multicards batchIssue failed: ${response.status} — ${errorText}`;
    logger.error('Multicards batchIssue: API error', {
      bankId,
      quantity: numCards,
      httpStatus: response.status,
      body: truncateCardCreateAuditText(errorText),
    });
    await recordDirectProviderHttpIncident(config, {
      source: 'multicards_fetch',
      kind: 'psp_http_error',
      bank: 'multicards',
      operation: batchOp,
      http_status: response.status,
      error: new Error(msg),
      detail: {
        bank_id: bankId,
        quantity: numCards,
        response_body_snippet: errorText.slice(0, 2000),
      },
    });
    await enqueueCardProviderCreateAudit({
      bank: 'multicards',
      source: 'multicards_create',
      eventType: 'multicards_batch_issue_failed',
      logType: 'error',
      severity: 3,
      userEmail: requestedBy,
      eventAttributes: {
        stage: 'batch_issue',
        bin,
        bank_id: bankId,
        quantity: numCards,
        http_status: response.status,
        error: truncateCardCreateAuditText(errorText),
        ...(cardGroupId != null ? { card_group_id: cardGroupId } : {}),
        ...(buyerAffId != null ? { buyer_aff_id: buyerAffId } : {}),
      },
    });
    throw new Error(msg);
  }

  const okText = await response.text();
  let json: Record<string, unknown>;
  try {
    json = okText ? (JSON.parse(okText) as Record<string, unknown>) : {};
  } catch (parseErr) {
    const err = parseErr instanceof Error ? parseErr : new Error(String(parseErr));
    await recordDirectProviderHttpIncident(config, {
      source: 'multicards_fetch',
      kind: 'psp_response_parse_error',
      bank: 'multicards',
      operation: batchOp,
      http_status: response.status,
      error: err,
      detail: {
        bank_id: bankId,
        quantity: numCards,
        response_body_snippet: okText.slice(0, 2000),
      },
    });
    throw err;
  }

  logger.info('Multicards batchIssue create cards done', {
    bankId,
    requested: numCards,
    batchId: json.id,
  });

  await enqueueCardProviderCreateAudit({
    bank: 'multicards',
    source: 'multicards_create',
    eventType: 'multicards_batch_issue_succeeded',
    logType: 'info',
    severity: 1,
    userEmail: requestedBy,
    eventAttributes: {
      bin,
      bank_id: bankId,
      quantity: numCards,
      batch_id: json.id ?? null,
      ...(cardGroupId != null ? { card_group_id: cardGroupId } : {}),
      ...(buyerAffId != null ? { buyer_aff_id: buyerAffId } : {}),
    },
  });

  return { created: numCards };
}
