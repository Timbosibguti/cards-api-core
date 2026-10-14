-- Добавить updated_at в bank_cards, если таблица была создана без неё (например, из старой схемы).
-- Код resolveOwnerViaBankCards использует ORDER BY created_at, но колонка полезна для будущего использования.
ALTER TABLE public.bank_cards ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
