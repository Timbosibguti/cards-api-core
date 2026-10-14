# MQTT Handlers: архитектура и структура каталогов

## 1. Назначение

Обработка входящих MQTT-сообщений вынесена в адаптеры по топикам. Каждый топик имеет один обработчик; список топиков получается **динамически** при старте приложения по структуре каталогов. Подключение к брокеру и подписка на все обнаруженные топики выполняются при старте приложения.

## 2. Структура каталогов

Корень обработчиков: **`src/mqtt/`**.

Иерархия каталогов **зеркалирует** имена MQTT-топиков (без префикса брокера):

- Путь каталога относительно `src/mqtt/` с разделителем `/` = имя топика.
- В каждом каталоге, соответствующем топику, лежит **`index.ts`**, экспортирующий функцию обработки сообщения.

Пример:

```
src/mqtt/
├── index.ts              # Загрузчик: сканирование каталогов и подписка на топики
├── sequoia/
│   ├── hardware/
│   │   ├── index.ts      # топик: sequoia/hardware (SMS с устройств)
│   │   ├── heartbeat/
│   │   │   └── index.ts  # топик: sequoia/hardware/heartbeat
│   │   └── ota_devicelog/
│   │       └── index.ts  # топик: sequoia/hardware/ota_devicelog
│   ├── commands/
│   │   └── index.ts      # топик: sequoia/commands (при необходимости)
│   ├── otp/
│   │   └── index.ts      # топик: sequoia/otp (потребление OTP: SMS и картовые источники)
│   └── transaction/
│       └── index.ts      # топик: sequoia/transaction
```

Итог: каталог `src/mqtt/sequoia/hardware/heartbeat/` с файлом `index.ts` → топик **`sequoia/hardware/heartbeat`**.

## 3. Контракт обработчика

Каждый `index.ts` в таком каталоге должен экспортировать по **умолчанию** функцию с сигнатурой:

```ts
export default async function handleMessage(
  topic: string,
  payload: Buffer
): Promise<void>;
```

- **topic** — нормализованное имя топика (без префикса брокера, например `sequoia/hardware/heartbeat`).
- **payload** — сырое тело сообщения (для JSON: `JSON.parse(payload.toString())`).

Ошибки в обработчике логируются в MQTT-клиенте; исключение не прерывает подписку.

## 4. Префикс топиков (topicPrefix)

В конфигурации задаётся `config.mqtt.topicPrefix` (например, `v2/`). Фактическая подписка в брокере идёт на **префикс + топик**:

- Подписка: `v2/sequoia/hardware/heartbeat`
- Входящее сообщение приходит с тем же полным путём; при вызове обработчика топик передаётся **без префикса** (`sequoia/hardware/heartbeat`).

## 5. Загрузка при старте

1. **Подключение MQTT**  
   При старте приложения вызывается `mqtt.connect()` (как и раньше, лениво при первом использовании).

2. **Сканирование обработчиков**  
   Модуль `src/mqtt/index.ts` при инициализации рекурсивно обходит каталог рядом с собой (в рантайме это `dist/mqtt/` после сборки) и ищет все файлы `index.js` в подкаталогах. Для каждого такого файла:
   - относительный путь от `dist/mqtt/` до каталога с `index.js` с заменой `\` на `/` даёт **нормализованное имя топика**;
   - выполняется динамический `import()` модуля и из него берётся `default` как обработчик.

3. **Подписка**  
   Для каждой пары (топик, обработчик) вызывается:
   - `mqtt.subscribe(topicPrefix + topic, wrapper)`  
   где `wrapper` при получении сообщения снимает префикс с `topic`, находит обработчик по нормализованному топику и вызывает его.

Важно: подписка выполняется только на **точные** имена топиков (префикс + топик), без wildcard (`#`/`+`), если иное не потребуется позже.

## 6. Hardware-топики (устройства)

Топики под префиксом `sequoia/hardware*` используются для работы с устройствами (телеметрия, SMS с устройств, логи OTA). Источник логики — проект **mqtt_otp_transactions_service**; в processor-hub перенесены:

| Топик | Назначение |
|-------|------------|
| `sequoia/hardware/heartbeat` | Heartbeat устройства: IMEI, phone, version, uptime, stats, config, board, creg, csq → upsert в `public.ota_devices`. |
| `sequoia/hardware/ota_devicelog` | Лог устройства: извлечение IMEI из JSON или текста, запись в `public.ota_device_logs`. |
| `sequoia/hardware` | SMS с устройства: from, phone, imei, text. Разрешение номера по `ota_devices` при `phone === '0'`. Далее — логирование и (в перспективе) парсинг OTP, drafts, Slack/аудит. |

Таблицы БД для hardware:

- **`public.ota_devices`** — реестр устройств (imei, phone, version, uptime, stats, config, board, creg, csq, note).
- **`public.ota_device_logs`** — логи устройств (imei, payload, raw, created_at).

Создание таблиц — в миграциях (см. миграцию `*_ota_devices.sql`).

## 7. Мобильные приложения (SmsPhone) и вебхук

**Отдельно от hardware (MQTT)** действует вебхук для мобильных приложений, присылающих SMS с телефона:

