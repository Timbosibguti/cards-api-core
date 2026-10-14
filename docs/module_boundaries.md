# Processor-Hub — границы модулей (module boundaries)

Документ фиксирует **bounded contexts** внутри монолита и правило ownership таблиц.  
Источник: [processor_hub_recommendations_for_cursor.md](./processor_hub_recommendations_for_cursor.md) §4.

**Правило:** изменение записи в owned-таблице должно происходить только через сервис/API владельца. Модуль не пишет SQL в чужие таблицы — только вызов публичного сервиса другого модуля.

---

## Официальные модули

| Модуль | Путь в коде | Назначение |
|--------|-------------|------------|
| **transactions** | `src/modules/transactions/` | Нормализация транзакций, ingest, bank_transactions, связь с адаптерами провайдеров |
| **otp** | `src/modules/otp/`, `src/mqtt/sequoia/otp/` | OTP-поток: парсинг, маршрутизация, drafts, уведомления |
| **bank_queue** | `src/infra/queueDb.ts`, `src/api/routes/queue.ts` | Очередь банковских слотов (acquire/release/status) |
| **drafts** | `src/modules/drafts/` | Pre-transaction / card-otp drafts, matching, TTL |
| **statements_import** | `src/modules/statementsImport/` | Импорт выписок, statement_import_jobs |
| **cards** | `src/modules/cards/`, `src/infra/cardsDb.ts`, `src/infra/cardOwnership.ts` | Карты, владение, bank_cards, bank_cards_history, farm API |
| **notifications** | Обработка в `src/infra/processingRuntime/`, постановка в `src/infra/outgoingNotifications.ts` | outbox_events, outgoing_notifications, воркеры доставки |
| **audit** | `src/infra/AuditService.ts`, постановка в outgoing | Аудит через mqtt:sequoia/audit, без прямой записи в audit_events |
| **identity/correlation** | `src/infra/correlation/` | correlation_id, idempotency keys, dedup keys |
| **provider_adapters** | `src/modules/transactions/adapters/` | Адаптеры ecards, adscards, multicards, stellarcards |

**Naming:** каноническое имя модуля импорта выписок — **statementsImport** (camelCase). Папка-дубль `statements_import` подлежит удалению/консолидации (см. implementation_progress.md § «Организационный дрейф»).

---

## Ownership таблиц

| Таблица | Владелец | Примечание |
|---------|----------|------------|
| `incoming_transactions` | **transactions** | Входной журнал транзакций; воркер в processingRuntime |
| `outbox_events` | **notifications** | Обработка в processingRuntime + outboxHandlers |
| `outgoing_notifications` | **notifications** | Постановка — outgoingNotifications; отправка — processingRuntime |
| `queue` | **bank_queue** | queueDb, api/queue |
| `bank_accounts` | **bank_queue** | Связаны с очередью |
| `drafts` | **drafts** | modules/drafts |
| `statement_import_jobs` | **statements_import** | statementsImport |
| `bank_transactions` | **transactions** | Результат нормализации |
| `bank_cards` | **cards** | cardsDb, cardOwnership |
| `bank_cards_history` | **cards** | cardOwnership |
| `bank_cards_shown` | **cards** | cardsDb |
| `cards_access` | **cards** | Farm-доступ к API карт |
| `cards_info` | **cards** | Справочник BIN |
| `sms_devices` | **otp** | Регистрация устройств для SMS |
| `ota_devices`, `ota_device_logs` | hardware/device registry | MQTT hardware |
| `balance_history` | balances / отдельный контекст | Алерты по балансам |
| `farm_ext.tbl_profile_auth_changes` | Внешняя БД Farm (канон: имена таблиц с префиксом tbl_) | Читает profileAuthChangeWorker |

Изменение данных в таблице должно выполняться только через код владельца (сервис/репозиторий). Запрещён произвольный SQL в чужие таблицы из других модулей.

---

## Публичные точки входа (кратко)

- **transactions:** `processIncomingBatch`, нормализация по банку, адаптеры (normalize, resolveOwner, create, removeLimits).
- **cards:** `reserveFreeCardByBin`, `unlinkCardFromProfile`, `setCardOwnership`, `getCardByProfileName`, API `/api/cards/*`.
- **bank_queue:** `acquire`, `release`, `status`, `credentials`, `kickoff` через api/queue и queueDb.
- **drafts:** `createBankPreDraftFromTaurus`, работа с drafts по типам.
- **statements_import:** `processSingleStatementJob`, воркер по statement_import_jobs.
- **notifications:** `enqueueOutgoingNotification`, воркеры incoming/outbox/outgoing, StuckProcessingJob. Переходы статусов (incoming_transactions, outbox_events, outgoing_notifications) — только через `src/infra/stateTransitions.ts` (set*Status*, set*Reclaim*, set*StuckToFailed).
- **audit:** события только через постановку в `outgoing_notifications` (channel mqtt:sequoia/audit).
- **identity/correlation:** `createCorrelationId`, `createIncomingIdempotencyKey`, `createOtpCardDedupKey`, `createMqttTxDedupKey`.

---

## Запрещённые зависимости

- Модуль **otp** не пишет напрямую в `queue` — только через вызов сервиса/порта **bank_queue** (если потребуется изменение слота).
- Модуль **transactions** не пишет напрямую в `bank_cards` — определение buyer/profile_name через чтение или через **cards** (репозиторий/сервис).
- Ни один модуль не публикует MQTT и не шлёт Slack напрямую — только через **notifications** (outgoing_notifications).
- Вне **cards** не должно быть прямого UPDATE/INSERT в `bank_cards` и `bank_cards_history` — только через cardOwnership/cardsDb или публичный API модуля cards.

Документ живёт: при добавлении таблиц и модулей границы обновляются. См. также [idempotency_policy.md](./idempotency_policy.md), [state_machines.md](./state_machines.md).
