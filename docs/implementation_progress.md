# Прогресс реализации Processor-Hub

Связь эпиков и задач из `tasks/` с фактическим прогрессом. Обновляется по мере выполнения.

## Хронология 04–06 марта 2026


| Дата      | Что сделано                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **04.03** | Воркер incoming_transactions: нормализация по банку, upsert в bank_transactions (ON CONFLICT), buyer/profile_name из bank_cards; постановка в outgoing (mqtt:sequoia/transaction, mqtt:sequoia/audit). Outgoing notifications worker: публикация в MQTT с envelope, retry/backoff; Slack — через REST на slack-app (send-otp, send-to-channel). Аудит транзакций через outgoing_notifications (mqtt:sequoia/audit). Миграции: формат имён, ALTER bank_transactions, init_core_tables (incoming_transactions, outbox_events, outgoing_notifications).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **05.03** | Доработки по транзакциям и инфраструктуре (при необходимости уточняется).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **06.03** | MQTT-обработчики: динамическая подписка по структуре каталогов; sequoia/hardware (heartbeat → ota_devices, ota_devicelog, hardware SMS — лог); sequoia/commands (парсинг/лог); **sequoia/otp** — потребление входящих OTP (SMS и картовые), извлечение суммы по контексту валюты (INR/Rs.), Slack DM + finance-otp + audit через outgoing_notifications, dedup для multi-DC. Вебхук мобильных приложений POST /webhooks/mobile/sms, таблица sms_devices. REST api/queue/* (acquire, release, status, credentials, kickoff), таблицы queue и bank_accounts, JWT и аудит. **Unlink-dead воркер**: запуск в полночь, отвязка карт от мёртвых профилей (Farm DB), аудит card_unlinked (user_email = buyer или [system@groscloud.com](mailto:system@groscloud.com), полные profile_name и card_number) и Slack #farm-otp через outgoing_notifications. Миграции: ota_devices, sms_devices, queue_bank_accounts. **Адаптеры (stellarcards, adscards, multicards)** приведены к полному функционалу по аналогии с ecards: stellarcards — поллинг транзакций и карт; adscards — поллинг карт, вебхук OTP (POST /webhooks/:bank/otp); multicards — вебхук transaction + card3ds (OTP в mqtt:sequoia/otp), resolveOwner по cardId. |
| **09.03** | **Multi-DC leasing для поллинга карт/транзакций:** добавлена миграция `20260309_polling_leases.sql` (таблица polling_leases: id, holder, acquired_at, expires_at, индекс по expires_at) и модуль `src/infra/pollingLease.ts` (getPollingInstanceId, acquirePollingLease). Все поллеры адаптеров (`startEcardsCardsPolling`, `startEcardsTransactionsPolling`, `startAdscardsCardsPolling`, `startAdscardsTransactionsPolling`, `startStellarcardsCardsPolling`, `startStellarcardsTransactionsPolling`, `startMulticardsTransactionsPolling`) берут lease по `id` вида `<bank>.<entity>` с TTL 60 секунд; если lease уже занят другим инстансом, текущий инстанс ждёт 5 секунд и пропускает цикл. Так гарантируется, что в multi-DC транзакции и карты каждого провайдера поллятся ровно одним активным воркером. |
| **06.03** | **bank_cards_history и is_buying:** миграция `20260306_bank_cards_history_and_is_buying.sql` (таблица bank_cards_history, колонка is_buying на bank_cards, частичный уникальный индекс «один активный интервал на карту»). Единая функция **setCardOwnership** (`src/infra/cardOwnership.ts`): в одной транзакции обновление bank_cards (buyer, profile_name, is_buying), закрытие текущего интервала в history, вставка новой строки. Вызовы: get-by-bin (фармер привязывает → buyer=email, is_buying=false); profileAuthChangeWorker (передача баеру → is_buying=true; возврат в фарм → buyer=null, is_buying=false); unlink (API и unlink-dead). acc_no не меняется в setCardOwnership; при unlink выставляется в вызывающем коде (cardsDb, unlinkDeadWorker).                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **06.03** | **Создание карт adscards и multicards:** адаптеры вызывают сервисы выпуска: adscards — POST {ADSCARDS_BASE_URL}/api/cards/issue (body: count, bin_id), multicards — POST {MULTICARDS_BASE_URL}/api/cards/create (body: quantity, bin как bankId). Роут POST /api/cards/create/:bankId поддерживает ecards, adscards, multicards; валидация bin по банку.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **06.03** | **Рекомендации CTO — к исполнению:** (1) **Аудит:** в `AuditEvent`/`AuditWriteInput` добавлены опциональные поля расследовательского стандарта: `subject`, `before_state`, `after_state`, `result`, `no_op_reason` ([idempotency_policy.md](./idempotency_policy.md), Priority 1.4). (2) **Reclaim/requeue:** StuckProcessingJob переведён на функции из `src/infra/stateTransitions.ts` (setIncomingReclaimPending, setIncomingStuckToFailed, setOutbox*, setOutgoingReclaimPending) — Priority 1.5. (3) **State guards:** модуль `stateTransitions.ts` — константы допустимых переходов (INCOMING_ALLOWED и др.), функции set*Status*/set*Reclaim*; воркер incoming использует setIncomingStatusToProcessing. (4) **Dead-letter:** статус `dead_letter` для `statement_import_jobs` зафиксирован в миграции и [state_machines.md](./state_machines.md). См. [decisions_log.md](./decisions_log.md), [processor_hub_cursor_epics_progress.md](./processor_hub_cursor_epics_progress.md) EPIC 3.                                                                                                                                                                                                                         |
| **06.03** | **P1.6 Production Readiness:** эндпоинты /health, /liveness, /readiness (readiness проверяет БД, 503 при ошибке), в production обязателен QUEUE_API_KEY (запрещён дефолт в env.ts). **EPIC 2.1:** Vitest, тесты stateTransitions (14 юнит-тестов).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **06.03** | **Dev simulation (dev-контур):** полная среда по [processor_hub_dev_simulation_spec.md](./processor_hub_dev_simulation_spec.md): конфиг DEV_SIMULATION_ENABLED, таблица dev_inbox_events, DevInboxWorker + devDispatcher, API POST/GET /dev/inbox-events и replay; роуты и воркер только при devSimulation.enabled; фикстуры в `dev-fixtures/`. Описание в архитектуре — architecture_overview.md §5.3, state_machines.md §dev_inbox_events.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |


