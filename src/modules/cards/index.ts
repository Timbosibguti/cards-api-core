/**
 * Модуль cards: выпуск карт, привязка/отвязка, история владения (bank_cards, bank_cards_history).
 * Доменные операции по картам инкапсулированы в сервисе:
 * - upsert карт от провайдеров (ProviderCardInput → upsertProviderCard);
 * - дальнейшие задачи: привязка/отвязка к профилю, история владения.
 */

export const cardsModule = {
  name: 'cards',
} as const;

export { upsertProviderCard, type ProviderCardInput } from './service.js';
