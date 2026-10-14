# Audit события в `public.audit`

Таблица Аудита должны использоваться для поиска событие в системе, если приходит такой запрос.
Код проекта в n8n/audit

Документ собран по двум источникам:

1. Текущий срез БД `public.audit`: уникальные `event_type`, частоты и реально встречающиеся ключи в `event_attributes`.
2. Поиск по коду соседних проектов в `/Users/alexander/Development/Sequoia/*`: `crm-api`, `retool`, `n8n/*`, `slack_app`.

Если источник в коде не найден, описание ниже помечено как вывод по имени события и структуре `event_attributes`.

## Что есть в таблице

`public.audit` содержит:

- `timestamp`
- `division`
- `user_email`
- `log_type`
- `severity`
- `event_type`
- `event_attributes jsonb`
- `created_at`
- `dedup_key`

## Базовые запросы

### Все типы событий

```sql
select event_type, count(*) as cnt
from public.audit
group by event_type
order by event_type;
```

### Последние события конкретного типа

```sql
select timestamp, division, user_email, log_type, severity, event_attributes
from public.audit
where event_type = 'status_change'
order by timestamp desc
limit 100;
```

### Какие ключи встречаются в `event_attributes` по типу события

```sql
select
  event_type,
  string_agg(distinct k.key, ', ' order by k.key) as keys
from public.audit a
left join lateral jsonb_object_keys(coalesce(a.event_attributes, '{}'::jsonb)) as k(key) on true
where event_type = 'status_change'
group by event_type;
```

### Поиск по ключу внутри `event_attributes`

```sql
select timestamp, user_email, event_attributes
from public.audit
where event_type = 'take_to_work'
  and event_attributes->>'profile_id' = '431528'
order by timestamp desc;
```

### Поиск по текстовому `request_data` у legacy UI-событий

```sql
select timestamp, user_email, event_type, event_attributes->>'request_data' as request_data
from public.audit
where event_type in ('update_domain', 'publish_domains', 'ajax:save_permission')
  and event_attributes->>'request_data' ilike '%token%';
```

### Поиск по нескольким опорным атрибутам

```sql
select timestamp, event_type, event_attributes
from public.audit
where
  event_attributes->>'profile_name' = 'BR2316347_BEN_FP_POST_RT_0304'
  or event_attributes->>'card_number' = '5347863847725027'
  or event_attributes->>'transaction_id' = '49e30061-6baf-4226-864c-7e0dcc36c1ba'
order by timestamp desc;
```

## Как читать события

- Для legacy UI-событий почти всегда полезны `user_login`, `user_id`, `client_ip`, `request_uri`, `request_data`.
- Для профильных workflow-событий основа поиска: `profile_id`, `profile_name`, `browser_identifier`, `auth_id`, `old_status_id`, `new_status_id`, `stage`, `stage_id`, `phase_id`.
- Для карточных и банковских событий основа поиска: `bank`, `acc_no`, `card_number`, `ext_id`, `transaction_id`, `profile_name`, `buyer`.
- Для batch-событий из Retool основа поиска: `batch_id`, `results`, `successful_records`, `failed_records`, `user_email`.
- Для refund-событий основа поиска: `profile_id`, `profile_name`, `request_id`, `outcome`, `error_message`, `status_code`.

## Справочник `event_type`

### Advertiser / partner

| event_type | Где найдено | Краткое описание | Что смотреть в `event_attributes` |
|---|---|---|---|
| `advertiser_add` | Код не найден; вывод по данным | Создание рекламодателя | `name`, `comment` |
| `advertiser_delete` | Код не найден; вывод по данным | Удаление рекламодателя | `id` |
| `advertiser_dup_tr` | Код не найден; вывод по данным | Найден дубликат advertiser-транзакции с теми же параметрами | `transaction_id`, `advertiser_uuid`, `campaign_uuid`, `existing_amount`, `original_amount` |
| `advertiser_dup_tr_mismatch` | Код не найден; вывод по данным | Дубликат транзакции, но входящие параметры не совпали с уже существующими | `transaction_id`, `error`, `incoming_*`, `existing_*` |
| `advertiser_dup_trnotfound` | Код не найден; вывод по данным | Обнаружен конфликт/дубликат, но исходная транзакция не найдена | `error`, `transaction_id`, `advertiser_uuid`, `campaign_uuid`, `amount` |
| `advertiser_linkcampaign` | Код не найден; вывод по данным | Привязка кампании к рекламодателю | `id`, `advertiser_name`, `campaign_name`, `campaign_uuid` |
| `advertiser_not_found` | Код не найден; вывод по данным | Не найден рекламодатель для операции | `error`, `advertiser_uuid`, `transaction_type`, `amount` |
| `advertiser_no_trtype` | Код не найден; вывод по данным | Не найден тип advertiser-транзакции | `error`, `advertiser_name`, `advertiser_uuid`, `transaction_type_id` |
| `advertiser_tr` | Код не найден; вывод по данным | Проведена advertiser-транзакция старого/сокращенного формата | `transaction_id`, `advertiser_uuid`, `campaign_uuid`, `transaction_type_id`, `amount`, `balance_before`, `balance_after`, `user_email` |
| `advertiser_transaction` | Код не найден; вывод по данным | Проведена advertiser-транзакция | `transaction_id`, `advertiser_uuid`, `campaign_uuid`, `transaction_type_id`, `transaction_type_name`, `amount`, `increment_balance` |
| `advertiser_trdelete` | Код не найден; вывод по данным | Запрос на удаление advertiser-транзакции | `id`, `reason` |
| `advertiser_tr_deleted` | Код не найден; вывод по данным | Фактическое удаление advertiser-транзакции | `transaction_id`, `advertiser_uuid`, `campaign_uuid`, `transaction_type_id`, `amount`, `reason` |
| `advertiser_trupdate` | Код не найден; вывод по данным | Запрос на редактирование advertiser-транзакции | `id`, `amount`, `comment`, `created_at` |
| `advertiser_tr_updated` | Код не найден; вывод по данным | Старая и новая версия advertiser-транзакции после обновления | `transaction_id`, `advertiser_uuid`, `old_*`, `new_*` |
| `advertiser_unlinkcampaign` | Код не найден; вывод по данным | Отвязка кампании от рекламодателя/партнера | `id`, `partner_name`, `campaign_name`, `campaign_uuid` |
| `advertiser_update` | Код не найден; вывод по данным | Обновление карточки рекламодателя | `id`, `name`, `comment` |