Подробности решений — [decisions_log.md](./decisions_log.md); архитектура процессов — [architecture/processes.md](../architecture/processes.md), [architecture/mqtt_handlers.md](../architecture/mqtt_handlers.md). Dev-контур — [processor_hub_dev_simulation_spec.md](./processor_hub_dev_simulation_spec.md), [dev_simulation_concept.md](./dev_simulation_concept.md).

## Хронология март 2026 (дополнение)

| Дата | Что сделано |
|------|-------------|
| **31.03** | **Taurus — API карт:** `GET /taurus/buyer-cards` (список карт баера по `profile_name`), `POST /taurus/card-credentials` (креды в `credentials_base64`); авторизация **`api-key`** = queue **`QUEUE_API_KEY`**. Код: `src/api/routes/taurus.ts`, `farmDb.resolveBuyerEmailByProfileName`, `cardsDb.listBankCardsByBuyerEmail`, `getBankCardForBuyerByCardNumber`. Документация: [card_and_bank_flows.md](./card_and_bank_flows.md) § **I.e**, [decisions_log.md](./decisions_log.md). |
| **30.03** | **Очередь блокировок карт (`card_block_queue`):** задокументирован полный поток — `POST /api/card-block/block-batch`, воркер `cardBlockQueueWorker`, идемпотентность «уже в хабе» только в воркере (без вызова ПС, текст в `error`). Обновлены [card_and_bank_flows.md](./card_and_bank_flows.md) § I.b, [ops_incidents.md](./ops_incidents.md), [processes.md §2.6a](../architecture/processes.md), [decisions_log.md](./decisions_log.md). |
| **30.03** | **Multicards — группы баера и `acc_no`:** при выпуске с непустым `buyer_email` в теле `POST /api/cards/create/multicards` хаб резолвит `aff_id` в `binom`, запрашивает список групп Multicards (`GET /v1/card/group/list`), при отсутствии группы с именем `aff_id` создаёт её (`POST /v1/card/group/create`), в **`batchIssue`** передаётся **`cardGroupId`**. Поллинг карт (`GET /v1/card/list`): из **`cardGroup.name`** парсится `aff_id`, в **`bank_cards.buyer`** подставляется email из `binom`, в **`bank_cards.acc_no`** — строка **`binom.username / binom.aff_id`** (если `username` пустой — только `aff_id`); если из группы не удаётся получить числовой `aff_id`, для `acc_no` сохраняется прежняя заглушка **`FEBRUARY`**. Код: `multicards/create.ts`, `multicards/cards.ts`, `modules/binom/index.ts`. См. [decisions_log.md](./decisions_log.md), [card_and_bank_flows.md](./card_and_bank_flows.md) § I.c. |

## Хронология апрель 2026

