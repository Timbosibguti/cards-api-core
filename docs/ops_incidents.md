# Где и какие ошибки сохраняются (`ops_incidents`)

## Где сохраняются

Все перечисленные ниже события пишутся в **`public.ops_incidents`** (основная БД, пул **`main`**). Схема таблицы — миграция **`migrations/20260417_ops_incidents.sql`**.

Технически вставка идёт через **`recordIncident`** (`src/infra/incidents/recordIncident.ts`): поля **`occurred_at`**, **`source`**, **`kind`**, **`severity`**, **`summary`**, **`detail`** (JSONB), при необходимости **`correlation_id`**, **`dedup_key`**.

---

## Какие ошибки сохраняются (сводная таблица)

Ниже: **в каком месте кода** срабатывает запись и **какая ситуация** считается ошибкой (что уходит в **`summary` / `detail`**).

| № | Файл (от корня `processor-hub`) | Что триггерит запись (ошибка) | `source` | `kind` |
|---|----------------------------------|-------------------------------|----------|--------|
| 1 | `src/infra/payment/httpClient.ts` | Любой сбой **`getPaymentHttpClient().request()`**: не-2xx, таймаут/abort, обрыв сети, ошибка до/после `fetch`, неверные креды при разборе | `payment_http_client` | `psp_http_error` / `psp_request_timeout` / `psp_request_failed` |
| 2 | `src/modules/transactions/adapters/ecards/create.ts` | Сбой **`fetch`** на guest sign-in (токен ecards), невалидный JSON, нет `accessToken`, HTTP неуспех | `ecards_fetch` | `psp_network_error` / `psp_http_error` / `psp_response_parse_error` / `psp_response_invalid` |
| 3 | `src/modules/transactions/adapters/ecards/balances.ts` | Сбой **`fetch`** при sign-in / refresh / списке счетов в поллере балансов (сеть, HTTP, парсинг, нет токенов в ответе) | `ecards_balances_fetch` | те же `psp_*` |
| 4 | `src/modules/transactions/adapters/multicards/create.ts` | Сбой **`fetch`** на login, **`v1/card/group/list`**, **`v1/card/group/create`** или **`v1/card/batchIssue`** | `multicards_fetch` | те же `psp_*` |
| 5 | `src/modules/transactions/adapters/adscards/create.ts` | Сбой **`fetch`** на `issue_info` или `purchase` | `adscards_fetch` | те же `psp_*` |
| 6 | `src/modules/cardBlock/providers/ecards.ts` | Сбой **`fetch`** на `card/close`; отдельно — после второй попытки close всё ещё unauthorized | `ecards_card_block_fetch` | `psp_*` + при необходимости **`psp_auth_failed`** |
| 7 | `src/modules/transactions/adapters/ecards/transactions.ts` | Исключение во **внешнем** `catch` цикла поллинга транзакций | `ecards_adapter_poll` | `adapter_polling_cycle_error` |
| 8 | `src/modules/transactions/adapters/ecards/cards.ts` | То же для поллинга карт (в т.ч. при назначении группы из очереди баера — запросы к **`/user/card-group`** и **`PATCH /user/card/:id`** через **`PaymentHttpClient`**, см. также п. **1**) | `ecards_adapter_poll` | `adapter_polling_cycle_error` |
| 9 | `src/modules/transactions/adapters/ecards/otp.ts` | То же для поллинга OTP | `ecards_adapter_poll` | `adapter_polling_cycle_error` |
| 10 | `src/modules/transactions/adapters/ecards/balances.ts` | То же для внешнего `catch` цикла балансов | `ecards_adapter_poll` | `adapter_polling_cycle_error` |
| 11 | `src/modules/transactions/adapters/adscards/transactions.ts` | Внешний `catch` поллинга транзакций | `adscards_adapter_poll` | `adapter_polling_cycle_error` |
| 12 | `src/modules/transactions/adapters/adscards/cards.ts` | Внешний `catch` поллинга карт | `adscards_adapter_poll` | `adapter_polling_cycle_error` |
| 13 | `src/modules/transactions/adapters/multicards/transactions.ts` | Внешний `catch` поллинга транзакций | `multicards_adapter_poll` | `adapter_polling_cycle_error` |
| 14 | `src/modules/transactions/adapters/multicards/cards.ts` | Внешний `catch` поллинга карт | `multicards_adapter_poll` | `adapter_polling_cycle_error` |
| 15 | `src/modules/transactions/adapters/stellarcards/transactions.ts` | Внешний `catch` поллинга транзакций | `stellarcards_adapter_poll` | `adapter_polling_cycle_error` |
| 16 | `src/modules/transactions/adapters/stellarcards/cards.ts` | Внешний `catch` поллинга карт | `stellarcards_adapter_poll` | `adapter_polling_cycle_error` |
| 17 | `src/modules/cardBlock/blockCard.ts` | Исключение при **`adapter.blockCard(...)`** (любая ошибка ПС после вызова адаптера) | `card_block` | `card_block_provider_error` |
| 18 | `src/api/routes/cards.ts` | Исключение при **`adapter.create`** на **`POST /api/cards/create/:bankId`** | `cards_api` | `cards_create_provider_error` |
| 19 | `src/infra/outboxHandlers.ts` | Исключение при **`removeLimits`** в обработчике **`profile_transferred_to_buyer`** | `outbox_profile_transfer` | `remove_limits_provider_error` |
| 20 | `src/infra/profileAuthChangeWorker.ts` | Исключение при **`removeLimits`** в воркере смены auth | `profile_auth_change_worker` | `remove_limits_provider_error` |

