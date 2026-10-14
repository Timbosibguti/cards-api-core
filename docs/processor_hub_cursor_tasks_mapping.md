# Разложение задач Cursor Tasks по файлам и эпикам

Сопоставление [processor_hub_cursor_tasks.md](./processor_hub_cursor_tasks.md) с текущей реализацией: статус, эпик, файлы для правок, конкретные шаги.

---

## P0 – Critical Tasks

### 1. Card Ownership Domain

| Поле | Значение |
|------|----------|
| **Статус** | Частично сделано (реализована своя модель, не буквально `card_ownership_history` из задачи) |
| **Эпик** | **EPIC 8** (Card Ownership Domain Consolidation) |
| **Уже есть** | `bank_cards_history`, `setCardOwnership`, один активный интервал на карту, все смены через cardOwnership.ts |

**Оставшиеся шаги (EPIC 8):**

| # | Действие | Файлы |
|---|----------|--------|
| 1 | Вынести единый **CardOwnershipService** (доменный слой): запрос «кто владел в момент X», все операции владения только через него | **Создать:** `src/modules/cards/CardOwnershipService.ts` (или `src/infra/CardOwnershipService.ts`). **Менять:** `src/infra/cardOwnership.ts` → вызывается из сервиса; `src/infra/cardsDb.ts`, `src/infra/profileAuthChangeWorker.ts`, `src/infra/unlinkDeadWorker.ts`, `src/api/routes/cards.ts` — обращаться к сервису, не к cardOwnership напрямую (или оставить фасад в cardOwnership и сервис оборачивает его). |
| 2 | Транзакции ссылаются на «ownership snapshot» при нормализации | `src/modules/transactions/index.ts`, `src/modules/transactions/normalize.ts` — при разрешении buyer/profile_name вызывать CardOwnershipService (владелец на момент операции), не только чтение из bank_cards. |
| 3 | Документировать инварианты и использование истории в расследованиях | `docs/state_machines.md` (§8), при необходимости ADR или раздел в architecture_overview. |

---

### 2. Event Correlation System

| Поле | Значение |
|------|----------|
| **Статус** | Готово |
| **Эпик** | — |
| **Уже есть** | `correlation_id` в incoming_transactions, outbox_events, outgoing_notifications, envelope, аудит; `src/infra/correlation/index.ts` (createCorrelationId, ключи). |

**Дополнительно (по желанию):**

| # | Действие | Файлы |
|---|----------|--------|
| 1 | Гарантировать наличие correlation_id во всех логах по операциям | `src/infra/logger.ts` — при необходимости добавлять correlation в контекст; вызовы logger в воркерах и роутах передают correlation_id где есть. |

---

### 3. Concurrency Safety

| Поле | Значение |
|------|----------|
| **Статус** | Готово |
| **Эпик** | — |
| **Уже есть** | FOR UPDATE SKIP LOCKED (incoming, outbox, outgoing, statement_import_jobs), idempotency_key/dedup_key, ON CONFLICT в bank_transactions и outgoing_notifications; queue через queueDb. |

Дополнительные правки не требуются.

---

## P1 – Production Hardening

### 4. Event Journal

| Поле | Значение |
|------|----------|
| **Статус** | Открыто (отдельной таблицы `event_journal` нет; роль журнала выполняют incoming_transactions, outbox_events, аудит через outgoing) |
| **Эпик** | Отдельная задача или **EPIC 11/12** (event contract / observability) |

**Варианты:**

| Вариант | Действие | Файлы |
|---------|----------|--------|
| A. Отдельная таблица | Ввести append-only `event_journal` (id, correlation_id, actor_id, event_type, payload, created_at) и писать в неё при критичных операциях | **Миграция:** `migrations/YYYYMMDD_event_journal.sql`. **Создать:** `src/infra/eventJournal.ts` (append). **Менять:** вызовы из outboxHandlers, processingRuntime (после обработки), возможно transactions — запись в journal. |
| B. Оставить текущую модель | Считать журналом связку incoming_transactions + outbox_events + outgoing (audit) и документировать, что реконструкция идёт по ним и correlation_id | Только документация: `docs/idempotency_policy.md` или новый раздел «Event journal / реконструкция». |

