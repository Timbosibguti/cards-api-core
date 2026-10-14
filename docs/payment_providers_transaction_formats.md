# Форматы транзакций платёжных систем и нормализация в Processor-Hub

Этот документ фиксирует примеры «сырых» транзакций из платёжных систем и то, какие поля считаются описанием операции (merchant / description). На их основе адаптеры будут строить нормализованный `TransactionEventPayload` (см. архитектуру, раздел 4.3 и Event Contract).

## Общий принцип

- Вебхуки и/или polling от платёжных систем принимают **сырой JSON** (или строку JSON), который приводится к соответствующему raw-типу (`EcardsRawTransaction`, `AdsCardsRawTransaction`, `MulticardsRawTransaction`, `StellarCardsRawTransaction`).
- Далее адаптер маппит сырые поля во внутреннюю нормализованную транзакцию (единый тип), где:
  - есть `bank` (`adscards`, `ecards`, `multicards`, `stellarcards`);
  - приведённые суммы и валюты;
  - нормализованный статус (`pending/processed/failed/...`);
  - строка описания операции (`merchant_description`) — см. ниже для каждого провайдера.

## Ecards

**Пример сырой транзакции:**

```json
"{\"id\": 4050846, \"card\": {\"id\": 451806, \"cardCvv\": \"masked\", \"currency\": \"usd\", \"cardExpire\": \"deleted\", \"cardNumber\": \"4288520220513032\", \"last3dsOtp\": null, \"paymentSystem\": \"visa\"}, \"type\": \"card_operation\", \"value\": \"1.37\", \"method\": \"sub\", \"account\": {\"name\": \"FARM БИН 428852\"}, \"createdAt\": \"2026-03-04T05:41:16.090Z\", \"merchantInfo\": \"GOOGLE *JWX 875188     g.co/helppay#  GB, GB , 7399\"}"
```

- **Описание транзакции (merchant):** поле `merchantInfo`.

## AdsCards (`mqtt_adscards_transactions`)

**Пример сырой транзакции:**

```json
"{\"data\": {\"card_group\": \"Aleksey Markeev / 38\", \"card_number\": \"2240 0205 6049 6121 \", \"card_currency\": \"usd\", \"transaction_sum\": \"2,00\", \"transaction_status\": \"failed\", \"transaction_recipient\": \"GOOGLE*JXE 150606 MOUNTAIN VIEW USA\"}, \"webhook_event\": \"transaction_add\"}"
```

- **Описание транзакции (merchant):** поле `data.transaction_recipient`.

## Multicards

**Пример сырой транзакции:**

```json
"{\"id\": 13810476, \"paid\": true, \"type\": \"PAYMENT\", \"user\": {\"lastName\": \"Gravs\", \"firstName\": \"Darya\"}, \"amount\": 1.34, \"cardId\": 518684, \"onHold\": false, \"status\": \"PENDING\", \"wallet\": \"dsgravs@groscloud.com\", \"cardNote\": \"\", \"cardType\": \"POSTPAID\", \"currency\": \"USD\", \"refunded\": false, \"createdAt\": \"2026-03-04T05:01:03.000Z\", \"issued_at\": \"2026-03-04T05:01:03.000Z\", \"recieptId\": \"24417732\", \"authAmount\": 1.34, \"cardNumber\": \"5***********9223\", \"description\": \"GOOGLE *ULY 961996\", \"authFixedFee\": 0.07, \"authModified\": false, \"transactionFee\": 0, \"transactionFixedFee\": 0.07}"
```

- **Описание транзакции (merchant):** поле `description`.

## StellarCards

**Пример сырой транзакции:**

```json
"{\"id\": 10255456, \"bin\": \"53602553\", \"amount\": 1, \"fx_fee\": 0, \"status\": \"pending\", \"user_id\": 5365, \"merchant\": \"GOOGLE *329 725326\", \"card_guid\": \"019c3a05-1e4b-7730-8ba7-5b3f6af3e15f\", \"card_name\": \"\", \"total_fee\": 0, \"amount_usd\": 1.34, \"decline_fee\": 0, \"account_guid\": \"019ac554-8c91-7ce1-928a-c3589a663347\", \"company_name\": \"Sequoia\", \"country_code\": \"GB\", \"country_name\": \"United Kingdom\", \"currency_code\": \"GBP\", \"card_last_four\": \"5402\", \"decline_reason\": \"\", \"user_last_name\": \"emets\", \"user_first_name\": \"Stanislav\", \"authorize_at_utc\": \"2026-03-04T08:05:27Z\", \"cross_border_fee\": 0, \"processed_at_utc\": null}"
```

