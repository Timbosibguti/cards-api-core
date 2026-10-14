-- Снимок profile_name на момент постановки в очередь (для аудита и отчётов).

ALTER TABLE public.card_block_queue
  ADD COLUMN IF NOT EXISTS profile_name TEXT NULL;

