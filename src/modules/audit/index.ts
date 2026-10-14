/**
 * Модуль audit: обёртки над AuditService для доменных событий (card_issued, card_linked и т.д.).
 * Запись в audit_events и постановка в outgoing_notifications для sequoia/audit.
 */

export const auditModule = {
  name: 'audit',
} as const;
