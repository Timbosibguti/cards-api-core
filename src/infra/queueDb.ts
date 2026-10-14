/**
 * Очередь (queue) и банковские аккаунты (bank_accounts) для api/queue/*.
 * Совместимость с mqtt_otp_transactions_service.
 */

import type { PoolClient } from 'pg';
import { getConfig } from '../config/index.js';
import { getDatabaseService } from './index.js';
import { decryptCredentials, encryptCredentials } from './credentialsCrypto.js';
import { logger } from './logger.js';

export type BankStatusItem = {
  bank: string;
  acc_no: string;
  name: string;
  status: 'my' | 'busy' | 'free';
  release_at: Date | null;
  balance: number | null;
  currency: string | null;
  info: string | null;
  info_at: Date | null;
  info_buyer: string | null;
  login: string | null;
  password: string | null;
  extra: string | null;
};

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const db = getDatabaseService(getConfig());
  const client = await db.getClient('main');
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function cleanupExpiredQueues(client: PoolClient): Promise<void> {
  try {
    await client.query('DELETE FROM public.queue WHERE expires_at < NOW()');
  } catch (err) {
    logger.error('Error cleaning up expired queues', err as Error);
  }
}

export async function getUserAcquiredAccount(email: string): Promise<{ bank: string; acc_no: string } | null> {
  return withClient(async (client) => {
    await cleanupExpiredQueues(client);
    const result = await client.query<{ bank: string; acc_no: string }>(
      `SELECT bank, acc_no FROM public.queue WHERE email = $1 AND expires_at > NOW() LIMIT 1`,
      [email]
    );
    return result.rows[0] ?? null;
  });
}

export async function acquireQueue(email: string, bank: string, accNo: string): Promise<boolean> {
  const db = getDatabaseService(getConfig());
  const client = await db.getClient('main');
  try {
    await cleanupExpiredQueues(client);

    const accountCheck = await client.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM public.bank_accounts WHERE bank = $1 AND acc_no = $2',
      [bank, accNo]
    );
    if (parseInt(accountCheck.rows[0]!.count, 10) === 0) throw new Error('Bank account not found');

    const existing = await client.query<{ email: string; expires_at: Date }>(
      'SELECT email, expires_at FROM public.queue WHERE bank = $1 AND acc_no = $2',
      [bank, accNo]
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0]!;
      if (new Date(row.expires_at) > new Date()) {
        if (row.email === email) {
          const upd = await client.query(
            `UPDATE public.queue SET expires_at = NOW() + INTERVAL '40 minutes', acquired_at = NOW(), notification_sent = FALSE
             WHERE bank = $1 AND acc_no = $2 AND email = $3`,
            [bank, accNo, email]
          );
          if ((upd.rowCount ?? 0) > 0) return true;
        } else return false;
      }
      await client.query('DELETE FROM public.queue WHERE bank = $1 AND acc_no = $2', [bank, accNo]);
    }

    await client.query(
      `INSERT INTO public.queue (email, bank, acc_no, expires_at, notification_sent)
       VALUES ($1, $2, $3, NOW() + INTERVAL '40 minutes', FALSE)`,
      [email, bank, accNo]
    );
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') {
      const existing = await client.query<{ email: string }>(
        'SELECT email FROM public.queue WHERE bank = $1 AND acc_no = $2',
        [bank, accNo]
      );
      if (existing.rows.length > 0 && existing.rows[0]!.email === email) {
        const upd = await client.query(
          `UPDATE public.queue SET expires_at = NOW() + INTERVAL '40 minutes', acquired_at = NOW(), notification_sent = FALSE
           WHERE bank = $1 AND acc_no = $2 AND email = $3`,
          [bank, accNo, email]
        );
        if ((upd.rowCount ?? 0) > 0) return true;
      }
      return false;
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function releaseQueue(email: string, bank: string, accNo: string): Promise<boolean> {
  return withClient(async (client) => {
    const result = await client.query(
      'DELETE FROM public.queue WHERE email = $1 AND bank = $2 AND acc_no = $3',
      [email, bank, accNo]
    );
    return (result.rowCount ?? 0) > 0;
  });
}

export async function getQueuePositionsByEmail(email: string): Promise<Array<{ bank: string; acc_no: string; account_name: string }>> {
  return withClient(async (client) => {
    await cleanupExpiredQueues(client);
    const result = await client.query<{ bank: string; acc_no: string; name: string }>(
      `SELECT q.bank, q.acc_no, ba.name
       FROM public.queue q
       JOIN public.bank_accounts ba ON q.bank = ba.bank AND q.acc_no = ba.acc_no
       WHERE q.email = $1 AND q.expires_at > NOW()`,
      [email]
    );
    return result.rows.map((r) => ({ bank: r.bank, acc_no: r.acc_no, account_name: r.name }));
  });
}

export async function releaseAllQueuePositionsByEmail(email: string): Promise<number> {
  return withClient(async (client) => {
    const result = await client.query('DELETE FROM public.queue WHERE email = $1', [email]);
    return result.rowCount ?? 0;
  });
}