### Legacy UI / domains / admin

| event_type | Где найдено | Краткое описание | Что смотреть в `event_attributes` |
|---|---|---|---|
| `ajax:fix-domain` | Код не найден; по данным видно legacy POST action | Ручной `fix-domain` из старого UI | `request_data`, `request_uri`, `user_login`, `user_id`, `client_ip` |
| `ajax:save_permission` | Код не найден; по данным видно legacy POST action | Сохранение permission/feature для роли | `request_data`, `user_login`, `user_id`, `client_ip`; в `request_data` искать `role_id`, `feature_id`, `value` |
| `assign_role` | Код не найден; по данным видно legacy POST action | Назначение роли пользователю | `request_data`, `user_login`, `user_id`; в `request_data` искать `role_id`, `user_id` |
| `auth_as_user` | Код не найден; по данным видно legacy GET action | Вход/имперсонация под другим пользователем | `request_uri`, `request_data`, `user_login`, `client_ip` |
| `bulk_zip_rearchive` | Код не найден; вывод по данным | Массовая переархивация ZIP/лендов из старого UI | `request_data`, `files`, `user_login`, `client_ip` |
| `checkBinom` | Код не найден; вывод по данным | Проверка Binom в старом UI | `request_data`, `request_uri`, `user_login` |
| `checkDomain` | Код не найден; вывод по данным | Проверка домена в старом UI | `request_data`, `request_uri`, `user_login` |
| `checkPalladiumClickDetails` | Код не найден; вывод по данным | Проверка деталей клика Palladium | `request_data`, `request_uri`, `user_login` |
| `checkPalladiumOrAdspectDomain` | Код не найден; вывод по данным | Проверка домена через Palladium/Adspect | `request_data`, `request_uri`, `user_login` |
| `create_role` | Код не найден; вывод по данным | Создание роли в legacy UI | `request_data`, `user_login`, `client_ip` |
| `delete_item` | Код не найден; вывод по данным | Удаление элемента/записи в legacy UI | `request_data`, `request_uri`, `user_login` |
| `domain_added` | Код не найден; вывод по данным | Добавление домена/скрипта | `domain_name`, `script_version` |
| `getDomainInfo` | Код не найден; вывод по данным | Получение информации по домену | `request_data`, `request_uri`, `user_login` |
| `import_adspect_all` | Код не найден; вывод по данным | Массовый импорт из Adspect | `request_data`, `request_uri`, `user_login` |
| `impersonate_enable` | Код не найден; вывод по данным | Включение режима имперсонации | `impersonateLogin` |
| `impersonate_reset` | Код не найден; вывод по данным | Сброс режима имперсонации | Обычно достаточно `timestamp`, `user_email`; атрибутов может не быть |
| `mass_delete` | Код не найден; вывод по данным | Массовое удаление в legacy UI | `request_data`, `request_uri`, `user_login` |
| `publish_debug` | Код не найден; вывод по данным | Debug-публикация доменов/файлов | `request_data`, `request_uri`, `user_login` |
| `publish_domains` | Код не найден; вывод по данным | Публикация доменов | `request_data`, `request_uri`, `user_login`; часто искать список в `file` или `domains_filter` |
| `read_only_shard` | Код не найден; вывод по данным | Операция уткнулась в read-only shard/режим | `request_data`, `request_uri`, `user_login` |
| `rename_item` | Код не найден; вывод по данным | Переименование сущности в legacy UI | `request_data`, `request_uri`, `user_login` |
| `repair_domain_once` | Код не найден; вывод по данным | Разовый repair домена | `request_data`, `request_uri`, `user_login` |
| `transfer-domains` | Код не найден; вывод по данным | Массовая передача доменов другому пользователю | `request_data`, `request_uri`, `user_login`; искать `transfer_user`, список доменов |
| `unpublish_debug` | Код не найден; вывод по данным | Debug-unpublish доменов/файлов | `request_data`, `request_uri`, `user_login` |
| `unpublish_domains` | Код не найден; вывод по данным | Снятие доменов с публикации | `request_data`, `request_uri`, `user_login`; искать список доменов в `file` |
| `update_domain` | Код не найден; вывод по данным | Обновление параметров домена | `request_data`, `request_uri`, `user_login`; искать `domain_url`, `geo`, `binomKey`, `id` |
| `update_domains_protection` | Код не найден; вывод по данным | Обновление защиты/anti-detect параметров домена | `request_data`, `request_uri`, `user_login`; искать `protection_type`, `enhanced_protection`, `domains` |
| `update_geo_bynom` | Код не найден; вывод по данным | Массовое обновление GEO/Bindom/Bynom-настроек доменов | `request_data`, `files`, `request_uri`, `user_login`; искать `geo`, `binomKey`, `domains` |
| `update_user_language` | Код не найден; вывод по данным | Смена языка пользователя | `request_data`, `user_login`; искать `lang` |
| `zip_upload_on_create` | Код не найден; вывод по данным | Загрузка ZIP при создании домена/ленда | `request_data`, `files`, `request_uri`, `user_login` |

