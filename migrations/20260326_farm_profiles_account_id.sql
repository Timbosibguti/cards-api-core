-- Добавляет account_id для привязки Google Ads account к профилю farm-extension
ALTER TABLE farm_ext.tbl_profiles
ADD COLUMN IF NOT EXISTS account_id text DEFAULT NULL;
