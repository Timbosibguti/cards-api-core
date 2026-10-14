/**
 * Реестр инцидентов (`ops_incidents`): единая точка записи «какой сервис / когда / что случилось».
 */

export type IncidentSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface RecordIncidentParams {
  /** Логический источник: `processor-hub`, `outgoing_worker`, `stellarcards_adapter`, … */
  source: string;
  /** Тип события: `queue_depth`, `http_4xx`, `delivery_failed`, … */
  kind: string;
  severity?: IncidentSeverity;
  /** Короткий текст для человека и алертов. */
  summary: string;
  /** Произвольный контекст (банк, http_status, счётчики, …). */
  detail?: Record<string, unknown>;
  correlation_id?: string | null;
  /** Если задан — повторная запись с тем же ключом не создаёт новую строку (dedup). */
  dedup_key?: string | null;
  /** По умолчанию NOW(). */
  occurred_at?: Date;
}

export interface RecordIncidentResult {
  /** id новой строки; `null`, если сработал dedup (конфликт по dedup_key). */
  id: number | null;
}
