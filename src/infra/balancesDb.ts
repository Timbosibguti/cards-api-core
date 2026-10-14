/**
 * Балансы и алерты bank_accounts, история balance_history.
 * Для sequoia/otp SMS (уменьшение баланса, алерты) и API /api/balances/*.
 */

import type { PoolClient } from 'pg';
import { getConfig } from '../config/index.js';
import { getDatabaseService } from './index.js';
import { logger } from './logger.js';

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const db = getDatabaseService(getConfig());
  const client = await db.getClient('main');
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function decreaseBankAccountBalance(
  client: PoolClient,
  bank: string,
  accNo: string,
  amount: number,
): Promise<number | null> {
  const result = await client.query<{ balance: string }>(
    `UPDATE public.bank_accounts
     SET balance = COALESCE(balance, 0) - $1
     WHERE bank = $2 AND acc_no = $3
     RETURNING balance`,
    [amount, bank.toLowerCase(), accNo],
  );
  if (result.rows[0]) {
    const newBalance = parseFloat(result.rows[0].balance);
    logger.info('Bank account balance decreased', { bank, accNo, amount, newBalance });
    return newBalance;
  }
  return null;
}

export type BankAccountAlerts = {
  balance: number;
  balance_limit_alert: number;
  op_limit_alert: number;
  op_sum_limit_alert: number;
};

export async function getBankAccountAlerts(
  client: PoolClient,
  bank: string,
  accNo: string,
): Promise<BankAccountAlerts | null> {
  const result = await client.query<{
    balance: string;
    balance_limit_alert: string;
    op_limit_alert: string;
    op_sum_limit_alert: string;
  }>(
    `SELECT balance, balance_limit_alert, op_limit_alert, op_sum_limit_alert
     FROM public.bank_accounts
     WHERE bank = $1 AND acc_no = $2`,
    [bank.toLowerCase(), accNo],
  );
  if (!result.rows[0]) return null;
  const r = result.rows[0];
  return {
    balance: parseFloat(r.balance ?? '0'),
    balance_limit_alert: parseFloat(r.balance_limit_alert ?? '0'),
    op_limit_alert: parseFloat(r.op_limit_alert ?? '0'),
    op_sum_limit_alert: parseFloat(r.op_sum_limit_alert ?? '0'),
  };
}

/** Дневная статистика операций по balance_history (sms_decrease / decrease за сегодня). */
export async function getDailyOperationsStats(
  client: PoolClient,
  bank: string,
  accNo: string,
): Promise<{ count: number; sum: number }> {
  const result = await client.query<{ count: string; sum: string | null }>(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0) AS sum
     FROM public.balance_history
     WHERE bank = $1 AND acc_no = $2
       AND DATE(created_at) = CURRENT_DATE
       AND operation_type IN ('sms_decrease', 'decrease')`,
    [bank.toLowerCase(), accNo],
  );
  if (!result.rows[0]) return { count: 0, sum: 0 };
  return {
    count: parseInt(result.rows[0].count, 10) || 0,
    sum: parseFloat(result.rows[0].sum ?? '0') || 0,
  };
}

export async function recordBalanceChange(
  client: PoolClient,
  params: {
    bank: string;
    accNo: string;
    operationType: string;
    amount: number;
    balanceBefore: number;
    balanceAfter: number;
    currency?: string | null;
    userEmail?: string | null;
    comment?: string | null;
    source?: string;
  },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO public.balance_history (
       bank, acc_no, operation_type, amount, balance_before, balance_after,
       currency, user_email, comment, source
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      params.bank.toLowerCase(),
      params.accNo,
      params.operationType,
      params.amount,
      params.balanceBefore,
      params.balanceAfter,
      params.currency ?? null,
      params.userEmail ?? null,
      params.comment ?? null,
      params.source ?? 'manual',
    ],
  );
  return result.rows[0]!.id;
}

export async function updateBankAccountBalance(
  bank: string,
  accNo: string,
  balance: number,
): Promise<boolean> {
  return withClient(async (client) => {
    return updateBankAccountBalanceWithClient(client, bank, accNo, balance);
  });
}

/** Обновление баланса в рамках переданного client (для транзакций, напр. add-balance). */
export async function updateBankAccountBalanceWithClient(
  client: PoolClient,
  bank: string,
  accNo: string,
  balance: number,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE public.bank_accounts SET balance = $1 WHERE bank = $2 AND acc_no = $3`,
    [balance, bank.toLowerCase(), accNo],
  );
  return (result.rowCount ?? 0) > 0;
}

