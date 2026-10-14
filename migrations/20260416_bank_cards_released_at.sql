-- =============================================================================
-- Миграция: bank_cards_released_at
-- Дата: 2026-04-16
-- Назначение: "отлёжка" карты после release/unlink (24 часа не выдавать как свободную)
-- =============================================================================

ALTER TABLE public.bank_cards
  ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ DEFAULT NULL;

-- Индекс для быстрого отсечения "отлеживающихся" карт
CREATE INDEX IF NOT EXISTS bank_cards_released_at_idx
  ON public.bank_cards (released_at)
  WHERE released_at IS NOT NULL;

