-- Price-action classification flags aligned to crypto_prices bucket starts.
-- Written by /api/compute-crypto-ma immediately after bar characteristics.

create table if not exists public.crypto_price_action (
  asset_id bigint not null
    references public.crypto_assets (id)
    on delete cascade,

  -- 1m, 5m, 15m, 1h, 4h, 1D
  timeframe integer not null
    check (timeframe in (1, 5, 15, 60, 240, 1440)),

  timestamp timestamptz not null,

  -- Candle strength
  is_strong_bullish boolean not null default false,
  is_strong_bearish boolean not null default false,

  -- Candlestick patterns
  is_doji boolean not null default false,
  is_hammer boolean not null default false,
  is_shooting_star boolean not null default false,

  -- Momentum / structure
  is_momentum boolean not null default false,
  is_inside_bar boolean not null default false,
  is_engulfing boolean not null default false,
  engulfing_direction smallint
    check (engulfing_direction in (-1, 1)),

  -- Breakouts
  is_breakout boolean not null default false,
  breakout_direction smallint
    check (breakout_direction in (-1, 1)),

  -- Breakdowns
  is_breakdown boolean not null default false,

  -- Rejection
  is_rejection boolean not null default false,
  rejection_direction smallint
    check (rejection_direction in (-1, 1)),

  -- Volume
  is_high_volume boolean not null default false,

  primary key (asset_id, timeframe, timestamp)
);

create index if not exists idx_crypto_price_action_lookup
  on public.crypto_price_action (asset_id, timeframe, timestamp desc);

comment on table public.crypto_price_action is
  'Price-action classification flags. Written by /api/compute-crypto-ma after bar characteristics.';

alter table public.crypto_price_action enable row level security;

drop policy if exists "Admin panel can read crypto_price_action"
  on public.crypto_price_action;
create policy "Admin panel can read crypto_price_action"
on public.crypto_price_action
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

grant select, insert, update, delete on table public.crypto_price_action to service_role;
grant select on table public.crypto_price_action to authenticated;
