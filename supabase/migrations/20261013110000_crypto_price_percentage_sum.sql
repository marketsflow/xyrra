-- Sum of the last 4 × 4h crypto_prices.percentage values at this snapshot.

alter table public.crypto_price
  add column if not exists percentage_sum numeric(12, 6);

comment on column public.crypto_price.percentage_sum is
  'Sum of the last 4 crypto_prices.percentage values on timeframe 4h (as of bucket_start). Null when fewer than 4 bars or any percentage is missing.';
