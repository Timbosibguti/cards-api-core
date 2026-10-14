-- Очередь блокировок карт: постановка через POST /api/card-block/block-batch; обработка — отдельным воркером (позже).

CREATE TABLE IF NOT EXISTS public.card_block_queue (
  id           BIGSERIAL PRIMARY KEY,
  card_number  BIGINT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_at   TIMESTAMPTZ NULL,
  error        TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_card_block_queue_created_at
  ON public.card_block_queue (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_card_block_queue_pending
  ON public.card_block_queue (blocked_at)
  WHERE blocked_at IS NULL;

COMMENT ON TABLE public.card_block_queue IS 'Очередь на блокировку карт; blocked_at/error заполняются при обработке.';
