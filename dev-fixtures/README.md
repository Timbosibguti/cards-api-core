# Dev fixtures (processor_hub_dev_simulation_spec.md §9)

**Полное руководство по dev-контуру:** [docs/dev_simulation_developer_guide.md](../docs/dev_simulation_developer_guide.md).

Примеры тел для **POST /dev/inbox-events**. Каждый файл — JSON в формате:

```json
{
  "source": "stellarcards",
  "event_type": "transaction_created",
  "payload": { ... }
}
```

Опционально: `correlation_id`, `external_id`, `aggregate_key`, `meta`, `created_by`.

Использование (при включённом dev simulation, `DEV_SIMULATION_ENABLED=true`):

```bash
curl -X POST http://localhost:3000/dev/inbox-events \
  -H "Content-Type: application/json" \
  -d @stellarcards.transaction-created.json
```

Replay: **POST /dev/inbox-events/:id/replay** или **POST /dev/inbox-events/replay-batch** (body: `{ "ids": ["uuid1", ...] }`).

---

## Whitelist и валидация

- Допустимые **source** и **event_type** возвращает **GET /dev/whitelist**.
- При вставке события проверяются whitelist и схема payload по паре (source, event_type). При ошибке — **400** с полями `error`, `message` или `allowed`. Подробности: [dev_simulation_developer_guide.md](../docs/dev_simulation_developer_guide.md) §3.

---

## Ответ при создании события (trace)

Ответ **201** на POST /dev/inbox-events и from-fixture содержит:

- `id`, `source`, `event_type`, `status: "pending"`, `correlation_id`, `created_at`
- **trace**: `event_url` (GET статуса), `outcome_url` (GET созданных incoming_transactions / bank_transactions после обработки воркером)

Используйте `trace.event_url` и `trace.outcome_url` для навигации после инжекта.

---

## Сценарный workflow (удобный replay-слой)

1. **Список фикстур** — какие файлы можно инжектить:
   ```bash
   GET /dev/fixtures   → { "fixtures": ["stellarcards.transaction-created.json", ...] }
   ```

2. **Инжект по имени фикстуры** — без ручного чтения файла:
   ```bash
   POST /dev/inbox-events/from-fixture
   Body: { "fixture": "stellarcards.transaction-created.json" }
   → 201 { "id", "source", "event_type", "status", "correlation_id", "created_at", "trace": { "event_url", "outcome_url" } }
   ```

3. **Статус события** — один элемент или список:
   ```bash
   GET /dev/inbox-events           → список (опционально ?status=pending&limit=20)
   GET /dev/inbox-events/:id      → полная запись (payload, status, error, processed_at)
   ```

4. **Outcome** — что создано по этому событию (incoming_transactions, bank_transactions по correlation_id):
   ```bash
   GET /dev/inbox-events/:id/outcome
   → { "event_id", "status", "correlation_id", "incoming_transactions": [...], "bank_transactions": [...] }
   ```

5. **Переиграть цепочку** — один или пачка:
   ```bash
   POST /dev/inbox-events/:id/replay        → одно событие (новый id)
   POST /dev/inbox-events/replay-batch
   Body: { "ids": ["uuid1", "uuid2", ...] } → до 50 событий по порядку (массив { id, new_id, source, event_type })
   ```

У каждого нового события при создании проставляется **correlation_id** (если не передан), по нему outcome находит созданные incoming_transactions и bank_transactions после обработки воркером.

---

## Поддерживаемые обработчики (Dispatcher)

| source | event_type | Действие |
|--------|------------|----------|
| ecards, stellarcards, multicards, adscards | transaction_created, transaction_updated, provider_webhook | ingestRawTransaction → incoming_transactions |
| любой | otp_received, sms_received, sms_raw_received | Постановка в mqtt:sequoia/otp (payload: source, raw или otp/bank/acc_no/card_number) |
| ecards, stellarcards, multicards, adscards, farm_extension* | card_issued, card_updated, card_reassigned | upsertProviderCard (payload: **bank**, card_number, acc_no, created_at, note, ext_id, buyer) |
| taurus | taurus_heartbeat, taurus_status | upsertDevice → ota_devices (payload: imei, phone, version, uptime, stats) |
| sms_device | heartbeat | upsertSmsDevice → sms_devices (payload: imei, phones[], battery, charging, info) |
| любой | device_online, device_offline | no-op (логирование) |

\* **farm_extension** для card_*: в payload обязательно указать **bank** (один из платёжных источников).

---

## Маршрутизация dev=true (Farm Extension, Taurus, вебхуки)

При **dev=true** (query или body) и включённом dev simulation запрос **не идёт в production**, а сохраняется в `dev_inbox_events`; обрабатывается DevInboxWorker.

| Точка входа | Пример | source / event_type в dev_inbox |
|-------------|--------|----------------------------------|
| Платёжные вебхуки | `POST /webhooks/ecards/transaction?dev=true` | bank / `provider_webhook` |
| | `POST /webhooks/adscards/otp?dev=true` | bank / `otp_received` |
| Taurus HTTP | `POST /taurus/heartbeat?dev=true` | `taurus` / `taurus_heartbeat` |
| Taurus MQTT | сообщение в `sequoia/hardware/heartbeat` с `dev: true` в payload | `taurus` / `taurus_heartbeat` |
| Farm extension | `POST /api/events?dev=true` body: `{ event_type, payload, source? }` | body.source или `farm_extension` / body.event_type |

Без `dev=true` запрос обрабатывается как в проде. Если dev=true передан, но `DEV_SIMULATION_ENABLED=false` или `NODE_ENV=production`, возвращается 400 «Dev simulation is disabled».
