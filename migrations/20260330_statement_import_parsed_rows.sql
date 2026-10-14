-- Стадирование строк импорта выписки: сырой парс + флаги применения в bank_transactions (аналог «отправлено» у outgoing_notifications).

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

COMMENT ON TABLE public.statement_import_parsed_rows IS
  'Строки выписки после парсинга; enriched и флаги — позже (drafts/binom, upsert в bank_transactions).';
COMMENT ON COLUMN public.statement_import_parsed_rows.parsed IS
  'Объект транзакции сразу после ParserFactory (как в API /statements/parse).';
COMMENT ON COLUMN public.statement_import_parsed_rows.enriched IS
  'Доп. поля после обогащения (buyer, profile_name, aff_id и т.д.) — заполняется отдельным шагом.';
COMMENT ON COLUMN public.statement_import_parsed_rows.bank_transactions_applied IS
  'Строка учтена в public.bank_transactions (insert/update).';
