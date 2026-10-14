/**
 * In-memory кеш ответа `GET /api/queue/status` (TTL 60 с).
 * Снижает нагрузку на БД при частом опросе клиентами (например расширением).
 * Инвалидация — при любых мутациях очереди / учётных данных, влияющих на статус.
 */

const TTL_MS = 60_000;

let generation = 0;
const entries = new Map<
  string,
  {
    generation: number;
    expiresAt: number;
    payload: QueueStatusResponseItem[];
  }
>();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Элемент тела ответа `GET /api/queue/status` (после маппинга в роуте). */
export type QueueStatusResponseItem = {
  bank: string;
  acc_no: string;
  name: string;
  status: string;
  phone_online: boolean;
  release_at?: string;
  balance?: number;
  currency?: string;
  info?: string;
  info_at?: string;
  info_buyer?: string;
  login?: string;
  password?: string;
  extra?: string;
};

/** Сбросить кеш для всех пользователей (новая «эпоха» + очистка Map). */
export function invalidateQueueStatusCache(): void {
  generation += 1;
  entries.clear();
}

export function getQueueStatusCache(email: string): QueueStatusResponseItem[] | null {
  const key = normalizeEmail(email);
  const e = entries.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt || e.generation !== generation) {
    entries.delete(key);
    return null;
  }
  return e.payload;
}

export function setQueueStatusCache(email: string, payload: QueueStatusResponseItem[]): void {
  const key = normalizeEmail(email);
  entries.set(key, {
    generation,
    expiresAt: Date.now() + TTL_MS,
    payload,
  });
}

export const QUEUE_STATUS_CACHE_TTL_MS = TTL_MS;
