-- 20260309_polling_leases.sql
-- Назначение: таблица аренд (lease) для поллингов адаптеров платёжных систем.
-- Используется для координации multi-DC: в каждый момент времени только один инстанс
-- приложения владеет lease для конкретного poller'а (ecards.transactions, stellarcards.cards и т.п.).
-- EP3 / multi-DC: polling coordination.

CREATE TABLE IF NOT EXISTS public.polling_leases (
  id          text PRIMARY KEY,                           -- логический идентификатор poller'а (ecards.transactions, ecards.cards, ...),
  holder      text      NOT NULL,                         -- идентификатор инстанса (например, host:pid или INSTANCE_ID),
  acquired_at timestamptz NOT NULL DEFAULT NOW(),         -- когда lease был захвачен текущим holder'ом,
  expires_at  timestamptz NOT NULL                        -- до какого момента lease считается действительным
);

CREATE INDEX IF NOT EXISTS idx_polling_leases_expires_at
  ON public.polling_leases (expires_at);