### Auth / OpenID / proxy

| event_type | Где найдено | Краткое описание | Что смотреть в `event_attributes` |
|---|---|---|---|
| `authentication_failed` | `n8n/openid/app/api/[...path]/route.ts` | Неуспешная аутентификация запроса в OpenID proxy | `route`, `method`, `reason`, `request_id`, `ip_address`, `user_agent`, `has_token` |
| `authentication_successful` | `n8n/openid/app/api/[...path]/route.ts` | Успешная аутентификация запроса в OpenID proxy | `route`, `method`, `request_id`, `ip_address`, `full_name`, `token_regenerated` |
| `proxy_error` | `n8n/openid/app/api/[...path]/route.ts` | Ошибка проксирования запроса после аутентификации | `route`, `method`, `request_id`, `error_message`, `response_status`, `duration_ms`, `token_length` |
| `proxy_request_successful` | `n8n/openid/app/api/[...path]/route.ts` | Успешный проксированный запрос через OpenID proxy | `route`, `target_url`, `method`, `request_id`, `response_status`, `proxy_duration_ms`, `total_duration_ms` |

### Profiles / workflow / extensions

| event_type | Где найдено | Краткое описание | Что смотреть в `event_attributes` |
|---|---|---|---|
| `auth_determine` | `crm-api/src/profiles/profiles.service.ts` | Этап определения `auth_id` при workflow смены статуса/обработки профиля | `profile_id`, `profile_auth_id`, `auth_id`, `auth_id_source`, `old_status_id`, `new_status_id`, `stage`, `stage_id`, `phase_id`, `browser_identifier` |
| `buying-extension` | `n8n/buyer_profile_extension/js/audit.js` | Событие браузерного buyer-расширения | `action`, `stage`, `result`, `profile_id`, `profile_name`, `browser_identifier`, `status_id`, `error_message` |
| `clear_delivery` | `retool/Cab-FarmControl/src/pageAccountDelivery.rsx` | Очистка настроек delivery | `source`, `updated_by`, `updated_at` |
| `delivery_auto` | `retool/Cab-FarmControl/src/pageAccountDelivery.rsx` | Автоматический delivery режим | `source`, `updated_by`, `updated_at` |
| `delivery_personal` | `retool/Cab-FarmControl/src/container1.rsx` | Ручная/персональная выдача delivery | `buyer_auth_id`, `buyer_email`, `count`, `geo`, `source`, `updated_by`, `updated_at` |
| `delivery_workflow` | `retool/Cab-FarmControl/src/pageAccountDelivery.rsx` | Workflow-режим delivery | `source`, `updated_by`, `updated_at` |
| `draft_created` | `n8n/mqtt_otp_transactions_service/src/app/api/draft/route.ts` | Создан draft по банковской транзакции/OTP | `transaction_id`, `bank`, `profile_id`, `profile_name`, `available_balance` |
| `draft_creation_error` | `n8n/mqtt_otp_transactions_service/src/app/api/draft/route.ts` | Ошибка создания draft | `transaction_id`, `bank`, `profile_id`, `profile_name`, `error` |
| `farm-extension` | `n8n/farm-extension/js/audit.js` | Событие farmer-расширения | `action`, `stage`, `result`, `profile_id`, `profile_name`, `browser_identifier`, `status_id`, `error_message` |
| `irev_metrics_updated` | Код не найден; вывод по данным | Обновление iRev-метрик | `aff_id`, `day`, `geo`, `old_leads`, `new_leads`, `old_ftds`, `new_ftds` |
| `lock_exclusive` | Код явно не найден, но формат типичен для `crm-api` profile workflow | Работа с `lock_exclusive` при сменах статусов/байера | `profile_id`, `auth_id`, `locked_auth_id`, `old_status_id`, `new_status_id`, `stage`, `reason`, `lock_exclusive_removed`, `moved_to_shared_pool` |
| `mango_profile_link` | `crm-api/src/mango-profile-link/mango-profile-link.service.ts` | Привязка профиля к Mango/очередь link-процесса | `email`, `profile_name`, `record_id`, `stage`, `status`, `reason`, `error`, `queue_length`, `duration_ms` |
| `octo_profile_title_update` | В коде найден только по литералу в Retool docs/usage | Массовое обновление title/metadata у профилей Octo | `record_id`, `before_data`, `after_data`, `changes_summary`, `user_email` |
| `profile` | `crm-api`, `retool`, несколько сервисов | Общий audit-контейнер для операций с профилями; смысл зависит от `stage`/`action` | `profile_id`, `profile_name`, `browser_identifier`, `stage`, `action`, `source`, `status_id`, `old_status_id`, `new_status_id`, `error`, `user_email` |
| `profile_edit` | `retool` по литералу | Ручное редактирование профиля | `before_data`, `after_data`, `logged_at`, `user_email` |
| `profile_localtags_add` | `retool/Cab-FarmControl` | Добавление локальных тегов профилям | `profile_ids`, `tags`, `user_email` |
| `profile_localtags_delete` | `retool/Cab-FarmControl` | Удаление локальных тегов у профилей | `profile_ids`, `tags`, `user_email` |
| `profileTable_update` | Код не найден; вывод по данным | Массовый апдейт строк таблицы профилей | `before_data`, `after_data`, `updates`, `user_email` |
| `return_buyer` | `crm-api/src/profiles/profiles.service.ts` | Возврат профиля/авторизации байеру | `profile_id`, `auth_id`, `current_auth_id`, `old_status_id`, `new_status_id`, `stage`, `error`, `browser_identifier` |
| `status_change` | `crm-api/src/profiles/profiles.service.ts`, SQL trigger в Retool | Основное событие смены статуса профиля | `profile_id`, `auth_id`, `old_status_id`, `new_status_id`, `status_id`, `stage`, `stage_id`, `phase_id`, `job_id`, `job_request_id`, `error` |
| `switch_limit_ws` | `retool/Cab-FarmControl/src/pageSettings.rsx` | Переключение режима лимитов WS | `currentdataSwitch`, `user_email` |
| `tag_operation` | `crm-api/src/profiles/profiles.service.ts` | Применение/сброс тегов к профилю и ответ Octo API | `stage`, `timestamp`, `browser_identifier`, `tags_list`, `tags_count`, `response_status`, `response_data`, `error` |
| `take_to_work` | `crm-api/src/take-to-work/*` | Workflow take-to-work, включая job-стадии и результаты по профилям | `request_id`, `job_id`, `job_item_id`, `job_operation`, `profile_id`, `profile_name`, `stage`, `item_status`, `message`, `octo_*`, `user_email` |
| `update-status-mass` | `crm-api/src/profiles/profiles.service.ts` | Массовая смена статуса профилей | `status_id`, `stage`, `profiles_count`, `profiles_list`, `groups_count`, `updated_count`, `not_found_count` |
| `ws_limit_automation` | `crm-api/src/profiles/ws-limit-automation.service.ts` | Автомат WS-лимитов, срабатывающий по trigger-профилям | `cod`, `reason`, `dry_run`, `trigger_auth_id`, `trigger_profile_names`, `target_profile_names` |

