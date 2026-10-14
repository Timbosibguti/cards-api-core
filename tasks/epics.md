## Processor-Hub — эпики и задачи

Эпики собраны на основе `architecture_overview.md`, `processes.md`, `event_contract.md` и существующего `backlog.md`.  
На этом этапе — только постановка, без реализации кода.

- **Глобальное жёсткое правило side-effects:**  
  Ни один модуль (воркеры, HTTP‑роуты, адаптеры платёжных систем, hardware‑интеграции и т.п.) **не имеет права публиковать MQTT‑сообщения или отправлять Slack‑нотификации напрямую**.  
  Допустимы только:
  - `INSERT` в `outbox_events` (внутренние доменные события);
  - `INSERT` в `outgoing_notifications` (Slack/MQTT и другие внешние нотификации).  
  Любой обход этого правила считается архитектурной ошибкой и должен быть устранён в код‑ревью.

- **Глобальное жёсткое правило транзакций:**  
  Любые изменения доменных состояний (`bank_cards`, `bank_cards_history`, `bank_transactions`, `drafts`, `queue`, `bank_accounts` и т.п.), а также связанная запись аудита и порождение outbox‑событий **всегда выполняются внутри транзакции основного подключения**.  
  На уровне кода это означает: все state‑mutations должны идти через `DatabaseService.withTransaction('main', async (tx) => { ... })` (или эквивалентный helper), без разрозненных `UPDATE`/`INSERT` вне общей транзакции.

---

### EP0. Базовая подготовка репозитория и окружения

- **EP0.1 Структура проекта и фреймворк**
  - **T0.1**: Создать корневую структуру (`src/infra`, `src/modules`, `src/app`/`src/api`) с явным разделением слоёв:
    - `infra/*` — доступ к БД, MQTT, логированию, processing runtime, Slack‑клиент, без доменной логики;
    - `modules/*` — доменные модули (`cards`, `transactions`, `drafts`, `bank_queue`, `otp`, `statements_import`, `audit`), внутри которых есть **repository + service + handlers**;
    - `app`/`api` — HTTP‑роуты/контроллеры, которые вызывают только `modules/*` и не трогают `infra/database`/`infra/mqtt` напрямую.
  - **T0.1.a**: Зафиксировать выбор фреймворка (Next app router vs чистый Node) и схему bootstrap’а (instrumentation/index).
- **EP0.2 Конфигурация окружения**
  - **T0.2**: Описать и завести `env`‑переменные (DB, MQTT, Slack, unlinkDead, и т.д.).
  - **T0.2.a**: Реализовать типизированный `config`‑слой для всех модулей.

---

### EP1. Инфраструктура и processing runtime

- **EP1.1 Синглтоны доступа к ресурсам**
  - **T1.1**: Реализовать `DatabaseService` (finance, farm, sync; graceful shutdown).
  - **T1.2**: Реализовать `MqttClient` (singleton, reconnect, routing).
  - **T1.3**: Реализовать базовый `AuditService` (запись в `audit_events` + MQTT `sequoia/audit`).

