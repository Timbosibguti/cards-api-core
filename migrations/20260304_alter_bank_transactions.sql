-- =============================================================================
-- Миграция: расширение существующей таблицы bank_transactions
-- Дата: 2026-03-04
-- Назначение: только изменения существующей таблицы (без создания новых).
--   Добавляются поля идемпотентности и трассировки для Processor-Hub.
-- Задачи: EP2 (T2.1), processes.md 2.6, architecture_overview 4.
-- =============================================================================

-- bank_transactions: добавление полей (таблица уже существует в БД)
ALTER TABLE bank_transactions
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE bank_transactions
    ADD COLUMN IF NOT EXISTS correlation_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_transactions_idempotency_key
    ON bank_transactions (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- =============================================================================
-- Конец миграции alter_bank_transactions
-- =============================================================================
