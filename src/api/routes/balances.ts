/**
 * REST api/balances/* — совместимость с mqtt_otp_transactions_service.
 * Авторизация: Api-Key (queue) ИЛИ Basic Auth ИЛИ Bearer JWT (любой один).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getConfig } from '../../config/index.js';
import { getEmailFromAuthHeader } from '../../infra/jwt.js';
import { getDatabaseService } from '../../infra/index.js';
import * as balancesDb from '../../infra/balancesDb.js';
import * as queueDb from '../../infra/queueDb.js';
import { decryptCredentials } from '../../infra/credentialsCrypto.js';
import { logger } from '../../infra/logger.js';

function checkBasicAuth(request: FastifyRequest): boolean {
  const authHeader = (request.headers.authorization as string) ?? '';
  if (!authHeader.startsWith('Basic ')) return false;
  const config = getConfig();
  if (!config.basicAuth) return false;
  const base64 = authHeader.slice(6).trim();
  try {
    const decoded = Buffer.from(base64, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    const user = colon >= 0 ? decoded.slice(0, colon) : decoded;
    const pass = colon >= 0 ? decoded.slice(colon + 1) : '';
    return user === config.basicAuth!.user && pass === config.basicAuth!.password;
  } catch {
    return false;
  }
}

/** Возвращает true если авторизация прошла (Api-Key или Basic или JWT). Иначе отправляет 401 и возвращает false. */
function requireBalancesAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  const config = getConfig();
  const apiKey = (request.headers['api-key'] as string) ?? '';
  if (apiKey === config.queueApi.apiKey) return true;
  if (checkBasicAuth(request)) return true;
  const email = getEmailFromAuthHeader((request.headers.authorization as string) ?? null);
  if (email) return true;
  void reply.status(401).send({
    success: false,
    error: 'Unauthorized - Api-Key, Basic Auth or JWT Bearer token required',
  });
  return false;
}

