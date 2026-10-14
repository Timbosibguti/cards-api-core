# `farm_ext` schema cheat sheet

Короткий рабочий справочник по `farm_ext`, актуализированный по живой БД `information_schema` и Retool-коду из `/Users/alexander/Development/Sequoia/retool`.

Цель файла: быстро отвечать на вопросы вида "откуда брать поле", "как джойнить", "какие инварианты ожидает код", не раздувая контекст.

## Краткая карта схемы

- `tbl_profiles` — центральный объект. Почти любой сценарий стартует отсюда.
- `tbl_users` — ключевой справочник пользователей Retool и владельцы профилей байеры.
- `tbl_statuses -> tbl_stages / tbl_phases` — нормализованный статусный слой профиля.
- `tbl_profile_access_grant` — временный operational lock: кто взял профиль в работу у farmer / fixer.
- `tbl_buyer_limits + tbl_buyer_geo_access` — актуальная модель лимитов и GEO-доступа buyer.
- `tbl_delivery_profile` — очередь и история выдачи профилей buyer; `delivery_status_id = 3` считать фактом успешной выдачи.
- `tbl_profile_settings` — rules engine для выбора `proxy/extensions/method` по `country + group + method`.
- `tbl_profile_group_link`, `tbl_profile_user_link`, `tbl_users_groups` — доступы и связи через branch/group.
- `tbl_groups_tags + tbl_profile_tags` — buyer tags.
- `tbl_profiles_localtags` — локальные текстовые теги для farm/control, отдельно от buyer tags.
- `tbl_statuses_log`, `tbl_logs`, `tbl_delivery_log`, `tbl_profile_auth_changes` — аудит и техлоги.
- `tbl_take_to_work_jobs + tbl_take_to_work_job_items` — async-модель массового `take to work`.

Для людей:

- схема обслуживает жизненный цикл профилей: создание, фарм, фиксы, выдачу buyer, возврат, группировку, теги и аудит
- есть три разных слоя "назначения" профиля:
  - владелец профиля: `tbl_profiles.auth_id`
  - кто временно взял профиль в работу: `tbl_profile_access_grant`
  - кому профиль выдавался батчем: `tbl_delivery_profile.auth_id`
- есть две модели тегов:
  - buyer/group tags: `tbl_groups_tags` + `tbl_profile_tags`
  - local tags: `tbl_profiles_localtags`
- есть две модели лимитов:
  - актуальная: `tbl_buyer_limits` + `tbl_buyer_geo_access`
  - legacy: `tbl_buyers_limits`

## Роли

- `farmer`: создает и дофармливает профили, работает в `Farm`-статусах.
- `buyer`: получает профили, ведет buyer-статусы, кампании, теги, лимиты.
- `fixer`: чинит сломанные профили, работает в `Fixer`-статусах.

## Что обновлено в этой версии файла

- В `tbl_profiles` добавлены поля `profile_data jsonb` и `profile_synced_at timestamptz`.
- В `tbl_feature_flags` добавлено поле `settings jsonb`.
- Вынесены в основное описание реальные рабочие таблицы `tbl_profiles_localtags`, `tbl_profile_auth_changes`, `tbl_take_to_work_jobs`, `tbl_take_to_work_job_items`.
- Уточнено, что Retool реально использует две разные модели тегов: buyer tags и local tags.
- Уточнено, что в выдаче `tbl_delivery_profile` записи со статусами `1/2` часто очищаются перед новой витриной, а `3` остается как история успешной выдачи.

## Справочники статусов

### `tbl_stages`

- `1 = Buying`
- `2 = Farm`
- `3 = Fixer`
- `4 = QC`

### `tbl_phases`

- `1 = import`
- `2 = free`
- `3 = inwork`
- `4 = done`
- `5 = error`
- `6 = wait`
- `7 = archive`
- `8 = Rework`

### Практика

- farmer чаще работает с `stage_id = 2`
- buyer чаще работает с `stage_id = 1`
- fixer чаще работает с `stage_id = 3`
- для buyer-лимитов "активными" считаются профили со `stage_id = 1 and phase_id in (2,3,6)`

## Главные JOIN-цепочки

### Профиль с контекстом

