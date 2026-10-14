/**
 * Проверка доступа к API карт (farm-отдел + cards_access).
 * Текущий пользователь профиля определяется только через Farm DB (getCurrentUserByProfileName),
 * т.к. JWT от OpenID не содержит email. См. architecture/profile_current_user.md.
 */

import { getConfig } from '../config/index.js';
import { getDatabaseService } from './index.js';
import * as cardsDb from './cardsDb.js';
import * as farmDb from './farmDb.js';
import { logger } from './logger.js';

const ROMAN_TEST_PROFILE_ID = 'ba05528e977a4e5db86aa0ffa4163203';
const EMAIL_ACCESS_BYPASS = new Set([
  'fskudratov@groscloud.com',
  'kvtafintseva@groscloud.com',
  'uabulygina@groscloud.com',
  'eskrstevski@groscloud.com',
]);

export interface FarmAccessOptions {
  profileId: string;
  /** Если не передан, разрешается по Farm DB (getProfileNameById). */
  profileName?: string | null;
}

export async function requireFarmAccess(
  profileIdOrOptions: string | FarmAccessOptions,
): Promise<{ email: string | null; jobTitle: string }> {
  const profileId =
    typeof profileIdOrOptions === 'string' ? profileIdOrOptions : profileIdOrOptions.profileId;
  const profileNameHint =
    typeof profileIdOrOptions === 'string' ? undefined : profileIdOrOptions.profileName;

  const config = getConfig();
  const db = getDatabaseService(config);

  let profile_name: string;
  let currentUser: farmDb.CurrentUserByProfile | null;

  const farmClient = await db.getClient('farm');
  try {
    // Если нам уже передали profile_name (как на большинстве карточных роутов),
    // используем его напрямую и не лезем в Farm DB за именем по id.
    // В Farm DB в этом случае ходим только за currentUser.
    if (profileNameHint && profileNameHint.trim() !== '') {
      profile_name = profileNameHint.trim();
    } else {
      // Иначе разрешаем profile_id → profile_name по Farm DB.
      profile_name = (await farmDb.getProfileNameById(farmClient, profileId)) || '';
    }
    if (!profile_name) {
      logger.warn('requireFarmAccess: profile not found in Farm DB', { profileId });
      throw new Error('farm_profile_not_found');
    }
    currentUser = await farmDb.getCurrentUserByProfileName(farmClient, profile_name);
  } finally {
    farmClient.release();
  }

  if (!currentUser) {
    logger.warn('requireFarmAccess: no current user for profile', { profileId, profile_name });
    throw new Error('farm_profile_not_found');
  }

  const email = currentUser.email;
  if (!email) {
    logger.warn('requireFarmAccess: current user has no email', { profileId, profile_name });
    throw new Error('farm_profile_not_found');
  }

  if (EMAIL_ACCESS_BYPASS.has(email.toLowerCase())) {
    return { email, jobTitle: 'farm' };
  }

  if (profileId !== ROMAN_TEST_PROFILE_ID && currentUser.profile_type !== 'farm') {
    logger.warn('Access denied: profile is not in farm stage', {
      profileId,
      profile_name,
      profile_type: currentUser.profile_type,
    });
    throw new Error('not_farm');
  }

  const mainClient = await db.getClient('main');
  try {
    const hasAccess = await cardsDb.checkCardAccess(mainClient, email);
    if (!hasAccess) {
      logger.warn('Access denied: user email not in cards_access', { profileId, email });
      throw new Error('cards_access_denied');
    }
    return {
      email,
      jobTitle: currentUser.profile_type === 'farm' ? 'farm' : 'buyer',
    };
  } finally {
    mainClient.release();
  }
}

export function mapAccessError(error: unknown): { status: number; message: string } {
  const code = error instanceof Error ? error.message : String(error);
  switch (code) {
    case 'not_farm':
      return {
        status: 403,
        message: 'Ошибка профиля: профиль не взят в работу (статус не FARM). Проверьте профиль в Retool.',
      };
    case 'cards_access_denied':
      return {
        status: 403,
        message: 'Доступ к картам запрещен: текущий пользователь отсутствует в cards_access.',
      };
    case 'farm_profile_not_found':
      return {
        status: 404,
        message: 'Ошибка профиля: профиль не найден или нет current user в Farm DB. Возможно профиль не взят в работу.',
      };
    case 'sync_fibery_failed':
      return { status: 502, message: 'Ошибка синхронизации: не удалось получить роль пользователя (sync-fibery).' };
    case 'sync_fibery_invalid':
      return { status: 502, message: 'Ошибка синхронизации: получен некорректный ответ по роли пользователя (sync-fibery).' };
    default:
      return { status: 500, message: 'Ошибка проверки доступа к профилю. Проверьте логи сервиса.' };
  }
}
