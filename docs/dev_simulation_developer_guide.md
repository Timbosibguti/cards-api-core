# Dev Simulation — руководство для разработчиков

Единая точка входа: как включить dev-контур, какие API использовать, как ориентироваться по ответам и ошибкам.

**Спецификация:** [processor_hub_dev_simulation_spec.md](./processor_hub_dev_simulation_spec.md)  
**Концепция:** [dev_simulation_concept.md](./dev_simulation_concept.md)  
**Фикстуры и примеры:** [../dev-fixtures/README.md](../dev-fixtures/README.md)

---

## 1. Включение

- **Переменные:** `DEV_SIMULATION_ENABLED=true`, окружение не production (`NODE_ENV !== 'production'`).
- **Проверка:** при старте в логах сообщение «Dev simulation enabled: DevInboxWorker started, /dev/* routes registered».
- В production dev-контур **всегда выключен**; запросы к `/dev/*` не регистрируются.

**Пуско-наладка Slack:** чтобы все сообщения Slack (DM и каналы) летели в один канал с указанием, куда бы они полетели в бою, задайте `SLACK_ALL_TO_CHANNEL=dev-hub` (имя канала без #). В сообщениях будет префикс `[DM: email]` или `[#канал]`.

---

## 2. Обзор API (только при включённом dev)

| Метод | Путь | Назначение |
|-------|------|------------|
| GET | `/dev/whitelist` | Допустимые `sources` и `event_types` (для UI/валидации). |
| POST | `/dev/inbox-events` | Вставка события (body: source, event_type, payload). |
| POST | `/dev/inbox-events/from-fixture` | Вставка из файла фикстуры (body: fixture: "name.json"). |
| GET | `/dev/inbox-events` | Список событий (?status=, ?limit=). |
| GET | `/dev/inbox-events/:id` | Одно событие (полная запись, статус, error). |
| GET | `/dev/inbox-events/:id/outcome` | Результат обработки: созданные incoming_transactions, bank_transactions (по correlation_id). |
| POST | `/dev/inbox-events/:id/replay` | Переиграть одно событие. |
| POST | `/dev/inbox-events/replay-batch` | Переиграть цепочку (body: ids[]). |
| GET | `/dev/fixtures` | Список имён файлов в `dev-fixtures/*.json`. |

---

## 3. Whitelist и валидация

- **Допустимые source:** `ecards`, `stellarcards`, `multicards`, `adscards`, `sms_device`, `sms_gateway`, `taurus`, `farm_extension`, `manual`.
- **Допустимые event_type:** `card_issued`, `card_updated`, `card_reassigned`, `transaction_created`, `transaction_updated`, `transaction_completed`, `transaction_failed`, `otp_received`, `sms_received`, `sms_raw_received`, `taurus_heartbeat`, `taurus_status`, `device_online`, `device_offline`, `provider_webhook`, `heartbeat`.

Узнать актуальный список: **GET /dev/whitelist** → `{ sources: string[], event_types: string[] }`.

При **POST /dev/inbox-events** и **from-fixture**:
- неразрешённый `source` или `event_type` → **400** с полем `allowed`;
- не прошедший проверку payload (по паре source + event_type) → **400** с полем `message` (например, «payload.imei required for taurus_heartbeat»).

---

## 4. Ответ при создании события (trace)

После **POST /dev/inbox-events** или **from-fixture** в ответе 201 приходят не только `id` и `status: 'pending'`, но и данные для навигации:

- **correlation_id** — используется для поиска созданных сущностей (outcome).
- **created_at** — время создания (ISO).
- **trace** — ссылки для следующих шагов:
  - **event_url** — статус события: `GET /dev/inbox-events/:id`;
  - **outcome_url** — что создано после обработки: `GET /dev/inbox-events/:id/outcome`.

Пример ответа 201:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "source": "stellarcards",
  "event_type": "transaction_created",
  "status": "pending",
  "correlation_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "created_at": "2026-03-06T12:00:00.000Z",
  "trace": {
    "event_url": "/dev/inbox-events/550e8400-e29b-41d4-a716-446655440000",
    "outcome_url": "/dev/inbox-events/550e8400-e29b-41d4-a716-446655440000/outcome"
  }
}
```

Рекомендуемый сценарий: сохранить `id` и `correlation_id`, по **event_url** проверять статус, по **outcome_url** после обработки смотреть созданные транзакции/карты.

---

## 5. Маршрутизация dev=true (без вызова прод-сервисов)

Запросы с **dev=true** (query или body) при включённом dev simulation **не идут в production**, а пишутся в `dev_inbox_events` и обрабатываются DevInboxWorker.

| Кто | Как отправить | source / event_type в dev_inbox |
|-----|----------------|----------------------------------|
| Платёжные вебхуки | `POST /webhooks/:bank/transaction?dev=true` или `.../otp?dev=true` | bank / `provider_webhook` или `otp_received` |
| Taurus HTTP | `POST /taurus/heartbeat?dev=true` | `taurus` / `taurus_heartbeat` |
| Taurus HTTP (prod, карты) | `GET /taurus/buyer-cards`, `POST /taurus/card-credentials` с заголовком **`api-key`** = **`QUEUE_API_KEY`** | не dev_inbox; см. [card_and_bank_flows.md](./card_and_bank_flows.md) § I.e |
| Taurus MQTT | В payload сообщения в `sequoia/hardware/heartbeat` поле `dev: true` | `taurus` / `taurus_heartbeat` |
| Farm extension | `POST /api/events?dev=true`, body: `{ event_type, payload, source? }` | body.source или `farm_extension` / body.event_type |

Если dev=true передан при выключенном dev simulation — ответ **400** «Dev simulation is disabled».

---

## 6. Обработчики (Dispatcher)

Какие пары source + event_type к какому действию приводят (таблица и детали) — в [dev-fixtures/README.md](../dev-fixtures/README.md) § «Поддерживаемые обработчики».  
В т.ч.: **farm_extension** может слать card_issued/card_updated с **payload.bank** (платёжный источник); **taurus_status** обрабатывается так же, как **taurus_heartbeat**.

---

## 7. Где что искать в коде

| Что | Где |
|-----|-----|
| Whitelist и валидация payload | `src/infra/devInboxWhitelist.ts` |
| Диспетчер (source + event_type → handler) | `src/infra/devDispatcher.ts` |
| Обработчики (OTP, карты, Taurus, sms_device, device_online/offline) | `src/infra/devHandlers.ts` |
| Dev API (роуты /dev/*) | `src/api/routes/dev.ts` |
| Вставка в dev_inbox при dev=true | `src/infra/devInboxIngest.ts` |
| Роуты Taurus и /api/events | `src/api/routes/taurus.ts`, `src/api/routes/eventsIngest.ts` |

Архитектура dev-контура в обзоре: [architecture/architecture_overview.md](../architecture/architecture_overview.md) §5.3.