| Дата | Что сделано |
|------|-------------|
| **06.04** | **MR 29 — unlink-dead и блокировка у ПС:** для карт без `is_bad` перед отвязкой от мёртвого профиля вызывается `adapter.blockCard`; при успехе — `setCardOwnership`, `is_bad`, `acc_no` «blocked at …», аудит `bank_card_blocked` с `source: 'unlink_dead'`. Если провайдер недоступен — **изменений в `bank_cards` нет**, профиль остаётся на карте до следующего запуска; аудит в этом прогоне не шлётся. Ветка `is_bad` (Binom и т.д.) без изменений. Роут `POST /api/cards/unlink` не трогался. Подробно: [mr29_unlink_dead_block.md](./mr29_unlink_dead_block.md), обновлены [card_and_bank_flows.md](./card_and_bank_flows.md), [processes.md §2.7](../architecture/processes.md). |
| **06.04** | **Документация очереди и «устройства в сети»:** `GET /api/queue/status` обогащается `phone_online` через `queuePhoneOnline.ts` (порог 2 минуты по `sim_last_network_at` / `sms_devices.updated_at`); при «не в сети» клиент получает **`phone_online: false`**. См. [card_issuance_queue_phone_online.md](./card_issuance_queue_phone_online.md). |
| **30.04** | **eCards — очередь привязки карт к баеру:** таблица **`ecards_buyer_card_issue_queue`** (одна строка на карту, общий **`request_batch_id`**). **`POST /api/cards/create/ecards`** с **`buyer_email`** только ставит очередь (без выпуска в ПС). Поллинг карт: claim по BIN, группа **`username / aff_id`**, API **`card-group`** + **`PATCH` карты**, статусы **`pending` / `processing` / `completed` / `failed`**. Миграция **`20260430_ecards_buyer_card_issue_queue.sql`**. См. [card_and_bank_flows.md](./card_and_bank_flows.md) § I.d, [decisions_log.md](./decisions_log.md). |

---

## Честная оценка готовности

**Документация не должна завышать фактическую готовность.** Если реализован только каркас (пайплайн, смена статусов) без доменной логики — это не «Готово», а **«Каркас»**. Иначе управление проектом и приоритеты искажаются.

Явные примеры:

- **Outbox Worker:** реализован диспетчер по `event_type` и обработчик **profile_transferred_to_buyer** (обновление bank_cards + bank_cards_history через setCardOwnership, аудит и Slack в outgoing_notifications, removeLimits). События помечаются processed или failed. Доп. типы событий при необходимости добавляются в `src/infra/outboxHandlers.ts`.
- **MqttClient:** синглтон и reconnect есть, но **уровня «устойчивый internal platform module» (как в architecture_overview) пока нет**: нет publish-буфера при disconnect, нет subscription registry и повторной подписки при reconnect, нет защиты от повторной регистрации обработчиков, входящие сообщения идут по `handlers.get(topic)` — только точное совпадение, без wildcard-диспетчеризации. Закрытие — EPIC 6 в [Cursor epics](./processor_hub_cursor_epics_progress.md).
- **Домен ownership (владение картой) — главный архитектурный риск.** Логика владения размазана между `cardsDb`, `profileAuthChangeWorker`, `unlinkDeadWorker`, `transactions`, queue-процессами, audit/outgoing. Модуль `cards` есть, но **CardOwnershipService как единая доменная точка ещё не собран**. От централизации зависят критические вопросы: кто владел картой в момент времени, когда карта перешла от farmer к buyer, когда отвязана, чем и кем платили. Без единой точки система будет усложняться быстрее, чем команда успеет удерживать инварианты. Закрытие — EPIC 8 в [Cursor epics](./processor_hub_cursor_epics_progress.md).

При обновлении таблиц ниже: помечать «Готово» только там, где реализована и инфраструктура, и требуемая бизнес-логика (или целевой уровень устойчивости из архитектуры).

---

## Легенда статусов

- **Не начато** — задача не взята в работу.
- **В работе** — в процессе реализации.
- **Готово** — реализовано и зафиксировано (код/документация), включая требуемую доменную логику.
- **Каркас** — инфраструктура/пайплайн есть, но либо **доменная обработка не реализована** (заглушка, только смена статусов), либо **целевой уровень устойчивости из архитектуры не достигнут** (например, MQTT без publish-буфера и wildcard-диспетчеризации). Не считать готовым для продакшена.
- **Отложено** — приостановлено по решению.

**Важно:** не помечать «Готово» то, где есть только каркас без реальной бизнес-логики или без заявленного в архитектуре уровня (outbox = пайплайн + доменные обработчики; MQTT = устойчивый platform module по architecture_overview).

---

## EP0. Базовая подготовка репозитория и окружения


