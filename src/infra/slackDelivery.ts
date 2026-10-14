/**
 * Доставка сообщений в Slack через slack-app API.
 * Совместимость с mqtt_otp_transactions_service SlackOtpService:
 *   POST {appUrl}/api/slack/send-otp   — DM (email + message)
 *   POST {appUrl}/api/slack/send-to-channel — канал (channel, message).
 *
 * Пуско-наладка: при заданном SLACK_ALL_TO_CHANNEL (например dev-hub) все сообщения
 * идут в этот канал с префиксом [DM: email] или [#канал], чтобы видеть, куда бы они полетели в бою.
 */

import { getConfig } from '../config/index.js';
import { logger } from './logger.js';

const SLACK_MIN_INTERVAL_MS = 1500;
let lastSendTime = 0;

function getApiKey(): string {
  const config = getConfig();
  return (config.slack.apiKey || config.slack.apiToken || '').trim();
}

function getAppUrl(): string {
  return getConfig().slack.appUrl?.trim() ?? '';
}

/** Если включён режим «всё в один канал», возвращает имя канала. */
function getAllToChannel(): string | undefined {
  const ch = getConfig().slack.allToChannel?.trim();
  return ch || undefined;
}

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastSendTime;
  if (elapsed < SLACK_MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, SLACK_MIN_INTERVAL_MS - elapsed));
  }
  lastSendTime = Date.now();
}

/**
 * Отправить сообщение в DM (и опционально в #finance-otp).
 * POST /api/slack/send-otp, body: { email?, message, postToFinanceOtp? }.
 * При SLACK_ALL_TO_CHANNEL сообщение уходит в тот канал с префиксом [DM: email].
 */
export async function sendSlackDm(message: string, email?: string | null, postToFinanceOtp = true): Promise<boolean> {
  const allTo = getAllToChannel();
  if (allTo) {
    const target = email ? `DM: ${email}` : 'DM: (no email)';
    const prefixed = `[${target}]\n${message}`;
    logger.info('Slack DM redirecting to channel (SLACK_ALL_TO_CHANNEL)', { allToChannel: allTo, recipient: email ?? '(none)' });
    return sendSlackToChannel(allTo, prefixed);
  }

  const url = getAppUrl();
  const apiKey = getApiKey();
  if (!url || !apiKey) {
    // test comment
    logger.warn('Slack DM skipped: appUrl or apiKey not configured', { hasUrl: !!url, hasApiKey: !!apiKey });
    return false;
  }
  await throttle();
  const endpoint = `${url.replace(/\/$/, '')}/api/slack/send-otp`;
  try {
    const body: { email?: string; message: string; postToFinanceOtp?: boolean } = { message };
    if (email) body.email = email;
    if (!postToFinanceOtp) body.postToFinanceOtp = false;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      logger.warn('Slack send-otp failed', {
        status: response.status,
        error: (err as { error?: string }).error,
      });
      return false;
    }
    const data = (await response.json()) as { ok?: boolean; error?: string };
    if (data.ok) {
      logger.info('Slack DM sent', { email: email ?? '(none)' });
      return true;
    }
    logger.warn('Slack send-otp returned not ok', { email: email ?? '(none)', error: data.error });
    return false;
  } catch (err) {
    logger.error('Slack send-otp error', { email: email ?? '(none)', error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Отправить сообщение в канал Slack.
 * POST /api/slack/send-to-channel, body: { channel, message, members?, blocks? }.
 * @param channelName — имя канала без # (например farm-otp, finance-otp).
 * При SLACK_ALL_TO_CHANNEL сообщение уходит в тот канал с префиксом [#исходный_канал].
 */
export async function sendSlackToChannel(
  channelName: string,
  message: string,
  blocks?: unknown[],
): Promise<boolean> {
  const allTo = getAllToChannel();
  const effectiveChannel = allTo ?? channelName;
  const effectiveMessage = allTo && channelName !== allTo ? `[#${channelName}]\n${message}` : message;

  if (allTo) {
    logger.info('Slack channel redirect (SLACK_ALL_TO_CHANNEL)', { requested: channelName, target: allTo });
  }

  const url = getAppUrl();
  const apiKey = getApiKey();
  if (!url || !apiKey) {
    logger.warn('Slack channel skipped: appUrl or apiKey not configured', { channel: effectiveChannel, hasUrl: !!url, hasApiKey: !!apiKey });
    return false;
  }
  await throttle();
  const endpoint = `${url.replace(/\/$/, '')}/api/slack/send-to-channel`;
  try {
    const body: Record<string, unknown> = {
      channel: effectiveChannel,
      message: effectiveMessage,
      members: [],
    };
    if (blocks && Array.isArray(blocks) && blocks.length > 0) {
      body.blocks = blocks;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      logger.warn('Slack send-to-channel failed', {
        status: response.status,
        channel: effectiveChannel,
        error: (err as { error?: string }).error,
      });
      return false;
    }
    const data = (await response.json()) as { ok?: boolean; error?: string };
    if (data.ok) {
      logger.info('Slack channel sent', { channel: effectiveChannel, redirected: !!allTo });
      return true;
    }
    logger.warn('Slack send-to-channel returned not ok', { channel: effectiveChannel, error: data.error });
    return false;
  } catch (err) {
    logger.error('Slack send-to-channel error', { channel: effectiveChannel, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
