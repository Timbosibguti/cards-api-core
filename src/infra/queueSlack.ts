/**
 * Отправка сообщений в Slack для api/queue/* (acquire/release/kickoff).
 * Использует общий slackDelivery (slack-app API: send-otp).
 */

import { sendSlackDm } from './slackDelivery.js';

export async function sendQueueSlackMessage(message: string, email?: string): Promise<boolean> {
  return sendSlackDm(message, email ?? undefined, true);
}
