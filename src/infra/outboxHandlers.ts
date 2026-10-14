/**
 * Доменные обработчики outbox_events по event_type.
 * Вызываются из processingRuntime Outbox Worker.
 * Архитектура: processes.md §2.4, architecture_overview.md §5.
 */

import { randomUUID } from 'node:crypto';
import { getConfig } from '../config/index.js';
import { getDatabaseService, recordIncident } from './index.js';
import { setCardOwnership } from './cardOwnership.js';
import { enqueueOutgoingNotification } from './outgoingNotifications.js';
import { getTransactionsAdapter } from '../modules/transactions/adapters/index.js';
import type { BankId } from '../modules/transactions/types.js';
import * as farmDb from './farmDb.js';
import { logger } from './logger.js';

export interface OutboxRow {
  id: number;
  event_type: string;
  payload: Record<string, unknown>;
  correlation_id: string | null;
}

/**
 * Обработчик event_type = 'profile_transferred_to_buyer'.
 * Payload: { profile_name, old_auth_id?, new_auth_id }.
 * Обновляет bank_cards.buyer и bank_cards_history, ставит аудит и Slack в outgoing_notifications, снимает лимиты.
 */
async function handleProfileTransferredToBuyer(row: OutboxRow): Promise<void> {
  const payload = row.payload;
  const profileName = String(payload.profile_name ?? '').trim();
  const newAuthId = payload.new_auth_id != null ? String(payload.new_auth_id) : null;
  const correlationId = row.correlation_id ?? randomUUID();

  if (!profileName || !newAuthId) {
    logger.warn('Outbox profile_transferred_to_buyer: missing profile_name or new_auth_id', {
      id: row.id,
      profile_name: profileName || undefined,
      new_auth_id: newAuthId || undefined,
    });
    return;
  }

  const config = getConfig();
  const db = getDatabaseService(config);

  const farmClient = await db.getClient('farm');
  let email: string | null = null;
  try {
    email = await farmDb.getEmailByAuthId(farmClient, newAuthId);
  } finally {
    farmClient.release();
  }

  if (!email) {
    logger.warn('Outbox profile_transferred_to_buyer: no user for new_auth_id', {
      id: row.id,
      profile_name: profileName,
      new_auth_id: newAuthId,
    });
    return;
  }

  const mainClient = await db.getClient('main');
  try {
    const checkResult = await mainClient.query<{
      card_number: string;
      bank: string;
      acc_no: string | null;
      ext_id: string | null;
      old_buyer: string | null;
    }>(
      `SELECT card_number::text AS card_number, bank, acc_no, ext_id, buyer AS old_buyer
       FROM public.bank_cards
       WHERE profile_name = $1 AND (buyer IS NULL OR buyer = '' OR buyer <> $2)`,
      [profileName, email],
    );

    if (checkResult.rows.length === 0) {
      logger.debug('Outbox profile_transferred_to_buyer: no cards to update', {
        profile_name: profileName,
        email,
      });
      return;
    }

    await db.withTransaction('main', async (client) => {
      for (const card of checkResult.rows) {
        await setCardOwnership(client, {
          cardNumber: parseInt(card.card_number, 10),
          bank: card.bank,
          buyer: email!,
          profileName,
          is_buying: true,
        });
      }
    });

    const isTransfer = checkResult.rows.some((r) => r.old_buyer && r.old_buyer !== email);
    const eventType = isTransfer ? 'card_transferred' : 'card_linked';
    const cardList = checkResult.rows.map((c) => `${c.card_number} (${c.bank})`).join(', ');
    const slackMessage =
      isTransfer
        ? `⚠️ PROFILE TRANSFER: ${profileName}\nTo: ${email}\nCards: ${cardList}`
        : `Bank cards linked to profile ${profileName} for ${email}\nCards: ${cardList}`;

    await db.withTransaction('main', async (client) => {
      const auditPayload = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        division: 'finance' as const,
        user_email: email,
        log_type: 'info' as const,
        severity: 1,
        event_type: eventType,
        event_attributes: {
          profile_name: profileName,
          new_buyer: email,
          old_auth_id: payload.old_auth_id ?? null,
          new_auth_id: newAuthId,
          cards_updated: checkResult.rows.length,
        },
        correlation_id: correlationId,
      };
      const timeBucket = new Date().toISOString().slice(0, 16);
      await enqueueOutgoingNotification(client, {
        channel: 'mqtt:sequoia/audit',
        payload: auditPayload,
        dedupKey: `audit:profile_auth:${eventType}:${email}:${timeBucket}`,
        correlationId,
      });
      await enqueueOutgoingNotification(client, {
        channel: 'slack:#card-link',
        payload: { kind: 'card_link_notification', message: slackMessage },
        dedupKey: `slack:card-link:${eventType}:${email}:${timeBucket}`,
        correlationId,
      });
    });

    for (const card of checkResult.rows) {
      const adapter = getTransactionsAdapter(card.bank as BankId);
      if (adapter?.removeLimits) {
        try {
          const cardNumber = parseInt(card.card_number, 10);
          if (Number.isFinite(cardNumber)) {
            await adapter.removeLimits({
              cardNumber,
              extId: card.ext_id,
              buyerEmail: email!,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error('Outbox profile_transferred_to_buyer: removeLimits failed', {
            card_number: card.card_number,
            bank: card.bank,
            email,
            err,
          });
          try {
            await db.withTransaction('main', async (client) => {
              await recordIncident(client, {
                source: 'outbox_profile_transfer',
                kind: 'remove_limits_provider_error',
                severity: 'error',
                summary: `removeLimits failed (${card.bank}): ${msg}`.slice(0, 1000),
                detail: {
                  bank: card.bank,
                  card_number: card.card_number,
                  ext_id: card.ext_id,
                  buyer_email: email,
                  profile_name: profileName,
                  error_message: msg,
                },
                correlation_id: correlationId,
              });
            });
          } catch (recordErr) {
            logger.error(
              'Outbox profile_transferred_to_buyer: recordIncident failed after removeLimits',
              recordErr as Error,
            );
          }
        }
      }
      await db.withTransaction('main', async (client) => {
        const auditPayload = {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          division: 'finance' as const,
          user_email: email,
          log_type: 'info' as const,
          severity: 1,
          event_type: 'card_limits_removed',
          event_attributes: { card_number: card.card_number, bank: card.bank, buyer_email: email },
          correlation_id: correlationId,
        };
        const timeBucket = new Date().toISOString().slice(0, 16);
        await enqueueOutgoingNotification(client, {
          channel: 'mqtt:sequoia/audit',
          payload: auditPayload,
          dedupKey: `audit:card_limits_removed:${email}:${card.card_number}:${timeBucket}`,
          correlationId,
        });
      });
    }

    logger.info('Outbox profile_transferred_to_buyer: updated buyer for profile', {
      profile_name: profileName,
      email,
      rowCount: checkResult.rows.length,
      isTransfer,
    });
  } finally {
    mainClient.release();
  }
}

/**
 * Диспетчер по event_type. Вызывать из Outbox Worker после выборки записей.
 */
export async function processOutboxEvent(row: OutboxRow): Promise<void> {
  switch (row.event_type) {
    case 'profile_transferred_to_buyer':
      await handleProfileTransferredToBuyer(row);
      return;
    default:
      logger.warn('Outbox: unknown event_type, marking as processed', { id: row.id, event_type: row.event_type });
  }
}
