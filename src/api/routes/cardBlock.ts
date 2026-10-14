import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getConfig } from '../../config/index.js';
import { blockCardByCardNumber } from '../../modules/cardBlock/index.js';
import { logger } from '../../infra/logger.js';

type BlockBody = { card_number?: string | number };

export async function registerCardBlockRoutes(server: FastifyInstance): Promise<void> {
  const config = getConfig();

  server.post<{ Body: BlockBody }>('/api/card-block/block', async (request: FastifyRequest<{ Body: BlockBody }>, reply: FastifyReply) => {
    const apiKey = (request.headers['api-key'] as string) ?? '';
    if (apiKey !== config.queueApi.apiKey) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' });
    }

    const cardNumber = request.body?.card_number;
    if (cardNumber === undefined || cardNumber === null || cardNumber === '') {
      return reply.status(400).send({ success: false, error: 'card_number is required' });
    }

    try {
      const result = await blockCardByCardNumber(cardNumber);
      if (!result.ok) {
        const status =
          result.error === 'card_not_found'
            ? 404
            : result.error === 'unsupported_bank' || result.error === 'missing_ext_id'
              ? 422
              : 502;
        return reply.status(status).send({ success: false, ...result });
      }
      return reply.status(200).send({ success: true, bank: result.bank });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('card-block: unexpected error', { error: msg });
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });
}
