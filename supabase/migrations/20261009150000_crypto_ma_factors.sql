-- Cross factors for crypto moving averages:
--   1  = short MA above long MA
--  -1  = short MA below long MA
--   0  = equal
--  null when either MA is missing

alter table public.crypto_moving_averages
  add column if not exists sma_20_50_factor smallint;

alter table public.crypto_moving_averages
  add column if not exists ema_9_20_factor smallint;

alter table public.crypto_moving_averages
  add column if not exists ema_20_50_factor smallint;

comment on column public.crypto_moving_averages.sma_20_50_factor is
  '1 if sma_20 > sma_50, -1 if sma_20 < sma_50, 0 if equal, null if either missing.';

comment on column public.crypto_moving_averages.ema_9_20_factor is
  '1 if ema_9 > ema_20, -1 if ema_9 < ema_20, 0 if equal, null if either missing.';

comment on column public.crypto_moving_averages.ema_20_50_factor is
  '1 if ema_20 > ema_50, -1 if ema_20 < ema_50, 0 if equal, null if either missing.';
