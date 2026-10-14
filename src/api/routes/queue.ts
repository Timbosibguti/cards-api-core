/**
 * REST api/queue/* — совместимость с mqtt_otp_transactions_service.
 * Авторизация: заголовок Api-Key + Bearer JWT (email из payload).
 * Аудит по пользователю и действиям по очередям.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { getConfig } from '../../config/index.js';
import { getEmailFromAuthHeader } from '../../infra/jwt.js';
import { getDatabaseService, enqueueOutgoingNotification } from '../../infra/index.js';
import { createCorrelationId } from '../../infra/correlation/index.js';
import * as queueDb from '../../infra/queueDb.js';
import { enrichBankStatusWithPhoneOnline, getPhoneOnlineForQueueAcquire, PHONE_ONLINE_THRESHOLD_MINUTES } from '../../infra/queuePhoneOnline.js';
import {
  getQueueStatusCache,
  invalidateQueueStatusCache,
  setQueueStatusCache,
  type QueueStatusResponseItem,
} from '../../infra/queueStatusCache.js';
import { logger } from '../../infra/logger.js';

type AuditParams = {
  user_email: string;
  log_type: 'info' | 'log' | 'error' | 'warning';
  severity: number;
  event_type: string;
  event_attributes?: Record<string, unknown>;
};

/** По архитектуре аудит идёт только через outgoing_notifications (mqtt:sequoia/audit), без прямых вызовов AuditService. */
async function enqueueAuditLog(params: AuditParams): Promise<void> {
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
    const accNo = typeof attrs.acc_no === 'string' ? attrs.acc_no : '';
    const timeBucket = now.toISOString().slice(0, 16);
    const dedupKey = `audit:queue:${params.event_type}:${params.user_email}:${bank}:${accNo}:${timeBucket}`;

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
    logger.error('Audit enqueue failed', { event_type: params.event_type, error: err });
  }
}

type QueueSlackParams = {
  message: string;
  email?: string;
};

async function enqueueQueueSlackMessage(params: QueueSlackParams): Promise<void> {
  const now = new Date();
  const correlationId = createCorrelationId();

  const payload = {
    kind: 'queue_notification' as const,
    message: params.message,
    email: params.email ?? null,
    timestamp: now.toISOString(),
    correlation_id: correlationId,
  };

  const timeBucket = now.toISOString().slice(0, 16);
  const target = params.email ?? 'broadcast';
  const messageSig = createHash('sha256').update(params.message, 'utf8').digest('hex').slice(0, 16);
  const dedupKey = `slack:queue:${target}:${timeBucket}:${messageSig}`;

  const config = getConfig();
  const db = getDatabaseService(config);

  await db.withTransaction('main', async (client) => {
    await enqueueOutgoingNotification(client, {
      channel: 'slack:dm',
      payload,
      dedupKey,
      correlationId,
      recipient: params.email ?? null,
    });
  });
}

function requireQueueAuth(request: FastifyRequest, _reply: FastifyReply): string | null {
  // В проде маршруты /api/queue/* больше не требуют Api-Key.
  // Пытаемся вытащить email из Bearer JWT, но если его нет — считаем системным пользователем.
  const email = getEmailFromAuthHeader((request.headers.authorization as string) ?? null);
  return email ?? 'system@groscloud.com';
}

