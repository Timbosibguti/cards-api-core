-- Ищет транзакции за март+апрель 2026 с Google Ads account id (10 цифр),
-- которых нет в finance0_ext.funds_from_account.account_id (где id может быть с дефисами).
--
-- Результат:
-- 1) все поля bank_transactions
-- 2) google_ads_id (10 цифр)
-- 3) full_card_number (отдельно)

WITH tx_base AS (
  SELECT
    bt.*,
    CASE
      WHEN upper(bt.raw::text) ~ 'GOOGLE' AND upper(bt.raw::text) ~ 'ADS'
      THEN substring(upper(bt.raw::text) FROM '(?<!\d)(\d{10})(?!\d)')
      ELSE NULL
    END AS google_ads_id,
    COALESCE(
      NULLIF(regexp_replace(bt.card_number::text, '\D', '', 'g'), ''),
      NULLIF(
        regexp_replace(
          COALESCE(
            bt.raw ->> 'card_number',
            bt.raw ->> 'cardNumber',
            bt.raw ->> 'pan',
            bt.raw ->> 'full_card_number',
            bt.raw ->> 'card',
            bt.raw #>> '{data,card_number}',
            bt.raw #>> '{transaction,card_number}'
          ),
          '\D',
          '',
          'g'
        ),
        ''
      )
    ) AS full_card_number
  FROM public.bank_transactions bt
  WHERE bt.created_at >= TIMESTAMP '2026-03-01 00:00:00'
    AND bt.created_at < TIMESTAMP '2026-05-01 00:00:00'
),
missing_google_ads AS (
  SELECT t.*
  FROM tx_base t
  WHERE t.google_ads_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM finance0_ext.funds_from_account ffa
      WHERE regexp_replace(COALESCE(ffa.account_id, ''), '\D', '', 'g') = t.google_ads_id
    )
)
SELECT *
FROM missing_google_ads
ORDER BY created_at, bank, ext_id;
