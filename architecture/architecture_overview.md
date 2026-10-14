## Processor-Hub — обзор архитектуры

### 1. Цель и роль сервиса

**Processor-Hub** — единый сервис для работы с платежными системами и банками, который:

- **принимает события**:
  - webhooks от платежных систем (карты, банковские операции);
  - результаты polling API (карты, операции, выписки);
- **нормализует и сохраняет данные** в общую модель:
  - `bank_transactions`, `drafts`, `bank_cards`, `bank_accounts`, `bank_cards_history`, `queue`, `audit_events`, `incoming_transactions`, `outbox_events`;
- **обеспечивает гарантии**:
  - идемпотентность обработки;
  - отсутствие потери событий (outbox / incoming);
  - корректная историчность владения картами;
  - multi-DC готовность;
- **рассылает события** в другие части системы:
  - Slack‑нотификации (OTP, статусы, ошибки);
  - MQTT‑топики (`sequoia/otp`, `sequoia/transaction`, `sequoia/cards`, `sequoia/card`, `sequoia/audit` и др.) по формальному **Event Contract** (раздел 5.1 и `architecture/event_contract.md`): схемы, версионирование, обратная совместимость.

Сервис объединяет логику существующих проектов:

- `mqtt_adscards_transactions`
- `mqtt_ecards_transactions`
- `mqtt_multicards_transactions`
- `mqtt_import_by_file_transactions`
- `mqtt_stellarcards_transactions`
- `mqtt_otp_transactions_service`

и реализует их общую архитектурную модель внутри одного репозитория.

---

### 2. Высокоуровневая архитектура

**Слои Processor-Hub:**

- **API‑слой**:
  - HTTP‑эндпоинты для webhooks от платежных систем и банков;
  - **вебхук мобильных приложений** `POST /webhooks/mobile/sms`: приём JSON от мобильного приложения — либо **heartbeat** (SmsPhone: imei, phones, battery, charging, info) → upsert в `sms_devices`, либо **sms_received** (type, sender, content, recipient, …) → при необходимости определение IMEI по `sms_devices` по номеру получателя, формирование `SmsOtpPayload` и постановка в `outgoing_notifications` (channel `mqtt:sequoia/otp`); воркер исходящих уведомлений вызывает OTP-обработчик **напрямую**, без публикации в MQTT; см. `architecture/processes.md` и `src/api/routes/mobileSms.ts`;
  - внешние эндпоинты для работы с картами (выпуск/привязка/отвязка/проверка, снятие лимитов);
  - служебные эндпоинты (health, техническая диагностика).
- **Слой интеграции с провайдерами (adapters)**:
  - polling‑сервисы для провайдеров (`AdsCards`, `eCards`, `Multicards`, `StellarCards`, банки с выписками);
  - адаптеры webhooks (нормализация внешнего payload → внутренняя модель);
  - маппинг внешних полей к общим структурам (`MqttPayload`, `ParsedDraft`, `NormalizedTransaction`, `ProviderCardInput`);
  - **адаптеры не работают напрямую с БД, аудитом и MQTT**: после нормализации они вызывают доменные сервисы (`cards`/`transactions`), которые инкапсулируют:
    - upsert в `bank_cards` / `bank_transactions`;
    - запись истории владения картами;
    - постановку аудита и доменных событий в `outgoing_notifications` / `outbox_events` (без прямых вызовов `AuditService`/`MqttClient` из адаптеров).
- **Авторизационный слой (credentials + HTTP‑клиент платёжных систем)**:
  - **централизованное хранение и использование кредов**: все платёжные системы имеют свои API‑ключи, логин/пароль или токены доступа; креды хранятся и выдаются через единый слой, а не дублируются в каждом адаптере;
  - **общий HTTP‑клиент для платёжных сервисов** (`PaymentHttpClient`): адаптеры **не делают** собственный `fetch`/`axios` к API провайдеров, а используют единый клиент, который:
    - подставляет авторизацию (Bearer, Basic, custom headers) из централизованного хранилища кредов по идентификатору провайдера и, при необходимости, по `(bank, acc_no)` или `ext_id`;
    - обеспечивает единые retry, таймауты, логирование и трассировку (`correlation_id`) для всех исходящих вызовов к платёжным системам;
  - в результате: один контракт для «запроса к платёжной системе», адаптеры вызывают только доменные методы клиента (например, `getCards(bank, accNo)`, `getTransactions(bank, options)`), а не низкоуровневый HTTP.
- **Core‑слой Processor-Hub**:
  - обработчики бизнес‑процессов (см. `architecture/processes.md`);
  - маршрутизация и оркестрация событий;
  - реализация схем идемпотентности, outbox / incoming, очередей;
  - доменные сервисы:
    - `cards` — выпуск и владение картами: upsert от провайдеров (`ProviderCardInput → upsertProviderCard`), привязка/отвязка к профилю, история владения, аудит (`card_issued`, `card_linked_by_farmer` и др.);
    - `transactions` — приём нормализованных транзакций (`NormalizedTransaction`), запись в `bank_transactions`, аудит и публикация в `sequoia/transaction`.
- **Инфраструктурный слой**:
  - единый `DatabaseService` (Postgres, несколько пулов при необходимости);
  - единый `MqttClient` для работы с брокером;
  - клиенты Slack/HTTP, логирование, трассировка.

**Процессы** (из `processor_hub_business_processes.md`) реализуются как отдельные модули в Core‑слое:

- карточные операции (выпуск, привязка, OTP, транзакции);
- банковские очереди и OTP;
- pre‑transactions / drafts;
- импорт банковских выписок;
- историчность владения картами;
- аудит.

Каждый процесс описан отдельно в `architecture/processes.md` (архитектура, схемы данных, алгоритмы).

---

### 3. Инфраструктура и синглтоны

#### 3.1. Подключение к БД

- **Один `DatabaseService` на процесс** (Node‑процесс), реализованный как синглтон:
  - внутри: один или несколько `pg.Pool` для:
    - основной БД (финансы/транзакции);
    - farm‑БД (пользователи, профили);
    - при необходимости — external/sync БД;
  - инициализация пула выполняется лениво при первом запросе либо в bootstrap‑коде (`instrumentation.ts` / `index.ts`);
  - `DatabaseService` отвечает за:
    - управление соединениями;
    - переиспользование пулов;
    - централизованный graceful shutdown (закрытие пулов при SIGTERM/SIGINT).

**Требования:**

- никакие модули не создают собственные экземпляры `Pool`;
- все запросы к БД идут через `DatabaseService`;
- любые миграции/инициализация схемы также проходят через этот слой.

#### 3.2. Подключение к MQTT (асинхронные реконнекты)

- **Один `MqttClient` на процесс** (синглтон), инкапсулирующий клиент `mqtt`:
  - ленивое подключение `connect()` с кешированием промиса подключения;
  - автоматический `reconnect` с экспоненциальной или ступенчатой задержкой;
  - обработка событий `connect`, `reconnect`, `close`, `offline`, `error`;
  - конфигурируемый `keepalive`, `connectTimeout`, `reconnectPeriod`;
  - поддержка нескольких подписок на топики и роутинг сообщений по обработчикам.

**Ключевые моменты:**

- ни один модуль не создает прямые `mqtt.connect(...)` — всё проходит через общий `MqttClient`;
- `MqttClient` (целевой уровень — «устойчивый internal platform module»):
  - умеет **безошибочно переживать разрывы связи**:
    - `reconnectPeriod` включен;
    - **publish-буфер при disconnect** (очередь публикаций, flush при reconnect);
    - сообщения, которые нельзя потерять, по возможности дублируются через БД (outbox / incoming);
  - реализует **подписку и диспетчеризацию**:
    - **subscription registry** и повторная подписка при reconnect, защита от дублирования обработчиков;
    - таблица/диспетчеризация `topic → handler` с поддержкой **wildcard** (`#`, `+`) при необходимости;
  - предоставляет высокоуровневые методы:
    - `publish(topic, payload, options?)`;
    - `subscribe(topic, handler, options?)`.

**Реализация на момент 2026-03:** в `MqttClient.ts` есть синглтон, reconnect и **publish-буфер при disconnect** (сообщения буферизуются до 10k, сброс при reconnect). Subscription registry и wildcard-диспетчеризация — при необходимости; входящие по точному `handlers.get(topic)`. См. docs/implementation_progress.md.

**Гарантии:**

- потеря соединения с MQTT **не влияет** на фиксацию критических событий:
  - ingress‑события (webhook/polling) сначала пишутся в БД (`incoming_transactions`, `drafts`, `outbox_events`);
  - публикация в MQTT осуществляется поверх уже зафиксированных данных и может быть повторена.

#### 3.3. Авторизационный слой и HTTP‑клиент платёжных систем (credentials + PaymentHttpClient)

- **Один общий HTTP‑клиент для всех платёжных систем** (`PaymentHttpClient`, синглтон или фабрика по контексту):
  - адаптеры (eCards, Multicards, StellarCards, AdsCards, банки с API) **не создают** собственные экземпляры `fetch`/`axios` и не хранят креды у себя;
  - все исходящие запросы к API провайдеров идут через `PaymentHttpClient.request(options)` или доменные методы‑обёртки (`getCards`, `getTransactions`, `issueCard`, `setVelocityControl` и т.п.).
- **Централизованное использование кредов:**
  - креды (API key, login/password, токены) хранятся в защищённом хранилище (переменные окружения, секрет-менеджер, или таблица с шифрованием, например `bank_accounts`/отдельная `payment_provider_credentials` по `bank`/`acc_no`);
  - при запросе клиент по идентификатору провайдера (`bank`) и опционально контексту (`acc_no`, `card_id`) получает нужные заголовки/тело авторизации и подставляет их в запрос;
  - ротация и обновление кредов выполняются в одном месте, без правок в коде адаптеров.
