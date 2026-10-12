-- Switch crypto_price from live upsert (one row per asset/tf) to
-- minute-by-minute history (one row per asset/tf/1m bucket).
-- Safe no-op if 20261012120000 already created the history shape.

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'crypto_price'
      and column_name = 'bucket_start'
  ) then
    return;
  end if;

  alter table public.crypto_price
    add column if not exists bucket_start timestamptz;

  -- Backfill existing live rows to their updated_at minute so the NOT NULL can apply.
  update public.crypto_price
  set bucket_start = date_trunc('minute', coalesce(updated_at, created_at, now()))
  where bucket_start is null;

  alter table public.crypto_price
    alter column bucket_start set not null;

  alter table public.crypto_price
    drop constraint if exists crypto_price_asset_id_timeframe_key;

  alter table public.crypto_price
    drop constraint if exists crypto_price_asset_id_timeframe_bucket_start_key;

  alter table public.crypto_price
    add constraint crypto_price_asset_id_timeframe_bucket_start_key
    unique (asset_id, timeframe, bucket_start);

  drop index if exists idx_crypto_price_lookup;
  create index if not exists idx_crypto_price_lookup
    on public.crypto_price (asset_id, timeframe, bucket_start desc);

  comment on table public.crypto_price is
    'Minute-by-minute support/resistance proximity and signal history per asset/timeframe.';

  comment on column public.crypto_price.bucket_start is
    '1-minute candle start this snapshot is aligned to.';
end $$;
