-- =============================================================================
-- Миграция: drafts (pre‑transactions)
-- Дата: 2026-03-06
-- Назначение: таблица drafts для pre‑transactions / OTP‑drafts.
--   Используется эндпоинтом /draft (см. architecture/processes.md 3.3,
--   architecture_overview.md 4.1).
-- =============================================================================

CREATE TABLE IF NOT EXISTS drafts (
    id             SERIAL PRIMARY KEY,
    kind           TEXT NOT NULL,           -- bank_pre | card_otp | card_pre | ...
    status         TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | expired

    bank           TEXT,
    transaction_id TEXT,
    profile_name   TEXT,
    buyer_email    TEXT,
    card_number    BIGINT,
    otp            TEXT,
    amount         NUMERIC,
    currency       TEXT,

    time_bucket    TIMESTAMPTZ,
    raw            JSONB NOT NULL,
    payload_hash   TEXT,

    expires_at     TIMESTAMPTZ NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Уникальные ключи по kind (см. architecture_overview.md 4.1).

-- bank_pre: один draft на операцию в банке
CREATE UNIQUE INDEX IF NOT EXISTS uq_drafts_bank_pre
    ON drafts (bank, transaction_id)
    WHERE kind = 'bank_pre';

-- card_otp: при наличии card_number используем (bank, card_number, otp, time_bucket)
CREATE UNIQUE INDEX IF NOT EXISTS uq_drafts_card_otp_card
    ON drafts (bank, card_number, otp, time_bucket)
    WHERE kind = 'card_otp' AND card_number IS NOT NULL;

-- card_pre: уникальность по (profile_name, otp, time_bucket)
CREATE UNIQUE INDEX IF NOT EXISTS uq_drafts_card_pre_profile
    ON drafts (profile_name, otp, time_bucket)
    WHERE kind = 'card_pre';

CREATE INDEX IF NOT EXISTS idx_drafts_kind_status
    ON drafts (kind, status);

CREATE INDEX IF NOT EXISTS idx_drafts_expires_at
    ON drafts (expires_at);

-- =============================================================================
-- Конец миграции drafts
-- =============================================================================

