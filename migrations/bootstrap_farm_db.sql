-- =============================================================================
-- Разовая миграция: Farm DB — таблица лога для Processor-Hub (канон имён tbl_*).
-- Применять к БД FARM (не к основной БД processor-hub).
-- В Farm DB все таблицы по канонам называются с префикса tbl_.
--
-- Создаётся таблица tbl_profile_auth_changes и новый триггер, который пишет в неё
-- при изменении auth_id в tbl_profiles. Старый триггер (NOTIFY), если есть, не трогаем.
-- Processor-Hub читает из farm_ext.tbl_profile_auth_changes (profileAuthChangeWorker).
-- =============================================================================

-- Схема farm_ext (если ещё нет — создать)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'farm_ext') THEN
    CREATE SCHEMA farm_ext;
  END IF;
END$$;

-- Таблица лога изменений auth_id (имя с префиксом tbl_ по канону Farm DB)
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

COMMENT ON TABLE farm_ext.tbl_profile_auth_changes IS 'Лог изменений auth_id в tbl_profiles для Processor-Hub (multi-DC safe). Канон Farm DB: имена таблиц с префиксом tbl_.';

-- Функция триггера: при изменении auth_id вставить запись в tbl_profile_auth_changes
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

-- Новый триггер (имя уникальное, старый NOTIFY-триггер не удаляем)
DROP TRIGGER IF EXISTS trg_tbl_profiles_auth_id_to_processor_hub ON farm_ext.tbl_profiles;
CREATE TRIGGER trg_tbl_profiles_auth_id_to_processor_hub
  AFTER UPDATE OF auth_id ON farm_ext.tbl_profiles
  FOR EACH ROW
  EXECUTE PROCEDURE farm_ext.tbl_profile_auth_changes_on_update();

-- =============================================================================
-- Конец миграции (применять на Farm DB)
-- =============================================================================
