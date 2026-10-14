-- =============================================================================
-- Миграция: statement_import_jobs — явный статус dead_letter
-- Дата: 2026-03-06
-- Назначение: документировать в схеме допустимые статусы (docs/state_machines.md).
-- dead_letter — для безнадёжных задач (ручной перевод или будущая логика).
-- =============================================================================

ALTER TABLE public.statement_import_jobs
  DROP CONSTRAINT IF EXISTS chk_statement_import_jobs_status;

ALTER TABLE public.statement_import_jobs
  ADD CONSTRAINT chk_statement_import_jobs_status
  CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'dead_letter'));

COMMENT ON COLUMN public.statement_import_jobs.status IS
  'pending | processing | processed | failed | dead_letter (см. docs/state_machines.md)';

-- =============================================================================
-- Конец миграции
-- =============================================================================
