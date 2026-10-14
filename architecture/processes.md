## Processor-Hub — архитектура по бизнес‑процессам

Документ детализирует архитектуру, схемы данных и алгоритмы Processor-Hub по процессам из `docs/processor_hub_business_processes.md`.

Соглашения:

- **DB** — основная финансовая БД (банк, карты, транзакции).
- **Farm DB** — БД farm‑экосистемы (профили, пользователи).
- **MQTT** — брокер сообщений, к которому Processor-Hub подключается через единый синглтон‑клиент.
- Все соединения к БД и MQTT — через синглтоны (`DatabaseService`, `MqttClient`) с поддержкой асинхронных реконнектов.
- **Платёжные системы (API провайдеров):** все исходящие HTTP‑вызовы к платёжным системам выполняются через единый **PaymentHttpClient** (авторизационный слой); креды (API key, логин/пароль, токены) хранятся и подставляются централизованно, адаптеры не делают свой fetch и не хранят креды (см. `architecture_overview.md`, раздел 3.3).
- **Dev simulation (dev-контур):** в среде разработки внешние события можно подавать через таблицу **dev_inbox_events** (API `POST /dev/inbox-events`, фикстуры в `dev-fixtures/`). DevInboxWorker забирает записи и вызывает **Dev Dispatcher**, который по `(source, event_type)` вызывает те же прикладные сервисы (например, `ingestRawTransaction` для платёжных transaction_created). Подробно: `docs/processor_hub_dev_simulation_spec.md`, `architecture_overview.md` §5.3.

---

### 2.1 Выпуск карты

**Кратко:** карта создаётся в платежной системе, Processor-Hub регистрирует её в `bank_cards` и пишет аудит `card_issued`.

#### Архитектура

- **Внешние системы:**
  - платежные системы (`AdsCards`, `Multicards`, `eCards`, др.) — webhook и/или polling API;
  - Slack — для уведомлений (опционально).
- **Компоненты Processor-Hub:**
  - модуль `modules/cards/card-issuance`:
    - HTTP‑эндпоинты webhooks (`/api/webhooks/{provider}/card-issued`);
    - poller‑сервисы для периодической синхронизации списка карт (запросы к API провайдеров — через **PaymentHttpClient**, креды из авторизационного слоя);
    - нормализация внешних данных в `CardRecord`.
  - `DatabaseService` (DB):
    - операции upsert в `bank_cards` и, при необходимости, `cards_info`;
  - `AuditService`:
    - запись события `card_issued` в `audit_events` и/или MQTT‑топик `sequoia/audit`.

#### Схема данных

- `bank_cards` (фрагмент):
  - `card_number BIGINT` — маскированный/нормализованный номер карты;
  - `bank TEXT` — идентификатор провайдера (`adscards`, `ecards`, `multicards`, `stellarcards`, др.);
  - `acc_no TEXT` — номер счёта / логический аккаунт в провайдере (может меняться при polling при смене aff_id/группы);
  - `profile_name TEXT NULL` — профиль OCTO, начально `NULL`;
  - `buyer_email TEXT NULL` — владелец, начально `NULL`;
  - **`is_buying BOOLEAN`** — владелец из buying‑отдела (определяется по email при любом изменении владельца);
  - `creds JSONB` — зашифрованные реквизиты, токены, метаданные;
  - `ext_id TEXT` — внешний идентификатор карты у провайдера;
  - служебные поля: `created_at`, `updated_at`, индекс по `(bank, card_number)`, уникальность `(bank, ext_id)`.

#### Алгоритм

1. **Webhook / polling**:
   - адаптер провайдера получает событие "card created" (или список карт при polling);
   - нормализует payload в `CardRecord`.
2. **Валидация и дедупликация:**
   - проверка на существование по `(bank, ext_id)` или `(bank, card_number)`;
   - при повторе выполняется upsert/обновление метаданных, а не вставка дубликата.
3. **Запись в БД:**
   - через `DatabaseService` выполняется upsert в `bank_cards`;
   - при необходимости — обновляется/создаётся запись в `cards_info` (BIN‑информация).
4. **Polling: смена aff_id/группы = смена владельца карты**
   - при синхронизации карт с провайдером (polling) могут приходить обновлённые `aff_id`, группа, `acc_no`; если по новому `aff_id`/группе определяется **другой** buyer (например, через `binom` или маппинг провайдера), карта считается переданной от одного баера другому:
     - в **одной транзакции** (раздел 4.2): обновить `bank_cards` (`buyer_email`, `profile_name` при необходимости, `acc_no`, **`is_buying`** — по новому buyer_email через справочник/роль);
     - закрыть текущий интервал в `bank_cards_history` (`valid_to = NOW()`);
     - вставить новую запись истории с новым `buyer_email`, `profile_name`, **`is_buying`**;
     - аудит события смены владельца (например, `card_owner_changed_by_polling`).
   - если buyer не изменился — только обновление метаданных карты (acc_no и т.д.) без изменения истории.
5. **Аудит:**
   - пишется запись `card_issued`:
     - минимум: `card_number`, `bank`, `acc_no`, `ext_id`, `raw`, `correlation_id`;
     - при polling‑сценариях (как в eCards‑адаптере) событие **обязательно** создаётся,
       если карта:
       - впервые появилась с уже известным владельцем (`buyer` пришёл напрямую из источника), или
       - получила нового владельца по `aff_id`/группе (buyer разрешён, например, через `binom`);
     - `user_email` в аудите = `buyer` карты на момент события.
6. **Отказоустойчивость:**
   - перед любыми внешними эффектами (Slack, MQTT) запись в `bank_cards` должна быть уже зафиксирована;
   - повтор webhook’а не должен приводить к дублям — только к идемпотентному upsert’у.

---

### 2.2 Привязка карты через farm‑расширение

**Кратко:** Farmer привязывает карту к профилю; Processor-Hub обновляет `bank_cards`, пишет историю в `bank_cards_history` и аудит `card_linked_by_farmer`.

#### Архитектура

- **Внешние системы:**
  - `farm-extension` (UI), вызывающий API Processor-Hub (`/cards/get-by-bin`, `/cards/link`).
  - Farm DB — хранит пользователей и профили.
- **Компоненты Processor-Hub:**
  - модуль `modules/cards/linking`:
    - API для поиска карты по BIN/карте;
    - API для привязки карты к `profile_name`/`buyer_email`;
  - `DatabaseService` (DB + Farm DB):
    - чтение из `bank_cards`;
    - обновление `bank_cards`, вставка в `bank_cards_history`;
    - проверка профиля и пользователя.
  - `AuditService` — запись `card_linked_by_farmer`.

#### Схема данных

- `bank_cards`:
  - `profile_name TEXT NULL`, `buyer_email TEXT NULL`, **`is_buying BOOLEAN`** — связываются при привязке; `is_buying` определяется по email (farmer → как правило `false`).
