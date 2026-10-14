CREATE TABLE IF NOT EXISTS public.bankcards_balances (
  bank        text        NOT NULL DEFAULT 'ecards',
  ext_id      integer     NOT NULL,
  branch_id   uuid,
  name        text,
  currency    text,
  balance     numeric,
  updated_at  timestamptz,
  PRIMARY KEY (bank, ext_id)
);