### Bank / cards / OTP / transactions / queue / refunds

| event_type | Где найдено | Краткое описание | Что смотреть в `event_attributes` |
|---|---|---|---|
| `account_transaction_synced` | `n8n/mqtt_ecards_transactions/src/services/EcardsAccountsService.ts` | Синхронизация транзакции по банковскому аккаунту | `account_name`, `ext_id`, `type`, `value` |
| `balance_updated` | Есть форматы в `n8n/audit-formats.md` | Обновление баланса аккаунта/карты | `bank`, `acc_no`, `balance`, `profile_id`, `transaction_id` |
| `bank_card_issued` | `n8n/mqtt_multicards_transactions/src/services/DatabaseService.ts` | Выпущена банковская карта | `bank`, `acc_no`, `card_number`, `note` |
| `bank_card_linked_to_profile` | `n8n/processor-hub/src/api/routes/cards.ts` | Банковская карта привязана к профилю | `card_number`, `profileName` |
| `bank_card_upsert_failed` | `n8n/mqtt_ecards_transactions/src/services/DatabaseService.ts` | Ошибка upsert банковской карты | `bank`, `acc_no`, `card_number`, `error` |
| `bank_comment_set` | `n8n/processor-hub/src/api/routes/bank.ts` | Успешное сохранение комментария к банковскому аккаунту | `bank`, `acc_no`, `account_name`, `comment` |
| `bank_transaction_imported` | `n8n/processor-hub/src/modules/statementsImport/index.ts` | Импорт банковской транзакции из файла/выписки | `bank`, `acc_no`, `ext_id`, `amount`, `currency`, `draft_id`, `profile_name`, `matched_by`, `job_id`, `source` |
| `bank_transaction_upserted` | `n8n/processor-hub/src/modules/transactions/index.ts` | Upsert транзакции в `bank_transactions` | `bank`, `acc_no`, `ext_id`, `amount`, `correlation_id` |
| `binding_token_event` | `n8n/mqtt_import_by_file_transactions/app/api/funds/create/route.ts` | Жизненный цикл relay/binding token в refund-потоке | `action`, `event_id`, `retry_key`, `request_id`, `token_version`, `has_token`, `is_active` |
| `buyer_fix_at_transaction_time` | Код не найден; вывод по данным | Разовая коррекция buyer во время обработки транзакции | `reason`, `script` |
| `compliance_fix_cards` | `n8n/mqtt_ecards_transactions/src/services/ComplianceService.ts` | Массовая compliance-коррекция связей/состояния карт | `operation`, `cards_updated`, `skipped_shared_accounts`, `source` |
| `compliance_fix_trans` | `n8n/mqtt_ecards_transactions/src/services/ComplianceService.ts` | Compliance-коррекция транзакций | `bank`, `operation`, `transactions_updated` |
| `card_buyer_synced` | `n8n/mqtt_otp_transactions_service/src/services/DbProfileListener.ts` | Синхронизация buyer на карте после изменений по профилю | `card_number`, `old_buyer`, `new_buyer`, `profile_name`, `sync_source`, `sync_type`, `transactions_updated` |
| `card_issued` | Есть в `processor-hub` как доменное событие; фактический emitter зависит от сервиса | Выпуск карты | `bank`, `acc_no`, `card_number`, `ext_id`, `note`, `source` |
| `card_issue_error` | `n8n/mqtt_adscards_transactions/src/app/api/cards/issue/route.ts`, `n8n/mqtt_ecards_transactions/src/app/api/cards/create/route.ts` | Ошибка выпуска карты | `source`, `bank`, `profile_id`, `aff_id`, `group_id`, `bin_id`, `quantity`, `ps_status`, `ps_error` |
| `card_limits_removed` | `n8n/processor-hub/src/infra/profileAuthChangeWorker.ts` | У карты сняты buyer/usage лимиты | `buyer_email`, `bank`, `card_number` |
| `card_linked` | `n8n/mqtt_otp_transactions_service/src/services/DbProfileListener.ts`, `n8n/mqtt_adscards_transactions` | Карта привязана к buyer/профилю | `bank`, `acc_no`, `card_number`, `new_buyer`, `old_buyer`, `auth_id`, `new_auth_id`, `profile_name`, `cards_updated`, `transactions_updated`, `source` |
| `card_returned_to_farm` | `n8n/processor-hub/src/infra/profileAuthChangeWorker.ts`, `DbProfileListener` | Карта возвращена на farm/в shared pool | `card_number`, `old_buyer`, `profile_name`, `sync_type` |
| `cards_info_update` | Код не найден; вывод по данным | Обновление метаданных/BIN-информации карты | `bank`, `bin`, `old_geo`, `new_geo`, `old_info`, `new_info` |
| `card_transferred` | `DbProfileListener`, `processor-hub` | Карта переведена от одного buyer/auth к другому | `bank`, `acc_no`, `card_number`, `old_buyer`, `new_buyer`, `old_auth_id`, `new_auth_id`, `profile_name`, `cards_updated`, `transactions_updated` |
| `bank_card_blocked` | `processor-hub` `src/infra/cardBlockQueueWorker.ts` (только если реально вызывался `adapter.blockCard`), `src/infra/unlinkDeadWorker.ts` | Карта заблокирована у провайдера (`adapter.blockCard`) | `bank`, `card_number`, `profile_name`, `buyer`, `source` (`card_block_queue_worker` / контекст unlink-dead), `blocked_at_provider`, `result` (в очереди блокировок). **Не** эмитится, если воркер очереди пропустил ПС из‑за «уже заблокирована хабом» — тогда только `card_block_queue.error`. |
| `card_unlinked` | `n8n/mqtt_ecards_transactions/src/app/api/cards/unlink/route.ts`, `processor-hub` `unlinkDeadWorker` (ветки без успешной блокировки у ПС или `is_bad`) | Карта отвязана от buyer/профиля | `bank`, `card_number`, `buyer`, `profile_name`, `source` |
| `google_code_received` | `n8n/processor-hub/src/modules/transactions/index.ts` | Получен Google code / OTP-код по карте | `bank`, `acc_no`, `card_guid`, `card_number`, `correlation_id`, `otp` |
| `otp_blocked` | Код найден по литералу; эмиттер не выделен | OTP не может быть выдан/использован | `bank`, `acc_no`, `card_id`, `card_number`, `profile_name`, `amount`, `currency`, `usd_amount`, `reason` |
| `otp_received` | `n8n/mqtt_adscards_transactions/src/app/api/webhook/route.ts` | Получен OTP с внешнего webhook/сервиса | `bank`, `buyer`, `card_number`, `operation_id`, `otp_source` |
| `otp_sent` | Литералы есть в нескольких `mqtt_*` сервисах | OTP отправлен/записан в pipeline | `bank`, `acc_no`, `account_id`, `card_id`, `card_number`, `draft_id`, `profile_name`, `amount`, `currency`, `otp`, `source` |
| `payment_processed` | Есть в audit demo/docs; в prod встречается редко | Тестовое/общее финансовое событие обработки платежа | `transaction_id`, `amount`, `currency` |
| `pre_transaction_created` | Код не найден; вывод по данным | Создан pre-transaction объект до финальной атрибуции | `bank`, `transaction_id`, `profile_name`, `otp_present`, `version` |
| `queue_acquire_conflict` | `n8n/mqtt_otp_transactions_service/src/app/api/queue/acquire/route.ts` | Конфликт: слот аккаунта уже занят | `bank`, `acc_no`, `existing_bank`, `existing_acc_no`, `reason` |
| `queue_acquired` | `n8n/processor-hub/src/api/routes/queue.ts` | Аккаунт успешно занят в queue | `bank`, `acc_no`, `account_name`, `expires_at`, `source` |
| `queue_acquire_error` | `n8n/mqtt_otp_transactions_service/src/services/MqttService.ts` | Общая ошибка обработки acquire | `bank`, `acc_no`, `error`, `source` |
| `queue_acquire_failed` | `n8n/processor-hub/src/api/routes/queue.ts` | Acquire завершился без успеха по бизнес-причине | `bank`, `acc_no`, `reason`, `source` |
| `queue_acquire_device_offline` | `processor-hub` `src/api/routes/queue.ts` | Отказ в acquire: устройство для OTP не в сети (как `phone_online` в status) | `bank`, `acc_no`, `reason`, `threshold_minutes` |
| `queue_kicked_off` | `n8n/mqtt_otp_transactions_service/src/app/api/queue/kickoff/route.ts`, `processor-hub` | Принудительное освобождение/выбивание из очереди | `bank`, `acc_no`, `account_name`, `kicked_off_by` |
| `queue_released` | `n8n/processor-hub/src/api/routes/queue.ts`, `MqttService` | Успешное освобождение queue-слота | `bank`, `acc_no`, `account_name`, `source` |
| `queue_release_error` | `n8n/mqtt_otp_transactions_service/src/services/MqttService.ts` | Общая ошибка release | `bank`, `acc_no`, `error`, `source` |
| `queue_release_failed` | `n8n/processor-hub/src/api/routes/queue.ts` | Не удалось освободить slot по бизнес-причине | `bank`, `acc_no`, `account_name`, `reason`, `source` |
| `queue_slot_expired` | `n8n/processor-hub/src/infra/queueNotificationWorker.ts` | Истек срок действия занятого queue-слота | `bank`, `acc_no`, `account_name`, `email` |
| `refund` | Код явно не локализован; по структуре это профильный refund workflow | Нижний регистр: подробный refund-flow со стадиями и тегами | `profile_id`, `user_email`, `stage`, `refund_flow`, `old_status_id`, `new_status_id`, `tags_*`, `warning`, `error` |
| `Refund` | Код явно не локализован; по структуре похоже на UI/массовую операцию refund | Верхний регистр: отдельный источник refund-событий | `profile_id`, `selected_count`, `old_status_id`, `new_status_id`, `source`, `result`, `error_message`, `affected_profile_ids` |
| `refund_cancel_error` | `retool/Cab-BuyerPersonal/lib/cancelRefund.js` | Ошибка отмены refund | `error`, `info`, `stack`, `data`, `upstream_body` |
| `refund_cancel_ok` | `retool/Cab-BuyerPersonal/lib/cancelRefund.js` | Успешная отмена refund | `cancelled`, `rejected`, `skipped`, `results`, `data` |
| `refund_funds_event` | `n8n/mqtt_import_by_file_transactions/app/api/funds/create/route.ts` | Детальный event по движению refund funds | `request_id`, `kind`, `outcome`, `profile_id`, `profile_name`, `account_email`, `actual_refund_amount`, `withdrawal_amount`, `status_code`, `error_message` |
| `refund_ingest_error` | `retool/Cab-BuyerPersonal/lib/issueRefund.js` | Ошибка ingest refund-запроса | `error`, `info`, `stack`, `data`, `upstream_body` |
| `refund_ingest_ok` | `retool/Cab-BuyerPersonal/lib/issueRefund.js` | Успешный ingest refund-запроса | `accepted`, `rejected`, `skipped`, `data` |
| `refund_request` | `n8n/mqtt_import_by_file_transactions/lib/orchestrator-refund.ts` | Создание/отправка refund request в upstream | `request_id`, `request_path`, `action`, `outcome`, `upstream_status`, `error_message`, `profile_ids_count`, `profile_ids_csv`, `force_requeue`, `preserve_account` |
| `transaction_attributed` | `n8n/mqtt_ecards_transactions`, `mqtt_import_by_file_transactions`, `mqtt_adscards_transactions` | Транзакция атрибутирована buyer/профилю | `bank`, `acc_no`, `ext_id`, `amount`, `currency`, `buyer`, `profile_name`, `card_number`, `transaction_date`, `source` |
| `transaction_comment` | Код не найден; вывод по данным | Комментарий к транзакции | Атрибуты почти пустые; искать по соседним записям, `timestamp`, `user_email` |
| `transaction_linked` | `n8n/mqtt_ecards_transactions/src/services/ComplianceService.ts` | Транзакция привязана к buyer/профилю в compliance-потоке | `bank`, `acc_no`, `ext_id`, `buyer`, `buyer_source`, `profile_source`, `transaction_date` |
| `transaction_unattributed` | `n8n/mqtt_ecards_transactions`, `mqtt_import_by_file_transactions`, `mqtt_adscards_transactions` | Транзакция не смогла быть атрибутирована | `bank`, `acc_no`, `ext_id`, `amount`, `currency`, `card_number`, `profile_name`, `transaction_date`, `source` |
| `transaction_update` | `n8n/mqtt_ecards_transactions/src/services/ComplianceService.ts`, `mqtt_adscards_transactions` | Обновление buyer/атрибуции транзакции | `bank`, `ext_id`, `new_buyer`, `source` |