- `bank_cards_history` (инвариант и защита — architecture_overview.md, раздел 4.2):
  - `card_number BIGINT`, `bank TEXT`;
  - `profile_name TEXT`, `buyer_email TEXT`, **`is_buying BOOLEAN`**;
  - `valid_from TIMESTAMP`, `valid_to TIMESTAMP NULL`;
  - **инвариант:** не более одной строки с `valid_to IS NULL` на один `card_number`;
  - частичный уникальный индекс: `UNIQUE (card_number) WHERE valid_to IS NULL`;
  - индекс по `(card_number, valid_from)` для запросов «на дату».

#### Алгоритм

1. **Поиск карты:** `GET /cards/get-by-bin`:
   - вход: BIN, возможно часть номера / маска;
   - запрос к `bank_cards` по `bank`, `card_number`/`bin`;
   - карта считается "свободной", если `profile_name IS NULL` и `buyer_email IS NULL`.
2. **Привязка:** `POST /cards/link`:
   - вход: `card_number` (или `ext_id`), `profile_name`, контекст farmer’а (`farmer_email`);
   - **в одной транзакции** (раздел 4.2 — иначе гонки multi-worker дадут две «текущие» записи):
     - вычислить **`is_buying`** по email farmer’а (справочник/роль: принадлежность к buying‑отделу; при привязке farmer’ом обычно `false`);
     - обновить `bank_cards`: `profile_name = <profile_name>`, `buyer_email = <farmer_email>`, `is_buying = <значение>`;
     - закрыть текущий активный интервал: `SELECT id ... WHERE card_number = ? AND valid_to IS NULL FOR UPDATE`; затем `UPDATE bank_cards_history SET valid_to = NOW() WHERE card_number = ? AND valid_to IS NULL`;
     - вставить новую запись: `INSERT INTO bank_cards_history (..., is_buying, valid_from = NOW(), valid_to = NULL)`.
   - частичный уникальный индекс `(card_number) WHERE valid_to IS NULL` гарантирует на уровне БД не более одного активного интервала на карту.
3. **Аудит:**
   - записать `card_linked_by_farmer` с деталями карты, профиля, farmer’а.
4. **Идемпотентность:**
   - повторный вызов с теми же параметрами не должен создавать дубликаты истории;
   - можно использовать `(card_number, profile_name, buyer_email, valid_from)` или hash‑ключ для защиты.

---

### 2.2a Google Ads скрипт и связь аккаунта с профилем (farm‑расширение)

**Кратко:** farm‑расширение запрашивает у Processor-Hub текст Google Apps Script, уникальный для профиля; отдельно может передать Google Ads customer ID и `profile_name` для записи в Farm DB. Скрипт в Google Ads после установки запускается раз в час, присылает метрики и версию скрипта; Processor-Hub сохраняет логи и обновляет поля профиля. **Скрипт считается установленным, если в `tbl_profiles` задано `script_version` (ненулевое/непустое значение после первого отчёта).** Идентификатор аккаунта Google Ads хранится в **`tbl_profiles.account_id`**.

#### Два запроса от farm‑расширения к Processor-Hub

1. **Текст скрипта:** `GET /google/account?profile_name={profile_name}` — ответ: обфусцированный JS для вставки в Google Ads; в тело подставляются `profile_name` и метка времени сборки (реализация: `src/api/routes/google.ts`, шаблон `google-account-index.js`). Каждый ответ уникален за счёт обфускации и времени.
2. **Фиксация Google Ads ID и профиля:** `POST /google/account/set` с телом `profile_name`, `account_id` в формате `XXX-XXX-XXXX` — обновляет **`tbl_profiles.account_id`**, только если оно было `NULL` (первичная привязка без ожидания часового отчёта скрипта).

#### Поведение установленного скрипта (Google Ads → Processor-Hub)

- Скрипт настраивается на **ежечасовой** запуск; в теле запроса — метрики аккаунта, служебные поля и **`version`** (версия скрипта).
- **`POST /google/account`** (вызов из Google Ads, не из расширения):
  - в основной БД: вставка строки в **`public.google_account_logs`** (`account_id`, `profile_name`, полный `payload` JSON);
  - в Farm DB: при наличии `profile_name` и `accountId` в теле — **`UPDATE tbl_profiles SET account_id = <accountId>, script_version = <version> WHERE name = <profile_name>`**;
  - дедуплицированное уведомление в Slack (`slack:#finance-otp`); при **первой** установке (`account_id` у профиля до обновления был пуст) — дополнительно DM владельцу и сообщение в `#finance-otp` с текстом об установке.

#### Смысл полей в `tbl_profiles` (Farm DB)

| Поле | Назначение |
|------|------------|
| `account_id` | Google Ads customer ID, связанный с профилем (может быть выставлен расширением через `/google/account/set` и/или уточнён часовыми отчётами `/google/account`). |
| `script_version` | Версия скрипта из последнего отчёта; **если задана — Google Ads скрипт считается установленным и уже отчитывался в Hub.** |

Исключение: профиль не найден по `name` — обновление `tbl_profiles` пропускается, лог в `google_account_logs` всё равно пишется.

---

### 2.3 Пришел Google‑код (карточная операция)

**Кратко:** приходит google‑code/OTP по карте, Processor-Hub находит владельца карты и отправляет код в Slack (DM + канал `farm-otp`), сохраняя аудит.

#### Архитектура

- **Внешние источники:**
  - платежные системы (через webhook/polling);
  - возможно — банк/смс‑шлюз (через отдельный SMS‑парсер).
- **Компоненты Processor-Hub:**
  - модуль `modules/otp/card-otp`:
    - парсинг google‑кодов из текстов транзакций или SMS;
    - нормализация в `ParsedDraft` (аналогично `mqtt_otp_transactions_service`);
  - `DatabaseService`:
    - поиск `bank_cards` по `card_number` / `acc_no` / `bank`;
    - извлечение `buyer_email` и `profile_name`.
  - постановка уведомлений в **`outgoing_notifications`** (architecture_overview.md, раздел 6.2): DM владельцу карты и сообщение в канал `farm-otp`; фактическую отправку выполняет воркер исходящих уведомлений (дедупликация по `dedup_key`, retry, rate limit).
  - `AuditService`:
    - событие `google_code_received`.

#### Схема данных

- `bank_cards` — как выше.
- `drafts` (опционально, если код также используется как OTP‑draft):
  - `kind = 'card_otp'`;
  - `otp`, `card_number`, `buyer_email`, `profile_name`, `raw`, `payload_hash`.

#### Алгоритм

1. **Получение события:**
   - от провайдера приходит либо:
     - webhook с полем для OTP/description;
     - либо транзакция/сообщение на MQTT‑топик `sequoia/transaction` / `sequoia/otp`.
2. **Парсинг кода:**
   - модуль OTP пытается извлечь google‑code (регулярки, шаблоны).
   - при успехе формируется `ParsedDraft` c:
     - `bank`, `otp`, `card_number`, возможно `amount`, `currency`, `buyer_email`.
3. **Поиск владельца карты:**
   - через `bank_cards` находится актуальный владелец (`buyer_email`, `profile_name`);
   - если не найден — опционально fallback логика или запись в аудит об ошибке.
