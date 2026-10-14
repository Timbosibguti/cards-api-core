import { getConfig } from '../../../../config/index.js';
import {
  getDatabaseService,
  getPaymentHttpClient,
  createCorrelationId,
  enqueueOutgoingNotification,
  recordAdapterPollingCycleError,
} from '../../../../infra/index.js';
import { logger } from '../../../../infra/logger.js';
import type { AdapterPollerHandle } from '../types.js';

interface EcardsOtpRecord {
  id?: number;
  createdAt?: string;
  name?: string;
  cardId?: number;
  cardNumber?: string;
  amount?: number | string | null;
  currency?: string;
  merchant?: string;
  otpCode?: string;
}

const POLL_INTERVAL_MS = 1_000;

function toAmountString(value: number | string | null | undefined): string {
  if (value == null) return '';
  if (typeof value === 'number') return value.toString();
  const trimmed = String(value).trim();
  return trimmed;
}

function computeTimeBucket(iso: string | undefined): string {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) {
    return 'unknown';
  }

  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  return `${y}${m}${d}${h}`;
}

export async function startEcardsOtpPolling(): Promise<AdapterPollerHandle> {
  const config = getConfig();
  const http = getPaymentHttpClient(config);
  const db = getDatabaseService(config);

  let stopped = false;
  let lastSeenId = 0;

  const loop = async () => {
    logger.info('Ecards OTP poller started');

    while (!stopped) {
      try {
        // Simple-api: https://ecardsnew.cab/api/modern/user/v1/simple-api/<token>/codes
        const simpleApiBase = process.env.ECARDS_SIMPLE_API_BASE_URL?.replace(/\/+$/, '');
        const records = await http.request<EcardsOtpRecord[]>({
          bank: 'ecards',
          method: 'GET',
          path: 'codes',
          ...(simpleApiBase ? { baseUrlOverride: simpleApiBase } : {}),
        });

        const list = Array.isArray(records) ? records : [];
        if (list.length === 0) {
          if (!stopped) {
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          }
          continue;
        }

        const fresh = list.filter(
          (r) => typeof r.id === 'number' && (lastSeenId === 0 || (r.id as number) > lastSeenId),
        );

        if (fresh.length === 0) {
          if (!stopped) {
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          }
          continue;
        }

        fresh.sort((a, b) => (a.id! - b.id!));

        for (const rec of fresh) {
          if (stopped) break;
          if (typeof rec.id !== 'number') continue;

          lastSeenId = Math.max(lastSeenId, rec.id);

          const otp = rec.otpCode ? String(rec.otpCode).trim() : '';
          if (!otp) continue;

          const cardNumberRaw = rec.cardNumber ? String(rec.cardNumber).trim() : '';
          const cardNumberDigits = cardNumberRaw.replace(/\D/g, '');
          const amountStr = toAmountString(rec.amount);
          const timeBucket = computeTimeBucket(rec.createdAt);

          await db.withTransaction('main', async (client) => {
            let buyer: string | null = null;
            let isBuying: boolean | null = null;
            let profileName: string | null = null;
            let bankFromCards: string | null = null;
            let accNoFromCards: string | null = null;
            let extIdFromCards: string | null = null;

            if (cardNumberDigits) {
              const cardRes = await client.query<{
                bank: string;
                acc_no: string | null;
                buyer: string | null;
                is_buying: boolean | null;
                profile_name: string | null;
                ext_id: string | null;
              }>(
                `SELECT bank, acc_no, buyer, is_buying, profile_name, ext_id
                 FROM public.bank_cards
                 WHERE bank = $1 AND card_number = $2::bigint
                 ORDER BY created_at DESC NULLS LAST
                 LIMIT 1`,
                ['ecards', cardNumberDigits],
              );

              if (cardRes.rows[0]) {
                bankFromCards = cardRes.rows[0].bank;
                accNoFromCards = cardRes.rows[0].acc_no;
                buyer = cardRes.rows[0].buyer;
                isBuying = cardRes.rows[0].is_buying;
                profileName = cardRes.rows[0].profile_name;
                extIdFromCards = cardRes.rows[0].ext_id ?? 'unknown';
              }
            }

            const idempotencyKey = `otp:ecards:${extIdFromCards}:${otp}:${timeBucket}`;
            const correlationId = createCorrelationId();

            const payload = {
              source: 'ecards' as const,
              bank: bankFromCards ?? 'ecards',
              acc_no: accNoFromCards ?? null,
              amount: amountStr,
              currency: rec.currency ?? null,
              otp,
              card_id: rec.cardId ?? null,
              card_number: cardNumberRaw,
              raw: JSON.stringify(rec),
              buyer,
              is_buying: isBuying,
              profile_name: profileName,
              idempotency_key: idempotencyKey,
              correlation_id: correlationId,
            };

            await enqueueOutgoingNotification(client, {
              channel: 'mqtt:sequoia/otp',
              payload,
              dedupKey: idempotencyKey,
              correlationId,
            });
          });
        }
      } catch (err) {
        logger.error('Ecards OTP poller loop error', {
          error: err instanceof Error ? err.message : String(err),
        });
        await recordAdapterPollingCycleError(config, 'ecards', 'ecards.otp', err);
      }

      if (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    }
  };

  void loop();

  return {
    async stop() {
      stopped = true;
    },
  };
}

