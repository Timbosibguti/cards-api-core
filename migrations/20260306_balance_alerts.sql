-- =============================================================================
-- Миграция: лимиты алертов и история балансов (bank_accounts, balance_history)
-- Дата: 2026-03-06
-- Для sequoia/otp SMS: уменьшение баланса и алерты в finance-otp.
-- Совместимость с mqtt_otp_transactions_service.
-- =============================================================================

-- bank_accounts: лимиты для алертов (balance, op count, op sum за день)
ALTER TABLE public.bank_accounts
  ADD COLUMN IF NOT EXISTS balance_limit_alert DECIMAL NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS op_limit_alert      DECIMAL NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS op_sum_limit_alert DECIMAL NOT NULL DEFAULT 0;

-- balance_history: история изменений баланса (add, update, decrease, sms_decrease)
CREATE TABLE IF NOT EXISTS public.balance_history (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  bank              TEXT NOT NULL,
  acc_no            TEXT NOT NULL,
  operation_type    TEXT NOT NULL,
  amount            DECIMAL NOT NULL,
  balance_before    DECIMAL NOT NULL,
  balance_after     DECIMAL NOT NULL,
  currency          TEXT,
  user_email        TEXT,
  comment           TEXT,
  source            TEXT DEFAULT 'manual'
);

CREATE INDEX IF NOT EXISTS idx_balance_history_bank_acc ON public.balance_history(bank, acc_no);
CREATE INDEX IF NOT EXISTS idx_balance_history_created_at ON public.balance_history(created_at);
CREATE INDEX IF NOT EXISTS idx_balance_history_operation_type ON public.balance_history(operation_type);

-- =============================================================================
-- Конец миграции 20260306_balance_alerts
-- =============================================================================
