# Выдача карт и статус очереди: «телефон / устройство в сети»

Документ описывает, как в **processor-hub** отражается готовность **телефона/устройства** при приёме OTP для банковской очереди — не путать с **выдачей свободных карт** по BIN (`get-by-bin` / `reserveFreeCardByBin`).

## Две разные темы

| Тема | Где в коде | Смысл |
|------|------------|--------|
| **Свободная карта фарму** | `src/infra/cardsDb.ts` — `reserveFreeCardByBin`, `countFreeCardsByBin`, фильтры `acc_no`, `last_used_at`, `released_at`, `NOT is_bad` | Атомарный резерв карты под `profile_name`; устройство не участвует. |
| **Очередь на банк + OTP по SMS** | `src/api/routes/queue.ts` — `GET /api/queue/status`; `src/infra/queuePhoneOnline.ts` | Для каждой строки `(bank, acc_no)` считается флаг **`phone_online`**. |

## `POST /api/queue/acquire`

Перед остальной логикой (конфликт «уже занят другой слот», `acquireQueue`) вызывается **`getPhoneOnlineForQueueAcquire`** — тот же расчёт, что и для `phone_online` в status.

- Если аккаунта нет в `bank_accounts` → **404** `Bank account not found`.
- Если **`phone_online` был бы `false`** → **409**, тело: `{ success: false, code: 'device_offline', error: '...' }`, аудит **`queue_acquire_device_offline`**.

Клиенты могут ориентироваться на **`code: 'device_offline'`**.

## `GET /api/queue/status`

После выборки статусов очереди (`queueDb.getBankStatus`) вызывается **`enrichBankStatusWithPhoneOnline`**.

**Кеш (in-process):** ответ кешируется **по email из JWT** на **60 секунд** (`src/infra/queueStatusCache.ts`), чтобы снизить нагрузку при частом опросе (например расширением). Кеш сбрасывается при успешных **`acquire` / `release` / `credentials` / `kickoff`** и при авто-снятии слота по **`expires_at`** в **`queueNotificationWorker`**. Повторный запрос в пределах минуты без мутаций отдаёт тот же JSON без повторных запросов к БД.

В ответе каждый элемент списка может содержать:

- **`phone_online: boolean`** — можно ли считать «линию» для OTP **свежей** (устройство в сети по порогу времени).

### Как считается `phone_online`

Файл: `src/infra/queuePhoneOnline.ts`.

- Порог **`PHONE_ONLINE_THRESHOLD_MINUTES = 2`**: если последняя активность **старше** этого окна, **считаем «не в сети»** → **`phone_online: false`**.
- Для **`ota_devices`**: ориентир **`sim_last_network_at`** (не `updated_at` — heartbeat может быть без сотовой сети).
- Для **`sms_devices`**: если OTA не сматчился, **fallback** по **`updated_at`** и совпадению номера телефона с `bank_accounts.phone`.
- Если телефон не привязан или нет записи устройства — **`phone_online: false`**.

### Как использовать на клиенте

- **`phone_online === false`** — устройство **не считается в сети** для приёма OTP в разумном окне; UI может показывать предупреждение и **не полагаться** на мгновенную доставку OTP.
- Это **не блокирует** выдачу карт и **не меняет** `bank_cards` — только информирует статус очереди.

## Связь с MR 29 (unlink-dead)

Не пересекается: MR 29 меняет только поток **мёртвых профилей** и блокировку у ПС. Фильтры выдачи свободных карт по-прежнему в `cardsDb` (`is_bad`, `last_used_at`, `released_at`, `acc_no`).

## См. также

- [card_and_bank_flows.md](./card_and_bank_flows.md) — раздел III (очередь на банк).
- `src/infra/queueDb.ts`, `src/api/routes/queue.ts`.