- **EP1.2 Processing runtime (incoming/outbox/outgoing + stuck/DLQ)**
  - **Жёсткое правило для всех воркеров:** **запрещены прямые side-effects** (Slack/MQTT/HTTP внешних сервисов) из воркеров `incoming_transactions`, `outbox_events`, `outgoing_notifications` и любых доменных воркеров.  
    Все внешние эффекты идут **только** через `outbox_events` и `outgoing_notifications` (см. архитектуру, разделы 5.0 и 6.2). Нарушение этого правила считается архитектурной ошибкой.
  - **T1.4**: Реализовать воркер обработки `incoming_transactions` (по модели 6.1: `SELECT … FOR UPDATE SKIP LOCKED`, `status=processing`, idempotent upsert в `bank_transactions`).
  - **T1.5**: Реализовать воркер обработки `outbox_events` (по моделям 2.4 и 2.7, с concurrency control).
  - **T1.6**: Реализовать воркер `outgoing_notifications` (публикация в Slack/MQTT, retries, rate limit) с учётом модели из раздела 6.2:
    - использовать поля `attempts`, `max_attempts`, `next_retry_at` в таблице;
    - реализовать функцию backoff(attempts) по архитектуре (ступенчатый/экспоненциальный backoff с cap 30 минут) и обновлять `next_retry_at` при ошибках;
    - при ответе Slack с HTTP 429 обрабатывать заголовок `Retry-After` (если есть) и выставлять `next_retry_at = NOW() + Retry-After` (или фиксированную паузу), опционально статус `rate_limited`;
    - при `attempts >= max_attempts` выставлять `status = 'failed'` и не пытаться отправлять дальше.
  - **T1.7**: Реализовать модуль `infra/processing_runtime` с единым `StuckProcessingJob` (раздел 6.3):
    - сброс зависших `processing`/`sending` по таймаутам (см. `STUCK_*_TIMEOUT_MINUTES` в разделе 6.3);
    - увеличение `processing_attempts`/`attempts` и соблюдение лимитов:
      - `INCOMING_MAX_PROCESSING_ATTEMPTS` (по умолчанию 3) и `OUTBOX_MAX_PROCESSING_ATTEMPTS` (по умолчанию 3);
      - `OUTGOING_MAX_ATTEMPTS` (по умолчанию 8) для Slack/MQTT нотификаций;
    - перевод в `failed` при превышении лимита (без автоматического возврата в `pending`);
    - (опционально) перенос в quarantine‑таблицы (`*_quarantine`) для failed‑записей.

- **EP1.3 Авторизационный слой (credentials + PaymentHttpClient)**
  - **T1.8**: Реализовать централизованное хранилище кредов платёжных систем:
    - источник кредов: env‑переменные, конфиг и/или таблица (например, `payment_provider_credentials` или использование существующих `bank_cards.creds` / `bank_accounts` по контексту `bank`/`acc_no`);
    - интерфейс получения кредов по идентификатору провайдера и опционально контексту (acc_no, card_id): тип авторизации (API key, Basic, Bearer, custom headers) и значения для подстановки в запросы;
    - шифрование чувствительных полей при хранении в БД (если креды в таблице).
  - **T1.9**: Реализовать единый **PaymentHttpClient** (`infra/payment_http`):
    - синглтон (или фабрика по контексту), через который выполняются **все** исходящие HTTP‑запросы к платёжным системам (eCards, Multicards, StellarCards, AdsCards, банки с API);
    - подстановка авторизации из слоя кредов (раздел 3.3 architecture_overview.md): по `bank` и при необходимости `acc_no`/параметрам запроса получать заголовки/тело и добавлять к запросу;
    - единые таймауты, retry с backoff, логирование запросов/ответов (без логирования секретов), прокидывание `correlation_id` в заголовки исходящих вызовов;
    - опционально: доменные методы‑обёртки (`getCards(bank, accNo)`, `getTransactions(bank, options)` и т.п.) или универсальный `request({ bank, accNo?, method, path, body?, correlationId? })`.
  - **T1.10**: Обеспечить использование PaymentHttpClient во всех платёжных адаптерах:
    - при портировании/реализации адаптеров (EP3): запретить прямой `fetch`/`axios` к API провайдеров; все вызовы только через `PaymentHttpClient`;
    - зафиксировать в код‑ревью и в описании адаптеров (раздел 4.3 architecture_overview.md).

---

### EP2. Data model и ручные миграции

