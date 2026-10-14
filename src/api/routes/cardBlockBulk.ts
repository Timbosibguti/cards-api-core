import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { getConfig } from '../../config/index.js';
import { getCardByProfileName } from '../../infra/cardsDb.js';
import { createCorrelationId, enqueueOutgoingNotification, getDatabaseService } from '../../infra/index.js';
import { getEmailFromAuthHeader } from '../../infra/jwt.js';
import { logger } from '../../infra/logger.js';

type BulkBody = { card_numbers?: unknown };

function trimInput(item: unknown): string | null {
  if (item === null || item === undefined) return null;
  const s = String(item).trim();
  return s.length > 0 ? s : null;
}

async function lookupCardNumber(client: PoolClient, digits: string): Promise<string | null> {
  const res = await client.query<{ card_number: string }>(
    `SELECT card_number::text AS card_number
     FROM public.bank_cards
     WHERE card_number = $1::bigint
     LIMIT 1`,
    [digits],
  );
  return res.rows[0]?.card_number ?? null;
}

async function resolveToCardDigits(
  client: PoolClient,
  raw: string,
): Promise<{ ok: true; cardDigits: string } | { ok: false; reason: string }> {
  const isAllDigits = /^\d+$/.test(raw);

  if (isAllDigits) {
    const byNum = await lookupCardNumber(client, raw);
    if (byNum) return { ok: true, cardDigits: byNum };
    const byProfileDigits = await getCardByProfileName(client, raw);
    if (byProfileDigits) return { ok: true, cardDigits: String(byProfileDigits.card_number) };
    return { ok: false, reason: 'card_or_profile_not_found' };
  }

  const digitsOnly = raw.replace(/\D/g, '');
  if (digitsOnly.length >= 12 && digitsOnly.length <= 19) {
    const byNum = await lookupCardNumber(client, digitsOnly);
    if (byNum) return { ok: true, cardDigits: byNum };
  }

  const byProfile = await getCardByProfileName(client, raw);
  if (byProfile) return { ok: true, cardDigits: String(byProfile.card_number) };
  return { ok: false, reason: 'card_or_profile_not_found' };
}

export async function registerCardBlockBulkRoutes(server: FastifyInstance): Promise<void> {
  const config = getConfig();

  server.post<{ Body: BulkBody }>('/api/card-block/block-batch', async (request: FastifyRequest<{ Body: BulkBody }>, reply: FastifyReply) => {
    const apiKey = (request.headers['api-key'] as string) ?? '';
    if (apiKey !== config.queueApi.apiKey) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' });
    }

    const email = getEmailFromAuthHeader((request.headers.authorization as string) ?? null);
    if (!email) {
      return reply.status(401).send({
        success: false,
        error: 'Unauthorized',
        message: 'Bearer JWT with email claim is required',
      });
    }

    const raw = request.body?.card_numbers;
    if (!Array.isArray(raw) || raw.length === 0) {
      return reply.status(400).send({ success: false, error: 'card_numbers must be a non-empty array' });
    }

    const db = getDatabaseService(config);
    try {
      const result = await db.withTransaction('main', async (client) => {
        const resolved: string[] = [];
        const unresolved: { input: unknown; reason: string }[] = [];

        for (const item of raw) {
          const trimmed = trimInput(item);
          if (!trimmed) {
            unresolved.push({ input: item, reason: 'empty' });
            continue;
          }
          const r = await resolveToCardDigits(client, trimmed);
          if (r.ok) {
            resolved.push(r.cardDigits);
          } else {
            unresolved.push({ input: item, reason: r.reason });
          }
        }

        if (unresolved.length > 0) {
          const farmOtpLines = [
            'Блокировка пачки карт: часть записей не найдена в БД.',
            `Кто: ${email}`,
            'Переданные номера карт / имена аккаунтов:',
            ...raw.map((x) => `- ${String(x)}`),
            '',
            'Не найдены:',
            ...unresolved.map((u) => `- ${String(u.input)} (${u.reason})`),
          ];
          const correlationId = createCorrelationId();
          await enqueueOutgoingNotification(client, {
            channel: 'slack:#farm-otp',
            payload: { message: farmOtpLines.join('\n') },
            dedupKey: `slack:card_block_batch_unresolved:${randomUUID()}`,
            correlationId,
          });
          return { ok: false as const, unresolved };
        }

        const unique = [...new Set(resolved)];
        for (const cardDigits of unique) {
          const pr = await client.query<{ profile_name: string | null }>(
            `SELECT profile_name::text FROM public.bank_cards WHERE card_number = $1::bigint LIMIT 1`,
            [cardDigits],
          );
          const profileName = pr.rows[0]?.profile_name ?? null;
          await client.query(
            `INSERT INTO public.card_block_queue (card_number, email, profile_name) VALUES ($1::bigint, $2, $3)`,
            [cardDigits, email, profileName],
          );
        }

        return { ok: true as const, card_numbers: unique };
      });

      if (!result.ok) {
        return reply.status(400).send({
          success: false,
          error: 'unresolved_inputs',
          unresolved: result.unresolved,
        });
      }

      return reply.status(200).send({
        success: true,
        message:
          'Cards are queued for blocking; they will be processed within a short time.',
        queued_count: result.card_numbers.length,
        card_numbers: result.card_numbers,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('card-block block-batch: queue insert failed', { error: msg });
      return reply.status(500).send({ success: false, error: 'queue_failed', message: msg });
    }
  });
}