- **Единое поведение для всех провайдеров:**
  - таймауты, retry (с backoff), логирование запросов/ответов и прокидывание `correlation_id` в заголовки исходящих вызовов;
  - при необходимости — метрики по провайдерам (latency, errors).
- **Итог:** авторизационный слой = «единая точка» для кредов и исходящего HTTP к платёжным системам; адаптеры содержат только бизнес‑маппинг (форматы запросов/ответов провайдера ↔ внутренняя модель), а не инфраструктуру доступа.

---

### 4. Основные таблицы данных (логическая модель)

Эта секция описывает **логическую** модель данных Processor-Hub. Физические схемы БД, индексы и ограничения подробно описаны в `architecture/processes.md` для каждого процесса.

- **`bank_transactions`** — финальные и полу-финальные транзакции (карточные и банковские):
  - `bank`, `acc_no`, `ext_id` (уникальный ключ);
  - `amount`, `currency`, `status`, `occurred_at`;
  - `buyer_email`, `profile_name`;
  - `raw` (`JSONB`) — сырой payload от провайдера (существующее поле в текущей схеме);
  - дополнительно, при необходимости (через миграции), поля `idempotency_key` и `correlation_id` для идемпотентности и трассировки;
  - служебные поля: `created_at`, `updated_at`, `processed_at`, флаги fallback и пр.

- **`incoming_transactions`** — гарантированная фиксация входящих событий (webhook / polling):
  - `id` (PK), `bank`, `acc_no`, `ext_id`;
  - `raw_payload`, `received_at`;
  - `status` (`pending`, `processing`, `processed`, `failed`), `processing_started_at`;
  - **`processing_attempts`** (int, default 0) — число попыток обработки; при превышении лимита (раздел 6.3) → `failed`, без повторного сброса в pending;
  - **`idempotency_key`** — уникальный ключ бизнес-события (раздел 5.2), например `tx:<bank>:<acc_no>:<ext_id>`; UNIQUE;
  - **`correlation_id`** — трассировка цепочки (раздел 5.2), прокидывается при записи;
  - выборка воркерами — только через Worker concurrency control (раздел 6.1); политика зависших и ядовитых — раздел 6.3.

- **`drafts`** — единый реестр pre‑transaction / OTP‑draft; **строгая схема ключей, TTL и state machine** (см. раздел 4.1):
  - `id`, `kind` (`bank_pre`, `card_pre`, `card_otp`);
  - поля по типу: `bank`, `transaction_id`, `profile_name`, `buyer_email`, `card_number`, `otp`, `amount`, `currency`;
  - `time_bucket` (TIMESTAMP или INT) — хранимое окно времени для ключей card_otp/card_pre (например, минута от `created_at`);
  - `status` — только переходы `pending` → `confirmed` | `expired`;
  - `created_at`, `expires_at` (NOT NULL, TTL для matching и архивации);
  - уникальность и upsert — строго по ключу для каждого `kind` (раздел 4.1).

- **`bank_cards` / `bank_cards_history`** — владение картами (инвариант и защита — раздел 4.2):
  - `bank_cards` хранит **текущее** состояние:
    - `card_number`, `bank`, `acc_no`, `buyer_email`, `profile_name`, `creds`, `ext_id`, др.;
    - **`is_buying BOOLEAN`** — владелец из buying‑отдела (определяется по email при любом изменении владельца: передача профиля, привязка farmer’ом, смена aff_id/группы при polling).
    - **`last_used_at TIMESTAMPTZ NULL`** — дата изъятия карты из оборота; карта с `last_used_at IS NOT NULL` не должна участвовать в выдаче свободных карт (`get-by-bin`, `free-count`, `get-bins`).
    - **`released_at TIMESTAMPTZ NULL`** — “отлёжка” карты после **release/unlink** из farm‑расширения: карта с `released_at >= NOW() - 24h` не должна участвовать в выдаче свободных карт (`get-by-bin`, `free-count`, `get-bins`). Это защищает от мгновенной повторной выдачи только что отвязанной карты как “свободной”.
  - `bank_cards_history` хранит **историю владения**:
    - `card_number`, `buyer_email`, `profile_name`, **`is_buying BOOLEAN`**, `valid_from`, `valid_to`;
    - **инвариант:** у одной карты не может быть двух активных интервалов (не более одной строки с `valid_to IS NULL` на `card_number`);
    - физическая защита: частичный уникальный индекс и транзакционное обновление «закрыть текущий → вставить новый» в одной транзакции (раздел 4.2).

- **`bank_accounts` / `queue` / `sms_phones` / `sms`** — банковские очереди, SMS‑OTP, балансы и hardware‑устройства:
  - `bank_accounts` — связь телефона / реквизитов с банком и счётом:
    - `bank`, `acc_no`, `name`, `phone`, `balance`, `currency`, `extra` и др.;
    - используется для:
      - валидации существования `(bank, acc_no)` при `/queue/acquire`;
      - сопоставления входящих SMS‑OTP по `phone` → `(bank, acc_no)` (раздел 3.2, SmsParser);
      - REST‑методов управления балансами и лимитами (`/balances`, `/balances/update-balance`, `/balances/add-balance`, `/balances/update-limits`, `/balances/update-credentials`, `/balances/history`);
      - отчётов/балансов по банковским аккаунтам и контроля лимитов.
  - `queue` — захват очереди:
    - `email`, `bank`, `acc_no`, `expires_at`, `notification_sent`;
    - обслуживается REST‑методами `/queue/acquire`, `/queue/release`, `/queue/credentials`, `/queue/kick-off`, `/queue/status` (по образцу `mqtt_otp_transactions_service`), при этом сами воркеры всегда работают через БД (без прямых Slack‑вызовов).
  - `sms_phones` — реестр физических SMS‑устройств (по аналогии с `SmsPhones` в `adscards-webhook`):
    - ключ `imei` (PRIMARY KEY), поля о батарее, состоянии зарядки, времени последнего обновления, наборах привязанных телефонов `phones[]`, доп.инфо `info JSONB`;
    - используется для мониторинга парков устройств и для поиска устройства по номеру телефона, если в сыром SMS нет IMEI.
  - **`sms_devices`** — реестр **мобильных** устройств (тип SmsPhone из `adscards-webhook`):
    - ключ `imei` (PRIMARY KEY), `phones` (TEXT[]), `battery`, `charging`, `info` (JSONB), `tg_chat`, `updated_at`;
    - обновляется по вебхуку **`POST /webhooks/mobile/sms`** при приходе heartbeat (SmsPhone); по номеру получателя ищется IMEI для входящих SMS без IMEI;
    - миграция: `*_sms_devices.sql`.
  - `sms` — таблица сырых SMS от устройств (по аналогии с `Sms` в `adscards-webhook`):
    - `id`, `imei`, `created_at`, `type` (`sms_received` и т.п.), `content`, `sender`, `recipient`, служебные атрибуты;
    - служит источником для дальнейшего парсинга через `SmsParser` и построения `SmsOtpPayload` / других OTP‑событий.

- **`outbox_events`** — outbox‑шаблон для событий (например, `profile_transferred_to_buyer`):
  - `id`, `event_type`, `payload` (структурировано, не только `JSON`);
  - `occurred_at`, `status` (`pending`, `processing`, `processed`, `failed`), `processing_started_at`;
  - **`processing_attempts`** (int, default 0) — число попыток обработки; при превышении лимита (раздел 6.3) → `failed`;
  - **`correlation_id`** — приходит от источника события, прокидывается воркером в аудит/MQTT/outgoing (раздел 5.2);
  - выборка воркерами — только через Worker concurrency control (раздел 6.1); политика зависших и ядовитых — раздел 6.3.

- **`audit_events`** — общий аудит:
  - `id`, `event_type`, `payload`, `created_at`, `correlation_id`.

- **`spends`** — агрегированная аналитика расходов по карточным пополнениям (eCards):
  - назначение: хранить результат reconciliation между `finance0_ext.funds_from_account`, `bank_cards` и `bank_transactions` для сценариев «пополнение с карты / расход по карте»;
  - текущий источник: batch-скрипт `src/bin/buildEcardsFundsCardStats.ts`;
  - ключ уникальности (upsert): `(card_number, buyer, bank)`, где в текущем сценарии `bank = 'ecards'`;
  - основные поля:
    - идентификация: `card_number`, `buyer`, `bank`;
    - агрегаты транзакций: `bank_transactions_total_amount_usd`, `bank_transactions_debit_amount_usd`, `bank_transactions_refund_amount_usd`, `bank_transactions_count`;
    - агрегаты пополнений: `funds_amount_usd_total`, `funds_profiles` (`text[]`);
    - `payload` (`jsonb`) — снимок текущего агрегированного состояния для диагностики/интеграций;
    - служебные: `created_at`, `updated_at`;
  - требования к upsert:
    - `funds_profiles` объединяются как множество (`existing ∪ incoming`) с устранением дублей;
    - `funds_amount_usd_total` накапливается инкрементально (`existing + incoming_row_amount_usd`);
    - транзакционные агрегаты карты (`bank_transactions_*`) обновляются актуальным срезом по `bank_transactions`, где траты считаются по правилу `amount < 0` (а не net-суммой всех движений);
    - `payload` синхронизируется с итоговым состоянием строки после merge.
  