- **EP2.1 Миграции схемы (ручные .sql)**
  - **T2.1**: Подготовить SQL‑миграции для основных таблиц:
    - `bank_transactions`, `incoming_transactions`, `drafts`;
    - `bank_cards`, `bank_cards_history`, `bank_accounts`, `queue`;
    - `outbox_events`, `audit_events`, `outgoing_notifications`.
    - Обязательно учесть **уникальные и частичные индексы** из архитектуры:
      - `incoming_transactions.idempotency_key` — `UNIQUE`, ключ идемпотентности (`tx:<bank>:<acc_no>:<ext_id>` и т.п.).
      - `bank_cards_history` — частичный `UNIQUE (card_number) WHERE valid_to IS NULL` (один активный интервал на карту).
      - `drafts` — уникальные ключи по `kind` (раздел 4.1):
        - `bank_pre`: `UNIQUE (bank, transaction_id)`;
        - `card_otp`: `UNIQUE (bank, card_number, otp, time_bucket)` или `UNIQUE (bank, payload_hash)` при отсутствии card_number;
        - `card_pre`: `UNIQUE (profile_name, otp, time_bucket)` или `UNIQUE (bank, payload_hash)` / `UNIQUE (bank, transaction_id)` при наличии клиентского id.
  - **T2.1.a**: Обновить/создать README по миграциям (правила именования, порядок применения).
  - **T2.1.b**: Добавить, при необходимости, quarantine‑таблицы (`*_quarantine`) для ядовитых записей.

- **EP2.2 Согласование с существующими сервисами**
  - **T2.2**: Сверить фактические схемы в:
    - `mqtt_adscards_transactions`, `mqtt_ecards_transactions`, `mqtt_multicards_transactions`,
      `mqtt_import_by_file_transactions`, `mqtt_stellarcards_transactions`, `mqtt_otp_transactions_service`.
  - **T2.2.a**: Составить единый справочник:
    - типов `bank`;
    - статусов транзакций;
    - типов событий аудита.

---

### EP3. Платёжные адаптеры и внешние роуты по картам

- **EP3.1 Требования к адаптерам платёжных систем (раздел 4.3)**
  - **T3.0**: Для каждого адаптера (`ecards`, `multicards`, `stellarcards`, `adscards`) описать/реализовать:
    - выпуск карт по BIN;
    - поллинг карт с кредами и поиском `buyer`/`is_buying` по `aff_id`;
    - обработку OTP (если поддерживается);
    - поллинг транзакций и вебхуки (если есть), с записью в `incoming_transactions` и публикацией в `sequoia/transaction`.
    - **Конкретные реализации на основе существующих сервисов** (код уже есть, требуется порт и единый контракт):
      - **ecards**: перенести/обернуть реализацию из `mqtt_ecards_transactions` и `adscards-webhook`:
        - выпуск карт и управление лимитами (роуты `remove-limits`, `set-velocity-control` и связанные API‑клиенты);
        - поллинг карт (список активных карт, BIN/группа, креды) и запись в `bank_cards`/`bank_cards_history`;
        - поллинг транзакций и, где есть, webhooks → нормализация в `TransactionEventPayload` и `incoming_transactions`;
        - поллинг OTP‑кодов (по образцу `ECardsService` — `/codes`) и генерация `sequoia/otp` с `source='ecards'`.
      - **multicards**: перенести реализацию из `mqtt_multicards_transactions`:
        - выпуск карт по BIN и привязка к аккаунтам/группам;
        - поллинг карт с кредами и вычислением `buyer`/`is_buying` по `aff_id` (binom);
        - поллинг транзакций и формирование событий/записей по схеме раздела 4.3/2.6.
      - **stellarcards**: перенести реализацию из `mqtt_stellarcards_transactions`:
        - API выпусков и карт‑листов (card list);
        - поллинг транзакций и, при наличии, OTP по тем же правилам (event contract, `incoming_transactions`/`sequoia/otp`).
      - **adscards**: перенести реализацию из `mqtt_adscards_transactions` и `adscards-webhook`:
        - выпуск и поллинг карт/транзакций;
        - вебхук `card_sms_codeV2` для OTP (перенос в Processor‑Hub и публикация `sequoia/otp` с `source='adscards'`);
        - единый формат событий и запись во внутренние таблицы, без прямых Slack‑вызовов (через `outgoing_notifications`).