```sql
SELECT
  p.*,
  st.name AS status_name,
  sg.name AS stage_name,
  ph.name AS phase_name,
  m.name  AS method_name,
  br.name AS browser_name
FROM farm_ext.tbl_profiles p
LEFT JOIN farm_ext.tbl_statuses st ON st.id = p.status_id
LEFT JOIN farm_ext.tbl_stages   sg ON sg.id = st.stage_id
LEFT JOIN farm_ext.tbl_phases   ph ON ph.id = st.phase_id
LEFT JOIN farm_ext.tbl_methods  m  ON m.id = p.method_id
LEFT JOIN farm_ext.tbl_browsers br ON br.id = p.browser_id;
```

### Профиль с группами

```sql
SELECT p.id, p.name, pg.id AS group_id, pg.name AS group_name
FROM farm_ext.tbl_profiles p
LEFT JOIN farm_ext.tbl_profile_group_link pgl ON pgl.profile_id = p.id
LEFT JOIN farm_ext.tbl_profile_groups pg ON pg.id = pgl.profile_group_id;
```

### Профиль с buyer tags

```sql
SELECT p.id, p.name, gt.id AS tag_id, gt.name AS tag_name
FROM farm_ext.tbl_profiles p
LEFT JOIN farm_ext.tbl_profile_tags pt ON pt.profile_id = p.id
LEFT JOIN farm_ext.tbl_groups_tags gt ON gt.id = pt.tag_id;
```

### Профиль с local tags

```sql
SELECT p.id, p.name, l.tagname
FROM farm_ext.tbl_profiles p
LEFT JOIN farm_ext.tbl_profiles_localtags l ON l.profile_id = p.id;
```

### Текущий активный грант

```sql
SELECT *
FROM farm_ext.tbl_profile_access_grant g
WHERE g.profile_id = :profile_id
  AND g.lock_exclusive = true
  AND g.revoked_at IS NULL
ORDER BY g.updated_at DESC, g.id DESC
LIMIT 1;
```

Интерпретация для этого файла:

- `lock_exclusive = true` + `revoked_at IS NULL` — основной operational-признак, что профиль занят.
- `revoked_at` — история завершения/возврата гранта.
- в части витрин Retool смотрит "последнюю запись" по `updated_at`, поэтому для расследований полезно проверять и активный грант, и последнюю запись истории.

## Бизнес-правила, которые важны для SQL

- `tbl_profiles.auth_id` — бизнес-владелец профиля, обычно buyer.
- `tbl_profile_access_grant` — не владелец, а "кто сейчас взял в работу". farmer / fixer.
- `tbl_profile_group_link` — основной источник групп профиля.
- `tbl_profiles.profile_group_id` — legacy shortcut, но код местами его еще учитывает.
- `tbl_buyer_limits` — источник истины по лимитам; `tbl_buyers_limits` legacy.
- `tbl_delivery_profile.delivery_status_id = 3` — успешная выдача.
- `tbl_delivery_profile.delivery_status_id in (1,2)` — временные строки текущей витрины выдачи, часто очищаются перед новой выдачей.
- `tbl_profiles_localtags` — local tags для farm/control; не путать с buyer tags.
- для operational-ответов занятость профиля определять прежде всего по `lock_exclusive = true and revoked_at is null`.
- статус `37` (`Срочная верификация`) ограничен кодом Retool: не более `10` переводов в сутки на пользователя по `tbl_statuses_log`.
- в auto/personal delivery код жёстко использует `p.status_id = 5` как входной статус кандидатов на выдачу и переводит профиль в `status_id = 2` после постановки в очередь.
- в return-to-buyer код переводит профиль в `status_id = 6` и снимает активный `tbl_profile_access_grant`.

## Инварианты

- в `tbl_buyer_limits` максимум одна строка на `buyer_auth_id`
- в `tbl_buyer_geo_access` максимум одна строка на `(buyer_auth_id, country_code)`
- в `tbl_profile_tags` максимум одна строка на `(profile_id, tag_id)`
- в `tbl_user_filters` максимум одна строка на `(auth_id, retool_cabinet, retool_screen)`
- в `tbl_users_groups` максимум одна строка на `(auth_id, group_id)`
- в `tbl_delivery_profile` уникален `(batch_id, profile_id)`
- в `tbl_profiles_localtags` код ожидает идемпотентные вставки/удаления по `(profile_id, tagname)`
- в `tbl_take_to_work_job_items` одна строка на `(job_id, profile_id)`
- логика этого документа считает, что максимум один активный профильный захват определяется по `lock_exclusive = true and revoked_at is null`

