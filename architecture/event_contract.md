# Event Contract — MQTT-топики Processor-Hub

Формальный контракт событий MQTT: общий envelope, схемы по топикам (TypeScript-интерфейсы), версионирование и обратная совместимость. Источники: `mqtt_otp_transactions_service`, `mqtt_adscards_transactions`, `mqtt_multicards_transactions`, `mqtt_ecards_transactions`, `mqtt_stellarcards_transactions`, `mqtt_import_by_file_transactions`, `audit`.

---

## 1. Общий envelope (обязательные метаполя)

Каждое сообщение, публикуемое Processor-Hub или потребляемое им, **рекомендуется** (а для новых топиков — обязательно) оборачивать в единый envelope с полями версионирования и трассировки:

```ts
/** Общий envelope для всех MQTT-событий Processor-Hub */
interface MqttEventEnvelope {
  /** Версия схемы payload (semver или целое: 1, 2, …). По умолчанию 1. */
  schema_version: number;
  /** Сервис/адаптер — производитель события (processor-hub, adscards, multicards, ecards, stellarcards, sms, …). */
  producer: string;
  /** ISO8601, момент возникновения события в источнике. */
  occurred_at: string;
  /** Идемпотентность: уникальный ключ события (например hash(bank, acc_no, ext_id) или correlation_id). */
  idempotency_key?: string;
  /** Связь с запросом/цепочкой (для трассировки и аудита). */
  correlation_id?: string;
  /** Тело события — структура зависит от топика и schema_version. */
  payload: object;
}
```

- **Правила:**
  - `schema_version` — при несовместимых изменениях payload увеличивается; потребитель может отбрасывать неизвестные версии или обрабатывать по старой логике.
  - `producer` — всегда заполняется (processor-hub или идентификатор провайдера).
  - `occurred_at` — предпочтительно из источника; при отсутствии — время публикации.
  - `idempotency_key` — для топиков транзакций/OTP обязательно (дедупликация).
  - Существующие сервисы сегодня не везде шлют envelope; Processor-Hub при публикации **должен** добавлять envelope, при потреблении — принимать как «envelope + payload», так и «голый» payload (см. backward compatibility ниже).

---

## 2. Топики и схемы

**Единая модель владельца (как в `bank_cards`):** во всех топиках, где указывается сотрудник-владелец, используются только два поля:
- **`buyer`** (string) — email сотрудника (фермер или баер);
- **`is_buying`** (boolean) — сотрудник из buying‑отдела (`true`) или из farm (`false`).

Поля `farmer_email` и дублирование «buyer vs farmer» в контракте **не используются**. Legacy-продюсеры, которые до сих пор шлют `farmer_email`, при приёме в Processor-Hub маппятся: если пришло только `farmer_email` — подставляем `buyer = farmer_email`, `is_buying = false`; при публикации Processor-Hub всегда шлёт только `buyer` и `is_buying`.

---

### 2.1. `sequoia/otp`

События OTP по картам и банкам (коды подтверждения, Google-коды и т.д.). Потребляет: `mqtt_otp_transactions_service`. Публикуют: AdsCards, Multicards, eCards, StellarCards, Processor-Hub (агрегатор).

**Целевой контракт (Processor-Hub и все провайдеры):** один формат по владельцу — `buyer` + `is_buying`.

