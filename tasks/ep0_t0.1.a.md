## EP0 T0.1.a — Выбор фреймворка и bootstrap-схемы

### Цель

Зафиксировать, будет ли `processor-hub` построен на Next.js (app router + `instrumentation.ts`) или как чистый Node/Express/Fastify сервис, и описать схему запуска воркеров и HTTP‑слоя.

### Требования

- Сравнить варианты:
  - **Next.js app router** (по аналогии с `mqtt_*_transactions`):
    - HTTP‑роуты в `src/app/api/*`;
    - фоновые воркеры стартуют через `src/instrumentation.ts`.
  - **Чистый Node**:
    - HTTP‑сервер (Express/Fastify/H3) в `src/api/*`;
    - воркеры стартуют из `src/index.ts` или отдельного bootstrap‑модуля.
- Принять решение и зафиксировать его в:
  - `README.md` (в корне проекта);
  - отдельном разделе `architecture_overview.md` (описание API‑слоя и bootstrap’а).
- Описать:
  - где создаётся `DatabaseService`/`MqttClient` (в каком файле/слое);
  - в каком месте жизни процесса стартуют воркеры:
    - worker `incoming_transactions`;
    - worker `outbox_events`;
    - worker `outgoing_notifications`;
    - `StuckProcessingJob` и `unlink-dead`.

### Acceptance criteria

- Документация чётко описывает:
  - какой фреймворк используется;
  - где находится entrypoint HTTP;
  - как и где стартуют фоновые воркеры.
- Решение согласовано с текущей экосистемой (`mqtt_*` сервисы) и не противоречит `architecture_overview.md`.

