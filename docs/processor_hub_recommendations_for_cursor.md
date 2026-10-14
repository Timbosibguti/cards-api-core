# Processor-Hub — рекомендации CTO по доведению до целевого состояния

> Цель документа: зафиксировать конкретные инженерные рекомендации для **modular monolith**, который должен обеспечивать **безупречный журнал операций, идемпотентность, корректную работу в нескольких инстансах и полную реконструкцию действий сотрудников**.
>
> Контекст проекта: в архитектуре уже есть сильные опоры — `incoming_transactions`, `outbox_events`, `queue`, `drafts`, `statement_import_jobs`, `bank_cards_history`, `AuditService`, MQTT-хендлеры, `SELECT ... FOR UPDATE SKIP LOCKED`, отдельные модули `transactions`, `otp`, `bank_queue`, `statements_import`, `audit`. Именно это и нужно теперь довести до системного стандарта.

**Статус (Priority 1):** созданы три документа: [module_boundaries.md](./module_boundaries.md), [idempotency_policy.md](./idempotency_policy.md), [state_machines.md](./state_machines.md). Решение зафиксировано в [decisions_log.md](./decisions_log.md). Дальнейшие шаги — внедрение границ в коде, transition guards, интеграционные тесты (см. чек-листы в конце документа).

---

## 1. Executive summary

Текущий путь с **монолитом** считаю правильным для запуска. Распиливать систему на сервисы сейчас не нужно. Вместо этого нужно целенаправленно довести её до формы **modular monolith** с жёсткими внутренними границами и операционной дисциплиной.

Главная задача не в том, чтобы сделать «красивую архитектуру», а в том, чтобы получить систему, где:

1. **любая операция реконструируется задним числом полностью**;
2. **любой входящий сигнал обрабатывается идемпотентно**;
3. **несколько инстансов не создают дублей и гонок**;
4. **OTP и транзакции склеиваются детерминированно и объяснимо**;
5. **финансовый отдел и SRE за 30 секунд понимают, где застрял кейс**.

Иными словами: для этого проекта критичны не микросервисы и не ledger, а:

- **transaction journal**;
- **audit trail**;
- **state machine**;
- **idempotency**;
- **concurrency control**;
- **операционная наблюдаемость**.

---

## 2. Архитектурная позиция

### Что считаем правильным

- Оставляем **монолит** как единый deployable unit.
- Поддерживаем запуск в **нескольких инстансах**.
- Не внедряем «полноценный бухгалтерский ledger», если задача системы — не расчёт пользовательских остатков, а **надёжная фиксация действий сотрудников, OTP и транзакций**.
- Усиливаем уже существующий паттерн:
  - `incoming_transactions` как входной журнал;
  - `outbox_events` как гарантированная доставка исходящих событий;
  - `queue` как управление владением банковским слотом;
  - `drafts` как bounded matching для pre-transaction/OTP;
  - `statement_import_jobs` как асинхронный ingestion;
  - `bank_cards_history` как историчность владения;
  - `audit` как слой реконструкции действий.

### Что считаем недопустимым

- размытые модульные границы внутри монолита;
- доступ в «любые таблицы отовсюду»;
- скрытая логика статусов без формального жизненного цикла;
- повторная обработка одинаковых входящих событий;
- расхождение между тем, что сделал сотрудник, что приняла система и что подтвердил внешний провайдер;
- невозможность восстановить кейс постфактум.

---

## 3. Целевое определение системы

Processor-Hub нужно трактовать как:

> **операционный fintech orchestration core**

То есть это не бухгалтерская система и не простой webhook-агрегатор. Это ядро, которое:

- принимает входящие события;
- соотносит их с операционным контекстом;
- двигает состояние кейса;
- уведомляет нужных сотрудников;
- фиксирует всё так, чтобы спустя дни и недели можно было доказуемо восстановить цепочку событий.

Отсюда следуют обязательные свойства:

- детерминированные переходы состояний;
- идемпотентная обработка;
- конкурентная безопасность при нескольких инстансах;
- неизменяемая история фактов;
- минимизация «магии» в matching-логике.

---

## 4. Рекомендации по внутренней структуре modular monolith

### 4.1. Зафиксировать доменные модули как жёсткие bounded contexts

