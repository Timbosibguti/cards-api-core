import dotenv from 'dotenv';

// Порядок важен: .env.local перекрывает .env (как в других bin‑скриптах)
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local', override: true });

import type { Pool } from 'pg';
import { getConfig } from '../config/index.js';
import { getDatabaseService } from '../infra/index.js';

const START_AT = '2026-03-01T00:00:00.000Z';
const BANK = 'ecards';
const PAGE_SIZE = 500;
const HTTP_TIMEOUT_MS = 15_000;
const CONCURRENCY = 6;
const LOG_EVERY_SCANNED = 200;

type BankTxTodoRow = {
  created_at: string;
  ext_id: string | null;
};

type EcardsCardOperationItem = Record<string, unknown> & { id?: number };

type EcardsCardOperationResponse = {
  data?: {
    content?: EcardsCardOperationItem[];
  };
};

interface AuthResponse {
  data?: {
    accessToken?: string;
    refreshToken?: string;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function getEcardsAccessToken(): Promise<string> {
  const config = getConfig();
  const prov = config.providers.ecards;
  if (!prov?.username || !prov?.password) {
    throw new Error('ECARDS_USERNAME/ECARDS_PASSWORD must be configured');
  }

  const url = 'https://ecardsnew.cab/api/modern/user/v1/guest/auth/sign-in';
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  const res = await fetch(url, {
    method: 'POST',
    signal: controller.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: prov.username, password: prov.password }),
  }).finally(() => clearTimeout(t));
  const json = (await res.json().catch(() => null)) as AuthResponse | null;
  const token = json?.data?.accessToken;
  if (!res.ok || !token) {
    throw new Error(`eCards sign-in failed: HTTP ${res.status}`);
  }
  return token;
}

async function fetchEcardsOperationBySearch(
  accessToken: string,
  extId: string,
): Promise<EcardsCardOperationItem | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const url =
      `https://ecardsnew.cab/api/modern/account/v1/user/card-operation` +
      `?offset=0&limit=20&sortBy=id&sortDirection=desc&search=${encodeURIComponent(extId)}`;

    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`eCards card-operation HTTP ${res.status}`);
      (err as any).status = res.status;
      (err as any).body = text;
      throw err;
    }

    const json = (text ? JSON.parse(text) : null) as EcardsCardOperationResponse | null;
    const content = json?.data?.content ?? [];
    if (!Array.isArray(content) || content.length === 0) return null;

    const wanted = Number.parseInt(extId, 10);
    if (Number.isFinite(wanted)) {
      const exact = content.find((x) => toInt((x as any)?.id) === wanted);
      if (exact) return exact;
    }

    return content[0] ?? null;
  } finally {
    clearTimeout(t);
  }
}

async function updateRaw(pool: Pool, bank: string, extId: string, raw: EcardsCardOperationItem): Promise<void> {
  await pool.query(
    `UPDATE public.bank_transactions
     SET raw = $2::jsonb
     WHERE bank = $3
       AND ext_id = $1`,
    [extId, JSON.stringify(raw), bank],
  );
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    const fn = queue.shift();
    if (fn) fn();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`[ecards-backfill] start: bank=${BANK}, start_at=${START_AT}`);
  const config = getConfig();
  const db = getDatabaseService(config);
  const mainPool = await db.getPool('main');

  // eslint-disable-next-line no-console
  console.log('[ecards-backfill] acquiring eCards access token...');
  let token = await getEcardsAccessToken();
  // eslint-disable-next-line no-console
  console.log('[ecards-backfill] token acquired');

  let lastCreatedAt = START_AT;
  let lastExtId = '';
  let scanned = 0;
  let updated = 0;
  let notFound = 0;
  let failed = 0;
  const startedAt = Date.now();

  const limit = createLimiter(CONCURRENCY);

  try {
    while (true) {
      const selectStarted = Date.now();
      const page = await mainPool.query<BankTxTodoRow>(
        `SELECT created_at::text AS created_at, ext_id
         FROM public.bank_transactions
         WHERE bank = $1
           AND amount < 0
           AND created_at >= $2::timestamptz
           AND raw->>'description' IS NULL
           AND (created_at, COALESCE(ext_id, '')) > ($3::timestamptz, $4::text)
         ORDER BY created_at, ext_id
         LIMIT $5`,
        [BANK, START_AT, lastCreatedAt, lastExtId, PAGE_SIZE],
      );
      const selectMs = Date.now() - selectStarted;

      // eslint-disable-next-line no-console
      console.log(
        `[ecards-backfill] fetched page: rows=${page.rowCount} cursor_in=(${lastCreatedAt},${lastExtId || '∅'}) select_ms=${selectMs}`,
      );

      if (page.rowCount === 0) break;

      const rows = page.rows;
      lastCreatedAt = rows[rows.length - 1]!.created_at;
      lastExtId = rows[rows.length - 1]!.ext_id ?? '';

      const pageWorkStarted = Date.now();
      await Promise.all(
        rows.map((row) =>
          limit(async () => {
            scanned += 1;
            const extId = row.ext_id ? String(row.ext_id).trim() : '';
            if (!extId) return;

            // Ретраи: 401 -> перелогин; 429/5xx -> короткий backoff.
            for (let attempt = 1; attempt <= 4; attempt++) {
              try {
                const item = await fetchEcardsOperationBySearch(token, extId);
                if (!item) {
                  notFound += 1;
                  return;
                }
                await updateRaw(mainPool, BANK, extId, item);
                updated += 1;
                return;
              } catch (e) {
                const err = e as any;
                const status = typeof err?.status === 'number' ? err.status : null;
                if (status === 401) {
                  // eslint-disable-next-line no-console
                  console.log(`[ecards-backfill] 401 for ext_id=${extId}, re-auth...`);
                  token = await getEcardsAccessToken();
                  continue;
                }
                if (status === 429 || (status != null && status >= 500)) {
                  await sleep(250 * attempt);
                  continue;
                }
                failed += 1;
                return;
              }
            }

            failed += 1;
          }),
        ),
      );
      const pageWorkMs = Date.now() - pageWorkStarted;
      const elapsedMs = Date.now() - startedAt;
      const ratePerSec = elapsedMs > 0 ? Math.round((updated / elapsedMs) * 1000 * 10) / 10 : 0;

      // eslint-disable-next-line no-console
      console.log(
        `[ecards-backfill] page done: cursor_out=(${lastCreatedAt},${lastExtId || '∅'}) page_ms=${pageWorkMs} scanned=${scanned} updated=${updated} notFound=${notFound} failed=${failed} rate_updated_per_sec=${ratePerSec}`,
      );

      if (scanned % LOG_EVERY_SCANNED === 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[ecards-backfill] heartbeat ok: scanned=${scanned} updated=${updated} notFound=${notFound} failed=${failed}`,
        );
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[ecards-backfill] DONE scanned=${scanned} updated=${updated} notFound=${notFound} failed=${failed}`,
    );
  } finally {
    await db.shutdown();
  }
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('ecards backfill script failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

