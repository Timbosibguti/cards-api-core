/**
 * Синглтон MQTT-клиента.
 * Единая точка подключения к брокеру, reconnect, подписки и публикация.
 * EPIC 6: при отключении публикации буферизуются и отправляются после reconnect.
 */

import mqtt, { type MqttClient as RawMqttClient, type IClientOptions, type IClientSubscribeOptions } from 'mqtt';
import type { AppConfig, MqttConfig } from '../config/index.js';
import { logger } from './logger.js';

const MAX_PUBLISH_BUFFER_SIZE = 10_000;

export interface MqttClient {
  /** Подключиться к брокеру (лениво при первом вызове publish/subscribe). */
  connect(): Promise<void>;
  /** Опубликовать сообщение в топик (при отключении буферизуется). */
  publish(topic: string, payload: unknown, options?: { qos?: 0 | 1 | 2 }): Promise<void>;
  /** Подписаться на топик (поддержка wildcards при необходимости). */
  subscribe(topic: string, handler: (topic: string, payload: Buffer) => void | Promise<void>, options?: { qos?: 0 | 1 | 2 }): Promise<void>;
  /** Отключиться и освободить ресурсы. */
  disconnect(): Promise<void>;
}

type Handler = (topic: string, payload: Buffer) => void | Promise<void>;

interface BufferedPublish {
  topic: string;
  serialized: string | Buffer;
  qos: 0 | 1 | 2;
}

let instancePublisher: MqttClient | null = null;
let instanceSubscriber: MqttClient | null = null;

function serializePayload(payload: unknown): string | Buffer {
  if (Buffer.isBuffer(payload)) return payload;
  if (typeof payload === 'string') return payload;
  return JSON.stringify(payload ?? {});
}

/** Разные clientId для pub и sub, чтобы брокер доставлял наши публикации подписчику (один инстанс). */
function buildClientId(config: MqttConfig, role: 'publish' | 'subscribe'): string {
  const pid = process.pid;
  return `${config.clientIdPrefix}-${role}-${pid}`;
}