- **`polling_leases`** — координация поллинга карт/транзакций между инстансами:
  - `id TEXT PRIMARY KEY` — идентификатор поллера (`ecards.transactions`, `ecards.cards`, `adscards.transactions`, `stellarcards.cards`, `multicards.transactions` и т.п.);
  - `holder TEXT` — идентификатор инстанса (обычно `<hostname>:<pid>` или `INSTANCE_ID` из конфига);
  - `acquired_at TIMESTAMPTZ`, `expires_at TIMESTAMPTZ`;
  - индекс по `expires_at` для уборки протухших lease.

#### 4.1. Drafts: уникальные ключи по kind, TTL, state machine (must-have)

Без формализации ключей и срока жизни таблица `drafts` превращается в «кладбище» записей: растёт объём, падает скорость matching при импорте выписок, возможны коллизии при upsert.

**Уникальные ключи (для upsert и дедупликации):**

| `kind`      | Уникальный ключ (логический) | Реализация в БД |
|------------|-------------------------------|------------------|
| `bank_pre` | Один draft на операцию в банке | `UNIQUE(bank, transaction_id)`. При upsert: `INSERT ... ON CONFLICT (bank, transaction_id) DO UPDATE` (обновлять только разрешённые поля, не трогать `id`). |
| `card_otp` | Один OTP на карту в окне времени | `UNIQUE(bank, card_number, otp, time_bucket)`, поле `time_bucket` хранится при вставке (например, `date_trunc('minute', NOW())`). Если `card_number` не известен: `UNIQUE(bank, payload_hash)` с `payload_hash = hash(profile_name, otp, time_bucket)`. |
| `card_pre` | Pre-транзакция по профилю/OTP      | `UNIQUE(profile_name, otp, time_bucket)` или `UNIQUE(bank, payload_hash)`; при наличии клиентского `transaction_id` — `UNIQUE(bank, transaction_id)`. |

Все запросы matching (импорт выписок, подтверждение транзакций) должны использовать эти же ключи: поиск по `(bank, transaction_id)` для `bank_pre`, по `(bank, card_number?, otp, time_bucket)` или `payload_hash` для card-типов.

**Срок жизни (TTL) и архивация:**

- У каждой записи в `drafts` есть **`expires_at`** (NOT NULL):
  - `bank_pre`: например `created_at + 7 дней` (ожидание выписки);
  - `card_otp` / `card_pre`: например `created_at + 24 часа` (OTP и привязка к транзакции в течение суток).
- Matching при импорте выписок и при подтверждении транзакций учитывает только записи с `expires_at > NOW()` и `status = 'pending'` (либо явно включаем недавно истёкшие, например `expires_at > NOW() - 1 hour`, по политике).
- **Фоновый job (архивация):** периодически (раз в сутки/час) переводит записи с `expires_at < NOW()` в `status = 'expired'` и/или переносит в архивную таблицу `drafts_archive` (опционально), после чего удаляет из `drafts` или оставляет с `status = 'expired'` и исключает из поиска по умолчанию. Так таблица `drafts` не раздувается, индексы остаются по «горячим» данным.

**State machine:**

- Допустимые переходы:
  - `pending` → `confirmed` (draft сопоставлен с выпиской/транзакцией);
  - `pending` → `expired` (истёк `expires_at` или явная пометка архивным job’ом).
- Записи в `confirmed` и `expired` в обычном matching не участвуют (фильтр по `status = 'pending'` и, при необходимости, по `expires_at`). Повторный upsert по тому же уникальному ключу для `pending` — идемпотентное обновление полей; попытка перевести уже `confirmed`/`expired` не меняет статус (или возвращает ошибку по политике).

**Итог:** ключи по `kind` заданы однозначно; TTL через `expires_at` и архивация ограничивают рост таблицы; state machine исключает «мёртвые» записи из активного поиска и снижает latency. **Matching всегда ограничен по времени (TTL)** — иначе pre-transaction начнёт матчиться «по сумме» с чем угодно спустя недели (риск №3 в разделе 9).

#### 4.2. Bank_cards_history: инвариант «один активный интервал на карту» (must-have)

**Инвариант:** для одного `card_number` не может существовать двух строк с `valid_to IS NULL` («текущий» владелец единствен). Иначе запрос «чья карта сейчас» и «на дату» даёт неоднозначность; при multi-worker возможны гонки и две «текущие» записи.

**Физическая защита (обязательно одна из двух или обе):**

1. **Частичный уникальный индекс (рекомендуется):**
   ```sql
   CREATE UNIQUE INDEX uq_bank_cards_history_one_active_per_card
   ON bank_cards_history (card_number) WHERE valid_to IS NULL;
   ```
   Тогда вставка второй строки с `valid_to IS NULL` для того же `card_number` приведёт к нарушению уникальности и ошибке. Чтобы не получать ошибку в нормальном потоке, перед каждой вставкой новой «текущей» записи нужно в той же транзакции закрыть предыдущую (см. ниже).

2. **Транзакционное обновление «закрыть текущий → вставить новый»:**
   - В **одной транзакции** выполнять:
     1. `SELECT id FROM bank_cards_history WHERE card_number = $1 AND valid_to IS NULL FOR UPDATE` — заблокировать активную строку (если есть);
     2. `UPDATE bank_cards_history SET valid_to = NOW() WHERE card_number = $1 AND valid_to IS NULL`;
     3. `INSERT INTO bank_cards_history (card_number, bank, buyer_email, profile_name, is_buying, valid_from, valid_to) VALUES (..., NOW(), NULL)`.
   - Благодаря `FOR UPDATE` второй воркер не сможет вставить вторую активную строку до коммита первого; после коммита первого активная запись уже одна (новая). Частичный уникальный индекс дополнительно гарантирует инвариант на уровне БД даже при сбоях логики.

**Итог:** все места, меняющие владение картой (привязка 2.2, передача профиля 2.4, смена владельца при polling 2.1), обязаны выполнять «close previous, then insert» в одной транзакции и полагаться на частичный уникальный индекс; без этого multi-worker может создать две активные записи на одну карту.

**Поле `is_buying`:** при любом изменении владельца карты (`buyer_email`) в `bank_cards` и во вставляемой строке `bank_cards_history` выставляется **`is_buying`**: по email сотрудника определяется, принадлежит ли он к buying‑отделу (справочник email→department, роль в `tbl_users` или аналог). При передаче профиля от farm к buying новый владелец — баер → `is_buying = true`; при привязке farmer’ом — как правило `is_buying = false`; при смене владельца из‑за изменения aff_id/группы при polling — по новому buyer_email. Так в истории и в текущем состоянии всегда видно, была ли карта у buying на данном интервале.

**Целевая реализация:** единая доменная точка **CardOwnershipService** — все операции, меняющие владение или записывающие историю (issuance, farmer link, transfer to buyer, dead profile unlink, обновление current owner), вызываются только через неё; инварианты и запросы (кто владел в момент времени, текущий владелец, история передач) — в одном месте. **Текущее состояние (2026-03):** реализованы таблица bank_cards_history, колонка is_buying и функция **setCardOwnership**; все смены владельца (get-by-bin, profileAuthChangeWorker, unlink) вызывают её и пишут историю. Полная централизация в CardOwnershipService (запросы «кто владел в момент X», единый слой) — EPIC 8; см. docs/implementation_progress.md § «Домен владения картами (ownership)».

---

#### 4.3. Требования к адаптерам платёжных систем (ecards, multicards, stellarcards, adscards)

Для каждого платёжного сервиса (`ecards`, `multicards`, `stellarcards`, `adscards`) в `processor-hub` действует единый набор требований. Адаптеры этих систем реализуются в модулях `modules/cards`, `modules/transactions`, `modules/otp` и работают с общей моделью данных (`bank_cards`, `bank_cards_history`, `bank_transactions`, `drafts`) и Event Contract (раздел 5.1).

**Обязательное правило по авторизации и HTTP:** все исходящие вызовы к API платёжных систем выполняются **только** через общий `PaymentHttpClient` (раздел 3.3). Адаптеры не используют собственный `fetch`/`axios` и не хранят креды; авторизация подставляется централизованно из слоя кредов.

1. **Выпуск карт для выбранного БИН**
   - Адаптер должен уметь выпускать карты по заданному BIN (или набору BIN’ов) через API провайдера.
   - Каждая новая карта фиксируется в `bank_cards` (idempotent upsert по `(bank, ext_id)` или `(bank, card_number)`):
     - `bank`, `card_number`, `acc_no`, `ext_id`, `creds`, `note`, `created_at`;
     - изначально: `buyer = NULL`, `profile_name = NULL`, `is_buying = NULL/false`.
   - По результатам выпуска публикуется событие `sequoia/cards` по контракту (список новых карт) и пишется аудит `card_issued`.

2. **Поллинг карт с кредами, сохранение и поиск баера для именных карт**
   - Адаптер периодически опрашивает провайдера на предмет **списка активных карт** с реквизитами (card_number, card_id/ext_id, BIN, группа/acc_no, статусы, лимиты и т.п.).
   - Данные нормализуются и сохраняются в `bank_cards` и, при необходимости, в `cards_info`:
     - креды шифруются и кладутся в `creds`;
     - `acc_no` определяется по правилам (aff_id/группа/спец. значения, например `FEBRUARY`/`farm`).
   - Для **именных карт** (задана группа и есть `aff_id` в `binom`):
     - по `aff_id` находится `buyer` (email) через общий модуль `modules/binom` (таблица `binom`); по email определяется `is_buying` (принадлежность к buying‑отделу);
     - `bank_cards.buyer`, `bank_cards.is_buying` обновляются, а изменения фиксируются в `bank_cards_history` по общим правилам (раздел 4.2).
   - Поллинг **не удаляет** карты, а только обновляет их состояние; архив/удаление решается отдельной политикой.

