-- Lease while воркер держит строку между COMMIT и финальным обновлением (ретраи + HTTP к ПС).
-- Строка не видна другим воркерам, пока NOW() < processing_lease_until (кроме истёкшего lease — повторная попытка).

ALTER TABLE public.card_block_queue
  ADD COLUMN IF NOT EXISTS processing_lease_until TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.card_block_queue.processing_lease_until IS
  'Пока в будущем — строка обрабатывается воркером (ретраи блокировки); NULL или прошлое — доступна для claim.';
