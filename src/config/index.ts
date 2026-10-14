/**
 * Единая точка доступа к конфигурации приложения.
 * Все модули импортируют config отсюда; прямое чтение process.env запрещено.
 */

import { loadConfig, type AppConfig } from './env.js';

let cached: AppConfig | null = null;

/**
 * Возвращает конфиг (загружается при первом вызове).
 * Вызов loadConfig() выполняется в bootstrap (index.ts) до старта сервера и воркеров.
 */
export function getConfig(): AppConfig {
  if (cached === null) {
    cached = loadConfig();
  }
  return cached;
}

/**
 * Устанавливает конфиг извне (для тестов или явной инициализации при старте).
 */
export function setConfig(config: AppConfig): void {
  cached = config;
}

export type { AppConfig } from './env.js';
export type { DatabaseConfig, FarmDatabaseConfig, MqttConfig, SlackConfig, QueueApiConfig, UnlinkDeadConfig, ProcessingRuntimeConfig, DevSimulationConfig } from './env.js';
