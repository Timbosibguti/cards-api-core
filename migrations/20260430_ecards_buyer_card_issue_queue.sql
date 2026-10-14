-- Очередь привязки карт eCards к баеру: одна строка = одна карта.
-- POST /api/cards/create/ecards с buyer_email создаёт quantity строк с общим request_batch_id.
-- Поллинг карт: pending → processing → completed | failed (ошибка в error).

CREATE TABLE IF NOT EXISTS public.ecards_buyer_card_issue_queue (
  id                  BIGSERIAL PRIMARY KEY,
  buyer_email         TEXT NOT NULL,
  bank                TEXT NOT NULL DEFAULT 'ecards',
  bin                 INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  requested_by_email  TEXT NULL,
  request_batch_id    UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NULL,
  error               TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_ecards_buyer_card_issue_queue_pending
  ON public.ecards_buyer_card_issue_queue (bin, id ASC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_ecards_buyer_card_issue_queue_buyer
  ON public.ecards_buyer_card_issue_queue (lower(trim(buyer_email)));

CREATE INDEX IF NOT EXISTS idx_ecards_buyer_card_issue_queue_batch
  ON public.ecards_buyer_card_issue_queue (request_batch_id);

COMMENT ON TABLE public.ecards_buyer_card_issue_queue IS
  'Очередь: по одной записи на карту для закрепления за buyer_email; ошибка фиксируется в error только у соответствующей строки.';

COMMENT ON COLUMN public.ecards_buyer_card_issue_queue.request_batch_id IS
  'Один UUID на запрос POST /api/cards/create/ecards (все строки из этого запроса имеют одинаковый batch).';

COMMENT ON COLUMN public.ecards_buyer_card_issue_queue.status IS
  'pending — ждёт карту в поллинге; processing — взята в работу; completed / failed — итог по этой карте.';
