import type { PoolClient } from 'pg';
import type { BankId } from '../types.js';
import type { NormalizedTransaction } from '../normalize.js';

export interface AdapterPollerHandle {
  stop(): Promise<void>;
}

export interface TransactionsAdapter {
  bank: BankId;
  normalize(client: PoolClient, raw: unknown): Promise<NormalizedTransaction | null>;

  /**
   * Фоновый поллинг транзакций (операций).
   * Например: /transaction, /operations, cursor‑based API и т.п.
   */
  startTransactionsPolling?(): Promise<AdapterPollerHandle>;

  /**
   * Фоновый поллинг карт (card list, лимиты, BIN/группы, креды).
   * Например: /card, /cards, /card-list и т.п.
   */
  startCardsPolling?(): Promise<AdapterPollerHandle>;

  /**
   * Фоновый поллинг OTP/кодов подтверждения (если провайдер поддерживает).
   * Например: ecards /codes, adscards/stellarcards webhook-based OTP и т.п.
   */
  startOtpPolling?(): Promise<AdapterPollerHandle>;

  resolveOwner?(
    client: PoolClient,
    normalized: NormalizedTransaction,
  ): Promise<{ buyer: string | null; profileName: string | null }>;

  /** Обработка webhook-событий: kind (transaction/otp/...) и сырое тело от платёжной системы. */
  handleWebhook?(
    kind: string,
    body: unknown,
    correlationId?: string,
  ): Promise<void>;

  /**
   * Фоновый поллинг балансов аккаунтов платёжной системы → public.bankcards_balances.
   */
  startBalancePolling?(): Promise<AdapterPollerHandle>;

  /**
   * Создание карт по BIN и количеству (если провайдер поддерживает).
   * Карты появятся в поллинге карт, отдельно поллить не нужно.
   */
  create?( bin: number, quantity: number,context?: { requestedByEmail?: string | null; buyerEmail?: string | null }, ): Promise<{ created: number }>;

  /**
   * Снять лимиты с карты при передаче профиля сотруднику (buyer).
   * Вызывается после обновления bank_cards.buyer. Обязательно писать аудит по владельцу карты (buyer_email).
   */
  removeLimits?(params: { cardNumber: number; extId?: string | null; buyerEmail: string }): Promise<void>;

  /**
   * Блокировка карты на стороне ПС (по данным bank_cards: cardNumber, extId).
   * Для ecards ext_id может быть пустым — провайдер сам выбирает идентификатор.
   */
  blockCard?(params: { cardNumber: number; extId: string | null }): Promise<void>;
}

