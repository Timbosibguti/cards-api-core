-- =============================================================================
-- Разовая миграция: полная структура БД Processor-Hub (основная БД).
-- Использование: тестовая/локальная БД, где не все таблицы есть.
-- Все объекты: CREATE TABLE IF NOT EXISTS, ALTER TABLE ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS. bank_cards не трогаем по данным (только структура).
-- В конце — опциональная очистка для локального запуска (раскомментировать при необходимости).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Существующие/легаси таблицы (создать минимальную структуру если нет)
-- -----------------------------------------------------------------------------

-- bank_cards (если таблицы нет — создаём с минимальным набором колонок)
CREATE TABLE IF NOT EXISTS public.bank_cards (
  card_number   BIGINT NOT NULL,
  bank          TEXT NOT NULL,
  acc_no        TEXT,
  profile_name  TEXT,
  buyer         TEXT,
  creds         JSONB,
  ext_id        TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  note          TEXT,
  PRIMARY KEY (bank, card_number)
);

ALTER TABLE public.bank_cards ADD COLUMN IF NOT EXISTS is_buying BOOLEAN;
ALTER TABLE public.bank_cards ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_bank_cards_profile_name ON public.bank_cards(profile_name);
CREATE INDEX IF NOT EXISTS idx_bank_cards_bank ON public.bank_cards(bank);
CREATE INDEX IF NOT EXISTS idx_bank_cards_acc_no ON public.bank_cards(acc_no);
CREATE INDEX IF NOT EXISTS idx_bank_cards_last_used_at ON public.bank_cards(last_used_at);

-- bank_transactions (минимальная структура если нет)
CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id         SERIAL PRIMARY KEY,
  bank       TEXT NOT NULL,
  acc_no     TEXT,
  ext_id     TEXT,
  amount     NUMERIC,
  currency   TEXT,
  status     TEXT,
  occurred_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS correlation_id TEXT;
ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS amount_usd NUMERIC;
ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS is_postpay BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_transactions_idempotency_key
  ON public.bank_transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sync_bank_transactions_amount_usd()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_key TEXT;
  v_rate NUMERIC;
BEGIN
  v_key := COALESCE(NULLIF(NEW.currency, ''), NEW.bank);

  IF upper(v_key) = 'USD' THEN
    v_rate := 1;
  ELSE
    SELECT e.rate
      INTO v_rate
    FROM public.exchange e
    WHERE e.bank = v_key
    LIMIT 1;
  END IF;

  UPDATE public.bank_transactions bt
  SET amount_usd = CASE
    WHEN NEW.amount IS NULL THEN NULL
    WHEN upper(v_key) <> 'USD' AND v_rate IS NULL THEN NULL
    ELSE NEW.amount * COALESCE(v_rate, 1)
  END
  WHERE bt.bank = NEW.bank
    AND bt.ext_id = NEW.ext_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bank_transactions_amount_usd_sync ON public.bank_transactions;

CREATE TRIGGER trg_bank_transactions_amount_usd_sync
AFTER INSERT OR UPDATE OF amount, bank, currency ON public.bank_transactions
FOR EACH ROW
WHEN (pg_trigger_depth() = 0)
EXECUTE FUNCTION public.sync_bank_transactions_amount_usd();

-- cards_info (справочник BIN для getCardInfo / get-bins)
CREATE TABLE IF NOT EXISTS public.cards_info (
  bank TEXT NOT NULL,
  bin  BIGINT NOT NULL,
  geo  TEXT,
  info TEXT,
  PRIMARY KEY (bank, bin)
);