Внутри монолита нужны **строгие внутренние контексты**, а не просто папки.

Рекомендую считать официальными следующие модули:

- `transactions`
- `otp`
- `bank_queue`
- `drafts`
- `statements_import`
- `cards`
- `notifications`
- `audit`
- `identity/correlation`
- `provider_adapters`

Для каждого модуля должны быть:

- свой `README.md`;
- список owned-таблиц;
- список публичных use case / service entry points;
- список запрещённых прямых зависимостей.

### 4.2. Ввести правило ownership для таблиц

Каждая ключевая таблица должна иметь **одного владельца-модуля**.

Пример:

| Таблица | Владелец |
|---|---|
| `incoming_transactions` | `transactions` |
| `outbox_events` | `notifications` / `integration_core` |
| `queue` | `bank_queue` |
| `drafts` | `drafts` |
| `statement_import_jobs` | `statements_import` |
| `bank_cards_history` | `cards` |
| `audit` | `audit` |
| `bank_transactions` | `transactions` |
| `sms_devices` | `otp` / `device_registry` |

**Правило:** изменение записи в owned-таблице должно происходить только через сервис владельца.

### 4.3. Запретить произвольный SQL из чужих модулей

Если модуль `otp` хочет изменить сущность из `queue`, он не должен сам писать SQL в `queue`. Он должен вызвать публичный сервис/порт `bank_queue`.

Это даст:

- предсказуемые инварианты;
- более дешёвый будущий распил;
- меньше скрытых side effects;
- легче ревьюить бизнес-логику.

### 4.4. Убрать организационный дрейф и дубль-нейминг

Уже виден drift вроде `statementsImport` vs `statements_import`. Это надо закрыть сейчас.

Нужны правила:

- модуль — один canonical name;
- имя таблицы, папки, worker-а и docs должны совпадать по терминологии;
- все новые сущности проходят через naming review.

---

## 5. Идемпотентность как базовый закон системы

### 5.1. Любой входящий сигнал должен иметь dedup strategy

Это относится ко всему:

- SMS/OTP;
- webhooks провайдеров;
- MQTT-сообщения;
- statement import;
- ручные действия сотрудников;
- переотправка уведомлений;
- ownership change;
- подтверждение транзакции.

Для каждого типа входа должна быть явно описана схема:

- **что является business key**;
- **что является idempotency key**;
- **сколько живёт dedup window**;
- **что делать при duplicate**.

### 5.2. Хранить idempotency policy в документации и коде

Нужно завести единый документ, например `docs/idempotency_policy.md`, где по каждой операции будет таблица:

| Operation | Business key | Idempotency key | Window | Duplicate behavior |
|---|---|---|---|---|
| bank OTP ingest | bank + acc_no + otp + bucket | `otp:bank:acc:otp:bucket` | 5–15 min | ignore / link existing |
| statement import | file hash / storage ref | explicit import key | 24h+ | return existing job |
| queue acquire | bank + acc_no + actor | request id + unique lock path | request lifetime | no duplicate slot |
| notification send | channel + payload hash | dedup key | short TTL | do not resend |
| transaction confirm | provider ext_id / bank ext_id | stable key | forever | upsert existing |

### 5.3. Использовать два уровня защиты

#### Уровень 1 — прикладной

- расчёт `idempotency_key`;
- проверка существующего факта;
- явная ветка `duplicate_detected`.

#### Уровень 2 — на БД

- `UNIQUE` индексы;
- `INSERT ... ON CONFLICT ...`;
- частичные индексы, где требуется;
- запрет на доверие только памяти процесса.

### 5.4. Duplicate не должен считаться ошибкой уровня incident

Duplicate — это **ожидаемое поведение** в распределённой системе. Его надо не бояться, а корректно обрабатывать.

Система должна:

- спокойно переживать повторную доставку;
- возвращать существующий результат или no-op;
- писать понятный аудит-событие типа `duplicate_ignored`, `duplicate_linked`, `job_already_exists`.

---

## 6. Concurrency control для нескольких инстансов

### 6.1. Зафиксировать классы операций по риску гонок

Есть разные уровни риска:

#### Критичные