export type BalanceHistoryRow = {
  id: string;
  created_at: Date;
  operation_type: string;
  amount: number;
  balance_before: number;
  balance_after: number;
  currency: string | null;
  user_email: string | null;
  comment: string | null;
  source: string;
};

export type BalanceAccountRow = {
  bank: string;
  acc_no: string;
  name: string | null;
  phone: string | null;
  balance: number;
  currency: string | null;
  balance_limit_alert: number;
  op_limit_alert: number;
  op_sum_limit_alert: number;
  login: string | null;
  password: string | null;
  extra: string | null;
  daily_count: number;
  daily_sum: number;
};

/** Список аккаунтов (phone <> '0') с дневной статистикой. login/password — как в БД (расшифровка в роуте). */
export async function getBalancesList(): Promise<BalanceAccountRow[]> {
  return withClient(async (client) => {
    const result = await client.query<{
      bank: string;
      acc_no: string;
      name: string | null;
      phone: string | null;
      balance: string | null;
      currency: string | null;
      balance_limit_alert: string | null;
      op_limit_alert: string | null;
      op_sum_limit_alert: string | null;
      login: string | null;
      password: string | null;
      extra: string | null;
    }>(
      `SELECT bank, acc_no, name, phone, balance, currency,
              balance_limit_alert, op_limit_alert, op_sum_limit_alert,
              login, password, extra
       FROM public.bank_accounts
       WHERE phone IS DISTINCT FROM '0'
       ORDER BY name ASC NULLS LAST, bank ASC, acc_no ASC`,
    );
    const rows: BalanceAccountRow[] = [];
    for (const r of result.rows) {
      const stats = await getDailyOperationsStats(client, r.bank, r.acc_no);
      rows.push({
        bank: r.bank,
        acc_no: r.acc_no,
        name: r.name,
        phone: r.phone,
        balance: parseFloat(r.balance ?? '0'),
        currency: r.currency,
        balance_limit_alert: parseFloat(r.balance_limit_alert ?? '0'),
        op_limit_alert: parseFloat(r.op_limit_alert ?? '0'),
        op_sum_limit_alert: parseFloat(r.op_sum_limit_alert ?? '0'),
        login: r.login,
        password: r.password,
        extra: r.extra,
        daily_count: stats.count,
        daily_sum: stats.sum,
      });
    }
    return rows;
  });
}

export async function getBankAccountBalance(
  client: PoolClient,
  bank: string,
  accNo: string,
): Promise<{ balance: number; currency: string | null } | null> {
  const result = await client.query<{ balance: string | null; currency: string | null }>(
    `SELECT balance, currency FROM public.bank_accounts WHERE bank = $1 AND acc_no = $2`,
    [bank.toLowerCase(), accNo],
  );
  if (!result.rows[0]) return null;
  return {
    balance: parseFloat(result.rows[0].balance ?? '0'),
    currency: result.rows[0].currency,
  };
}

export async function getBalanceHistory(params: {
  bank: string;
  accNo: string;
  limit?: number;
  offset?: number;
  startDate?: Date;
  endDate?: Date;
}): Promise<BalanceHistoryRow[]> {
  return withClient(async (client) => {
    const conditions: string[] = ['bank = $1', 'acc_no = $2'];
    const values: (string | number | Date)[] = [params.bank.toLowerCase(), params.accNo];
    let paramIndex = 3;
    if (params.startDate) {
      conditions.push(`created_at >= $${paramIndex}`);
      values.push(params.startDate);
      paramIndex++;
    }
    if (params.endDate) {
      conditions.push(`created_at <= $${paramIndex}`);
      values.push(params.endDate);
      paramIndex++;
    }
    const limit = Math.min(params.limit ?? 100, 1000);
    const offset = params.offset ?? 0;
    const result = await client.query<{
      id: string;
      created_at: Date;
      operation_type: string;
      amount: string;
      balance_before: string;
      balance_after: string;
      currency: string | null;
      user_email: string | null;
      comment: string | null;
      source: string;
    }>(
      `SELECT id, created_at, operation_type, amount, balance_before, balance_after,
              currency, user_email, comment, source
       FROM public.balance_history
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...values, limit, offset],
    );
    return result.rows.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      operation_type: r.operation_type,
      amount: parseFloat(r.amount),
      balance_before: parseFloat(r.balance_before),
      balance_after: parseFloat(r.balance_after),
      currency: r.currency,
      user_email: r.user_email,
      comment: r.comment,
      source: r.source,
    }));
  });
}
