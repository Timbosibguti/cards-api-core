# MR 29 — Unlink-dead: блокировка карты у провайдера перед отвязкой от мёртвого профиля

**Статус:** реализовано в `processor-hub`.  
**Связанный код:** `src/infra/unlinkDeadWorker.ts`, адаптеры `adapter.blockCard` (как в `src/modules/cardBlock/blockCard.ts`).

## Зачем

Раньше воркер **unlink-dead** только снимал привязку карты к мёртвому профилю в `bank_cards` (и `last_used_at`), без обязательной блокировки у платёжной системы. Карта могла снова попасть в фарм/к другому профилю, оставаясь активной у провайдера.

**Цель продукта:** при «смерти» профиля **сначала заблокировать карту у ПС**, затем зафиксировать это в БД и отвязать профиль.

## Что не входит в MR 29

- **`POST /api/cards/unlink`** (фарм, режим «отлёжки» с `released_at`) — **не менялся**.
- Отдельный сервис **mqtt_otp** и его cron unlink-dead — вне scope; в hub логика живёт в **processor-hub**.

## Поведение (текущая реализация)

### Карты с `is_bad = false` (основной случай)

1. Загружается строка карты, включая **`ext_id`** (для не-ecards нужен для вызова блокировки).
2. **Сначала** вызывается **`adapter.blockCard({ cardNumber, extId })`** (HTTP к провайдеру, **вне** длинной транзакции БД).
3. **При успехе:** короткая транзакция — `setCardOwnership` (снятие `profile_name` / `buyer`), **`is_bad = true`**, **`last_used_at`**, **`acc_no`** в формате `blocked at YYYY-MM-DD HH:MM:SS` (как в `blockCardByCardNumber`).
4. **Аудит:** `event_type: bank_card_blocked`, `source: 'unlink_dead'`, в атрибутах есть `blocked_at_provider: true` (и прочие поля как раньше).

### Если провайдер недоступен — строку `bank_cards` не меняем

- Ошибка логируется (`UnlinkDeadWorker: provider blockCard failed, leaving profile linked for retry on next run`).
- **Профиль остаётся привязанным к карте**; на следующем запуске воркера карта снова попадёт в выборку (профиль всё ещё «мёртвый» по Farm DB).
- **Аудит по этой карте в этом прогоне не шлём** (нет ложного `card_unlinked`).
- В сводке Slack и в `lastBatchCount` учитываются только карты, по которым реально выполнено действие (без «зависших» из‑за ПС).

### Карты с `is_bad = true` (отдельная ветка: Binom / передача баеру / иначе)

Логика **как до MR 29** (первая транзакция батча): Binom → `buyer`, Slack DM; иначе отвязка с `is_bad` и т.д. Блокировка у ПС в этой ветке **не добавлялась** в MR 29.

## Логи

- `UnlinkDeadWorker: provider blockCard starting` / `... succeeded` — вокруг вызова провайдера.
- Итог прогона: `processed_after_block_or_is_bad`, `block_skipped_pending_ps`.

## Конфигурация

Без изменений: `unlinkDead.defaultDays`, `stellarcardsDays`, `billingBins`, лимит батча, расписание (полночь локальное время).

## См. также

- [card_and_bank_flows.md](./card_and_bank_flows.md) — шаг 7 (unlink-dead).
- [architecture/processes.md](../architecture/processes.md) §2.7.
- [decisions_log.md](./decisions_log.md) — запись от 2026-04-06.