| Задача | Описание                                                           | Статус | Примечания / ссылки                                                                                     |
| ------ | ------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------- |
| T0.1   | Корневая структура проекта (`src/infra`, `src/modules`, `src/api`) | Готово | [ep0_t0.1.md](../tasks/ep0_t0.1.md) — структура и заглушки в `src/`                                     |
| T0.1.a | Выбор фреймворка и bootstrap-схемы                                 | Готово | [ep0_t0.1.a.md](../tasks/ep0_t0.1.a.md) — Node.js + Fastify, [ADR-0001](./adr/0001-framework-choice.md) |
| T0.2   | Env-переменные и описание конфигурации                             | Готово | [ep0_t0.2.md](../tasks/ep0_t0.2.md) — перечень в `src/config/env.ts`                                    |
| T0.2.a | Типизированный config-слой                                         | Готово | [ep0_t0.2.a.md](../tasks/ep0_t0.2.a.md) — `src/config/` (env.ts, index.ts)                              |


---

## EP1. Инфраструктура и processing runtime


| Задача          | Описание                                                                                                                                                                                                                                                      | Статус | Примечания / ссылки                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1.1            | DatabaseService (finance, farm, sync; graceful shutdown)                                                                                                                                                                                                      | Готово | [ep1_t1.1.md](../tasks/ep1_t1.1.md), `src/infra/DatabaseService.ts`                                                                                                                                     |
| T1.2            | **MqttClient** — синглтон, reconnect, **publish-буфер при disconnect (EPIC 6)**: при отключении сообщения буферизуются (до 10k), при reconnect — сброс буфера. Subscription registry и wildcard-диспетчеризация — при необходимости далее.                    | Готово | [ep1_t1.2.md](../tasks/ep1_t1.2.md), `src/infra/MqttClient.ts`.                                                                                                                                         |
| T1.3            | Базовый AuditService + расследовательские поля                                                                                                                                                                                                                | Готово | [ep1_t1.3.md](../tasks/ep1_t1.3.md), `src/infra/AuditService.ts` (MQTT → `sequoia/audit`). Опциональные поля: subject, before_state, after_state, result, no_op_reason (Priority 1.4 рекомендаций CTO). |
| T1.4            | Incoming transactions worker: FOR UPDATE SKIP LOCKED, нормализация, upsert bank_transactions, buyer/profile_name из bank_cards по (bank, acc_no), постановка в outgoing (sequoia/transaction + sequoia/audit). Переходы статусов через `stateTransitions.ts`. | Готово | `src/infra/processingRuntime`, `src/infra/stateTransitions.ts`, `src/modules/transactions` (normalize, processIncomingBatch)                                                                            |
| T1.5 (outbox)   | Outbox events worker: пайплайн (pending → processing → processed/failed) и диспетчер по event_type; обработчик **profile_transferred_to_buyer** (setCardOwnership, аудит, Slack, removeLimits).                                                               | Готово | `src/infra/processingRuntime/index.ts`, `src/infra/outboxHandlers.ts`.                                                                                                                                  |
| T1.5 (outgoing) | Outgoing notifications worker: публикация в MQTT с envelope, backoff 1,2,4,8,16,30 мин; Slack через REST на slack-app (send-otp, send-to-channel). StuckProcessingJob — reclaim через `stateTransitions.ts` (setOutgoingReclaimPending и др.).                | Готово | `src/infra/outgoingBackoff.ts`, `src/infra/slackDelivery.ts`, `src/infra/stateTransitions.ts`, createEnvelope; [state_machines.md](./state_machines.md)                                                 |
| T1.6–T1.10      | Credentials, PaymentHttpClient, webhooks                                                                                                                                                                                                                      | Готово | см. предыдущие сессии                                                                                                                                                                                   |


---

## Рекомендации CTO — выполненный backlog (06.03)

Документация и код по [processor_hub_recommendations_for_cursor.md](./processor_hub_recommendations_for_cursor.md):


| Область                       | Что сделано                                                                                                                | Где                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Priority 1 docs**           | module_boundaries.md, idempotency_policy.md, state_machines.md                                                             | [docs/](./)                                                                                              |
| **Аудит (1.4)**               | В AuditEvent добавлены subject, before_state, after_state, result, no_op_reason                                            | `src/infra/AuditService.ts`                                                                              |
| **Reclaim/requeue (1.5)**     | StuckProcessingJob вызывает только функции из stateTransitions                                                             | `src/infra/processingRuntime/index.ts` (startStuckProcessingJob)                                         |
| **State guards (Epic C)**     | Допустимые переходы и функции set*Status*/set*Reclaim* в одном модуле                                                      | `src/infra/stateTransitions.ts`, [state_machines.md](./state_machines.md)                                |
| **Dead-letter (Epic D)**      | Статус dead_letter для statement_import_jobs в схеме и в state_machines                                                    | `migrations/20260306_statement_import_jobs_dead_letter.sql`, [state_machines.md](./state_machines.md) §5 |
| **P1.6 Production Readiness** | /health, /liveness, /readiness (БД → 503), в production обязателен QUEUE_API_KEY. Проверка БД при старте не в требованиях. | `src/api/routes/health.ts`, `src/config/env.ts`                                                          |
| **EPIC 2.1 Testing**          | Vitest, юнит-тесты stateTransitions (14 тестов)                                                                            | `vitest.config.ts`, `tests/stateTransitions.test.ts`                                                     |


