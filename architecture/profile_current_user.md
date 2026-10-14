# Текущий пользователь профиля (Farm DB)

В Farm DB по канону **все таблицы** называются с префикса **`tbl_`** (tbl_profiles, tbl_users, tbl_profile_access_grant, tbl_profile_auth_changes и т.д.). Код и миграции Processor-Hub соблюдают этот канон.

## Важность

**Кто сейчас работает с профилем** (фармер или баер) и **email этого пользователя** определяются **только** одним каноническим запросом к Farm DB. Запросы от Taurus и от farm-расширения приходят не напрямую, а через сервис Open ID; в JWT записаны `profile_id` и `profile_name`, **без указания email**. Поэтому email в этих запросах **всегда вычисляемый** и имеет смысл только **в текущий момент времени**.

- В `tbl_profiles.auth_id` хранится актуальный владелец **только для баера** (когда профиль передан баеру).
- Когда профиль находится у фарма или ещё у фарма (есть запись в `tbl_profile_access_grant` с `lock_exclusive = true`), текущий «владелец» — фармер, и его `auth_id` берётся из гранта, а не из `tbl_profiles.auth_id`.

Использование канонического запроса обязательно для:

- определения текущего пользователя при запросе/линковке/отвязке карт через farm-расширение;
- роутов от Taurus (в т.ч. `/draft`);
- любой логики, где нужен «кто сейчас работает с профилем» и его email.

---

## Канонический SQL

```sql
SELECT p.name, tu.email,
  CASE
    WHEN tgrant.farm_auth_id IS NOT NULL THEN 'farm'
    ELSE 'buyer'
  END AS profile_type
FROM farm_ext.tbl_profiles p
LEFT JOIN LATERAL (
  SELECT DISTINCT tpg.auth_id AS farm_auth_id
  FROM farm_ext.tbl_profile_access_grant tpg
  WHERE tpg.profile_id = p.id AND tpg.lock_exclusive = true
  LIMIT 1
) tgrant ON true
LEFT JOIN farm_ext.tbl_users tu ON (tu.auth_id = COALESCE(tgrant.farm_auth_id, p.auth_id))
WHERE p.name = $1  -- profile_name
```

- **profile_type = 'farm'** — есть эксклюзивный грант фарма; текущий пользователь — фармер (email из `tbl_users` по `tgrant.farm_auth_id`).
- **profile_type = 'buyer'** — гранта нет; текущий пользователь — баер (email из `tbl_users` по `p.auth_id`).

Реализация в коде: **`src/infra/farmDb.ts`** — функция **`getCurrentUserByProfileName(farmClient, profileName)`**. Дополнительно: **`getProfileNameById(farmClient, profileId)`** для разрешения `profile_id → profile_name`, когда в запросе есть только `profile_id`.

---

## Где используется

| Место | Назначение |
|-------|------------|
| **requireFarmAccess** (`src/infra/syncFibery.ts`) | Доступ к API карт: текущий пользователь и email определяются по Farm DB; проверка `profile_type === 'farm'` и `cards_access` по этому email. |
| **POST /draft** (Taurus) | `buyer_email` в `drafts` и в аудите задаётся через `getCurrentUserByProfileName(profileName)`. |
| **api/cards*** (get, get-by-bin, check, free-count, unlink) | Везде, где нужен доступ по профилю, вызывается `requireFarmAccess({ profileId, profileName })`, внутри — канонический запрос. |
| **processIncomingBatch** (`modules/transactions`) | При `GOOGLE*ADS##########` в карточной транзакции сначала находится `profile_name` через `public.google_account_logs`, затем email владельца определяется через `getCurrentUserByProfileName(profile_name)`. |
| **profileAuthChangeWorker / outboxHandlers** | Для события «профиль передан баеру» используется `getEmailByAuthId(new_auth_id)` — в этот момент `tbl_profiles.auth_id` уже установлен в auth_id баера, т.е. контекст однозначен. Для «текущего пользователя в произвольный момент» всегда используется `getCurrentUserByProfileName`. |

---

## Правило для разработки

- **JWT от OpenID** (Taurus, farm-extension): не доверять email из клиента; использовать только `profile_id` / `profile_name`.
- **Email и тип (farm/buyer)** для операций с профилем брать из Farm DB через **`getCurrentUserByProfileName`** (или через `requireFarmAccess`, который внутри это вызывает).
- **`getEmailByAuthId`** применять только там, где контекст уже задан (например, `new_auth_id` при передаче профиля баеру).
