-- sim_last_network_at: последний раз симка была в сети (CREG registered); при потере сети не обновляется в коде upsert.
-- notification_tg_group_id: bigint[] (несколько TG-групп); миграция с bigint если было одно значение.

ALTER TABLE public.ota_devices ADD COLUMN IF NOT EXISTS sim_last_network_at TIMESTAMPTZ;

DO $$
DECLARE
  dt text;
BEGIN
  SELECT c.data_type INTO dt FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = 'ota_devices' AND c.column_name = 'notification_tg_group_id';
  IF dt = 'bigint' THEN
    ALTER TABLE public.ota_devices ADD COLUMN notification_tg_group_id_arr bigint[];
    UPDATE public.ota_devices SET notification_tg_group_id_arr = CASE WHEN notification_tg_group_id IS NOT NULL THEN ARRAY[notification_tg_group_id] ELSE NULL END;
    ALTER TABLE public.ota_devices DROP COLUMN notification_tg_group_id;
    ALTER TABLE public.ota_devices RENAME COLUMN notification_tg_group_id_arr TO notification_tg_group_id;
  ELSIF dt IS NULL THEN
    ALTER TABLE public.ota_devices ADD COLUMN notification_tg_group_id bigint[];
  END IF;
END $$;