4. **Уведомления (без дублей):**
   - вставка в `outgoing_notifications` двух записей (DM владельцу + канал `farm-otp`) с `dedup_key` вида `otp:card:<bank>:<acc_no>:<card_number>:<otp>:<timestamp_bucket>` (или привязка к id в `drafts`); отправка — через воркер 6.2.
5. **Аудит:**
   - `google_code_received` с деталями.

---

### 2.4 Профиль передан баеру (гарантированная доставка события)

**Кратко:** при изменении `auth_id` профиля в основной БД создаётся событие в `outbox_events`, Processor-Hub обрабатывает его, обновляя владельца карты, историю владения и аудит.

#### Архитектура

- **Внешняя система:**
  - основная БД профилей/пользователей (изменение `auth_id` в `tbl_profiles`).
- **Компоненты Processor-Hub:**
  - модуль `modules/cards/profile-transfer`:
    - worker обработки `outbox_events` с типом `profile_transferred_to_buyer`;
  - `DatabaseService` (DB + Farm DB):
    - чтение `outbox_events`, `tbl_users`, `tbl_profiles`, `bank_cards`, `bank_cards_history`;
  - `AuditService`:
    - событие `profile_transferred_to_buyer`.

#### Схема данных

- `outbox_events`:
  - `event_type = 'profile_transferred_to_buyer'`;
  - `profile_name`, `old_auth_id`, `new_auth_id`, `occurred_at`, `correlation_id`;
  - `status` (`pending`, `processing`, `processed`, `failed`);
  - `processing_started_at TIMESTAMP NULL` — для таймаута «зависших» записей при использовании FOR UPDATE SKIP LOCKED.
- `bank_cards`, `bank_cards_history` — как описано выше.

#### Алгоритм

1. **Запись события в outbox (вне Processor-Hub):**
   - триггер/приложение основной БД при изменении `auth_id`:
     - создаёт запись в `outbox_events` с `status = 'pending'`.
2. **Worker Processor-Hub (concurrency control — см. architecture_overview.md, раздел 6.1):**
   - выборка записей **только** через механизм конкурентной выборки:
     - либо `SELECT ... FROM outbox_events WHERE event_type = 'profile_transferred_to_buyer' AND status = 'pending' ORDER BY id LIMIT N FOR UPDATE SKIP LOCKED` с последующим в той же транзакции `UPDATE outbox_events SET status = 'processing', processing_started_at = NOW() WHERE id = ANY(...)` и коммитом;
     - либо advisory lock по `outbox_events.id` перед обработкой (вся обработка в одной транзакции).
   - без этого два инстанса могут взять одно и то же событие → дубли в истории владения, в Slack и в аудите.
   - после эксклюзивной выборки (в отдельной транзакции или под тем же lock):
     - находит `buyer_email` по `new_auth_id` через `tbl_users`;
     - по **email сотрудника** определяет принадлежность к buying‑отделу (справочник email→department, роль в `tbl_users` или аналог) → **`is_buying`** (при передаче профиля баеру обычно `true`);
     - обновляет `bank_cards.buyer_email = buyer_email`, **`bank_cards.is_buying = <значение>`** для всех карт профиля;
     - для **каждой карты профиля** в одной транзакции (раздел 4.2): закрыть текущий интервал (`SELECT ... FOR UPDATE`, `UPDATE ... SET valid_to = NOW() WHERE card_number = ? AND valid_to IS NULL`), затем вставить новую запись истории с `buyer_email`, **`is_buying`**, `valid_to = NULL`; частичный уникальный индекс гарантирует один активный интервал на карту.
3. **Идемпотентность:**
   - по `correlation_id` и/или составному ключу создаётся защита от повторной обработки;
   - операция обновления должна быть безопасна при повторном запуске (например, `UPDATE ... WHERE valid_to IS NULL`).
4. **Аудит:**
   - `profile_transferred_to_buyer` с `profile_name`, `buyer_email`, списком карт, `correlation_id`.
5. **Завершение:**
   - событие в `outbox_events` помечается как `processed` (или заполняется `processed_at`).

---

### 2.7 “Смерть” профиля (batch-отвязка карт от отработанных профилей)

**Кратко:** периодический batch‑воркер ищет “мёртвые”/отработанные профили по Farm DB (phase_id=4, stage_id=1, старше N дней (5 по умолчанию, 30 для billing BIN StellarCards)), находит привязанные к ним карты и **изымает из оборота** для автовыдачи.

**MR 29 (processor-hub, 2026-04):** для карт **без** `is_bad` сначала выполняется **блокировка у платёжной системы** (`adapter.blockCard`, см. `unlinkDeadWorker` и `modules/cardBlock`). После успеха: отвязка `profile_name` и владельца (`buyer`/`is_buying`), `is_bad`, `acc_no` вида `blocked at …`, `bank_cards.last_used_at`, аудит **`bank_card_blocked`** (`source: unlink_dead`). Если провайдер недоступен — **запись `bank_cards` в этом прогоне не меняется** (профиль остаётся на карте; повтор на следующем запуске). Отдельная ветка для уже **`is_bad`** (Binom / передача баеру) — по-прежнему без обязательной блокировки у ПС в этом MR. Документация: [docs/mr29_unlink_dead_block.md](../docs/mr29_unlink_dead_block.md).

Для сценариев без успешной блокировки у ПС (legacy / другие ветки) по-прежнему возможны отвязка без `is_bad`, аудит **`card_unlinked`** и Slack (`#farm-otp`).

#### Архитектура

- **Внешние системы:**
  - Farm DB (`tbl_profiles`, `tbl_statuses`) — источник статусов профилей (phase_id, stage_id, `updated_at`);
  - Finance DB (`bank_cards`) — хранение карт.
- **Компоненты Processor-Hub:**
  - воркер `infra/unlinkDeadWorker`:
    - запуск по расписанию в **00:00** (проверка раз в минуту); один прогон в сутки;
    - вычисляет мёртвые профили (отдельно 5 и 30 дней для billing BIN StellarCards);
    - выбирает карты для отвязки, выполняет UPDATE в `bank_cards`;
    - для каждой отвязанной карты: запись в `outgoing_notifications` (канал `mqtt:sequoia/audit`) с **user_email = bank_cards.buyer или "system@groscloud.com"**; в **event_attributes обязательно полные profile_name и card_number**, плюс bank, source: 'unlink_dead', а также `marked_out_of_circulation` и `last_used_at`;
    - одна запись в `outgoing_notifications` (канал `slack:#farm-otp`) — сводка по освобождённым картам и статистике доступных для фарма.
  - `DatabaseService` (Farm DB + main) для запросов и обновлений.

#### Формат таблицы `bank_cards` (требование для unlink-dead и выдачи карт)

- `last_used_at TIMESTAMPTZ NULL`:
  - `NULL` — карта участвует в обычной выдаче свободных карт;
  - `NOT NULL` — карта изъята из оборота и не должна выдаваться в `get-by-bin`, `free-count`, `get-bins`.

#### Критерий “мёртвого” профиля

