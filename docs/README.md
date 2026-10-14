# Техническая документация Processor-Hub

Сопроводительная документация к разработке: принятые решения, прогресс по эпикам/задачам, соглашения.

## Структура

| Документ | Назначение |
|----------|------------|
| [ADR (Architecture Decision Records)](./adr/) | Зафиксированные архитектурные и технические решения с обоснованием. |
| [implementation_progress.md](./implementation_progress.md) | Прогресс по эпикам и задачам: статус, ссылки на задачи, связь с коммитами/документами. |
| [decisions_log.md](./decisions_log.md) | Краткий хронологический лог решений (дата, суть, ссылка на ADR при наличии). |
| [mr29_unlink_dead_block.md](./mr29_unlink_dead_block.md) | MR 29: unlink-dead — блокировка карты у ПС перед отвязкой от мёртвого профиля. |
| [card_and_bank_flows.md](./card_and_bank_flows.md) | Потоки карточных/банковских сценариев, очередь **`card_block_queue`**, **eCards** очередь баера (**§ I.d**), **Taurus** API карт по **`profile_name`** (**§ I.e**), **Multicards** (**§ I.c**), `public.spends`. |
| [card_issuance_queue_phone_online.md](./card_issuance_queue_phone_online.md) | Выдача карт vs очередь банка: `phone_online` в `GET /api/queue/status` (устройство «в сети» для OTP). |
| [ops_incidents.md](./ops_incidents.md) | Таблица **`ops_incidents`**: где пишутся инциденты (ПС, поллинг, API, outbox/worker), **`source`/`kind`**, ссылки на код. |
| [korean_sms_forwarding_slack.md](./korean_sms_forwarding_slack.md) | Операционная диагностика корейских номеров и форвардинга SMS в Slack (heartbeat, логи SMS, DM-маршрутизация). |

## Связь с проектом

- **Задачи и эпики:** `tasks/` — [epics.md](../tasks/epics.md), [backlog.md](../tasks/backlog.md), отдельные файлы `tasks/ep*_t*.md`.
- **Архитектура:** `architecture/` — [architecture_overview.md](../architecture/architecture_overview.md), [processes.md](../architecture/processes.md), [event_contract.md](../architecture/event_contract.md). В обзоре описан **dev-контур** (раздел 5.3).
- **Dev simulation (dev-контур):** **[dev_simulation_developer_guide.md](./dev_simulation_developer_guide.md)** — главное руководство для разработчиков (включение, API, whitelist, валидация, trace, dev=true). Спецификация: [processor_hub_dev_simulation_spec.md](./processor_hub_dev_simulation_spec.md), концепция: [dev_simulation_concept.md](./dev_simulation_concept.md), фикстуры: [dev-fixtures/README.md](../dev-fixtures/README.md).
- **Миграции БД:** `migrations/` — файлы формата `YYYYmmdd_{migration_name}.sql`, см. [migrations/README.md](../migrations/README.md).

При реализации задач решения фиксируются в ADR или decisions_log, прогресс — в implementation_progress.md.