- `queue acquire/release`;
- исходящая отправка OTP/notification;
- обработка `statement_import_jobs`;
- выбор следующего pending event/job;
- смена владельца карты;
- подтверждение транзакции по external id.

#### Средние

- обновление статусов девайсов;
- refresh кэшей;
- вторичные синки.

Для критичных операций нужна формальная стратегия блокировки.

### 6.2. Стандартизировать паттерн worker lock

Там, где уже используется `SELECT ... FOR UPDATE SKIP LOCKED`, надо объявить это **официальным стандартом**.

Пример правила:

1. выбрать пачку `pending` задач `FOR UPDATE SKIP LOCKED`;
2. сразу перевести в `processing/sending`;
3. зафиксировать `worker_id`, `started_at`, `attempt`;
4. по завершении перевести в terminal state или backoff state;
5. обязательно иметь reclaim logic для зависших `processing`.

### 6.3. Добавить lease/heartbeat для долгих задач

Для задач, которые могут зависнуть из-за падения инстанса:

- `processing_started_at`;
- `lease_expires_at`;
- `processing_owner`;
- механизм safe requeue, если lease истёк.

Иначе multi-instance не спасает: задача может «навсегда остаться processing».

### 6.4. Queue ownership должен быть атомарным и объяснимым

Для `queue` цель простая:

- в один момент времени у банковского слота должен быть **один владелец**;
- продление, освобождение и повторный захват должны быть формализованы;
- любой конфликт должен быть виден в аудите.

Нужно явно оформить доменные события:

- `bank_queue_acquired`
- `bank_queue_extended`
- `bank_queue_released`
- `bank_queue_acquire_denied`
- `bank_queue_expired`

### 6.5. Не допускать side effect до фиксации ownership/state

Если операция отправляет уведомление, дергает внешний API или публикует MQTT — сначала должен быть **зафиксирован локальный факт**, что именно этот worker взял задачу в работу.

Принцип:

> сначала атомарно фиксируем локальное право выполнить действие, потом делаем side effect.

---

## 7. State machine вместо скрытой статусной магии

### 7.1. У каждой сущности с жизненным циклом должна быть явная state machine

Минимум для следующих сущностей:

- `drafts`
- `statement_import_jobs`
- `outgoing_notifications`
- `incoming_transactions`
- `bank_transactions`
- `queue`
- `card ownership change` workflow

### 7.2. Описывать не только статусы, но и допустимые переходы

Недостаточно хранить `status TEXT`. Нужна формальная карта:

#### Пример: `statement_import_jobs`

- `pending`
- `processing`
- `processed`
- `failed`
- `dead_letter` (рекомендую добавить)

Допустимые переходы:

- `pending -> processing`
- `processing -> processed`
- `processing -> failed`
- `failed -> pending` (retry)
- `failed -> dead_letter`

#### Пример: `outgoing_notifications`

- `pending`
- `sending`
- `sent`
- `failed`
- `cancelled`

#### Пример: `drafts`

- `pending`
- `confirmed`
- `expired`
- `cancelled` (если возможна ручная отмена)

### 7.3. Запретить “прыжки” через статусы

Переходы должны валидироваться в одном месте. Нельзя, чтобы разные части кода произвольно писали `status='sent'` или `status='processed'`.

Рекомендация:

- создать transition service/guard для каждой stateful-сущности;
- аудит писать на каждый переход.

### 7.4. Разделить business status и technical status

У одной сущности часто есть два разных измерения:

- бизнес-смысл (`confirmed`, `matched`, `expired`);
- техническая обработка (`processing`, `retrying`, `failed_delivery`).

Не стоит смешивать их в одно поле, если это ломает читаемость. Лучше два поля, чем один статус-помойка.

---

## 8. Безупречный журнал операций

### 8.1. Нужен единый transaction journal, а не только набор таблиц

Даже без ledger системе нужен **единый операционный журнал фактов**.

Подход:

- каждая значимая операция получает `operation_id`;
- все связанные события содержат:
  - `operation_id`
  - `correlation_id`
  - `actor`
  - `source`
  - `subject` (transaction, queue slot, card, draft, sms, statement job)
  - `event_type`
  - `occurred_at`
  - `payload_snapshot` / `diff`

