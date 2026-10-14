# Processor-Hub — Процессные диаграммы (Mermaid)

Версия: 1.0  
Назначение: Визуализация ключевых процессов Processor-Hub

---

# 0. Архитектурно-программная диаграмма (программные слои)

Показаны программные слои Processor-Hub: от API и адаптеров до инфраструктуры. Авторизационный слой (credentials + PaymentHttpClient) — единая точка для кредов и исходящего HTTP к платёжным системам.

```mermaid
flowchart TB
  subgraph API["API-слой"]
    WEB["Webhooks /api/webhooks/:provider"]
    ROUTES["Роуты карт, очередей, балансов, draft"]
    HEALTH["/health, диагностика"]
  end

  subgraph ADAPTERS["Слой интеграции (адаптеры)"]
    EC["eCards adapter"]
    MC["Multicards adapter"]
    SC["StellarCards adapter"]
    AC["AdsCards adapter"]
    BANKS["Банки / выписки"]
  end

  subgraph AUTH["Авторизационный слой"]
    CREDS["Хранилище кредов\n(API key, login/pass, токены)"]
    PHC["PaymentHttpClient\nединый HTTP-клиент"]
    CREDS --> PHC
  end

  subgraph CORE["Core-слой"]
    CARDS["cards: выпуск, привязка, история"]
    TX["transactions: ingest, processor"]
    OTP["otp: парсинг, маршрутизация"]
    DRAFTS["drafts: bank_pre, card_otp"]
    QUEUE["bank_queue: acquire/release"]
    STMT["statements_import"]
    AUDIT["audit"]
  end

  subgraph INFRA["Инфраструктурный слой"]
    DB["DatabaseService\n(DB, Farm DB)"]
    MQTT["MqttClient"]
    RUNTIME["processing_runtime\nворкеры, stuck job"]
    SLACK["Slack-клиент\n(только из outgoing_notifications)"]
  end

  subgraph EXTERNAL["Внешние системы"]
    PS["Платёжные системы\n(eCards, Multicards, …)"]
    SL["Slack"]
    EMQX["EMQX MQTT"]
  end

  WEB --> ADAPTERS
  ROUTES --> CORE
  HEALTH --> INFRA

  ADAPTERS --> PHC
  PHC -->|"HTTP + auth"| PS
  ADAPTERS --> CORE

  CORE --> DB
  CORE --> RUNTIME
  RUNTIME --> MQTT
  RUNTIME --> SLACK
  SLACK --> SL
  MQTT --> EMQX
  CORE --> AUDIT
```

**Пояснения:**

- **API-слой:** приём webhooks, роуты для карт/очередей/балансов/draft, health.
- **Адаптеры:** маппинг форматов провайдеров во внутреннюю модель; **не** делают свой fetch — все вызовы к провайдерам через **PaymentHttpClient**.
- **Авторизационный слой:** централизованные креды и единый HTTP-клиент для платёжных систем (retry, таймауты, correlation_id).
- **Core:** бизнес-процессы (processes.md), оркестрация, идемпотентность, outbox/incoming.
- **Инфраструктура:** БД, MQTT, processing runtime, Slack (только из воркера outgoing_notifications).

---

# 1. Общая архитектура обработки событий

```mermaid
flowchart LR

  subgraph INGRESS
    WH["Webhooks: /ingest/webhook/:provider"]
    POLL["Polling workers"]
    DRAFT["/draft"]
    OTPIN["/ingest/otp"]
  end

  subgraph BUS
    INQ[(incoming_transactions)]
    OBOX[(outbox_events)]
    ONOT[(outgoing_notifications)]
  end

  subgraph CORE
    W_IN["IncomingWorker"]
    W_OB["OutboxWorker"]
    W_NO["NotifyWorker"]
  end

  subgraph EXT
    MQTT["EMQX MQTT"]
    SL["Slack"]
  end

  WH --> INQ
  POLL --> INQ
  DRAFT --> INQ
  OTPIN --> INQ

  INQ --> W_IN
  W_IN --> ONOT

  OBOX --> W_OB
  W_OB --> ONOT

  ONOT --> W_NO
  W_NO --> SL
  W_NO --> MQTT
```

---

# 2. Карточные операции

```mermaid
flowchart TD
  A[Card issued] --> B[Farmer links card]
  B --> BC[(bank_cards)]
  B --> H[(bank_cards_history)]
  B --> AU[(audit)]

  X[Profile transferred to Buyer] --> OBOX[(outbox_events)]
  OBOX --> WOB[OutboxWorker]
  WOB --> BC
  WOB --> H
  WOB --> AU2[(audit)]

  GC[Google-code arrives] --> INQ[(incoming_transactions)]
  INQ --> WIN[IncomingWorker]
  WIN --> BC
  WIN --> ONOT[(outgoing_notifications)]
  ONOT --> SL[Slack]

  PSP[Provider webhook/poll] --> INQ
  WIN --> BT[(bank_transactions)]
  WIN --> AU3[(audit)]
```

