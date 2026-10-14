-- Реестр инцидентов для мониторинга и алертов (processor-hub).
-- Запись: какой компонент (source), когда (occurred_at), что случилось (kind, summary, detail).

CREATE TABLE IF NOT EXISTS public.ops_incidents (
  id              BIGSERIAL PRIMARY KEY,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source          TEXT NOT NULL,
  kind            TEXT NOT NULL,
  severity        TEXT NOT NULL DEFAULT 'info',
  summary         TEXT NOT NULL,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id  TEXT,
  dedup_key       TEXT
);

COMMENT ON TABLE public.ops_incidents IS 'Инциденты/сигналы мониторинга: сервис, время, тип, краткое описание, произвольный JSON в detail.';

CREATE INDEX IF NOT EXISTS idx_ops_incidents_occurred_at ON public.ops_incidents (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_incidents_source ON public.ops_incidents (source);
CREATE INDEX IF NOT EXISTS idx_ops_incidents_kind ON public.ops_incidents (kind);
CREATE INDEX IF NOT EXISTS idx_ops_incidents_severity ON public.ops_incidents (severity);

-- Повтор с тем же непустым dedup_key — INSERT ... ON CONFLICT DO NOTHING (несколько NULL допустимы в UNIQUE).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_incidents_dedup_key ON public.ops_incidents (dedup_key);

ALTER TABLE public.ops_incidents
  ADD CONSTRAINT chk_ops_incidents_severity
  CHECK (severity IN ('info', 'warning', 'error', 'critical'));