- Профиль считается “мёртвым” (dead), если по Farm DB:
  - статус `phase_id = 4` и `stage_id = 1`;
  - `tbl_statuses.updated_at <= NOW() - interval 'N days'`.
- Значения `N`:
  - по умолчанию **N = 7 дней** (`DEFAULT_DEAD_DAYS`, из конфига);
  - для **billing BIN’ов** StellarCards (список `UNLINK_DEAD_BILLING_BINS` в конфиге) — **N = 30 дней** (`STELLARCARDS_DEAD_DAYS`).
- Конфигурация:
  - `unlinkDead.defaultDays` — для большинства банков;
  - `unlinkDead.stellarcardsDays` — для биллинговых BIN’ов StellarCards;
  - `unlinkDead.billingBins` — список BIN’ов, для которых применяется 30‑дневный порог.

#### Алгоритм (упрощённо, по мотивам текущего `unlink-dead`)

1. **Определение dead‑профилей:**
   - из Farm DB выбираются профили, удовлетворяющие критериям выше, отдельно для 7 и 30 дней;
   - объединение множеств даёт `deadProfileNames`, с учётом фильтра по банку (если задан `bank`).
2. **Поиск карт для отвязки:**
   - из `bank_cards` выбираются карты, где `profile_name IN deadProfileNames` и, при наличии, `bank = $bank`:
     - для `stellarcards`:
       - карты с BIN’ами **не** из billing‑списка — по 7‑дневному порогу;
       - карты с BIN’ами **из** billing‑списка — по 30‑дневному порогу;
     - для остальных банков (`ecards`, `adscards`, `multicards`) — 7‑дневный порог.
   - применяется ограничение `LIMIT` (по умолчанию до 500–2000 карт, параметр запроса).
3. **Режим preview (dry‑run):**
   - при вызове воркера с `dryRun = true`:
     - собирается список dead‑профилей (ограниченный, например до 100 имён);
     - формируется `cards_to_unlink` (маскированные номера, банк, profile_name);
     - считается `stats` — статистика доступных для фарма карт (см. ниже);
     - при необходимости отправляется в Slack отчёт только по статистике, без фактических изменений в БД.
4. **Режим выполнения (dryRun = false):**
   - воркер **не имеет публичного HTTP‑роута**; он запускается по расписанию или через административный триггер и сам решает, когда выполнять отвязку.
   - при `dryRun = false`:
     - внутри транзакции Finance DB:
       - `UPDATE bank_cards SET profile_name = NULL, buyer = NULL, is_buying = NULL/false, last_used_at = COALESCE(last_used_at, NOW()) WHERE card_number IN (...)`;
       - **расширение для Processor-Hub:** закрытие активных интервалов истории:
         - `UPDATE bank_cards_history SET valid_to = NOW() WHERE card_number IN (...) AND valid_to IS NULL`;
        - новые активные интервалы не создаются; карта помечается как выведенная из оборота (`last_used_at`) и не участвует в автовыдаче.
     - формируется массив `unlinked` с атрибутами (card_number, bank, profile_name, buyer);
     - выполняется batch‑insert в таблицу аудита с `event_type = 'card_unlinked'` (через `unnest(...)`) с fallback на индивидуальные `writeAuditLog` при ошибке.
