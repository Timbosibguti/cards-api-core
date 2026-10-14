/**
 * Farm DB: канонические запросы к farm_ext (tbl_profiles, tbl_users, tbl_profile_access_grant).
 *
 * Важно: «текущий пользователь» профиля определяется только запросом getCurrentUserByProfileName.
 * JWT от OpenID (Taurus, farm-extension) содержит profile_id/profile_name, но не email — email
 * всегда вычисляется из Farm DB в момент запроса. tbl_profiles.auth_id актуален только для баера;
 * при нахождении профиля у фарма владелец задаётся tbl_profile_access_grant (lock_exclusive).
 * См. architecture/profile_current_user.md.
 */

import type { PoolClient } from 'pg';

export type ProfileType = 'farm' | 'buyer' | 'free';

export interface CurrentUserByProfile {
  name: string;
  email: string | null;
  profile_type: ProfileType;
}

/**
 * Канонический запрос: кто сейчас работает с профилем {profile_name}.
 * Возвращает email и тип (farm/buyer). Если есть эксклюзивный грант фарма — текущий пользователь
 * фармер (auth_id из tbl_profile_access_grant); иначе — баер (tbl_profiles.auth_id).
 */
export async function getCurrentUserByProfileName(
  farmClient: PoolClient,
  profileName: string,
): Promise<CurrentUserByProfile | null> {
  const result = await farmClient.query<{
    name: string;
    email: string | null;
    profile_type: 'farm' | 'buyer' | 'free';
    last_farmer: string | null;
  }>(
    `SELECT p.name, tu.email,
       CASE
         WHEN tgrant.farm_auth_id IS NOT NULL THEN 'farm'::text
         WHEN p.auth_id  IS NOT NULL THEN 'buyer'::text
         ELSE 'free'::text
       END AS profile_type,
       tgrant_last.last_farm_auth_id  as last_farmer
     FROM tbl_profiles p
     LEFT JOIN LATERAL (
       SELECT DISTINCT tpg.auth_id AS farm_auth_id
       FROM tbl_profile_access_grant tpg
       WHERE tpg.profile_id = p.id AND tpg.lock_exclusive = true
       LIMIT 1
     ) tgrant ON true
     LEFT JOIN LATERAL (
       SELECT tpg.auth_id AS last_farm_auth_id
       FROM tbl_profile_access_grant tpg
       WHERE tpg.profile_id = p.id order by tpg.created_at DESC
       LIMIT 1
     ) tgrant_last ON true
     LEFT JOIN tbl_users tu ON (tu.auth_id = COALESCE(tgrant.farm_auth_id, p.auth_id, tgrant_last.last_farm_auth_id))
     WHERE p.name = $1`,
    [profileName.trim()],
  );
  const row = result.rows[0];
  // logger.warn('[getCurrentUserByProfileName] profileName: ' + profileName + ', result: ' + JSON.stringify(result));
  if (!row) return null;
  return {
    name: row.name,
    email: row.email ?? null,
    profile_type: row.profile_type as ProfileType,
  };
}

/**
 * Разрешить profile_id → profile_name по Farm DB (для вызовов, где есть только profile_id).
 */
export async function getProfileNameById(
  farmClient: PoolClient,
  profileId: string,
): Promise<string | null> {
  const result = await farmClient.query<{ name: string }>(
    `SELECT name FROM tbl_profiles WHERE id = $1 LIMIT 1`,
    [profileId.trim()],
  );
  return result.rows[0]?.name ?? null;
}

/**
 * Email по auth_id из tbl_users (Farm DB).
 * Используется там, где контекст уже однозначен: например new_auth_id при передаче профиля баеру
 * (tbl_profiles.auth_id в этот момент уже установлен в auth_id баера).
 */
export async function getEmailByAuthId(
  farmClient: PoolClient,
  authId: string | null,
): Promise<string | null> {
  if (!authId) return null;
  const result = await farmClient.query<{ email: string }>(
    `SELECT email FROM tbl_users WHERE auth_id = $1 LIMIT 1`,
    [authId],
  );
  return result.rows[0]?.email ?? null;
}

/**
 * Taurus / интеграции: только profile_name → владелец профиля в смысле tbl_profiles.auth_id → email баера.
 * Не учитывает lock_exclusive у фарма (в отличие от getCurrentUserByProfileName).
 */
export async function resolveBuyerEmailByProfileName(
  farmClient: PoolClient,
  profileName: string,
): Promise<{ profileExists: boolean; authId: string | null; buyerEmail: string | null }> {
  const result = await farmClient.query<{ auth_id: string | null }>(
    `SELECT auth_id FROM tbl_profiles WHERE name = $1 LIMIT 1`,
    [profileName.trim()],
  );
  const row = result.rows[0];
  if (!row) return { profileExists: false, authId: null, buyerEmail: null };
  const authId = row.auth_id;
  if (!authId) return { profileExists: true, authId: null, buyerEmail: null };
  const buyerEmail = await getEmailByAuthId(farmClient, authId);
  return { profileExists: true, authId, buyerEmail };
}
