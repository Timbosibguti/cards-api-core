/**
 * Создание карт через прямой вызов AdsCard API /cards/purchase
 * по мотивам AdsCardApiService.issueCards из mqtt_adscards_transactions.
 */

import type { PoolClient } from 'pg';
import { getConfig } from '../../../../config/index.js';
import { getDatabaseService, recordDirectProviderHttpIncident } from '../../../../infra/index.js';
import { logger } from '../../../../infra/logger.js';
import {
  getAffIdFromBinomByBuyer,
  getBinomByAffId,
  formatMulticardsAccNoFromBinom,
} from '../../../binom/index.js';
import {
  cardCreateAuditUserEmail,
  enqueueCardProviderCreateAudit,
  truncateCardCreateAuditText,
} from '../cardCreateAudit.js';

/** BIN (6 цифр) → bin_id в AdsCard (как в mqtt_ecards_transactions _ADSCARDS_BIN_TO_ID). */
const ADSCARDS_BIN_TO_ID: Record<string, number> = {
  '474366': 16, '474362': 17, '540542': 25, '475225': 27, '426289': 28,
  '443252': 44, '525797': 45, '539502': 46, '436120': 47, '400242': 49,
  '238003': 63, '223514': 66, '224002': 67, '516760': 71, '522692': 72,
  '428589': 73, '479727': 74, '556766': 75, '531561': 76,
};

function resolveAdscardsBinId(bin: number): number | null {
  const binStr = String(bin);
  if (binStr.length <= 3 && bin >= 1 && bin <= 200) {
    return bin;
  }
  const normalized = binStr.length >= 6 ? binStr.slice(0, 6) : binStr.padStart(6, '0');
  return ADSCARDS_BIN_TO_ID[normalized] ?? ADSCARDS_BIN_TO_ID[String(bin)] ?? null;
}

/**
 * Ответ AdsCard: либо `{ "0": { id, name }, ... }`, либо `{ data: ... }` (объект или массив).
 */
function parseAdscardsGroupsPayload(raw: unknown): Array<{ id: number; name: string }> {
  if (raw == null || typeof raw !== 'object') return [];
  const root = raw as Record<string, unknown>;
  let container: unknown = root;
  if ('data' in root && root.data != null) {
    container = root.data;
  }
  const out: Array<{ id: number; name: string }> = [];
  if (Array.isArray(container)) {
    for (const item of container) {
      if (item && typeof item === 'object' && 'id' in item) {
        const id = Number((item as { id: unknown }).id);
        const name = (item as { name?: unknown }).name;
        if (Number.isFinite(id)) {
          out.push({ id, name: name != null ? String(name).trim() : '' });
        }
      }
    }
    return out;
  }
  if (container && typeof container === 'object') {
    for (const v of Object.values(container as Record<string, unknown>)) {
      if (v && typeof v === 'object' && 'id' in v) {
        const id = Number((v as { id: unknown }).id);
        const name = (v as { name?: unknown }).name;
        if (Number.isFinite(id)) {
          out.push({ id, name: name != null ? String(name).trim() : '' });
        }
      }
    }
  }
  return out;
}

async function fetchAdscardsGroupsList(
  apiUrl: string,
  authToken: string,
  applicationAuth: string,
): Promise<Array<{ id: number; name: string }>> {
  const res = await fetch(`${apiUrl}/cards/groups`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Application-Authorization': applicationAuth,
    },
    body: JSON.stringify({ auth_token: authToken }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`AdsCard groups list failed: ${res.status} — ${truncateCardCreateAuditText(text)}`);
  }
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('AdsCard groups list: invalid JSON');
  }
  return parseAdscardsGroupsPayload(json);
}

/**
 * Группа с именем `binom.username / binom.aff_id` для выпуска карт на баера (как в Multicards).
 */
