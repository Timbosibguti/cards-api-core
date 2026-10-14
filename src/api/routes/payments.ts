import type { FastifyInstance } from 'fastify';
import type { BankId } from '../../modules/transactions/index.js';
import { getTransactionsAdapter } from '../../modules/transactions/adapters/index.js';
import { ingestToDevInbox, isDevRequest } from '../../infra/devInboxIngest.js';
import { logger } from '../../infra/logger.js';

type RawBody = unknown;

const SUPPORTED_BANKS: BankId[] = ['ecards', 'adscards', 'multicards', 'stellarcards'];

function isBankId(value: string): value is BankId {
  return (SUPPORTED_BANKS as string[]).includes(value);
}

export async function registerPaymentWebhooks(server: FastifyInstance): Promise<void> {
  server.post<{ Params: { bank: string }; Body: RawBody }>('/webhooks/:bank/transaction', async (request, reply) => {
    logger.warn(`[HUB_WEBHOOK] /webhooks/${request.params.bank}/transaction`, { params: request.params });
    const bankParam = request.params.bank;
    if (!isBankId(bankParam)) {
      await reply.code(400).send({ error: 'Unsupported bank', bank: bankParam });
      return;
    }

    const body = request.body;
    if (isDevRequest(request.query as Record<string, unknown>, body)) {
      const result = await ingestToDevInbox(bankParam, 'provider_webhook', body, {
        correlation_id: (request.headers['x-correlation-id'] as string) ?? undefined,
      });
      if (result) {
        return reply.code(202).send({ status: 'accepted', id: result.id, dev_inbox: true });
      }
      return reply.code(400).send({ error: 'Dev simulation is disabled' });
    }

    const adapter = getTransactionsAdapter(bankParam);
    if (!adapter || !adapter.handleWebhook) {
      await reply.code(400).send({ error: 'Webhook handler not implemented for bank', bank: bankParam });
      return;
    }
    const correlationId = (request.headers['x-correlation-id'] as string | undefined) ?? undefined;
    await adapter.handleWebhook('transaction', body, correlationId);
    return reply.code(202).send({ status: 'accepted' });
  });

  server.post<{ Params: { bank: string }; Body: RawBody }>('/webhooks/:bank/otp', async (request, reply) => {
    logger.warn(`[HUB_WEBHOOK] /webhooks/${request.params.bank}/otp`, { params: request.params });
    
    const bankParam = request.params.bank;
    if (!isBankId(bankParam)) {
      await reply.code(400).send({ error: 'Unsupported bank', bank: bankParam });
      return;
    }

    const body = request.body;
    if (isDevRequest(request.query as Record<string, unknown>, body)) {
      const result = await ingestToDevInbox(bankParam, 'otp_received', body, {
        correlation_id: (request.headers['x-correlation-id'] as string) ?? undefined,
      });
      if (result) {
        return reply.code(202).send({ status: 'accepted', id: result.id, dev_inbox: true });
      }
      return reply.code(400).send({ error: 'Dev simulation is disabled' });
    }

    const adapter = getTransactionsAdapter(bankParam);
    if (!adapter || !adapter.handleWebhook) {
      await reply.code(400).send({ error: 'Webhook handler not implemented for bank', bank: bankParam });
      return;
    }
    const correlationId = (request.headers['x-correlation-id'] as string | undefined) ?? undefined;
    await adapter.handleWebhook('otp', body, correlationId);
    return reply.code(202).send({ status: 'accepted' });
  });
}