export async function registerBalancesRoutes(server: FastifyInstance): Promise<void> {
  // GET /api/balances
  server.get('/api/balances', async (request, reply) => {
    if (!requireBalancesAuth(request, reply)) return;
    try {
      const list = await balancesDb.getBalancesList();
      const accounts = list.map((row) => {
        let login: string | null = null;
        let password: string | null = null;
        if (row.login) {
          try {
            login = decryptCredentials(row.login);
          } catch (e) {
            logger.error('Failed to decrypt login', { bank: row.bank, acc_no: row.acc_no, error: e });
          }
        }
        if (row.password) {
          try {
            password = decryptCredentials(row.password);
          } catch (e) {
            logger.error('Failed to decrypt password', { bank: row.bank, acc_no: row.acc_no, error: e });
          }
        }
        return {
          bank: row.bank,
          acc_no: row.acc_no,
          name: row.name,
          phone: row.phone,
          balance: row.balance,
          currency: row.currency,
          balance_limit_alert: row.balance_limit_alert,
          op_limit_alert: row.op_limit_alert,
          op_sum_limit_alert: row.op_sum_limit_alert,
          login,
          password,
          extra: row.extra,
          daily_operations: { count: row.daily_count, sum: row.daily_sum },
        };
      });
      return reply.send(accounts);
    } catch (err) {
      logger.error('GET /api/balances', err);
      return reply.status(500).send({ success: false, error: (err as Error).message || 'Internal server error' });
    }
  });

  // POST /api/balances/add-balance
  server.post<{
    Body: { bank?: string; acc_no?: string; amount?: number };
  }>('/api/balances/add-balance', async (request, reply) => {
    if (!requireBalancesAuth(request, reply)) return;
    const body = request.body ?? {};
    const { bank, acc_no, amount } = body;
    if (!bank || !acc_no || amount === undefined || amount === null) {
      return reply.status(400).send({ success: false, error: 'Missing required fields: bank, acc_no, amount' });
    }
    if (typeof amount !== 'number') {
      return reply.status(400).send({ success: false, error: 'Amount must be a number' });
    }
    const config = getConfig();
    const db = getDatabaseService(config);
    try {
      const isBasic = checkBasicAuth(request);
      const email = getEmailFromAuthHeader((request.headers.authorization as string) ?? null);
      const userEmail = isBasic ? 'admin' : (email ?? null);
      const source = isBasic ? 'manual' : 'api';

      type AddResult = { status: 'ok'; newBalance: number } | { status: 'not_found' } | { status: 'negative' } | { status: 'error' };
      const addResult: AddResult = await db.withTransaction('main', async (client) => {
        const current = await balancesDb.getBankAccountBalance(client, bank, acc_no);
        if (!current) return { status: 'not_found' as const };
        const currentBalance = current.balance;
        const currency = current.currency;
        const nextBalance = currentBalance + amount;
        if (nextBalance < 0) return { status: 'negative' as const };
        const updated = await balancesDb.updateBankAccountBalanceWithClient(
          client,
          bank,
          acc_no,
          nextBalance,
        );
        if (!updated) return { status: 'not_found' as const };
        await balancesDb.recordBalanceChange(client, {
          bank: bank.toLowerCase(),
          accNo: acc_no,
          operationType: 'add',
          amount,
          balanceBefore: currentBalance,
          balanceAfter: nextBalance,
          currency,
          userEmail,
          comment: 'Manual balance addition',
          source,
        });
        return { status: 'ok' as const, newBalance: nextBalance };
      });

      if (addResult.status === 'not_found') {
        return reply.status(404).send({ success: false, error: 'Account not found' });
      }
      if (addResult.status === 'negative') {
        return reply.status(400).send({
          success: false,
          error: 'Resulting balance cannot be negative',
        });
      }
      if (addResult.status === 'ok') {
        return reply.send({ success: true, newBalance: addResult.newBalance });
      }
      return reply.status(500).send({ success: false, error: 'Update failed' });
    } catch (err) {
      logger.error('POST /api/balances/add-balance', err);
      return reply.status(500).send({ success: false, error: (err as Error).message || 'Internal server error' });
    }
  });

  // POST /api/balances/update-balance
  server.post<{
    Body: { bank?: string; acc_no?: string; balance?: number };
  }>('/api/balances/update-balance', async (request, reply) => {
    if (!requireBalancesAuth(request, reply)) return;
    const body = request.body ?? {};
    const { bank, acc_no, balance } = body;
    if (!bank || !acc_no || balance === undefined || balance === null) {
      return reply.status(400).send({ success: false, error: 'Missing required fields: bank, acc_no, balance' });
    }
    if (typeof balance !== 'number' || balance < 0) {
      return reply.status(400).send({ success: false, error: 'Balance must be a non-negative number' });
    }
    try {
      const success = await balancesDb.updateBankAccountBalance(bank.toLowerCase(), acc_no, balance);
      if (success) return reply.send({ success: true });
      return reply.status(404).send({ success: false, error: 'Account not found or update failed' });
    } catch (err) {
      logger.error('POST /api/balances/update-balance', err);
      return reply.status(500).send({ success: false, error: (err as Error).message || 'Internal server error' });
    }
  });

  // POST /api/balances/update-credentials
  server.post<{
    Body: { bank?: string; acc_no?: string; login?: string | null; password?: string | null; extra?: string | null };
  }>('/api/balances/update-credentials', async (request, reply) => {
    if (!requireBalancesAuth(request, reply)) return;
    const body = request.body ?? {};
    const { bank, acc_no, login, password, extra } = body;
    if (!bank || !acc_no) {
      return reply.status(400).send({ success: false, error: 'Missing required fields: bank, acc_no' });
    }
    try {
      const success = await queueDb.updateBankAccountCredentials({
        bank: bank.toLowerCase(),
        accNo: acc_no,
        login: login !== undefined ? login : undefined,
        password: password !== undefined ? password : undefined,
        extra: extra !== undefined ? extra : undefined,
      });
      if (success) return reply.send({ success: true });
      return reply.status(404).send({ success: false, error: 'Account not found or no fields to update' });
    } catch (err) {
      logger.error('POST /api/balances/update-credentials', err);
      return reply.status(500).send({ success: false, error: (err as Error).message || 'Internal server error' });
    }
  });

  // POST /api/balances/update-limits
  server.post<{
    Body: {
      bank?: string;
      acc_no?: string;
      balance_limit_alert?: number;
      op_limit_alert?: number;
      op_sum_limit_alert?: number;
      phone?: string;
    };
  }>('/api/balances/update-limits', async (request, reply) => {
    if (!requireBalancesAuth(request, reply)) return;
    const body = request.body ?? {};
    const { bank, acc_no, balance_limit_alert, op_limit_alert, op_sum_limit_alert, phone } = body;
    if (!bank || !acc_no) {
      return reply.status(400).send({ success: false, error: 'Missing required fields: bank, acc_no' });
    }
    const updates: string[] = [];
    const values: (number | string)[] = [];
    let paramIndex = 1;
    if (balance_limit_alert !== undefined && balance_limit_alert !== null) {
      if (typeof balance_limit_alert !== 'number' || balance_limit_alert < 0) {
        return reply.status(400).send({
          success: false,
          error: 'balance_limit_alert must be a non-negative number',
        });
      }
      updates.push(`balance_limit_alert = $${paramIndex}`);
      values.push(balance_limit_alert);
      paramIndex++;
    }
    if (op_limit_alert !== undefined && op_limit_alert !== null) {
      if (typeof op_limit_alert !== 'number' || op_limit_alert < 0) {
        return reply.status(400).send({
          success: false,
          error: 'op_limit_alert must be a non-negative number',
        });
      }
      updates.push(`op_limit_alert = $${paramIndex}`);
      values.push(op_limit_alert);
      paramIndex++;
    }
    if (op_sum_limit_alert !== undefined && op_sum_limit_alert !== null) {
      if (typeof op_sum_limit_alert !== 'number' || op_sum_limit_alert < 0) {
        return reply.status(400).send({
          success: false,
          error: 'op_sum_limit_alert must be a non-negative number',
        });
      }
      updates.push(`op_sum_limit_alert = $${paramIndex}`);
      values.push(op_sum_limit_alert);
      paramIndex++;
    }
    if (phone !== undefined && phone !== null) {
      updates.push(`phone = $${paramIndex}`);
      values.push(phone);
      paramIndex++;
    }
    if (updates.length === 0) {
      return reply.status(400).send({ success: false, error: 'No fields to update' });
    }
    values.push(bank.toLowerCase(), acc_no);
    try {
      const config = getConfig();
      const db = getDatabaseService(config);
      const client = await db.getClient('main');
      try {
        const result = await client.query(
          `UPDATE public.bank_accounts SET ${updates.join(', ')} WHERE bank = $${paramIndex} AND acc_no = $${paramIndex + 1}`,
          values,
        );
        const updated = (result.rowCount ?? 0) > 0;
        if (updated) {
          logger.info('Bank account limits updated', { bank, acc_no });
          return reply.send({ success: true });
        }
        return reply.status(404).send({ success: false, error: 'Account not found' });
      } finally {
        client.release();
      }
    } catch (err) {
      logger.error('POST /api/balances/update-limits', err);
      return reply.status(500).send({ success: false, error: (err as Error).message || 'Internal server error' });
    }
  });

  // GET /api/balances/history
  server.get<{
    Querystring: { bank?: string; acc_no?: string; limit?: string; offset?: string; startDate?: string; endDate?: string };
  }>('/api/balances/history', async (request, reply) => {
    if (!requireBalancesAuth(request, reply)) return;
    const { bank, acc_no, limit, offset, startDate, endDate } = request.query;
    if (!bank || !acc_no) {
      return reply.status(400).send({ success: false, error: 'Missing required params: bank, acc_no' });
    }
    const limitNum = parseInt(limit ?? '100', 10);
    const offsetNum = parseInt(offset ?? '0', 10);
    let startDateObj: Date | undefined;
    let endDateObj: Date | undefined;
    if (startDate) startDateObj = new Date(startDate);
    if (endDate) {
      endDateObj = new Date(endDate);
      endDateObj.setHours(23, 59, 59, 999);
    }
    try {
      const history = await balancesDb.getBalanceHistory({
        bank,
        accNo: acc_no,
        limit: limitNum,
        offset: offsetNum,
        startDate: startDateObj,
        endDate: endDateObj,
      });
      return reply.send(history);
    } catch (err) {
      logger.error('GET /api/balances/history', err);
      return reply.status(500).send({ success: false, error: (err as Error).message || 'Internal server error' });
    }
  });
}