```ts
// Дискриминатор: payload.source
type OtpPayload =
  | AdscardsOtpPayload
  | SmsOtpPayload
  | EcardsOtpPayload
  | MulticardsOtpPayload
  | StellarcardsOtpPayload;

interface AdscardsOtpPayload {
  source: 'adscards';
  code: string;
  card_id: number;
  card_number: string;
  raw: string;
  card_group?: string;
  /** Email сотрудника-владельца (farm или buying). */
  buyer?: string | null;
  /** true = buying-отдел, false = farm. */
  is_buying?: boolean | null;
}

interface SmsOtpPayload {
  source: 'sms';
  /**
   * Сырой SMS-пакет от шлюза.
   * Рекомендуемый формат: JSON-строка вида
   * { "content": "<текст SMS>", "recipient": "<phone>" }
   * где recipient — номер телефона, на который пришло SMS (используется для поиска bank_accounts.phone).
   * Legacy-вариант: просто строка с текстом SMS (без recipient) — тогда телефон определяется другими способами.
   */
  raw: string;
}

interface EcardsOtpPayload {
  source: 'ecards';
  amount: string;
  otp: string;
  card_id: number;
  card_number: string;
  raw: string;
  buyer?: string | null;
  is_buying?: boolean | null;
}

interface MulticardsOtpPayload {
  source: 'multicards';
  id: number;
  description: string;
  cardId: number;
  cardNumber: string;
  amount: number;
  currency: string;
  buyer?: string | null;
  is_buying?: boolean | null;
  otp?: string | null;
  raw: string;
}

interface StellarcardsOtpPayload {
  source: 'stellarcards';
  id: number;
  merchant: string;
  card_last_four: string;
  card_guid: string;
  amount: number;
  currency_code: string;
  user_first_name: string;
  user_last_name: string;
  otp: string;
  raw: string;
  buyer?: string | null;
  is_buying?: boolean | null;
}
```

**С envelope (рекомендуемый формат для Processor-Hub):**

- `payload` — один из OtpPayload выше.
- `schema_version: 1`, `producer`: источник (adscards, ecards, multicards, stellarcards, sms, processor-hub).
- `idempotency_key`: например `otp:<source>:<card_number|card_id>:<otp>:<time_bucket>`.
- `occurred_at`: время получения OTP в источнике.

---

### 2.2. `sequoia/transaction`

Нормализованные карточные транзакции. Потребляют: `mqtt_otp_transactions_service` (Google OTP из описания), `mqtt_import_by_file_transactions` (обогащение profile_name). Публикуют: AdsCards, Multicards, eCards, StellarCards, Processor-Hub.

**Единый контракт (целевой для Processor-Hub), schema_version: 1:** владелец — только `buyer` + `is_buying` (как в bank_cards).

```ts
interface TransactionEventPayload {
  /** Идентификатор провайдера (adscards, ecards, multicards, stellarcards). */
  bank: string;
  /** Внешний id транзакции у провайдера. */
  ext_id: string;
  /** Номер счёта/группы (acc_no): aff_34, group_*, FEBRUARY и т.д. */
  acc_no?: string | null;
  /** Сумма, валюта, статус, дата. */
  amount: number | string;
  currency: string;
  status?: string;
  occurred_at?: string; // ISO8601
  /** Маска/номер карты (строка или number — в провайдерах по-разному). */
  card_number?: string | number | null;
  card_id?: number | null;
  /** Email сотрудника-владельца (как в bank_cards). */
  buyer?: string | null;
  /** true = buying-отдел, false = farm. */
  is_buying?: boolean | null;
  /** OTP из описания (Google и т.д.), если извлечён. */
  otp?: string | null;
  description?: string | null;
  /** Сырой payload провайдера (для отладки и повторного парсинга). */
  raw?: string | null;
}
```

- **idempotency_key:** `tx:<bank>:<acc_no>:<ext_id>`.
- **occurred_at** в envelope — время операции в источнике или получения события.

---

### 2.3. `sequoia/cards`

События выпуска/появления карт (итог создания карт в провайдере). Потребляют: подписчики на уведомления о новых картах. Публикуют: eCards (cards/create), Processor-Hub.

**Текущий формат (ecards cards/create):**

- Массив карт: `cards: Array<{ cardNumber, accNo, createdAt, note }>`, `timestamp` (ISO8601).

**Контракт schema_version: 1:**

```ts
interface CardsIssuedEventPayload {
  /** Источник: adscards, multicards, ecards, processor-hub. */
  source: string;
  /** Список карт. */
  cards: Array<{
    card_number: string;
    acc_no: string | null;
    created_at: string; // ISO8601
    note?: string | null;
    ext_id?: string | null;
    bank?: string;
  }>;
  timestamp: string; // ISO8601
}
```

- **idempotency_key:** опционально, например по `source` + хешу списка карт + временному окну.

---

### 2.4. `sequoia/card`

Команды к сервисам карт (например снятие лимитов). Потребляет: `mqtt_ecards_transactions` (CardLimitService). Публикует: `mqtt_otp_transactions_service` (DbProfileListener).

