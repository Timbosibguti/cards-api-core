## EP1 T1.3 — Базовый `AuditService`

### Цель

Реализовать `AuditService`, который пишет события в `audit_events` и, опционально, дублирует их в MQTT‑топик `sequoia/audit`.

### Требования

- **Структура события (AuditEventPayload):**
  - `id: uuid` (генерируется при отсутствии);
  - `timestamp: string` (ISO8601 UTC);
  - `division: string`;
  - `user_email: string`;
  - `log_type: 'info' | 'log' | 'error' | 'warning'`;
  - `severity: number` (0–5);
  - `event_type: string`;
  - `event_attributes?: object`;
  - `correlation_id?: string`.

- **Хранение:**
  - Таблица `audit_events` (в соответствии с архитектурой):
    ```sql
    INSERT INTO audit_events (id, timestamp, division, user_email, log_type, severity, event_type, event_attributes, correlation_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9);
    ```
  - Схема по умолчанию (как в `audit`/`mqtt_*` проектах) — уточнить в миграциях `migrations/*.sql`.

- **Интерфейс:**
  - `writeAudit(event: Partial<AuditEventPayload> & RequiredCoreFields): Promise<void>`.
  - Заполнение дефолтов (id, timestamp).
  - Прокидывание `correlation_id` из текущего контекста.

- **MQTT‑публикация:**
  - Опционально: дублировать событие в `sequoia/audit` через `MqttClient` (envelope по Event Contract).
  - Ошибки MQTT не должны ломать запись в БД (side-effect only).

### Acceptance criteria

- Лёгкий интерфейс для всех модулей: один вызов `writeAudit` вместо ручных INSERT’ов.
- События корректно появляются в `audit_events` и (при включённой опции) в `sequoia/audit`.