## Частые вопросы

- У кого сейчас профиль:
  - владелец: `tbl_profiles.auth_id`
  - кто взял в работу: `tbl_profile_access_grant`
  - кому выдавался батчем: `tbl_delivery_profile.auth_id`
- Можно ли ещё выдать buyer профиль:
  - смотри `tbl_buyer_limits.max_limit`, `daily_limit`, `is_active`
  - смотри `tbl_buyer_geo_access`
  - считай профили buyer, где `tbl_profiles.auth_id = buyer_auth_id`, `tbl_statuses.stage_id = 1`, `tbl_statuses.phase_id in (2,3,6)`
- Какие теги доступны buyer:
  - группы пользователя берутся через `tbl_profile_user_link`
  - словарь тегов лежит в `tbl_groups_tags`
  - привязки профилей лежат в `tbl_profile_tags`
- Какие proxy/extensions применятся:
  - источник `tbl_profile_settings`
  - score: `country 100 / group 50 / method 25`
  - tie-break: меньший `order`, затем меньший `id`
- Где local tags:
  - `tbl_profiles_localtags`
  - это отдельный слой, не связанный с `tbl_groups_tags`

## Структура таблиц

Формат:

- `cols` — колонки в виде `name type [nullability/default]`
- `keys` — PK/UNIQUE/FK
- `use` — зачем таблица нужна в кабинетах

### Core

`tbl_profiles`
- cols: `id int PK`, `name varchar!`, `created_at timestamptz! default CURRENT_TIMESTAMP`, `updated_at timestamptz! default CURRENT_TIMESTAMP`, `status_id int?`, `description text?`, `auth_id int?`, `browser_identifier varchar?`, `profile_group_id int?`, `method_id int?`, `browser_id int?`, `settings_id int?`, `country_code varchar?`, `batch_name text?`, `is_locked_for_delete bool? default false`, `account_id text?`, `script_version text?`, `profile_data jsonb?`, `profile_synced_at timestamptz?`
- keys: `PK(id)`, `FK status_id->tbl_statuses.id`, `FK auth_id->tbl_users.auth_id`, `FK profile_group_id->tbl_profile_groups.id`, `FK method_id->tbl_methods.id`, `FK browser_id->tbl_browsers.id`, `FK settings_id->tbl_profile_settings.id`, `UNIQUE(settings_id)`, `UNIQUE(browser_identifier)`
- use: главная таблица профилей; все списки, выдача, ownership, фильтры, карточки и статусы стартуют отсюда

`tbl_statuses`
- cols: `id int PK`, `name varchar!`, `stage_id int?`, `phase_id int?`, `is_active bool! default true`, `order_id int?`, `color_hex varchar?`, `created_at timestamptz! default CURRENT_TIMESTAMP`, `updated_at timestamptz! default CURRENT_TIMESTAMP`
- keys: `PK(id)`, `FK stage_id->tbl_stages.id`, `FK phase_id->tbl_phases.id`
- use: конкретный статус профиля

`tbl_stages`
- cols: `id int PK`, `name varchar!`, `is_active bool! default true`
- keys: `PK(id)`
- use: крупный домен процесса (`Buying`, `Farm`, `Fixer`, `QC`)

`tbl_phases`
- cols: `id int PK`, `name varchar!`, `is_active bool! default true`
- keys: `PK(id)`
- use: абстрактная фаза (`free`, `inwork`, `done`, `wait`, ...)

`tbl_profile_access_grant`
- cols: `id bigint PK`, `profile_id int!`, `auth_id int!`, `granted_by_auth_id int!`, `created_at timestamptz! default CURRENT_TIMESTAMP`, `revoked_at timestamptz?`, `lock_exclusive bool! default true`, `updated_at timestamptz! default CURRENT_TIMESTAMP`
- keys: `PK(id)`, `FK profile_id->tbl_profiles.id`, `FK auth_id->tbl_users.auth_id`, `FK granted_by_auth_id->tbl_users.auth_id`
- use: кто сейчас держит профиль в работе; для operational-логики активным считать `lock_exclusive=true and revoked_at is null`

