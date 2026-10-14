-- =============================================================================
-- Миграция: dev_inbox_events (Dev Simulation Environment)
-- Дата: 2026-03-06
-- Назначение: таблица и view для dev-контура (processor_hub_dev_simulation_spec.md).
-- Включается только при DEV_SIMULATION_ENABLED=true и не в production.
-- =============================================================================

CREATE TABLE IF NOT EXISTS dev_inbox_events (
    id UUID PRIMARY KEY,
    source TEXT NOT NULL,
    event_type TEXT NOT NULL,
    external_id TEXT NULL,
    correlation_id UUID NULL,
    aggregate_key TEXT NULL,
    payload JSONB NOT NULL,
    meta JSONB NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT NULL,
    replay_of_event_id UUID NULL,
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ NULL,
    created_by TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_dev_inbox_events_status
    ON dev_inbox_events (status);

CREATE INDEX IF NOT EXISTS idx_dev_inbox_events_created_at
    ON dev_inbox_events (created_at DESC);

COMMENT ON TABLE dev_inbox_events IS 'Dev simulation: injected events processed by DevInboxWorker (processor_hub_dev_simulation_spec.md)';

-- Observability: последние события (spec §13)
CREATE OR REPLACE VIEW dev_inbox_events_recent AS
SELECT
    id,
    source,
    event_type,
    status,
    created_at,
    processed_at,
    error
FROM dev_inbox_events
ORDER BY created_at DESC;

-- =============================================================================
-- Конец миграции
-- =============================================================================