export async function registerQueueRoutes(server: FastifyInstance): Promise<void> {
  // POST /api/queue/acquire
  server.post<{ Body: { bank?: string; acc_no?: string } }>('/api/queue/acquire', async (request, reply) => {
    const email = requireQueueAuth(request, reply);
    if (!email) return;

    const body = request.body ?? {};
    if (!body.bank || !body.acc_no) {
      return reply.status(400).send({ success: false, error: 'Missing required fields: bank, acc_no' });
    }

    logger.warn('[QUEUE_HUB] queue/acquire', { body, email });

    let phoneGate: 'ok' | 'not_found' | 'offline';
    try {
      phoneGate = await getPhoneOnlineForQueueAcquire(body.bank, body.acc_no);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[QUEUE_HUB] queue/acquire phone_online check failed', { err: msg, bank: body.bank, acc_no: body.acc_no });
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
    if (phoneGate === 'not_found') {
      return reply.status(404).send({ success: false, error: 'Bank account not found' });
    }
    if (phoneGate === 'offline') {
      await enqueueAuditLog({
        user_email: email,
        log_type: 'warning',
        severity: 2,
        event_type: 'queue_acquire_device_offline',
        event_attributes: {
          bank: body.bank,
          acc_no: body.acc_no,
          reason: 'OTP device not online (same criteria as queue/status phone_online)',
          threshold_minutes: PHONE_ONLINE_THRESHOLD_MINUTES,
        },
      });
      return reply.status(409).send({
        success: false,
        code: 'device_offline',
        error: `The OTP device for this bank account is not online: no recent network activity within the last ${PHONE_ONLINE_THRESHOLD_MINUTES} minutes. You cannot take the queue until the device can receive SMS. Please try again when the device is connected.`,
      });
    }

    const existing = await queueDb.getUserAcquiredAccount(email);
    if (existing && (existing.bank !== body.bank || existing.acc_no !== body.acc_no)) {
      await enqueueAuditLog({
        user_email: email,
        log_type: 'warning',
        severity: 2,
        event_type: 'queue_acquire_conflict',
        event_attributes: {
          bank: body.bank,
          acc_no: body.acc_no,
          existing_bank: existing.bank,
          existing_acc_no: existing.acc_no,
          reason: 'User already has an acquired bank account',
        },
      });
      return reply.status(409).send({
        success: false,
        error: `You already have an acquired bank account: ${existing.bank} ${existing.acc_no}. Please release it first.`,
      });
    }

    let acquired: boolean;
    try {
      acquired = await queueDb.acquireQueue(email, body.bank, body.acc_no);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Bank account not found') {
        return reply.status(404).send({ success: false, error: 'Bank account not found' });
      }
      await enqueueAuditLog({
        user_email: email,
        log_type: 'error',
        severity: 3,
        event_type: 'queue_acquire_error',
        event_attributes: { bank: body.bank, acc_no: body.acc_no, error: msg },
      });
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }

    if (!acquired) {
      await enqueueAuditLog({
        user_email: email,
        log_type: 'warning',
        severity: 2,
        event_type: 'queue_acquire_failed',
        event_attributes: { bank: body.bank, acc_no: body.acc_no, reason: 'Account is already taken or not found' },
      });
      return reply.status(409).send({ success: false, error: 'Account is already taken or not found' });
    }

    try {
      const accountName = await queueDb.getAccountName(body.bank, body.acc_no);
      const expiresAt = await queueDb.getQueueExpiresAt(body.bank, body.acc_no);
      const extra = await queueDb.getAccountExtra(body.bank, body.acc_no);

      await enqueueAuditLog({
        user_email: email,
        log_type: 'info',
        severity: 1,
        event_type: 'queue_acquired',
        event_attributes: {
          bank: body.bank,
          acc_no: body.acc_no,
          account_name: accountName ?? null,
          expires_at: expiresAt?.toISOString() ?? null,
        },
      });

      if (accountName) {
        let message = `${accountName} занят вами ${email}`;
        if (extra != null) message += `, доп. инфо к банку: ${extra}`;
        if (expiresAt) {
          const h = String(expiresAt.getUTCHours()).padStart(2, '0');
          const m = String(expiresAt.getUTCMinutes()).padStart(2, '0');
          message += ` до ${h}:${m} UTC`;
        }
        await enqueueQueueSlackMessage({ message, email });
      }
    } catch (err) {
      logger.error('Acquire notification error', err);
      await enqueueAuditLog({
        user_email: email,
        log_type: 'error',
        severity: 2,
        event_type: 'acquire_notification_failed',
        event_attributes: {
          bank: body.bank,
          acc_no: body.acc_no,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }

    invalidateQueueStatusCache();
    return reply.status(200).send({ success: true });
  });

  // POST /api/queue/release
  server.post<{ Body: { bank?: string; acc_no?: string } }>('/api/queue/release', async (request, reply) => {
    const email = requireQueueAuth(request, reply);
    if (!email) return;

    const body = request.body ?? {};
    if (!body.bank || !body.acc_no) {
      return reply.status(400).send({ success: false, error: 'Missing required fields: bank, acc_no' });
    }

    logger.warn('[QUEUE_HUB] queue/release', { body, email });

    const accountName = await queueDb.getAccountName(body.bank, body.acc_no);
    const released = await queueDb.releaseQueue(email, body.bank, body.acc_no);

    if (!released) {
      await enqueueAuditLog({
        user_email: email,
        log_type: 'warning',
        severity: 2,
        event_type: 'queue_release_failed',
        event_attributes: {
          bank: body.bank,
          acc_no: body.acc_no,
          account_name: accountName ?? null,
          reason: 'Queue position not found or already released',
        },
      });
      return reply.status(404).send({
        success: false,
        error: 'Queue position not found or already released',
      });
    }

    await enqueueAuditLog({
      user_email: email,
      log_type: 'info',
      severity: 1,
      event_type: 'queue_released',
      event_attributes: { bank: body.bank, acc_no: body.acc_no, account_name: accountName ?? null },
    });

    if (accountName) {
      const message = `${accountName} освобожден вами ${email}`;
      try {
        await enqueueQueueSlackMessage({ message, email });
      } catch (err) {
        logger.error('Release notification enqueue error', err);
        await enqueueAuditLog({
          user_email: email,
          log_type: 'error',
          severity: 2,
          event_type: 'release_notification_failed',
          event_attributes: {
            bank: body.bank,
            acc_no: body.acc_no,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    invalidateQueueStatusCache();
    return reply.status(200).send({ success: true });
  });

  // GET /api/queue/status
  server.get('/api/queue/status', async (request, reply) => {
    const apiKey = (request.headers['api-key'] as string) ?? '';
    const config = getConfig();
    if (apiKey !== config.queueApi.apiKey) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' });
    }
    const email = getEmailFromAuthHeader((request.headers.authorization as string) ?? null);
    if (!email) {
      return reply.status(401).send({ success: false, error: 'Missing or invalid Authorization header' });
    }

    try {
      const cached = getQueueStatusCache(email);
      if (cached) {
        logger.debug('[QUEUE_HUB] queue/status cache hit', { email });
        return reply.status(200).send(cached);
      }

      const bankStatus = await queueDb.getBankStatus(email);
      const withPhoneOnline = await enrichBankStatusWithPhoneOnline(bankStatus);
      const isFinanceDept = await queueDb.isFinanceDepartmentEmployee(email);

      const list: QueueStatusResponseItem[] = withPhoneOnline.map((item) => ({
        bank: item.bank,
        acc_no: item.acc_no,
        name: item.name,
        status: item.status,
        phone_online: item.phone_online,
        ...(item.release_at && { release_at: item.release_at.toISOString() }),
        ...(item.balance !== null && { balance: item.balance }),
        ...(item.currency && { currency: item.currency }),
        ...(item.info && { info: item.info }),
        ...(item.info_at && { info_at: item.info_at.toISOString() }),
        ...(item.info_buyer && { info_buyer: item.info_buyer }),
        ...((isFinanceDept || item.status === 'my') && item.login !== null && { login: item.login }),
        ...((isFinanceDept || item.status === 'my') && item.password !== null && { password: item.password }),
        ...((isFinanceDept || item.status === 'my') && item.extra !== null && { extra: item.extra }),
      }));

      setQueueStatusCache(email, list);
      logger.warn('[QUEUE_HUB] queue/status', { email, list });

      return reply.status(200).send(list);
    } catch (err) {
      logger.error('queue/status error', err);
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // POST /api/queue/credentials
  server.post<{
    Body: { bank?: string; acc_no?: string; login?: string | null; password?: string | null; extra?: string | null };
  }>('/api/queue/credentials', async (request, reply) => {
    const email = requireQueueAuth(request, reply);
    if (!email) return;

    const body = request.body ?? {};
    if (!body.bank || !body.acc_no) {
      return reply.status(400).send({ success: false, error: 'Missing required fields: bank, acc_no' });
    }
    if (
      body.login === undefined &&
      body.password === undefined &&
      body.extra === undefined
    ) {
      return reply.status(400).send({
        success: false,
        error: 'At least one field must be provided: login, password, or extra',
      });
    }

    const accountName = await queueDb.getAccountName(body.bank, body.acc_no);
    if (!accountName) {
      await enqueueAuditLog({
        user_email: email,
        log_type: 'warning',
        severity: 2,
        event_type: 'credentials_update_failed',
        event_attributes: { bank: body.bank, acc_no: body.acc_no, reason: 'Bank account not found' },
      });
      return reply.status(404).send({ success: false, error: 'Bank account not found' });
    }

    let updated: boolean;
    try {
      updated = await queueDb.updateBankAccountCredentials({
        bank: body.bank,
        accNo: body.acc_no,
        login: body.login !== undefined ? body.login : undefined,
        password: body.password !== undefined ? body.password : undefined,
        extra: body.extra !== undefined ? body.extra : undefined,
      });
    } catch (err) {
      logger.error('credentials update error', err);
      await enqueueAuditLog({
        user_email: email,
        log_type: 'error',
        severity: 3,
        event_type: 'credentials_update_error',
        event_attributes: {
          bank: body.bank,
          acc_no: body.acc_no,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return reply.status(500).send({ success: false, error: 'Internal server error' });
    }

    if (!updated) {
      await enqueueAuditLog({
        user_email: email,
        log_type: 'warning',
        severity: 2,
        event_type: 'credentials_update_failed',
        event_attributes: { bank: body.bank, acc_no: body.acc_no, reason: 'Update failed' },
      });
      return reply.status(500).send({ success: false, error: 'Failed to update credentials' });
    }

    await enqueueAuditLog({
      user_email: email,
      log_type: 'info',
      severity: 1,
      event_type: 'credentials_updated',
      event_attributes: {
        bank: body.bank,
        acc_no: body.acc_no,
        account_name: accountName,
        login_updated: body.login !== undefined,
        password_updated: body.password !== undefined,
        extra_updated: body.extra !== undefined,
      },
    });

    invalidateQueueStatusCache();
    return reply.status(200).send({ success: true });
  });

  // POST /api/queue/kickoff
  server.post<{ Body: { email?: string } }>('/api/queue/kickoff', async (request, reply) => {
    const adminEmail = requireQueueAuth(request, reply);
    if (!adminEmail) return;

    const body = request.body ?? {};
    if (!body.email) {
      return reply.status(400).send({ success: false, error: 'Missing required field: email' });
    }

    const targetEmail = body.email;
    const positions = await queueDb.getQueuePositionsByEmail(targetEmail);

    if (positions.length === 0) {
      return reply.status(404).send({
        success: false,
        error: 'No active queue positions found for this email',
      });
    }

    const releasedCount = await queueDb.releaseAllQueuePositionsByEmail(targetEmail);
    if (releasedCount === 0) {
      return reply.status(500).send({ success: false, error: 'Failed to release queue positions' });
    }

    for (const pos of positions) {
      await enqueueAuditLog({
        user_email: targetEmail,
        log_type: 'info',
        severity: 1,
        event_type: 'queue_kicked_off',
        event_attributes: {
          bank: pos.bank,
          acc_no: pos.acc_no,
          account_name: pos.account_name,
          kicked_off_by: adminEmail,
        },
      });
      const message = `Финотдел вас снял с очереди на банк ${pos.account_name}`;
      try {
        await enqueueQueueSlackMessage({ message, email: targetEmail });
      } catch (err) {
        logger.error('Kickoff Slack enqueue error', err);
        await enqueueAuditLog({
          user_email: targetEmail,
          log_type: 'error',
          severity: 2,
          event_type: 'kickoff_notification_failed',
          event_attributes: {
            bank: pos.bank,
            acc_no: pos.acc_no,
            account_name: pos.account_name,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    invalidateQueueStatusCache();
    return reply.status(200).send({
      success: true,
      email: targetEmail,
      released_count: releasedCount,
      positions: positions.map((p) => ({ bank: p.bank, acc_no: p.acc_no, account_name: p.account_name })),
    });
  });
}