---

# 3. Банковский процесс

```mermaid
flowchart TD
  Q1[Buyer /queue/acquire] --> QDB[(queue)]
  Q1 --> AUQ[(audit)]

  SMS[Bank OTP SMS] --> INQ[(incoming_transactions)]
  INQ --> WIN[IncomingWorker]
  WIN --> QDB
  WIN --> ONOT[(outgoing_notifications)]
  ONOT --> SL[Slack]

  D1[POST /draft bank_pre] --> INQ
  WIN --> DR[(drafts kind=bank_pre)]

  IMP[Bank statement import] --> INQ
  WIN --> DR
  WIN --> BT[(bank_transactions)]
  WIN --> AUF[(audit)]
```

---

# 4. /draft два типа

```mermaid
sequenceDiagram
  participant Client
  participant API
  participant INQ
  participant Worker
  participant Drafts

  alt Bank pre-transaction
    Client->>API: {transactionId, bank, profile_name}
    API->>INQ: insert pending
    Worker->>Drafts: upsert bank_pre
  else Card OTP
    Client->>API: {profile_name, otp}
    API->>INQ: insert pending
    Worker->>Drafts: upsert card_pre
  end
```

---

# 5. Импорт выписки + fallback

```mermaid
flowchart LR
  S[Statement row] --> M{transactionId exists?}
  M -->|yes| D[Find draft]
  D -->|found| C1[Confirm transaction]
  D -->|not found| F[Fallback]
  M -->|no| F

  F --> F1[Extract aff_id from amount]
  F1 --> F2[Resolve buyer]
  F2 --> C2[Upsert bank_transaction]
```

---

# 6. История владения картой

```mermaid
flowchart TD
  CH[Ownership change] --> H[(bank_cards_history)]
  CH --> C[(bank_cards current)]

  Q1[Query owner at date] --> H
  Q2[Query current owner] --> C
```

---

# 7. Processing runtime + retry/backoff (outgoing_notifications)

```mermaid
sequenceDiagram
  participant W as NotifyWorker
  participant DB as outgoing_notifications
  participant SL as Slack API

  loop pick pending
    W->>DB: SELECT ... FOR UPDATE SKIP LOCKED<br/>WHERE status='pending'<br/>AND next_retry_at <= NOW()
    DB-->>W: rows (notifications)
    W->>DB: UPDATE ... SET status='sending', sending_started_at=NOW()
    alt send OK
      W->>SL: POST message
      SL-->>W: 200 OK
      W->>DB: UPDATE ... SET status='sent', sent_at=NOW()
    else Slack 429
      W->>SL: POST message
      SL-->>W: 429 Too Many Requests<br/>Retry-After = N
      W->>DB: UPDATE ... SET attempts=attempts+1,<br/>status='pending',<br/>next_retry_at=NOW()+Retry-After
    else other error
      W->>SL: POST message
      SL-->>W: 5xx / network error
      W->>DB: UPDATE ... SET attempts=attempts+1,<br/>last_error=...,<br/>next_retry_at=NOW()+backoff(attempts),<br/>status = attempts>=max_attempts ? 'failed' : 'pending'
    end
  end
```

---

# 8. Очередь в банк и OTP от банка

```mermaid
sequenceDiagram
  participant Buyer
  participant API as /queue/acquire
  participant QDB as queue
  participant Bank
  participant SMSG as SMS-gateway
  participant MQTT as sequoia/otp (source='sms')
  participant OTP as modules/otp/bank-otp
  participant BA as bank_accounts
  participant ON as outgoing_notifications

  Buyer->>API: POST /queue/acquire {bank, acc_no}
  API->>QDB: INSERT/UPDATE lease row (atomic)
  API-->>Buyer: 200 acquired

  Bank-->>SMSG: SMS with OTP
  SMSG-->>MQTT: publish {source:'sms', raw:{content,recipient}}
  MQTT-->>OTP: SmsOtpPayload
  OTP->>OTP: parse via SmsParser<br/>→ bank, otp, phone_to
  OTP->>BA: SELECT bank, acc_no WHERE phone = recipient/phone_to
  OTP->>QDB: find active lease for (bank, acc_no)
  OTP->>ON: insert OTP notification<br/>(DM buyer, channel finance-otp)
```

---

# 9. Hardware устройства + SmsPhones/Sms + OTP

