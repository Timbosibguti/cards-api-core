# API V3 Routes Documentation

## Base URL
All API v3 endpoints are accessed via: `https://talkv2.adscard.net/v3`

## Route Format
All routes follow the pattern: `/v3/{group}/{action}`

## Authentication
All requests require:
- **Application-Authorization**: Bearer Token header
- **Content-Type**: application/json
- **auth_token**: Included in request body (except for `/v3/auth/login`)

## Response Format
All responses include a `request_id` field in the JSON response body.

## Time Parameter
For listing methods, you may need to specify a time period using the `time` parameter:

- `3day` - 3 days
- `day` - today
- `yesterday` - yesterday
- `week` - current week
- `last_week` - last week
- `month` - current month
- `last_month` - last month
- `year` - current year
- `last_year` - last year
- `period` - custom period

If `period` is used in `time`, provide the `period` parameter in format: `2023-01-01|2023-02-01`

---

## Routes by Group

### Auth

#### `POST /v3/auth/login`
Get authorization token

**Request Body:**
```json
{
    "email": "user@example.com",
    "password": "password"
}
```

**Required Parameters:**
- `email` (string) - User email address
- `password` (string) - User password

**Response:**
```json
{
    "auth_token": "TOKEN",
    "request_id": "REQUEST_ID"
}
```

---

### Users

#### `POST /v3/users/balance`
Get user balance