3. **Получение OTP (если платёжный сервис поддерживает)**
   - Если провайдер отдаёт OTP (SMS/3DS/коды из описания транзакции):
     - адаптер обязан формировать события в `sequoia/otp` по контракту `OtpPayload`:
       - `source` (`adscards` / `ecards` / `multicards` / `stellarcards` / `sms`);
       - `otp`/`code`, `card_number`/`cardId`, `amount`/`currency`, `raw`;
       - при наличии — `buyer` + `is_buying`.
     - используется `idempotency_key` вида `otp:<source>:<card>:<otp>:<time_bucket>`, чтобы не дублировать одну и ту же OTP‑сессию.
   - Специализация по провайдерам:
     - **ecards** — отдельный фоновый poller (`modules/transactions/adapters/ecards/otp.ts`, метод `startOtpPolling` адаптера), который периодически вызывает HTTP API `/codes` через `PaymentHttpClient`, для новых записей формирует `EcardsOtpPayload` и ставит MQTT‑нотификации в `outgoing_notifications` с каналом `mqtt:sequoia/otp` и idempotency‑ключом вида `otp:ecards:<card_number|card_id>:<otp>:<time_bucket>`;
     - **adscards** и **stellarcards** — получение OTP через вебхуки провайдера (по образцу `adscards-webhook`), далее формирование соответствующих `OtpPayload` и публикация в `sequoia/otp`;
     - **multicards** — собственных OTP не отдаёт, адаптер не генерирует `sequoia/otp` для этого банка.

4. **Поллинг транзакций и (если поддерживает провайдер) вебхуки на операции**
   - **Поллинг:**
    - периодический опрос API провайдера по операциям за “скользящее окно” (последние N минут/часов или по курсору/ID);
    - для карточных транзакций **обязательное требование**: адаптеры не должны без ограничений перечитывать весь дневной/исторический поток; поллинг ограничивается окном давности, задаваемым конфигом (`transactionsPollingWindowHours`, по умолчанию 24 часа), и при достижении транзакции старше этого окна цикл поллинга для данного запуска прекращается;
     - каждая операция нормализуется до `TransactionEventPayload` и:
       - записывается в `incoming_transactions` с `idempotency_key = tx:<bank>:<acc_no>:<ext_id>`;
       - воркер (раздел 2.6 `processes.md`) делает upsert в `bank_transactions`, определяет `buyer`/`profile_name` по `bank_cards`/`bank_accounts` и, при необходимости, через drafts/fallback;
       - при необходимости ставит событие в `outgoing_notifications` для публикации в `sequoia/transaction`.
   - **Вебхуки (если провайдер их шлёт):**
     - HTTP‑эндпоинты принимают события реального времени, но **всё равно** сначала пишут в `incoming_transactions` (с тем же idempotency_key), а не напрямую в `bank_transactions`;
     - повторные вебхуки по той же операции обрабатываются идемпотентно (через upsert).
   - **OTP из транзакций (если применимо):**
     - если OTP/Google‑код содержится в описании транзакции, адаптер извлекает его и формирует OTP‑payload (с `buyer`/`is_buying`, если известны) в `sequoia/otp` через `outgoing_notifications` или через drafts/ParsedDraft.

Таким образом, каждый платёжный адаптер реализует одинаковый контракт по выпуску карт, поллингу карт и транзакций, OTP и публикации событий, опираясь на общую модель (`buyer` + `is_buying`) и Event Contract. Это устраняет расхождения между сервисами `ecards`, `multicards`, `stellarcards`, `adscards` и упрощает их дальнейшую эволюцию.

---

- **`outgoing_notifications`** — mini-outbox для исходящих side-effects (Slack, MQTT); гарантии «не задвоить» и retry (см. раздел 6.2):
  - `id`, `channel` (slack_channel / dm / mqtt_topic);
  - `recipient` (user_id, email, или пусто для канала/MQTT);
  - `payload_hash` — хеш тела сообщения (дедупликация); уникальность по `(channel, recipient, payload_hash)` или по отдельному `dedup_key`;
  - **`dedup_key`** (раздел 5.2) — единственный ключ идемпотентности нотификации, UNIQUE; формат по типу события (OTP, tx, audit…);
  - **`correlation_id`** — связь с цепочкой обработки (из incoming/outbox), для трассировки;
  - `payload JSONB` — тело уведомления;
  - `status` (`pending`, `sending`, `sent`, `failed`, `rate_limited`);
  - `attempts INT DEFAULT 0`, `max_attempts INT`;
  - `next_retry_at TIMESTAMP NULL` — когда повторить при retry/rate limit;
  - `sent_at TIMESTAMP NULL`, `last_error TEXT`;
  - выборка воркером — через Worker concurrency control (FOR UPDATE SKIP LOCKED + `status = 'sending'`).

---

### 5. Потоки данных и взаимодействие с провайдерами

#### 5.0. Двухслойная шина: правило разделения (must-have)

У Processor-Hub фактически **двухслойная шина**:

1. **Внутренняя шина (source of processing):** таблицы `incoming_transactions`, `outbox_events`, `outgoing_notifications` — гарантированный event-log, **откуда воркеры берут работу** и где обеспечиваются гарантии доставки, идемпотентности и retry.
2. **Внешняя шина (distribution bus):** топики MQTT по Event Contract — **оповещение подписчиков**, real-time интеграции, доставка событий наружу.

**Жёсткое правило:** MQTT — это **только distribution** (публикация после фиксации в БД через `outgoing_notifications`). **Нельзя** строить обработку на принципе «подписались на MQTT и пишем обратно в БД / запускаем бизнес-логику»: это создаёт петли, дубли и потерю гарантий. Вся обработка берёт работу **только** из внутренней шины (incoming_transactions, outbox_events); публикация в MQTT — следствие успешной обработки через `outgoing_notifications`.

**Итого:** внутренняя шина = источник правды для воркеров; MQTT = канал доставки наружу, не «истина» для обработки.

---

**Внутри Processor-Hub «шина» = три event-stream'а:**

- **`incoming_transactions`** — всё, что пришло извне (webhook, polling и т.п.) и требует обработки.
- **`outbox_events`** — события, появившиеся внутри домена (например «профиль передан баеру»), которые нельзя потерять.
- **`outgoing_notifications`** — всё, что должно уйти наружу (Slack, MQTT), с дедупом и retry.

**MQTT — внешняя шина доставки**, но не источник работы для воркеров.

---

**Внешние источники:**

- платежные системы (AdsCards, eCards, Multicards, StellarCards и др.);
- банки (выписки, SMS / OTP, API);
- внутренние сервисы (farm-extension, UI, другие микросервисы).

**Основные направления потоков:**

- **Webhook → Processor-Hub**:
  - HTTP‑запрос приходит в API‑эндпоинт;
  - payload валидируется и нормализуется в внутреннюю модель (`IncomingWebhookEvent`);
  - в рамках транзакции пишется запись в `incoming_transactions` или `outbox_events`;
  - worker Processor-Hub асинхронно обрабатывает запись:
    - нормализация в `NormalizedTransaction` или `ParsedDraft`;
    - upsert в `bank_transactions` / `drafts`;
    - дополнительные вычисления (buyer, profile_name, fallback);
    - публикация в MQTT и аудит.
  - интеграция **Google Ads script + farm‑расширение** (`src/api/routes/google.ts`):
    - **farm‑расширение:** `GET /google/account?profile_name=...` — выдаёт обфусцированный Google Apps Script, **уникальный для профиля** (подстановка `profile_name`);
    - **farm‑расширение:** `POST /google/account/set` — передача `profile_name` и `account_id` (`XXX-XXX-XXXX`); при первичной привязке выставляет `farm_ext.tbl_profiles.account_id`, если оно было `NULL`;
    - **скрипт в Google Ads** (запуск **раз в час**): `POST /google/account` — метрики и поле `version`; запись в `public.google_account_logs` и обновление **`tbl_profiles.account_id`** и **`tbl_profiles.script_version`**; **наличие `script_version` у профиля трактуется как «скрипт установлен и уже отчитался»**.

- **Polling → Processor-Hub**:
  - фоновые poller‑сервисы опрашивают API провайдеров;
  - опрос выполняется только за ограниченное “скользящее окно” транзакций (по умолчанию последние 24 часа, параметр `transactionsPollingWindowHours` в конфиге); при встрече транзакции старше этого окна адаптер завершает текущий цикл поллинга и не идёт дальше в прошлое;
  - для каждой операции в этом окне:
    - сначала сохраняется `incoming_transactions` (аналогично webhook’ам);
    - затем worker обрабатывает backlog `pending`.

- **DB outbox → Processor-Hub**:
  - изменения в основных доменных таблицах (например, `tbl_profiles`) пишут записи в `outbox_events`;
  - worker Processor-Hub периодически читает `pending` события и выполняет бизнес‑логику (обновление владельцев карт, очередей и т.п.).

- **Текущий пользователь профиля (Farm DB)**:
  - запросы от Taurus и farm-расширения идут через Open ID; в JWT только `profile_id`/`profile_name`, **email не передаётся**;
  - кто сейчас работает с профилем (фармер или баер) и его email определяются **только** каноническим запросом к Farm DB (`tbl_profiles` + `tbl_profile_access_grant` + `tbl_users`); см. **`architecture/profile_current_user.md`**.
  - для карточных транзакций с маркером `GOOGLE*ADS##########` определение `profile_name`/email идёт приоритетно через `google_account_logs.account_id` → `getCurrentUserByProfileName()`, и только затем через `bank_cards`/fallback.