**Текущий формат (remove_limits):**

```ts
interface CardCommandPayload {
  action: 'remove_limits';
  card_number: string | number;
  /** Email сотрудника-владельца (поле buyer, как в bank_cards). */
  buyer: string;
}
```

**Расширяемый контракт (schema_version: 1):**

```ts
interface CardCommandPayload {
  action: 'remove_limits' | string; // для будущих команд
  card_number: string | number;
  buyer?: string; // email, как в bank_cards
  [key: string]: unknown;
}
```

- **correlation_id** — для связи с событием профиля/аудитом.

---

### 2.5. `sequoia/audit`

Аудит-события. Потребляют: сервис audit, подписчики логов. Публикуют: все сервисы, Processor-Hub.

**Текущий формат (ecards audit-validation, slack_app, openid, sync):**

```ts
interface AuditEventPayload {
  id: string;           // UUID
  timestamp: string;     // ISO8601 UTC
  division: string;     // hr, finance, buyer, …
  user_email: string;
  log_type: 'info' | 'log' | 'error' | 'warning';
  severity: number;      // 0–5
  event_type: string;    // otp_received, card_issued, …
  event_attributes?: object;
}
```

- **idempotency_key** для аудита опционален; при необходимости — по `id` или `(event_type, correlation_id, timestamp)`.
- **occurred_at** в envelope может дублировать `timestamp`.

---

## 3. Версионирование (schema_version)

- В envelope поле **`schema_version`** (целое число, по умолчанию 1):
  - при **обратно совместимых** изменениях (новые опциональные поля, расширение enum) версию не увеличивать либо оставить ту же;
  - при **несовместимых** (удаление/переименование полей, смена типа обязательного поля) — увеличить версию и описать миграцию в CHANGELOG контракта.
- Processor-Hub как производитель всегда выставляет `schema_version` и `producer`.
- Потребители могут игнорировать сообщения с неизвестной `schema_version` или логировать и обрабатывать по умолчанию (best effort).

---

## 4. Обратная совместимость (backward compatibility)

- **Приём (Processor-Hub подписан на топики):**
  - если сообщение приходит **с envelope** (`schema_version`, `producer`, `payload`, …) — парсить `payload` по `schema_version`;
  - если сообщение приходит **без envelope** (голый JSON) — считать это `schema_version = 1`, `producer = unknown`, тело = весь JSON; существующие адаптеры (adscards, multicards, ecards, stellarcards) продолжают работать без изменений.
- **Публикация (Processor-Hub издаёт в топики):**
  - всегда оборачивать в envelope с `schema_version`, `producer: 'processor-hub'`, `occurred_at`, при необходимости `idempotency_key` и `correlation_id`;
  - не удалять и не переименовывать существующие поля в `payload`; новые поля добавлять только опциональными.
- **Совместимость по топикам:**
  - текущие потребители ожидают ключевые поля в корне payload (`bank`, `source`, `buyer`); поле владельца везде единое — **`buyer`** (email), при необходимости **`is_buying`** (boolean). Legacy-поля вроде `farmer_email` при приёме маппятся в `buyer` + `is_buying`, при публикации не используются.

---

## 5. Сводная таблица топиков

| Топик                 | Назначение           | Producer(s)                    | Обязательный idempotency_key     | schema_version по умолчанию |
|-----------------------|----------------------|--------------------------------|----------------------------------|------------------------------|
| `sequoia/otp`         | OTP по картам/банкам | adscards, ecards, multicards, stellarcards, sms, processor-hub | Рекомендуется (дедуп OTP)       | 1                            |
| `sequoia/transaction` | Карточные транзакции | adscards, ecards, multicards, stellarcards, processor-hub | Да: tx:bank:acc_no:ext_id       | 1                            |
| `sequoia/cards`       | Выпуск карт          | ecards, processor-hub          | Опционально                      | 1                            |
| `sequoia/card`        | Команды картам       | processor-hub, mqtt_otp       | Нет                              | 1                            |
| `sequoia/audit`       | Аудит                | все сервисы, processor-hub     | Опционально (id события)         | 1                            |

Дополнительные топики (`sequoia/commands`, `sequoia/hardware`, …) остаются вне данного контракта до формализации.
