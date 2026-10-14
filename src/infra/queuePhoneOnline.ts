import type { BankStatusItem } from './queueDb.js';
import { getConfig } from '../config/index.js';
import { getDatabaseService } from './index.js';

/** Устройство считаем «не в сети» для приёма OTP, если свежесть ниже этого порога (минуты). */
export const PHONE_ONLINE_THRESHOLD_MINUTES = 2;

export type BankStatusWithPhoneOnline = BankStatusItem & { phone_online: boolean };

function minimalBankStatusItem(bank: string, accNo: string): BankStatusItem {
  return {
    bank,
    acc_no: accNo,
    name: '',
    status: 'free',
    release_at: null,
    balance: null,
    currency: null,
    info: null,
    info_at: null,
    info_buyer: null,
    login: null,
    password: null,
    extra: null,
  };
}

/**
 * Проверка перед `POST /api/queue/acquire`: тот же расчёт `phone_online`, что и для `GET /api/queue/status`.
 * `not_found` — нет строки в `bank_accounts` (как при acquire без аккаунта).
 */
export async function getPhoneOnlineForQueueAcquire(
  bank: string,
  accNo: string,
): Promise<'ok' | 'not_found' | 'offline'> {
  const db = getDatabaseService(getConfig());
  const client = await db.getClient('main');
  try {
    const ex = await client.query(
      `SELECT 1 FROM public.bank_accounts WHERE bank = $1 AND acc_no = $2 LIMIT 1`,
      [bank, accNo],
    );
    if (ex.rows.length === 0) return 'not_found';
  } finally {
    client.release();
  }

  const [enriched] = await enrichBankStatusWithPhoneOnline([minimalBankStatusItem(bank, accNo)]);
  return enriched.phone_online ? 'ok' : 'offline';
}

/**
 * Для `ota_devices` флаг считается только по `sim_last_network_at` (не `updated_at` — heartbeat идёт без сотовой сети).
 */
export async function enrichBankStatusWithPhoneOnline(
  items: BankStatusItem[]
): Promise<BankStatusWithPhoneOnline[]> {
  if (items.length === 0) return [];

  const banks = items.map((i) => i.bank);
  const accNos = items.map((i) => i.acc_no);

  const db = getDatabaseService(getConfig());
  const client = await db.getClient('main');
  try {
    const result = await client.query<{ bank: string; acc_no: string; phone_online: boolean }>(
      `SELECT
         ba.bank,
         ba.acc_no,
         CASE
           WHEN NULLIF(regexp_replace(COALESCE(ba.phone::text, ''), '[^0-9]', '', 'g'), '') IS NULL THEN FALSE
           WHEN od.imei IS NOT NULL THEN (
             od.sim_last_network_at IS NOT NULL
             AND od.sim_last_network_at >= NOW() - ($3::int * INTERVAL '1 minute')
           )
           WHEN sd.imei IS NOT NULL THEN (
             sd.updated_at >= NOW() - ($3::int * INTERVAL '1 minute')
           )
           ELSE FALSE
         END AS phone_online
       FROM unnest($1::text[], $2::text[]) AS keys(bank, acc_no)
       INNER JOIN public.bank_accounts ba ON ba.bank::text = keys.bank AND ba.acc_no = keys.acc_no
       LEFT JOIN LATERAL (
         SELECT od_inner.imei, od_inner.sim_last_network_at
         FROM public.ota_devices od_inner
         WHERE od_inner.phone = (
           NULLIF(regexp_replace(COALESCE(ba.phone::text, ''), '[^0-9]', '', 'g'), '')
         )::bigint
         ORDER BY od_inner.updated_at DESC
         LIMIT 1
       ) od ON TRUE
       LEFT JOIN LATERAL (
         SELECT sd_inner.imei, sd_inner.updated_at
         FROM public.sms_devices sd_inner
         WHERE od.imei IS NULL
           AND EXISTS (
             SELECT 1
             FROM unnest(sd_inner.phones) AS phone_el
             WHERE regexp_replace(phone_el, '[^0-9]', '', 'g')
               = NULLIF(regexp_replace(COALESCE(ba.phone::text, ''), '[^0-9]', '', 'g'), '')
           )
         ORDER BY sd_inner.updated_at DESC
         LIMIT 1
       ) sd ON TRUE`,
      [banks, accNos, PHONE_ONLINE_THRESHOLD_MINUTES]
    );

    const map = new Map<string, boolean>();
    for (const row of result.rows) {
      map.set(`${row.bank}\0${row.acc_no}`, row.phone_online);
    }

    return items.map((item) => ({
      ...item,
      phone_online: map.get(`${item.bank}\0${item.acc_no}`) ?? false,
    }));
  } finally {
    client.release();
  }
}
