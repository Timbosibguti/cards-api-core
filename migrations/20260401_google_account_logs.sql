-- =============================================================================
-- google_account_logs: журнал отстуков POST /google/account (Google Ads скрипт)
-- =============================================================================
-- Назначение: сохранять каждый POST независимо от первой установки скрипта.
-- Полный JSON тела — в payload; для фильтров — created_at, account_id, profile_name.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.google_account_logs (
  id              BIGSERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL,
  account_id      TEXT,
  profile_name    TEXT,
  payload         JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_google_account_logs_created_at
  ON public.google_account_logs (created_at);

CREATE INDEX IF NOT EXISTS idx_google_account_logs_account_id
  ON public.google_account_logs (account_id);

CREATE INDEX IF NOT EXISTS idx_google_account_logs_profile_name
  ON public.google_account_logs (profile_name);

CREATE INDEX IF NOT EXISTS idx_google_account_logs_payload_gin
  ON public.google_account_logs USING GIN (payload jsonb_path_ops);

COMMENT ON TABLE public.google_account_logs IS
  'Отстуки POST /google/account: полное тело запроса в payload; created_at — момент записи (NOW() на сервере).';
COMMENT ON COLUMN public.google_account_logs.created_at IS
  'Момент записи строки (NOW() на сервере при INSERT).';
COMMENT ON COLUMN public.google_account_logs.account_id IS
  'body.accountId (Google Ads customer id, строка).';
COMMENT ON COLUMN public.google_account_logs.profile_name IS
  'body.profile_name.';
COMMENT ON COLUMN public.google_account_logs.payload IS
  'Полный JSON тела POST (stats, breakdown, moderation, budget и т.д.).';
