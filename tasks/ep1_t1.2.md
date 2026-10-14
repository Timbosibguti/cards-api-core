## EP1 T1.2 — Реализация `MqttClient` (singleton)

### Цель

Создать единый `MqttClient`‑синглтон для подключения к брокеру MQTT, подписки на топики и публикации сообщений по Event Contract.

### Требования

- **Интерфейс:**
  - `static getInstance(): MqttClient`.
  - `connect(): Promise<void>` — ленивое подключение, хранит `connectionPromise`.
  - `publish(topic: string, payload: object, opts?: { qos?: 0|1|2 }): Promise<void>`.
  - `subscribe(topic: string, handler: (topic: string, payload: Buffer) => Promise<void>, opts?: { qos?: 0|1|2 }): Promise<void>`.
  - Поддержка нескольких хэндлеров и wildcard‑подписок.

- **Конфигурация:**
  - URL/хост/порт/логин/пароль из `config.mqtt`.
  - `clientId` вида `processor-hub-<role>-<pid>`.
  - `keepalive`, `connectTimeout`, `reconnectPeriod` — из конфига (значения по умолчанию как в `mqtt_*` сервисах).

- **Поведение:**
  - Обработка событий `connect`, `reconnect`, `close`, `offline`, `error` с логированием.
  - Автоматический reconnect при потере соединения.
  - Публикация:
    - сериализация `payload` в JSON;
    - QoS=1 по умолчанию;
    - логирование успеха/ошибок.

- **Связь с Event Contract:**
  - Поверх `publish` будет работать helper, формирующий envelope (`schema_version`, `producer`, `occurred_at`, `idempotency_key`, `correlation_id`) — описано в задачах EP8.

### Acceptance criteria

- Умеет подключаться к локальному/тестовому брокеру (по аналогии с существующими проектами).
- Подписка и публикация работают корректно на тестовых топиках.

