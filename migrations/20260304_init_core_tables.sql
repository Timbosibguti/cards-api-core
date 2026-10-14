-- =============================================================================
-- Миграция: init_core_tables
-- Дата: 2026-03-04
-- Назначение: Таблицы processing runtime (новые объекты, не существующие ранее):
--   - incoming_transactions
--   - outbox_events
--   - outgoing_notifications
-- Изменения существующих таблиц — в отдельной миграции 20260304_alter_bank_transactions.sql.
-- Задачи: EP1 (T1.4–T1.7), EP2 (T2.1), EP5.1.
-- =============================================================================

-- incoming_transactions: гарантированная фиксация входящих событий
CREATE TABLE IF NOT EXISTS incoming_transactions (
    id                  SERIAL PRIMARY KEY,
    bank                TEXT NOT NULL,
    raw_payload         JSONB NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending', -- pending | processing | processed | failed
    processing_started_at TIMESTAMPTZ,
    processed_at        TIMESTAMPTZ,
    processing_attempts INTEGER NOT NULL DEFAULT 0,
    idempotency_key     TEXT NOT NULL,
    correlation_id      TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_incoming_transactions_idempotency_key
    ON incoming_transactions (idempotency_key);

CREATE INDEX IF NOT EXISTS idx_incoming_transactions_status
    ON incoming_transactions (status);

-- outbox_events: события доменной outbox-шины
CREATE TABLE IF NOT EXISTS outbox_events (
    id                   SERIAL PRIMARY KEY,
    event_type           TEXT NOT NULL,
    payload              JSONB NOT NULL,
    occurred_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status               TEXT NOT NULL DEFAULT 'pending', -- pending | processing | processed | failed
    processing_started_at TIMESTAMPTZ,
    processed_at         TIMESTAMPTZ,
    processing_attempts  INTEGER NOT NULL DEFAULT 0,
    correlation_id       TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_events_status
    ON outbox_events (status);

-- outgoing_notifications: mini-outbox для Slack/MQTT и других нотификаций
CREATE TABLE IF NOT EXISTS outgoing_notifications (
    id                 SERIAL PRIMARY KEY,
    channel            TEXT NOT NULL, -- slack:dm, slack:#channel, mqtt:topic и т.п.
    recipient          TEXT,          -- email/userId/пусто для каналов
    payload            JSONB NOT NULL,
    dedup_key          TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'pending', -- pending | sending | sent | failed | rate_limited
    attempts           INTEGER NOT NULL DEFAULT 0,
    max_attempts       INTEGER NOT NULL DEFAULT 8,
    next_retry_at      TIMESTAMPTZ,
    sending_started_at TIMESTAMPTZ,
    sent_at            TIMESTAMPTZ,
    last_error         TEXT,
    correlation_id     TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_outgoing_notifications_dedup_key
    ON outgoing_notifications (dedup_key);

CREATE INDEX IF NOT EXISTS idx_outgoing_notifications_status
    ON outgoing_notifications (status);

-- =============================================================================
-- Конец миграции init_core_tables
-- =============================================================================