5. **Slack‑отчёт и статистика:**
   - после UPDATE пересчитывается статистика доступных для фарма карт по `bank_cards`:
     - карта считается **доступной для фарма**, если:
       - `profile_name IS NULL` и (`buyer IS NULL OR buyer = '') и
       - `last_used_at IS NULL` и
       - `acc_no = 'FEBRUARY'` или `LOWER(acc_no) LIKE '%farm%'`;
   - формируется текст отчёта:
     - по каждому банку/BIN: сколько карт освобождено и сколько всего доступно;
     - общий итог: сколько карт доступно для фарма по всем банкам;
   - отчёт отправляется в канал `farm-otp`.

#### Инварианты и связь с общей моделью

- Отвязка “мёртвых” профилей **освобождает карты для фарма**, при этом:
  - текущий владелец карты в `bank_cards` очищается (`buyer_email`/`buyer`, `profile_name`, `is_buying`);
  - для карт, выведенных из оборота, проставляется `last_used_at` (идемпотентно, без перезаписи уже проставленной даты);
  - история в `bank_cards_history` корректно закрывается (`valid_to` заполняется), но не затирается;
  - состояние “карта свободна” определяется по тем же критериям, что и статистика доступности для фарма (profile_name NULL, buyer пуст/NULL, `last_used_at IS NULL`, acc_no метит “farm”/`FEBRUARY`).
- `unlink-dead` — это **batch‑процесс**, независимый от потоков ingest/outbox, но работающий в тех же таблицах `bank_cards`/`bank_cards_history` и пользующийся общими инвариантами истории владения картами.

---

### 2.5 Баер получает OTP по карте

**Кратко:** OTP по карте поступает от платежной системы; Processor-Hub определяет `bank_cards.buyer` и доставляет OTP в DM + канал `finance-otp`, сохраняя аудит.

#### Архитектура

- Логически расширяет процесс 2.3, но с другим каналом доставки и каналом Slack.
- Доставка — только через **`outgoing_notifications`** (раздел 6.2): запись в таблицу с `dedup_key`, воркер отправляет в Slack; при rate limit — retry по `next_retry_at`.

#### Схема данных

- `drafts` (тип card‑otp), `bank_cards` — как выше.

#### Алгоритм

1. Получение OTP по карте (webhook / polling / MQTT).
2. Нормализация в `ParsedDraft` (bank, otp, card_number, buyer_email, profile_name).
3. Поиск buyer по карте и профилю (если не был явно указан).
4. Постановка в `outgoing_notifications` (раздел 6.2): DM buyer и канал `finance-otp`; `dedup_key` — например `otp:card:<bank>:<acc_no>:<card_number>:<otp>:<timestamp_bucket>`.
5. Запись аудита `card_otp_delivered`.

---

### 2.6 Получение транзакции от платежной системы

**Кратко:** Processor-Hub гарантированно фиксирует каждую транзакцию (webhook/polling) в `incoming_transactions`, затем worker идемпотентно обновляет `bank_transactions`, определяет владельца (buyer/profile), выполняет fallback‑логику и пишет аудит.

#### Архитектура

- **Внешние источники:**
  - webhooks и polling API платежных систем и банков.
- **Компоненты Processor-Hub:**
  - модуль `modules/transactions/ingest`:
    - приём и нормализация payload;
    - запись в `incoming_transactions`;
  - при polling: вызовы API провайдеров — только через **PaymentHttpClient** (авторизационный слой), без собственного fetch в адаптере.
  - worker `modules/transactions/processor`:
    - выборка записей **только** через Worker concurrency control (см. architecture_overview.md, раздел 6.1): `SELECT ... FOR UPDATE SKIP LOCKED` + `UPDATE status = 'processing'` в одной транзакции, либо advisory lock по `id` / `idempotency_key`;
    - нормализация в `NormalizedTransaction`;
    - upsert в `bank_transactions`;
    - вычисление buyer/profile_name;
    - fallback‑логика.
  - `DatabaseService`:
    - операции с `incoming_transactions`, `bank_transactions`, `bank_cards`, `bank_accounts`, `drafts`;
  - `AuditService`:
    - `card_transaction_upserted` / `bank_transaction_upserted`.

#### Схема данных

- `incoming_transactions`:
  - `id SERIAL`, `bank`, `acc_no`, `ext_id`, `raw_payload JSONB`, `received_at TIMESTAMP`;
  - `status TEXT` (`pending`, `processing`, `processed`, `failed`);
  - `processing_started_at TIMESTAMP NULL` — для таймаута «зависших» записей;
  - `idempotency_key TEXT UNIQUE`.
- `bank_transactions`:
  - `bank`, `acc_no`, `ext_id` — уникальный ключ;
  - `amount`, `currency`, `status`, `occurred_at`;
  - `buyer_email`, `profile_name`;
  - `raw JSONB`, `fallback_used BOOLEAN`, `created_at`, `updated_at`;
  - при необходимости расширяется полями `idempotency_key` и `correlation_id` через миграции.

#### Алгоритм

1. **Ingress:**
   - сразу после приёма события (HTTP/MQTT/polling) в одной транзакции:
     - вычисляется `idempotency_key = hash(bank, acc_no, ext_id)`;
     - делается `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` в `incoming_transactions`.
2. **Worker (concurrency control — must-have):**
   - в одной короткой транзакции:
     - `SELECT id, ... FROM incoming_transactions WHERE status = 'pending' ORDER BY id LIMIT N FOR UPDATE SKIP LOCKED`;
     - `UPDATE incoming_transactions SET status = 'processing', processing_started_at = NOW() WHERE id = ANY($1)`;
     - коммит.
   - альтернатива: advisory lock по `id` или `idempotency_key` на время обработки (вся обработка в одной транзакции).
   - без этого при нескольких инстансах возможны дубли Slack/MQTT, гонки в истории владения и шум в аудите.
   - для каждой захваченной записи:
     - парсит и нормализует payload в `NormalizedTransaction`.
3. **Upsert в `bank_transactions`:**
   - `INSERT ... ON CONFLICT (bank, acc_no, ext_id) DO UPDATE`:
     - обновляет `amount`, `currency`, `status`, `occurred_at`, `raw_payload`.
4. **Определение владельца:**
   - приоритетно проверяется `merchant_description`: если есть `GOOGLE*ADS##########` (10 цифр),
     сначала ищется `profile_name` в `public.google_account_logs` по `account_id` (сравнение в формате digits-only: `0123456789` ↔ `012-345-6789`);
   - если в `google_account_logs` профиля нет, выполняется второй lookup в `finance0_ext.funds_from_account` по тому же нормализованному `account_id`;
   - найденный `profile_name` разрешается в `buyer_email` через канонический запрос `getCurrentUserByProfileName()` к Farm DB;
   - только если этот путь не сработал, используются текущие источники (`resolveOwner` адаптера, `bank_cards`, `drafts` и другие fallback-правила);
   - итоговые `buyer_email` и `profile_name` пишутся в `bank_transactions`.
5. **Fallback‑логика:**
   - если владелец не найден:
     - применяется набор fallback‑правил (например, сопоставление по сумме/aff_id, как в выписках);
     - при успехе поля `buyer_email` / `profile_name` также заполняются;
     - в `bank_transactions` выставляется `fallback_used = true`.
6. **Завершение обработки:**
   - запись в `incoming_transactions` помечается как `processed` (либо `failed` при ошибках);
   - пишется аудит `*_transaction_upserted` с ключевыми полями и `correlation_id`.
7. **Публикация в MQTT (при необходимости):**
   - постановка в `outgoing_notifications` с `channel = mqtt:sequoia/transaction`, `dedup_key = mqtt:tx:<bank>:<acc_no>:<ext_id>`; фактическая публикация — воркер 6.2.

---

### 2.6a Очередь массовой блокировки карт (`card_block_queue`)

**Кратко:** массовая постановка карт на блокировку в таблицу **`public.card_block_queue`**; фоновый воркер **`startCardBlockQueueWorker`** (`src/infra/cardBlockQueueWorker.ts`) снимает строки с конкурентным контролем (`FOR UPDATE SKIP LOCKED`), по возможности вызывает **`blockCardByCardNumber`** (адаптер **`blockCard`**), обновляет **`bank_cards`** и помечает очередь (**`blocked_at`** / **`error`**).

**Идемпотентность для очереди:** если по **`bank_cards`** карта уже помечена заблокированной хабом (**`is_bad`** и **`acc_no`** с префиксом **`blocked at `**), воркер **не вызывает** платёжную систему и записывает пояснение в **`card_block_queue.error`** (аудит **`bank_card_blocked`** в этой ветке не ставится). Синхронный **`POST /api/card-block/block`** очередь не использует и эту проверку не выполняет.

Постановка в очередь: **`POST /api/card-block/block-batch`** (`src/api/routes/cardBlockBulk.ts`). Пошаговый поток и семантика колонок — [docs/card_and_bank_flows.md](../docs/card_and_bank_flows.md) § I.b.

---

### 3.1 Баер занял очередь в банк (acquire/release/credentials/kick-off/status)

**Кратко:** Processor-Hub реализует атомарный захват и освобождение очереди по `(bank, acc_no)` с учётом TTL и аудита.

#### Контракт очереди (lease semantics)

- Таблица **`queue`** моделирует **lease** (аренду), а не «владение навсегда»:
  - lease действует до **`expires_at`**;
  - продление тем же владельцем = **renew** (обновление `expires_at`);
  - **release** = best effort (удаление своей записи; если уже истекла или занята другим — корректный noop).
- Для multi-DC и масштабирования:
  - **status endpoint** (проверка «кто в очереди») должен быть **read-only и дешёвый** (без блокировок, по возможности кеш);
  - **acquire** и **release** — **строго идемпотентные** (повторный вызов с теми же параметрами даёт предсказуемый результат без дублей).

#### Архитектура

- **Внешние клиенты:** UI/сервисы, вызывающие `/queue/acquire` и `/queue/release`.
- **Компоненты Processor-Hub:**
  - модуль `modules/bank_queue`:
    - реализация `acquireQueue(email, bank, accNo)` (acquire / renew);
    - реализация `releaseQueue(email, bank, accNo)` (best effort);
    - фоновые задачи по очистке просроченных записей и кешей.
  - `DatabaseService` — операции с `bank_accounts` и `queue`;
  - `AuditService` — события `bank_queue_*`.

#### Схема данных

- `bank_accounts`:
  - хранит все доступные банковские аккаунты (`bank`, `acc_no`, phone и др.), валидируется при acquire.
- `queue`:
  - `email`, `bank`, `acc_no`, `expires_at`, `notification_sent`;
  - уникальный ключ `(bank, acc_no)`.

#### Алгоритм acquire

1. Очистка просроченных записей `cleanupExpiredQueues()`.
2. Проверка, что `(bank, acc_no)` существует в `bank_accounts`.
3. Чтение `queue` по `(bank, acc_no)`:
   - запись отсутствует → переход к вставке;
   - запись есть и `expires_at > NOW()`:
     - если `email` совпадает — продление:
       - `expires_at = NOW() + 40m`, `notification_sent = false`;
       - аудит `bank_queue_extended`;
     - если `email` другой — отказ:
       - аудит `bank_queue_acquire_denied`.
   - запись истекла — удаление и переход к вставке.
4. Вставка:

   - `INSERT INTO queue (email, bank, acc_no, expires_at, notification_sent) VALUES (..., NOW() + 40m, false)`.

5. Обработка гонок (конфликт уникальности):
   - при `unique violation`:
     - перечитать `queue`;
     - если владелец тот же email → сделать UPDATE‑продление;
     - иначе вернуть `false`.

6. Инвалидация кеша статусов банка, аудит `bank_queue_acquired` при успехе.

#### Алгоритм release

1. `DELETE FROM queue WHERE email = $1 AND bank = $2 AND acc_no = $3`.
2. Если `rowCount > 0`:
   - инвалидировать кеш;
   - аудит `bank_queue_released`.
3. Иначе аудит `bank_queue_release_noop`.

---

### 3.2 Получен OTP от банка

**Кратко:** приходит SMS/OTP от банка (через SMS‑шлюз/MQTT `sequoia/otp` с `source='sms'`), Processor-Hub парсит текст SMS (и при необходимости — через систему SmsParser), по номеру телефона ищет `bank_accounts` и определяет `(bank, acc_no)`, находит активную очередь (`queue`) и ставит в `outgoing_notifications` DM владельцу очереди + канал finance-otp + аудит otp_sent. Реализация потребления топика `sequoia/otp`: [architecture/mqtt_handlers.md](mqtt_handlers.md) §8, `src/mqtt/sequoia/otp/index.ts`.

#### Архитектура

- **Внешние источники:** SMS‑шлюз, API банка, MQTT с сырыми SMS (`sequoia/otp` с `source='sms'`, `SmsOtpPayload.raw` как JSON `{ content, recipient }` или просто текст), а также HTTP‑вебхук от hardware‑устройств (по образцу `adscards-webhook` + `SmsPhones`/`Sms`).
- **Компоненты Processor-Hub:**
  - модуль `modules/otp/bank-otp`:
    - обработка входящих `SmsOtpPayload`:
      - извлечение `content` и `recipient` (phone) из `raw`;
      - парсинг текста через `SmsParser`:
        - цепочка `BankSmsParser` по банкам (Axis, Hdfc, Kotak, … + Generic);
        - извлечение `bank`, `otp`, `amount`, `currency`, `card_number`, `phone_to`, `sender`;
        - определение и отбрасывание рекламных/промо SMS (bank = 'promotional' или отсутствие OTP);
      - сопоставление номера телефона с банковским аккаунтом через `bank_accounts`;
    - формирование `ParsedDraft`/внутреннего OTP‑события для дальнейшей маршрутизации.
  - модуль `modules/bank_queue`:
    - поиск активной очереди по `(bank, acc_no)`;
  - постановка OTP в **`outgoing_notifications`** (раздел 6.2), доставка владельцу очереди через воркер исходящих уведомлений;
  - `AuditService` — `bank_otp_received`.
  - модуль `modules/hardware/sms-ingest`:
    - приём SMS от hardware‑устройств (аналог вебхука `WebhookController` из `adscards-webhook`):
      - десериализация телеметрии устройств в `sms_phones` по IMEI (battery, charging, phones[], info);
      - десериализация входящих SMS в таблицу `sms` с `type = 'sms_received'`;
      - дальнейшая маршрутизация этих SMS в общий поток OTP (через MQTT `sequoia/otp`/внутренний вызов `modules/otp/bank-otp`).
  - **Вебхук мобильных приложений** `POST /webhooks/mobile/sms` (реализация: `src/api/routes/mobileSms.ts`):
    - приём JSON в формате **SmsPhone** (heartbeat): `imei`, `phones`, `battery`, `charging`, `info` → upsert в таблицу **`sms_devices`** (аналог `sms_phones`, отдельная таблица под мобильные приложения);
    - приём JSON с `type = 'sms_received'`: `sender`, `content`, `recipient` (и опционально `imei`); при отсутствии IMEI — поиск по номеру получателя в `sms_devices`; формирование `SmsOtpPayload` и постановка в `outgoing_notifications` (channel `mqtt:sequoia/otp`); воркер исходящих уведомлений **вызывает OTP-обработчик напрямую** (без публикации в MQTT).
#### Схема данных

- `bank_accounts` — связь `phone → (bank, acc_no)` и дополнительные атрибуты (имя, баланс, extra), используемые для отчётов и вспомогательной логики.
- `queue` — как выше.

#### Алгоритм

1. Получение SMS/OTP от банка (HTTP‑вебхук от SMS‑шлюза или MQTT‑сообщение `sequoia/otp` с `source='sms'` и `raw`).
2. Разбор `raw`:
   - если `raw` — JSON `{ content, recipient }`, то:
     - `smsText = content`;
     - `recipient = recipient` (телефон, на который пришло SMS);
   - иначе: `smsText = raw` (recipient определяется парсером или не используется).
3. Парсинг текста через `SmsParser`:
   - последовательно вызываются `BankSmsParser.canParse/parse` для зарегистрированных банковских парсеров;
   - на выходе: `bank`, `otp`, `amount`, `currency`, `card_number`, `phone_to`, `sender`;
   - если OTP не найден и текст распознан как промо — сообщение помечается как `bank = 'promotional'` и дальнейшая обработка не выполняется (только, при необходимости, аудит).
4. Определение `(bank, acc_no)` по номеру телефона:
   - выбирается номер для поиска: приоритетно `recipient` из JSON, затем `phone_to` из результата парсинга;
   - выполняется запрос к `bank_accounts`:
     ```sql
     SELECT bank, acc_no
     FROM bank_accounts
     WHERE phone = $1;
     ```
   - если одна запись — берём её;
   - если несколько — при наличии `bank` из парсинга выбираем соответствующую запись; иначе — fallback (первая запись c логированием).
5. Поиск активной записи в `queue` по `(bank, acc_no)` и `expires_at > NOW()`.
6. Постановка нотификации в `outgoing_notifications`: канал = DM по email владельца очереди; `dedup_key`, например, `otp:bank:<bank>:<acc_no>:<otp>:<timestamp_bucket>`; отправка — воркер 6.2 (retry, rate limit).
7. Аудит `bank_otp_received` с деталями (bank, acc_no, phone, otp, correlation_id).

---

### 3.3 Создание pre‑transaction (draft)

**Кратко:** `/draft` принимает два типа payload (банковский и карточный), идемпотентно сохраняет их в `drafts`, связывая с `buyer`/`profile_name` и, при необходимости, OTP. Drafts оформлены как **маленький workflow**: kind, уникальные ключи по kind, time_bucket, TTL (expires_at), state machine (pending → confirmed | expired); **matching всегда bounded по времени** (иначе pre-transaction матчится с «чем угодно» спустя недели).

#### Архитектура

- **Компоненты Processor-Hub:**
  - модуль `modules/drafts`:
    - HTTP‑эндпоинт `/draft` с типами A (bank_pre) и B (card_pre/card_otp);
    - бизнес‑логика для upsert в `drafts` и связки с профилями.
  - `DatabaseService` (DB + Farm DB) — доступ к `drafts`, профилям, пользователям.
  - `AuditService` — `pre_transaction_created` / `draft_otp_linked`.

#### Схема данных и ключи (architecture_overview.md, раздел 4.1)

- `drafts`:
  - `id`, `kind`, `status` — только переходы `pending` → `confirmed` | `expired`;
  - `bank`, `transaction_id`, `profile_name`, `buyer_email`, `card_number` (nullable), `otp`, `amount`, `currency`;
  - `time_bucket` (хранимое, для ключей card_otp/card_pre), `raw`, `payload_hash`;
  - `created_at`, `expires_at` (NOT NULL) — TTL для matching и архивации.
- **Уникальные ключи по `kind`:**
  - **`bank_pre`:** `UNIQUE(bank, transaction_id)` — один draft на операцию в банке;
  - **`card_otp`:** `UNIQUE(bank, card_number, otp, time_bucket)` (если `card_number` известен) или `UNIQUE(bank, payload_hash)` при `payload_hash = hash(profile_name, otp, time_bucket)`;
  - **`card_pre`:** `UNIQUE(profile_name, otp, time_bucket)` или `UNIQUE(bank, payload_hash)` / `UNIQUE(bank, transaction_id)` при наличии клиентского id.
- Фоновый job: перевод в `expired` и/или архивация при `expires_at < NOW()` (раздел 4.1).

#### Алгоритм тип A — банковская pre‑transaction

1. Вход: `{ transactionId, bank, profile_name }`.
2. По `profile_name` определить `buyer_email` (через Farm DB).
3. Upsert в `drafts` по ключу **`(bank, transaction_id)`** (раздел 4.1):
   - `kind = 'bank_pre'`, `status = 'pending'`;
   - `expires_at = NOW() + 7 days` (или конфиг);
   - при конфликте — обновить только разрешённые поля, статус не перезаписывать если уже `confirmed`/`expired`.
4. Аудит `pre_transaction_created` / `pre_transaction_upserted`.

#### Алгоритм тип B — карточная pre/OTP

1. Вход: `{ profile_name, otp }` (опционально `card_number`, `bank`).
2. По `profile_name` определить `buyer_email`.
3. Вычислить `time_bucket` (например, `date_trunc('minute', NOW())`).
4. Upsert в `drafts` по ключу для **`card_otp`** / **`card_pre`** (раздел 4.1):
   - при наличии `(bank, card_number)` — ключ `(bank, card_number, otp, time_bucket)`;
   - иначе — `payload_hash = hash(profile_name, otp, time_bucket)`, ключ `(bank, payload_hash)` или `(profile_name, otp, time_bucket)`;
   - `expires_at = NOW() + 24 hours` (или конфиг).
5. Аудит `card_otp_received` / `draft_otp_linked`.

---

### 3.4 Импорт банковской выписки

**Кратко:** выписка (файл) принимается по REST, пользователю сразу возвращается ответ “принят в обработку”, а сам файл/набор транзакций ставится в очередь для фонового воркера. Воркеры в разных DC обрабатывают очередь с учётом Worker concurrency control, сопоставляют транзакции с pre‑transactions (`drafts`) или по fallback‑правилам (`aff_id` → `binom`), и обновляют `bank_transactions` и аудит.

#### Архитектура

- **Внешние источники:**
  - HTTP‑загрузка файлов (CSV/XLS/XLSX/PDF) через UI/интеграции.
- **Компоненты Processor-Hub:**
  - модуль `modules/statements_import`:
    - эндпоинт `POST /statements/import` (или `/api/statements/upload`):
      - приём multipart/form‑data с файлом выписки;
      - валидация формата и размеров;
      - запись файла/метаданных в таблицу очереди импорта (`statement_import_jobs`, см. ниже) и **немедленный ответ** пользователю с `job_id` и статусом `accepted` (без ожидания парсинга и сохранения транзакций);
    - эндпоинт `GET /statements/status?id=...`:
      - проверка статуса обработки по `job_id` (`pending` / `processing` / `processed` / `failed`), опционально — сводка по количеству обработанных/ошибочных транзакций;
    - фоновые воркеры, обрабатывающие очередь import‑job’ов по модели 6.1 (`SELECT ... FOR UPDATE SKIP LOCKED`) с учётом multi‑DC;
    - парсинг файлов (через `ParserFactory`‑подобный слой) → список нормализованных транзакций `ImportedStatementTransaction`.
  - модуль `modules/transactions/confirmation`:
    - сопоставление импортированных транзакций с `drafts` и существующими `bank_transactions`;
    - fallback‑логика по `aff_id` и таблице `binom`, как в существующем `mqtt_import_by_file_transactions` (извлечение `aff_id` из суммы, поиск `buyer` по `binom`).
  - `DatabaseService`:
    - операции с `drafts`, `bank_transactions`, `bank_accounts` (создание записей для новых `(bank, acc_no)`), `binom` и таблицей очереди импорта;
  - `AuditService`:
    - события `bank_transaction_confirmed`, `bank_transaction_fallback_matched`, а также события уровня job’а (`statement_import_started/finished/failed`).

#### Схема данных

- `drafts` — как в 3.3 (раздел 4.1: ключи по `kind`, `expires_at`, state machine).
- `bank_transactions` — как в 2.6 (уникальность `(bank, acc_no, ext_id)` или `(bank, ext_id)`).
- `binom` — таблица соответствий `aff_id`, **`buyer`** (email баера), **`username`**; используется для fallback при импорте выписок и для Multicards: выпуск в группу по `buyer_email` → `aff_id`, поллинг карт — **`bank_cards.acc_no`** в виде **`username / aff_id`** (см. `modules/binom`, адаптер `multicards/cards`);
- `bank_accounts` — при импорте выписки для новых `(bank, acc_no)` создаются записи (по аналогии с текущим `save`‑роутом);
- **`statement_import_jobs`** (очередь задач на импорт):
  - `id UUID PRIMARY KEY` — идентификатор job’а, возвращаемый пользователю;
  - `file_name TEXT`, `file_type TEXT`, `file_size BIGINT`;
  - `storage_ref TEXT` или `file_contents BYTEA` (в зависимости от выбранного способа хранения: файловая система, S3, BYTEA и т.п.);
  - `status TEXT` (`pending`, `processing`, `processed`, `failed`);
  - `created_at TIMESTAMPTZ`, `started_at TIMESTAMPTZ`, `finished_at TIMESTAMPTZ`;
  - `error TEXT` (сообщение об ошибке, если `failed`);
  - `correlation_id UUID`, `idempotency_key TEXT` (по желанию, для повторного импорта того же файла/набора);
  - воркеры выбирают job’ы по `status = 'pending'` с использованием Worker concurrency control (раздел 6.1).

#### Алгоритм

1. **Приём файла (REST):**
   - клиент отправляет `POST /statements/import` с multipart/form‑data (`file`);
   - API:
     - валидирует формат/размер/тип файла;
     - создаёт запись в `statement_import_jobs` со `status = 'pending'` и сохраняет файл (в `storage_ref` или `BYTEA`/внешнее хранилище);
     - возвращает JSON `{ job_id, status: 'accepted' }` без ожидания обработки.

2. **Фоновая обработка job’а (воркер):**
   - воркер `modules/statements_import` периодически выполняет:
     - `SELECT id, ... FROM statement_import_jobs WHERE status = 'pending' ORDER BY created_at LIMIT N FOR UPDATE SKIP LOCKED`;
     - `UPDATE statement_import_jobs SET status = 'processing', started_at = NOW() WHERE id = ANY($1)`;
     - коммит;
   - затем для каждого выбранного job’а:
     - извлекает файл (по `storage_ref` / `BYTEA`);
     - вызывает парсер (по аналогии с `ParserFactory.parseFile` в `mqtt_import_by_file_transactions`) и получает список транзакций `{ amount, date, description, reference, transactionId?, bank, account_number?, ... }`;
     - приводит их к `ImportedStatementTransaction` и передаёт в модуль `modules/transactions/confirmation`.

3. **Сопоставление с `drafts` (только активные записи, контекст pre‑transaction → transaction):**
   - **Matching всегда ограничен по времени (TTL):** учитываются только записи с **`expires_at > NOW()`** и `status = 'pending'` (раздел 4.1 state machine).
   - **По ключу `bank_pre`:**
     - поиск по `(bank, transaction_id)` из выписки;
     - дополнительное сужение по окну времени и сумме (`drafts.amount`, `drafts.created_at`);
   - при успехе:
     - соответствующий draft помечается `status = 'confirmed'`;
     - `bank_transactions` обновляется: заполняются `buyer_email`, `profile_name`, статус подтверждения, а также связь между pre‑transaction и финальной транзакцией (по `draft_id` / `correlation_id`).

4. **Fallback по `aff_id` и `binom`:**
   - для транзакций, не сопоставленных с draft’ами:
     - из суммы извлекается `aff_id` (по правилам из `aff-id-extractor`, как в `mqtt_import_by_file_transactions`);
     - по `aff_id` ищется `buyer_email` в таблице `binom`;
     - при успехе `bank_transactions` обновляется с найденным `buyer_email`, флаг `fallback_used = true`.

5. **Обновление `bank_accounts` (при необходимости):**
   - для уникальных `(bank, acc_no)` из импортированных транзакций проверяется наличие записей в `bank_accounts`;
   - отсутствующие пары вставляются (`INSERT ... ON CONFLICT DO NOTHING`).

6. **Завершение job’а и аудит:**
   - при успешной обработке всех транзакций job помечается `status = 'processed'`, `finished_at = NOW()`;
   - при ошибках job помечается `status = 'failed'`, заполняется `error`, пишется аудит `statement_import_failed`;
   - на уровне транзакций пишется аудит `bank_transaction_confirmed` или `bank_transaction_fallback_matched`.

7. **Проверка статуса (REST):**
   - `GET /statements/status?id=<job_id>`:
     - возвращает `status`, `created_at`, `started_at`, `finished_at`, `error` и, опционально, агрегированную информацию (количество обработанных транзакций, количество ошибок);
     - multi‑DC: статус читается напрямую из `statement_import_jobs`, без привязки к конкретному инстансу воркера.

---

### 5. Историчность владения картами

**Кратко:** Processor-Hub обеспечивает корректную историю владения картами через `bank_cards_history`, позволяя отвечать на вопросы “чья была карта в дату X?” и “кто владелец сейчас?”.

#### Архитектура

- Функциональность реализуется внутри модулей `modules/cards/linking` и `modules/cards/profile-transfer`.
- **Инвариант (раздел 4.2):** у одной карты не может быть двух активных интервалов — не более одной строки с `valid_to IS NULL` на `card_number`. Обеспечивается частичным уникальным индексом и транзакционным паттерном «закрыть текущий → вставить новый» в одной транзакции.

#### Схема данных

- `bank_cards`:
  - текущий владелец (`buyer_email`, `profile_name`), **`is_buying`**.
- `bank_cards_history`:
  - `card_number`, `bank`, `buyer_email`, `profile_name`, **`is_buying`**;
  - `valid_from`, `valid_to`;
  - частичный уникальный индекс: `UNIQUE (card_number) WHERE valid_to IS NULL`.

#### Алгоритмы запросов (на уровне интерфейса)

- **Чья была карта на дату D?**

  - запрос к `bank_cards_history`:

  ```sql
  SELECT *
  FROM bank_cards_history
  WHERE card_number = :card_number
    AND valid_from <= :date
    AND (valid_to IS NULL OR valid_to > :date);
  ```

- **Кто владелец сейчас?**

  - запрос к `bank_cards`:

  ```sql
  SELECT buyer_email, profile_name
  FROM bank_cards
  WHERE card_number = :card_number;
  ```

#### Инварианты

- любое изменение владельца карты (привязка, передача профиля) ведёт к:
  - обновлению `bank_cards`;
  - в **одной транзакции**: закрытию текущей записи в `bank_cards_history` (`valid_to = NOW()`) и вставке новой с `valid_to = NULL` (раздел 4.2);
  - записи аудита (соответствующий тип события).
- на уровне БД для одной карты не может существовать двух строк с `valid_to IS NULL` (частичный уникальный индекс + транзакционный паттерн).

---

### 6. Инварианты Processor-Hub

1. Любая финальная транзакция имеет:
   - `amount`, `currency`, `occurred_at`, `buyer_email`, `profile_name`.
2. Любое изменение владения картой отражается в `bank_cards_history`; при этом соблюдается инвариант «один активный интервал на карту» (раздел 4.2): частичный уникальный индекс и транзакция «close previous, then insert». При каждом изменении владельца в `bank_cards` и в новой строке истории выставляется **`is_buying`** по email (принадлежность к buying‑отделу).
3. Любое значимое действие порождает запись в `audit_events` и/или MQTT‑топик `sequoia/audit`.
4. Все события (webhook, polling, outbox, OTP, выписки) обрабатываются идемпотентно.
5. Отказ внешних интеграций (MQTT, Slack, банки) не приводит к потере данных:
   - ingress всегда сначала фиксируется в БД (`incoming_transactions`, `drafts`, `outbox_events`).
6. Все исходящие Slack и MQTT публикации идут через таблицу `outgoing_notifications` (раздел 6.2); прямые вызовы Slack/MQTT из бизнес‑воркеров запрещены — гарантии дедупликации, retry и rate limit.
7. В `drafts` используются только формализованные ключи по `kind` (раздел 4.1), у каждой записи задан `expires_at`; допустимы только переходы `pending` → `confirmed` | `expired`; архивация/очистка по TTL обязательна, чтобы не раздувать таблицу и не увеличивать latency при matching.

