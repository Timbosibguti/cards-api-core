# ADR-0001: Выбор фреймворка и bootstrap-схемы

## Статус

Принято (2025-03-04).

## Контекст

Нужно зафиксировать: Next.js (app router + instrumentation) или чистый Node.js для HTTP и фоновых воркеров. От выбора зависят entrypoint, место запуска воркеров и конфигурация деплоя.

## Варианты

- **Next.js app router:** HTTP в `src/app/api/*`, воркеры в `instrumentation.ts`; единообразие с частью существующих `mqtt_*` сервисов.
- **Чистый Node.js:** отдельный HTTP-сервер (Express/Fastify/H3), воркеры в `src/index.ts`; один процесс, явный контроль над жизненным циклом и graceful shutdown.

## Решение

**Чистый Node.js + Fastify.**

- Entrypoint: `src/index.ts`. В нём по порядку: загрузка конфига (`getConfig()`), инициализация синглтонов `DatabaseService`, `MqttClient`, `ProcessingRuntime`, запуск HTTP-сервера (Fastify), запуск `ProcessingRuntime.start()` (воркеры и StuckProcessingJob). Обработка SIGTERM/SIGINT: остановка runtime → закрытие HTTP → отключение MQTT → закрытие пулов БД.
- HTTP-слой: `src/api/server.ts` (создание Fastify), роуты в `src/api/routes/` (например `health.ts`). Дополнительные роуты (`/cards/*`, `/queue/*`, webhooks) подключаются в `server.ts`.
- Воркеры и StuckProcessingJob не имеют отдельного entrypoint: они стартуют из того же процесса в `index.ts` через `getProcessingRuntime().start()` (реализация — EP1 T1.4–T1.7).

## Последствия

- Один процесс, один порт; деплой как обычный Node-сервис (systemd, Docker, K8s).
- Конфиг загружается один раз при старте; синглтоны создаются при первом обращении в `index.ts`.
- При необходимости отдельного запуска только воркеров можно вынести их в отдельный скрипт (например `src/worker-entry.ts`), который не поднимает HTTP; на текущем этапе не требуется.
