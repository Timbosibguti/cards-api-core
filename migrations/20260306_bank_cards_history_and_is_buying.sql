-- =============================================================================
-- Миграция: bank_cards_history и is_buying на bank_cards
-- Дата: 2026-03-06
-- Назначение: История владения картами (интервалы «кто владел в момент X»),
--   поле is_buying на bank_cards. Архитектура: architecture_overview.md §4.2.
-- =============================================================================

-- Поле is_buying: при привязке фармером = false, при передаче баеру = true
ALTER TABLE public.bank_cards
  ADD COLUMN IF NOT EXISTS is_buying BOOLEAN;

-- История владения: один активный интервал на карту (valid_to IS NULL)
CREATE TABLE IF NOT EXISTS public.bank_cards_history (
    id             SERIAL PRIMARY KEY,
    card_number    BIGINT NOT NULL,
    bank           TEXT NOT NULL,
    buyer_email    TEXT,
    profile_name   TEXT,
    is_buying      BOOLEAN,
    valid_from     TIMESTAMPTZ NOT NULL,
    valid_to       TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_cards_history_one_active_per_card
  ON public.bank_cards_history (card_number) WHERE valid_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_bank_cards_history_card_number
  ON public.bank_cards_history (card_number);
CREATE INDEX IF NOT EXISTS idx_bank_cards_history_valid_from
  ON public.bank_cards_history (valid_from);

-- =============================================================================
-- Конец миграции
-- =============================================================================
