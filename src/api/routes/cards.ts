/**
 * REST api/cards/* — farm-extension, совместимость с mqtt_ecards_transactions.
 * Авторизация: Api-Key (queue) ИЛИ Bearer JWT; для маршрутов с profileId — дополнительно requireFarmAccess (sync-fibery + cards_access).
 * Аудит через outgoing_notifications (mqtt:sequoia/audit).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../../config/index.js';
import { getDatabaseService, enqueueOutgoingNotification, recordIncident } from '../../infra/index.js';
import { createCorrelationId } from '../../infra/correlation/index.js';
import * as cardsDb from '../../infra/cardsDb.js';
import { setCardOwnership } from '../../infra/cardOwnership.js';
import { requireFarmAccess, mapAccessError } from '../../infra/syncFibery.js';
import { decryptCardCredentials } from '../../infra/encryption/cardCredentials.js';
import type { BankId } from '../../modules/transactions/types.js';
import { getTransactionsAdapter } from '../../modules/transactions/adapters/index.js';
import { insertEcardsBuyerCardIssueQueue } from '../../modules/cards/ecardsBuyerCardIssueQueue.js';
import { logger } from '../../infra/logger.js';
import { getEmailFromAuthHeader } from '../../infra/jwt.js';

function requireCardsAuth(_request: FastifyRequest, _reply: FastifyReply): boolean {
  // В проде маршруты /api/cards/* больше не требуют Api-Key / JWT — авторизация вынесена наружу (gateway).
  return true;
}

async function enqueueAuditLog(params: {
  user_email: string | null | undefined;
  log_type: 'info' | 'log' | 'error' | 'warning';
  severity: number;
  event_type: string;
  event_attributes?: Record<string, unknown>;
}): Promise<void> {
  if (!params.user_email) return;
  try {
    const now = new Date();
    const correlationId = createCorrelationId();
    const payload = {
      id: randomUUID(),
      timestamp: now.toISOString(),
      division: 'finance' as const,
      user_email: params.user_email,
      log_type: params.log_type,
      severity: params.severity,
      event_type: params.event_type,
      event_attributes: params.event_attributes ?? {},
      correlation_id: correlationId,
    };
    const attrs = params.event_attributes ?? {};
    const bank = typeof attrs.bank === 'string' ? attrs.bank : '';
    const cardNumber = typeof attrs.card_number === 'string' ? attrs.card_number : '';
    const timeBucket = now.toISOString().slice(0, 16);
    const dedupKey = `audit:cards:${params.event_type}:${params.user_email}:${bank}:${cardNumber}:${timeBucket}`;
    const config = getConfig();
    const db = getDatabaseService(config);
    await db.withTransaction('main', async (client) => {
      await enqueueOutgoingNotification(client, {
        channel: 'mqtt:sequoia/audit',
        payload,
        dedupKey,
        correlationId,
      });
    });
  } catch (err) {
    logger.error('Cards audit enqueue failed', { event_type: params.event_type, error: err });
  }
}

// --- binUtils (inline) ---
function parseBank(value?: string | null): string | null {
  if (!value) return 'ecards';
  const n = value.trim().toLowerCase();
  if (['ecards', 'adscards', 'multicards', 'stellarcards'].includes(n)) return n;
  return null;
}
function parseBinPrefix(value?: number | string | null): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const t = String(value).trim();
  if (!/^\d+$/.test(t)) return NaN;
  return parseInt(t, 10);
}
function isValidBinForBank(bank: string, binPrefix: number): boolean {
  if (!Number.isFinite(binPrefix) || binPrefix < 1) return false;
  const len = String(binPrefix).length;
  if (bank === 'ecards') return len === 6;
  if (bank === 'adscards') return len <= 6 || (binPrefix >= 1 && binPrefix <= 200);
  if (bank === 'multicards') return len <= 9;
  return len >= 4 && len <= 6;
}

function normalizeCardExpireForV2(value: string | null | undefined): string {
  const src = String(value ?? '').trim();
  if (!src) return '';

  const cleaned = src.replace(/[.\-\s]/g, '/');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length >= 2) {
    const monthRaw = parts[0].replace(/\D+/g, '').slice(0, 2);
    const month = monthRaw.length === 1 ? `0${monthRaw}` : monthRaw;
    let year = parts[1].replace(/\D+/g, '');
    if (year.length >= 4) year = year.slice(-2);
    if (month.length === 2 && year.length === 2) {
      return `${month}/${year}`;
    }
  }

  const digits = src.replace(/\D+/g, '');
  if (digits.length === 3) {
    return `0${digits.slice(0, 1)}/${digits.slice(1, 3)}`;
  }
  if (digits.length >= 4) {
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}`;
  }
  return '';
}

export async function registerCardsRoutes(server: FastifyInstance): Promise<void> {
  // POST /api/cards/create/:bankId — создание карт по BIN и количеству (ecards, adscards, multicards)
  server.post<{
    Params: { bankId: string };
    Body: { bin?: number; quantity?: number; buyer_email?: string };
  }>('/api/cards/create/:bankId', async (request, reply) => {
    if (!requireCardsAuth(request, reply)) return;
    const bankId = parseBank(request.params.bankId);
    if (!bankId) {
      return reply.status(400).send({ success: false, message: 'Invalid bankId' });
    }
    const adapter = getTransactionsAdapter(bankId as BankId);
    if (!adapter?.create) {
      return reply.status(400).send({
        success: false,
        message: `Card creation not supported for bank: ${bankId}. Supported: ecards, adscards, multicards.`,
      });
    }
    const body = (request.body ?? {}) as { bin?: number; quantity?: number; buyer_email?: unknown };
    if (body.buyer_email !== undefined && body.buyer_email !== null && body.buyer_email !== '') {
      if (typeof body.buyer_email !== 'string') {
        return reply.status(400).send({ success: false, message: 'buyer_email must be a string' });
      }
    }
    const buyerEmailRaw =
      typeof body.buyer_email === 'string' ? body.buyer_email.trim() : '';
    const buyerEmail = buyerEmailRaw !== '' ? buyerEmailRaw : null;

    const bin = parseBinPrefix(body.bin);
    if (bin === null || Number.isNaN(bin) || !Number.isFinite(bin) || !isValidBinForBank(bankId, bin)) {
      return reply.status(400).send({
        success: false,
        message: `Invalid or missing bin for ${bankId} (ecards: 6 digits; adscards: 6-digit BIN or bin_id; multicards: bankId).`,
      });
    }
    const quantity = typeof body.quantity === 'number' ? Math.floor(body.quantity) : parseInt(String(body.quantity ?? 0), 10);
    if (quantity < 1) {
      return reply.status(400).send({ success: false, message: 'quantity must be at least 1' });
    }
    const requestedByEmail = getEmailFromAuthHeader((request.headers.authorization as string) ?? null);
    try {
      if (bankId === 'ecards' && buyerEmail != null) {
        const cfg = getConfig();
        const dbQueue = getDatabaseService(cfg);
        const { ids: queueIds, requestBatchId } = await dbQueue.withTransaction('main', async (client) =>
          insertEcardsBuyerCardIssueQueue(client, {
            buyerEmail,
            bin,
            quantity,
            requestedByEmail,
          }),
        );
        logger.info('Cards create: ecards buyer card issue queued', {
          queue_ids: queueIds,
          request_batch_id: requestBatchId,
          buyer_email: buyerEmail,
          bin,
          quantity: queueIds.length,
          requested_by: requestedByEmail,
        });
        return reply.send({
          success: true,
          queued: true,
          queue_ids: queueIds,
          request_batch_id: requestBatchId,
          bank: 'ecards',
          buyer_email: buyerEmail,
          bin,
          quantity: queueIds.length,
          created: 0,
        });
      }

      const result = await adapter.create(bin, quantity, { requestedByEmail, buyerEmail });
      return reply.send({ success: true, created: result.created });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Cards create failed', { bankId, bin, quantity, buyer_email: buyerEmail, error: msg });
      try {
        const config = getConfig();
        const db = getDatabaseService(config);
        await db.withTransaction('main', async (client) => {
          await recordIncident(client, {
            source: 'cards_api',
            kind: 'cards_create_provider_error',
            severity: 'error',
            summary: `Cards create failed (${bankId}): ${msg}`.slice(0, 1000),
            detail: {
              bank: bankId,
              bin,
              quantity,
              requested_by: requestedByEmail,
              buyer_email: buyerEmail,
              error_message: msg,
            },
          });
        });
      } catch (recordErr) {
        logger.error('cards API: recordIncident failed after create error', recordErr as Error);
      }
      return reply.status(500).send({ success: false, message: msg });
    }
  });

  // POST /api/cards/get-by-bin
  server.post<{
    Body: { profileId?: string; profileName?: string | null; bin?: number | string | null; bank?: string | null };
  }>('/api/cards/get-by-bin', async (request, reply) => {
    if (!requireCardsAuth(request, reply)) return;
    const body = request.body ?? {};
    if (!body.profileId || typeof body.profileId !== 'string') {
      return reply.status(400).send({ success: false, message: 'Не передан profileId.' });
    }
    const profileId = body.profileId.trim();
    const profileName = (body.profileName ?? '').trim() || profileId;
    const bank = parseBank(body.bank);
    if (!bank) {
      return reply.status(400).send({
        success: false,
        message: 'Некорректное значение bank. Допустимо: ecards, adscards, multicards, stellarcards.',
      });
    }
    const binPrefix = parseBinPrefix(body.bin);
    if (binPrefix !== null && !isNaN(binPrefix) && !isValidBinForBank(bank, binPrefix)) {
      return reply.status(400).send({
        success: false,
        message: `Некорректный BIN для банка ${bank}. Проверьте BIN/префикс в выборе.`,
      });
    }
    let access: { email: string | null; jobTitle: string };
    try {
      access = await requireFarmAccess({ profileId, profileName });
    } catch (err) {
      const mapped = mapAccessError(err);
      return reply.status(mapped.status).send({ success: false, message: mapped.message });
    }
    const config = getConfig();
    const db = getDatabaseService(config);
    type ReservedCard = { creds: string | null; card_number: number; bank: string };
    let card: ReservedCard | null = null;
    try {
      card = await db.withTransaction('main', async (client): Promise<ReservedCard> => {
        const existing = await cardsDb.getCardByProfileName(client, profileName);
        if (existing) {
          throw Object.assign(new Error('У профиля уже есть привязанная карта. Дождитесь загрузки или отвяжите текущую карту.'), { statusCode: 409 });
        }
        const r = await cardsDb.reserveFreeCardByBin(client, { bank, binPrefix, profileName, body });
        if (!r) {
          throw Object.assign(new Error('Нет свободных карт для выбранного BIN. Попробуйте другой BIN или повторите позже.'), { statusCode: 404 });
        }
        await setCardOwnership(client, {
          cardNumber: r.card_number,
          bank: r.bank,
          buyer: access.email ?? null,
          profileName,
          is_buying: false,
        });
        return r;
      });
    } catch (err: unknown) {
      const statusCode = err && typeof err === 'object' && 'statusCode' in err ? (err as { statusCode: number }).statusCode : 500;
      const message = err instanceof Error ? err.message : 'Внутренняя ошибка при резервировании карты.';
      return reply.status(statusCode).send({ success: false, message });
    }
    if (!card) {
      return reply.status(404).send({
        success: false,
        message: 'Нет свободных карт для выбранного BIN. Попробуйте другой BIN или повторите позже.',
      });
    }
    const client = await db.getClient('main');
    try {
      let decrypted: { cardNumber: string; cardCvv: string; cardExpire: string };
      if (card.creds) {
        try {
          decrypted = decryptCardCredentials(card.creds);
        } catch {
          return reply.status(404).send({
            success: false,
            message: 'Реквизиты карты недоступны (не удалось расшифровать creds). Попробуйте взять другую карту.',
          });
        }
      } else {
        decrypted = {
          cardNumber: String(card.card_number),
          cardCvv: '',
          cardExpire: '',
        };
      }
      const binForInfo = cardsDb.extractBin(card.card_number, card.bank);
      const cardInfo = await cardsDb.getCardInfo(client, card.bank, binForInfo);
      await enqueueAuditLog({
        user_email: access.email,
        log_type: 'info',
        severity: 1,
        event_type: 'bank_card_linked_to_profile',
        event_attributes: {
          card_number: String(card.card_number),
          profileName,
        },
      });
      try {
        await cardsDb.recordCardShown(client, {
          cardNumber: parseInt(decrypted.cardNumber, 10),
          email: access.email,
          profileName,
        });
      } catch (e) {
        logger.error('Failed to record card shown', { error: e, cardNumber: card.card_number });
      }
      return reply.send({
        success: true,
        message: 'Card linked to profile successfully',
        card: {
          cardNumber: decrypted.cardNumber,
          cardCvv: decrypted.cardCvv,
          cardExpire: decrypted.cardExpire,
          bank: card.bank,
          geo: cardInfo.geo ?? 'unknown',
          info: cardInfo.info ?? 'unknown',
        },
      });
    } finally {
      client.release();
    }
  });

  // POST /api/cards/v2/get-by-bin
  server.post<{
    Body: { profileId?: string; profileName?: string | null; bin?: number | string | null; bank?: string | null };
  }>('/api/cards/v2/get-by-bin', async (request, reply) => {
    if (!requireCardsAuth(request, reply)) return;
    const body = request.body ?? {};
    if (!body.profileId || typeof body.profileId !== 'string') {
      return reply.status(400).send({ success: false, message: 'Не передан profileId.' });
    }
    const profileId = body.profileId.trim();
    const profileName = (body.profileName ?? '').trim() || profileId;
    const bank = parseBank(body.bank);
    if (!bank) {
      return reply.status(400).send({
        success: false,
        message: 'Некорректное значение bank. Допустимо: ecards, adscards, multicards, stellarcards.',
      });
    }
    const binPrefix = parseBinPrefix(body.bin);
    if (binPrefix !== null && !isNaN(binPrefix) && !isValidBinForBank(bank, binPrefix)) {
      return reply.status(400).send({
        success: false,
        message: `Некорректный BIN для банка ${bank}. Проверьте BIN/префикс в выборе.`,
      });
    }
    let access: { email: string | null; jobTitle: string };
    try {
      access = await requireFarmAccess({ profileId, profileName });
    } catch (err) {
      const mapped = mapAccessError(err);
      return reply.status(mapped.status).send({ success: false, message: mapped.message });
    }
    const config = getConfig();
    const db = getDatabaseService(config);
    type ReservedCard = { creds: string | null; card_number: number; bank: string };
    let card: ReservedCard | null = null;
    try {
      card = await db.withTransaction('main', async (client): Promise<ReservedCard> => {
        const existing = await cardsDb.getCardByProfileName(client, profileName);
        if (existing) {
          throw Object.assign(new Error('У профиля уже есть привязанная карта. Дождитесь загрузки или отвяжите текущую карту.'), { statusCode: 409 });
        }
        const r = await cardsDb.reserveFreeCardByBin(client, { bank, binPrefix, profileName, body });
        if (!r) {
          throw Object.assign(new Error('Нет свободных карт для выбранного BIN. Попробуйте другой BIN или повторите позже.'), { statusCode: 404 });
        }
        await setCardOwnership(client, {
          cardNumber: r.card_number,
          bank: r.bank,
          buyer: access.email ?? null,
          profileName,
          is_buying: false,
        });
        return r;
      });
    } catch (err: unknown) {
      const statusCode = err && typeof err === 'object' && 'statusCode' in err ? (err as { statusCode: number }).statusCode : 500;
      const message = err instanceof Error ? err.message : 'Внутренняя ошибка при резервировании карты.';
      return reply.status(statusCode).send({ success: false, message });
    }
    if (!card) {
      return reply.status(404).send({
        success: false,
        message: 'Нет свободных карт для выбранного BIN. Попробуйте другой BIN или повторите позже.',
      });
    }
    const client = await db.getClient('main');
    try {
      let decrypted: { cardNumber: string; cardCvv: string; cardExpire: string };
      if (card.creds) {
        try {
          decrypted = decryptCardCredentials(card.creds);
        } catch {
          try {
            await db.withTransaction('main', async (releaseClient) => {
              await cardsDb.unlinkCardFromProfile(releaseClient, card.card_number, profileName);
            });
          } catch (releaseError) {
            logger.error('Failed to release card after decrypt error', {
              error: releaseError,
              cardNumber: card.card_number,
              profileName,
            });
          }
          return reply.status(404).send({
            success: false,
            message: 'Реквизиты карты недоступны (не удалось расшифровать creds). Попробуйте взять другую карту.',
          });
        }
      } else {
        decrypted = {
          cardNumber: String(card.card_number),
          cardCvv: '',
          cardExpire: '',
        };
      }
      const binForInfo = cardsDb.extractBin(card.card_number, card.bank);
      const cardInfo = await cardsDb.getCardInfo(client, card.bank, binForInfo);
      await enqueueAuditLog({
        user_email: access.email,
        log_type: 'info',
        severity: 1,
        event_type: 'bank_card_linked_to_profile',
        event_attributes: {
          card_number: String(card.card_number),
          profileName,
        },
      });
      try {
        await cardsDb.recordCardShown(client, {
          cardNumber: parseInt(decrypted.cardNumber, 10),
          email: access.email,
          profileName,
        });
      } catch (e) {
        logger.error('Failed to record card shown', { error: e, cardNumber: card.card_number });
      }
      const payload = {
        cardNumber: decrypted.cardNumber,
        cardCvv: decrypted.cardCvv,
        cardExpire: normalizeCardExpireForV2(decrypted.cardExpire),
        bank: card.bank,
        geo: cardInfo.geo ?? 'unknown',
        info: cardInfo.info ?? 'unknown',
      };
      const cardBase64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
      return reply.send({
        success: true,
        message: 'Card linked to profile successfully',
        card_base64: cardBase64,
      });
    } finally {
      client.release();
    }
  });

  // GET /api/cards/get-bins?profile_id=...&profile_name=...
  server.get<{
    Querystring: { profile_id?: string; profile_name?: string };
  }>('/api/cards/get-bins', async (request, reply) => {
    if (!requireCardsAuth(request, reply)) return;
    const { profile_id, profile_name } = request.query;
    if (profile_id) {
      try {
        await requireFarmAccess({ profileId: profile_id, profileName: profile_name });
      } catch (err) {
        const mapped = mapAccessError(err);
        return reply.status(mapped.status).send({ success: false, message: mapped.message });
      }
    }
    try {
      let rows: Array<{ bank: string; bin: string; geo: string | null; info: string | null; free_count: number }>;
      try {
        rows = await cardsDb.getAllCardsInfoWithFreeCounts();
      } catch (e) {
        logger.warn('getAllCardsInfoWithFreeCounts failed (cards_info may be missing)', e);
        rows = [];
      }
      const bins = rows.map((r) => ({
        bank: r.bank,
        bin: r.bin,
        bin_id: 0,
        name: r.geo || r.info || '',
        currency: 'usd',
        label: `${r.bank} БИН ${r.bin} - ${r.free_count} свободных карт`,
        value: `${r.bank}:${r.bin}`,
        available_cards: r.free_count,
        available_to_issue: null,
        allowed_to_issue: true,
      }));
      return reply.send({ success: true, total: bins.length, bins });
    } catch (err) {
      logger.error('GET /api/cards/get-bins', err);
      return reply.status(500).send({ success: false, error: (err as Error).message });
    }
  });

  // GET /api/cards/check?profile_name=...&profile_id=...
  server.get<{
    Querystring: { profile_name?: string; profile_id?: string };
  }>('/api/cards/check', async (request, reply) => {
    if (!requireCardsAuth(request, reply)) {
      logger.error('[CARDS_HUB] Unauthorized', { profile_name: request.query.profile_name, profile_id: request.query.profile_id });
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const { profile_name, profile_id } = request.query;
    if (!profile_name) {
      logger.error('[CARDS_HUB] profile_name is required', { profile_name: request.query.profile_name, profile_id: request.query.profile_id });
      return reply.status(400).send({ success: false, message: 'profile_name is required' });
    }
    if (!profile_id) {
      logger.error('[CARDS_HUB] profile_id is required', { profile_name: request.query.profile_name, profile_id: request.query.profile_id });
      return reply.status(400).send({ success: false, message: 'profile_id is required' });
    }
    try {
      await requireFarmAccess({ profileId: profile_id, profileName: profile_name });
    } catch (err) {
      //- logger.error('[CARDS_HUB] requireFarmAccess failed', { error: err, profile_name: request.query.profile_name, profile_id: request.query.profile_id });
      const mapped = mapAccessError(err);
      return reply.status(mapped.status).send({ success: false, message: mapped.message });
    }
    const config = getConfig();
    const client = await getDatabaseService(config).getClient('main');
    try {
      const card = await cardsDb.getCardByProfileName(client, profile_name);
      if (!card) {
        logger.warn('[CARDS_HUB] No card found', { profile_name: request.query.profile_name, profile_id: request.query.profile_id });
        return reply.send({ success: true, hasCard: false });
      }
      const bin = cardsDb.extractBin(card.card_number, card.bank);
      const cardInfo = await cardsDb.getCardInfo(client, card.bank, bin);
      if (!card.creds) {
        logger.warn('[CARDS_HUB] Card found but credentials are not available', { profile_name: request.query.profile_name, profile_id: request.query.profile_id });
        return reply.send({
          success: true,
          hasCard: true,
          card: {
            cardNumber: String(card.card_number),
            cardCvv: '',
            cardExpire: '',
            bank: card.bank,
            geo: cardInfo.geo,
            info: cardInfo.info,
          },
        });
      }
      let decrypted;
      try {
        decrypted = decryptCardCredentials(card.creds);
      } catch {
        logger.error('[CARDS_HUB] decryptCardCredentials failed', { profile_name: request.query.profile_name, profile_id: request.query.profile_id });
        return reply.send({
          success: true,
          hasCard: true,
          card: {
            cardNumber: String(card.card_number),
            cardCvv: '',
            cardExpire: '',
            bank: card.bank,
            geo: cardInfo.geo,
            info: cardInfo.info,
          },
        });
      }
      logger.warn('[CARDS_HUB] Card found', { profile_name: request.query.profile_name, profile_id: request.query.profile_id, card_number: card.card_number, bank: card.bank });
      return reply.send({
        success: true,
        hasCard: true,
        card: {
          cardNumber: decrypted.cardNumber,
          cardCvv: decrypted.cardCvv,
          cardExpire: decrypted.cardExpire,
          bank: card.bank,
          geo: cardInfo.geo,
          info: cardInfo.info,
        },
      });
    } finally {
      client.release();
    }
  });

  // GET /api/cards/v2/check?profile_name=...&profile_id=...
  server.get<{
    Querystring: { profile_name?: string; profile_id?: string };
  }>('/api/cards/v2/check', async (request, reply) => {
    if (!requireCardsAuth(request, reply)) {
      logger.error('[CARDS_HUB] Unauthorized', { profile_name: request.query.profile_name, profile_id: request.query.profile_id });
      return reply.status(401).send({ success: false, message: 'Unauthorized' });
    }
    const { profile_name, profile_id } = request.query;
    if (!profile_name) {
      logger.error('[CARDS_HUB] profile_name is required', { profile_name: request.query.profile_name, profile_id: request.query.profile_id });
      return reply.status(400).send({ success: false, message: 'profile_name is required' });
    }
    if (!profile_id) {
      logger.error('[CARDS_HUB] profile_id is required', { profile_name: request.query.profile_name, profile_id: request.query.profile_id });
      return reply.status(400).send({ success: false, message: 'profile_id is required' });
    }
    try {
      await requireFarmAccess({ profileId: profile_id, profileName: profile_name });
    } catch (err) {
      const mapped = mapAccessError(err);
      return reply.status(mapped.status).send({ success: false, message: mapped.message });
    }
    const config = getConfig();
    const client = await getDatabaseService(config).getClient('main');
    try {
      const card = await cardsDb.getCardByProfileName(client, profile_name);
      if (!card) {
        logger.warn('[CARDS_HUB] No card found', { profile_name: request.query.profile_name, profile_id: request.query.profile_id });
        return reply.send({ success: true, hasCard: false });
      }
      const bin = cardsDb.extractBin(card.card_number, card.bank);
      const cardInfo = await cardsDb.getCardInfo(client, card.bank, bin);
      let decrypted: { cardNumber: string; cardCvv: string; cardExpire: string };
      if (!card.creds) {
        logger.warn('[CARDS_HUB] Card found but credentials are not available', { profile_name: request.query.profile_name, profile_id: request.query.profile_id });
        decrypted = {
          cardNumber: String(card.card_number),
          cardCvv: '',
          cardExpire: '',
        };
      } else {
        try {
          decrypted = decryptCardCredentials(card.creds);
        } catch {
          logger.error('[CARDS_HUB] decryptCardCredentials failed', { profile_name: request.query.profile_name, profile_id: request.query.profile_id });
          decrypted = {
            cardNumber: String(card.card_number),
            cardCvv: '',
            cardExpire: '',
          };
        }
      }
      logger.warn('[CARDS_HUB] Card found', { profile_name: request.query.profile_name, profile_id: request.query.profile_id, card_number: card.card_number, bank: card.bank });
      const payload = {
        cardNumber: decrypted.cardNumber,
        cardCvv: decrypted.cardCvv,
        cardExpire: normalizeCardExpireForV2(decrypted.cardExpire),
        bank: card.bank,
        geo: cardInfo.geo,
        info: cardInfo.info,
      };
      const cardBase64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
      return reply.send({
        success: true,
        hasCard: true,
        card_base64: cardBase64,
      });
    } finally {
      client.release();
    }
  });

  // GET /api/cards/free-count?profile_id=...&bank=...&bin=...
  server.get<{
    Querystring: { profile_id?: string; bank?: string; bin?: string };
  }>('/api/cards/free-count', async (request, reply) => {
    if (!requireCardsAuth(request, reply)) return;
    const { profile_id, bank: bankRaw, bin: binRaw } = request.query;
    const bank = parseBank(bankRaw);
    if (!bank) {
      return reply.status(400).send({ success: false, message: 'Invalid bank value' });
    }
    const binPrefix = parseBinPrefix(binRaw);
    if (binPrefix !== null && !isNaN(binPrefix) && !isValidBinForBank(bank, binPrefix)) {
      return reply.status(400).send({ success: false, message: 'Invalid bin value' });
    }
    if (profile_id) {
      try {
        await requireFarmAccess({ profileId: profile_id });
      } catch (err) {
        const mapped = mapAccessError(err);
        return reply.status(mapped.status).send({ success: false, message: mapped.message });
      }
    }
    const config = getConfig();
    const client = await getDatabaseService(config).getClient('main');
    try {
      const freeCount = await cardsDb.countFreeCardsByBin(client, { bank, binPrefix });
      return reply.send({ success: true, bank, bin: binPrefix, freeCount });
    } finally {
      client.release();
    }
  });

  // POST /api/cards/unlink
  server.post<{
    Body: { cardNumber?: number; profileId?: string; profileName?: string | null };
  }>('/api/cards/unlink', async (request, reply) => {
    if (!requireCardsAuth(request, reply)) return;
    const body = request.body ?? {};
    if (typeof body.cardNumber !== 'number' || !Number.isFinite(body.cardNumber)) {
      return reply.status(400).send({ success: false, message: 'cardNumber is required' });
    }
    if (!body.profileId || typeof body.profileId !== 'string') {
      return reply.status(400).send({ success: false, message: 'profileId is required' });
    }
    let access: { email: string | null; jobTitle: string };
    try {
      access = await requireFarmAccess({ profileId: body.profileId, profileName: body.profileName ?? undefined });
    } catch (err) {
      const mapped = mapAccessError(err);
      return reply.status(mapped.status).send({ success: false, message: mapped.message });
    }
    const config = getConfig();
    const client = await getDatabaseService(config).getClient('main');
    let cardData: { profile_name: string | null; bank: string | null; buyer: string | null };
    let unlinked: boolean;
    try {
      cardData = await cardsDb.getCardDataBeforeUnlink(client, body.cardNumber);
      if (!cardData.profile_name || cardData.profile_name.trim() === '') {
        return reply.status(400).send({ success: false, message: 'Card is not linked to any profile' });
      }
      unlinked = await cardsDb.unlinkCardFromProfile(
        client,
        body.cardNumber,
        body.profileName ?? undefined,
      );
    } finally {
      client.release();
    }
    if (!unlinked) {
      return reply.status(400).send({ success: false, message: 'Card not found or unlink conditions not met' });
    }
    const auditAttrs: Record<string, string> = {
      profile_name: cardData.profile_name,
      card_number: String(body.cardNumber),
      bank: cardData.bank ?? '',
      source: 'farm_extension_unlink',
    };
    if (cardData.buyer) auditAttrs.buyer = cardData.buyer;
    await enqueueAuditLog({
      user_email: access.email,
      log_type: 'info',
      severity: 1,
      event_type: 'card_unlinked',
      event_attributes: auditAttrs,
    });
    return reply.send({ success: true, message: 'Card unlinked from profile successfully' });
  });
}
