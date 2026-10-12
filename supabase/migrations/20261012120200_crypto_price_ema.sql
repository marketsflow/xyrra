-- Add ema (0–50) to crypto_price history rows.

alter table public.crypto_price
  add column if not exists ema numeric(8, 4);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'crypto_price_ema_check'
      and conrelid = 'public.crypto_price'::regclass
  ) then
    alter table public.crypto_price
      add constraint crypto_price_ema_check
      check (ema is null or (ema >= 0 and ema <= 50));
  end if;
end $$;

comment on column public.crypto_price.ema is
  'Cross-TF EMA score (0–50): +10 when latest crypto_moving_averages.ema_9_20_factor is bullish (1) for each of 5m/15m/1h/4h/1D; 0 when neutral/bearish/missing.';
