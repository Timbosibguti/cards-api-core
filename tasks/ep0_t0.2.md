## EP0 T0.2 — Env-переменные и конфигурация

### Цель

Определить полный список `env`‑переменных для `processor-hub` и оформить их в единый типизированный конфигурационный слой.

### Требования

- Составить список `env`‑переменных, опираясь на существующие проекты:
  - БД:
    - `DATABASE_URL` или отдельные `DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME`;
    - указание схем (search_path) для `finance*_ext`, `farm_ext`, `public`.
  - Farm DB:
    - `FARM_DB_HOST/PORT/USER/PASS/NAME`;
    - `FARM_DB_SCHEMA` (`farm_ext` или `public`).
  - MQTT:
    - `BROKER_HOST`, `BROKER_PORT`, `BROKER_USER`, `BROKER_PASS`;
    - `MQTT_TOPIC` (по умолчанию `sequoia/otp` или `sequoia/transaction`);
    - `MQTT_TRANSACTION_TOPIC`, при необходимости.
  - Slack:
    - `SLACK_APP_URL`, `SLACK_API_KEY`, каналы/члены по умолчанию для уведомлений.
  - Unlink-dead:
    - `UNLINK_DEAD_DEFAULT_DAYS` (по умолчанию 7);
    - `UNLINK_DEAD_STELLARCARDS_DAYS` (по умолчанию 30);
    - `UNLINK_DEAD_BILLING_BINS` (список BIN’ов).
  - Прочие (token‑сервисы платёжных систем, HTTP‑клиенты и т.д.).
- Оформить конфиг:
  - `src/config/env.ts` или аналогичный модуль:
    - чтение `process.env`;
    - приведение типов (числа, bool, массивы);
    - значения по умолчанию (как в `architecture_overview.md`).
  - `src/config/index.ts` — экспорт финального `config` объекта с разделами:
    - `database`, `farmDatabase`, `mqtt`, `slack`, `unlinkDead`, `providers.ecards/multicards/...`.

### Acceptance criteria

- Все модули используют **один** конфиг‑объект, не читают `process.env` напрямую.
- Документация содержит таблицу переменных и их значения по умолчанию.