function createMqttClient(config: AppConfig, role: 'publish' | 'subscribe'): MqttClient {
  const mqttConfig = config.mqtt;
  let client: RawMqttClient | null = null;
  let connectionPromise: Promise<void> | null = null;
  const handlers = new Map<string, Handler[]>();
  const publishBuffer: BufferedPublish[] = [];
  let connected = false;

  const flushPublishBuffer = async (): Promise<void> => {
    if (!client || !connected || publishBuffer.length === 0) return;
    const toSend = [...publishBuffer];
    publishBuffer.length = 0;
    for (const item of toSend) {
      try {
        await new Promise<void>((resolve, reject) => {
          client!.publish(item.topic, item.serialized, { qos: item.qos }, (err) => {
            if (err) {
              logger.error(`MQTT publish error (flush) for topic ${item.topic}`, err as Error);
              reject(err);
            } else {
              resolve();
            }
          });
        });
      } catch {
        // already logged; skip and continue
      }
    }
    if (toSend.length > 0) {
      logger.info('MQTT publish buffer flushed', { count: toSend.length });
    }
  };

  const connectIfNeeded = async (): Promise<void> => {
    if (connectionPromise) return connectionPromise;

    connectionPromise = new Promise<void>((resolve, reject) => {
      const url = `mqtt://${mqttConfig.brokerHost}:${mqttConfig.brokerPort}`;
      const options: IClientOptions = {
        clientId: buildClientId(mqttConfig, role),
        username: mqttConfig.brokerUser || undefined,
        password: mqttConfig.brokerPassword || undefined,
        keepalive: 60,
        connectTimeout: 10_000,
        reconnectPeriod: 3_000,
      };

      client = mqtt.connect(url, options);

      client.on('connect', () => {
        connected = true;
        logger.info(`MQTT connected ${url} [${role}]`);
        resolve();
        void flushPublishBuffer();
      });

      client.on('reconnect', () => {
        connected = true;
        logger.info('MQTT reconnecting');
        void flushPublishBuffer();
      });

      client.on('close', () => {
        connected = false;
        logger.warn('MQTT connection closed');
      });

      client.on('offline', () => {
        connected = false;
        logger.warn('MQTT offline');
      });

      client.on('error', (err) => {
        logger.error('MQTT error', err as Error);
      });

      client.on('message', async (topic, payload) => {
        const topicHandlers = handlers.get(topic);
        if (!topicHandlers || topicHandlers.length === 0) return;
        for (const h of topicHandlers) {
          try {
            await h(topic, payload);
          } catch (err) {
            logger.error(`MQTT handler error for topic ${topic}`, err as Error);
          }
        }
      });

      client.once('error', (err) => {
        reject(err);
      });
    });

    return connectionPromise;
  };

  return {
    async connect(): Promise<void> {
      await connectIfNeeded();
    },

    async publish(topic: string, payload: unknown, options?: { qos?: 0 | 1 | 2 }): Promise<void> {
      await connectIfNeeded();
      if (!client) throw new Error('MQTT client not initialized');

      const qos = (options?.qos ?? 1) as 0 | 1 | 2;
      const serialized = serializePayload(payload);

      if (connected) {
        await new Promise<void>((resolve, reject) => {
          client!.publish(topic, serialized, { qos }, (err) => {
            if (err) {
              logger.error(`MQTT publish error for topic ${topic}`, err as Error);
              reject(err);
            } else {
              resolve();
            }
          });
        });
        return;
      }

      // Буфер при отключении (EPIC 6)
      if (publishBuffer.length >= MAX_PUBLISH_BUFFER_SIZE) {
        const dropped = publishBuffer.shift();
        logger.warn('MQTT publish buffer full, dropped oldest message', {
          topic: dropped?.topic ?? topic,
          bufferSize: MAX_PUBLISH_BUFFER_SIZE,
        });
      }
      publishBuffer.push({ topic, serialized, qos });
    },

    async subscribe(topic: string, handler: Handler, options?: { qos?: 0 | 1 | 2 }): Promise<void> {
      await connectIfNeeded();
      if (!client) throw new Error('MQTT client not initialized');

      const qOpts: IClientSubscribeOptions = {
        qos: options?.qos ?? 1,
      };

      await new Promise<void>((resolve, reject) => {
        client!.subscribe(topic, qOpts, (err) => {
          if (err) {
            logger.error(`MQTT subscribe error for topic ${topic}`, err as Error);
            reject(err);
          } else {
            resolve();
          }
        });
      });

      const list = handlers.get(topic) ?? [];
      list.push(handler);
      handlers.set(topic, list);
    },

    async disconnect(): Promise<void> {
      if (!client) return;
      connected = false;
      await new Promise<void>((resolve) => {
        client!.end(true, {}, () => resolve());
      });
      client = null;
      connectionPromise = null;
      handlers.clear();
      publishBuffer.length = 0;
    },
  };
}

/**
 * Клиент только для публикации (outgoing worker, audit). Отдельный clientId,
 * чтобы подписчик (другой коннект) получал наши сообщения от брокера.
 */
export function getMqttPublisher(config: AppConfig): MqttClient {
  if (!instancePublisher) {
    instancePublisher = createMqttClient(config, 'publish');
  }
  return instancePublisher;
}

/**
 * Клиент только для подписок (обработчики топиков sequoia/otp и т.д.).
 * Отдельный clientId от publisher — брокер доставляет сообщения этому коннекту.
 */
export function getMqttSubscriber(config: AppConfig): MqttClient {
  if (!instanceSubscriber) {
    instanceSubscriber = createMqttClient(config, 'subscribe');
  }
  return instanceSubscriber;
}

/** @deprecated Используйте getMqttPublisher или getMqttSubscriber. Для совместимости возвращает publisher. */
export function getMqttClient(config: AppConfig): MqttClient {
  return getMqttPublisher(config);
}

export function resetMqttClient(): void {
  instancePublisher = null;
  instanceSubscriber = null;
}