-- -----------------------------------------------------------------------------
-- 2. Processing runtime (init_core_tables)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.incoming_transactions (
  id                   SERIAL PRIMARY KEY,
  bank                 TEXT NOT NULL,
  raw_payload          JSONB NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
  processing_started_at TIMESTAMPTZ,
  processed_at         TIMESTAMPTZ,
  processing_attempts   INTEGER NOT NULL DEFAULT 0,
  idempotency_key      TEXT NOT NULL,
  correlation_id       TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_incoming_transactions_idempotency_key
  ON public.incoming_transactions (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_incoming_transactions_status
  ON public.incoming_transactions (status);

CREATE TABLE IF NOT EXISTS public.outbox_events (
  id                    SERIAL PRIMARY KEY,
  event_type            TEXT NOT NULL,
  payload               JSONB NOT NULL,
  occurred_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status                TEXT NOT NULL DEFAULT 'pending',
  processing_started_at TIMESTAMPTZ,
  processed_at          TIMESTAMPTZ,
  processing_attempts   INTEGER NOT NULL DEFAULT 0,
  correlation_id         TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_events_status ON public.outbox_events (status);

CREATE TABLE IF NOT EXISTS public.outgoing_notifications (
  id                 SERIAL PRIMARY KEY,
  channel            TEXT NOT NULL,
  recipient          TEXT,
  payload            JSONB NOT NULL,
  dedup_key          TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  attempts           INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 8,
  next_retry_at      TIMESTAMPTZ,
  sending_started_at TIMESTAMPTZ,
  sent_at            TIMESTAMPTZ,
  last_error         TEXT,
  correlation_id     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_outgoing_notifications_dedup_key
  ON public.outgoing_notifications (dedup_key);
CREATE INDEX IF NOT EXISTS idx_outgoing_notifications_status
  ON public.outgoing_notifications (status);

-- -----------------------------------------------------------------------------
-- 3. bank_cards_history, is_buying уже добавлен выше к bank_cards
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.bank_cards_history (
  id           SERIAL PRIMARY KEY,
  card_number  BIGINT NOT NULL,
  bank         TEXT NOT NULL,
  buyer_email  TEXT,
  profile_name TEXT,
  is_buying    BOOLEAN,
  valid_from   TIMESTAMPTZ NOT NULL,
  valid_to     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_cards_history_one_active_per_card
  ON public.bank_cards_history (card_number) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_bank_cards_history_card_number
  ON public.bank_cards_history (card_number);
CREATE INDEX IF NOT EXISTS idx_bank_cards_history_valid_from
  ON public.bank_cards_history (valid_from);

-- -----------------------------------------------------------------------------
-- 4. drafts
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.drafts (
  id              SERIAL PRIMARY KEY,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  bank            TEXT,
  transaction_id  TEXT,
  profile_name    TEXT,
  buyer_email     TEXT,
  card_number     BIGINT,
  otp             TEXT,
  amount          NUMERIC,
  currency        TEXT,
  time_bucket     TIMESTAMPTZ,
  raw             JSONB NOT NULL,
  payload_hash    TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Если таблица drafts уже существовала со старой структурой — добавить недостающие колонки
ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS kind TEXT;
ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS transaction_id TEXT;
ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS profile_name TEXT;
ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS buyer_email TEXT;
ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS time_bucket TIMESTAMPTZ;
ALTER TABLE public.drafts ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_drafts_bank_pre
  ON public.drafts (bank, transaction_id) WHERE kind = 'bank_pre';
CREATE UNIQUE INDEX IF NOT EXISTS uq_drafts_card_otp_card
  ON public.drafts (bank, card_number, otp, time_bucket)
  WHERE kind = 'card_otp' AND card_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_drafts_card_pre_profile
  ON public.drafts (profile_name, otp, time_bucket) WHERE kind = 'card_pre';
CREATE INDEX IF NOT EXISTS idx_drafts_kind_status ON public.drafts (kind, status);
CREATE INDEX IF NOT EXISTS idx_drafts_expires_at ON public.drafts (expires_at);

-- -----------------------------------------------------------------------------
-- 5. queue, bank_accounts
-- -----------------------------------------------------------------------------

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

ALTER TABLE public.bank_accounts
  ADD COLUMN IF NOT EXISTS balance_limit_alert DECIMAL NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS op_limit_alert     DECIMAL NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS op_sum_limit_alert DECIMAL NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_bank_accounts_bank ON public.bank_accounts(bank);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_acc_no ON public.bank_accounts(acc_no);

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

-- -----------------------------------------------------------------------------
-- 6. cards_farm_extension
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.bank_cards_shown (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  card_number  BIGINT NOT NULL,
  email        CITEXT,
  profile_name CITEXT
);

CREATE INDEX IF NOT EXISTS idx_bank_cards_shown_created_at ON public.bank_cards_shown(created_at);
CREATE INDEX IF NOT EXISTS idx_bank_cards_shown_card_number ON public.bank_cards_shown(card_number);
CREATE INDEX IF NOT EXISTS idx_bank_cards_shown_email ON public.bank_cards_shown(email);
CREATE INDEX IF NOT EXISTS idx_bank_cards_shown_profile_name ON public.bank_cards_shown(profile_name);

CREATE TABLE IF NOT EXISTS public.cards_access (
  email      CITEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cards_access_email ON public.cards_access(email);
CREATE INDEX IF NOT EXISTS idx_cards_access_created_at ON public.cards_access(created_at);

-- -----------------------------------------------------------------------------
-- 7. dev_inbox_events
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.dev_inbox_events (
  id               UUID PRIMARY KEY,
  source           TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  external_id      TEXT,
  correlation_id   UUID,
  aggregate_key    TEXT,
  payload          JSONB NOT NULL,
  meta             JSONB,
  status           TEXT NOT NULL DEFAULT 'pending',
  error            TEXT,
  replay_of_event_id UUID,
  scheduled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at     TIMESTAMPTZ,
  created_by       TEXT
);

CREATE INDEX IF NOT EXISTS idx_dev_inbox_events_status ON public.dev_inbox_events (status);
CREATE INDEX IF NOT EXISTS idx_dev_inbox_events_created_at ON public.dev_inbox_events (created_at DESC);

-- -----------------------------------------------------------------------------
-- 8. statement_import_jobs
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.statement_import_jobs (
  id              UUID PRIMARY KEY,
  file_name       TEXT NOT NULL,
  file_type       TEXT,
  file_size       BIGINT,
  file_contents   BYTEA NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  error           TEXT,
  correlation_id  TEXT,
  idempotency_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_statement_import_jobs_status ON public.statement_import_jobs (status);
CREATE INDEX IF NOT EXISTS idx_statement_import_jobs_created_at ON public.statement_import_jobs (created_at);

ALTER TABLE public.statement_import_jobs DROP CONSTRAINT IF EXISTS chk_statement_import_jobs_status;
ALTER TABLE public.statement_import_jobs
  ADD CONSTRAINT chk_statement_import_jobs_status
  CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'dead_letter'));

-- 8b. statement_import_parsed_rows (строки после парсинга, до/после обогащения)
CREATE TABLE IF NOT EXISTS public.statement_import_parsed_rows (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                          UUID NOT NULL REFERENCES public.statement_import_jobs (id) ON DELETE CASCADE,
  row_index                       INTEGER NOT NULL,
  parsed                          JSONB NOT NULL,
  enriched                        JSONB,
  bank_transactions_applied     BOOLEAN NOT NULL DEFAULT FALSE,
  bank_transactions_applied_at    TIMESTAMPTZ,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_statement_import_parsed_rows_job_row UNIQUE (job_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_statement_import_parsed_rows_job_id
  ON public.statement_import_parsed_rows (job_id);

-- -----------------------------------------------------------------------------
-- 9. sms_devices, ota_devices, balance_history
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sms_devices (
  imei       CITEXT PRIMARY KEY,
  phones     TEXT[] NOT NULL,
  battery    INTEGER NOT NULL,
  charging   BOOLEAN NOT NULL,
  info       JSONB NOT NULL,
  tg_chat    BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_devices_updated_at ON public.sms_devices(updated_at);
CREATE INDEX IF NOT EXISTS idx_sms_devices_phones_gin ON public.sms_devices USING GIN (phones);

CREATE TABLE IF NOT EXISTS public.ota_devices (
  imei       CITEXT PRIMARY KEY,
  phone      BIGINT,
  version    TEXT,
  uptime     BIGINT,
  stats      JSONB,
  config     JSONB DEFAULT '{"answer": 0, "play": 32, "hang": 60, "play_answer": 2}'::jsonb,
  board      TEXT,
  creg       TEXT,
  csq        TEXT,
  note       TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ota_devices_phone ON public.ota_devices(phone);
CREATE INDEX IF NOT EXISTS idx_ota_devices_version ON public.ota_devices(version);

CREATE TABLE IF NOT EXISTS public.ota_device_logs (
  id         BIGSERIAL PRIMARY KEY,
  imei       CITEXT NOT NULL,
  payload    JSONB,
  raw        TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ota_device_logs_imei ON public.ota_device_logs(imei);
CREATE INDEX IF NOT EXISTS idx_ota_device_logs_created_at ON public.ota_device_logs(created_at);

CREATE TABLE IF NOT EXISTS public.balance_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  bank            TEXT NOT NULL,
  acc_no          TEXT NOT NULL,
  operation_type  TEXT NOT NULL,
  amount          DECIMAL NOT NULL,
  balance_before  DECIMAL NOT NULL,
  balance_after   DECIMAL NOT NULL,
  currency        TEXT,
  user_email      TEXT,
  comment         TEXT,
  source          TEXT DEFAULT 'manual'
);

CREATE INDEX IF NOT EXISTS idx_balance_history_bank_acc ON public.balance_history(bank, acc_no);
CREATE INDEX IF NOT EXISTS idx_balance_history_created_at ON public.balance_history(created_at);
CREATE INDEX IF NOT EXISTS idx_balance_history_operation_type ON public.balance_history(operation_type);

-- -----------------------------------------------------------------------------
-- 10. View dev_inbox_events_recent (если нужна для dev simulation)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.dev_inbox_events_recent AS
SELECT id, source, event_type, status, created_at, processed_at, error
FROM public.dev_inbox_events
ORDER BY created_at DESC;

-- =============================================================================
-- Опционально: для локального запуска — очистка bank_transactions и аудита
-- (аудит у нас в outgoing_notifications по каналу mqtt:sequoia/audit).
-- Раскомментируйте блок ниже, если нужно начать с пустых транзакций и нотификаций.
-- =============================================================================
/*
TRUNCATE TABLE public.bank_transactions RESTART IDENTITY;
TRUNCATE TABLE public.outgoing_notifications RESTART IDENTITY;
*/

-- =============================================================================
-- Конец bootstrap_full_structure.sql
-- =============================================================================