Если отдельной таблицы `operation_journal` пока нет — можно начать с дисциплины поверх `audit`, но стратегически лучше иметь явный слой журнала фактов.

### 8.2. Аудит должен быть не декоративным, а расследовательским

Аудит обязан отвечать на вопросы:

- кто это сделал;
- когда;
- из какого канала;
- с каким request id / correlation id;
- с каким payload;
- какое состояние было до;
- какое стало после;
- какой внешний ответ получили;
- была ли операция ретраем/дублем.

### 8.3. События аудита нормализовать по шаблону

Рекомендую единый формат поля события:

```json
{
  "eventType": "bank_otp_received",
  "operationId": "...",
  "correlationId": "...",
  "actor": {
    "type": "employee|system|provider|device",
    "id": "...",
    "email": "..."
  },
  "subject": {
    "type": "queue|transaction|draft|statement_job|card|sms",
    "id": "..."
  },
  "source": {
    "channel": "http|mqtt|worker|manual|provider_webhook",
    "name": "..."
  },
  "before": {},
  "after": {},
  "metadata": {},
  "occurredAt": "..."
}
```

### 8.4. Сохранять полные ключевые идентификаторы, а не только человекочитаемый текст

Плохо:

- “OTP отправлен баеру”

Хорошо:

- `queue_owner_email`
- `bank`
- `acc_no`
- `otp_hash/otp_masked`
- `notification_id`
- `dedup_key`
- `operation_id`
- `correlation_id`

### 8.5. Аудит должен содержать и no-op сценарии

Нужно писать не только успехи, но и такие факты:

- duplicate ignored;
- acquire denied;
- release noop;
- no matching queue found;
- OTP parsed but not routed;
- statement row unmatched;
- provider callback stale;
- event rejected by invariant.

Именно это делает систему расследуемой.

---

## 9. Полная реконструкция действий сотрудника

### 9.1. Ввести понятие case timeline

Для финансового отдела и SRE нужен не просто список таблиц, а **единый timeline кейса**.

По любому инциденту система должна уметь собрать хронологию:

1. сотрудник взял банковский слот;
2. пришёл OTP;
3. OTP был маршрутизирован;
4. был создан draft / pre-transaction;
5. поступила выписка / callback;
6. транзакция сопоставлена;
7. уведомление отправлено;
8. ownership карты изменён;
9. кейс завершился success / failure / manual review.

### 9.2. Для каждого action сотрудника фиксировать intent и result

Например, сотрудник нажал acquire.

Нужно сохранить:

- кто нажал;
- что хотел получить;
- по какому объекту;
- что система ответила;
- был ли конфликт;
- какой state transition произошёл.

То есть журнал должен содержать **не только итог**, но и **намерение**.

### 9.3. Привязать все действия к actor identity

Необходим единый стандарт actor-полей:

- `actor_type`: `employee | system | provider | device`
- `actor_id`
- `actor_email`
- `actor_team` / `actor_role` при наличии

Без этого расследования быстро становятся ручными и дорогими.

### 9.4. Сделать восстановление кейса отдельным use case

Реконструкция не должна быть “аналитик вручную лазит по пяти таблицам”.

Нужен отдельный use case/endpoint уровня:

- `GET /cases/:id/timeline`
- или `CaseTimelineService.build(...)`

Источники:

- `audit`
- `incoming_transactions`
- `outbox_events`
- `queue`
- `drafts`
- `bank_transactions`
- `statement_import_jobs`
- `bank_cards_history`

---

## 10. OTP-контур: рекомендации

OTP — центральный операционный нерв системы. Здесь нужна максимальная строгость.

### 10.1. OTP должен жить как отдельный доменный поток

Не как “просто SMS”, а как доменный процесс:

- приём;
- парсинг;
- нормализация;
- поиск контекста;
- dedup;
- маршрутизация;
- уведомление;
- аудит;
- кейс-линковка.

### 10.2. Разделить raw SMS, parsed OTP и routed OTP

Нужно различать три уровня факта:

1. **raw received** — получили сырой текст;
2. **parsed** — извлекли `bank`, `otp`, `phone_to`, `card_number`, `amount`, `currency`;
3. **routed** — нашли очередь / адресата и поставили нотификацию;
4. **delivered** — нотификация реально ушла;
5. **consumed/linked** — OTP был связан с конкретным кейсом, если применимо.