- **Processor-Hub → MQTT / Slack / др.**:
  - все исходящие уведомления (Slack DM/каналы, публикации в MQTT) идут **через таблицу `outgoing_notifications`** (раздел 6.2): запись в БД → отдельный воркер отправляет и обновляет статус; так обеспечиваются дедупликация, retry и безопасность при multi-DC.

#### 5.1. Event Contract (MQTT) — формальный контракт событий (must-have)

Поскольку Processor-Hub становится **единой точкой** приёма и публикации событий, топики MQTT (`sequoia/otp`, `sequoia/transaction`, `sequoia/cards`, `sequoia/card`, `sequoia/audit` и др.) должны иметь формальный контракт: схемы, версионирование и правила обратной совместимости. Иначе разнородные форматы из соседних проектов и будущие изменения приведут к поломкам подписчиков и дублированию логики парсинга.

**Обязательные элементы контракта:**

1. **Общий envelope для каждого сообщения** (рекомендуется для всех исходящих от Processor-Hub, в перспективе — для входящих):
   - **`schema_version`** (number) — версия схемы payload (1, 2, …); при несовместимых изменениях увеличивается.
   - **`producer`** (string) — идентификатор производителя события (`processor-hub`, `adscards`, `multicards`, `ecards`, `stellarcards`, `sms` и т.д.).
   - **`occurred_at`** (string, ISO8601) — момент возникновения события в источнике.
   - **`idempotency_key`** (string, опционально) — ключ идемпотентности (например `tx:<bank>:<acc_no>:<ext_id>` для транзакций, `otp:<source>:<card>:<otp>:<time_bucket>` для OTP).
   - **`correlation_id`** (string, опционально) — для трассировки цепочки запросов и аудита.
   - **`payload`** (object) — тело события; структура определяется топиком и `schema_version`.

2. **JSON‑schema или TypeScript‑интерфейсы по каждому топику** — единый справочник форматов:
   - `sequoia/otp` — OTP по картам/банкам (источники: adscards, ecards, multicards, stellarcards, sms); дискриминатор `source`, поля по типу источника.
   - `sequoia/transaction` — нормализованные карточные транзакции (bank, ext_id, acc_no, amount, currency, buyer, card_number, otp, raw, …).
   - `sequoia/cards` — события выпуска карт (массив карт, source, timestamp).
   - `sequoia/card` — команды картам (action: remove_limits, card_number, **buyer** — как в bank_cards; единая модель buyer + is_buying в контракте).
   - `sequoia/audit` — аудит (id, timestamp, division, user_email, log_type, severity, event_type, event_attributes).

3. **Версионирование (schema_version):**
   - обратно совместимые изменения (новые опциональные поля) — версию не менять;
   - несовместимые (удаление/переименование полей, смена типа обязательного поля) — увеличить `schema_version` и описать миграцию.

4. **Правила обратной совместимости:**
   - **Приём:** если сообщение приходит с envelope — парсить `payload` по `schema_version`; если без envelope (голый JSON) — считать legacy, `schema_version = 1`, тело = весь JSON (существующие провайдеры продолжают работать).
   - **Публикация:** Processor-Hub всегда оборачивает исходящие сообщения в envelope с `schema_version`, `producer`, `occurred_at`; не удалять и не переименовывать существующие поля в payload; новые поля только опциональные.

Полное описание контракта: **типы по топикам, примеры envelope, таблица топиков** — в отдельном документе `architecture/event_contract.md`. Реализация должна опираться на общий envelope и справочник схем при публикации и при парсинге входящих сообщений.

#### 5.2. Correlation / Idempotency model — единая модель сквозняком (must-have)

Чтобы не было разночтений между модулями («кто как генерит ключи» и «почему задвоилось»), ниже зафиксирована **одна** модель для всех ключей трассировки и идемпотентности. Все компоненты Processor-Hub обязаны её соблюдать.

**1. Correlation ID (трассировка одной цепочки)**

- **Что это:** один идентификатор на всю цепочку обработки одного входящего события (один webhook-запрос, один outbox-ивенент, один результат polling-цикла по одной операции).
- **Кто генерирует:** единственная точка — **первый вход в систему**:
  - HTTP webhook / API: генерирует **приёмник запроса** (middleware или первый обработчик), если клиент не передал заголовок `X-Correlation-Id` (или аналог); иначе — прокидывать значение клиента;
  - outbox: генерирует **источник события** (внешняя БД/приложение) при записи в `outbox_events`; Processor-Hub не генерирует, только прокидывает;
  - polling: генерирует **poller** в момент «создания» логического события (одна операция провайдера → один correlation_id).
- **Формат:** строка, уникальная в разумных пределах времени и DC; рекомендуется **UUID v4** или префиксный вид `ph-<uuid>` (ph = processor-hub), чтобы в логах и аудите сразу видеть источник.
- **Где прокидываем:** во всех записях и сообщениях, относящихся к этой цепочке:
  - при записи в `incoming_transactions` — поле `correlation_id` (если есть);
  - в `outbox_events` — уже приходит с событием;
  - при обработке воркером — брать из обрабатываемой записи и передавать дальше;
  - в `audit_events` — всегда заполнять `correlation_id` из контекста обработки;
  - в MQTT envelope (раздел 5.1) — поле `correlation_id`;
  - при вставке в `outgoing_notifications` — поле `correlation_id` (для связи уведомления с цепочкой).
- **Итог:** по одному `correlation_id` можно собрать все записи и сообщения одной цепочки (incoming → обработка → bank_transactions/drafts → audit, outgoing, MQTT).

**2. Idempotency key для incoming_transactions**

- **Что это:** ключ **бизнес-уникальности** одной логической транзакции (одна операция в платёжной системе = одна запись при повторных доставках).
- **Кто генерирует:** модуль ingest (webhook-handler или poller) в момент первой фиксации события.
- **Формат:** детерминированный по данным события, например `tx:<bank>:<acc_no>:<ext_id>` или `hash(bank, acc_no, ext_id)` (единый формат в коде — один helper, без вариаций по модулям).
- **Где хранится:** `incoming_transactions.idempotency_key`, UNIQUE в таблице; при `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` повторный webhook/poll не создаёт вторую строку.
- **Связь с correlation_id:** одна запись `incoming_transactions` имеет один `idempotency_key` и один `correlation_id`; при повторной доставке того же события (тот же idempotency_key) новая строка не создаётся, то есть второй correlation_id не появляется — цепочка одна.

**3. Idempotency для outbox_events**

- **Что это:** гарантия, что одно и то же исходящее событие (например, «профиль передан баеру») не обработается дважды с разным результатом.
- **Ключ уникальности:** задаётся источником outbox (внешняя система): обычно **`correlation_id`** события или составной ключ `(event_type, payload_hash)` / `(event_type, unique_field_from_payload)`. В таблице `outbox_events` — уникальный constraint или проверка при вставке со стороны источника; Processor-Hub при обработке не генерирует idempotency, а читает запись по id и помечает processed.
- **Связь:** один outbox-ивенент = один `correlation_id` (приходит извне); воркер при обработке прокидывает этот `correlation_id` в аудит, в `outgoing_notifications` и в MQTT.

**4. Dedup_key для outgoing_notifications**

- **Что это:** ключ **идемпотентности одной логической нотификации** (одно и то же сообщение в Slack/MQTT не должно быть отправлено дважды).
- **Кто генерирует:** бизнес-модуль в момент постановки уведомления в `outgoing_notifications` (правила в разделе 6.2): один формат на тип события (OTP по карте, OTP от банка, публикация транзакции в MQTT и т.д.).
- **Формат:** строка по соглашению, например `otp:card:<bank>:<acc_no>:<card_number>:<otp>:<time_bucket>`, `mqtt:tx:<bank>:<acc_no>:<ext_id>`, `audit:<event_type>:<correlation_id>` (если нужна дедупликация аудита). Единый справочник форматов — в коде один модуль/константы, без дублирования формул в разных сервисах.
- **Где хранится:** `outgoing_notifications.dedup_key`, UNIQUE; при `INSERT ... ON CONFLICT (dedup_key) DO NOTHING` повторная постановка той же нотификации не создаёт вторую запись.
- **Связь с correlation_id:** запись в `outgoing_notifications` хранит также `correlation_id` (из контекста обработки); по нему можно связать уведомление с цепочкой (incoming/outbox → обработка → эта нотификация). Дедупликация при этом идёт по `dedup_key`, а не по `correlation_id` (одна цепочка может породить несколько разных уведомлений с одним correlation_id).

**5. Как ключи связаны между собой (один trace на цепочку)**

- **Идеал:** одна логическая «операция извне» имеет один **correlation_id**. Он генерируется один раз при входе (или приходит с outbox) и прокидывается во все таблицы и сообщения: `incoming_transactions`, `outbox_events`, `audit_events`, `outgoing_notifications`, MQTT envelope. По нему можно собрать полный след.
- **idempotency_key** (incoming) и **dedup_key** (outgoing) — это **разные** цели: первый гарантирует «одна транзакция провайдера = одна запись в incoming», второй — «одно логическое уведомление = одна запись в outgoing и одна отправка». Оба могут присутствовать в одной цепочке: у одной записи incoming один correlation_id и один idempotency_key; обработка создаёт записи в outgoing с тем же correlation_id, но каждая запись outgoing имеет свой dedup_key.
- **Правило для реализации:** в коде один модуль/слой отвечает за генерацию correlation_id при ingress; один helper — за вычисление idempotency_key для incoming; один справочник/helper — за формат dedup_key по типу уведомления. Модули не изобретают свои форматы — только используют общие.

