-- =============================================================================
-- Миграция: statement_import_jobs (очередь импорта банковских выписок)
-- Дата: 2026-03-06
-- Назначение: очередь задач для фонового импорта выписок.
-- Соответствует architecture/processes.md §3.4.
-- =============================================================================

CREATE TABLE IF NOT EXISTS statement_import_jobs (
    id             UUID PRIMARY KEY,
    file_name      TEXT NOT NULL,
    file_type      TEXT,
    file_size      BIGINT,
    file_contents  BYTEA NOT NULL,

    status         TEXT NOT NULL DEFAULT 'pending', -- pending | processing | processed | failed
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at     TIMESTAMPTZ,
    finished_at    TIMESTAMPTZ,

    error          TEXT,
    correlation_id TEXT,
    idempotency_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_statement_import_jobs_status
    ON statement_import_jobs (status);

CREATE INDEX IF NOT EXISTS idx_statement_import_jobs_created_at
    ON statement_import_jobs (created_at);

-- =============================================================================
-- Конец миграции statement_import_jobs
-- =============================================================================