Это желательно отражать либо отдельными событиями, либо отдельными полями состояния.

### 10.3. OTP должен иметь bounded matching

Ты уже правильно идёшь к этому через `drafts`, `time_bucket`, TTL и bounded matching.

Рекомендация:

- не матчить OTP с «чем угодно когда-нибудь»;
- все связи должны быть ограничены окном времени;
- при выходе за окно — только `manual_review`, но не автоматический матч.

### 10.4. Маскировать OTP в человекочитаемых логах, но сохранять техническую пригодность

Рекомендую:

- в аудит/UI — masked OTP;
- для dedup и matching — hash или отдельное защищённое поле;
- полный OTP не разносить по логам и Slack без необходимости.

---

## 11. Транзакционный контур: рекомендации

### 11.1. Подтверждение транзакции должно быть однонаправленным и объяснимым

Для подтверждения транзакции нужен единый flow:

1. пришёл внешний факт (`statement row`, callback, provider event);
2. нормализовали;
3. вычислили стабильный business key;
4. проверили duplicate;
5. попытались матчить с `drafts`;
6. если не нашли — используем формально описанный fallback;
7. зафиксировали результат;
8. записали аудит.

### 11.2. Fallback matching должен быть минимально магическим

Если используется `aff_id -> binom` или другой fallback, он должен быть:

- явно описан в docs;
- прозрачно логирован;
- отмечен как `fallback_matched`, а не как обычное совпадение;
- пригоден для ручного расследования.

### 11.3. Разделять confirmed, matched, imported, posted

Частая ошибка — называть одним словом разные вещи.

Нужно различать:

- **imported** — строка попала в систему;
- **matched** — строка соотнесена с кейсом;
- **confirmed** — признана валидным подтверждением операции;
- **posted/finalized** — прошла конечную фиксацию в доменной модели.

---

## 12. Outbox / incoming: довести до системного стандарта

### 12.1. Incoming journal — это не просто staging

`incoming_transactions` должен рассматриваться как **входной журнал фактов**, а не временная таблица.

Нужно хранить:

- сырой payload;
- normalized payload;
- source type;
- received_at;
- dedup key;
- processing status;
- processing attempts;
- last_error;
- linked entity ids.

### 12.2. Outbox — единая точка всех внешних side effects

Все исходящие действия желательно вести через единый outbox-like механизм, в том числе:

- MQTT publish;
- Slack/DM;
- provider callbacks/retries;
- внутренние интеграционные события.

Это даст:

- повторяемость;
- retry discipline;
- доставляемость;
- расследуемость.

### 12.3. У каждой outbox-записи должны быть terminal и retry semantics

Нужно определить:

- `max_attempts`;
- backoff;
- retry-after support;
- когда задача уходит в `failed`;
- когда — в `dead_letter`;
- кто и как её реанимирует.

---

## 13. Тестовая стратегия, без которой multi-instance опасен

Сейчас для такого проекта особенно важны **интеграционные тесты на поведение**, а не только unit-тесты.

### 13.1. Обязательные integration suites

Нужно покрыть как минимум:

1. **incoming worker lifecycle**
2. **outgoing worker lifecycle**
3. **queue acquire/release race**
4. **duplicate OTP ingestion**
5. **duplicate statement import**
6. **two workers pick one job**
7. **lease expiry and requeue**
8. **card ownership history invariants**
9. **fallback match vs direct match**
10. **audit completeness for critical flow**

### 13.2. Отдельные race-condition tests

Нужны тесты, где два параллельных потока:

- одновременно пытаются взять один queue slot;
- одновременно подтверждают одну транзакцию;
- одновременно обрабатывают один OTP;
- одновременно отправляют один notification job.

Acceptance criteria: ровно один победитель, второй — корректный no-op/duplicate branch.

### 13.3. Golden-path и ugly-path тесты

Для каждой критичной цепочки нужны обе категории:

- happy path;
- broken path;
- duplicate path;
- stale path;
- timeout path;
- manual review path.

---

## 14. Наблюдаемость, нужная финансовому отделу и SRE

### 14.1. Не только логи, но и операционные представления