#### 5.3. Dev simulation (dev-контур)

В среде разработки и тестирования **внешние события** (платежи, OTP, SMS, Taurus и т.д.) можно подавать **без подключения к реальным провайдерам** через единый слой инъекции — **Dev Inbox**.

**Принцип:** все внешние взаимодействия в dev симулируются через таблицу **`dev_inbox_events`**. События вставляются вручную (API или фикстуры) и обрабатываются тем же пайплайном, что и в проде: воркер не пишет в доменные таблицы напрямую, а вызывает те же сервисы (ingest транзакций, аудит, outgoing).

**Цепочка:**

1. **Ingress:** `POST /dev/inbox-events` (тело: `source`, `event_type`, `payload` [, `correlation_id`, …]) — запись в `dev_inbox_events` со статусом `pending`.
2. **DevInboxWorker** (фоновый цикл): в транзакции забирает `pending` (FOR UPDATE SKIP LOCKED), переводит в `processing`, затем для каждой записи вызывает **Dev Dispatcher**.
3. **Dev Dispatcher:** по паре `(source, event_type)` маршрутизирует вызовы в те же прикладные сервисы, что и реальные адаптеры (например, для платёжных источников и `transaction_created` — `ingestRawTransaction`; остальные типы — no-op с пометкой processed).
4. По завершении: `markDevInboxProcessed` или `markDevInboxFailed`.

**Включение:** только при `config.devSimulation.enabled === true` (в проде — всегда выключено: `NODE_ENV=production` или `DEV_SIMULATION_ENABLED=false`). При включении регистрируются маршруты `/dev/inbox-events`, `/dev/inbox-events/:id/replay` и стартует DevInboxWorker.

**Документация:** [processor_hub_dev_simulation_spec.md](../docs/processor_hub_dev_simulation_spec.md), [dev_simulation_concept.md](../docs/dev_simulation_concept.md). Фикстуры — каталог `dev-fixtures/`, state machine — [state_machines.md](../docs/state_machines.md) § dev_inbox_events.

---

### 6. Идемпотентность и отказоустойчивость

- **Идемпотентность входящих событий:** единая модель ключей — раздел 5.2.
  - `incoming_transactions.idempotency_key` (формат по 5.2) гарантирует одну запись на одно бизнес-событие;
  - в `bank_transactions` ключ `(bank, acc_no, ext_id)`;
  - повторные webhooks / результаты polling не создают дубликатов, а обновляют существующие записи.

- **Идемпотентность действий по профилям и картам:** correlation_id и уникальность outbox — раздел 5.2.
  - `outbox_events` — уникальность задаётся источником (correlation_id или payload‑ключ);
  - worker может безопасно повторять обработку:
    - обновление владельца карты;
    - запись в историю владения;
    - отправка Slack/MQTT — только через **`outgoing_notifications`** (раздел 6.2), без прямых вызовов из воркера.

- **Сбой MQTT / Slack / внешних сервисов:**
  - основная инварианта: **сначала БД, потом внешние побочные эффекты**;
  - при сбоях во внешних интеграциях:
    - состояния в БД уже зафиксированы;
    - повторные попытки или реконсиляция могут быть выполнены без нарушения идемпотентности.

- **Multi-DC и горизонтальное масштабирование:**
  - все ключевые операции используют:
    - уникальные ключи (БД);
    - idempotency‑ключи;
    - **Worker concurrency control** (см. ниже) — для воркеров `incoming_transactions` и `outbox_events`;
    - при необходимости advisory‑locks для точечных операций.
  - несколько экземпляров Processor-Hub могут параллельно обрабатывать **разные** записи из `incoming_transactions` / `outbox_events` только при соблюдении механизма конкурентной выборки.

#### 6.1. Worker concurrency control и транзакционные границы (must-have)

Воркеры, обрабатывающие таблицы **`incoming_transactions`** и **`outbox_events`**, не должны использовать простой `SELECT ... WHERE status = 'pending' LIMIT N`: два и более инстансов (в т.ч. в multi-DC) тогда возьмут одни и те же строки. Идемпотентность на уровне `bank_transactions` защитит от дублей в БД, но **не** защитит от:

- дублирования сообщений в Slack и MQTT;
- гонок при обновлении истории владения картами (`bank_cards_history`);
- дублирования записей в аудите.

**Обязательный механизм** — эксклюзивная выборка «одна запись — один воркер». Допустимы два подхода (на выбор реализации):

1. **`SELECT ... FOR UPDATE SKIP LOCKED` + обновление статуса в одной транзакции**
   - В одной транзакции:
     - `SELECT id, ... FROM incoming_transactions WHERE status = 'pending' ORDER BY id LIMIT N FOR UPDATE SKIP LOCKED`;
     - для выбранных строк: `UPDATE incoming_transactions SET status = 'processing', processing_started_at = NOW() WHERE id = ANY($1)`;
     - коммит транзакции.
   - Обработка выполняется **после** коммита по уже зафиксированному набору id; по завершении — `UPDATE ... SET status = 'processed'` (или `failed`).
   - Аналогично для `outbox_events`: выборка по `event_type` и `status = 'pending'`, затем `status = 'processing'`, коммит, обработка, финальный `processed`.
   - `SKIP LOCKED` гарантирует, что строки, заблокированные другим инстансом, не попадут в выборку.

2. **Advisory lock по ключу записи**
   - Перед обработкой записи воркер берёт advisory lock:
     - для `incoming_transactions`: например `pg_advisory_xact_lock(hashtext(idempotency_key))` или lock по `id`;
     - для `outbox_events`: `pg_advisory_xact_lock(id)` или по составному ключу события.
   - Если lock не удалось взять (другой инстанс уже обрабатывает) — запись пропускается в этом цикле.
   - Вся обработка (чтение, бизнес-логика, обновление статуса) выполняется внутри той же транзакции, держащей advisory lock.

**Рекомендация:** подход 1 (FOR UPDATE SKIP LOCKED + `status = 'processing'`) проще операционно: не нужно держать длинную транзакцию на время обработки, достаточно короткой транзакции «выборка + захват». Конкретные таймауты и сброс зависших записей — раздел 6.3.

**Транзакционные границы (transactional boundaries):**

- Все изменения **доменных состояний** (таблицы `bank_cards`, `bank_cards_history`, `bank_transactions`, `drafts`, `queue`, `bank_accounts` и т.п.) и порождение связанных событий/аудита должны выполняться **в рамках одной транзакции**. Пример:
  - смена владельца карты (привязка, передача профиля, polling адаптера) включает:
    - обновление `bank_cards` (текущий владелец, `is_buying`);
    - закрытие/вставку записи в `bank_cards_history` по паттерну «закрыть текущий → вставить новый» (раздел 4.2);
    - запись в `audit_events` (с `correlation_id`);
    - создание записи в `outbox_events` (если нужно последующее событие в MQTT);
    - **всё это — внутри одного `withTransaction(...)` / `BEGIN ... COMMIT`.**
- Базовый принцип: **нет частичных состояний**:
  - запрещены последовательные операции вида «сначала обновить `bank_cards`, потом отдельно history, потом отдельно audit/outbox» без общей транзакции;
  - все процессы из `processes.md`, в которых меняется бизнес‑состояние и порождаются события/аудит, при реализации должны использовать единый helper уровня `DatabaseService` (например, `withTransaction(mainDb, async (tx) => { ... })`) и не выходить за его пределы до завершения логической операции.

Детали применения к процессам **2.4** (outbox) и **2.6** (incoming_transactions) описаны в `architecture/processes.md`.

#### 6.2. Outgoing notifications (Slack / MQTT): гарантии «не задвоить» (must-have)

Все исходящие side-effects (Slack DM, Slack‑каналы, публикация в MQTT) не выполняются напрямую из воркеров обработки событий. Вместо этого используется **mini-outbox** — таблица **`outgoing_notifications`**.

**Зачем:** при нескольких инстансах один и тот же бизнес-событие (например, OTP) не должен приводить к двум одинаковым сообщениям в Slack или к двум публикациям в MQTT. Идемпотентность в БД этого не гарантирует: два инстанса могут обработать разные записи (благодаря 6.1), но одна и та же логическая нотификация может быть сформирована из разных источников или при повторной обработке. Плюс нужны retry при сбоях и корректная реакция на rate limit Slack.

**Механика:**

1. **Запись в outbox вместо немедленной отправки**
   - После фиксации результата в БД (транзакция, draft, OTP и т.д.) воркер **не вызывает** Slack/MQTT напрямую.
   - Он вставляет запись в `outgoing_notifications`:
     - `channel` — идентификатор канала Slack, MQTT‑топик или внутренний канал (например, `slack:dm`, `slack:#finance-otp`, `mqtt:sequoia/transaction`, `mqtt:sequoia/audit`; для OTP используется `mqtt:sequoia/otp` — по таким записям воркер **вызывает OTP-обработчик напрямую**, без публикации в MQTT);
     - `recipient` — для DM: email или user_id; для канала/MQTT — пусто или условное значение;
     - `payload` — тело сообщения (JSON);
     - `payload_hash` — `hash(channel, recipient, canonical_json(payload))` для дедупликации;
     - **`dedup_key`** — явный ключ идемпотентности, уникальный в таблице (UNIQUE), чтобы одна и та же логическая нотификация не была вставлена дважды.
   - Ограничение уникальности: `UNIQUE(dedup_key)` или `UNIQUE(channel, recipient, payload_hash)` — при конфликте вставки (другой инстанс или повтор обработки) делаем `INSERT ... ON CONFLICT (dedup_key) DO NOTHING` (или DO UPDATE только служебных полей), запись не дублируется.

