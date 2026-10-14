# Processor-Hub — политика идемпотентности

Явное описание **business key**, **idempotency key**, **окна дедупликации** и **поведения при дубликате** для критичных операций.  
Источник: [processor_hub_recommendations_for_cursor.md](./processor_hub_recommendations_for_cursor.md) §5.

**Принцип:** дубликат — ожидаемое поведение в распределённой системе. Обрабатываем явно (no-op, return existing, audit `duplicate_ignored`), не считаем инцидентом.

---

## Уровни защиты

1. **Прикладной:** расчёт idempotency_key, проверка существующего факта, явная ветка duplicate.
2. **БД:** UNIQUE-индексы, `INSERT ... ON CONFLICT`, частичные индексы где нужно.

---

## Таблица по операциям

| Operation | Business key | Idempotency key / dedup | Window | Duplicate behavior |
|-----------|--------------|--------------------------|--------|--------------------|
| **Bank transaction ingest** | bank + ext_id | idempotency_key в incoming_transactions (из нормализатора) | Forever | ON CONFLICT (bank, ext_id) в bank_transactions; повторная обработка — no-op / same result |
| **Incoming transaction processing** | id записи incoming_transactions | SELECT FOR UPDATE SKIP LOCKED по id | До processed | Только один воркер обрабатывает запись; повторный приход — запись уже processed |
| **OTP (card) ingest** | bank + card/acc + otp + time_bucket | dedup_key в outgoing_notifications, напр. `otp:ecards:<card>:<otp>:<bucket>` | 5–15 min | Не создавать вторую нотификацию; ON CONFLICT DO NOTHING по dedup_key |
| **OTP (SMS) ingest** | phone + message hash + bucket | dedup по каналу/получателю + bucket | Short TTL | Игнорировать повтор; при необходимости audit duplicate_ignored |
| **Statement import job** | file hash / storage ref / explicit key | dedup_key или unique constraint по job key | 24h+ | Return existing job / job_already_exists |
| **Queue acquire** | bank + acc_no + actor | Request id + эксклюзивная блокировка слота (FOR UPDATE) | Request lifetime | Один победитель; второй — acquire_denied, аудит |
| **Queue release** | bank + acc_no + current owner | Проверка владельца перед release | — | No-op если уже не владелец; аудит |
| **Outgoing notification send** | channel + payload hash / dedup_key | dedup_key в outgoing_notifications | Short TTL | Не отправлять повторно; при повторной постановке — ON CONFLICT по dedup_key (если есть) или идемпотентная отправка |
| **Card ownership change** | card_number + момент времени | Одна активная запись в bank_cards_history (valid_to IS NULL) на карту | Forever | Закрыть текущий интервал + вставить новый в одной транзакции; частичный UNIQUE по (card_number) WHERE valid_to IS NULL |
| **Profile transfer (outbox)** | event id в outbox_events | Один раз обработана по id (status = processed) | Forever | Повторная доставка — запись уже processed; воркер не возьмёт |
| **Audit event** | event_type + subject + time_bucket / correlation | dedup_key в outgoing (audit) | Short | Один аудит-событие на ключ в окне; дубли не создают вторую запись при совпадении dedup_key |
| **Draft create/update** | Тип + business key (напр. taurus ref) | Ключ по типу и внешнему id | TTL draft | Upsert; duplicate — return existing / no-op |

---

## Где реализовано в коде

- **incoming_transactions:** idempotency_key при вставке; воркер FOR UPDATE SKIP LOCKED; bank_transactions ON CONFLICT (bank, ext_id).
- **outgoing_notifications:** dedup_key UNIQUE; при вставке ON CONFLICT (dedup_key) DO NOTHING где применимо.
- **bank_cards_history:** частичный уникальный индекс по (card_number) WHERE valid_to IS NULL; смена владения — закрыть текущий + вставить новый.
- **queue:** acquire с блокировкой; проверка владельца при release.
- **OTP:** dedup_key при постановке в outgoing (format в correlation/index.ts и в модулях otp).

---

## Аудит для duplicate/no-op

Рекомендуется явно фиксировать в аудите:

- `duplicate_ignored`
- `duplicate_linked`
- `job_already_exists`
- `acquire_denied`
- `release_noop`
- `no_matching_queue_found`
- `provider_callback_stale`
- `event_rejected_by_invariant`

Так система остаётся расследуемой при повторах и конфликтах.

См. также [module_boundaries.md](./module_boundaries.md), [state_machines.md](./state_machines.md).
