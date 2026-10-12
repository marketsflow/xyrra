-- Minute-by-minute proximity / signal history per asset + timeframe.
-- One new row per 1m bucket (cron inserts; idempotent on conflict).

create table if not exists public.crypto_price (
  id uuid primary key default gen_random_uuid(),

  asset_id bigint not null
    references public.crypto_assets (id)
    on delete cascade,

  -- 1m candle this snapshot is aligned to
  bucket_start timestamptz not null,

  -- Latest 1m close used as the reference price for distances / signal
  price_1m numeric(20, 8),

  -- 5m, 15m, 1h, 4h, 1D
  timeframe integer not null
    check (timeframe in (5, 15, 60, 240, 1440)),

  -- Percent (or absolute) distance of last price from active support / resistance
  distance_from_support numeric(12, 6),
  distance_to_resistance numeric(12, 6),

  -- Trading / level signal (e.g. approach, hover, breach)
  signal text,

  -- Reference price used for the distance / signal calculation
  price_level numeric(20, 8),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (asset_id, timeframe, bucket_start)
);

create index if not exists idx_crypto_price_lookup
  on public.crypto_price (asset_id, timeframe, bucket_start desc);

create index if not exists idx_crypto_price_updated
  on public.crypto_price (updated_at desc);

comment on table public.crypto_price is
  'Minute-by-minute support/resistance proximity and signal history per asset/timeframe.';

comment on column public.crypto_price.bucket_start is
  '1-minute candle start this snapshot is aligned to.';

comment on column public.crypto_price.price_1m is
  '1-minute close for bucket_start.';

comment on column public.crypto_price.distance_from_support is
  'Distance of current price from active support (convention set by writer).';

comment on column public.crypto_price.distance_to_resistance is
  'Distance of current price to active resistance (convention set by writer).';

comment on column public.crypto_price.signal is
  'Signal label for this asset/timeframe at bucket_start.';

comment on column public.crypto_price.price_level is
  'Price used when computing distances / signal.';

alter table public.crypto_price enable row level security;

drop policy if exists "Admin panel can read crypto_price"
  on public.crypto_price;
create policy "Admin panel can read crypto_price"
on public.crypto_price
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

grant select, insert, update, delete on table public.crypto_price to service_role;
grant select on table public.crypto_price to authenticated;
