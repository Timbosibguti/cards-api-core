/**
 * Шифрование/дешифрование login и password для bank_accounts.
 * Совместимость с mqtt_otp_transactions_service (AES-256-GCM, scrypt, ENCRYPTED_PREFIX).
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { getConfig } from '../config/index.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ENCRYPTED_PREFIX = 'ENC:';

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LENGTH);
}

export function encryptCredentials(text: string | null): string | null {
  if (!text) return null;
  const key = getConfig().queueApi.encryptionKey;
  if (!key) return text;
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const derived = deriveKey(key, salt);
  const cipher = createCipheriv(ALGORITHM, derived, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENCRYPTED_PREFIX + Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

export function decryptCredentials(encryptedText: string | null): string | null {
  if (!encryptedText) return null;
  if (!encryptedText.startsWith(ENCRYPTED_PREFIX)) return encryptedText;
  const key = getConfig().queueApi.encryptionKey;
  if (!key) return null;
  const combined = Buffer.from(encryptedText.slice(ENCRYPTED_PREFIX.length), 'base64');
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const encrypted = combined.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const derived = deriveKey(key, salt);
  const decipher = createDecipheriv(ALGORITHM, derived, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