`tbl_statuses_log`
- cols: `id int PK`, `created_at timestamptz! default CURRENT_TIMESTAMP`, `auth_id int?`, `profile_id int!`, `status_old int?`, `status_new int?`
- keys: `PK(id)`, `FK auth_id->tbl_users.auth_id`, `FK profile_id->tbl_profiles.id`, `FK status_old->tbl_statuses.id`, `FK status_new->tbl_statuses.id`
- use: история смены статусов; используется и для аудита, и для кодовых лимитов на отдельные статусы

`tbl_logs`
- cols: `id int PK`, `action varchar!`, `metadata text?`, `created_at timestamptz! default CURRENT_TIMESTAMP`, `auth_id int?`, `method varchar?`
- keys: `PK(id)`
- use: общий техлог операций Retool и service SQL

`tbl_profile_auth_changes`
- cols: `id bigint PK`, `created_at timestamptz! default now()`, `profile_name text!`, `old_auth_id text?`, `new_auth_id text?`, `processed_at timestamptz?`, `mango_processed_at timestamptz?`
- keys: `PK(id)`
- use: аудит смены владельца профиля и интеграционной обработки этой смены

### Delivery and limits

`tbl_buyer_limits`
- cols: `id int PK`, `buyer_auth_id int!`, `max_limit int!`, `is_active bool! default true`, `created_at timestamptz! default now()`, `updated_at timestamptz! default now()`, `daily_limit int! default 40`
- keys: `PK(id)`, `FK buyer_auth_id->tbl_users.auth_id`, `UNIQUE(buyer_auth_id)`
- use: актуальные лимиты buyer; база для auto/person delivery V2.4

`tbl_buyer_geo_access`
- cols: `id int PK`, `buyer_auth_id int?`, `country_code varchar?`, `created_at timestamptz? default now()`, `updated_at timestamptz? default now()`
- keys: `PK(id)`, `FK buyer_auth_id->tbl_users.auth_id`, `UNIQUE(buyer_auth_id, country_code)`
- use: список разрешенных стран buyer

`tbl_buyers_limits`
- cols: `id int PK`, `auth_id int!`, `country_code varchar!`, `max_limit int!`, `created_at timestamptz! default CURRENT_TIMESTAMP`, `updated_at timestamptz! default CURRENT_TIMESTAMP`, `is_active bool? default true`
- keys: `PK(id)`, `FK auth_id->tbl_users.auth_id`, `UNIQUE(auth_id, country_code)`
- use: legacy-таблица старой модели лимитов; ещё видна в части buyer-control экранов

`tbl_delivery_profile`
- cols: `id bigint PK`, `batch_id text?`, `profile_id int!`, `auth_id int!`, `delivery_status_id smallint! default 1`, `error_message text?`, `attempt_count int! default 0`, `processed_at timestamptz?`, `created_at timestamptz! default CURRENT_TIMESTAMP`, `updated_at timestamptz! default CURRENT_TIMESTAMP`, `initiator_auth_id int?`, `profile_name text?`, `proxy jsonb?`, `extensions jsonb?`, `browser_identifier text?`, `method_id int?`
- keys: `PK(id)`, `FK profile_id->tbl_profiles.id`, `FK auth_id->tbl_users.auth_id`, `FK initiator_auth_id->tbl_users.auth_id`, `FK delivery_status_id->tbl_delivery_statuses.id`, `UNIQUE(batch_id, profile_id)`
- use: очередь и история выдачи профиля buyer; временные строки `1/2` формируют текущую витрину, `3` — исторический факт успешной выдачи

`tbl_delivery_statuses`
- cols: `id smallint PK`, `name text!`
- keys: `PK(id)`, `UNIQUE(name)`
- use: статусы выдачи (`1 не выдавался`, `2 ошибка`, `3 успешно`)

`tbl_delivery_log`
- cols: `id bigint PK`, `created_at timestamptz! default now()`, `batch_id text!`, `step text!`, `payload jsonb!`, `percent smallint?`
- keys: `PK(id)`
- use: отладочный лог шагов алгоритмов авто- и batch-выдачи

### Rules, groups, tags

`tbl_profile_settings`
- cols: `id int PK`, `name varchar!`, `description text?`, `is_active bool! default true`, `country varchar?`, `browser_id int?`, `profile_group_id int?`, `updated_at timestamptz! default CURRENT_TIMESTAMP`, `method_id int?`, `params text?`, `created_at timestamptz! default CURRENT_TIMESTAMP`, `order int?`
- keys: `PK(id)`, `FK browser_id->tbl_browsers.id`, `FK profile_group_id->tbl_profile_groups.id`, `FK method_id->tbl_methods.id`
- use: rules engine выбора `proxy/extensions/method`; Retool скорит совпадения как `country 100 / group 50 / method 25`