### Retool settings / справочники / массовые операции

| event_type | Где найдено | Краткое описание | Что смотреть в `event_attributes` |
|---|---|---|---|
| `buyer_limit_update` | `retool/Cab-BuyerControl`, `Cab-FarmControl` | Обновление лимитов buyer | `buyer_email`, `buyer_auth_id`, `max_limit`, `daily_limit`, `is_active`, `available_geo`, `updated_by`, `source` |
| `groups_batch_update` | `retool/Cab-FarmControl/src/pageGroups.rsx` | Batch-обновление групп | `batch_id`, `results`, `successful_records`, `failed_records`, `total_records`, `user_email` |
| `groups_info_before_update` | Код не найден; вывод по данным | Снимок группы до обновления | `id`, `name`, `description`, `type_name`, `profiles_count`, `users_count`, `is_active` |
| `groups_info_what_update` | Код не найден; вывод по данным | Какие поля группы изменялись | `id`, `is_active` |
| `helpBuyer_add` | `retool/Cab-FarmControl/src/pageAssistance.rsx` | Добавление помощника buyer | `batch_id`, `results`, `user_email` |
| `helpBuyer_batch_update` | `retool/Cab-FarmControl/src/pageAssistance.rsx` | Batch-обновление связок helper/buyer | `batch_id`, `results`, `successful_records`, `failed_records`, `total_records`, `user_email` |
| `helpBuyer_delete` | `retool/Cab-FarmControl/src/pageAssistance.rsx` | Удаление helper-связки | `batch_id`, `results`, `user_email` |
| `helpByuer_info_before_update` | Код не найден; есть явная опечатка в имени | Снимок helper/buyer записи до обновления | `buyer` |
| `helpByuer_info_what_update` | Код не найден; есть явная опечатка в имени | Что обновляли в helper/buyer записи | `buyer` |
| `helpers_byuer_info_what_update` | Код не найден; есть явная опечатка в имени | Вариант события с опечаткой для helper/buyer update | `buyer`, `id`, `target_auth_id` |
| `helpersByuer_info_what_update` | Код не найден; есть явная опечатка в имени | Еще один вариант того же события с опечаткой | `buyer` |
| `limits_batch_update` | `retool/Cab-BuyerControl` | Batch-обновление лимитов | `batch_id`, `results`, `successful_records`, `failed_records`, `total_records`, `user_email`, `source` |
| `limits_buyer_update` | Код найден по литералу в Retool | Обновление лимитов конкретного buyer | `batch_id`, `results`, `successful_records`, `failed_records`, `total_records`, `user_email` |
| `limits_info_before_update` | Код не найден; вывод по данным | Снимок лимитов до изменения | `buyer_auth_id`, `max_limit`, `daily_limit`, `is_active`, `available_geo` |
| `limits_info_update` | Код не найден; вывод по данным | Финальные значения лимитов после апдейта | `buyer_auth_id`, `max_limit`, `daily_limit`, `is_active`, `available_geo` |
| `limits_info_what_update` | Код не найден; вывод по данным | Какие поля лимитов изменились | `id`, `is_active`, `available_geo` |
| `limits_update` | Код не найден; вывод по данным | Детальный лог единичного обновления лимитов | `record_id`, `before_data`, `after_data`, `changes_summary`, `user_email` |
| `methods_batch_update` | `retool/Cab-FarmControl` по литералу | Batch-обновление методов | `batch_id`, `results`, `successful_records`, `failed_records`, `total_records`, `user_email` |
| `methods_info_before_update` | Код не найден; вывод по данным | Снимок метода до обновления | `id`, `name`, `description`, `is_active`, `created_at`, `updated_at` |
| `methods_info_what_update` | Код не найден; вывод по данным | Какие поля метода менялись | `id`, `name`, `description`, `is_active` |
| `rules_batch_update` | `retool/Cab-FarmControl/src/pageProfileSettings.rsx` | Batch-обновление правил/настроек профиля | `batch_id`, `results`, `successful_records`, `failed_records`, `total_records`, `user_email` |
| `statuses_batch_update` | `retool/Cab-FarmControl/src/pageStatuses.rsx` | Batch-обновление статусов | `batch_id`, `results`, `successful_records`, `failed_records`, `total_records`, `user_email` |
| `status_info_before_update` | Код не найден; вывод по данным | Снимок статуса до обновления | `id`, `name`, `phase_id`, `stage_id`, `order_id`, `color_hex`, `is_active` |
| `status_info_what_update` | Код не найден; вывод по данным | Какие поля статуса обновлялись | `id`, `order_id`, `is_active` |