---

### 5. Observability

| Поле | Значение |
|------|----------|
| **Статус** | Открыто |
| **Эпик** | **EPIC 10/11/12** (HTTP API, event contract, observability) |

**Шаги по файлам:**

| # | Действие | Файлы |
|---|----------|--------|
| 1 | Подключить Prometheus (счётчики/гистограммы) | **Создать:** `src/infra/metrics.ts` (или `src/infra/prometheus.ts`) — инициализация registry, счётчики: `transactions_total`, `otp_requests_total`, `provider_errors_total`, `queue_processing_latency` (гистограмма). **Менять:** `src/api/server.ts` — роут `GET /metrics` (expose registry). |
| 2 | Инструментировать критические пути | `src/modules/transactions/index.ts` — инкремент transactions_total, ошибки провайдера; `src/mqtt/sequoia/otp/index.ts` — otp_requests_total; `src/infra/queueDb.ts` или `src/api/routes/queue.ts` — queue_processing_latency; адаптеры провайдеров — provider_errors_total при ошибках HTTP. |
| 3 | correlation_id в логах | `src/infra/logger.ts` — добавить поле в default meta или формат; везде, где есть correlation_id, передавать в logger (child logger или второй аргумент). |
| 4 | Категории ошибок | Ввести коды/категории (например enum или константы) и логировать категорию при ошибках; при необходимости маппинг в metrics (labels). |

---

### 6. Production Readiness

| Поле | Значение |
|------|----------|
| **Статус** | Частично сделано |
| **Эпик** | Частично **EPIC 3**, частично отдельная задача (health/startup) |

**Сделано:** (1) Эндпоинты: `/health`, `/liveness` (200), `/readiness` (проверка БД, 503 при ошибке) в `src/api/routes/health.ts`. (2) В production обязателен QUEUE_API_KEY и запрещён дефолт — проверка в `src/config/env.ts` loadConfig(). Проверка БД при старте не в утверждённых требованиях — не делается.

**Оставшиеся шаги:**

| # | Действие | Файлы |
|---|----------|--------|
| 1 | Fail-fast: MQTT при старте (по требованию) | Опционально: проверка подключения к MQTT до подписок; при ошибке — exit(1). |
| 2 | Документация runbook | `docs/production_readiness_audit.md` — отметить выполненные пункты; runbook: перечень env, порядок миграций. |

---

### 7. Integration Tests

| Поле | Значение |
|------|----------|
| **Статус** | Открыто |
| **Эпик** | **EPIC 2** (Testing Foundation) |

**Шаги по файлам:**

| # | Действие | Файлы |
|---|----------|--------|
| 1 | Тестовый раннер и окружение | **Установить:** jest или vitest (и при необходимости pg, testcontainers или in-memory SQL). **Создать:** `jest.config.js` / `vitest.config.ts`, скрипт `npm run test` запускает тесты. **Создать:** `src/test/setup.ts` (или `tests/setup.ts`) — поднятие/очистка БД, конфиг для тестов. |
| 2 | Тесты: транзакция + OTP (сквозной сценарий) | **Создать:** `src/modules/transactions/__tests__/integration.test.ts` или `tests/integration/transaction-otp.test.ts` — ingest → incoming_transactions → processed, постановка в outgoing; при наличии OTP-потока — проверка связки. Использовать тестовую БД и при необходимости заглушки MQTT. |
| 3 | Тесты: очередь (acquire/release) | **Создать:** `tests/integration/queue.test.ts` (или в `src/api/routes/__tests__/queue.test.ts`) — acquire, повторный acquire (должен быть отказ или другой слот), release, повторный release (idempotent). |
| 4 | Тесты: дубликаты событий | **Создать:** тест на повторную вставку с тем же idempotency_key — вторая запись не создаётся или не обрабатывается дважды (incoming_transactions, outgoing_notifications dedup). |
| 5 | Тесты: provider callbacks | **Создать:** тест на вызов POST /webhooks/:bank/transaction или /otp с телом — проверка, что запись попала в очередь/таблицу и обработана (с заглушкой адаптера или тестовым банком). |

Зависимости: `package.json` — добавить devDependencies (jest/vitest, @types/jest и т.д.); при использовании тестовой БД — описать в README или docs.

