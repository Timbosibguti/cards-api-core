# Processor-Hub — автоматы состояний (state machines)

Формальное описание **статусов** и **допустимых переходов** для сущностей с жизненным циклом.  
Источник: [processor_hub_recommendations_for_cursor.md](./processor_hub_recommendations_for_cursor.md) §7.

**Правило:** переходы должны выполняться в одном месте (transition guard / сервис). Запрещены произвольные записи `status = '...'` из разных частей кода без единой точки валидации.

**Реализация:** модуль `src/infra/stateTransitions.ts` — константы допустимых переходов (INCOMING_ALLOWED, OUTBOX_ALLOWED, OUTGOING_ALLOWED), функции set*Status*/set*Reclaim*/set*StuckToFailed. Воркеры и StuckProcessingJob вызывают только эти функции (см. processingRuntime/index.ts).

---

## 1. incoming_transactions

| Статус | Описание |
|--------|----------|
| `pending` | Запись принята, ждёт обработки |
| `processing` | Воркер взял в работу (FOR UPDATE SKIP LOCKED) |
| `processed` | Успешно обработано (upsert в bank_transactions, outgoing) |
| `failed` | Исчерпаны попытки (StuckProcessingJob) или обработка вернула ошибку |

**Допустимые переходы:**

- `pending` → `processing` (воркер при взятии)
- `processing` → `processed` (успех)
- `processing` → `failed` (ошибка или превышен processing_attempts)
- `processing` → `pending` (reclaim: StuckProcessingJob по таймауту, attempts < max)
- `processing` → `failed` (reclaim: attempts >= max)

**Поля:** processing_started_at, processed_at, processing_attempts. Reclaim — см. StuckProcessingJob, config processingRuntime.

---

## 2. outbox_events

| Статус | Описание |
|--------|----------|
| `pending` | Событие в очереди |
| `processing` | Воркер обрабатывает (диспетчер по event_type) |
| `processed` | Обработка завершена успешно |
| `failed` | Обработчик выбросил ошибку (после попытки) |

**Допустимые переходы:**

- `pending` → `processing` (воркер при взятии)
- `processing` → `processed` (успех processOutboxEvent)
- `processing` → `failed` (исключение в processOutboxEvent)
- `processing` → `pending` (reclaim: StuckProcessingJob, attempts < max)
- `processing` → `failed` (reclaim: attempts >= max)

**Поля:** processing_started_at, processed_at, processing_attempts.

---

## 3. outgoing_notifications

| Статус | Описание |
|--------|----------|
| `pending` | В очереди на отправку |
| `sending` | Воркер отправил запрос (MQTT/Slack) |
| `sent` | Доставка подтверждена (только после успешного ответа) |
| `failed` | attempts >= max_attempts |
| `rate_limited` | HTTP 429, retry после Retry-After |

**Допустимые переходы:**

- `pending` → `sending` (воркер при отправке)
- `sending` → `sent` (успех)
- `sending` → `pending` (reclaim: StuckProcessingJob по таймауту — запись снова подхватится)
- `sending` → `pending` с next_retry_at (ошибка, attempts < max)
- `sending` → `failed` (attempts >= max_attempts)
- `sending` → `rate_limited` (при 429, опционально)
- `rate_limited` → `pending` (после next_retry_at)

**Инвариант:** статус `sent` выставляется только после фактического подтверждения доставки (код в processingRuntime).

---

## 4. drafts

| Статус | Описание |
|--------|----------|
| `pending` | Черновик создан, ждёт подтверждения/матча |
| `confirmed` | Подтверждён (сопоставлен с транзакцией/операцией) |
| `expired` | Истёк TTL (expires_at) |

**Допустимые переходы:**

- (создание) → `pending`
- `pending` → `confirmed` (matching / подтверждение)
- `pending` → `expired` (по времени или явная пометка)

Рекомендация из doc: при необходимости ручной отмены — статус `cancelled` и переход `pending` → `cancelled`. Пока в схеме только pending | confirmed | expired.

---

## 5. statement_import_jobs

| Статус | Описание |
|--------|----------|
| `pending` | Задача создана |
| `processing` | Воркер обрабатывает |
| `processed` | Импорт завершён успешно |
| `failed` | Ошибка обработки |

**Допустимые переходы:**

- (создание) → `pending`
- `pending` → `processing` (воркер взял задачу)
- `processing` → `processed` (успех)
- `processing` → `failed` (ошибка)
- `failed` → `pending` (retry, если будет реализовано)

**dead_letter:** добавлен в схему (миграция `20260306_statement_import_jobs_dead_letter.sql`). Переход `failed` → `dead_letter` — вручную или будущей логикой (повторные неудачи).

---

## 6. queue (банковский слот)

Состояние слота задаётся полями резервации (reserved_by, expires_at и т.п.), а не единым полем status. Операции:

- **acquire:** слот свободен → занят текущим актором (lease/expires_at).
- **release:** слот занят этим актором → свободен.
- **extend:** продление lease.
- **expire:** StuckProcessingJob или таймер — слот с истёкшим lease считается свободным.

Доменные события (рекомендация): bank_queue_acquired, bank_queue_released, bank_queue_extended, bank_queue_acquire_denied, bank_queue_expired. Аудит на каждый переход.

---

## 7. bank_transactions

Жизненный цикл — через нормализацию и upsert (ON CONFLICT). Отдельного поля «status» в текущей схеме может не быть; факт «подтверждён» задаётся наличием записи и связью с buyer/profile_name. При появлении явного статуса (imported / matched / confirmed / posted) — описать переходы здесь и в коде в одном месте.

---

## 8. dev_inbox_events (dev simulation)

Таблица используется только при включённом dev-контуре (`config.devSimulation.enabled`). События инжектируются через API или фикстуры и обрабатываются DevInboxWorker → Dispatcher → те же прикладные сервисы, что и в проде.

| Статус | Описание |
|--------|----------|
| `pending` | Событие добавлено, ждёт обработки |
| `processing` | DevInboxWorker взял в работу (FOR UPDATE SKIP LOCKED) |
| `processed` | Диспетчер успешно вызвал сервис(ы) |
| `failed` | Обработка вернула ошибку (error сохраняется в поле error) |

**Допустимые переходы:**

- (создание) → `pending`
- `pending` → `processing` (воркер при взятии)
- `processing` → `processed` (успех dispatchDevInboxEvent)
- `processing` → `failed` (исключение в диспетчере)

Спецификация: [processor_hub_dev_simulation_spec.md](./processor_hub_dev_simulation_spec.md). Reclaim/stuck job для dev_inbox_events в текущей реализации не предусмотрен (достаточно ручного разбора failed).

---

## 9. Card ownership (смена владельца)

Не таблица-автомат, а инвариант истории:

- В любой момент у карты **один** активный интервал в `bank_cards_history` (valid_to IS NULL).
- Допустимые «переходы»: закрыть текущий интервал (valid_to = NOW()) + вставить новый (valid_from = NOW(), valid_to = NULL) в **одной транзакции**. Только через setCardOwnership / единый сервис владения.

---

## Дальнейшие шаги

- Вынести проверку переходов в явные guard-функции или transition-сервис.
- Писать аудит на каждый переход (event_type = status_transition, before/after).
- При добавлении новых статусов (например dead_letter) — обновить миграции и этот документ.

См. также [module_boundaries.md](./module_boundaries.md), [idempotency_policy.md](./idempotency_policy.md).
