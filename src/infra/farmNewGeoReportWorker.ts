/**
 * Ежедневный отчёт по "свободным картам" и прогнозу unlink-dead.
 * Запуск: 05:00 по времени сервера (08:00 МСК).
 * Отправка: Slack канал #farm-new-geo через outgoing_notifications.
 */

import type { PoolClient } from 'pg';
import { getConfig } from '../config/index.js';
import { getDatabaseService } from './index.js';
import { enqueueOutgoingNotification } from './outgoingNotifications.js';
import { createCorrelationId } from './correlation/index.js';
import { logger } from './logger.js';
import { ACC_NO_FARM } from './cardsDb.js';

const CHECK_INTERVAL_MS = 60 * 1000; // 1 мин

type WorkerHandle = { stop: () => Promise<void> };

type UnlinkRow = { bank: string | null; bin: string | null; cnt: number };
type FreeRow = { bank: string; bin: string; cnt: number };

function tomorrowMidnightServer(): Date {
  const now = new Date();
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d;
}

async function getDeadProfilesByCutoff(
  farmClient: PoolClient,
  cutoff: Date,
): Promise<string[]> {
  const r = await farmClient.query<{ name: string }>(
    `SELECT tprof.name
     FROM tbl_profiles tprof
     INNER JOIN tbl_statuses ts ON ts.id = tprof.status_id
     INNER JOIN (
       SELECT tsl.profile_id, MAX(tsl.created_at) AS entered_refund_at
       FROM tbl_statuses_log tsl
       INNER JOIN tbl_statuses ts_new ON ts_new.id = tsl.status_new
       WHERE ts_new.phase_id = 4 AND ts_new.stage_id = 1
       GROUP BY tsl.profile_id
     ) last_refund ON last_refund.profile_id = tprof.id
     WHERE ts.phase_id = 4 AND ts.stage_id = 1
       AND last_refund.entered_refund_at <= $1::timestamptz`,
    [cutoff.toISOString()],
  );
  return r.rows.map((row) => row.name);
}

async function getWillUnlinkByBankBin(params: {
  mainClient: PoolClient;
  dead5: string[];
  dead30: string[];
  billingBins: string[];
  unlinkLimit: number;
}): Promise<UnlinkRow[]> {
  const { mainClient, dead5, dead30, billingBins, unlinkLimit } = params;

  if (billingBins.length === 0) {
    if (dead5.length === 0) return [];
    const r = await mainClient.query<{ bank: string | null; bin: string | null; cnt: string }>(
      `WITH limited AS (
         SELECT
           bank,
           CASE
             WHEN bank = 'stellarcards' AND LENGTH(card_number::text) < 6 THEN 'unknown'
             ELSE LEFT(card_number::text, 6)
           END AS bin
         FROM public.bank_cards
         WHERE profile_name = ANY($1::text[])
           AND (bank = ANY($2::text[]) OR bank = 'stellarcards')
           AND NOT is_bad
         LIMIT $3
       )
       SELECT bank, bin, COUNT(*)::text AS cnt
       FROM limited
       GROUP BY bank, bin
       ORDER BY bank, bin`,
      [dead5, ['ecards', 'adscards', 'multicards'], unlinkLimit],
    );
    return r.rows.map((row) => ({
      bank: row.bank ?? null,
      bin: row.bin ?? null,
      cnt: parseInt(row.cnt, 10) || 0,
    }));
  }

  const rows: Array<{ bank: string | null; bin: string | null; cnt: number }> = [];

  if (dead5.length > 0) {
    const r5 = await mainClient.query<{ bank: string | null; bin: string | null; cnt: string }>(
      `WITH limited AS (
         SELECT
           bank,
           CASE
             WHEN bank = 'stellarcards' AND LENGTH(card_number::text) < 6 THEN 'unknown'
             ELSE LEFT(card_number::text, 6)
           END AS bin
         FROM public.bank_cards
         WHERE profile_name = ANY($1::text[])
           AND (
             bank = ANY($2::text[])
             OR (bank = 'stellarcards' AND LEFT(card_number::text, 6) <> ALL($3::text[]))
           )
           AND NOT is_bad
         LIMIT $4
       )
       SELECT bank, bin, COUNT(*)::text AS cnt
       FROM limited
       GROUP BY bank, bin
       ORDER BY bank, bin`,
      [dead5, ['ecards', 'adscards', 'multicards'], billingBins, unlinkLimit],
    );
    rows.push(
      ...r5.rows.map((row) => ({
        bank: row.bank ?? null,
        bin: row.bin ?? null,
        cnt: parseInt(row.cnt, 10) || 0,
      })),
    );
  }

  if (dead30.length > 0) {
    const r30 = await mainClient.query<{ bank: string | null; bin: string | null; cnt: string }>(
      `WITH limited AS (
         SELECT
           bank,
           CASE
             WHEN bank = 'stellarcards' AND LENGTH(card_number::text) < 6 THEN 'unknown'
             ELSE LEFT(card_number::text, 6)
           END AS bin
         FROM public.bank_cards
         WHERE profile_name = ANY($1::text[])
           AND bank = 'stellarcards'
           AND LEFT(card_number::text, 6) = ANY($2::text[])
           AND NOT is_bad
         LIMIT $3
       )
       SELECT bank, bin, COUNT(*)::text AS cnt
       FROM limited
       GROUP BY bank, bin
       ORDER BY bank, bin`,
      [dead30, billingBins, unlinkLimit],
    );
    rows.push(
      ...r30.rows.map((row) => ({
        bank: row.bank ?? null,
        bin: row.bin ?? null,
        cnt: parseInt(row.cnt, 10) || 0,
      })),
    );
  }

  // объединяем по (bank, bin)
  const m = new Map<string, UnlinkRow>();
  for (const r of rows) {
    const key = `${r.bank ?? 'unknown'}|${r.bin ?? ''}`;
    const prev = m.get(key);
    if (prev) prev.cnt += r.cnt;
    else m.set(key, { bank: r.bank, bin: r.bin, cnt: r.cnt });
  }

  // Применяем общий лимит unlinkDeadWorker (slice до unlinkLimit) на уровне строк невозможно корректно без исходного списка,
  // поэтому здесь считаем "верхнюю оценку" по группам в рамках лимитов на ветки. Это совпадает с вашим SQL-подходом.
  return Array.from(m.values()).sort((a, b) => (a.bank ?? '').localeCompare(b.bank ?? '') || (a.bin ?? '').localeCompare(b.bin ?? ''));
}