- **EP3.2 Внешние роуты для работы с картами (как в mqtt_ecards_transactions)**
  - **T3.1**: Реализовать роут **`POST /cards/get-by-bin`**:
    - вход: `profileId`, `profileName`, `bin`, `bank`;
    - проверка доступа (farmer);
    - атомарный выбор и резервирование свободной карты по BIN с формализованной **concurrency‑policy**:
      - либо шаблон `SELECT ... FOR UPDATE SKIP LOCKED` по `bank_cards` в короткой транзакции;
      - либо атомарный `UPDATE ... WHERE buyer IS NULL RETURNING *` (или эквивалентный upsert‑паттерн);
      - запрещены read‑modify‑write без блокировок/уникальных ограничений (иначе два фермера могут взять одну карту);
    - расшифровка кредов;
    - аудит `bank_card_linked_to_profile` + запись в `bank_cards_history` и `bank_cards_shown`.
  - **T3.2**: Реализовать роут **`POST /cards/unlink`**:
    - вход: `cardNumber`, `profileId`, опционально `profileName`;
    - проверка доступа;
    - отвязка карты от профиля (обновление `bank_cards` и `bank_cards_history`) с явной **concurrency‑policy**:
      - операции по карте выполняются в одной транзакции;
      - обновления опираются на инвариант истории (частичный `UNIQUE (card_number) WHERE valid_to IS NULL`) и/или условия `WHERE current_owner = :expectedOwner` для избежания гонок при смене владельца;
    - аудит `card_unlinked`.
  - **T3.3**: Реализовать роут **`GET /cards/check`**:
    - вход: `profile_name`, `profile_id`;
    - проверка доступа;
    - проверка, привязана ли карта к профилю;
    - при наличии — расшифровка кредов и возврат сведений о карте (номер/срок/geo/info).

- **EP3.3 Снятие лимитов при передаче профиля баеру**
  - **T3.4**: Перенести логику `remove-limits` в Processor-Hub:
    - абстрактный интерфейс для “card limit removal” у адаптеров (не только eCards);
    - eCards‑реализация по образцу `remove-limits` (TokenService, `/set-velocity-control`).
  - **T3.5**: В процессе **2.4 “Профиль передан баеру”**:
    - при смене владельца на баера (is_buying=true) вызывать “remove limits” для поддерживаемых платёжных систем:
      - либо напрямую через адаптер, либо через постановку команды в MQTT (`sequoia/card`).
  - **T3.6**: Добавить аудит и Slack‑нотификации по результату удаления лимитов (успех/ошибка), по аналогии с текущим eCards‑роутом.

---

### EP4. Процессы карточных операций и OTP

- **EP4.1 Карточные операции**
  - **T3.1 (из backlog)**: Реализовать процесс 2.1 “Выпуск карты” (webhooks/polling → `bank_cards` + аудит).
  - **T3.2 (из backlog)**: Реализовать процесс 2.2 “Привязка карты через farm‑расширение” (`/cards/get-by-bin`, `/cards/link` → `bank_cards` + `bank_cards_history` + аудит).
    - все изменения (`bank_cards`, `bank_cards_history`, `audit_events`, `outbox_events`) выполнять **строго в рамках одной транзакции** через helper `withTransaction(...)`/аналогичный API `DatabaseService`, чтобы исключить частичные состояния.

- **EP4.2 OTP по картам и Google‑коды**
  - **T3.3 (из backlog)**: Реализовать процессы 2.3 и 2.5 “Google‑код / OTP по карте”:
    - приём OTP из webhooks/MQTT/SMS, включая специальные потоки:
      - фоновый поллинг OTP‑кодов от **eCards** (по образцу `ECardsService` из `adscards-webhook`: HTTP API `/codes` → сохранение в таблицу → публикация события `sequoia/otp` с `source='ecards'`);
      - вебхук `card_sms_codeV2` от **AdsCards** (по образцу `WebhookController`: приём `card_number` + `code` → событие `sequoia/otp` с `source='adscards'`);
    - парсинг через `ParserService`‑подобную логику;
    - поиск владельца карты через `bank_cards` и историю;
    - постановка уведомлений в `outgoing_notifications` (DM buyer + каналы `farm-otp`, `finance-otp`);
    - запись в `drafts` (тип `card_otp`) при необходимости и аудит.

