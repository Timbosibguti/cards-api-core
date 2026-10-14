-- Email инициатора постановки в очередь (из JWT). Старые строки до миграции остаются с NULL.

ALTER TABLE public.card_block_queue
  ADD COLUMN IF NOT EXISTS email TEXT NULL;

COMMENT ON COLUMN public.card_block_queue.email IS 'Email из payload JWT (Bearer); заполняется при INSERT из POST /api/card-block/block-batch.';

CREATE INDEX IF NOT EXISTS idx_card_block_queue_email
  ON public.card_block_queue (email)
  WHERE email IS NOT NULL;
