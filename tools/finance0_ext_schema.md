# схема finance0_ext

## Overview

Схема используется для рефандов
**Schema Name:** `finance0_ext`  

### 10. funds_from_account

**Description:** Funds withdrawal and top-up history.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| id | bigint | NO | Primary key identifier |
| account_id | character varying(255) | YES | Account identifier |
| withdrawal_amount | numeric(12,2) | YES | Withdrawal amount |
| withdrawal_date_time | bigint | YES | Withdrawal timestamp |
| withdrawal_destination | character varying(255) | YES | Withdrawal destination |
| withdrawal_user_name | character varying(255) | YES | User name |
| account_email | character varying(255) | YES | Account email |
| top_up_dates_from | bigint | YES | Top-up start date |
| top_up_dates_to | bigint | YES | Top-up end date |
| total_top_up_amount | numeric(10,2) | YES | Total top-up amount |
| payment_method | character varying(255) | YES | Payment method |
| created_at | timestamp without time zone | YES | Creation timestamp |
| updated_at | timestamp without time zone | YES | Last update timestamp |
| currency | character varying(255) | YES | Currency code |
| profile_name | character varying(255) | YES | Profile name |
| profile_uuid | character varying(255) | YES | Profile UUID |
| employee_name | character varying(255) | YES | Employee name |
| last_used_at | timestamp without time zone | YES | Last used timestamp |
| screenshot_path | character varying(255) | YES | Screenshot file path |
| bayer_id | character varying(255) | YES | Buyer ID |
| bayer_name | character varying(255) | YES | Buyer name |
| actual_refund_amount | numeric(15,2) | YES | Actual refund amount |
| active | boolean | NO | Active status |
