## Миграции в `processor-hub`

- **Все миграции выполняются только вручную.**
- Схемы таблиц, индексы, ограничения и любые изменения структуры БД описываются **только** в виде отдельных `.sql`‑файлов в этой папке.
- Запрещено использовать автогенерацию миграций ORM/фреймворками или хранить миграции в других форматах.

### Существующие таблицы vs новые

- **Изменения существующих таблиц** (например `bank_transactions`) оформляются **отдельными чистыми миграциями**: только `ALTER TABLE`, индексы по добавленным полям. Новые таблицы в таких файлах не создаются.
- **Новые таблицы** (incoming_transactions, outbox_events, outgoing_notifications и т.п.) — в отдельных миграциях с явным указанием в комментарии, что создаются новые объекты.

### Текущие миграции (2026-03-04 — 2026-03-06)

| Файл | Назначение |
|------|------------|
| `20260304_alter_bank_transactions.sql` | Только расширение существующей таблицы `bank_transactions`: `idempotency_key`, `correlation_id`, уникальный индекс. |
| `20260304_init_core_tables.sql` | Создание таблиц processing runtime: `incoming_transactions`, `outbox_events`, `outgoing_notifications`. Существующие таблицы не изменяет. |
| `20260306_farm_profile_auth_changes.sql` | **Применять к БД Farm**: таблица `farm_ext.tbl_profile_auth_changes` (канон Farm DB: имена с префиксом `tbl_`), триггер на `tbl_profiles` при изменении `auth_id`. Полная подготовка Farm DB: `bootstrap_farm_db.sql`. |
| `bootstrap_full_structure.sql` | **Разовая** подготовка основной БД: все таблицы/колонки/индексы (CREATE IF NOT EXISTS, ALTER ADD COLUMN IF NOT EXISTS). В конце — закомментированный блок очистки bank_transactions и outgoing_notifications для локального запуска. |
| `bootstrap_farm_db.sql` | **Разовая** подготовка Farm DB: схема farm_ext, таблица `tbl_profile_auth_changes`, триггер. Старый триггер (NOTIFY) не удаляется. |
| `truncate_for_local_run.sql` | Опционально: TRUNCATE `bank_transactions` и `outgoing_notifications` (оставляем `bank_cards`) для локального запуска. |
| `20260306_bank_cards_history_and_is_buying.sql` | Основная БД: таблица `bank_cards_history` (интервалы владения картами), колонка `is_buying` на `bank_cards`. См. architecture_overview.md §4.2. |
| `20260306_statement_import_jobs_dead_letter.sql` | Ограничение CHECK для `statement_import_jobs.status`: допустимые значения включают `dead_letter`. См. docs/state_machines.md §5. |
| `20260306_dev_inbox_events.sql` | Таблица `dev_inbox_events` и представление `dev_inbox_events_recent` для dev simulation (processor_hub_dev_simulation_spec.md). |

### Именование файлов

Формат: **`YYYYmmdd_{migration_name}.sql`**

- `YYYYmmdd` — дата создания миграции (год, месяц, день).
- `{migration_name}` — краткое осмысленное имя на английском, слова через подчёркивание.

Примеры:

- `20260304_init_core_tables.sql`
- `20260304_add_outgoing_notifications.sql`
- `20260305_add_is_buying_to_bank_cards.sql`

### Правила

- Один `.sql`‑файл — одна логическая миграция (изменение схемы).
- **Внутри каждого файла** в начале должны быть комментарии (SQL-комментарии `--` или блочные `/* ... */`): назначение миграции, перечень затрагиваемых объектов, при необходимости — ссылка на задачу/эпик (например, `-- EP2 T2.1`).
- Применение миграций (на dev/stage/prod) выполняется отдельными скриптами/процессами DBA/инженеров и фиксируется в истории деплоя (вне данного файла).

Это правило является **обязательным** для проекта `processor-hub`.