### Employees / sync / misc / tests

| event_type | Где найдено | Краткое описание | Что смотреть в `event_attributes` |
|---|---|---|---|
| `api_key_test` | Код не найден; вывод по данным | Тестовое событие проверки API key | `source`, `test` |
| `binom_sync` | Код не найден; вывод по данным | Sync с Binom | `source`, `status`, `count` |
| `employee_created` | `n8n/sync/src/services/SyncService.ts` | Создан сотрудник из sync-пайплайна | `employee_id`, `email`, `full_name`, `branch_id`, `branch_name`, `status` |
| `employee_manager_assigned` | `n8n/sync/src/services/SyncService.ts` | Сотруднику назначен менеджер | `employee_id`, `email`, `full_name`, `manager_id`, `manager_name` |
| `employee_manager_changed` | `n8n/sync/src/services/SyncService.ts` | Сменился менеджер сотрудника | `employee_id`, `email`, `full_name`, `old_manager_id`, `new_manager_id`, `old_manager_name`, `new_manager_name` |
| `hired` | `n8n/sync` и audit docs | Найм сотрудника | `employee_id`, `department`, `position` |
| `hired_test` | Код не найден; вывод по данным | Тестовый вариант события найма | `employee_id`, `department`, `position` |
| `mqtt_test_event` | Код не найден; вывод по данным | Тестовое MQTT-аудит событие | `source`, `test_run` |
| `promoted` | Код не найден; вывод по данным | Повышение сотрудника | `employee_id`, `department`, `position` |
| `test` | Код не найден; тестовые записи | Тестовое событие | Проверять все поля как есть: `a`, `b`, `data`, `department`, `employee_id`, `position` |
| `test 3` | Код не найден; тестовые записи | Тестовое событие | `data`, `department`, `employee_id`, `position` |
| `testevent` | Код не найден; тестовые записи | Тестовое событие проверки типов/null | `field_with_value`, `field_with_number`, `field_with_null`, `field_with_empty_string` |
| `{event_type}` | `retool/Cab-BuyerPersonal/functions.rsx` | Явный мусорный/шаблонный event_type, вероятно запись из неразвернутого шаблона | Обычно атрибутов нет; искать рядом по `timestamp` и `user_email` |

