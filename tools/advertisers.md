# Партнеры (`advertisers`)

Краткое описание текущего функционала по партнерам, транзакциям и аудиту.

## Основные таблицы

### `public.advertisers`

Справочник партнеров.

- `id` — UUID партнера.
- `name` — название партнера.
- `current_balance` — текущий рассчитанный баланс партнера.
- `campaign_uuids` — список кампаний, привязанных к партнеру.
- `deleted_at` — мягкое удаление партнера.

### `public.advertisers_transactions`

Журнал транзакций партнера.

- `id` — UUID транзакции.
- `created_at` — время транзакции.
- `amount` — исходная сумма транзакции.
- `cut_amount` — срез по транзакции.
- `balance_before` — баланс до применения транзакции.
- `balance_after` — баланс после применения транзакции.
- `campaign_uuid` — связанная кампания, если есть.
- `advertiser_uuid` — партнер-владелец транзакции.
- `advertiser_transaction_type` — тип транзакции.
- `lead_status` — статус лида, только для транзакций типа `2` (`NULL`, `Approved`, `Rejected`).
- `user_email` — пользователь, от которого пришло действие.
- `comment` — комментарий.
- `deleted_at` — мягкое удаление транзакции.

Фактическая сумма, влияющая на баланс:

`effective_amount = amount - coalesce(cut_amount, 0)`

### `public.advertisers_transactions_types`

Справочник типов транзакций.

| id | Название | Логика |
|---|---|---|
| `1` | Пополнение | Увеличивает баланс на `effective_amount` |
| `2` | Оплата лида | Уменьшает баланс на `effective_amount` |
| `3` | Корректировка | Устанавливает баланс равным `effective_amount` |

Для типа `2` дополнительно может использоваться `lead_status`:

- `NULL` — статус не задан;
- `Approved` — лид подтвержден;
- `Rejected` — лид отклонен.

## Функции

### `public.addadvertisertransaction(...)`

Создает новую транзакцию партнера.

Что делает:

- проверяет `cut_amount >= 0` и `cut_amount <= amount`;
- лочит строку партнера;
- создает транзакцию;
- если передан `transaction_id`, работает идемпотентно через `ON CONFLICT (id) DO NOTHING`;
- пересчитывает баланс партнера через `recalc_advertiser_transactions_from(...)`;
- пишет событие в `audit`.

Особенности:

- если партнер не найден, функция не падает, а пишет ошибку в `audit` и возвращает `NULL`;
- если `transaction_id` уже существует и параметры совпадают, возвращает существующий `id`;
- если `transaction_id` уже существует и параметры отличаются, пишет ошибку в `audit` и возвращает существующий `id`.

### `public.updateadvertisertransaction(...)`

Обновляет существующую транзакцию и пересчитывает баланс по следующим по дате транзакциям партнера

Что делает:

- лочит строку транзакции;
- запрещает менять `advertiser_uuid`;
- проверяет валидность `cut_amount`;
- обновляет только переданные поля через `COALESCE(...)`;
- пересчитывает баланс партнера начиная с минимальной из старой и новой даты транзакции;
- пишет событие в `audit`.

Типичный вызов для установки среза:

```sql
select public.updateadvertisertransaction(
  p_transaction_id => '...uuid...'::uuid,
  p_cut_amount => 10.50
);
```

### `public.deleteadvertisertransaction(...)`

Мягко удаляет транзакцию.

Что делает:

- лочит строку транзакции;
- если транзакция уже удалена, просто возвращает `id`;
- ставит `deleted_at = now()`;
- пересчитывает баланс партнера с момента удаленной транзакции;
- пишет событие в `audit`.

### `public.setadvertisertransactionleadstatus(...)`

Отдельно массово устанавливает или сбрасывает `lead_status` у группы транзакций.

Что делает:

- принимает массив `p_transaction_ids`;
- проверяет, что `p_lead_status` равен `NULL`, `Approved` или `Rejected`;
- лочит все выбранные транзакции;
- проверяет, что все переданные `id` существуют;
- запрещает работу с удаленными транзакциями;
- разрешает изменение только для транзакций типа `2` (`Оплата лида`);
- обновляет `lead_status` одним `UPDATE`;
- пишет одно bulk-событие в `audit`.

Функция не вызывает пересчет баланса, потому что `lead_status` не влияет на сумму транзакции и `current_balance`.

Типичный вызов:

```sql
select public.setadvertisertransactionleadstatus(
  p_transaction_ids => array[
    '...uuid1...'::uuid,
    '...uuid2...'::uuid
  ],
  p_lead_status => 'Approved',
  p_user_email => 'user@example.com'
);
```

### `public.trigger_addadvertisertransaction()`

Триггерная функция для автоматического создания транзакции по данным лида.

Что делает:

