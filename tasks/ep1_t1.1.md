## EP1 T1.1 — Реализация `DatabaseService`

### Цель

Создать единый синглтон `DatabaseService`, инкапсулирующий подключения к основным БД: finance (draft‑db), farm, при необходимости sync/extra (finance1_ext и др.), с безопасным управлением пулами и транзакциями.

### Требования

- **Поддерживаемые подключения:**
  - Основная фин. БД (draft‑db), где живут:
    - `bank_transactions`, `incoming_transactions`, `drafts`, `bank_cards`, `bank_cards_history`, `bank_accounts`, `queue`, `outbox_events`, `audit_events`, `outgoing_notifications`.
    - Таблицы могут находиться в схемах по умолчанию (как в существующих `mqtt_*` проектах) — использовать search_path из конфига.
  - Farm DB:
    - схемы `farm_ext` и/или `public` (`tbl_profiles`, `tbl_statuses`, `tbl_users`, `tbl_profile_access_grant`).
  - Sync/HR DB (если нужно для buyers/departments):
    - `finance1_ext.*` (`employees`, `departments`, `groups`, и т.п.).

- **Интерфейс:**
  - `static getInstance(): DatabaseService` — синглтон.
  - `getClient(db?: 'main' | 'farm' | 'sync'): Promise<PoolClient>` — выдаёт клиент нужной БД.
  - helper’ы для транзакций:
    - `withTransaction<T>(db: 'main' | 'farm' | 'sync', fn: (client: PoolClient) => Promise<T>): Promise<T>`.
  - Базовые методы для часто используемых операций:
    - получение профиля/пользователя по `profile_name`, `auth_id`, email (с учётом `farm_ext`/`public`);
    - базовые helpers по `bank_cards`/`bank_transactions` (без бизнес‑логики, только общие запросы).

- **Реализация пулов:**
  - Использовать `pg.Pool` с конфигом из `config.database`, `config.farmDatabase`, `config.syncDatabase`.
  - Пулы инициализируются лениво.
  - При завершении процесса/сигнала (`SIGTERM`/`SIGINT`) вызывается `pool.end()` для всех пулов.

- **Примеры SQL (псевдо):**
  - Чтение профиля из Farm DB:
    ```sql
    SELECT tprof.name
    FROM farm_ext.tbl_profiles tprof
    JOIN farm_ext.tbl_statuses ts ON ts.id = tprof.status_id
    WHERE tprof.name = $1;
    ```
  - Фолбэк на `public`:
    ```sql
    SELECT tprof.name
    FROM public.tbl_profiles tprof
    JOIN public.tbl_statuses ts ON ts.id = tprof.status_id
    WHERE tprof.name = $1;
    ```

### Acceptance criteria

- Все модули используют `DatabaseService` для доступа к БД.
- Есть базовые unit/integration‑тесты и/или playground‑скрипт, подтверждающий подключение к каждой схеме (`farm_ext/public`, `finance1_ext`).