---

### EP5. Банковские транзакции, drafts и выписки

- **EP5.1 Ingest транзакций**
  - **T4.1 (из backlog)**: Реализовать процесс 2.6 “Получение транзакции от платежной системы”.
  - **T4.1.a**: Нормализовать все входящие форматы (webhooks/polling) в единый `TransactionEventPayload`.

- **EP5.2 Drafts как workflow**
  - **T4.2 (из backlog)**: Реализовать `/draft` для типов A/B (bank_pre/card_pre/card_otp).
  - **T4.2.a**: Реализовать state machine и TTL по разделу 4.1:
    - уникальные ключи по kind;
    - `time_bucket`, `expires_at`, `status = pending/confirmed/expired`;
    - matching строго по TTL;
    - **concurrency‑policy** для `/draft`: только через `INSERT ... ON CONFLICT` по заданным уникальным ключам (без read‑modify‑write без блокировок), чтобы несколько запросов не создавали дубликаты draft’ов одного и того же события.

- **EP5.3 Импорт выписок**
  - **T4.3 (из backlog)**: Реализовать процесс 3.4 “Импорт банковской выписки” с учётом multi‑DC и очереди:
    - REST‑эндпоинт `POST /statements/import` (multipart/form‑data с файлом) → создать запись в `statement_import_jobs` и сразу вернуть `{ job_id, status: 'accepted' }` без ожидания обработки;
    - REST‑эндпоинт `GET /statements/status?id=...` → статус job’а (`pending`/`processing`/`processed`/`failed`, ошибки, агрегаты);
    - таблица `statement_import_jobs` (очередь задач на импорт) с полями `id`, `file_name`, `file_type`, `file_size`, `storage_ref`/`BYTEA`, `status`, `created_at/started_at/finished_at`, `error`, `correlation_id`, `idempotency_key`;
    - воркеры импорта, выбирающие job’ы по `status='pending'` через `SELECT ... FOR UPDATE SKIP LOCKED` (раздел 6.1), безопасно для multi‑DC;
    - парсинг файла (по образцу `mqtt_import_by_file_transactions`: `ParserFactory.parseFile`) → нормализованные транзакции `ImportedStatementTransaction`;
    - matching только по активным drafts (TTL) в контексте pre‑transaction → transaction (ключи `bank_pre`, см. раздел 3.3/4.1);
    - fallback по `aff_id`/сумме и таблице `binom` для поиска `buyer`;
    - создание/обновление `bank_accounts` для новых `(bank, acc_no)` и upsert в `bank_transactions`;
    - аудит `statement_import_started/finished/failed`, `bank_transaction_confirmed`, `bank_transaction_fallback_matched`.

---

### EP6. Очередь в банк, OTP банка, hardware‑SMS и балансы

- **EP6.1 Очередь (lease)**
  - **T5.1 (из backlog)**: Реализовать процесс 3.1 “Баер занял очередь в банк” с lease‑семантикой (раздел 3.1):
    - REST‑методы `/queue/acquire`, `/queue/release`, `/queue/credentials`, `/queue/kick-off`, `/queue/status` (по образцу `mqtt_otp_transactions_service`);
    - очистка просроченных записей в `queue`;
    - формализованная **concurrency‑policy** для `/queue/acquire`/`/queue/release`:
      - уникальный ключ `(bank, acc_no)` на `queue` + паттерн вставки с обработкой `unique violation` **или** `SELECT ... FOR UPDATE` в короткой транзакции;
      - идемпотентность acquire/release/kick-off (повторный запрос не меняет состояние неожиданным образом);
    - аудит `bank_queue_*`, `queue_kicked_off`, `credentials_*`.