2. **Ключи дедупликации (dedup_key) по типам событий**
   - **OTP по карте (farm-otp, finance-otp, DM):**  
     `otp:card:<bank>:<acc_no>:<card_number>:<otp>:<timestamp_bucket>`, где `timestamp_bucket` — округление времени до окна (например, 1 минута), чтобы один и тот же OTP в одной минуте не дублировался.  
     Либо привязка к id записи в `drafts`: `otp:draft:<drafts.id>`.
   - **OTP от банка (владельцу очереди):**  
     `otp:bank:<bank>:<acc_no>:<otp>:<timestamp_bucket>` или `otp:bank:<outbox_event_id>`.
   - **Транзакция в MQTT (sequoia/transaction):**  
     `mqtt:tx:<bank>:<acc_no>:<ext_id>` — одна транзакция = одно сообщение в топик.
   - **Аудит в MQTT (sequoia/audit):**  
     по желанию можно использовать `audit:<event_type>:<correlation_id>` или hash payload; при необходимости допускается несколько аудит-сообщений с одним correlation_id (тогда dedup не по correlation_id, а по payload_hash с TTL).
   - Конкретные форматы ключей фиксируются в коде и в глоссарии архитектуры; важно, что **все** исходящие Slack/MQTT проходят через одну таблицу и один формат выбора ключа.

3. **Воркер отправки**
   - Отдельный цикл (или тот же процесс с отдельной очередью) выбирает записи из `outgoing_notifications` со `status = 'pending'` (и при необходимости `next_retry_at <= NOW()`), с применением **Worker concurrency control** (6.1): `SELECT ... FOR UPDATE SKIP LOCKED`, затем `UPDATE status = 'sending'`, коммит, отправка.
   - После успешной отправки: `UPDATE ... SET status = 'sent', sent_at = NOW()`.
   - При ошибке: `UPDATE ... SET attempts = attempts + 1, last_error = ..., next_retry_at = NOW() + backoff(attempts), status = 'pending'` (или `failed` при `attempts >= max_attempts`).

4. **Retry и backoff**
   - `attempts`, `max_attempts`, `next_retry_at` хранятся в `outgoing_notifications`.
   - Backoff: **фиксированная экспоненциальная лестница по умолчанию**:  
     `backoff(attempts) = {1, 2, 4, 8, 16, 30}` минут для попыток 1–6; все последующие попытки также используют 30 минут (cap 30 мин).  
     Конкретная функция задаётся в одном месте (helper) и может быть переопределена конфигом, но реализация обязана придерживаться данного шаблона, пока явно не изменено.
   - Записи в статусе `sending` с таймаутом возвращаются в `pending` по политике раздела 6.3.

5. **Slack rate limit**
   - При ответе Slack API с HTTP 429 (rate limit):
     - запись остаётся в `outgoing_notifications` со статусом `rate_limited` (или `pending`);
     - выставляется `next_retry_at = NOW() + Retry-After` (если Slack вернул заголовок `Retry-After`) или фиксированный интервал (например, 60 секунд);
     - `attempts` увеличивается, но запись **не** переводится в `failed` до достижения `max_attempts`;
   - Воркер при следующем цикле не трогает записи с `next_retry_at > NOW()`, поэтому повторная отправка произойдёт после паузы. При необходимости можно ввести отдельный статус `rate_limited` и обрабатывать его с увеличенным интервалом.

**Итог:** все Slack и MQTT публикации идут через `outgoing_notifications`; дедупликация по `dedup_key` (и при необходимости по `payload_hash`); retry и учёт rate limit централизованы; multi-DC безопасен, так как только один воркер «забирает» конкретную запись благодаря 6.1.

#### 6.3. Зависшие processing и ядовитые payload'ы (timeout, reset, DLQ/quarantine) (must-have)

**Приоритет:** этот механизм (воркеры + stuck reset + attempts + failed/quarantine для incoming, outbox, outgoing) должен быть реализован **первым** инфраструктурным модулем. Иначе любая следующая часть системы добавит «вечные» processing/sending и ручные чистки. Один общий job: сбрасывает зависшие `processing` в `pending` по таймауту, увеличивает attempts, после max attempts → `failed` (и опционально quarantine).

Чтобы записи не оставались в `processing`/`sending` навсегда при падении воркера и чтобы «ядовитые» payload'ы не крутились бесконечно, вводится явная политика: таймаут «зависло», кто и как сбрасывает в pending, и когда запись переводится в failed/quarantine без дальнейших retry.

**1. Когда считаем запись «зависшей» (таймауты в минутах)**

| Таблица / статус | Таймаут (минуты) | Значение по умолчанию |
|------------------|------------------|------------------------|
| `incoming_transactions` / `status = 'processing'` | `processing_started_at < NOW() - N` | **15** мин |
| `outbox_events` / `status = 'processing'` | `processing_started_at < NOW() - N` | **15** мин |
| `outgoing_notifications` / `status = 'sending'` | время захвата (например `updated_at` или отдельное поле `sending_started_at`) < NOW() - N | **5** мин |

- Таймауты задаются конфигом (env или config-файл); в коде используются константы с дефолтами из таблицы. Разные таблицы могут иметь разные значения (outgoing обычно короче — отправка не должна занимать минуты).

**2. Кто и как возвращает в pending**

- **Один фоновый job** (например, `StuckProcessingJob` или cron раз в 1–2 минуты):
  - выполняется в любом из инстансов Processor-Hub (достаточно одного запуска в кластере — по расписанию или по интервалу);
  - для **incoming_transactions** и **outbox_events**: перед сбросом в pending проверять **`processing_attempts`**:
    - если `processing_attempts < max_processing_attempts`:  
      `UPDATE ... SET status = 'pending', processing_started_at = NULL, processing_attempts = processing_attempts + 1 WHERE status = 'processing' AND processing_started_at < NOW() - INTERVAL 'N minutes'`;
    - если `processing_attempts >= max_processing_attempts`:  
      `UPDATE ... SET status = 'failed' WHERE ...` (в pending не возвращаем, запись уходит в failed/quarantine по п.3).
  - для **outgoing_notifications** (нет лимита попыток при «зависании», лимит только по `attempts` при отправке):  
    `UPDATE outgoing_notifications SET status = 'pending' WHERE status = 'sending' AND (sending_started_at < NOW() - INTERVAL '5 minutes' OR updated_at < ...)` (без увеличения счётчика — повторная отправка будет снова считаться в `attempts` воркером 6.2).
  - лимит на число обновляемых строк за один запуск (например, не более 100 по каждой таблице), чтобы не создавать пиковую нагрузку;
  - логирование количества возвращённых записей и переведённых в failed, их id (для расследований).
- **Важно:** job не должен блокировать активную обработку; достаточно обычного `UPDATE` без `FOR UPDATE`, чтобы воркеры 6.1 при следующей выборке снова могли забрать эти строки.

**3. Как не устроить бесконечный retry на ядовитых payload'ах (DLQ / failed quarantine)**

- **Ядовитый payload:** запись, которая при каждой попытке обработки приводит к ошибке (парсинг, валидация, внешний сервис всегда возвращает 4xx/5xx). Без лимита попыток она будет вечно возвращаться в pending и снова падать.
- **Политика:**
  - **incoming_transactions:** счётчик **`processing_attempts`** увеличивается job'ом 6.3 при каждом сбросе «зависшей» записи в pending (п.2 выше). При **`processing_attempts >= max_processing_attempts`** (по умолчанию 3, см. сводку параметров ниже) job переводит запись в **`status = 'failed'`** и больше не возвращает в pending. Итог: максимум 3 «зависания» → failed; далее quarantine по п.3 ниже.
  - **outbox_events:** то же: `processing_attempts` при сбросе по таймауту; при достижении лимита — `failed`, не возвращать в pending.
  - **outgoing_notifications:** лимит задаётся полями **`attempts`** и **`max_attempts`** (уже в таблице). Воркер отправки при каждой неудаче увеличивает `attempts`; при **`attempts >= max_attempts`** выставляет **`status = 'failed'`**. Job таймаута только возвращает зависшие `sending` в `pending`, не трогает записи уже в `failed`. Рекомендуемое стандартное значение `max_attempts` — **8** (может быть изменено через конфиг, но не должно быть нулевым/бесконечным).
- **Quarantine / DLQ:** записи в статусе **`failed`** считаются окончательно не обработанными. Опционально:
  - **Вариант A (минимальный):** остаются в той же таблице со `status = 'failed'`; мониторинг и алерты по количеству `failed`; ручной разбор и при необходимости повторная постановка в pending (через админку или скрипт).
  - **Вариант B (quarantine):** периодический job или триггер переносит строки из `incoming_transactions`/`outbox_events` со `status = 'failed'` в таблицы **`incoming_transactions_quarantine`** / **`outbox_events_quarantine`** (те же поля + `failed_at`, `last_error`), после чего удаляет из основной таблицы (или оставляет копию с флагом `moved_to_quarantine`). Так основная таблица не раздувается «мёртвыми» записями, а все ядовитые payload'ы собраны в одном месте для анализа и ручного retry.
  - **outgoing_notifications:** при `failed` записи остаются в таблице; при необходимости отдельная таблица `outgoing_notifications_dlq` или прослойка «архив failed» по аналогии с quarantine.
- **Итог:** лимит попыток (счётчики + max) обязателен; после достижения лимита — только `failed`, без автоматического возврата в pending; quarantine/DLQ — опционально, но рекомендуется для incoming/outbox, чтобы не засорять рабочие таблицы и иметь единое место для «ядовитых» записей.

