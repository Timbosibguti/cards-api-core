-- =============================================================================
-- Миграция: queue и bank_accounts (очереди сотрудников на банк)
-- Дата: 2026-03-06
-- Назначение: REST api/queue/* (acquire, release, status, credentials, kickoff).
-- Совместимость с mqtt_otp_transactions_service.
-- =============================================================================

-- bank_accounts: банковские аккаунты (реквизиты, баланс, credentials)
CREATE TABLE IF NOT EXISTS public.bank_accounts (
  id         SERIAL PRIMARY KEY,
  bank       CITEXT NOT NULL,
  acc_no     TEXT NOT NULL,
  name       TEXT NOT NULL,
  phone      TEXT,
  login      TEXT,
  password   TEXT,
  extra      TEXT,
  balance    DECIMAL,
  currency   TEXT,
  info       TEXT,
  info_at    TIMESTAMPTZ,
  info_buyer TEXT,
  UNIQUE(bank, acc_no)
);

CREATE INDEX IF NOT EXISTS idx_bank_accounts_bank ON public.bank_accounts(bank);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_acc_no ON public.bank_accounts(acc_no);

-- queue: занятие очереди (email, bank, acc_no, expires_at)
CREATE TABLE IF NOT EXISTS public.queue (
  id                 SERIAL PRIMARY KEY,
  email              TEXT NOT NULL,
  bank               TEXT NOT NULL,
  acc_no             TEXT NOT NULL,
  acquired_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL,
  notification_sent  BOOLEAN DEFAULT FALSE,
  UNIQUE(bank, acc_no)
);

CREATE INDEX IF NOT EXISTS idx_queue_email ON public.queue(email);
CREATE INDEX IF NOT EXISTS idx_queue_bank_acc ON public.queue(bank, acc_no);
CREATE INDEX IF NOT EXISTS idx_queue_expires_at ON public.queue(expires_at);

-- =============================================================================
-- Конец миграции 20260306_queue_bank_accounts
-- =============================================================================
