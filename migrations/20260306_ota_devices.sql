-- =============================================================================
-- Миграция: ota_devices и ota_device_logs
-- Дата: 2026-03-06
-- Назначение: таблицы для hardware-устройств (heartbeat, OTA logs).
-- См. architecture/mqtt_handlers.md, топики sequoia/hardware/*.
-- =============================================================================

-- Реестр устройств (IMEI, телефон, версия прошивки, uptime, статистика, конфиг)
CREATE TABLE IF NOT EXISTS public.ota_devices (
  imei   CITEXT PRIMARY KEY,
  phone  BIGINT,
  version TEXT,
  uptime BIGINT,
  stats  JSONB,
  config JSONB DEFAULT '{"answer": 0, "play": 32, "hang": 60, "play_answer": 2}'::jsonb,
  board  TEXT,
  creg   TEXT,
  csq    TEXT,
  note   TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ota_devices_phone ON public.ota_devices(phone);
CREATE INDEX IF NOT EXISTS idx_ota_devices_version ON public.ota_devices(version);

-- Логи устройств (OTA devicelog, сырой payload)
CREATE TABLE IF NOT EXISTS public.ota_device_logs (
  id         BIGSERIAL PRIMARY KEY,
  imei       CITEXT NOT NULL,
  payload    JSONB,
  raw        TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ota_device_logs_imei ON public.ota_device_logs(imei);
CREATE INDEX IF NOT EXISTS idx_ota_device_logs_created_at ON public.ota_device_logs(created_at);

-- =============================================================================
-- Конец миграции 20260306_ota_devices
-- =============================================================================