```mermaid
sequenceDiagram
  participant HW as Hardware device
  participant WH as /WebhookController (adscards-webhook → Processor-Hub)
  participant DB as sms_phones / sms
  participant OTP as modules/otp/bank-otp

  HW-->>WH: JSON SmsPhone {imei, battery, phones[]}
  WH->>DB: UPSERT sms_phones by imei

  HW-->>WH: JSON Sms {type:'sms_received', imei?, sender, recipient, content}
  WH->>DB: INSERT INTO sms (...)
  WH->>OTP: forward raw SMS → SmsOtpPayload (source='hardware', raw)
  OTP->>OTP: parse & route как в процессе 3.2<br/>(поиск bank_accounts, queue, outgoing_notifications)
```

---

# 10. Импорт выписок как job + matching drafts

```mermaid
sequenceDiagram
  participant User
  participant API as /statements/import
  participant JOB as statement_import_jobs
  participant W as StatementImportWorker
  participant PARS as ParserFactory
  participant DR as drafts
  participant BT as bank_transactions

  User->>API: POST multipart/form-data (file)
  API->>JOB: INSERT {file_name, storage_ref, status='pending'}
  API-->>User: {job_id, status:'accepted'}

  loop worker tick
    W->>JOB: SELECT ... FOR UPDATE SKIP LOCKED WHERE status='pending'
    W->>JOB: UPDATE status='processing', started_at=NOW()
    W->>PARS: parseFile(file_name, buffer)
    PARS-->>W: [ImportedStatementTransaction]
    W->>DR: match active drafts (kind=bank_pre, TTL)
    W->>BT: upsert bank_transactions (matched / fallback aff_id→buyer)
    W->>JOB: UPDATE status='processed', finished_at=NOW()
  end
```

---

# 11. Unlink-dead (batch отвязка карт от мёртвых профилей, полночь)

```mermaid
flowchart TD
  subgraph SCHED["Расписание"]
    T[Каждую минуту проверка:<br/>час=0, минута=0?]
  end

  subgraph FARM_DB
    FP[tbl_profiles + tbl_statuses<br/>phase_id=4, stage_id=1, updated_at]
  end

  subgraph MAIN_DB
    BC[(bank_cards)]
    ON[(outgoing_notifications)]
  end

  subgraph HUB
    WD[UnlinkDeadWorker<br/>infra/unlinkDeadWorker]
  end

  T -->|да, раз в сутки| WD
  WD --> FP
  WD -->|выбор карт по dead profile| BC
  WD -->|для карт без is_bad: adapter.blockCard| BPS[Провайдер карты]
  BPS -->|успех| WDOK[setCardOwnership + is_bad=true<br/>acc_no='blocked at ...'<br/>last_used_at]
  BPS -->|ошибка| WDSKIP[без UPDATE bank_cards<br/>повтор в следующем прогоне]
  WDOK --> BC
  WDOK -->|на каждую карту: mqtt:sequoia/audit<br/>event_type=bank_card_blocked<br/>user_email=buyer или system@groscloud.com<br/>source=unlink_dead| ON
  WD -->|ветка уже is_bad / legacy unlink:<br/>audit card_unlinked| ON
  WD -->|сводка| ON
  ON -->|воркер 6.2| MQTT[sequoia/audit]
  ON -->|воркер 6.2| SL[Slack #farm-otp]
```

---

# 12. Управление балансами и лимитами банков

```mermaid
sequenceDiagram
  participant U as Finance user
  participant API as /balances*
  participant BA as bank_accounts
  participant BH as balance_history

  U->>API: GET /balances
  API->>BA: SELECT bank, acc_no, balance, limits, creds
  BA-->>API: rows
  API-->>U: accounts + daily_operations

  U->>API: POST /balances/update-balance {bank, acc_no, balance}
  API->>BA: UPDATE bank_accounts SET balance=...

  U->>API: POST /balances/add-balance {bank, acc_no, amount}
  API->>BA: SELECT current balance,currency
  API->>BA: UPDATE bank_accounts SET balance=balance+amount
  API->>BH: INSERT balance_change {before, after, amount, user, source}

  U->>API: POST /balances/update-limits {bank, acc_no, ...limits, phone}
  API->>BA: UPDATE bank_accounts SET *_limit_alert, phone=...

  U->>API: POST /balances/update-credentials {bank, acc_no, login,password,extra}
  API->>BA: UPDATE bank_accounts SET encrypted creds, extra

  U->>API: GET /balances/history?bank&acc_no
  API->>BH: SELECT changes for account
  BH-->>API: history
  API-->>U: JSON history
```

---

Документ предназначен для визуального понимания потоков.
