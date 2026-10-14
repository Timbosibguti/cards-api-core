## EP0 T0.1 — Корневая структура проекта

### Цель

Определить и создать базовую файловую структуру `processor-hub`, согласованную с архитектурой (`src/infra`, `src/modules`, `src/app`/`src/api`), без реализации логики.

### Требования

- Создать каталоги:
  - `src/infra` — инфраструктура (БД, MQTT, logging, slack, processing_runtime, event_contract, correlation SDK).
  - `src/modules` — доменные модули:
    - `cards`, `otp`, `transactions`, `bank_queue`, `drafts`, `statements_import`, `audit`.
  - `src/app` или `src/api` — HTTP‑слой (webhooks, внешние роуты `/cards/*`, `/queue/*`, `/draft`, `/health` и т.д.).
  - `src/config` — конфигурация/env‑обёртки.
- Файлы-заглушки:
  - `src/infra/DatabaseService.ts` (пустой класс/интерфейс).
  - `src/infra/MqttClient.ts`.
  - `src/infra/AuditService.ts`.
  - `src/infra/processingRuntime/index.ts`.
  - `src/infra/eventContract/index.ts`.
  - `src/infra/correlation/index.ts`.
- Не добавлять никакой бизнес‑логики, только каркасы (интерфейсы/классы без реализации).

### Acceptance criteria

- Структура директорий соответствует архитектурному описанию.
- Проект собирается/линтится (если настроен) с пустыми реализациями.