`tbl_profile_groups`
- cols: `id int PK`, `name varchar!`, `description text?`, `is_active bool! default true`, `created_at timestamptz! default CURRENT_TIMESTAMP`, `updated_at timestamptz! default CURRENT_TIMESTAMP`, `type_name varchar?`
- keys: `PK(id)`
- use: справочник branch/group, через который строятся доступы и правила

`tbl_profile_group_link`
- cols: `profile_group_id int!`, `added_by text?`, `created_at timestamptz! default CURRENT_TIMESTAMP`, `updated_at timestamptz! default CURRENT_TIMESTAMP`, `profile_id int?`
- keys: `FK profile_group_id->tbl_profile_groups.id`, `FK profile_id->tbl_profiles.id`, `UNIQUE(profile_group_id, profile_id)`
- use: many-to-many профиль -> группа; основной источник групп профиля

`tbl_profile_user_link`
- cols: `profile_group_id int!`, `auth_id int!`, `added_by text?`, `created_at timestamptz! default CURRENT_TIMESTAMP`, `updated_at timestamptz! default CURRENT_TIMESTAMP`
- keys: `PK(profile_group_id, auth_id)`, `FK profile_group_id->tbl_profile_groups.id`
- use: many-to-many пользователь -> профильная группа; через неё buyer получает branch/tag access

`tbl_users_groups`
- cols: `auth_id int!`, `group_id int!`, `group_name text?`, `created_at timestamptz! default CURRENT_TIMESTAMP`, `updated_at timestamptz! default CURRENT_TIMESTAMP`
- keys: `PK(auth_id, group_id)`
- use: орг-группы пользователя, синхронизируемые при логине; участвуют в лимитах, выдаче и rule matching

`tbl_groups_tags`
- cols: `id bigint PK`, `group_id bigint!`, `name text!`, `created_by_auth_id bigint!`, `created_at timestamptz! default now()`, `updated_at timestamptz! default now()`, `is_active bool! default true`
- keys: `PK(id)`, `FK group_id->tbl_profile_groups.id`, `FK created_by_auth_id->tbl_users.auth_id`, `UNIQUE(group_id, name)`
- use: словарь buyer tags внутри группы

`tbl_profile_tags`
- cols: `profile_id bigint!`, `tag_id bigint!`, `assigned_by_auth_id bigint!`, `assigned_at timestamptz! default now()`
- keys: `PK(profile_id, tag_id)`, `FK profile_id->tbl_profiles.id`, `FK tag_id->tbl_groups_tags.id`, `FK assigned_by_auth_id->tbl_users.auth_id`
- use: привязка buyer tags к профилям

`tbl_profiles_localtags`
- cols: `id bigint PK`, `tagname varchar!`, `created_at timestamp! default now()`, `profile_id int!`
- keys: `PK(id)`, `FK profile_id->tbl_profiles.id`
- use: локальные текстовые теги для farm/control витрин; не зависят от buyer groups и не связаны с `tbl_groups_tags`

`tbl_filters`
- cols: `id int PK`, `name varchar!`, `group_id int?`, `params text?`, `type varchar?`, `created_at timestamptz? default now()`, `updated_at timestamptz? default now()`
- keys: `PK(id)`, `FK group_id->tbl_profile_groups.id`
- use: сохраненные/админские фильтры по группам

### Users and UI state

`tbl_users`
- cols: `auth_id int PK`, `sid text?`, `email text?`, `first_name text?`, `last_name text?`, `full_name text?`, `display_name text?`, `profile_photo_url text?`, `first_seen_at timestamptz! default now()`, `last_seen_at timestamptz! default now()`, `login_count int! default 0`, `fired_at timestamp?`
- keys: `PK(auth_id)`, `UNIQUE(email)`, `UNIQUE(sid)`
- use: справочник пользователей, владельцев профилей, сотрудников и buyer account holder'ов