async function ensureAdscardsBuyerGroupId(
  client: PoolClient,
  buyerEmail: string,
  authToken: string,
  apiUrl: string,
  applicationAuth: string,
): Promise<{ groupId: number; groupName: string }> {
  const affId = await getAffIdFromBinomByBuyer(client, buyerEmail);
  if (affId == null) {
    throw new Error(`Adscards: buyer email not found in binom: ${buyerEmail}`);
  }
  const binomRow = await getBinomByAffId(client, affId);
  const groupName = formatMulticardsAccNoFromBinom(binomRow, affId);

  let groups = await fetchAdscardsGroupsList(apiUrl, authToken, applicationAuth);
  let found = groups.find((g) => g.name === groupName);
  if (!found) {
    const addRes = await fetch(`${apiUrl}/cards/groups_add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Application-Authorization': applicationAuth,
      },
      body: JSON.stringify({ auth_token: authToken, name: groupName }),
    });
    const addText = await addRes.text();
    if (!addRes.ok) {
      throw new Error(`AdsCard groups_add failed: ${addRes.status} — ${truncateCardCreateAuditText(addText)}`);
    }
    groups = await fetchAdscardsGroupsList(apiUrl, authToken, applicationAuth);
    found = groups.find((g) => g.name === groupName);
  }
  if (!found) {
    throw new Error(`Adscards: group "${groupName}" not found after groups_add`);
  }
  return { groupId: found.id, groupName };
}

/**
 * Выпуск карт через mqtt_adscards_transactions POST /api/cards/issue.
 * bin: 6-значный BIN или bin_id (1–200). quantity: 1–100.
 */
export async function createAdscardsCards(
  bin: number,
  quantity: number,
  _context?: { requestedByEmail?: string | null; buyerEmail?: string | null },
): Promise<{ created: number }> {
  const requestedBy = cardCreateAuditUserEmail(_context?.requestedByEmail);

  const binId = resolveAdscardsBinId(bin);
  logger.info('Adscards createAdscardsCards', { bin, quantity, binId, requestedBy });
  if (binId == null) {
    const err = new Error(
      `Invalid AdsCard BIN or bin_id: ${bin}. Use 6-digit BIN or bin_id from get-bins.`,
    );
    logger.error('Adscards: validation failed', { bin, error: err.message });
    await enqueueCardProviderCreateAudit({
      bank: 'adscards',
      source: 'adscards_create',
      eventType: 'adscards_cards_purchase_failed',
      logType: 'error',
      severity: 2,
      userEmail: requestedBy,
      eventAttributes: { stage: 'validation', reason: 'invalid_bin_or_bin_id', bin },
    });
    throw err;
  }

  const qty = Math.floor(quantity);
  if (qty < 1 || qty > 100) {
    const err = new Error('AdsCard count must be between 1 and 100');
    logger.error('Adscards: validation failed', { quantity: qty, error: err.message });
    await enqueueCardProviderCreateAudit({
      bank: 'adscards',
      source: 'adscards_create',
      eventType: 'adscards_cards_purchase_failed',
      logType: 'error',
      severity: 2,
      userEmail: requestedBy,
      eventAttributes: {
        stage: 'validation',
        reason: 'invalid_quantity',
        bin,
        bin_id: binId,
        quantity: qty,
      },
    });
    throw err;
  }

  const config = getConfig();
  const provider = config.providers.adscards;
  const baseUrl = provider?.baseUrl;
  if (!baseUrl) {
    const err = new Error('ADSCARD_API_URL/ADSCARDS_BASE_URL is not configured');
    logger.error('Adscards: config', { error: err.message });
    await enqueueCardProviderCreateAudit({
      bank: 'adscards',
      source: 'adscards_create',
      eventType: 'adscards_cards_purchase_failed',
      logType: 'error',
      severity: 2,
      userEmail: requestedBy,
      eventAttributes: {
        stage: 'validation',
        reason: 'missing_base_url',
        bin,
        bin_id: binId,
        quantity: qty,
      },
    });
    throw err;
  }

  const authToken =
    process.env.ADSCARD_AUTH_TOKEN ||
    process.env.ADSCARDS_AUTH_TOKEN ||
    provider.authTokenForBody;
  if (!authToken) {
    const err = new Error('ADSCARD_AUTH_TOKEN/ADSCARDS_AUTH_TOKEN must be configured for AdsCard card issue');
    logger.error('Adscards: config', { error: err.message });
    await enqueueCardProviderCreateAudit({
      bank: 'adscards',
      source: 'adscards_create',
      eventType: 'adscards_cards_purchase_failed',
      logType: 'error',
      severity: 2,
      userEmail: requestedBy,
      eventAttributes: {
        stage: 'validation',
        reason: 'missing_auth_token',
        bin,
        bin_id: binId,
        quantity: qty,
      },
    });
    throw err;
  }

  const apiUrl = baseUrl.replace(/\/+$/, '');
  const applicationAuth = provider.apiKey ?? '';

  const buyerEmailTrimmed = _context?.buyerEmail?.trim() ?? '';
  let adscardsGroupId: number | undefined;
  let adscardsGroupName: string | undefined;
  if (buyerEmailTrimmed) {
    try {
      const db = getDatabaseService(config);
      const resolved = await db.withTransaction('main', (client) =>
        ensureAdscardsBuyerGroupId(client, buyerEmailTrimmed, authToken, apiUrl, applicationAuth),
      );
      adscardsGroupId = resolved.groupId;
      adscardsGroupName = resolved.groupName;
      logger.info('Adscards create: buyer group resolved', {
        buyer_email: buyerEmailTrimmed,
        group_id: adscardsGroupId,
        group_name: adscardsGroupName,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error('Adscards create: buyer group resolution failed', {
        buyer_email: buyerEmailTrimmed,
        error: msg,
      });
      await enqueueCardProviderCreateAudit({
        bank: 'adscards',
        source: 'adscards_create',
        eventType: 'adscards_cards_purchase_failed',
        logType: 'error',
        severity: 2,
        userEmail: requestedBy,
        eventAttributes: {
          stage: 'adscards_buyer_group',
          reason: 'binom_or_groups',
          bin,
          bin_id: binId,
          quantity: qty,
          buyer_email: buyerEmailTrimmed,
          error: truncateCardCreateAuditText(msg),
        },
      });
      throw e;
    }
  }

  await enqueueCardProviderCreateAudit({
    bank: 'adscards',
    source: 'adscards_create',
    eventType: 'adscards_cards_purchase_requested',
    logType: 'info',
    severity: 1,
    userEmail: requestedBy,
    eventAttributes: {
      bin,
      bin_id: binId,
      quantity: qty,
      ...(buyerEmailTrimmed ? { buyer_email: buyerEmailTrimmed } : {}),
      ...(adscardsGroupId != null ? { adscards_group_id: adscardsGroupId, adscards_group_name: adscardsGroupName } : {}),
    },
  });

  const url = `${apiUrl}/cards/purchase`;

  let issueInfoResponse: Response;
  try {
    issueInfoResponse = await fetch(`${apiUrl}/cards/issue_info`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Application-Authorization': applicationAuth,
      },
      body: JSON.stringify({ auth_token: authToken }),
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    await recordDirectProviderHttpIncident(config, {
      source: 'adscards_fetch',
      kind: 'psp_network_error',
      bank: 'adscards',
      operation: 'cards/issue_info',
      error: err,
      detail: { bin_id: binId, quantity: qty },
    });
    throw err;
  }

  const issueInfoText = await issueInfoResponse.text();

  if (!issueInfoResponse.ok) {
    const errorText = issueInfoText;
    const msg = `AdsCard issue_info failed: ${issueInfoResponse.status} - ${errorText}`;
    logger.error('Adscards: issue_info failed', {
      bin_id: binId,
      quantity: qty,
      httpStatus: issueInfoResponse.status,
      body: truncateCardCreateAuditText(errorText),
    });
    await recordDirectProviderHttpIncident(config, {
      source: 'adscards_fetch',
      kind: 'psp_http_error',
      bank: 'adscards',
      operation: 'cards/issue_info',
      http_status: issueInfoResponse.status,
      error: new Error(msg),
      detail: {
        bin_id: binId,
        quantity: qty,
        response_body_snippet: errorText.slice(0, 2000),
      },
    });
    await enqueueCardProviderCreateAudit({
      bank: 'adscards',
      source: 'adscards_create',
      eventType: 'adscards_cards_purchase_failed',
      logType: 'error',
      severity: 3,
      userEmail: requestedBy,
      eventAttributes: {
        stage: 'issue_info',
        bin,
        bin_id: binId,
        quantity: qty,
        http_status: issueInfoResponse.status,
        error: truncateCardCreateAuditText(errorText),
      },
    });
    throw new Error(msg);
  }

  let issueData: { data?: { info?: Array<{ tr: number }> } };
  try {
    issueData = issueInfoText
      ? (JSON.parse(issueInfoText) as { data?: { info?: Array<{ tr: number }> } })
      : {};
  } catch (parseErr) {
    const err = parseErr instanceof Error ? parseErr : new Error(String(parseErr));
    await recordDirectProviderHttpIncident(config, {
      source: 'adscards_fetch',
      kind: 'psp_response_parse_error',
      bank: 'adscards',
      operation: 'cards/issue_info',
      http_status: issueInfoResponse.status,
      error: err,
      detail: {
        bin_id: binId,
        quantity: qty,
        response_body_snippet: issueInfoText.slice(0, 2000),
      },
    });
    throw err;
  }
  const infoList = issueData?.data?.info;
  const free = Array.isArray(infoList) ? infoList.filter((info) => info.tr > 0) : [];

  logger.info('Adscards create cards request', {
    bin_id: binId,
    quantity: qty,
    url,
    issue_info_slots_free: free.length,
  });

  const body: Record<string, unknown> = {
    auth_token: authToken,
    count: qty,
    bin: binId,
  };
  if (adscardsGroupId != null) {
    body.group_id = adscardsGroupId;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Application-Authorization': applicationAuth,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    await recordDirectProviderHttpIncident(config, {
      source: 'adscards_fetch',
      kind: 'psp_network_error',
      bank: 'adscards',
      operation: 'cards/purchase',
      error: err,
      detail: { bin_id: binId, quantity: qty },
    });
    throw err;
  }

  const purchaseText = await response.text();

  if (!response.ok) {
    const errorText = purchaseText;
    const msg = `AdsCard issue cards failed: ${response.status} - ${errorText}`;
    logger.error('Adscards: purchase failed', {
      bin_id: binId,
      quantity: qty,
      httpStatus: response.status,
      body: truncateCardCreateAuditText(errorText),
    });
    await recordDirectProviderHttpIncident(config, {
      source: 'adscards_fetch',
      kind: 'psp_http_error',
      bank: 'adscards',
      operation: 'cards/purchase',
      http_status: response.status,
      error: new Error(msg),
      detail: {
        bin_id: binId,
        quantity: qty,
        response_body_snippet: errorText.slice(0, 2000),
      },
    });
    await enqueueCardProviderCreateAudit({
      bank: 'adscards',
      source: 'adscards_create',
      eventType: 'adscards_cards_purchase_failed',
      logType: 'error',
      severity: 3,
      userEmail: requestedBy,
      eventAttributes: {
        stage: 'cards_purchase',
        bin,
        bin_id: binId,
        quantity: qty,
        http_status: response.status,
        error: truncateCardCreateAuditText(errorText),
      },
    });
    throw new Error(msg);
  }

  let data: { data?: unknown };
  try {
    data = purchaseText ? (JSON.parse(purchaseText) as { data?: unknown }) : {};
  } catch (parseErr) {
    const err = parseErr instanceof Error ? parseErr : new Error(String(parseErr));
    await recordDirectProviderHttpIncident(config, {
      source: 'adscards_fetch',
      kind: 'psp_response_parse_error',
      bank: 'adscards',
      operation: 'cards/purchase',
      http_status: response.status,
      error: err,
      detail: {
        bin_id: binId,
        quantity: qty,
        response_body_snippet: purchaseText.slice(0, 2000),
      },
    });
    throw err;
  }

  let issued = 0;
  if (data.data) {
    if (Array.isArray(data.data)) {
      issued = data.data.length;
    } else if (typeof data.data === 'object') {
      issued = Object.keys(data.data as Record<string, unknown>).length;
    }
  }
  const created = issued > 0 ? issued : qty;

  logger.info('Adscards create cards done', {
    bin_id: binId,
    requested: qty,
    created,
    ...(adscardsGroupId != null ? { adscards_group_id: adscardsGroupId } : {}),
  });

  await enqueueCardProviderCreateAudit({
    bank: 'adscards',
    source: 'adscards_create',
    eventType: 'adscards_cards_purchase_succeeded',
    logType: 'info',
    severity: 1,
    userEmail: requestedBy,
    eventAttributes: {
      bin,
      bin_id: binId,
      quantity_requested: qty,
      quantity_created: created,
      ...(buyerEmailTrimmed ? { buyer_email: buyerEmailTrimmed } : {}),
      ...(adscardsGroupId != null ? { adscards_group_id: adscardsGroupId, adscards_group_name: adscardsGroupName } : {}),
    },
  });

  return { created };
}