Нужны готовые view/query/service endpoints:

- зависшие `processing` jobs;
- queue slots с истёкшим lease;
- unmatched statement rows;
- OTP parsed but not routed;
- repeated duplicate events;
- notifications failed / dead_letter;
- операции без завершённого terminal state.

### 14.2. Стандартизировать correlation

Во всех слоях должен проходить один и тот же набор полей:

- `request_id`
- `correlation_id`
- `operation_id`
- `causation_id` (если есть цепочка событий)
- `actor_id`

Без этого multi-instance отладка будет дорогой.

### 14.3. Метрики, которые обязательны

Минимальный набор:

- duplicate rate по типам событий;
- OTP parse success rate;
- OTP route success rate;
- queue acquire conflict rate;
- average statement import latency;
- stuck processing count;
- retry count by worker type;
- dead-letter count;
- unmatched transaction count;
- audit gap count (если реализовать валидатор полноты).

---

## 15. Что нужно сделать в кодовой базе в первую очередь

Ниже — практический порядок, в котором это стоит реализовывать.

### Priority 1 — обязательный фундамент

#### 1. Зафиксировать module ownership и правила зависимостей

Сделать документ:

- `docs/module_boundaries.md`

В нём для каждого модуля описать:

- owned tables;
- public services;
- запрещённые прямые зависимости;
- canonical naming.

#### 2. Зафиксировать idempotency policy

Сделать документ:

- `docs/idempotency_policy.md`

И привязать его к реальным `UNIQUE` индексам и прикладному коду.

#### 3. Зафиксировать state machines

Сделать документ:

- `docs/state_machines.md`

Описать переходы для:

- `drafts`
- `statement_import_jobs`
- `outgoing_notifications`
- `incoming_transactions`
- `bank_transactions`
- `queue`

#### 4. Усилить аудит до расследовательского стандарта

Проверить, что критичные use case пишут:

- actor
- subject
- before/after
- operation/correlation ids
- result/no-op reason

#### 5. Добавить reclaim/requeue semantics для processing jobs

Везде, где есть воркерная обработка, убедиться, что после падения инстанса задача не зависает навсегда.

### Priority 2 — стабилизация multi-instance поведения

#### 6. Написать concurrency/race integration tests

Особенно для:

- queue acquire;
- OTP ingestion;
- statement import jobs;
- outgoing delivery.

#### 7. Ввести dead-letter для безнадёжных задач

Чтобы не терять случаи, которые нельзя обработать автоматически.

#### 8. Выделить единый `CaseTimelineService`

Чтобы по кейсу получать собранную хронологию.

#### 9. Нормализовать incoming/outbox schemas

Убедиться, что у них единая модель retry/attempt/status/error/owner/lease.

### Priority 3 — удобство эксплуатации и будущий рост

#### 10. Module-level README во всех критичных модулях

#### 11. Canonical naming cleanup

#### 12. Виджеты/эндпоинты для финансового отдела и SRE

#### 13. Автоматический валидатор audit completeness для критичных flows

---

## 16. Рекомендованные инварианты, которые надо защищать кодом и БД

### Queue

- у `(bank, acc_no)` не может быть двух активных владельцев одновременно;
- release чужого слота невозможен;
- expired slot не считается активным;
- acquire/reacquire пишут аудит всегда.

### Drafts

- у каждого `kind` свой уникальный ключ;
- истёкший draft не может автоматически матчиться;
- confirmed draft не должен повторно подтверждаться другой операцией;
- matching всегда bounded по времени.

### Bank transactions

- один внешний `ext_id` не может создавать несколько подтверждённых доменных фактов;
- fallback match обязан явно маркироваться;
- duplicate import не создаёт новый факт.

### Outgoing notifications

- одна и та же дедуп-операция не отправляется повторно;
- `sent` достигается только после фактического подтверждения отправки;
- зависшие `sending` подлежат reclaim.

### Card ownership

- в один момент времени карта имеет одного владельца;
- история смен владельца непрерывна и не имеет пересечений;
- смена ownership всегда порождает запись в history и аудит.

---

## 17. Как понять, что цель достигнута

Система считается доведённой до нужного уровня, если выполняются следующие критерии.

### Архитектурные критерии

