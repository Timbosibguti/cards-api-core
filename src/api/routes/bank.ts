import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../../config/index.js';
import { getEmailFromAuthHeader } from '../../infra/jwt.js';
import { getDatabaseService, enqueueOutgoingNotification } from '../../infra/index.js';
import { createCorrelationId } from '../../infra/correlation/index.js';
import * as queueDb from '../../infra/queueDb.js';
import { logger } from '../../infra/logger.js';

type AuditParams = {
  user_email: string;
  log_type: 'info' | 'log' | 'error' | 'warning';
  severity: number;
  event_type: 'bank_comment_set' | 'bank_comment_set_failed' | 'bank_comment_set_error';
  event_attributes?: {
    comment: string;
    bank?: string;
    acc_no?: string;
    account_name?: string | null;
    reason?: string;
    error?: string;
  };
};

async function enqueueBankCommentAudit(params: AuditParams): Promise<void> {
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
    const attrs = params.event_attributes ?? { comment: '' };
    const bank = attrs.bank ?? '';
    const accNo = attrs.acc_no ?? '';
    const timeBucket = now.toISOString().slice(0, 16);
    const dedupKey = `audit:bank_comment:${params.event_type}:${params.user_email}:${bank}:${accNo}:${timeBucket}`;

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
    logger.error('Bank comment audit enqueue failed', { event_type: params.event_type, error: err });
  }
}

function requireBankAuth(request: FastifyRequest, reply: FastifyReply): string | null {
  const email = getEmailFromAuthHeader((request.headers.authorization as string) ?? null);
  if (!email) {
    void reply.status(401).send({ success: false, error: 'Missing or invalid Authorization header' });
    return null;
  }
  return email;
}

export async function registerBankRoutes(server: FastifyInstance): Promise<void> {
  // POST /api/bank/comment
  server.post<{ Body: { comment?: string | null } }>('/api/bank/comment', async (request, reply) => {
    let email: string | null = null;
    let commentValue = '';

    try {
      email = requireBankAuth(request, reply);
      if (!email) return;

      const body = request.body ?? {};
      if (typeof body.comment !== 'string' && body.comment !== null) {
        return reply.status(400).send({ success: false, error: 'Missing required field: comment' });
      }

      // Комментарий может быть пустым по ТЗ
      commentValue = body.comment ?? '';

      logger.info('/api/bank/comment Request', { email, comment: commentValue });

      // Для текущего баера берём его занятый аккаунт из queue
      const acquired = await queueDb.getUserAcquiredAccount(email);
      if (!acquired) {
        await enqueueBankCommentAudit({
          user_email: email,
          log_type: 'warning',
          severity: 2,
          event_type: 'bank_comment_set_failed',
          event_attributes: {
            comment: commentValue,
            reason: 'No acquired bank account found for current user',
          },
        });
        return reply
          .status(404)
          .send({ success: false, error: 'No acquired bank account found for current user' });
      }

      // Обновляем комментарий в полях info/info_at/info_buyer bank_accounts
      const updated = await queueDb.updateBankAccountInfo({
        bank: acquired.bank,
        accNo: acquired.acc_no,
        info: commentValue,
        infoBuyer: email,
      });

      if (!updated) {
        await enqueueBankCommentAudit({
          user_email: email,
          log_type: 'error',
          severity: 3,
          event_type: 'bank_comment_set_failed',
          event_attributes: {
            comment: commentValue,
            bank: acquired.bank,
            acc_no: acquired.acc_no,
            reason: 'Bank account not found',
          },
        });

        return reply.status(404).send({ success: false, error: 'Bank account not found' });
      }

      const accountName = await queueDb.getAccountName(acquired.bank, acquired.acc_no);

      await enqueueBankCommentAudit({
        user_email: email,
        log_type: 'info',
        severity: 1,
        event_type: 'bank_comment_set',
        event_attributes: {
          comment: commentValue,
          bank: acquired.bank,
          acc_no: acquired.acc_no,
          account_name: accountName,
        },
      });

      return reply.status(200).send({ success: true });
    } catch (error) {
      logger.error('Error updating bank account comment', error);

      await enqueueBankCommentAudit({
        user_email: email ?? '',
        log_type: 'error',
        severity: 3,
        event_type: 'bank_comment_set_error',
        event_attributes: {
          comment: commentValue,
          error: error instanceof Error ? error.message : String(error),
        },
      });

      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });
}

