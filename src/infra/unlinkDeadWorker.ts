/**
 * Отвязка карт от отработанных профилей (phase_id=4, stage_id=1, давно не обновлялись).
 * Запускается по расписанию в полночь (локальное время).
 * Для карт без is_bad: сначала блокировка у провайдера (как blockCardByCardNumber), затем снятие профиля в DB.
 * Если провайдер недоступен — строку bank_cards не меняем: профиль остаётся привязанным, на следующем запуске снова попытка блокировки.
 * Аудит: bank_card_blocked при успешной блокировке; card_unlinked для остальных обработанных; при skip из‑за ошибки ПС событие не шлём.
 * Slack в outgoing_notifications.
 * Аудит: user_email = bank_cards.buyer или "system@groscloud.com"; в атрибутах — полные profile_name и card_number.
 */

import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../config/index.js';
import { getDatabaseService } from './index.js';
import { createCorrelationId } from './correlation/index.js';
import { enqueueOutgoingNotification } from './outgoingNotifications.js';
import { logger } from './logger.js';
import { setCardOwnership } from './cardOwnership.js';
import { updateWorkerStatus } from './runtimeStatus.js';
import { extractAffIdFromGroupName } from '../modules/transactions/adapters/ecards/cards.js';
import { getBuyerFromBinom } from '../modules/binom/index.js';
import { getTransactionsAdapter } from '../modules/transactions/adapters/index.js';
import type { BankId } from '../modules/transactions/types.js';

const CHECK_INTERVAL_MS = 60 * 1000; // проверка раз в минуту
const UNLINK_LIMIT = 2000;

type WorkerHandle = { stop: () => Promise<void> };

interface CardToUnlink {
  card_number: string;
  bank: string | null;
  profile_name: string | null;
  buyer: string | null;
  is_bad: boolean;
  acc_no: string | null;
  ext_id: string | null;
}

async function blockCardAtProvider(card: CardToUnlink): Promise<void> {
  const bank = (card.bank ?? 'ecards').toLowerCase();
  const profileName = card.profile_name ?? '';
  logger.info('UnlinkDeadWorker: provider blockCard starting', {
    card_number: card.card_number,
    bank,
    profile_name: profileName,
    ext_id_present: card.ext_id != null && card.ext_id !== '',
  });
  const adapter = getTransactionsAdapter(bank as BankId);
  if (adapter?.blockCard == null) {
    throw new Error(`Bank "${bank}" has no blockCard on the adapter`);
  }
  const parsed = parseInt(String(card.card_number).replace(/\D/g, ''), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error('Invalid card_number');
  }
  if (bank !== 'ecards' && (card.ext_id == null || card.ext_id === '')) {
    throw new Error('ext_id is required for this payment system');
  }
  await adapter.blockCard({ cardNumber: parsed, extId: card.ext_id });
  logger.info('UnlinkDeadWorker: provider blockCard succeeded', {
    card_number: card.card_number,
    bank,
    profile_name: profileName,
  });
}

function getBin(cardNumber: string): string {
  const s = String(cardNumber).replace(/\D/g, '');
  return s.length >= 6 ? s.slice(0, 6) : s;
}

/**
 * Мёртвые профили: phase_id=4, stage_id=1 (refund), в этом статусе >= days суток.
 * Используем tbl_statuses_log (дата перехода в refund), а НЕ tbl_statuses.updated_at.
 * tbl_statuses.updated_at — дата обновления строки справочника, общая для всех профилей
 * с этим статусом; при переходе профиля в refund она не меняется.
 * tbl_statuses_log фиксирует каждый переход: триггер при смене status_id в tbl_profiles
 * пишет запись с created_at = момент перехода.
 */
async function getDeadProfiles(farmClient: PoolClient, days: number): Promise<string[]> {
  const daysSafe = Math.max(1, Math.floor(days));
  const r = await farmClient.query<{ name: string }>(
    `SELECT tprof.name FROM tbl_profiles tprof
     INNER JOIN tbl_statuses ts ON ts.id = tprof.status_id
     INNER JOIN (
       SELECT tsl.profile_id, MAX(tsl.created_at) AS entered_refund_at
       FROM tbl_statuses_log tsl
       INNER JOIN tbl_statuses ts_new ON ts_new.id = tsl.status_new
       WHERE ts_new.phase_id = 4 AND ts_new.stage_id = 1
       GROUP BY tsl.profile_id
     ) last_refund ON last_refund.profile_id = tprof.id
     WHERE ts.phase_id = 4 AND ts.stage_id = 1
       AND last_refund.entered_refund_at <= NOW() - make_interval(days => $1::int)`,
    [daysSafe],
  );
  return r.rows.map((row) => row.name);
}