- монолит остаётся единым deployable unit;
- у каждого модуля есть formal ownership;
- нет скрытого SQL в чужие таблицы;
- state machine описаны и соблюдаются.

### Операционные критерии

- duplicate events не ломают систему;
- два инстанса не делают один и тот же side effect дважды;
- зависшие задачи requeue-ятся безопасно;
- любой OTP-кейс и transaction-кейс можно реконструировать по timeline.

### Финансовые критерии

- любой спорный кейс восстанавливается без ручного “копания вслепую”;
- видно, кто совершил действие и что система на это ответила;
- OTP и транзакции прослеживаются от получения до финального исхода;
- unmatched, duplicate, fallback и failed cases явно выделены.

### Эксплуатационные критерии

- есть integration tests на гонки и повторы;
- есть dashboards/queries для stuck jobs, dead letters, conflicts, unmatched events;
- аудит достаточно полный для расследований.

---

## 18. Итоговая рекомендация для Cursor

Ниже — краткая формулировка задачи для реализации.

### Формулировка

Нужно **не распиливать Processor-Hub на сервисы**, а довести его до состояния **строгого modular monolith** с фокусом на:

1. **module boundaries**;
2. **idempotency by design**;
3. **multi-instance safe concurrency**;
4. **formal state machines**;
5. **investigation-grade audit trail**;
6. **case timeline reconstruction**.

### Практическая цель

После доработки система должна гарантировать:

- один и тот же входящий сигнал можно безопасно получить повторно;
- любой worker crash не приводит к необратимому зависанию кейса;
- ни один OTP и ни одна транзакция не “теряются в воздухе”;
- финансовый отдел может доказуемо восстановить весь путь кейса;
- текущий монолит остаётся быстрым для разработки, но уже готов к будущему безопасному распилу по модулям.

---

## 19. Конкретный backlog для реализации

### Epic A — Module boundaries

- [ ] Создать `docs/module_boundaries.md`
- [ ] Для каждого модуля описать owned tables и public services
- [ ] Убрать прямой доступ в чужие таблицы из критичных модулей
- [ ] Зафиксировать canonical naming и убрать drift

### Epic B — Idempotency

- [ ] Создать `docs/idempotency_policy.md`
- [ ] Для каждого critical flow описать business key / idempotency key / duplicate behavior
- [ ] Проверить `UNIQUE` индексы и `ON CONFLICT`
- [ ] Добавить audit events для duplicate/no-op веток

### Epic C — State machines

- [ ] Создать `docs/state_machines.md`
- [ ] Формализовать переходы для `drafts`, `queue`, `statement_import_jobs`, `outgoing_notifications`, `bank_transactions`
- [ ] Вынести transition guards в явные сервисы

### Epic D — Worker safety

- [ ] Стандартизировать `FOR UPDATE SKIP LOCKED` pattern
- [ ] Добавить `processing_owner`, `lease_expires_at`, reclaim logic
- [ ] Ввести `dead_letter` для задач, не прошедших обработку

### Epic E — Audit & timeline

- [ ] Усилить `AuditService` до стандарта before/after + actor + ids
- [ ] Реализовать `CaseTimelineService`
- [ ] Добавить расследовательские queries/views для фин. отдела и SRE

### Epic F — Integration tests

- [ ] Race tests для queue acquire
- [ ] Duplicate OTP tests
- [ ] Duplicate statement import tests
- [ ] Two workers / one job tests
- [ ] Reclaim after crash tests
- [ ] Audit completeness tests

---

## 20. Финальная позиция

Стратегия проекта здравая:

- **монолит на запуске — это правильно**;
- **мультиинстансность — это правильно**;
- **ledger здесь действительно не является первоочередной необходимостью**;
- **главный актив системы — это безупречная фиксация фактов, OTP и действий сотрудников**.

Поэтому основной инженерный фокус должен быть не на “распиле”, а на следующем:

> сделать так, чтобы Processor-Hub был модульным внутри, детерминированным по поведению, устойчивым к дублям и гонкам, и полностью пригодным для расследования любого кейса.

Если это будет сделано, то монолит станет не временным компромиссом, а **сильным управляемым ядром**, которое позже можно будет безопасно разделять по границам домена.
