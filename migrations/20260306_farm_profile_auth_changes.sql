-- =============================================================================
-- Миграция: farm_profile_auth_changes (применять к БД FARM, не к основной БД processor-hub)
-- Дата: 2026-03-06
-- Назначение: Лог изменений auth_id в tbl_profiles для перепривязки карт.
-- В Farm DB по канону все таблицы с префиксом tbl_. Таблица: farm_ext.tbl_profile_auth_changes.
-- Полная разовая подготовка Farm DB (включая схему): migrations/bootstrap_farm_db.sql
-- =============================================================================

CREATE TABLE IF NOT EXISTS farm_ext.tbl_profile_auth_changes (
  id           BIGSERIAL PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  profile_name TEXT NOT NULL,
  old_auth_id  TEXT,
  new_auth_id  TEXT,
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tbl_profile_auth_changes_processed_at
  ON farm_ext.tbl_profile_auth_changes (processed_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tbl_profile_auth_changes_created_at
  ON farm_ext.tbl_profile_auth_changes (created_at);

COMMENT ON TABLE farm_ext.tbl_profile_auth_changes IS 'Лог изменений auth_id в tbl_profiles для Processor-Hub (multi-DC safe). Канон Farm DB: tbl_*';

CREATE OR REPLACE FUNCTION farm_ext.tbl_profile_auth_changes_on_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.auth_id IS DISTINCT FROM NEW.auth_id THEN
    INSERT INTO farm_ext.tbl_profile_auth_changes (profile_name, old_auth_id, new_auth_id)
    VALUES (COALESCE(NEW.name, ''), OLD.auth_id, NEW.auth_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tbl_profiles_auth_id_to_processor_hub ON farm_ext.tbl_profiles;
CREATE TRIGGER trg_tbl_profiles_auth_id_to_processor_hub
  AFTER UPDATE OF auth_id ON farm_ext.tbl_profiles
  FOR EACH ROW
  EXECUTE PROCEDURE farm_ext.tbl_profile_auth_changes_on_update();

-- =============================================================================
-- Конец миграции (применять на Farm DB). Старый триггер (NOTIFY), если есть, не удаляем.
-- =============================================================================
