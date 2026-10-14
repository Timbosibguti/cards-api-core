-- =============================================================================
-- Разовая очистка для локального запуска (основная БД).
-- Выполнять при необходимости: оставляем bank_cards, очищаем bank_transactions
-- и исходящие нотификации (в т.ч. аудит в mqtt:sequoia/audit).
-- =============================================================================

TRUNCATE TABLE public.bank_transactions RESTART IDENTITY;
TRUNCATE TABLE public.outgoing_notifications RESTART IDENTITY;