**Request Body:**
```json
{
    "auth_token": "TOKEN"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Response:**
```json
{
    "data": {
        "usd": 100.50,
        "rub": 5000.00,
        "eur": 50.25
    },
    "request_id": "REQUEST_ID"
}
```

---

### Cards (Advertising Cards)

#### `POST /v3/cards/declinerate`
Get declined transactions percentage

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "time": "TIME",
    "period": "PERIOD"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `time` (string) - Time period filter

**Optional Parameters:**
- `period` (string) - Custom period in format `YYYY-MM-DD|YYYY-MM-DD` (required if `time` is "period")

**Response:**
```json
{
    "data": {
        "percent": 5
    },
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards/count`
Get count of active cards

**Request Body:**
```json
{
    "auth_token": "TOKEN"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Response:**
```json
{
    "data": {
        "count": 10
    },
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards/statement`
Get card statement/statistics

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "time": "TIME",
    "period": "PERIOD",
    "card_id": "CARD_ID",
    "currency": "usd|rub|eur",
    "group_id": "GROUP_ID",
    "bin_id": "BIN_ID"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `time` (string) - Time period filter

**Optional Parameters:**
- `period` (string) - Custom period in format `YYYY-MM-DD|YYYY-MM-DD` (required if `time` is "period")
- `card_id` (string) - Filter by specific card ID
- `currency` (string) - Filter by currency: `usd`, `rub`, or `eur`
- `group_id` (string) - Filter by group ID
- `bin_id` (string) - Filter by BIN ID

**Response:**
```json
{
    "data": {
        "2023-01-01": {
            "fee": 10.5,
            "withdrawal": 100.0,
            "replenishment": 200.0,
            "issued": 5,
            "failed": 2,
            "pending": 1
        }
    },
    "request_id": "REQUEST_ID"
}
```

**Note:** Response types include: `fee`, `withdrawal`, `replenishment`, `issued`, `failed`, `pending`

#### `POST /v3/cards/transactions`
Get list of transactions

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "time": "TIME",
    "period": "PERIOD",
    "card_id": "CARD_ID",
    "currency": "usd|rub|eur",
    "type": "TYPE",
    "bin_id": "BIN_ID",
    "group_id": "GROUP_ID"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `time` (string) - Time period filter

**Optional Parameters:**
- `period` (string) - Custom period in format `YYYY-MM-DD|YYYY-MM-DD` (required if `time` is "period")
- `card_id` (string) - Filter by specific card ID
- `currency` (string) - Filter by currency: `usd`, `rub`, or `eur`
- `type` (string) - Filter by transaction type: `fee`, `withdrawal`, `replenishment`, `issued`, `failed`, `pending`
- `bin_id` (string) - Filter by BIN ID
- `group_id` (string) - Filter by group ID

**Response:**
```json
{
    "data": {
        "id": "TRANSACTION_ID",
        "card_number": "CARD_NUMBER",
        "amount": 100.50,
        "fee": 2.50,
        "date": "2023-01-01 12:00:00",
        "merchant": "MERCHANT_NAME",
        "status": "STATUS",
        "currency": "USD",
        "group_id": 1,
        "bank_commission": [
            {
                "name": "VALUE"
            }
        ]
    },
    "request_id": "REQUEST_ID"
}
```

**Note:** Transaction types include: `fee`, `withdrawal`, `replenishment`, `issued`, `failed`, `pending`

#### `POST /v3/cards/list`
Get list of cards

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "card_id": "CARD_ID",
    "currency": "usd|rub|eur",
    "group": "GROUP_ID",
    "status": "A|D"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `card_id` (string) - Filter by specific card ID
- `currency` (string) - Filter by currency: `usd`, `rub`, or `eur`
- `group` (string) - Filter by group ID
- `status` (string) - Filter by status: `A` (active) or `D` (deactivated)

**Response:**
```json
{
    "data": {
        "id": "ID",
        "number": "CARD_NUMBER",
        "date_expired": "2025-12-31",
        "date_issued": "2023-01-01",
        "status": "A",
        "currency": "usd",
        "cvc": "123",
        "comment": "COMMENT",
        "expense": 1000.50,
        "balance": 500.25,
        "limit": 2000.00,
        "group": 1,
        "payment_info": {
            "address": "ADDRESS",
            "pass": "PASS",
            "card_holder": "CARD_HOLDER",
            "region": "REGION"
        }
    },
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards/purchase`
Purchase a card

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "count": 1,
    "bin": 1,
    "email": "email@example.com"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `count` (integer) - Number of cards to purchase
- `bin` (integer) - BIN ID

**Optional Parameters:**
- `email` (string) - Email address (nullable)

**Response:**
```json
{
    "data": {
        "CARD_OBJECT"
    },
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards/block`
Block cards

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "cards_id": [1, 2, 3]
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `cards_id` (array) - Array of card IDs to block

**Response:**
```json
{
    "data": true,
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards/limit`
Change card limit

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "cards_id": [1, 2, 3],
    "limit": 2000
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `cards_id` (array) - Array of card IDs
- `limit` (integer) - Limit value. If `limit` is 0, it removes the fixed limit

**Response:**
```json
{
    "data": true,
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards/get_sms`
Get SMS code

**Request Body:**
```json
{
    "auth_token": "TOKEN"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Response:**
```json
{
    "data": {
        "code": "123456"
    },
    "request_id": "REQUEST_ID"
}
```

**Note:** If code is 0, request again later (code hasn't arrived yet)

#### `POST /v3/cards/issue_info`
Get information about available cards and bins

**Request Body:**
```json
{
    "auth_token": "TOKEN"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Response:**
```json
{
    "data": {
        "count": 10,
        "info": {
            "id": "BIN_ID",
            "bin": "BIN_NUMBER",
            "tr": "TR_FEE",
            "currency": "USD",
            "security": "3DS",
            "description_ru": "DESCRIPTION_RU",
            "description_en": "DESCRIPTION_EN",
            "fee": 5.0,
            "purchase": 100.0,
            "decline": 2.0,
            "region": "REGION"
        }
    },
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards/groups`
Get list of card groups

**Request Body:**
```json
{
    "auth_token": "TOKEN"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Response:**
```json
{
    "data": [
        {
            "id": 1,
            "name": "GROUP_NAME"
        }
    ],
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards/groups_add`
Create a card group

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "name": "GROUP_NAME"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `name` (string) - Group name

**Response:**
```json
{
    "data": {},
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards/groups_rename`
Rename a card group

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "name": "NEW_NAME",
    "id": 1
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `name` (string) - New group name
- `id` (integer) - Group ID

**Response:**
```json
{
    "data": {},
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards/groups_delete`
Delete a card group

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "id": 1
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `id` (integer) - Group ID

**Response:**
```json
{
    "data": {},
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards/card_groups_add`
Add cards to a group

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "id": 1,
    "cards_id": [1, 2, 3]
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `id` (integer) - Group ID. If `id` is 0, it removes cards from groups they belong to
- `cards_id` (array) - Array of card IDs to add to the group

**Response:**
```json
{
    "data": {},
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards/comment`
Add/edit comment for card

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "id": 1,
    "comment": "COMMENT_TEXT"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `id` (integer) - Card ID
- `comment` (string) - Comment text

**Response:**
```json
{
    "data": {},
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards/limit_up`
Increase limit for card

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "cards_id": [1, 2, 3],
    "limit": 2000
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `cards_id` (array) - Array of card IDs
- `limit` (integer) - Limit value to set

**Response:**
```json
{
    "data": true,
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards/limit_down`
Decrease limit for card

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "cards_id": [1, 2, 3],
    "limit": 1000
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `cards_id` (array) - Array of card IDs
- `limit` (integer) - Limit value to set

**Response:**
```json
{
    "data": true,
    "request_id": "REQUEST_ID"
}
```


---

### Cards Pay (Purchase Cards)

#### `POST /v3/cards_pay/statistics`
Get statistics for cards_pay

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "time": "TIME",
    "period": "PERIOD"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `time` (string) - Time period filter

**Optional Parameters:**
- `period` (string) - Custom period in format `YYYY-MM-DD|YYYY-MM-DD` (required if `time` is "period")

**Response:**
```json
{
    "data": {
        "2023-01-01": {
            "fee": 10.5,
            "withdrawal": 100.0,
            "replenishment": 200.0,
            "issued": 5,
            "failed": 2,
            "pending": 1
        }
    },
    "request_id": "REQUEST_ID"
}
```

**Note:** This endpoint uses the same backend method as `statement` but is specifically for statistics.

#### `POST /v3/cards_pay/transactions`
Get list of transactions

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "time": "TIME",
    "period": "PERIOD",
    "card_id": "CARD_ID",
    "currency": "usd|rub|eur",
    "type": "TYPE"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `time` (string) - Time period filter

**Optional Parameters:**
- `period` (string) - Custom period in format `YYYY-MM-DD|YYYY-MM-DD` (required if `time` is "period")
- `card_id` (string) - Filter by specific card ID
- `currency` (string) - Filter by currency: `usd`, `rub`, or `eur`
- `type` (string) - Filter by transaction type: `fee`, `withdrawal`, `replenishment`, `issued`, `failed`, `pending`

**Response:**
```json
{
    "data": [
        {
            "id": "TRANSACTION_ID",
            "card_number": "CARD_NUMBER",
            "amount": 100.50,
            "fee": 2.50,
            "date": "2023-01-01 12:00:00",
            "merchant": "MERCHANT_NAME",
            "status": "STATUS",
            "currency": "USD"
        }
    ],
    "request_id": "REQUEST_ID"
}
```

**Note:** Transaction types include: `fee`, `withdrawal`, `replenishment`, `issued`, `failed`, `pending`

#### `POST /v3/cards_pay/list`
Get list of cards

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "time": "TIME",
    "period": "PERIOD",
    "card_id": "CARD_ID",
    "currency": "usd|rub|eur",
    "type": "TYPE"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `time` (string) - Time period filter
- `period` (string) - Custom period in format `YYYY-MM-DD|YYYY-MM-DD` (required if `time` is "period")
- `card_id` (string) - Filter by specific card ID
- `currency` (string) - Filter by currency: `usd`, `rub`, or `eur`
- `type` (string) - Filter by type

**Response:**
```json
{
    "data": [
        {
            "id": "ID",
            "number": "CARD_NUMBER",
            "date_expired": "2025-12-31",
            "date_issued": "2023-01-01",
            "status": "A",
            "currency": "usd",
            "cvc": "123",
            "comment": "COMMENT",
            "expense": 1000.50,
            "balance": 500.25
        }
    ],
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards_pay/purchase`
Purchase a card

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "count": 1,
    "bin": 1,
    "amount": 100.50
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `count` (integer) - Number of cards to purchase
- `bin` (integer) - BIN ID

**Optional Parameters:**
- `amount` (numeric) - Amount (nullable)

**Response:**
```json
{
    "data": {
        "CARD_OBJECT"
    },
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards_pay/block`
Block cards

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "cards_id": [1, 2, 3]
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `cards_id` (array) - Array of card IDs to block

**Response:**
```json
{
    "data": true,
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards_pay/limit`
Change balance/limit

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "cards_id": [1, 2, 3],
    "topup": 1000
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `cards_id` (array) - Array of card IDs
- `topup` (integer) - Top-up amount. If `topup` is 0, it removes the fixed limit

**Response:**
```json
{
    "data": true,
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards_pay/issue_info`
Get information about available cards and bins

**Request Body:**
```json
{
    "auth_token": "TOKEN"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Response:**
```json
{
    "data": {
        "count": 10,
        "info": {
            "id": "BIN_ID",
            "bin": "BIN_NUMBER",
            "tr": "TR_FEE",
            "currency": "USD",
            "security": "3DS",
            "description_ru": "DESCRIPTION_RU",
            "description_en": "DESCRIPTION_EN",
            "fee": 5.0,
            "purchase": 100.0,
            "decline": 2.0,
            "topup": 1.0
        }
    },
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards_pay/get_sms`
Get SMS code

**Request Body:**
```json
{
    "auth_token": "TOKEN"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Response:**
```json
{
    "data": {
        "code": "123456"
    },
    "request_id": "REQUEST_ID"
}
```

**Note:** If code is 0, request again later (code hasn't arrived yet)

#### `POST /v3/cards_pay/comment`
Add/edit comment for cards_pay

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "id": 1,
    "comment": "COMMENT_TEXT"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `id` (integer) - Card ID
- `comment` (string) - Comment text

**Response:**
```json
{
    "data": {},
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards_pay/freeze`
Freeze a cards_pay card

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "cards_id": [1, 2, 3]
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `cards_id` (array) - Array of card IDs to freeze

**Response:**
```json
{
    "data": {
        "0": {
            "id": "ID",
            "guid": "CARD_GUID",
            "number": "CARD_NUMBER",
            "date_expired": "2025-12-31",
            "date_issued": "2023-01-01",
            "status": "A",
            "currency": "usd",
            "cvc": "123",
            "comment": "COMMENT",
            "expense": 1000.50,
            "balance": 500.25,
            "marketplace": 1,
            "payment_info": {
                "address": "ADDRESS",
                "pass": "PASS",
                "card_holder": "CARD_HOLDER",
                "region": "REGION"
            },
            "fee": "2.5"
        }
    },
    "request_id": "REQUEST_ID"
}
```

**Note:** Returns an object with numeric string keys (`"0"`, `"1"`, etc.) containing the frozen card objects.

#### `POST /v3/cards_pay/unfreeze`
Unfreeze a cards_pay card

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "cards_id": [1, 2, 3]
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `cards_id` (array) - Array of card IDs to unfreeze

**Response:**
```json
{
    "data": {
        "0": {
            "id": "ID",
            "guid": "CARD_GUID",
            "number": "CARD_NUMBER",
            "date_expired": "2025-12-31",
            "date_issued": "2023-01-01",
            "status": "A",
            "currency": "usd",
            "cvc": "123",
            "comment": "COMMENT",
            "expense": 1000.50,
            "balance": 500.25,
            "marketplace": 1,
            "payment_info": {
                "address": "ADDRESS",
                "pass": "PASS",
                "card_holder": "CARD_HOLDER",
                "region": "REGION"
            },
            "fee": "2.5"
        }
    },
    "request_id": "REQUEST_ID"
}
```

**Note:** Returns an object with numeric string keys (`"0"`, `"1"`, etc.) containing the unfrozen card objects.

#### `POST /v3/cards_pay/billing_email`
Manage billing email for cards_pay

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "id": 1,
    "value": "email@example.com"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `id` (integer) - Card ID
- `value` (string) - Email address

**Response:**
```json
{
    "data": {},
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/cards_pay/billing_phone`
Manage billing phone for cards_pay

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "id": 1,
    "phone": "1234567890",
    "zone": "+1"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `id` (integer) - Card ID
- `phone` (string) - Phone number
- `zone` (string) - Country code zone (e.g., "+1", "+7")

**Response:**
```json
{
    "data": {},
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/exchange_eur_usd`
Get USD to EUR exchange rate

**Request Body:**
```json
{
    "auth_token": "TOKEN"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Response:**
```json
{
    "data": {
        "rate": 0.838,
        "from": "usd",
        "to": "eur"
    },
    "request_id": "REQUEST_ID"
}
```

**Note:** `rate` is how much you get of the target currency (`to`) per 1 USD. Example: rate 0.838 means 1 USD = 0.838 EUR.

#### `POST /v3/exchange_gbp_usd`
Get USD to GBP exchange rate

**Request Body:**
```json
{
    "auth_token": "TOKEN"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Response:**
```json
{
    "data": {
        "rate": 0.838,
        "from": "usd",
        "to": "gbp"
    },
    "request_id": "REQUEST_ID"
}
```

**Note:** `rate` is how much you get of the target currency (`to`) per 1 USD. Example: rate 0.838 means 1 USD = 0.838 GBP.


---

### Withdrawals

#### `POST /v3/withdrawals/add`
Add a withdrawal request

**Request Body:**
```json
{
    "type": "ost|card2card|yoomoney|qiwi|mobile|eur|azn|kzt",
    "sum": 100.50,
    "pin": "PIN",
    "currency": "usd|rub",
    "details": {
        "wallet": "WALLET",
        "dateexpire": "12/25",
        "birthdate": "01.01.1990",
        "card_holder": "CARD_HOLDER",
        "country": "US",
        "provider_id": 1
    }
}
```

**Required Parameters:**
- `type` (string) - Withdrawal type
- `sum` (numeric) - Withdrawal amount
- `currency` (string) - Currency: `usd` or `rub`
- `details` (object) - Details object

**Optional Parameters:**
- `pin` (string) - PIN code

**Required `details` fields depend on withdrawal type:**
- `ost`, `card2card`, `yoomoney`, `qiwi`, `kzt`: `wallet`
- `mobile`: `wallet`, `provider_id`
- `eur`: `provider_id`, `wallet`, `dateexpire`, `birthdate`, `card_holder`
- `azn`: `wallet`, `dateexpire`

**Response:**
```json
{
    "data": {
        "id": "TRANSACTION_ID",
        "guid": "GUID",
        "amount": 100.50,
        "balance_amount": 98.00,
        "fee": 2.50,
        "balance_currency": "USD",
        "date": "2023-01-01 12:00:00",
        "wallet": "CARD_NUMBER",
        "type": "card2card",
        "bank": "BANK_NAME",
        "currency": "USD",
        "status": "inwork"
    },
    "request_id": "REQUEST_ID"
}
```

**Withdrawal Types:**
- `ost` - Transfer without notes (Russia) - requires: `wallet`
- `card2card` - Card to card transfer (Russia) - requires: `wallet`
- `yoomoney` - YooMoney wallet transfer - requires: `wallet`
- `qiwi` - Qiwi wallet transfer - requires: `wallet`
- `mobile` - Mobile phone top-up - requires: `wallet`, `provider_id`
- `eur` - Transfer to any card worldwide in EUR - requires: `provider_id`, `wallet`, `dateexpire`, `birthdate`, `card_holder`
- `azn` - Transfer to Azerbaijan card in AZN - requires: `wallet`, `dateexpire`
- `kzt` - Transfer to Kazakhstan card in KZT - requires: `wallet`

**Mobile Providers (provider_id):**
- `1` - МТС
- `2` - Мегафон
- `3` - Tele2
- `4` - Билайн

**Parameter Descriptions:**
- `provider_id` - Mobile operator ID
- `wallet` - Card number or wallet number (qiwi/yoomoney)
- `dateexpire` - Card expiration date in format `mm/yy`
- `birthdate` - Birth date in format `dd.mm.yyyy`
- `card_holder` - Card holder name
- `country` - Country in ISO format

#### `POST /v3/withdrawals/transactions`
Get list of withdrawal transactions

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "time": "TIME",
    "period": "PERIOD",
    "type": "TYPE",
    "guid": "GUID"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `time` (string) - Time period filter

**Optional Parameters:**
- `period` (string) - Custom period in format `YYYY-MM-DD|YYYY-MM-DD` (required if `time` is "period")
- `type` (string) - Filter by withdrawal type
- `guid` (string) - Filter by transaction GUID

**Response:**
```json
{
    "data": {
        "0": {
            "id": "TRANSACTION_ID",
            "guid": "GUID",
            "amount": 100.50,
            "balance_amount": 98.00,
            "fee": 2.50,
            "balance_currency": "USD",
            "date": "2023-01-01 12:00:00",
            "wallet": "CARD_NUMBER",
            "type": "card2card",
            "bank": "BANK_NAME",
            "currency": "USD",
            "status": "accepted"
        }
    },
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/withdrawals/transaction`
Get a single withdrawal transaction by GUID or external_id

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "guid": "GUID",
    "external_id": "EXTERNAL_ID"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- Either `guid` OR `external_id` (at least one must be provided)

**Optional Parameters:**
- `guid` (string) - Transaction GUID
- `external_id` (string) - External transaction ID

**Response:**
```json
{
    "data": {
        "id": "TRANSACTION_ID",
        "guid": "GUID",
        "amount": 100.50,
        "balance_amount": 98.00,
        "fee": 2.50,
        "balance_currency": "USD",
        "date": "2023-01-01 12:00:00",
        "wallet": "CARD_NUMBER",
        "type": "card2card",
        "bank": "BANK_NAME",
        "currency": "USD",
        "status": "accepted"
    },
    "request_id": "REQUEST_ID"
}
```

**Note:** Returns first transaction from year period if found, or `{"error": "not_found"}` if not found.

#### `POST /v3/withdrawals/list`
Get available withdrawal methods

**Request Body:**
```json
{
    "auth_token": "TOKEN"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Response:**
```json
{
    "data": {
        "card2card": {
            "commission": 2.5,
            "min": 10.0,
            "max": 10000.0,
            "rate": 1.0
        },
        "yoomoney": {
            "commission": 1.5,
            "min": 5.0,
            "max": 5000.0,
            "rate": 1.0
        }
    },
    "request_id": "REQUEST_ID"
}
```

---

### Balance (Top-ups)

#### `POST /v3/balance/trc_topup`
Top up balance via TRC (Tron)

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "amount": 100.50
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `amount` (numeric) - Top-up amount (defaults to 0)

**Response:**
```json
{
    "data": {
        "time": 1234567890,
        "amount": 100.50,
        "wallet": "TRON_WALLET_ADDRESS",
        "qr": "QR_CODE_LINK",
        "status": "pending",
        "created_at": "2023-01-01 12:00:00"
    },
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/balance/trc_list`
Get list of TRC top-ups

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "time": "TIME",
    "period": "PERIOD",
    "status": "STATUS",
    "id": 1
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `time` (string) - Time period filter
- `period` (string) - Custom period in format `YYYY-MM-DD|YYYY-MM-DD` (required if `time` is "period")
- `status` (string) - Filter by status
- `id` (integer) - Filter by request ID (defaults to 0)

**Response:**
```json
{
    "data": {
        "0": {
            "id": 13237,
            "status": "declined",
            "amount": 100,
            "wallet": "TNom9cUc59YHXsMRPtmehcLkBmdYtag7mj",
            "created_at": "2025-12-23T09:21:19.000000Z"
        },
        "1": {
            "id": 13236,
            "status": "new",
            "amount": 100,
            "wallet": "TXU2FAY2RSdJRrbgp9C4Xjb62cRDTLLT4o",
            "created_at": "2025-12-23T09:20:29.000000Z",
            "qr": "https://adscard.net/qr/payment/TRC_63.png"
        }
    },
    "request_id": "REQUEST_ID"
}
```

**Note:** Returns an object with numeric string keys (`"0"`, `"1"`, etc.). Each item has `id`, `status`, `amount`, `wallet`, `created_at` (ISO 8601). Field `qr` is present only when `status` is `"new"`. Possible statuses: `new`, `declined`, `accepted`.

#### `POST /v3/balance/trc_cancel`
Cancel TRC top-up

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "id": 1
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `id` (integer) - Request ID to cancel (defaults to 0)

**Response:**
```json
{
    "data": {
        "time": 1234567890,
        "amount": 100.50,
        "wallet": "TRON_WALLET_ADDRESS",
        "qr": "QR_CODE_STRING",
        "status": "cancelled",
        "created_at": "2023-01-01 12:00:00"
    },
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/balance/wire_topup`
Top up balance via Wire transfer

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "amount": 1000.00,
    "company_name": "COMPANY_NAME",
    "registration_number": "REG_NUMBER",
    "geo": "ADDRESS",
    "person": "SIGNATORY",
    "bank": "BANK_NAME",
    "url": "https://example.com",
    "bank_address": "BANK_ADDRESS",
    "comment": "COMMENT"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `amount` (numeric) - Top-up amount

**Optional Parameters:**
- `company_name` (string) - Company name (defaults to empty string)
- `registration_number` (string) - Registration number (defaults to empty string)
- `geo` (string) - Address (defaults to empty string)
- `person` (string) - Signatory person (defaults to empty string)
- `bank` (string) - Bank name (defaults to empty string)
- `url` (string) - URL (defaults to empty string)
- `bank_address` (string) - Bank address (defaults to empty string)
- `comment` (string) - Comment (defaults to empty string)

**Response:**
```json
{
    "data": {
        "id": 1,
        "status": "pending",
        "created_at": "2023-01-01 12:00:00",
        "amount": 1000.00,
        "company_name": "COMPANY_NAME",
        "registration_number": "REG_NUMBER",
        "geo": "ADDRESS",
        "person": "SIGNATORY",
        "bank": "BANK_NAME",
        "url": "https://example.com",
        "bank_address": "BANK_ADDRESS"
    },
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/balance/wire_list`
Get list of Wire transfers

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "time": "TIME",
    "period": "PERIOD",
    "status": "STATUS",
    "id": 1
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `time` (string) - Time period filter
- `period` (string) - Custom period in format `YYYY-MM-DD|YYYY-MM-DD` (required if `time` is "period")
- `status` (string) - Filter by status
- `id` (integer) - Filter by request ID (defaults to 0)

**Response:**
```json
{
    "data": {
        "0": {
            "id": 1,
            "status": "accepted",
            "created_at": "2023-01-01 12:00:00",
            "amount": 1000.00,
            "company_name": "COMPANY_NAME",
            "registration_number": "REG_NUMBER",
            "geo": "ADDRESS",
            "person": "SIGNATORY",
            "bank": "BANK_NAME",
            "url": "https://example.com",
            "bank_address": "BANK_ADDRESS"
        }
    },
    "request_id": "REQUEST_ID"
}
```

#### `POST /v3/balance/wire_cancel`
Cancel Wire transfer

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "id": 1
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `id` (integer) - Request ID to cancel (defaults to 0)

**Response:**
```json
{
    "data": {
        "id": 1,
        "status": "cancelled",
        "created_at": "2023-01-01 12:00:00",
        "amount": 1000.00,
        "company_name": "COMPANY_NAME",
        "registration_number": "REG_NUMBER",
        "geo": "ADDRESS",
        "person": "SIGNATORY",
        "bank": "BANK_NAME",
        "url": "https://example.com",
        "bank_address": "BANK_ADDRESS"
    },
    "request_id": "REQUEST_ID"
}
```

---

### Teams

#### `POST /v3/teams/users`
Get team users list

**Request Body:**
```json
{
    "auth_token": "TOKEN"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Response:**
If team has a name (single team object):
```json
{
    "data": {
        "name": "TEAM_NAME",
        "id": 1,
        "email": "team@example.com",
        "telegram": "TELEGRAM",
        "locked": false,
        "created_at": "2023-01-01 12:00:00",
        "withdrawal_enabled": true,
        "cardspay_enabled": true,
        "balances": {},
        "policy": {}
    },
    "request_id": "REQUEST_ID"
}
```

If multiple users (array):
```json
{
    "data": [
        {
            "id": 1,
            "name": "USER_NAME",
            "email": "user@example.com",
            "telegram": "TELEGRAM",
            "locked": false,
            "created_at": "2023-01-01 12:00:00",
            "withdrawal_enabled": true,
            "cardspay_enabled": true,
            "balances": {},
            "policy": {}
        }
    ],
    "request_id": "REQUEST_ID"
}
```


#### `POST /v3/teams/invite`
Invite user to team

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "email": "user@example.com"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `email` (string) - Email address of user to invite

**Response:**
```json
{
    "data": {},
    "request_id": "REQUEST_ID"
}
```


#### `POST /v3/teams/invites_decline`
Decline team invite

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "id": 1
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `id` (integer) - Invite ID to decline

**Response:**
```json
{
    "data": {},
    "request_id": "REQUEST_ID"
}
```


#### `POST /v3/teams/block_user`
Block user in team

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "id": 1
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `id` (integer) - User ID to block

**Response:**
```json
{
    "data": {},
    "request_id": "REQUEST_ID"
}
```


#### `POST /v3/teams/balance_user`
Get user balance in team

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "user_id": 1
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `user_id` (integer) - Team user ID

**Response:**
```json
{
    "data": {
        "usd": 100.50,
        "rub": 5000.00,
        "eur": 50.25
    },
    "request_id": "REQUEST_ID"
}
```

. Has rate limiting (throttle: 2 requests per 1 minute)

#### `POST /v3/teams/policy`
Manage team policy

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "user": 1,
    "users": [1, 2, 3],
    "type": "withdrawal|cardspay"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `user` (integer) - Single user ID
- `users` (array) - Array of user IDs
- `type` (string) - Policy type: `withdrawal` or `cardspay`

**Response:**
```json
{
    "data": {},
    "request_id": "REQUEST_ID"
}
```


#### `POST /v3/teams/cards_issue_info`
Get cards issue info for team

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "user_id": 1
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `user_id` (integer) - Team user ID (used internally to determine team user context)

**Response:**
```json
{
    "data": {
        "count": 10,
        "info": {
            "id": "BIN_ID",
            "bin": "BIN_NUMBER",
            "tr": "TR_FEE",
            "currency": "USD",
            "security": "3DS",
            "description_ru": "DESCRIPTION_RU",
            "description_en": "DESCRIPTION_EN",
            "fee": 5.0,
            "purchase": 100.0,
            "decline": 2.0,
            "region": "REGION"
        }
    },
    "request_id": "REQUEST_ID"
}
```


#### `POST /v3/teams/cards_team_card_purchase`
Purchase team card

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "count": 1,
    "bin": 1,
    "email": "email@example.com",
    "user_id": 1,
    "id": 1
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `count` (integer) - Number of cards to purchase
- `bin` (integer) - BIN ID

**Optional Parameters:**
- `email` (string) - Email address (nullable)
- `user_id` (integer) - Team user ID
- `id` (integer) - Optional ID

**Response:**
```json
{
    "data": {
        "CARD_OBJECT"
    },
    "request_id": "REQUEST_ID"
}
```


#### `POST /v3/teams/cards_list`
List team cards

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "user_id": 1,
    "status": "A"
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `user_id` (integer) - Team user ID (defaults to 0)
- `status` (string) - Card status filter (default: "A" for active)

**Response:**
```json
{
    "data": [
        {
            "id": "ID",
            "number": "CARD_NUMBER",
            "date_expired": "2025-12-31",
            "date_issued": "2023-01-01",
            "status": "A",
            "currency": "usd",
            "cvc": "123",
            "comment": "COMMENT",
            "expense": 1000.50,
            "balance": 500.25,
            "limit": 2000.00,
            "group": 1,
            "payment_info": {
                "address": "ADDRESS",
                "pass": "PASS",
                "card_holder": "CARD_HOLDER",
                "region": "REGION"
            }
        }
    ],
    "request_id": "REQUEST_ID"
}
```


#### `POST /v3/teams/cards_block`
Block team card

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "cards_id": [1, 2, 3],
    "user_id": 1
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token

**Optional Parameters:**
- `cards_id` (array) - Array of card IDs to block
- `user_id` (integer) - Team user ID (for team context)

**Response:**
```json
{
    "data": true,
    "request_id": "REQUEST_ID"
}
```


#### `POST /v3/teams/cards_transactions`
Get team card transactions

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "time": "TIME",
    "period": "PERIOD",
    "user_id": 1
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `time` (string) - Time period filter

**Optional Parameters:**
- `period` (string) - Custom period in format `YYYY-MM-DD|YYYY-MM-DD` (required if `time` is "period")
- `user_id` (integer) - Team user ID (defaults to 0)

**Response:**
```json
{
    "data": [
        {
            "id": "TRANSACTION_ID",
            "card_number": "CARD_NUMBER",
            "amount": 100.50,
            "fee": 2.50,
            "date": "2023-01-01 12:00:00",
            "merchant": "MERCHANT_NAME",
            "status": "STATUS",
            "currency": "USD",
            "group_id": 1,
            "bank_commission": [
                {
                    "name": "VALUE"
                }
            ]
        }
    ],
    "request_id": "REQUEST_ID"
}
```


#### `POST /v3/teams/cards_statement`
Get team card statement

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "time": "TIME",
    "period": "PERIOD",
    "user_id": 1
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `time` (string) - Time period filter

**Optional Parameters:**
- `period` (string) - Custom period in format `YYYY-MM-DD|YYYY-MM-DD` (required if `time` is "period")
- `user_id` (integer) - Team user ID (defaults to 0)

**Response:**
```json
{
    "data": {
        "2023-01-01": {
            "fee": 10.5,
            "withdrawal": 100.0,
            "replenishment": 200.0,
            "issued": 5,
            "failed": 2,
            "pending": 1
        }
    },
    "request_id": "REQUEST_ID"
}
```


#### `POST /v3/teams/cards_move`
Move team card to another user

**Request Body:**
```json
{
    "auth_token": "TOKEN",
    "id": 1,
    "user_id": 2
}
```

**Required Parameters:**
- `auth_token` (string) - Authentication token
- `card_id` (integer) - ID of card to move
- `user_id` (integer) - ID of user to move card to

**Response:**
```json
{
    "data": {},
    "request_id": "REQUEST_ID"
}
```


---

## Summary

**Total Routes Defined:** 59

### Routes by Group:
- **Auth:** 1 route ✅
- **Users:** 1 route ✅
- **Cards:** 19 routes ✅
- **Cards Pay:** 15 routes ✅
- **Withdrawals:** 4 routes ✅
- **Balance:** 6 routes ✅
- **Teams:** 13 routes ✅

---

## Notes

- All routes use POST method
- Request body must be JSON format
- All routes (except `/v3/auth/login`) require `auth_token` in the request body
- All responses include `request_id` in the response body
- Routes are case-sensitive
- For routes with time filtering, use the `time` parameter with optional `period` for custom date ranges
- Missing required parameters will return `{"error": "bad_request"}` with HTTP 400 status code
