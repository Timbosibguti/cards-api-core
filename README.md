# Cards API Core (processor-hub)

Единый сервис для работы с платёжными системами и банками: webhooks, polling, карты, очереди OTP, нормализация транзакций, Slack и MQTT.

Публичное имя репозитория: **cards-api-core**. Внутреннее кодовое имя пакета: `processor-hub`.

## Быстрый старт

1. Скопируйте окружение:

   ```bash
   cp .env.example .env
   ```

2. Заполните `.env` (PostgreSQL, `QUEUE_API_KEY`, `ENCRYPTION_KEY`, провайдеры карт по необходимости).

3. Примените миграции из [`migrations/`](migrations/).

4. Запуск:

   ```bash
   npm install
   npm run build && npm start
   # или
   npm run dev
   ```

Health: `GET /health`, readiness: `GET /readiness`.

## Стек

- Node.js 20+, TypeScript (ESM), Fastify
- Entry: `src/bootstrap.ts` → HTTP + MQTT + background workers

## Безопасность

- Не коммитьте `.env`, `deploy/env_file`, дампы `*.json` с транзакциями в корне.
- В **production** обязателен `QUEUE_API_KEY`; шифрование bank credentials — `ENCRYPTION_KEY`.

## Документация и планирование

| Раздел | Описание |
|--------|----------|
| [Архитектура](architecture/) | Обзор архитектуры, процессы, контракт событий. |
| [Задачи и эпики](tasks/) | [epics.md](tasks/epics.md), [backlog.md](tasks/backlog.md), постановки задач. |
| [Техническая документация](docs/) | Принятые решения (ADR), прогресс реализации, журнал решений. |
| [Источники и справочные материалы](tools/) | Документация по внешним источникам и интеграциям; при реализации задач ориентируйтесь в первую очередь на материалы из `tools/`. |
| [Миграции БД](migrations/) | SQL-миграции в формате `YYYYmmdd_{migration_name}.sql`. |

При реализации задач решения фиксируются в [docs/](docs/), прогресс — в [docs/implementation_progress.md](docs/implementation_progress.md). Для источников данных, внешних схем и интеграционных деталей используйте документацию из [tools/](tools/) как основной ориентир.
