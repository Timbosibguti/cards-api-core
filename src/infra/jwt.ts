/**
 * Извлечение email из JWT в заголовке Authorization (Bearer <token>).
 * Совместимость с mqtt_otp_transactions_service: только decode, без верификации.
 */

function base64UrlDecode(str: string): string {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
  return Buffer.from(padded, 'base64').toString('utf8');
}

/**
 * Возвращает email из payload JWT или null при отсутствии/невалидном токене.
 */
export function getEmailFromAuthHeader(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]!)) as Record<string, unknown>;
    const email = payload?.email;
    return typeof email === 'string' ? email : null;
  } catch {
    return null;
  }
}
