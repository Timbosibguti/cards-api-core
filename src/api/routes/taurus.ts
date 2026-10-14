/**
 * HTTP-эндпоинты для Taurus (spec §12: POST /taurus/heartbeat?dev=true → dev_inbox_events).
 * Без dev=true — production flow (upsert в ota_devices).
 * Список карт баера: GET /taurus/buyer-cards; креды карты (base64 JSON): POST /taurus/card-credentials (api-key как у queue).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getConfig } from '../../config/index.js';
import { getDatabaseService } from '../../infra/index.js';
import { decryptCardCredentials } from '../../infra/encryption/cardCredentials.js';
import * as cardsDb from '../../infra/cardsDb.js';
import * as farmDb from '../../infra/farmDb.js';
import { logger } from '../../infra/logger.js';
import { upsertDevice } from '../../infra/hardwareDb.js';
import { ingestToDevInbox, isDevRequest } from '../../infra/devInboxIngest.js';

function requireTaurusIntegrationAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  apiKey: string,
): boolean {
  const key = (request.headers['api-key'] as string) ?? '';
  if (key !== apiKey) {
    void reply.status(401).send({ success: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

type HeartbeatBody = Record<string, unknown>;

type CardCredentialsBody = { profile_name?: string; card_number?: string | number };

function normalizeCardNumberInput(value: string | number | undefined): string {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\D/g, '');
}

/** UTF-8 JSON с полями как у farm-extension после расшифровки creds + bank, затем base64. */
function encodeCredentialsPayload(payload: Record<string, string>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export async function registerTaurusRoutes(server: FastifyInstance): Promise<void> {
  const config = getConfig();

  server.post<{ Body: CardCredentialsBody }>('/taurus/card-credentials', async (request, reply) => {
    if (!requireTaurusIntegrationAuth(request, reply, config.queueApi.apiKey)) return;

    const profileName = typeof request.body?.profile_name === 'string' ? request.body.profile_name.trim() : '';
    const cardDigits = normalizeCardNumberInput(request.body?.card_number);
    if (!profileName) {
      return reply.status(400).send({ success: false, error: 'profile_name is required' });
    }
    if (!cardDigits) {
      return reply.status(400).send({ success: false, error: 'card_number is required' });
    }

    try {
      const resolved = await getDatabaseService(config).withTransaction('farm', (farmClient) =>
        farmDb.resolveBuyerEmailByProfileName(farmClient, profileName),
      );
      if (!resolved.profileExists || !resolved.buyerEmail) {
        return reply.status(404).send({ success: false, error: 'Not found' });
      }
      const buyerEmail = resolved.buyerEmail;
      const row = await getDatabaseService(config).withTransaction('main', (client) =>
        cardsDb.getBankCardForBuyerByCardNumber(client, buyerEmail, cardDigits),
      );
      if (!row) {
        return reply.status(404).send({ success: false, error: 'Not found' });
      }

      let decrypted: { cardNumber: string; cardCvv: string; cardExpire: string };
      if (row.creds) {
        try {
          decrypted = decryptCardCredentials(row.creds);
        } catch (e) {
          logger.error('POST /taurus/card-credentials decrypt failed', {
            profile_name: profileName,
            card_prefix: cardDigits.slice(0, 6),
            error: e instanceof Error ? e.message : String(e),
          });
          return reply.status(502).send({ success: false, error: 'Credentials unavailable' });
        }
      } else {
        decrypted = {
          cardNumber: String(row.card_number),
          cardCvv: '',
          cardExpire: '',
        };
      }

      const credentials_base64 = encodeCredentialsPayload({
        cardNumber: decrypted.cardNumber,
        cardCvv: decrypted.cardCvv,
        cardExpire: decrypted.cardExpire,
        bank: row.bank,
      });

      try {
        const db = getDatabaseService(config);
        const client = await db.getClient('main');
        try {
          await cardsDb.recordCardShown(client, {
            cardNumber: parseInt(decrypted.cardNumber.replace(/\D/g, ''), 10) || parseInt(cardDigits, 10),
            email: buyerEmail,
            profileName,
          });
        } finally {
          client.release();
        }
      } catch (shownErr) {
        logger.warn('POST /taurus/card-credentials recordCardShown failed', {
          error: shownErr instanceof Error ? shownErr.message : String(shownErr),
        });
      }

      return reply.send({
        success: true,
        profile_name: profileName,
        bank: row.bank,
        credentials_base64,
      });
    } catch (err) {
      logger.error('POST /taurus/card-credentials', { profile_name: profileName, error: err });
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  server.get<{ Querystring: { profile_name?: string } }>('/taurus/buyer-cards', async (request, reply) => {
    if (!requireTaurusIntegrationAuth(request, reply, config.queueApi.apiKey)) return;

    const profileName = request.query.profile_name?.trim() ?? '';
    if (!profileName) {
      return reply.status(400).send({ success: false, error: 'profile_name is required' });
    }

    try {
      const resolved = await getDatabaseService(config).withTransaction('farm', (farmClient) =>
        farmDb.resolveBuyerEmailByProfileName(farmClient, profileName),
      );
      if (!resolved.profileExists) {
        return reply.status(404).send({ success: false, error: 'Profile not found' });
      }
      const buyerEmail = resolved.buyerEmail;
      if (!buyerEmail) {
        return reply.send({
          success: true,
          profile_name: profileName,
          buyer_email: null,
          cards: [],
        });
      }
      const cards = await getDatabaseService(config).withTransaction('main', (client) =>
        cardsDb.listBankCardsByBuyerEmail(client, buyerEmail),
      );
      return reply.send({
        success: true,
        profile_name: profileName,
        buyer_email: buyerEmail,
        cards,
      });
    } catch (err) {
      logger.error('GET /taurus/buyer-cards', { profile_name: profileName, error: err });
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  server.post<{ Querystring: { dev?: string }; Body: HeartbeatBody }>(
    '/taurus/heartbeat',
    async (request, reply) => {
      const body = request.body ?? {};
      if (isDevRequest(request.query as Record<string, unknown>, body)) {
        const result = await ingestToDevInbox('taurus', 'taurus_heartbeat', body, {
          correlation_id: (request.headers['x-correlation-id'] as string) ?? undefined,
        });
        if (result) {
          return reply.code(202).send({ status: 'accepted', id: result.id, dev_inbox: true });
        }
        return reply.code(400).send({ error: 'Dev simulation is disabled' });
      }

      const imei = typeof body.imei === 'string' ? body.imei : '';
      const phone = typeof body.phone === 'string' ? body.phone : (typeof body.phone === 'number' ? String(body.phone) : '');
      const version = typeof body.version === 'string' ? body.version : '0';
      const uptime = typeof body.uptime === 'number' ? body.uptime : 0;
      const statsObj = body.stats && typeof body.stats === 'object' ? (body.stats as Record<string, unknown>) : {};
      const stats = { sms: typeof statsObj.sms === 'number' ? statsObj.sms : 0, call: typeof statsObj.call === 'number' ? statsObj.call : 0 };

      if (!imei || !version) {
        return reply.code(400).send({ error: 'imei and version required' });
      }

      const config = getConfig();
      const db = getDatabaseService(config);
      await db.withTransaction('main', (client) =>
        upsertDevice(client, {
          imei,
          phone,
          version,
          uptime,
          stats,
          config: body.config as { answer?: number; play?: number; hang?: number; play_answer?: number } | undefined,
          board: typeof body.board === 'string' ? body.board : undefined,
          creg: typeof body.creg === 'string' ? body.creg : undefined,
          csq: typeof body.csq === 'string' ? body.csq : undefined,
        }),
      );
      return reply.code(200).send({ status: 'ok' });
    },
  );
}