/** Статистика карт, доступных для фарма (profile_name IS NULL, buyer IS NULL, acc_no FEBRUARY/farm). */
async function getAvailableCardsStats(
  mainClient: PoolClient,
): Promise<Array<{ bank: string; bin: string; count: number }>> {
  const r = await mainClient.query(
    `SELECT bc.bank, LEFT(bc.card_number::text, 6) AS bin, COUNT(*)::int AS cnt
     FROM public.bank_cards bc
     WHERE bc.profile_name IS NULL
       AND (bc.buyer IS NULL OR bc.buyer = '')
       AND bc.last_used_at IS NULL
       AND ((LOWER(bc.acc_no) LIKE '%farm%' OR bc.acc_no = 'FEBRUARY' OR bc.acc_no = 'Для БИНа 450897 с общим балансом') AND bc.acc_no NOT LIKE '%/%')
     GROUP BY bc.bank, LEFT(bc.card_number::text, 6)
     ORDER BY bc.bank, bin`,
  );
  return r.rows.map((row) => ({
    bank: row.bank || 'unknown',
    bin: row.bin || '',
    count: Number(row.cnt) || 0,
  }));
}

function formatSlackMessage(
  unlinked: Array<{ card_number: string; bank: string | null; profile_name: string }>,
  stats: Array<{ bank: string; bin: string; count: number }>,
): string {
  const lines: string[] = [];
  if (unlinked.length > 0) {
    const byBankBin = new Map<string, number>();
    for (const c of unlinked) {
      const bank = c.bank || 'ecards';
      const bin = getBin(c.card_number);
      const key = `${bank} БИН ${bin}`;
      byBankBin.set(key, (byBankBin.get(key) || 0) + 1);
    }
    for (const [key, count] of byBankBin) {
      const binPart = key.replace(/.*БИН /, '');
      const bankPart = key.replace(/ БИН .*/, '');
      const totalForBin = stats.find((s) => s.bank === bankPart && s.bin === binPart)?.count ?? 0;
      lines.push(`${key}: освобождено ${count} карт, доступно для фарма: ${totalForBin} карт`);
    }
  }
  const totalAvailable = stats.reduce((acc, s) => acc + s.count, 0);
  lines.push('', `Всего доступно для фарма: ${totalAvailable} карт`);
  const byBank = new Map<string, Array<{ bin: string; count: number }>>();
  for (const s of stats) {
    if (!byBank.has(s.bank)) byBank.set(s.bank, []);
    byBank.get(s.bank)!.push({ bin: s.bin, count: s.count });
  }
  const BANKS_WITH_BINS = ['ecards', 'adscards', 'stellarcards'];
  for (const bank of Array.from(byBank.keys()).sort()) {
    const bins = byBank.get(bank)!;
    const total = bins.reduce((a, b) => a + b.count, 0);
    if (BANKS_WITH_BINS.includes(bank) && bins.length <= 25) {
      for (const { bin, count } of bins.sort((a, b) => a.bin.localeCompare(b.bin))) {
        lines.push(`  ${bank} БИН ${bin}: ${count}`);
      }
    } else {
      lines.push(`  ${bank}: ${total} карт`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : `Доступно для фарма: ${totalAvailable} карт`;
}

/** Один запуск отвязки: farm + main в двух клиентах. */
async function runUnlinkDead(): Promise<void> {
  const config = getConfig();
  const db = getDatabaseService(config);
  const { defaultDays, stellarcardsDays, billingBins } = config.unlinkDead;
  const billingBinsArr = billingBins.length > 0 ? billingBins : [];

  const farmClient = await db.getClient('farm');
  const mainClient = await db.getClient('main');
  try {
    updateWorkerStatus('unlinkDead', {
      lastRunAt: new Date().toISOString(),
      lastBatchCount: 0,
      lastError: undefined,
    });
    const deadProfiles5 = await getDeadProfiles(farmClient, defaultDays);
    const needDead30 = billingBinsArr.length > 0;
    const deadProfiles30 = needDead30 ? await getDeadProfiles(farmClient, stellarcardsDays) : [];
    const deadProfileNames = [...new Set([...deadProfiles5, ...deadProfiles30])];

    if (deadProfileNames.length === 0) {
      const stats = await getAvailableCardsStats(mainClient);
      const slackMsg = formatSlackMessage([], stats);
      await enqueueSlackOnly(mainClient, slackMsg);
      logger.info('UnlinkDeadWorker: no dead profiles', { stats: stats.length });
      updateWorkerStatus('unlinkDead', {
        lastRunAt: new Date().toISOString(),
        lastBatchCount: 0,
      });
      return;
    }

    let cards: CardToUnlink[];
    if (billingBinsArr.length === 0) {
      cards =
        deadProfiles5.length > 0
          ? (
              await mainClient.query<CardToUnlink>(
                `SELECT card_number::text AS card_number, bank, profile_name, buyer, COALESCE(is_bad, false) AS is_bad, acc_no, ext_id::text AS ext_id
                 FROM public.bank_cards
                 WHERE profile_name = ANY($1::text[])
                   AND (bank = ANY($2::text[]) OR (bank = 'stellarcards'))
                 LIMIT $3`,
                [deadProfiles5, ['ecards', 'adscards', 'multicards'], UNLINK_LIMIT],
              )
            ).rows
          : [];
    } else {
      const [r5, r30] = await Promise.all([
        deadProfiles5.length > 0
          ? mainClient.query<CardToUnlink>(
              `SELECT card_number::text AS card_number, bank, profile_name, buyer, COALESCE(is_bad, false) AS is_bad, acc_no, ext_id::text AS ext_id
               FROM public.bank_cards
               WHERE profile_name = ANY($1::text[])
                 AND (bank = ANY($2::text[])
                   OR (bank = 'stellarcards' AND LEFT(card_number::text, 6) != ALL($3::text[])))
               LIMIT $4`,
              [deadProfiles5, ['ecards', 'adscards', 'multicards'], billingBinsArr, UNLINK_LIMIT],
            )
          : { rows: [] as CardToUnlink[] },
        deadProfiles30.length > 0
          ? mainClient.query<CardToUnlink>(
              `SELECT card_number::text AS card_number, bank, profile_name, buyer, COALESCE(is_bad, false) AS is_bad, acc_no, ext_id::text AS ext_id
               FROM public.bank_cards
               WHERE profile_name = ANY($1::text[]) AND bank = 'stellarcards'
                 AND LEFT(card_number::text, 6) = ANY($2::text[])
               LIMIT $3`,
              [deadProfiles30, billingBinsArr, UNLINK_LIMIT],
            )
          : { rows: [] as CardToUnlink[] },
      ]);
      cards = [...r5.rows, ...r30.rows].slice(0, UNLINK_LIMIT);
    }

    if (cards.length === 0) {
      const stats = await getAvailableCardsStats(mainClient);
      await enqueueSlackOnly(mainClient, formatSlackMessage([], stats));
      logger.info('UnlinkDeadWorker: no cards to unlink', { dead_profiles: deadProfileNames.length });
      updateWorkerStatus('unlinkDead', {
        lastRunAt: new Date().toISOString(),
        lastBatchCount: 0,
      });
      return;
    }

    const correlationId = createCorrelationId();

    const markedCardNumbers = new Set<string>();
    const blockedAtProviderCardNumbers = new Set<string>();
    const blockSkippedCardNumbers = new Set<string>();
    const retiredAt = new Date();

    await db.withTransaction('main', async (client) => {
      for (const card of cards) {       
        if (!card.is_bad) continue;
        const affId = extractAffIdFromGroupName(card.acc_no);
        const buyerEmail = affId != null ? await getBuyerFromBinom(client, affId) : null;
        if (buyerEmail) {
          await setCardOwnership(client, {
            cardNumber: parseInt(card.card_number, 10),
            bank: card.bank ?? 'ecards',
            buyer: buyerEmail,
            profileName: null,
            is_buying: true,
          });
          await enqueueOutgoingNotification(client, {
            channel: 'slack:dm',
            payload: {
              message: `Карта номер ${card.card_number} платёжной системы ${card.bank ?? 'ecards'} теперь ваша`,
              email: buyerEmail,
            },
            dedupKey: `slack:unlink_dead_is_bad:${card.card_number}:${buyerEmail}:${new Date().toISOString().slice(0, 16)}`,
            correlationId,
            recipient: buyerEmail,
          });
        } else {
          await setCardOwnership(client, {
            cardNumber: parseInt(card.card_number, 10),
            bank: card.bank ?? 'ecards',
            buyer: null,
            profileName: null,
            is_buying: false,
            is_bad: true,
            lastUsedAt: retiredAt,
          });
          markedCardNumbers.add(card.card_number);
        }
      }
    });

    for (const card of cards) {
      if (card.is_bad) continue;

      try {
        await blockCardAtProvider(card);
      } catch (e) {
        logger.warn('UnlinkDeadWorker: provider blockCard failed, leaving profile linked for retry on next run', {
          card_number: card.card_number,
          bank: card.bank,
          profile_name: card.profile_name,
          error: e instanceof Error ? e.message : String(e),
        });
        blockSkippedCardNumbers.add(card.card_number);
        continue;
      }

      blockedAtProviderCardNumbers.add(card.card_number);
      const accNo = `blocked at ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;

      await db.withTransaction('main', async (client) => {
        await setCardOwnership(client, {
          cardNumber: parseInt(card.card_number, 10),
          bank: card.bank ?? 'ecards',
          buyer: null,
          profileName: null,
          is_buying: false,
          is_bad: true,
          lastUsedAt: retiredAt,
        });
        await client.query(
          `UPDATE public.bank_cards
           SET acc_no = $1
           WHERE card_number = $2::bigint AND bank = $3`,
          [accNo, card.card_number, (card.bank ?? 'ecards').toLowerCase()],
        );
        markedCardNumbers.add(card.card_number);
      });
    }
    const timeBucket = new Date().toISOString().slice(0, 16);

    for (const card of cards) {
      if (!card.is_bad && blockSkippedCardNumbers.has(card.card_number)) continue;

      const wasMarked = markedCardNumbers.has(card.card_number);
      const blockedAtProvider = blockedAtProviderCardNumbers.has(card.card_number);
      const userEmail = (card.buyer?.trim() || 'system@groscloud.com').slice(0, 256);
      const eventType = blockedAtProvider ? ('bank_card_blocked' as const) : ('card_unlinked' as const);
      const auditPayload = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        division: 'finance' as const,
        user_email: userEmail,
        log_type: 'info' as const,
        severity: 1,
        event_type: eventType,
        event_attributes: {
          profile_name: card.profile_name ?? '',
          card_number: card.card_number,
          bank: card.bank ?? '',
          source: 'unlink_dead',
          marked_out_of_circulation: wasMarked,
          last_used_at: wasMarked ? retiredAt.toISOString() : null,
          blocked_at_provider: blockedAtProvider,
        },
        correlation_id: correlationId,
      };
      const dedupAudit = `audit:unlink_dead:${card.card_number}:${timeBucket}`;
      await enqueueOutgoingNotification(mainClient, {
        channel: 'mqtt:sequoia/audit',
        payload: auditPayload,
        dedupKey: dedupAudit,
        correlationId,
      });

    }

    const stats = await getAvailableCardsStats(mainClient);
    const slackCards = cards.filter((c) => c.is_bad || !blockSkippedCardNumbers.has(c.card_number));
    const slackMsg = formatSlackMessage(
      slackCards.map((c) => ({ card_number: c.card_number, bank: c.bank, profile_name: c.profile_name ?? '' })),
      stats,
    );
    await enqueueSlackOnly(mainClient, slackMsg);

    const processedCount = cards.length - blockSkippedCardNumbers.size;
    logger.info('UnlinkDeadWorker: processed cards for dead profiles', {
      count: cards.length,
      processed_after_block_or_is_bad: processedCount,
      block_skipped_pending_ps: blockSkippedCardNumbers.size,
      dead_profiles: deadProfileNames.length,
    });
    updateWorkerStatus('unlinkDead', {
      lastRunAt: new Date().toISOString(),
      lastBatchCount: processedCount,
    });
  } finally {
    farmClient.release();
    mainClient.release();
  }
}

async function enqueueSlackOnly(mainClient: PoolClient, message: string): Promise<void> {
  const timeBucket = new Date().toISOString().slice(0, 16);
  const dedupSlack = `slack:unlink_dead:farm_otp:${timeBucket}`;
  await enqueueOutgoingNotification(mainClient, {
    channel: 'slack:#farm-otp',
    payload: { kind: 'unlink_dead_summary', message },
    dedupKey: dedupSlack,
    correlationId: createCorrelationId(),
  });
}

export async function startUnlinkDeadWorker(): Promise<WorkerHandle> {
  let stopped = false;
  let lastRunDate: string = '';

  const checkAndRun = (): void => {
    if (stopped) return;
    const now = new Date();
    const today = now.toDateString();
    if (now.getHours() !== 0 || now.getMinutes() !== 0) return;
    if (lastRunDate === today) return;
    lastRunDate = today;
    runUnlinkDead().catch((err) => {
      logger.error('UnlinkDeadWorker run error', { error: err instanceof Error ? err.message : String(err) });
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