- **EP6.2 OTP от банка**
  - **T5.2 (из backlog)**: Реализовать процесс 3.2 “Получен OTP от банка”:
    - приём SMS/OTP (MQTT `sequoia/otp` с `source='sms'` и/или HTTP‑вебхуки от SMS‑шлюза и hardware‑устройств по схеме `adscards-webhook`);
    - реализация подсистемы **SmsParser**:
      - интерфейс `BankSmsParser` (`canParse`/`parse`);
      - набор парсеров для конкретных банков (Axis/Hdfc/Kotak/... + Generic);
      - определение рекламных/промо SMS и их отбрасывание;
    - обработка `SmsOtpPayload.raw` (JSON `{ content, recipient }` или просто текст);
    - поиск `(bank, acc_no)` по телефону через `bank_accounts.phone` (учёт нескольких записей и bank из парсинга) и, при необходимости, поиск устройства по телефону через `sms_phones.phones[]` (IMEI → diagnostic/monitoring);
    - поиск активной очереди по `(bank, acc_no)`;
    - постановка уведомлений в `outgoing_notifications` (OTP владельцу очереди, dedup по `otp:bank:<bank>:<acc_no>:<otp>:<timestamp_bucket>`);
    - аудит `bank_otp_received` (bank, acc_no, phone, otp, correlation_id).

- **EP6.3 Hardware‑устройства (IMEI) и SMS‑ингест**
  - **T5.3**: Реализовать подсистему приёма SMS/телеметрии от hardware‑устройств:
    - HTTP‑вебхук `/hardware/sms-webhook` (или аналог) по образцу `WebhookController` из `adscards-webhook`;
    - десериализация и upsert устройств в таблицу `sms_phones` (IMEI, battery, charging, phones[], info, last_update);
    - сохранение входящих SMS в таблицу `sms` (`type='sms_received'`, `imei`, `sender`, `recipient`, `content`, `created_at`).
  - **T5.4**: Интегрировать hardware‑SMS с общим OTP‑потоком:
    - при `type='sms_received'` формировать внутренняя сущность (или MQTT‑сообщение) совместимую с `SmsOtpPayload` (`source='hardware'`, `raw` = JSON тела из вебхука);
    - прокинуть событие в `modules/otp/bank-otp` (через MQTT `sequoia/otp` либо прямой вызов) для парсинга и маршрутизации в очередь;
    - учесть идемпотентность (hash по IMEI+content+timestamp) и фильтрацию промо‑SMS.
  - **T5.5**: Реализовать REST‑методы управления hardware‑устройствами (по образцу `mqtt_otp_transactions_service` + `HARDWARE_API_DOCUMENTATION.md`):
    - `GET /hardware/devices`, `GET /hardware/devices/{imei}`;
    - `POST /hardware/devices/{imei}/send-sms`, `/ota-update`, `/ota-reboot`, `/ota-modemreboot`, `/ota-publishlog`, `/config`, `/set-note`, `/ota-logs`;
    - под капотом — использование `HardwareService`‑подобного singleton’а, публикующего команды в MQTT `sequoia/hardware/command` и читающего `sequoia/hardware/heartbeat`/`sequoia/hardware/ota_devicelog` (через общий `MqttClient`).

- **EP6.4 Балансы банков и лимиты**
  - **T5.3**: Реализовать REST‑метод `GET /balances` (по образцу `mqtt_otp_transactions_service`):
    - аутентификация: Basic Auth (админ) или JWT/OpenID;
    - выборка всех `bank_accounts` с `phone <> '0'` и полями `balance`, `currency`, `balance_limit_alert`, `op_limit_alert`, `op_sum_limit_alert`, креды (`login/password/extra`);
    - дешифровка `login/password` при выдаче;
    - вычисление `daily_operations` через вспомогательные функции/SQL.
  - **T5.4**: Реализовать REST‑методы управления балансами:
    - `POST /balances/update-balance` — прямое обновление `bank_accounts.balance` (валидация, неотрицательный баланс);
    - `POST /balances/add-balance` — инкремент баланса с записью истории (`balance_history`/`recordBalanceChange`);
    - учесть audit‑поля (`userEmail`, `source`, комментарий).
  - **T5.5**: Реализовать REST‑методы управления лимитами и телефоном:
    - `POST /balances/update-limits` — обновление `balance_limit_alert`, `op_limit_alert`, `op_sum_limit_alert`, `phone`;
    - валидация числовых значений и телефона;
    - корректная обработка отсутствующих/`null` полей (динамический `UPDATE`).
  - **T5.6**: Реализовать REST‑метод `POST /balances/update-credentials`:
    - обновление `login/password/extra` для `bank_accounts` с шифрованием чувствительных полей;
    - повторное использование общего сервиса `updateBankAccountCredentials`.
  - **T5.7**: Реализовать REST‑метод `GET /balances/history`:
    - фильтры `bank`, `acc_no`, `startDate`, `endDate`, пагинация `limit/offset`;
    - возвращать историю изменений баланса с метаданными (кто изменил, источник, комментарий).

