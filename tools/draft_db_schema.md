# Схемы таблиц в схеме public

Этот документ содержит описание всех таблиц в схеме `public` (бд draft-db), включая их структуру и связи между ними.

## Список таблиц

1. [advertisers](#advertisers)
2. [advertisers_transactions](#advertisers_transactions)
3. [advertisers_transactions_types](#advertisers_transactions_types)
4. [aff_admins](#aff_admins)
5. [aff_chats](#aff_chats)
6. [agent_run_steps](#agent_run_steps)
7. [agent_runs](#agent_runs)
8. [ai_logs](#ai_logs)
9. [ai_rag](#ai_rag)
10. [audit](#audit)
11. [audit_decode](#audit_decode)
12. [balance_history](#balance_history)
13. [bank_accounts](#bank_accounts)
14. [bank_cards](#bank_cards)
15. [bank_cards_shown](#bank_cards_shown)
16. [bank_transactions](#bank_transactions)
17. [banks](#banks)
18. [binom](#binom)
19. [binom_stats](#binom_stats)
20. [cards_access](#cards_access)
21. [cards_info](#cards_info)
22. [drafts](#drafts)
23. [ecards_card_ops](#ecards_card_ops)
24. [exchange](#exchange)
25. [farm_otp_dedup](#farm_otp_dedup)
26. [fibery_profiles](#fibery_profiles)
27. [irev_advertisers_api](#irev_advertisers_api)
28. [irev_events_api](#irev_events_api)
29. [irev_leads](#irev_leads)
30. [irev_logs](#irev_logs)
31. [irev_main](#irev_main)
32. [irev_metrics](#irev_metrics)
33. [irev_metrics_daily](#irev_metrics_daily)
34. [irev_settings](#irev_settings)
35. [knowledge_docs](#knowledge_docs)
36. [knowledge_embeddings](#knowledge_embeddings)
37. [leads](#leads)
38. [leads_irev_api](#leads_irev_api)
39. [octo](#octo)
40. [octo_actionlog](#octo_actionlog)
41. [octo_backup_full](#octo_backup_full)
42. [openid_audit](#openid_audit)
43. [ota_device_logs](#ota_device_logs)
44. [ota_devices](#ota_devices)
45. [ota_firmware](#ota_firmware)
46. [queue](#queue)
47. [rate_irev](#rate_irev)
48. [slack_installations](#slack_installations)
49. [tma_applications](#tma_applications)
50. [tma_countries](#tma_countries)
51. [tma_export_history](#tma_export_history)
52. [tma_users](#tma_users)
53. [training_items](#training_items)
54. [with_tech_farm](#with_tech_farm)
55. [with_tech_farm_logs](#with_tech_farm_logs)

## Описание таблиц

### advertisers

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| name | character varying | NO | null |
| current_balance | numeric(10,2) | NO | 0 |
| comment | character varying | YES | null |
| campaign_uuids | ARRAY | YES | null |
| created_at | timestamp without time zone | YES | null |
| deleted_at | timestamp without time zone | YES | null |

### advertisers_transactions

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| created_at | timestamp without time zone | NO | null |
| amount | numeric(10,2) | NO | null |
| balance_before | numeric(10,2) | NO | null |
| balance_after | numeric(10,2) | NO | null |
| campaign_uuid | uuid | YES | null |
| advertiser_uuid | uuid | NO | null |
| advertiser_transaction_type | numeric(32,0) | NO | null |
| user_email | character varying | YES | null |
| comment | character varying | YES | null |

### advertisers_transactions_types

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | numeric(32,0) | NO | nextval('advertisers_transactions_types_id_seq'::regclass) |
| name | character varying | NO | null |
| increment_balance | boolean | NO | null |
| negative_increment | boolean | NO | false |

### aff_admins

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| user_id | numeric(64,0) | NO | null |
| created_at | timestamp without time zone | YES | CURRENT_TIMESTAMP |
| nickname | text | YES | null |

### aff_chats

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | numeric(64,0) | NO | null |
| name | text | YES | null |
| created_at | timestamp without time zone | YES | CURRENT_TIMESTAMP |
| deleted_at | timestamp without time zone | YES | null |

### agent_run_steps

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| run_id | uuid | NO | null |
| step_index | numeric(32,0) | NO | null |
| type | text | NO | null |
| payload | jsonb | NO | null |
| created_at | timestamp with time zone | NO | now() |

### agent_runs

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| session_id | text | NO | null |
| question | text | NO | null |
| final_answer | text | YES | null |
| created_at | timestamp with time zone | NO | now() |
| timings | jsonb | YES | '{}'::jsonb |
| retrieved_doc_ids | ARRAY | YES | '{}'::uuid[] |
| sql_call_count | numeric(32,0) | YES | 0 |
| status | text | NO | 'ok'::text |
| error | text | YES | null |

### ai_logs

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| created_at | timestamp without time zone | NO | CURRENT_TIMESTAMP |
| user_message | text | NO | null |
| llm_response | text | YES | null |
| provider | text | YES | null |
| model | text | YES | null |
| iterations | numeric(32,0) | YES | null |
| tool_calls | jsonb | YES | null |
| response_time_ms | numeric(32,0) | YES | null |
| error | text | YES | null |
| user_ip | text | YES | null |
| user_agent | text | YES | null |

### ai_rag

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | numeric(32,0) | NO | nextval('ai_rag_id_seq'::regclass) |
| path | text | NO | null |
| chunk_index | numeric(32,0) | NO | null |
| content | text | NO | null |
| embedding | USER-DEFINED | YES | null |
| title | text | YES | null |
| created_at | timestamp without time zone | YES | now() |
| updated_at | timestamp without time zone | YES | now() |

### audit

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | uuid | NO | null |
| timestamp | timestamp with time zone | NO | null |
| division | text | NO | null |
| user_email | text | NO | null |
| log_type | USER-DEFINED | NO | null |
| severity | numeric(16,0) | NO | null |
| event_type | text | NO | null |
| event_attributes | jsonb | YES | null |
| created_at | timestamp with time zone | YES | now() |

### audit_decode

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | numeric(32,0) | NO | nextval('audit_decode_id_seq'::regclass) |
| event_type | text | NO | null |
| event_type_template | text | YES | null |
| event_attributes_template | text | YES | null |

### balance_history

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| created_at | timestamp without time zone | NO | now() |
| bank | USER-DEFINED | NO | null |
| acc_no | text | NO | null |
| operation_type | text | NO | null |
| amount | numeric | NO | null |
| balance_before | numeric | NO | null |
| balance_after | numeric | NO | null |
| currency | text | YES | null |
| user_email | text | YES | null |
| comment | text | YES | null |
| source | text | YES | 'manual'::text |
| related_draft_id | uuid | YES | null |

### bank_accounts

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| bank | USER-DEFINED | NO | null |
| acc_no | text | NO | null |
| name | text | YES | null |
| phone | text | YES | 0 |
| balance | numeric | YES | 0 |
| currency | text | YES | ''::text |
| info | text | YES | null |
| info_at | timestamp without time zone | YES | null |
| info_buyer | USER-DEFINED | YES | null |
| login | text | YES | null |
| password | text | YES | null |
| extra | text | YES | null |
| balance_limit_alert | numeric | YES | 0 |
| op_limit_alert | numeric | YES | 100 |
| op_sum_limit_alert | numeric | YES | 400000 |

### bank_cards

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| buyer | USER-DEFINED | YES | null |
| card_number | numeric(64,0) | YES | null |
| bank | USER-DEFINED | YES | null |
| acc_no | USER-DEFINED | YES | null |
| created_at | timestamp without time zone | NO | now() |
| note | text | YES | null |
| profile_name | USER-DEFINED | YES | null |
| creds | text | YES | null |
| ext_id | text | YES | null |
| released_at | timestamp with time zone | YES | null |

### bank_cards_shown

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| created_at | timestamp without time zone | NO | now() |
| card_number | numeric(64,0) | NO | null |
| email | USER-DEFINED | YES | null |
| profile_name | USER-DEFINED | YES | null |

### bank_transactions

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| ext_id | text | NO | null |
| created_at | timestamp without time zone | NO | null |
| bank | text | NO | 'ecards'::text |
| amount | numeric | YES | null |
| currency | text | YES | null |
| acc_no | text | YES | null |
| transaction_type | text | YES | null |
| balance_before | numeric | YES | null |
| balance_after | numeric | YES | null |
| created_at_utc | timestamp without time zone | YES | null |
| card_number | bigint | YES | null |
| operation_type | text | YES | null |
| created_at_utc2 | timestamp without time zone | YES | null |
| card_number2 | bigint | YES | null |
| card_number3 | bigint | YES | null |
| card_number4 | bigint | YES | null |
| card_number5 | bigint | YES | null |
| card_number6 | bigint | YES | null |
| card_number7 | bigint | YES | null |
| card_number8 | bigint | YES | null |
| card_number9 | bigint | YES | null |
| card_number10 | bigint | YES | null |

### banks

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| name | text | NO | null |
| is_active | boolean | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### binom

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| campaign_id | bigint | NO | null |
| click_count | bigint | NO | null |
| impression_count | bigint | NO | null |
| cost | numeric(20,2) | NO | null |
| profit | numeric(20,2) | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### binom_stats

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| date | date | NO | null |
| campaign_id | bigint | NO | null |
| click_count | bigint | NO | null |
| impression_count | bigint | NO | null |
| cost | numeric(20,2) | NO | null |
| profit | numeric(20,2) | NO | null |

### cards_access

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| card_id | bigint | NO | null |
| user_id | bigint | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### cards_info

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| card_number | text | NO | null |
| bank | text | YES | null |
| acc_no | text | YES | null |
| balance | numeric(18,2) | NO | null |
| currency | text | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### drafts

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| created_at | timestamp without time zone | NO | now() |
| updated_at | timestamp without time zone | NO | now() |
| user_email | text | NO | null |
| bank | text | NO | null |
| acc_no | text | NO | null |
| amount | numeric(18,2) | NO | null |
| currency | text | NO | null |
| operation_type | text | NO | null |
| comment | text | YES | null |
| status | text | NO | null |
| status_message | text | YES | null |

### ecards_card_ops

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| card_number | text | NO | null |
| bank | text | YES | null |
| acc_no | text | YES | null |
| balance | numeric(18,2) | NO | null |
| currency | text | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### exchange

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| currency_from | text | NO | null |
| currency_to | text | NO | null |
| rate | numeric(18,6) | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### farm_otp_dedup

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| phone | text | NO | null |
| otp_code | text | NO | null |
| created_at | timestamp without time zone | NO | null |

### fibery_profiles

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| name | text | NO | null |
| description | text | YES | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### irev_advertisers_api

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| advertiser_id | bigint | NO | null |
| campaign_id | bigint | NO | null |
| name | text | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |
| is_active | boolean | NO | null |

### irev_events_api

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| advertiser_id | bigint | NO | null |
| event_type | text | NO | null |
| event_data | text | YES | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### irev_leads

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| campaign_id | bigint | NO | null |
| lead_id | bigint | NO | null |
| name | text | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |
| is_active | boolean | NO | null |

### irev_logs

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| advertiser_id | bigint | NO | null |
| log_type | text | NO | null |
| log_data | text | YES | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### irev_main

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| advertiser_id | bigint | NO | null |
| campaign_id | bigint | NO | null |
| name | text | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |
| is_active | boolean | NO | null |

### irev_metrics

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| advertiser_id | bigint | NO | null |
| campaign_id | bigint | NO | null |
| metric_type | text | NO | null |
| metric_value | numeric(20,2) | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### irev_metrics_daily

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| advertiser_id | bigint | NO | null |
| campaign_id | bigint | NO | null |
| date | date | NO | null |
| metric_type | text | NO | null |
| metric_value | numeric(20,2) | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### irev_settings

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| setting_key | text | NO | null |
| setting_value | text | YES | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### knowledge_docs

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| title | text | NO | null |
| content | text | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### knowledge_embeddings

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| document_id | bigint | NO | null |
| embedding | USER-DEFINED | YES | null |
| created_at | timestamp without time zone | NO | null |

### leads

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| campaign_id | bigint | NO | null |
| lead_id | bigint | NO | null |
| name | text | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |
| is_active | boolean | NO | null |

### leads_irev_api

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| advertiser_id | bigint | NO | null |
| campaign_id | bigint | NO | null |
| name | text | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |
| is_active | boolean | NO | null |

### octo

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| name | text | NO | null |
| description | text | YES | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |
| is_active | boolean | NO | null |

### octo_actionlog

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| action_type | text | NO | null |
| action_data | text | YES | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### octo_backup_full

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| backup_name | text | NO | null |
| backup_path | text | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### openid_audit

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| user_id | bigint | NO | null |
| action_type | text | NO | null |
| action_data | text | YES | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### ota_device_logs

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| device_id | bigint | NO | null |
| log_type | text | NO | null |
| log_data | text | YES | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### ota_devices

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| device_name | text | NO | null |
| device_type | text | YES | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |
| is_active | boolean | NO | null |

### ota_firmware

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| firmware_name | text | NO | null |
| firmware_version | text | NO | null |
| firmware_path | text | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |
| is_active | boolean | NO | null |

### queue

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| task_type | text | NO | null |
| task_data | text | YES | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |
| status | text | YES | null |

### rate_irev

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| currency_pair | text | NO | null |
| rate | numeric(18,6) | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### slack_installations

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| slack_team_id | text | NO | null |
| slack_bot_id | text | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### tma_applications

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| application_name | text | NO | null |
| description | text | YES | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |
| is_active | boolean | NO | null |

### tma_countries

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| country_code | text | NO | null |
| country_name | text | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### tma_export_history

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| export_type | text | NO | null |
| export_data | text | YES | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |
| status | text | YES | null |

### tma_users

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| user_email | text | NO | null |
| user_name | text | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |
| is_active | boolean | NO | null |

### training_items

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| item_type | text | NO | null |
| item_content | text | NO | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

### with_tech_farm

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| name | text | NO | null |
| description | text | YES | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |
| is_active | boolean | NO | null |

### with_tech_farm_logs

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | null |
| farm_id | bigint | NO | null |
| log_type | text | NO | null |
| log_data | text | YES | null |
| created_at | timestamp without time zone | NO | null |
| updated_at | timestamp without time zone | NO | null |

## Связи между таблицами

В данный момент связи между таблицами не обнаружены.