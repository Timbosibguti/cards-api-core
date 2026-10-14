import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { getConfig } from '../../config/index.js';
import { createCorrelationId, getDatabaseService, enqueueOutgoingNotification } from '../../infra/index.js';
import { upsertSmsDevice, findSmsDeviceByRecipient } from '../../infra/smsDevicesDb.js';
import { logger } from '../../infra/logger.js';

interface SmsPhonePayload {
  imei: string;
  info: Record<string, unknown>;
  phones: string[];
  battery: number;
  charging: boolean;
  tg_chat?: number;
}

interface SmsPayload {
  imei?: string;
  type: string;
  sender: string;
  content: string;
  recipient: string;
  timestamp: number;
  received_at: number;
}

export async function registerMobileSmsWebhooks(server: FastifyInstance): Promise<void> {
  server.post<{ Body: unknown }>('/webhooks/mobile/sms', async (request, reply) => {
    const body = request.body;

    logger.info('Mobile SMS webhook received', { body });

    if (!body || typeof body !== 'object') {
      await reply.code(400).send({ error: 'Invalid JSON body' });
      return;
    }

    if ((body as SmsPhonePayload).imei === '347a1e184bfe1d47') {
      logger.info('[AFF_SMS] Received SMS from 347a1e184bfe1d47', { body });
    }

    // Попытка трактовать как SmsPhone (heartbeat)
    const maybePhone = body as Partial<SmsPhonePayload>;
    if (
      typeof maybePhone.imei === 'string' &&
      Array.isArray(maybePhone.phones) &&
      typeof maybePhone.battery === 'number' &&
      typeof maybePhone.charging === 'boolean' //&&
      //maybePhone.info && typeof maybePhone.info === 'object'
    ) {
      const config = getConfig();
      const db = getDatabaseService(config);

      await db.withTransaction('main', async (client) => {
        await upsertSmsDevice(client, {
          imei: maybePhone.imei!,
          phones: maybePhone.phones!,
          battery: maybePhone.battery!,
          charging: maybePhone.charging!,
          info: maybePhone.info as Record<string, unknown> || {},
          tg_chat: maybePhone.tg_chat != null ? String(maybePhone.tg_chat) : null,
        });
      });

      if ((body as SmsPhonePayload).imei === '347a1e184bfe1d47') {
        logger.info('[AFF_SMS] Mobile SmsPhone heartbeat processed', { body });
      }

      logger.info('Mobile SmsPhone heartbeat processed', { imei: maybePhone.imei });
      await reply.code(200).send({ status: 'ok', kind: 'heartbeat' });
      return;
    }

    // Попытка трактовать как Sms (sms_received)
    const maybeSms = body as Partial<SmsPayload>;
    if (maybeSms.type === 'sms_received') {
      if ((body as SmsPayload).imei === '347a1e184bfe1d47') {
        logger.info('[AFF_SMS] Mobile Sms received processed', { body });
      }

      const config = getConfig();
      const db = getDatabaseService(config);

      let imei = maybeSms.imei;
      const recipient = maybeSms.recipient;

      if (!recipient || !maybeSms.content || !maybeSms.sender) {
        if ((body as SmsPhonePayload).imei === '347a1e184bfe1d47') {
          logger.info('[AFF_SMS] Invalid sms payload', { body });
        }

        await reply.code(400).send({ error: 'Invalid sms payload' });
        return;
      }

      if (!imei || imei.trim() === '') {
        const client = await db.getClient('main');
        try {
          const dev = await findSmsDeviceByRecipient(client, recipient);
          if (dev) {
            imei = dev.imei;
            logger.info('Resolved imei for mobile SMS by recipient', { imei, recipient });
          } else {
            logger.info('No sms_device found for recipient, skipping imei attach', { recipient });
          }
        } finally {
          client.release();
        }
      }

      const rawForPayload = JSON.stringify({
        content: maybeSms.content,
        recipient,
        sender: maybeSms.sender,
        imei: imei ?? null,
        timestamp: maybeSms.timestamp ?? null,
        received_at: maybeSms.received_at ?? null,
      });

      const now = new Date();
      const timeBucket = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
      const hash = createHash('sha256').update(rawForPayload).digest('hex').slice(0, 16);
      const idempotencyKey = `otp:sms:${recipient}:${timeBucket}:${hash}`;
      const correlationId = createCorrelationId();

      const otpPayload = {
        source: 'sms' as const,
        raw: rawForPayload,
        idempotency_key: idempotencyKey,
        correlation_id: correlationId,
      };

      await db.withTransaction('main', async (client) => {
        await enqueueOutgoingNotification(client, {
          channel: 'mqtt:sequoia/otp',
          payload: otpPayload,
          dedupKey: idempotencyKey,
          correlationId,
        });
      });

      logger.info('Mobile SMS enqueued to sequoia/otp', {
        dedup_key: idempotencyKey,
        correlation_id: correlationId,
      });

      if ((body as SmsPhonePayload).imei === '347a1e184bfe1d47') {
        logger.info('[AFF_SMS] Mobile SMS enqueued to sequoia/otp', { body });
      }
  
      await reply.code(200).send({ status: 'ok', kind: 'sms_received' });
      return;
    }

    if ((body as SmsPhonePayload).imei === '347a1e184bfe1d47') {
      logger.info('[AFF_SMS] Unsupported payload format', { body });
    }

    await reply.code(400).send({ error: 'Unsupported payload format' });
  });
}