async function getFreeNowByBankBin(mainClient: PoolClient): Promise<FreeRow[]> {
  const r = await mainClient.query<{ bank: string; bin: string; cnt: string }>(
    `SELECT bank,
            CASE
              WHEN bank = 'stellarcards' AND LENGTH(card_number::text) < 6 THEN 'unknown'
              ELSE LEFT(card_number::text, 6)
            END AS bin,
            COUNT(*)::text AS cnt
     FROM public.bank_cards
     WHERE (buyer IS NULL OR buyer = '')
       AND (profile_name IS NULL OR profile_name = '')
       AND NOT is_bad
       AND ${ACC_NO_FARM}
     GROUP BY bank, CASE
              WHEN bank = 'stellarcards' AND LENGTH(card_number::text) < 6 THEN 'unknown'
              ELSE LEFT(card_number::text, 6)
            END
     ORDER BY bank, bin`,
  );
  return r.rows.map((row) => ({
    bank: row.bank,
    bin: row.bin,
    cnt: parseInt(row.cnt, 10) || 0,
  }));
}

export interface FarmNewGeoReportResult {
  message: string;
  cutoffTomorrow00: Date;
  rowsCount: number;
  blocks?: unknown[];
}

export async function generateFarmNewGeoReport(): Promise<FarmNewGeoReportResult> {
  const config = getConfig();
  const db = getDatabaseService(config);

  const cutoffTomorrow00 = tomorrowMidnightServer();
  const defaultDays = Math.max(1, Math.floor(config.unlinkDead.defaultDays));
  const stellarcardsDays = Math.max(1, Math.floor(config.unlinkDead.stellarcardsDays));
  const billingBins = (config.unlinkDead.billingBins ?? []).filter(Boolean);
  const unlinkLimit = 2000;

  const deadCutoff5 = new Date(cutoffTomorrow00.getTime() - defaultDays * 24 * 60 * 60 * 1000);
  const deadCutoff30 = new Date(cutoffTomorrow00.getTime() - stellarcardsDays * 24 * 60 * 60 * 1000);

  const farmClient = await db.getClient('farm');
  const mainClient = await db.getClient('main');
  try {
    const [dead5, dead30] = await Promise.all([
      getDeadProfilesByCutoff(farmClient, deadCutoff5),
      billingBins.length > 0 ? getDeadProfilesByCutoff(farmClient, deadCutoff30) : Promise.resolve([]),
    ]);

    const [freeNow, willUnlink] = await Promise.all([
      getFreeNowByBankBin(mainClient),
      getWillUnlinkByBankBin({ mainClient, dead5, dead30, billingBins, unlinkLimit }),
    ]);

    const freeMap = new Map<string, number>();
    for (const r of freeNow) {
      freeMap.set(`${r.bank}|${r.bin}`, r.cnt);
    }
    const unlinkMap = new Map<string, number>();
    for (const r of willUnlink) {
      const bank = (r.bank ?? 'unknown').toLowerCase();
      const bin = r.bin ?? '';
      unlinkMap.set(`${bank}|${bin}`, r.cnt);
    }

    const keys = new Set<string>([...freeMap.keys(), ...unlinkMap.keys()]);
    const rows = Array.from(keys)
      .map((k) => {
        const [bank, bin] = k.split('|');
        return {
          bank,
          bin,
          freeNow: freeMap.get(k) ?? 0,
          willUnlink: unlinkMap.get(k) ?? 0,
        };
      })
      .sort((a, b) => a.bank.localeCompare(b.bank) || a.bin.localeCompare(b.bin));

    let totalFreeNow = 0;
    let totalWillUnlink = 0;
    for (const r of rows) {
      totalFreeNow += r.freeNow;
      totalWillUnlink += r.willUnlink;
    }

    // Для slack_app таблица и заголовок передаются через blocks,
    // текстовое поле message используем только как технический placeholder.
    const message = 'Доступные карты для фарма';

    const title = 'Доступные карты для фарма';
    const headerText = title;
    const blocks: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: headerText, emoji: true },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Всего свободных карт: *${totalFreeNow}*, освободится завтра: *${totalWillUnlink}*.`,
          },
        ],
      },
    ];

    if (rows.length > 0) {
      const headerRow = [
        { type: 'raw_text', text: 'bank' },
        { type: 'raw_text', text: 'BIN' },
        { type: 'raw_text', text: 'свободно сейчас' },
        { type: 'raw_text', text: 'освободится завтра' },
      ];

      blocks.push({
        type: 'table',
        column_settings: [
          { is_wrapped: true },
          { is_wrapped: true },
          { align: 'right' },
          { align: 'right' },
        ],
        rows: [
          headerRow,
          ...rows.map((row) => [
            { type: 'raw_text', text: row.bank },
            { type: 'raw_text', text: row.bin },
            {
              type: 'raw_text',
              text: row.freeNow > 0 ? String(row.freeNow) : '—',
            },
            {
              type: 'raw_text',
              text: row.willUnlink > 0 ? String(row.willUnlink) : '—',
            },
          ]),
        ],
      });
    }

    return {
      message,
      cutoffTomorrow00,
      rowsCount: rows.length,
      blocks,
    };
  } finally {
    farmClient.release();
    mainClient.release();
  }
}

async function runOnce(): Promise<void> {
  const config = getConfig();
  const db = getDatabaseService(config);
  const correlationId = createCorrelationId();

  const { message, cutoffTomorrow00, rowsCount, blocks } = await generateFarmNewGeoReport();

  const dayKey = cutoffTomorrow00.toISOString().slice(0, 10); // YYYY-MM-DD завтрашнего дня
  const dedupKey = `slack:farm-new-geo:${dayKey}`;

  await db.withTransaction('main', async (client) => {
    await enqueueOutgoingNotification(client, {
      channel: 'slack:#farm-new-geo',
      payload: { kind: 'farm_new_geo_report', message, ...(blocks ? { blocks } : {}) },
      dedupKey,
      correlationId,
    });
  });

  logger.info('FarmNewGeoReportWorker: report enqueued', { dayKey, rows: rowsCount });
}

export async function startFarmNewGeoReportWorker(): Promise<WorkerHandle> {
  let stopped = false;
  let lastRunDate = '';

  const checkAndRun = (): void => {
    if (stopped) return;
    const now = new Date();
    const todayKey = now.toDateString();

    // 05:00 server time
    if (now.getHours() !== 5 || now.getMinutes() !== 0) return;
    if (lastRunDate === todayKey) return;
    lastRunDate = todayKey;

    runOnce().catch((err) => {
      logger.error('FarmNewGeoReportWorker run error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const intervalId = setInterval(checkAndRun, CHECK_INTERVAL_MS);
  checkAndRun();

  return {
    async stop() {
      stopped = true;
      clearInterval(intervalId);
    },
  };
}

