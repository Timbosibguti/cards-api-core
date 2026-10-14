/**
 * MQTT handlers: загрузка обработчиков по структуре каталогов и подписка на топики при старте.
 * См. architecture/mqtt_handlers.md.
 */

import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { MqttClient } from '../infra/MqttClient.js';
import type { AppConfig } from '../config/index.js';
import { logger } from '../infra/logger.js';

export type MqttMessageHandler = (topic: string, payload: Buffer) => void | Promise<void>;

const HANDLER_ENTRIES = ['index.js', 'index.ts'] as const;

function resolveHandlerPath(dir: string): string | null {
  for (const name of HANDLER_ENTRIES) {
    const p = path.join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Рекурсивно находит все каталоги с index.js/index.ts под baseDir и возвращает пары (topic, путь к модулю).
 * topic = относительный путь от baseDir до каталога с разделителем `/`.
 */
function discoverHandlers(baseDir: string): Array<{ topic: string; modulePath: string }> {
  const results: Array<{ topic: string; modulePath: string }> = [];

  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const indexPath = resolveHandlerPath(fullPath);
        if (indexPath) {
          const topic = path.relative(baseDir, fullPath).split(path.sep).join('/');
          results.push({ topic, modulePath: indexPath });
        }
        walk(fullPath);
      }
    }
  }

  const entries = readdirSync(baseDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const subDir = path.join(baseDir, ent.name);
    const indexPath = resolveHandlerPath(subDir);
    if (indexPath) {
      const topic = path.relative(baseDir, subDir).split(path.sep).join('/');
      results.push({ topic, modulePath: indexPath });
    }
    walk(subDir);
  }

  return results;
}

/**
 * Загружает обработчики из каталога, зеркалирующего топики (относительно текущего модуля).
 * Возвращает Map: нормализованный топик → обработчик.
 */
export async function loadHandlers(): Promise<Map<string, MqttMessageHandler>> {
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  const discovered = discoverHandlers(baseDir);
  const map = new Map<string, MqttMessageHandler>();

  for (const { topic, modulePath } of discovered) {
    try {
      const url = pathToFileURL(modulePath).href;
      const mod = await import(url);
      const handler = mod?.default;
      if (typeof handler !== 'function') {
        logger.warn(`[HUB_MQTT] MQTT handler for topic "${topic}" did not export a default function`, {
          modulePath,
        });
        continue;
      }
      map.set(topic, handler);
      logger.debug(`[HUB_MQTT] MQTT handler registered for topic: ${topic}`);
    } catch (err) {
      logger.error(`[HUB_MQTT] Failed to load MQTT handler for topic "${topic}"`, err as Error);
    }
  }

  return map;
}

/**
 * Подключается к MQTT, подписывается на все загруженные топики (с учётом topicPrefix)
 * и регистрирует обёртки, передающие в обработчик нормализованный топик и payload.
 */
export async function subscribeAll(mqtt: MqttClient, config: AppConfig): Promise<void> {
  await mqtt.connect();
  const prefix = config.mqtt.topicPrefix ?? '';
  const handlers = await loadHandlers();

  for (const [topic, handler] of handlers) {
    // OTP обрабатывается только через outgoing_notifications (воркер вызывает handler напрямую).
    // Подписка на sequoia/otp отключена, чтобы не зависеть от доставки MQTT.
    if (topic === 'sequoia/otp') {
      logger.info(`[HUB_MQTT] Skipping MQTT subscribe for ${topic} (handled by OutgoingNotificationsWorker)`);
      continue;
    }
    const fullTopic = prefix ? `${prefix.replace(/\/$/, '')}/${topic}` : topic;
    const wrapper = async (receivedTopic: string, payload: Buffer): Promise<void> => {
      const normalizedTopic = prefix && receivedTopic.startsWith(prefix)
        ? receivedTopic.slice(prefix.length).replace(/^\//, '')
        : receivedTopic;
      await handler(normalizedTopic, payload);
    };
    await mqtt.subscribe(fullTopic, wrapper);
    logger.info(`[HUB_MQTT] Subscribed to MQTT topic: ${fullTopic}`);
  }
}
