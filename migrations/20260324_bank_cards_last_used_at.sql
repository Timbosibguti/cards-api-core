BEGIN;

ALTER TABLE public.bank_cards
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_bank_cards_last_used_at
  ON public.bank_cards (last_used_at);

COMMIT;
