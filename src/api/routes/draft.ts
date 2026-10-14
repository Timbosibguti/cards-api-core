/**
 * Webhook /draft — создание pre‑transactions (drafts) из расширения Taurus.
 * См. architecture/processes.md 3.3.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getConfig } from '../../config/index.js';
import { logger } from '../../infra/logger.js';
import { createBankPreDraftFromTaurus, type TaurusDraftRequest } from '../../modules/drafts/index.js';

type DraftRequestBody = TaurusDraftRequest;

export async function registerDraftRoutes(server: FastifyInstance): Promise<void> {
  server.post('/draft', async (request: FastifyRequest<{ Body: DraftRequestBody }>, reply: FastifyReply) => {
    logger.info('[TAURUS] Draft webhook request received', { body: request.body });

    const config = getConfig();

    const apiKey = (request.headers['api-key'] as string) ?? '';
    if (apiKey !== config.queueApi.apiKey) {
      logger.warn('Draft webhook unauthorized', { apiKeyPresent: Boolean(apiKey) });
      return reply.status(401).send({ success: false, error: 'Unauthorized' });
    }

    const body = request.body as DraftRequestBody;
    if (!body || Object.keys(body).length === 0) {
      logger.warn('Draft webhook: empty body');
      return reply.status(400).send({ success: false, error: 'Request body is empty' });
    }

    if (!body.profileId || !body.profileName) {
      logger.warn('Draft webhook: missing required fields', { body });
      return reply
        .status(400)
        .send({ success: false, error: 'Missing required fields: profileId, profileName' });
    }

    const version = (request.query as Record<string, string | undefined>)?.version ?? null;

    try {
      await createBankPreDraftFromTaurus(body, version);
      return reply.status(200).send({ success: true });
    } catch (err) {
      logger.error('Draft webhook: internal error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });
}