Прогресс по эпикам — [processor_hub_cursor_epics_progress.md](./processor_hub_cursor_epics_progress.md) (EPIC 3); решения — [decisions_log.md](./decisions_log.md).

---

## Домен владения картами (ownership)

**Текущее состояние (06.03):** Реализованы таблица **bank_cards_history**, колонка **is_buying** и единая функция **setCardOwnership** (`src/infra/cardOwnership.ts`). Все смены владельца (get-by-bin, profileAuthChangeWorker, unlink API, unlink-dead) выполняют «закрыть текущий интервал → вставить новый» и обновление bank_cards только через setCardOwnership; история пишется везде. Семантика: фармер привязывает → buyer=email фармера, is_buying=false; передача баеру → is_buying=true; unlink → buyer=null, is_buying=false.


| Где живёт логика                       | Что делается                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/infra/cardOwnership.ts`           | setCardOwnership: UPDATE bank_cards + close/insert bank_cards_history                            |
| `src/infra/cardsDb.ts`                 | reserveFreeCardByBin, unlinkCardFromProfile (вызывает setCardOwnership), getCardDataBeforeUnlink |
| `src/infra/profileAuthChangeWorker.ts` | Вызов setCardOwnership при смене buyer (передача баеру / возврат в фарм)                         |
| `src/infra/unlinkDeadWorker.ts`        | Вызов setCardOwnership при отвязке + UPDATE acc_no                                               |
| `src/api/routes/cards.ts`              | get-by-bin: reserve + setCardOwnership (buyer=farmer, is_buying=false)                           |


**Остаётся для полной централизации (EPIC 8):** оформить **CardOwnershipService** как единый доменный слой с запросами «кто владел в момент X», issuance → history, и перевести все вызовы на него; вынести маппинг is_buying по справочнику/роли при необходимости.

---

## Организационный дрейф и структурные риски

**Симптом:** структура кода ещё не устоялась, явного naming governance нет — дальше будет больнее.

**Примеры:**


| Проблема                  | Где                                                                | Суть                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Дублирование имени модуля | `src/modules/statementsImport/` и `src/modules/statements_import/` | Один домен (импорт выписок) — два артефакта: camelCase vs snake_case. Реализация живёт в `statementsImport` (используется из processingRuntime); `statements_import` — заглушка (экспорт в modules/index). Нет единого правила именования папок.                                                                                                                                         |
| Смешение ролей в infra    | `src/infra/`*                                                      | Часть — воркеры (`profileAuthChangeWorker`, `unlinkDeadWorker`, `queueNotificationWorker`), часть — DB helpers (`cardsDb`, `queueDb`, `balancesDb`, `smsDevicesDb`, `hardwareDb`), часть — оркестрация/сервисы (`processingRuntime`, `AuditService`, `MqttClient`). Чёткой классификации (workers vs db vs orchestration) не зафиксировано, новые файлы добавляются без единого шаблона. |


**Рекомендации:** зафиксировать в документации (например, README или architecture) правила: именование папок модулей (единый стиль, напр. camelCase для `modules/`*), консолидация дублей (один модуль statements import — выбрать имя и перенести код/удалить заглушку), явное разделение в infra (workers / db / orchestration) или описание текущего разделения, чтобы новые артефакты не усугубляли дрейф. Задачу на приведение в порядок можно внести в backlog или EPIC 13 (Documentation alignment) / отдельную техническую задачу.

---

## EP2. Data model и миграции


| Задача        | Описание                        | Статус    | Примечания / ссылки                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T2.1          | SQL-миграции основных таблиц    | Готово    | Чистые миграции: [20260304_alter_bank_transactions.sql](../migrations/20260304_alter_bank_transactions.sql) — только ALTER bank_transactions; [20260304_init_core_tables.sql](../migrations/20260304_init_core_tables.sql) — только новые таблицы (incoming_transactions, outbox_events, outgoing_notifications). См. [migrations/README.md](../migrations/README.md). |
| T2.1.a        | README по миграциям             | Готово    | [migrations/README.md](../migrations/README.md) — обновлён формат имён                                                                                                                                                                                                                                                                                                 |
| T2.2 / T2.2.a | Согласование схемы, справочники | Не начато |                                                                                                                                                                                                                                                                                                                                                                        |


---

## Готовность к интеграциям с платёжными системами

- **Базовый поток транзакций**: реализовано **без** вызовов API платёжных систем (ecards, adscards, multicards, stellarcards): приём вебхуков → ingest → воркер → нормализация → bank_transactions, outgoing (MQTT/Slack), аудит.
- **Polling ecards (раздельно транзакции и карты)**:
  - адаптер `ecards` реализует два независимых poller’а, оба используют общий `PaymentHttpClient` и конфиг `transactionsPollingWindowHours`:
    - `startTransactionsPolling` — транзакции поллятся постранично, с обрезкой по «скользящему окну» давности и записью в `incoming_transactions`;
    - `startCardsPolling` — карты поллятся постранично до исчерпания страниц; креды шифруются через `infra/encryption/cardCredentials.ts` и сохраняются в `bank_cards.creds`; для карт из `note` + `groupsRelations.cardGroup.name` извлекается `aff_id`, по которому через `modules/binom` ищется `buyer` в таблице `binom`; при upsert’е в `bank_cards` новый `buyer` не затирает уже установленного.
- **OTP ecards**:
  - реализован отдельный poller внутри адаптера (`modules/transactions/adapters/ecards/otp.ts`, метод `startOtpPolling`), который периодически вызывает HTTP API `/codes` через `PaymentHttpClient`, отбирает новые записи по `id`, обогащает их `buyer`/`is_buying` по `bank_cards` и формирует `EcardsOtpPayload`;
  - события ставятся в `outgoing_notifications` с каналом `mqtt:sequoia/otp` и idempotency‑ключом вида `otp:ecards:<card_number|card_id>:<otp>:<time_bucket>`, после чего отправляются в MQTT воркером `OutgoingNotificationsWorker`.
- Слой polling/вызовов API для остальных провайдеров (adscards, multicards, stellarcards), включая их OTP‑потоки (вебхуки/отсутствие OTP), — следующий этап, реализуется отдельно.

---

## Dev контур (dev simulation)

Среда разработки без реальных платёжных систем и провайдеров: события инжектируются через **dev_inbox_events** и обрабатываются тем же пайплайном (DevInboxWorker → Dispatcher → реальные сервисы).


| Компонент                | Описание                                                                                                                                                                                                                | Статус | Ссылки                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Конфиг                   | `DEV_SIMULATION_ENABLED`; включено только при `NODE_ENV !== 'production'`                                                                                                                                               | Готово | `src/config/env.ts`                                                                                                                                                       |
| Таблица dev_inbox_events | id, source, event_type, payload, status (pending/processing/processed/failed), replay_of_event_id, представление dev_inbox_events_recent                                                                                | Готово | `migrations/20260306_dev_inbox_events.sql`, [state_machines.md](./state_machines.md) §8                                                                                   |
| DevInboxWorker           | Цикл: takePending → dispatch → mark processed/failed; старт только при devSimulation.enabled                                                                                                                            | Готово | `src/infra/devInboxWorker.ts`, `src/index.ts`                                                                                                                             |
| Dev Dispatcher           | source+event_type → реальные handlers: транзакции (платёжные), OTP/SMS, card_issued/updated (в т.ч. farm_extension с payload.bank), taurus_heartbeat/taurus_status, sms_device heartbeat, device_online/offline (no-op) | Готово | `src/infra/devDispatcher.ts`, `src/infra/devHandlers.ts`                                                                                                                  |
| API /dev/*               | POST/GET inbox-events, from-fixture, whitelist, :id, :id/outcome, replay, replay-batch, GET /dev/fixtures; ответ 201 с trace (event_url, outcome_url, correlation_id, created_at)                                       | Готово | `src/api/routes/dev.ts`, `src/api/server.ts`                                                                                                                              |
| Whitelist и валидация    | Допустимые source/event_type (GET /dev/whitelist); проверка и schema validation payload при вставке; 400 с message при ошибке                                                                                           | Готово | `src/infra/devInboxWhitelist.ts`                                                                                                                                          |
| dev=true                 | Платёжные вебхуки, POST /taurus/heartbeat, MQTT heartbeat (dev: true), POST /api/events (farm extension) → dev_inbox_events                                                                                             | Готово | `src/infra/devInboxIngest.ts`, `src/api/routes/payments.ts`, `src/api/routes/taurus.ts`, `src/api/routes/eventsIngest.ts`, `src/mqtt/sequoia/hardware/heartbeat/index.ts` |
| Фикстуры и доки          | Примеры в `dev-fixtures/`; руководство для разработчиков                                                                                                                                                                | Готово | [dev_simulation_developer_guide.md](./dev_simulation_developer_guide.md), `dev-fixtures/README.md`                                                                        |


**Главная точка входа для разработчиков:** [dev_simulation_developer_guide.md](./dev_simulation_developer_guide.md). Спецификация: [processor_hub_dev_simulation_spec.md](./processor_hub_dev_simulation_spec.md), концепт: [dev_simulation_concept.md](./dev_simulation_concept.md). В архитектуре: [architecture_overview.md](../architecture/architecture_overview.md) §5.3.

---

## MQTT-обработчики и очереди (2026-03-06)


| Компонент                             | Описание                                                                                                                                                                                                                             | Статус | Ссылки                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| MQTT handlers (динамическая подписка) | Загрузчик по структуре каталогов `src/mqtt/`, подписка на все топики при старте с учётом `topicPrefix`.                                                                                                                              | Готово | [architecture/mqtt_handlers.md](../architecture/mqtt_handlers.md), `src/mqtt/index.ts`                                                             |
| sequoia/hardware/*                    | Heartbeat → `ota_devices`, ota_devicelog → `ota_device_logs`, sequoia/hardware (SMS) — логирование.                                                                                                                                  | Готово | `src/mqtt/sequoia/hardware/`, `src/infra/hardwareDb.ts`, миграция `*_ota_devices.sql`                                                              |
| sequoia/commands                      | Парсинг и логирование команд (acquire/release); полная логика очередей — в api/queue/*.                                                                                                                                              | Готово | `src/mqtt/sequoia/commands/index.ts`                                                                                                               |
| **sequoia/otp (обработка)**          | Записи с channel `mqtt:sequoia/otp` обрабатываются **OutgoingNotificationsWorker** (прямой вызов handler из `src/mqtt/sequoia/otp`); подписка MQTT на топик `sequoia/otp` отключена. Логика: `source='sms'` и картовые → bank_accounts/queue, Slack DM + finance-otp + audit через outgoing_notifications; dedup_key + ON CONFLICT DO NOTHING. | Готово | [architecture/mqtt_handlers.md](../architecture/mqtt_handlers.md) §8, `src/mqtt/sequoia/otp/index.ts`, `src/infra/processingRuntime/index.ts` |
| Вебхук мобильных приложений           | `POST /webhooks/mobile/sms`: SmsPhone (heartbeat) → `sms_devices`; sms_received → outgoing_notifications (mqtt:sequoia/otp).                                                                                                         | Готово | `src/api/routes/mobileSms.ts`, миграция `*_sms_devices.sql`, [architecture/mqtt_handlers.md](../architecture/mqtt_handlers.md) §7                  |
| api/queue/*                           | Пять роутов: acquire, release, status, credentials, kickoff. Авторизация Api-Key + Bearer JWT, аудит по пользователю и очередям, Slack через queueSlack (send-otp).                                                                  | Готово | `src/api/routes/queue.ts`, `src/infra/queueDb.ts`, миграция `*_queue_bank_accounts.sql`, [architecture/processes.md](../architecture/processes.md) |


---

## EP7. Историчность владения и unlink-dead


| Задача | Описание                                                                                                                                | Статус | Примечания                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------- |
| T7.3   | Воркер unlink-dead: полночь, dead-профили (phase_id=4, stage_id=1, 5/30 дней), блокировка у ПС перед отвязкой (MR 29), отвязка карт, аудит + Slack через outgoing_notifications | Готово | `src/infra/unlinkDeadWorker.ts`, [mr29_unlink_dead_block.md](./mr29_unlink_dead_block.md), processes.md §2.7 |


---

## Дальнейшие эпики

EP3–EP9 — см. [epics.md](../tasks/epics.md). В таблицу выше будут добавляться строки по мере перехода к соответствующим задачам.

---

## Заключение по архитектуре, эпикам и задачам (2026-03-06)

**Проверка кода на соответствие бизнес-требованиям** (без учёта реализации адаптеров для остальных карточных сервисов — adscards/multicards/stellarcards сверх уже портированного):

- **Правило side-effects:** Модули не публикуют MQTT/Slack напрямую; все уведомления и аудит идут через `outgoing_notifications`. Соответствует.
- **Правило транзакций:** Изменения доменных состояний и связанный аудит выполняются в транзакциях (withTransaction / единый client). В unlink-dead используется два клиента (farm + main) без единой распределённой транзакции — допустимо, т.к. сначала читаем Farm, затем обновляем main и пишем в outgoing; при сбое между шагами повторный прогон на следующий день безопасен (идемпотентность по данным).
- **Outbox (событийная шина):** Реализован диспетчер по event_type и обработчик **profile_transferred_to_buyer** (bank_cards + history, аудит, Slack, removeLimits). События помечаются processed или failed.
- **MQTT (MqttClient):** Синглтон и reconnect работают, но **не уровня «устойчивый internal platform module»** по architecture_overview: нет publish-буфера при disconnect, нет subscription registry и идемпотентной подписки при reconnect, диспетчеризация входящих по точному топику (handlers.get(topic)), без wildcard. Закрытие — EPIC 6 Cursor.
- **Процесс 2.7 (unlink-dead):** Реализован воркер с запуском в полночь, критерии мёртвых профилей (5/30 дней, billing BIN), блокировка у ПС и отвязка (MR 29, см. [mr29_unlink_dead_block.md](./mr29_unlink_dead_block.md)), аудит с user_email = buyer или [system@groscloud.com](mailto:system@groscloud.com) и полными profile_name и card_number, Slack #farm-otp через outgoing_notifications. Соответствует.
- **Процесс 3.2 (OTP от банка), sequoia/otp:** Парсинг SMS, поиск по bank_accounts и queue, постановка в outgoing_notifications (DM + finance-otp + audit), извлечение суммы по контексту валюты (INR/Rs.). Соответствует.
- **Очередь (3.1), api/queue/*:** Acquire/release/status/credentials/kickoff, аудит и Slack через слой доставки. Соответствует.
- **Incoming transactions (2.6):** FOR UPDATE SKIP LOCKED, нормализация, upsert в bank_transactions, outgoing для MQTT и аудита. Соответствует. Fallback по drafts/aff_id в эпиках — не реализован, отмечен в backlog.
- **Profile transfer (2.4):** Поллинг tbl_profile_auth_changes (Farm DB) и обработка outbox_events с event_type **profile_transferred_to_buyer** (setCardOwnership, аудит, Slack, removeLimits). Соответствует.
- **Ownership (владение картой):** Реализованы **bank_cards_history**, **is_buying** и единая **setCardOwnership**; все смены владельца идут через неё, история пишется. Полная централизация в **CardOwnershipService** (запросы «кто владел в момент X», единый слой для issuance/history) — EPIC 8 Cursor.

**Архитектура:** Слои (API, адаптеры, core, infra), единый PaymentHttpClient и креды, DatabaseService и MqttClient как синглтоны, processing runtime с воркерами и StuckProcessingJob — в целом соответствуют architecture_overview.md. **Оговорка:** MqttClient реализован на уровне каркаса (reconnect есть; publish-буфер, subscription registry, wildcard-диспетчеризация — нет), целевой уровень — EPIC 6. Рекомендация: при росте числа планируемых джобов вынести расписание (cron/проверка времени) в один модуль с конфигурируемыми правилами.

**Эпики и задачи:** EP0, EP1, EP2 (миграции), фрагменты EP4–EP7 реализованы и отражены в таблицах выше. **Outbox worker — только каркас**, доменная обработка событий (EPIC 4 Cursor) не сделана. **Домен ownership не централизован** — главный архитектурный риск; доведение до CardOwnershipService и инвариантов истории — EPIC 8. EP3 (адаптеры остальных провайдеров), полноценный EP4 (cards/get-by-bin, link, history), EP5 (drafts state machine, fallback), EP6 (hardware, балансы), EP9 — частично или в backlog. Синхронизация epics.md с фактическим состоянием поддерживается через этот документ и decisions_log.

---

## Cursor Epics (типовой план доведения до продакшена)

Отдельный план задач по документу **processor_hub_cursor_epics_tasks.md** (источник: загрузка в Cursor). Отслеживание прогресса: **[processor_hub_cursor_epics_progress.md](./processor_hub_cursor_epics_progress.md)**.

**Приоритеты next steps (кратко):** см. полный список в [processor_hub_cursor_epics_progress.md](./processor_hub_cursor_epics_progress.md) § «Next steps — приоритеты (P0 / P1)».

- **P0 (без этого нельзя расширять домен):** зелёный typecheck, настоящие integration tests, реальная Slack delivery, бизнес-обработка в Outbox Worker, CardOwnershipService как единый слой.
- **P1 (сразу после P0):** полный workflow drafts, MQTT как platform module, API validation/error handling к одному стандарту, убрать дубли структуры (statementsImport vs statements_import и т.п.).
- **Phase 1 (Foundation):** EPIC 1 (Type Safety, Build, ESLint) — **готово** (06.03.2026). EPIC 2 (Testing), EPIC 3 (Runtime) — в очереди.
- Дальнейшие фазы: Phase 2 (EPIC 4, 5, 7) → Phase 3 (8, 9) → Phase 4 (10, 11, 12) → Phase 5 (13, документация).

**Аудит готовности к продакшену (06.03):** [production_readiness_audit.md](./production_readiness_audit.md) — перечень незавершённых мест в коде (TODO, feature gate, health, секреты, дубли), блокеры выхода в прод и рекомендации по эпикам/задачам.

---

## Документирование в процессе работы

- При принятии решения по архитектуре или конфигурации — добавить запись в [decisions_log.md](./decisions_log.md) и при необходимости создать ADR в [adr/](./adr/).
- При завершении задачи — обновить статус в этой таблице и указать ссылку на код или документ.
- По Cursor epics — обновлять [processor_hub_cursor_epics_progress.md](./processor_hub_cursor_epics_progress.md) и при необходимости этот раздел.

