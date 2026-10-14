import type { PoolClient } from 'pg';

/** Префикс `acc_no`, который выставляет хаб после успешной блокировки у ПС (`blockCard.ts`, unlink-dead). */
export const BANK_CARD_BLOCKED_AT_PREFIX = 'blocked at ';

export interface BankCardRowForBlock {
  bank: string;
  card_number: string;
  ext_id: string | null;
  profile_name: string | null;
  buyer: string | null;
}

export type BankCardBlockHubFlags = { is_bad: boolean; acc_no: string | null };

/** Карта уже помечена заблокированной хабом (не дергать ПС повторно). */
export function isBankCardAlreadyBlockedByHub(row: BankCardBlockHubFlags): boolean {
  if (!row.is_bad) return false;
  const acc = row.acc_no?.trim() ?? '';
  return acc.toLowerCase().startsWith(BANK_CARD_BLOCKED_AT_PREFIX.toLowerCase());
}

/** Дата/время из `acc_no` вида `blocked at YYYY-MM-DD HH:MM:SS` → `DD.MM.YYYY HH:MM:SS` для сообщения пользователю. */
export function formatBlockedAtForUserMessage(accNo: string | null): string {
  if (accNo == null || accNo === '') return '';
  const trimmed = accNo.trim();
  const lower = BANK_CARD_BLOCKED_AT_PREFIX.toLowerCase();
  if (!trimmed.toLowerCase().startsWith(lower)) return trimmed;
  const raw = trimmed.slice(BANK_CARD_BLOCKED_AT_PREFIX.length).trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2}:\d{2})/);
  if (m) {
    const [, y, mo, d, time] = m;
    return `${d}.${mo}.${y} ${time}`;
  }
  return raw;
}

/** Текст для колонки `error` в очереди блокировки (без вызова ПС). */
export function buildAlreadyBlockedHubQueueMessage(row: BankCardBlockHubFlags): string {
  const when = formatBlockedAtForUserMessage(row.acc_no);
  const suffix = when ? ` ${when}` : '';
  return `Карта уже была заблокирована${suffix}`;
}

function normalizeCardNumberDigits(input: string | number): string {
  return String(input).replace(/\D/g, '');
}


export async function lookupBankCardForBlock(
  client: PoolClient,
  cardNumberInput: string | number,
): Promise<BankCardRowForBlock | null> {
  const digits = normalizeCardNumberDigits(cardNumberInput);
  if (!digits) return null;

  const res = await client.query<{
    bank: string;
    card_number: string;
    ext_id: string | null;
    profile_name: string | null;
    buyer: string | null;
  }>(
    `SELECT bank::text,
            card_number::text,
            ext_id,
            profile_name::text,
            buyer::text
     FROM public.bank_cards
     WHERE card_number = $1::bigint
     LIMIT 1`,
    [digits],
  );

  const row = res.rows[0];
  if (!row) return null;

  return {
    bank: row.bank,
    card_number: row.card_number,
    ext_id: row.ext_id,
    profile_name: row.profile_name,
    buyer: row.buyer,
  };
}