`tbl_user_delegations`
- cols: `id bigint PK`, `delegator_auth_id int!`, `target_auth_id int!`, `scope varchar? default 'full'`, `created_at timestamptz! default CURRENT_TIMESTAMP`, `updated_at timestamptz! default CURRENT_TIMESTAMP`
- keys: `PK(id)`
- use: buyer может видеть/считать профили делегированных пользователей

`tbl_user_filters`
- cols: `auth_id int!`, `retool_cabinet varchar!`, `retool_screen varchar!`, `table_filterstack jsonb?`, `table_sortarray jsonb?`, `customfilters jsonb?`, `table_coldir jsonb?`
- keys: `PK(auth_id, retool_cabinet, retool_screen)`, `FK auth_id->tbl_users.auth_id`
- use: сохраненное состояние таблиц Retool

### Reference / secondary

`tbl_methods`
- cols: `id int PK`, `name varchar!`, `description text?`, `is_active bool! default true`, `created_at timestamptz! default CURRENT_TIMESTAMP`, `updated_at timestamptz! default CURRENT_TIMESTAMP`
- keys: `PK(id)`
- use: справочник методов профиля

`tbl_browsers`
- cols: `id int PK`, `name varchar!`, `created_at timestamptz! default CURRENT_TIMESTAMP`, `updated_at timestamptz! default CURRENT_TIMESTAMP`
- keys: `PK(id)`
- use: справочник браузеров

`tbl_profiles_log`
- cols: `id int PK`, `created_at timestamp! default now()`, `profile_id text!`, `profile_name text!`, `auth_id int?`
- keys: `PK(id)`
- use: старый техлог профилей

`tbl_feature_flags`
- cols: `flag_name varchar PK`, `enabled bool!`, `updated_at timestamp?`, `comment varchar?`, `settings jsonb?`
- keys: `PK(flag_name)`
- use: фича-флаги и дополнительные JSON-настройки флага

### Async take-to-work

`tbl_take_to_work_jobs`
- cols: `id bigint PK`, `request_id uuid!`, `created_by_auth_id bigint!`, `status varchar! default 'pending'`, `total_count int! default 0`, `processed_count int! default 0`, `success_count int! default 0`, `conflict_count int! default 0`, `forbidden_count int! default 0`, `failed_count int! default 0`, `error_message text?`, `metadata jsonb! default '{}'`, `created_at timestamptz! default now()`, `started_at timestamptz?`, `finished_at timestamptz?`, `updated_at timestamptz! default now()`
- keys: `PK(id)`, `UNIQUE(request_id)`
- use: шапка async-джобы массового `take to work`

`tbl_take_to_work_job_items`
- cols: `id bigint PK`, `job_id bigint!`, `profile_id bigint!`, `status varchar! default 'pending'`, `attempt int! default 0`, `worker_id text?`, `browser_identifier text?`, `message text?`, `rule_applied bool?`, `grant_created bool?`, `old_status_id bigint?`, `new_status_id bigint?`, `created_at timestamptz! default now()`, `started_at timestamptz?`, `finished_at timestamptz?`, `updated_at timestamptz! default now()`, `metadata jsonb! default '{}'`
- keys: `PK(id)`, `FK job_id->tbl_take_to_work_jobs.id`, `UNIQUE(job_id, profile_id)`
- use: построчный прогресс/результат по каждому профилю внутри async-джобы

## Минимальные практические выводы

- Если вопрос про список профилей: начинай с `tbl_profiles`, почти всегда джойнь `tbl_statuses`, `tbl_stages`, `tbl_phases`.
- Если вопрос про владельца/назначение: смотри `auth_id`, `tbl_profile_access_grant`, `tbl_delivery_profile` вместе.
- Если вопрос про branch/group/tag access: смотри `tbl_profile_group_link`, `tbl_profile_user_link`, `tbl_users_groups`, `tbl_groups_tags`, `tbl_profile_tags`.
- Если вопрос про local tags: смотри только `tbl_profiles_localtags`.
- Если вопрос про выдачу buyer: смотри `tbl_buyer_limits`, `tbl_buyer_geo_access`, `tbl_delivery_profile`, `tbl_delivery_log`.
- Если вопрос про "почему выбрался такой proxy/extensions": смотри `tbl_profile_settings` и scoring `100/50/25`.
- Если вопрос про массовое async-взятие профилей в работу: смотри `tbl_take_to_work_jobs` и `tbl_take_to_work_job_items`.