- **HTTP:** `POST /webhooks/mobile/sms` (реализация: `src/api/routes/mobileSms.ts`).
- **Таблица:** **`public.sms_devices`** — реестр мобильных устройств (тип SmsPhone из `adscards-webhook`): `imei` (PK), `phones` (TEXT[]), `battery`, `charging`, `info` (JSONB), `tg_chat`, `updated_at`. Миграция: `*_sms_devices.sql`.
- **Два формата тела запроса:**
  1. **Heartbeat (SmsPhone):** `imei`, `phones`, `battery`, `charging`, `info` → upsert в `sms_devices`.
  2. **SMS (type = 'sms_received'):** `sender`, `content`, `recipient`, опционально `imei`; при отсутствии IMEI — поиск устройства по номеру получателя в `sms_devices`; формирование `SmsOtpPayload` и постановка в `outgoing_notifications` (channel `mqtt:sequoia/otp`); воркер исходящих уведомлений **вызывает OTP-обработчик напрямую** (без публикации в MQTT).

Итог: **ota_devices** — устройства, шлющие по MQTT (`sequoia/hardware/*`); **sms_devices** — мобильные приложения, шлющие по HTTP (`/webhooks/mobile/sms`).

## 8. Обработка OTP (channel mqtt:sequoia/otp) — без MQTT

Записи в `outgoing_notifications` с **channel = `mqtt:sequoia/otp`** обрабатываются **OutgoingNotificationsWorker** напрямую: воркер вызывает тот же обработчик, что реализован в **`src/mqtt/sequoia/otp/index.ts`** (`handleMessage`), **без публикации в топик MQTT**. Подписка на топик `sequoia/otp` при старте приложения **не выполняется** (см. `src/mqtt/index.ts` — skip для `sequoia/otp`). Так устраняется зависимость доставки OTP от MQTT и гарантируется выполнение логики в том же процессе, что и запись в БД.

**Принципы (архитектура):**

- Вся доставка в Slack и аудит идёт **только через `outgoing_notifications`** (каналы `slack:dm`, `slack:#finance-otp`, `mqtt:sequoia/audit`). Прямых вызовов Slack/Telegram из обработчика нет.
- **Multi-DC:** все вставки в `outgoing_notifications` выполняются с уникальным `dedup_key` и **`ON CONFLICT (dedup_key) DO NOTHING`**, поэтому при одновременной доставке одного и того же сообщения в несколько инстансов только один инстанс создаёт записи; дубли не создаются.

**Входной формат:** JSON (возможно в envelope с `schema_version`, `payload`, `correlation_id`). Дискриминатор — **`payload.source`**.

**Ветки обработки:**

1. **`source === 'sms'`** (SmsOtpPayload):
   - Разбор `raw`: при JSON `{ content, recipient }` — текст SMS и номер получателя; иначе `raw` как текст, recipient должен быть определён.
   - Извлечение OTP из текста (regex по цифрам 4–8).
   - Поиск `(bank, acc_no)` в **`public.bank_accounts`** по полю `phone` = нормализованный recipient.
   - Поиск владельца очереди: **`queueDb.getQueueEmail(bank, acc_no)`** (активная запись в `public.queue`).
   - Постановка в `outgoing_notifications`: **DM сотруднику** (`slack:dm`, recipient = email), **канал** `slack:#finance-otp`, **аудит** `mqtt:sequoia/audit` с `event_type: 'otp_sent'` и атрибутами (bank, acc_no, otp, raw).
   - Dedup: `otp:bank:<bank>:<acc_no>:<otp>:<time_bucket>`, суффиксы `:dm`, `:channel`, `:audit`.

2. **`source` ∈ { ecards, adscards, multicards, stellarcards }** (картовые OTP):
   - Из payload: `bank`, `acc_no`, `otp` (или `code`), при необходимости `card_number`, `card_id`, `profile_name`.
   - Владелец очереди — **`queueDb.getQueueEmail(bank, acc_no)`**.
   - Постановка в `outgoing_notifications`: DM сотруднику, канал `slack:#finance-otp`, аудит `otp_sent` с атрибутами (bank, acc_no, otp, card_number, profile_name, card_id).
   - Dedup: `otp:card:<bank>:<acc_no>:<card_key>:<otp>:<time_bucket>`, суффиксы `:dm`, `:channel`, `:audit`.

**Зависимости:** `queueDb.getQueueEmail`, `public.bank_accounts`, `public.queue`, контракт `event_contract.md` (OtpPayload по source). Расширение банковских парсеров для SMS (определение банка по тексту) — в перспективе; текущая версия опирается на `bank_accounts.phone` и простой regex для OTP.

**Итоговые каналы доставки (после обработки OTP):** только Slack и MQTT для аудита/транзакций: `slack:#farm-otp`, `slack:dm`, `slack:#card-link`, `slack:#finance-otp`, `mqtt:sequoia/transaction`, `mqtt:sequoia/audit`. Топик `mqtt:sequoia/otp` не используется ни для публикации, ни для подписки.

## 9. Команды устройства (публикация)

Отправка команд устройствам (sendsms, config, ota_update и т.д.) выполняется публикацией в топик **`sequoia/hardware/command`** через общий `MqttClient`. Отдельный сервис/API для формирования команд может быть добавлен в модуле hardware или в API; детали — в HARDWARE_API_DOCUMENTATION (или аналог в репозитории mqtt_otp).

## 10. Итог

- Один каталог под топик, один `index.ts` с `default`-обработчиком.
- Топики обнаруживаются по структуре каталогов при старте.
- MQTT подключается и подписывается на все найденные топики (с учётом `topicPrefix`) при старте приложения, **кроме** `sequoia/otp` — он обрабатывается только воркером `outgoing_notifications` через прямой вызов обработчика.
