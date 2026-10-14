import os from 'node:os';
import type { DatabaseService } from './DatabaseService.js';

const DEFAULT_LEASE_TTL_SECONDS = 60;

function getInstanceIdFromArgs(): string | null {
  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--instance' || arg === '-i') {
      const value = argv[i + 1];
      if (!value) break;
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
    if (arg.startsWith('--instance=')) {
      const value = arg.slice('--instance='.length).trim();
      if (value.length > 0) return value;
    }
  }

  return null;
}

const INSTANCE_ID: string =
  (process.env.INSTANCE_ID && process.env.INSTANCE_ID.trim().length > 0
    ? process.env.INSTANCE_ID.trim()
    : null) ??
  getInstanceIdFromArgs() ??
  `${os.hostname()}:${process.pid}`;

export function getPollingInstanceId(): string {
  return INSTANCE_ID;
}

/**
 * Попытаться захватить lease для poller'а id. Если lease свободен или истёк,
 * текущий инстанс становится владельцем на TTL секунд. Возвращает true, если
 * lease удерживается этим инстансом, false — если сейчас владелец другой.
 */
export async function acquirePollingLease(
  db: DatabaseService,
  id: string,
  ttlSeconds: number = DEFAULT_LEASE_TTL_SECONDS,
): Promise<boolean> {
  const holder = INSTANCE_ID;
  const acquiredByUs = await db.withTransaction('main', async (client) => {
    const res = await client.query<{ holder: string | null }>(
      `INSERT INTO public.polling_leases (id, holder, acquired_at, expires_at)
       VALUES ($1, $2, NOW(), NOW() + ($3 || ' seconds')::interval)
       ON CONFLICT (id) DO UPDATE
         SET holder = CASE
                        WHEN polling_leases.expires_at < NOW() THEN EXCLUDED.holder
                        ELSE polling_leases.holder
                      END,
             acquired_at = CASE
                        WHEN polling_leases.expires_at < NOW() THEN EXCLUDED.acquired_at
                        ELSE polling_leases.acquired_at
                      END,
             expires_at = CASE
                        WHEN polling_leases.expires_at < NOW() THEN EXCLUDED.expires_at
                        ELSE polling_leases.expires_at
                      END
       RETURNING holder`,
      [id, holder, ttlSeconds],
    );
    const row = res.rows[0];
    return row?.holder === holder;
  });
  return acquiredByUs;
}