**Блокировка у провайдера** попадает в п. **17** только если выполняется **`adapter.blockCard`** внутри **`blockCardByCardNumber`** (`src/modules/cardBlock/blockCard.ts`):

- **`POST /api/card-block/block`** — всегда вызывает **`blockCardByCardNumber`** напрямую; при исключении адаптера — п. **17**.
- **`cardBlockQueueWorker`** — сначала проверяет «уже заблокирована хабом» по **`bank_cards`**; в этом случае **адаптер не вызывается** → **п. 17 не срабатывает**. Иначе вызывается **`blockCardByCardNumber`** → при исключении адаптера — п. **17**.

---

## Расшифровка `kind` (что означает ошибка)

| `kind` | Смысл |
|--------|--------|
| `psp_http_error` | ПС вернула HTTP с телом ошибки (часто есть `http_status` в `detail`). |
| `psp_request_timeout` | Таймаут или `AbortError` / жёсткий таймаут клиента. |
| `psp_request_failed` | Сеть, сбой до ответа, ошибка кредов/конфига до успешного запроса и т.п. (без успешного HTTP-кода в контексте). |
| `psp_response_parse_error` | Ответ не разобрать как ожидаемый JSON. |
| `psp_response_invalid` | HTTP успешный, но структура/поля ответа не те (например нет токена). |
| `psp_auth_failed` | Конкретно ecards: close карты после повторной выдачи токена всё ещё unauthorized. |
| `adapter_polling_cycle_error` | Упал **весь** виток поллера (внешний `catch`); текст исключения — в `summary` / `detail.error_message`. |
| `card_block_provider_error` | Блокировка карты через адаптер завершилась исключением. |
| `cards_create_provider_error` | Выпуск карт через API хаба завершился исключением. |
| `remove_limits_provider_error` | Снятие лимитов у ПС при передаче профиля завершилось исключением. |

**`severity`:** у `payment_http_client` для ответов **4xx** обычно **`warning`**, для **5xx** и прочих сбоев — **`error`**. У остальных записей при ошибках ПС/операций — чаще **`error`** (см. вызовы в коде).

---

## Что лежит в `detail` (обобщённо)

- **HTTP / ПС:** `bank`, `method` или `operation`, `path` при необходимости, `http_status`, `error_message`, `response_body_snippet`, `timeout_ms`, `correlation_id`.
- **Поллинг:** `poller_id`, плюс стандартные поля обёртки (`bank`, `operation`, имя ошибки).
- **Блок / create / removeLimits:** `card_number`, `bank`, `ext_id`, `buyer` / `buyer_email`, `profile_name`, контекст запроса; для API create — `bin`, `quantity`, `requested_by`.

Точный набор полей смотри в соответствующем **`recordIncident`** / **`recordDirectProviderHttpIncident`** в файле из таблицы выше.

---

## Дубли строк

Один сбой HTTP внутри поллера может дать **две** строки: например `payment_http_client` и сразу после — `adapter_polling_cycle_error`, если исключение пробросилось до внешнего `catch`. Это ожидаемо: один уровень — запрос к ПС, второй — «цикл поллинга не завершился нормально».

---

## Вспомогательные функции в коде

| Функция | Файл |
|---------|------|
| `recordIncident` | `src/infra/incidents/recordIncident.ts` |
| `recordDirectProviderHttpIncident`, `recordAdapterPollingCycleError` | `src/infra/incidents/recordDirectProviderHttpIncident.ts` |
| внутр. `recordPaymentHttpFailure` | `src/infra/payment/httpClient.ts` |

Экспорт: `src/infra/index.ts`.

---

## Примеры SQL

```sql
SELECT id, occurred_at, source, kind, severity, summary
FROM public.ops_incidents
ORDER BY occurred_at DESC
LIMIT 50;

SELECT * FROM public.ops_incidents
WHERE source = 'payment_http_client'
ORDER BY occurred_at DESC
LIMIT 100;

SELECT * FROM public.ops_incidents
WHERE kind = 'adapter_polling_cycle_error'
ORDER BY occurred_at DESC;
```

---

## Как добавлять новые записи

1. Исходящий HTTP к ПС — по возможности только через **`PaymentHttpClient`** → инцидент из п. **1** сам.
2. Нельзя обойтись без **`fetch`** — **`recordDirectProviderHttpIncident`** с новым осмысленным **`source`**.
3. Новый пользовательский/фоновый сценарий — **`recordIncident`** с новым **`kind`** и предсказуемым **`detail`**.