**4. Сводка параметров (конфиг)**

- `STUCK_INCOMING_TIMEOUT_MINUTES` = 15  
- `STUCK_OUTBOX_TIMEOUT_MINUTES` = 15  
- `STUCK_OUTGOING_TIMEOUT_MINUTES` = 5  
- `INCOMING_MAX_PROCESSING_ATTEMPTS` = 3 (после этого → failed)  
- `OUTBOX_MAX_PROCESSING_ATTEMPTS` = 3  
- `OUTGOING_MAX_ATTEMPTS` уже в таблице (по умолчанию 8 для Slack/MQTT нотификаций)  
- Включение quarantine (да/нет) и интервал переноса в quarantine (если включён).

---

### 7. Структура модулей Processor-Hub

Предварительная логическая структура кода (без реализации, только для понимания архитектуры).

**Текущее состояние (2026-03):** наблюдается организационный дрейф — naming governance не зафиксирован (пример: одновременно существуют `modules/statementsImport` и `modules/statements_import` на один домен); в `infra` смешаны воркеры, DB helpers и оркестрация без явной классификации. Рекомендуется зафиксировать правила именования и разделения, консолидировать дубли, иначе структура будет расходиться с этой схемой. См. docs/implementation_progress.md § «Организационный дрейф и структурные риски».

#### 7.1. Уровни (infra / domain modules / API)

- **`infra/*`** — техническая инфраструктура:
  - `infra/database` — `DatabaseService`, типы подключений, транзакционные helper’ы (`withTransaction(...)` и т.п.);
  - `infra/mqtt` — `MqttClient`, конфигурация тем, маршрутизация, реконнекты;
  - **`infra/payment_http`** (авторизационный слой) — `PaymentHttpClient` и сервис кредов:
    - единый HTTP‑клиент для всех запросов к платёжным системам (eCards, Multicards, StellarCards, AdsCards, банки);
    - подстановка авторизации (API key, Basic, Bearer, custom headers) из централизованного хранилища по `bank`/`acc_no`;
    - retry, таймауты, логирование, `correlation_id` в заголовках;
    - адаптеры не делают свой `fetch` — только используют этот клиент.
  - **`infra/processing_runtime`** (или `infra/stuck_processing` + воркеры) — **первый** инфраструктурный модуль: воркеры по incoming/outbox/outgoing, единый job сброса зависших (раздел 6.3), а также планируемые джобы: поллинг Farm DB (`tbl_profile_auth_changes` → обновление `bank_cards.buyer`, аудит и Slack через `outgoing_notifications`) и **unlink-dead** (запуск в полночь, отвязка карт от мёртвых профилей, аудит и Slack через `outgoing_notifications`). Без него не наращивать новые потоки обработки;
  - `infra/logging` — логирование, трассировка;
  - `infra/slack` — Slack‑клиент (вызывается только из воркера `outgoing_notifications`, не из бизнес‑воркеров).

- **`modules/*`** — доменные модули (уровень **domain‑services**):
  - **repositories** — инкапсулируют SQL/доступ к БД и возвращают доменные структуры:
    - пример: `modules/cards/cardRepository` с методами `findCardByNumber`, `upsertCard`, `appendHistoryInterval`, не «светящими» наружу SQL;
  - **services** — оркестрация доменной логики на уровне модуля:
    - пример: `modules/cards/cardService.transferOwnership(...)`:
      - внутри одной транзакции через `withTransaction` вызывает репозитории `bank_cards`, `bank_cards_history`, пишет аудит и, при необходимости, создаёт `outbox_events`;
      - никакого Slack/MQTT напрямую (только `outbox_events` / `outgoing_notifications`);
  - **handlers** — адаптеры под конкретный ingress (HTTP/MQTT/cron), которые:
    - валидируют вход,
    - вызывают методы `services`,
    - не содержат SQL и не обращаются к `infra/mqtt`/Slack напрямую.

- **`app/*` / `api/*`** — слой HTTP/API:
  - controllers/route‑handlers, которые делают только:
    - авторизацию/аутентификацию;
    - маппинг HTTP‑запрос ↔ DTO сервиса;
    - вызов соответствующего `modules/*/handlers` или `services`;
    - формирование HTTP‑ответа.
  - **Запрещено**: доступ к БД, прямой доступ к `infra/mqtt` или Slack, изменение доменных таблиц в обход `modules/*`.

#### 7.2. Доменные модули

- `modules/notifications` (или `infra/outgoing_notifications`):
  - воркер выборки из `outgoing_notifications` (FOR UPDATE SKIP LOCKED), отправка в Slack/MQTT, обновление статуса, retry/backoff и обработка rate limit (раздел 6.2).

- `modules/cards`:
  - выпуск и привязка карт;
  - история владения (`bank_cards_history`);
  - интеграция с AdsCards / Multicards / eCards.

- `modules/otp`:
  - парсинг OTP (`ParserService`‑подобная логика из `mqtt_otp_transactions_service`);
  - сохранение в `drafts` / `octo`;
  - постановка Slack/MQTT уведомлений в `outgoing_notifications` (раздел 6.2), без прямой отправки.

- `modules/transactions`:
  - ingest транзакций (webhook + polling);
  - адаптеры платёжных систем `modules/transactions/adapters/<bank>.ts`, реализующие интерфейс `TransactionsAdapter { bank, normalize(raw), startPolling?() }`:
    - `normalize(raw)` маппит сырой payload конкретного провайдера в общий `NormalizedTransaction` для последующего upsert в `bank_transactions`;
    - `startPolling()` (опционально) запускает поллинг транзакций провайдера через `PaymentHttpClient`, соблюдая окно давности `transactionsPollingWindowHours` (см. 4.3);
  - модуль `modules/transactions/normalize` делегирует нормализацию адаптерам через реестр `getTransactionsAdapter(bank)` вместо switch‑по‑банкам;
  - реестр адаптеров `modules/transactions/adapters/index` используется в `src/index.ts` для старта всех доступных адаптеров и их graceful‑остановки;
  - `incoming_transactions` + worker;
  - upsert в `bank_transactions`, вычисление buyer/profile, fallback‑логика.

- `modules/bank_queue`:
  - захват/освобождение очередей (`queue` и `bank_accounts`);
  - OTP от банка и маршрутизация к владельцу очереди.

- `modules/statements_import`:
  - импорт файлов выписок;
  - маппинг на существующие pre‑transactions (через `drafts`);
  - fallback по сумме/aff_id.

- `modules/audit`:
  - единая точка записи событий в `audit_events` и MQTT‑топик `sequoia/audit`.

Подробная проработка каждого бизнес‑процесса (данные, алгоритмы, точки интеграции) находится в `architecture/processes.md`.

---

### 8. Multi-DC

1. **Active/active** инстансы Processor-Hub в разных ДЦ возможны: воркеры используют concurrency control (раздел 6.1), записи обрабатываются ровно одним инстансом.
2. **HTTP ingress (Cloudflare RR и т.п.):** допустим; webhooks должны быть идемпотентны — это заложено через `idempotency_key` при записи в `incoming_transactions`.
3. **MQTT (EMQX и др.):** кластер решает real-time distribution; критично, чтобы **publish** шёл только через `outgoing_notifications`, а не «сразу» из обработчиков — иначе при падении инстанса или брокера теряются гарантии доставки.
4. **Polling карт/транзакций платёжных систем:** для каждого адаптера (`ecards`, `adscards`, `stellarcards`, `multicards`) поллеры карт и транзакций используют таблицу `polling_leases`: перед началом цикла инстанс пытается взять lease по `id` вида `<bank>.<entity>` (TTL, по умолчанию 60 секунд); только владелец lease выполняет поллинг, остальные инстансы спят (например, 5 секунд) и пробуют снова. Это предотвращает дублирующий поллинг одних и тех же окон транзакций/списков карт в multi-DC.

---

### 9. Главные риски (если не соблюдать текущую архитектуру)

- **Риск 1:** побочные эффекты (Slack, MQTT) из обработчиков напрямую → потеря устойчивости при падениях. В архитектуре зафиксировано: сначала фиксируем в БД, потом side effects через `outgoing_notifications`.
- **Риск 2:** отсутствие единого механизма stuck/attempts/DLQ (раздел 6.3) → вечные зависшие записи и ручные разборы. Processing runtime должен быть реализован первым.
- **Риск 3:** drafts без жёстких ключей и TTL (раздел 4.1, processes.md) → matching станет недостоверным и начнёт «привязывать не то» к pre-transaction. Matching всегда должен быть ограничен по времени (TTL).
- **Риск 4:** нарушение Event Contract (добавление полей «как удобно») → поломки подписчиков MQTT. Контракт должен быть библиотекой/пакетом типов и валидаторов, единым для репо.

---

### 10. Приоритетные архитектурные задачи (перед добавлением новых частей)

1. **Реализовать общий processing runtime:** воркеры + stuck reset + attempts + failed/quarantine для incoming_transactions, outbox_events, outgoing_notifications (разделы 6.1, 6.3). Это первый инфраструктурный модуль.
2. **Застолбить единый SDK внутри репо:** генерация correlation_id / idempotency_key / dedup_key (раздел 5.2); типы и валидаторы Event Contract (пакет типов, используемый всеми сервисами, пишущими/читающими MQTT).
3. **Оформить drafts как маленький workflow:** kind, уникальные ключи по kind, time_bucket, TTL (expires_at), state machine (pending → confirmed | expired); matching всегда bounded по времени (разделы 4.1, processes.md).

