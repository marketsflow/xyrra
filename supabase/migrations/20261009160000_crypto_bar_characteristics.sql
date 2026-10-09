-- Per-candle structure metrics aligned to crypto_prices bucket starts.
-- Written by /api/compute-crypto-ma immediately after MA upserts.

create table if not exists public.crypto_bar_characteristics (
  asset_id bigint not null
    references public.crypto_assets (id)
    on delete cascade,
  -- 1m, 5m, 15m, 1h, 4h, 1D
  timeframe integer not null
    check (timeframe in (1, 5, 15, 60, 240, 1440)),
  timestamp timestamptz not null,

  -- Price movement vs previous close
  price_change_pct double precision,

  -- Candle direction: 1 bullish, 0 neutral, -1 bearish
  direction smallint,

  -- Candle size
  body double precision,
  body_pct double precision,
  range double precision,
  range_pct double precision,

  -- Wicks
  upper_wick double precision,
  lower_wick double precision,

  -- Candle structure
  body_to_range double precision,
  close_position double precision,

  primary key (asset_id, timeframe, timestamp)
);

create index if not exists idx_bar_characteristics_lookup
  on public.crypto_bar_characteristics (asset_id, timeframe, timestamp desc);

comment on table public.crypto_bar_characteristics is
  'OHLCV-derived candle structure metrics. Written by /api/compute-crypto-ma after MA compute.';

alter table public.crypto_bar_characteristics enable row level security;

drop policy if exists "Admin panel can read crypto_bar_characteristics"
  on public.crypto_bar_characteristics;
create policy "Admin panel can read crypto_bar_characteristics"
on public.crypto_bar_characteristics
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

grant select, insert, update, delete on table public.crypto_bar_characteristics to service_role;
grant select on table public.crypto_bar_characteristics to authenticated;
