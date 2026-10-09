-- Close-to-previous-close percent change on each crypto_prices candle.
-- Written by ingest-crypto (1m) and compute-crypto-ma (higher TFs).

alter table public.crypto_prices
  add column if not exists percentage numeric(12, 6);

comment on column public.crypto_prices.percentage is
  'Percent change of this candle close vs the previous candle close on the same timeframe: ((close - prev_close) / prev_close) * 100.';

-- Backfill existing rows from lag(close) within each asset/timeframe series.
with ordered as (
  select
    asset_id,
    timeframe,
    bucket_start,
    close,
    lag(close) over (
      partition by asset_id, timeframe
      order by bucket_start
    ) as prev_close
  from public.crypto_prices
)
update public.crypto_prices cp
set percentage = round(((o.close - o.prev_close) / o.prev_close) * 100, 6)
from ordered o
where cp.asset_id = o.asset_id
  and cp.timeframe = o.timeframe
  and cp.bucket_start = o.bucket_start
  and o.prev_close is not null
  and o.prev_close <> 0;