- **Описание транзакции (merchant):** поле `merchant`.

## Знак amount / amount_usd

### Общие правила

- В `bank_transactions.amount`:
  - **расход (списание)** → **отрицательное** значение;
  - **возврат / пополнение** → **положительное** значение;
  - **отклонённые / неуспешные операции** → `0` (см. правила по провайдерам ниже).
- В `bank_transactions.amount_usd`:
  - всегда `amount * rate`, где:
    - `rate` берётся из `exchange` сначала по `currency` (строго по коду валюты), потом по `bank` (идентификатор провайдера: `ecards`/`adscards`/`multicards`/`stellarcards`);
    - для USD курс = `1`;
    - если курс не найден для не‑USD валюты → `amount_usd = NULL`;
  - знак `amount_usd` всегда совпадает со знаком `amount`.

### Ecards

Источники:

- `value`: сумма операции;
- `method`: вид операции (`add`/`sub` и т.п.).

Правила:

- `method = "sub"` → расход → `amount = -abs(value)`;
- `method = "add"` → пополнение / возврат → `amount = +abs(value)`;
- `amount_usd = amount * rate`.

### AdsCards

Источники:

- `data.transaction_sum` или `amount` — строка с возможными пробелами и запятой:
  - например: `"1 635.20"`, `"1 635,20"`, `"1635,20"`;
- `type` — тип операции, например: `pending`, `withdrawal`, `replenishment`, `failed`, `refund`, `reversed` и т.д.

Нормализация суммы:

- перед парсингом:
  - удалить пробелы: `replace(..., ' ', '')`;
  - заменить `,` на `.`: `replace(..., ',', '.')`;
  - привести к `numeric`.

Правила знака:

- `type IN ("failed", "declined")` → `amount = 0`;
- `type IN ("replenishment", "refund", "reversed", "reversal", "chargeback")` → `amount = +abs(sum)`;
- все остальные (`pending`, `withdrawal`, и т.д.) → расход → `amount = -abs(sum)`;
- `amount_usd = amount * rate`.

### Multicards

Источники:

- `amount` или `authAmount`;
- `status`: например `PENDING`, `APPROVED`, `DECLINED`, `REFUND`, `REFUNDED`, `REVERSED` и т.д.

Правила знака:

- `status IN ("DECLINED", "FAILED")` → `amount = 0`;
- `status IN ("REFUND", "REFUNDED", "REVERSED", "REVERSAL", "CHARGEBACK")` → `amount = +abs(sum)`;
- остальные статусы (`PENDING`, `APPROVED`, и т.п.) → расход → `amount = -abs(sum)`;
- `amount_usd = amount * rate`.

### StellarCards

Источники:

- `amount_usd` (если есть) или `amount`;
- `status`: например `pending`, `settled`, `declined`, `refund`, `reversed` и т.д.

Правила знака:

- `status IN ("declined", "failed")` → `amount = 0`;
- `status IN ("refund", "reversed", "reversal", "chargeback")` → `amount = +abs(sum)`;
- все остальные (`pending`, `settled`, …) → расход → `amount = -abs(sum)`;
- `amount_usd = amount * rate` (если провайдер уже отдаёт `amount_usd`, он используется как база для знака и конвертации).

## Использование в адаптерах

- При реализации адаптеров (`modules/transactions` и `modules/cards`) для каждого банка нужно:
  - распарсить сырой JSON вебхука/ответа polling в соответствующий raw-тип;
  - вытащить merchant/description из указанных выше полей;
  - построить нормализованный `TransactionEventPayload` и записать его в `incoming_transactions` (через воркер) и/или опубликовать в MQTT `sequoia/transaction` по Event Contract.

- Реализации адаптеров берутся из существующих проектов:
  - AdsCards: `c:\work\sequoia\mqtt_adscards_transactions`;
  - eCards: `c:\work\sequoia\mqtt_ecards_transactions`;
  - Multicards: `c:\work\sequoia\mqtt_multicards_transactions`;
  - StellarCards: `c:\work\sequoia\mqtt_stellarcards_transactions`;
и адаптируются под общий `PaymentHttpClient` и модели данных Processor-Hub.

