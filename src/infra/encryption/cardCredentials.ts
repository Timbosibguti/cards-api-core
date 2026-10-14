import crypto from 'crypto';
import { getConfig } from '../../config/index.js';
import { logger } from '../logger.js';

export interface CardCredentials {
  cardNumber: string;
  cardCvv: string;
  cardExpire: string;
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const ITERATIONS = 100_000;

const FALLBACK_KEY = 'default-encryption-key-change-in-production-32-chars!!';

function getEncryptionKey(): string {
  const key = process.env.CARD_CREDS_ENCRYPTION_KEY || FALLBACK_KEY;
  if (key.length < 32) {
    logger.warn('CARD_CREDS_ENCRYPTION_KEY is too short, using default; please set a strong key in production.');
  }
  return key;
}

/** Ключ для расшифровки (совместимость с mqtt_ecards: ENCRYPTION_KEY / queueApi.encryptionKey). */
function getDecryptionKey(): string {
  const config = getConfig();
  const fromQueue = config.queueApi.encryptionKey;
  if (fromQueue && fromQueue.length >= 32) return fromQueue;
  const fromEnv = process.env.ENCRYPTION_KEY;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  return getEncryptionKey();
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha512');
}

export function encryptCardCredentials(credentials: CardCredentials): string {
  try {
    const password = getEncryptionKey();
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = deriveKey(password, salt);
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const data = JSON.stringify(credentials);
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const tag = cipher.getAuthTag();

    const combined = Buffer.concat([
      salt,
      iv,
      tag,
      Buffer.from(encrypted, 'hex'),
    ]);

    return combined.toString('base64');
  } catch (error) {
    logger.error('Failed to encrypt card credentials', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error('Card credentials encryption failed', { cause: error });
  }
}

/**
 * Decrypt card credentials (совместимость с mqtt_ecards_transactions EncryptionService).
 * Формат: base64(salt 64 + iv 16 + tag 16 + encrypted hex).
 * Пробует ENCRYPTION_KEY / queueApi.encryptionKey, затем CARD_CREDS_ENCRYPTION_KEY / fallback.
 */
export function decryptCardCredentials(encryptedData: string): CardCredentials {
  if (!encryptedData) {
    throw new Error('No encrypted data provided');
  }
  const combined = Buffer.from(encryptedData, 'base64');
  const minLength = SALT_LENGTH + IV_LENGTH + TAG_LENGTH + 1;
  if (combined.length < minLength) {
    throw new Error('Invalid encrypted data: too short');
  }
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = combined.subarray(
    SALT_LENGTH + IV_LENGTH,
    SALT_LENGTH + IV_LENGTH + TAG_LENGTH,
  );
  const encrypted = combined.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

  const tryDecrypt = (password: string): CardCredentials => {
    const key = deriveKey(password, salt);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8');
    const parsed = JSON.parse(decrypted) as CardCredentials;
    if (typeof parsed.cardNumber !== 'string' || typeof parsed.cardCvv !== 'string' || typeof parsed.cardExpire !== 'string') {
      throw new Error('Invalid decrypted data format');
    }
    return parsed;
  };

  const primaryKey = getDecryptionKey();
  try {
    return tryDecrypt(primaryKey);
  } catch {
    if (primaryKey !== FALLBACK_KEY) {
      try {
        return tryDecrypt(FALLBACK_KEY);
      } catch {
        logger.debug('Card credentials decryption failed (wrong key or format)');
      }
    }
    throw new Error('Invalid decrypted data format');
  }
}

