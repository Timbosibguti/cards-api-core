/**
 * Backoff для retry исходящих уведомлений (architecture_overview 6.2).
 * Лестница: 1, 2, 4, 8, 16, 30 минут; далее cap 30 мин.
 */

const BACKOFF_MINUTES = [1, 2, 4, 8, 16, 30] as const;
const CAP_INDEX = BACKOFF_MINUTES.length - 1;

/**
 * Возвращает дату следующей попытки отправки (от текущего момента).
 * attempts — уже выполненное число попыток (0 = первая неудача).
 */
export function getNextRetryAt(attempts: number): Date {
  const index = Math.min(Math.max(0, attempts), CAP_INDEX);
  const minutes = BACKOFF_MINUTES[index];
  return new Date(Date.now() + minutes * 60 * 1000);
}