---

## P2 – Architecture Hygiene

### 8. Domain Boundaries Enforcement

| Поле | Значение |
|------|----------|
| **Статус** | Документировано (module_boundaries.md); в коде частично соблюдается, есть кросс-модульные вызовы |
| **Эпик** | **EPIC 13** (Documentation alignment) + точечные рефакторинги |

**Шаги по файлам:**

| # | Действие | Файлы |
|---|----------|--------|
| 1 | Запретить прямой SQL в чужие таблицы в критичных модулях | **Проверить:** `src/modules/transactions/` — нет ли прямого UPDATE/INSERT в bank_cards, queue, outbox (должны идти через cards, queueDb, outgoingNotifications). **Проверить:** `src/infra/otp` и mqtt/otp — запись в queue только через queueDb. **Проверить:** `src/modules/statementsImport/` — bank_transactions и drafts: transactions владеет bank_transactions, drafts владеет drafts; при необходимости вынести вызовы в сервисы. |
| 2 | Явные фасады/сервисы модулей | Там, где сейчас прямой импорт репозитория другого модуля, ввести вызов через публичный API модуля (например cards: экспорт из `src/modules/cards/index.ts` или `src/infra/cardsDb.ts` только функций, разрешённых module_boundaries). |
| 3 | Консолидация дублей имён | Удалить или перевести код из `src/modules/statements_import/` в `src/modules/statementsImport/`; в `src/modules/index.ts` экспортировать один модуль. |
| 4 | Module-level README | **Создать:** `src/modules/transactions/README.md`, `src/modules/cards/README.md`, `src/infra/README.md` (кратко: назначение, owned tables, публичный API). |

---

## Сводная таблица: эпик → файлы

| Эпик | Задачи Cursor | Основные файлы |
|------|----------------|----------------|
| **EPIC 2** | P1.7 Integration Tests | `package.json`, `src/test/` или `tests/`, `src/modules/transactions/__tests__/`, `src/api/routes/__tests__/` |
| **EPIC 3** | P1.6 Production Readiness (частично) | `src/index.ts`, `src/infra/startupChecks.ts` (новый), `src/api/routes/health.ts`, `src/config/env.ts` |
| **EPIC 6** | (уже сделано: publish buffer) | — |
| **EPIC 8** | P0.1 Card Ownership (доработка) | `src/modules/cards/CardOwnershipService.ts` (новый), `src/infra/cardOwnership.ts`, `src/infra/cardsDb.ts`, `src/infra/profileAuthChangeWorker.ts`, `src/infra/unlinkDeadWorker.ts`, `src/api/routes/cards.ts`, `src/modules/transactions/` |
| **EPIC 10/11/12** | P1.4 Event Journal (опционально), P1.5 Observability | `src/infra/metrics.ts`, `src/api/server.ts`, `src/infra/logger.ts`, воркеры и роуты (инструментирование), при варианте A: `migrations/*_event_journal.sql`, `src/infra/eventJournal.ts` |
| **EPIC 13** | P2.8 Domain Boundaries | `src/modules/statements_import/` (удалить/объединить), `src/modules/index.ts`, `src/modules/*/README.md`, ревью импортов в transactions, otp, statementsImport |

---

## Порядок выполнения (рекомендуемый)

1. **P1.6 Production Readiness** (health, fail-fast) — минимальный объём, сразу полезно для деплоя.  
2. **EPIC 2 / P1.7 Integration Tests** — базовый набор тестов.  
3. **P1.5 Observability** — метрики и correlation_id в логах.  
4. **EPIC 8 / P0.1** — CardOwnershipService и привязка транзакций к снимку владения.  
5. **P2.8 / EPIC 13** — границы модулей в коде, консолидация statements_import.  
6. **P1.4 Event Journal** — по решению: отдельная таблица или документирование текущей модели.

Ссылки: [processor_hub_cursor_tasks.md](./processor_hub_cursor_tasks.md), [processor_hub_cursor_epics_progress.md](./processor_hub_cursor_epics_progress.md), [module_boundaries.md](./module_boundaries.md), [production_readiness_audit.md](./production_readiness_audit.md).
