-- =============================================================================
-- Миграция: sms_devices (мобильные приложения, SmsPhone)
-- Дата: 2026-03-06
-- Назначение: реестр мобильных устройств, присылающих SMS через вебхук.
-- Аналог ota_devices, но под формат SmsPhone (adscards-webhook).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.sms_devices (
  imei        CITEXT PRIMARY KEY,
  phones      TEXT[] NOT NULL,
  battery     INTEGER NOT NULL,
  charging    BOOLEAN NOT NULL,
  info        JSONB NOT NULL,
  tg_chat     BIGINT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_devices_updated_at ON public.sms_devices(updated_at);
CREATE INDEX IF NOT EXISTS idx_sms_devices_phones_gin ON public.sms_devices USING GIN (phones);

-- =============================================================================
-- Конец миграции 20260306_sms_devices
-- =============================================================================

