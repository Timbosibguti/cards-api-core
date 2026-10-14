-- =============================================================================
-- Миграция: bank_transactions amount sign helpers and postpay metadata
-- Дата: 2026-03-19
-- Назначение:
--   1) Добавить bank_transactions.is_postpay
--   2) Автозаполнение bank_transactions.amount_usd через exchange.rate * amount
--      на AFTER INSERT / AFTER UPDATE
-- =============================================================================

ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS is_postpay BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS amount_usd NUMERIC;

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