- берет `buyer` из `binom` по `affiliate_id`;
- ищет партнера по вхождению `NEW.advertiser_uuid` в `advertisers.campaign_uuids`;
- если партнер найден, вызывает `addadvertisertransaction(...)`:
  - `advertiser_transaction_type = 2` (`Оплата лида`);
  - `amount = NEW.payout`;
  - `transaction_id = NEW.uuid`;
  - `p_created_at = NEW.updated_at`;
  - `p_cut_amount = 0`.

Сама триггерная функция в `audit` ничего не пишет, но вызываемая `addadvertisertransaction(...)` пишет.

### `public.recalc_advertiser_transactions_from(...)`

Служебная функция пересчета баланса партнера.

Что делает:

- лочит строку партнера;
- находит баланс перед стартовой точкой;
- лочит и последовательно проходит все не удаленные транзакции партнера начиная с `(created_at, id)`;
- для каждой транзакции пересчитывает `balance_before` и `balance_after`;
- обновляет `advertisers.current_balance` последним рассчитанным значением.

Формула применения транзакции:

- тип `1` (`Пополнение`): `running_balance + effective_amount`
- тип `2` (`Оплата лида`): `running_balance - effective_amount`
- тип `3` (`Корректировка`): `effective_amount`

Функция пересчета сама по себе записей в `audit` не создает.

## Каталог событий `audit`

Ниже перечислены события, которые генерирует этот функционал.

### `advertiser_not_found`

Источник: `addadvertisertransaction(...)`

Когда возникает:

- при попытке создать транзакцию для несуществующего партнера.

Основные поля:

- `advertiser_uuid`
- `amount`
- `cut_amount`
- `transaction_type`
- `error`

### `advertiser_dup_trnotfound`

Источник: `addadvertisertransaction(...)`

Когда возникает:

- при конфликте по `transaction_id`, если ожидаемая существующая транзакция не была найдена повторным чтением.

Основные поля:

- `transaction_id`
- `error`

### `advertiser_dup_tr_mismatch`

Источник: `addadvertisertransaction(...)`

Когда возникает:

- если `transaction_id` уже существует, но входные параметры не совпадают с уже сохраненной транзакцией.

Основные поля:

- `transaction_id`
- `incoming_advertiser_uuid`
- `existing_advertiser_uuid`
- `incoming_amount`
- `existing_amount`
- `incoming_cut_amount`
- `existing_cut_amount`
- `incoming_transaction_type`
- `existing_transaction_type`
- `incoming_campaign_uuid`
- `existing_campaign_uuid`
- `error`

### `advertiser_dup_tr`

Источник: `addadvertisertransaction(...)`

Когда возникает:

- если `transaction_id` уже существует и входные параметры совпадают.

Основные поля:

- `transaction_id`
- `advertiser_uuid`
- `original_amount`
- `existing_amount`
- `original_cut_amount`
- `existing_cut_amount`
- `campaign_uuid`
- `existing_campaign_uuid`

### `advertiser_tr`

Источник: `addadvertisertransaction(...)`

Когда возникает:

- после успешного создания транзакции и пересчета баланса.

Основные поля:

- `transaction_id`
- `advertiser_uuid`
- `advertiser_name`
- `transaction_type_id`
- `amount`
- `cut_amount`
- `balance_before`
- `balance_after`
- `campaign_uuid`
- `user_email`

### `advertiser_tr_updated`

Источник: `updateadvertisertransaction(...)`

Когда возникает:

- после успешного обновления транзакции и пересчета баланса.

Основные поля:

- `transaction_id`
- `advertiser_uuid`
- `old_amount`
- `new_amount`
- `old_cut_amount`
- `new_cut_amount`
- `new_effective_amount`
- `old_transaction_type_id`
- `new_transaction_type_id`
- `old_campaign_uuid`
- `new_campaign_uuid`
- `old_created_at`
- `new_created_at`

### `advertiser_tr_deleted`

Источник: `deleteadvertisertransaction(...)`

Когда возникает:

- после мягкого удаления транзакции и пересчета баланса.

Основные поля:

- `transaction_id`
- `advertiser_uuid`
- `amount`
- `cut_amount`
- `transaction_type_id`
- `campaign_uuid`
- `created_at`
- `reason`

### `advertiser_tr_lead_status_updated_bulk`

Источник: `setadvertisertransactionleadstatus(...)`

Когда возникает:

- после успешного массового изменения `lead_status` у транзакций типа `2`.

Основные поля:

- `transaction_ids`
- `count`
- `new_lead_status`
- `advertiser_uuids`

## Итоговая логика

- баланс партнера хранится в `advertisers.current_balance`;
- значение баланса полностью зависит от последовательного пересчета транзакций;
- `cut_amount` уменьшает влияние транзакции на баланс, но не является отдельным типом транзакции;
- `lead_status` не влияет на баланс и используется только как дополнительный статус для транзакций типа `2`.