export async function getAccountName(bank: string, accNo: string): Promise<string | null> {
  return withClient(async (client) => {
    const result = await client.query<{ name: string }>(
      'SELECT name FROM public.bank_accounts WHERE bank = $1 AND acc_no = $2',
      [bank, accNo]
    );
    return result.rows[0]?.name ?? null;
  });
}

export async function getAccountExtra(bank: string, accNo: string): Promise<string | null> {
  return withClient(async (client) => {
    const result = await client.query<{ extra: string | null }>(
      'SELECT extra FROM public.bank_accounts WHERE bank = $1 AND acc_no = $2',
      [bank, accNo]
    );
    return result.rows[0]?.extra ?? null;
  });
}

export async function updateBankAccountInfo(params: {
  bank: string;
  accNo: string;
  info: string;
  infoBuyer: string;
}): Promise<boolean> {
  return withClient(async (client) => {
    const result = await client.query(
      `UPDATE public.bank_accounts
       SET info = $1,
           info_at = NOW(),
           info_buyer = $2
       WHERE bank = $3 AND acc_no = $4`,
      [params.info, params.infoBuyer, params.bank, params.accNo],
    );
    return (result.rowCount ?? 0) > 0;
  });
}

export async function getQueueExpiresAt(bank: string, accNo: string): Promise<Date | null> {
  return withClient(async (client) => {
    const result = await client.query<{ expires_at: Date }>(
      'SELECT expires_at FROM public.queue WHERE bank = $1 AND acc_no = $2',
      [bank, accNo]
    );
    return result.rows[0]?.expires_at ?? null;
  });
}

export async function isFinanceDepartmentEmployee(_email: string): Promise<boolean> {
  return false;
}

export async function getQueueEmail(bank: string, accNo: string): Promise<string | null> {
  return withClient(async (client) => {
    const result = await client.query<{ email: string }>(
      'SELECT email FROM public.queue WHERE bank = $1 AND acc_no = $2',
      [bank, accNo]
    );
    return result.rows[0]?.email ?? null;
  });
}

export async function getBankStatus(userEmail: string): Promise<BankStatusItem[]> {
  return withClient(async (client) => {
    await cleanupExpiredQueues(client);

    const result = await client.query<{
      bank: string;
      acc_no: string;
      name: string;
      email: string | null;
      expires_at: Date | null;
      balance: string | null;
      currency: string | null;
      info: string | null;
      info_at: Date | null;
      info_buyer: string | null;
      login: string | null;
      password: string | null;
      extra: string | null;
    }>(
      `SELECT ba.bank, ba.acc_no, ba.name, ba.balance, ba.currency, ba.info, ba.info_at, ba.info_buyer,
              ba.login, ba.password, ba.extra, q.email, q.expires_at
       FROM public.bank_accounts ba
       LEFT JOIN public.queue q ON ba.bank = q.bank AND ba.acc_no = q.acc_no
       WHERE ba.phone IS DISTINCT FROM '0'
       ORDER BY ba.bank ASC, ba.name ASC`
    );

    const hasEncryption = Boolean(getConfig().queueApi.encryptionKey);
    const items: BankStatusItem[] = [];

    for (const row of result.rows) {
      let status: 'my' | 'busy' | 'free';
      let release_at: Date | null = null;
      if (row.email && row.expires_at) {
        status = row.email === userEmail ? 'my' : 'busy';
        release_at = row.expires_at;
      } else status = 'free';

      let login: string | null = null;
      let password: string | null = null;
      if (status === 'my' && hasEncryption) {
        try {
          if (row.login) login = decryptCredentials(row.login);
          if (row.password) password = decryptCredentials(row.password);
        } catch (e) {
          logger.error('Failed to decrypt credentials', { bank: row.bank, acc_no: row.acc_no, error: e });
        }
      } else if (status === 'my' && !hasEncryption && (row.login || row.password)) {
        login = row.login;
        password = row.password;
      }

      items.push({
        bank: row.bank,
        acc_no: row.acc_no,
        name: row.name,
        status,
        release_at,
        balance: row.balance != null ? parseFloat(row.balance) : null,
        currency: row.currency,
        info: row.info,
        info_at: row.info_at,
        info_buyer: row.info_buyer,
        login,
        password,
        extra: row.extra,
      });
    }
    return items;
  });
}

export async function updateBankAccountCredentials(params: {
  bank: string;
  accNo: string;
  login?: string | null;
  password?: string | null;
  extra?: string | null;
}): Promise<boolean> {
  return withClient(async (client) => {
    const updates: string[] = [];
    const values: (string | null)[] = [];
    let i = 1;
    if (params.login !== undefined) {
      updates.push(`login = $${i}`);
      values.push(params.login ? encryptCredentials(params.login) : null);
      i++;
    }
    if (params.password !== undefined) {
      updates.push(`password = $${i}`);
      values.push(params.password ? encryptCredentials(params.password) : null);
      i++;
    }
    if (params.extra !== undefined) {
      updates.push(`extra = $${i}`);
      values.push(params.extra);
      i++;
    }
    if (updates.length === 0) return false;
    values.push(params.bank, params.accNo);
    const result = await client.query(
      `UPDATE public.bank_accounts SET ${updates.join(', ')} WHERE bank = $${i} AND acc_no = $${i + 1}`,
      values
    );
    return (result.rowCount ?? 0) > 0;
  });
}