---

### EP7. Историчность владения картами и “смерть” профиля

- **EP7.1 История владения и аналитика**
  - **T6.1 (из backlog)**: Корректная поддержка `bank_cards_history` (все изменения владельца → закрыть старый интервал, создать новый).
  - **T6.2 (из backlog)**: API/функции:
    - “чья была карта на дату X?”;
    - “кто владелец сейчас?”;
    - проверка инвариантов истории.

- **EP7.2 Unlink-dead (batch‑отвязка карт от мёртвых профилей)**
  - **T7.3**: Реализовать воркер `unlink-dead` по разделу 2.7:
    - поиск dead‑профилей (phase_id=4, stage_id=1, старше 7/30 дней);
    - выборка карт `profile_name IN deadProfiles` с учётом банков/BIN’ов;
    - отвязка карт (`bank_cards`: `buyer/profile_name/is_buying` → NULL, `acc_no` → фармовое значение; `bank_cards_history`: закрыть активный интервал);
    - batch‑аудит `card_unlinked` и Slack‑отчёт в `farm-otp` с агрегированной статистикой.

---

### EP8. Event Contract, Correlation/Idempotency SDK

- **EP8.1 Event Contract SDK**
  - **T8.3**: Вынести типы из `architecture/event_contract.md` в общий пакет/модуль:
    - envelope (`schema_version`, `producer`, `occurred_at`, `idempotency_key`, `correlation_id`);
    - payload‑типы для `sequoia/otp`, `sequoia/transaction`, `sequoia/cards`, `sequoia/card`, `sequoia/audit`.
  - **T8.4**: Реализовать валидаторы/decoder’ы для входящих сообщений (envelope + payload) и helper’ы для публикации.

- **EP8.2 Correlation / Idempotency / Dedup SDK**
  - **T8.5**: Реализовать общий модуль генерации:
    - `correlation_id` (trace id для всей цепочки);
    - `idempotency_key` для incoming (`tx:<bank>:<acc_no>:<ext_id>`, OTP и т.д.);
    - `dedup_key` для outgoing_notifications (OTP, tx, audit).
  - **T8.6**: Применить SDK во всех новых модулях вместо локальной генерации ключей.

---

### EP9. Наблюдаемость, эксплуатация и миграция от mqtt_* сервисов

- **EP9.1 Наблюдаемость**
  - **T8.1 (из backlog)**: Логирование и метрики (структурированные логи, correlation_id, базовый набор метрик).
  - **T8.2 (из backlog)**: Health‑checks (`/health` + проверки БД, MQTT, воркеров).

- **EP9.2 Миграция от `mqtt_*`**
  - **T7.1 (из backlog)**: План миграции от существующих `mqtt_*` сервисов к Processor-Hub.
  - **T7.2 (из backlog)**: Обеспечить совместимость по MQTT‑топикам и форматам на переходный период.

---

Этот список эпиков и задач должен использоваться как основа планирования реализации `processor-hub`. При изменении архитектуры (`architecture_overview.md`, `processes.md`, `event_contract.md`) epics/tasks следует синхронизировать с актуальными требованиями.