## Наблюдения

- В базе одновременно существуют и нормализованные доменные события, и очень старые legacy UI-события с сериализованным `request_data`.
- Есть несколько явных опечаток в именах: `helpByuer_*`, `helpers_byuer_*`, `helpersByuer_*`.
- События `refund` и `Refund` выглядят как два разных источника с разными форматами payload.
- Событие `{event_type}` почти наверняка является ошибкой шаблона/подстановки.
- Для части advertiser-событий код в текущих дочерних проектах не найден: вероятно, источник находится в другом сервисе или в старом monolith-коде.

## Практические фильтры

### Все события по профилю

```sql
select timestamp, event_type, user_email, event_attributes
from public.audit
where
  event_attributes->>'profile_id' = '431528'
  or event_attributes->>'profile_name' = 'BR2316347_BEN_FP_POST_RT_0304'
order by timestamp desc;
```

### Все события по карте

```sql
select timestamp, event_type, user_email, event_attributes
from public.audit
where
  event_attributes->>'card_number' = '5347863847725027'
  or event_attributes->>'card_id' = '12345'
order by timestamp desc;
```

### Все события по queue-аккаунту

```sql
select timestamp, event_type, user_email, event_attributes
from public.audit
where
  event_type like 'queue_%'
  and event_attributes->>'bank' = 'ecards'
  and event_attributes->>'acc_no' = '1620013000000211'
order by timestamp desc;
```

### Все batch-операции из Retool

```sql
select timestamp, event_type, user_email, event_attributes
from public.audit
where event_type in (
  'groups_batch_update',
  'helpBuyer_batch_update',
  'limits_batch_update',
  'methods_batch_update',
  'rules_batch_update',
  'statuses_batch_update'
)
order by timestamp desc;
```
