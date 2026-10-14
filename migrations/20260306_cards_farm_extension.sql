-- =============================================================================
-- Миграция: cards_farm_extension
-- Дата: 2026-03-06
-- Назначение: Таблицы для farm-extension API карт (bank_cards_shown, cards_access).
-- Совместимость с mqtt_ecards_transactions.
-- =============================================================================

-- bank_cards_shown: аудит просмотра карты (кто и когда смотрел карту)
CREATE TABLE IF NOT EXISTS public.bank_cards_shown (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    card_number BIGINT NOT NULL,
    email CITEXT,
    profile_name CITEXT
);

CREATE INDEX IF NOT EXISTS idx_bank_cards_shown_created_at ON public.bank_cards_shown(created_at);
CREATE INDEX IF NOT EXISTS idx_bank_cards_shown_card_number ON public.bank_cards_shown(card_number);
CREATE INDEX IF NOT EXISTS idx_bank_cards_shown_email ON public.bank_cards_shown(email);
CREATE INDEX IF NOT EXISTS idx_bank_cards_shown_profile_name ON public.bank_cards_shown(profile_name);

-- cards_access: контроль доступа к роутам /api/cards/* (email должен быть в таблице)
CREATE TABLE IF NOT EXISTS public.cards_access (
    email CITEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cards_access_email ON public.cards_access(email);
CREATE INDEX IF NOT EXISTS idx_cards_access_created_at ON public.cards_access(created_at);

-- =============================================================================
-- Конец миграции
-- =============================================================================
