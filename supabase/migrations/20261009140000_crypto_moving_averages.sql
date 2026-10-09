-- SMA/EMA snapshots per asset + timeframe (1m, 5m, 15m, 1h, 4h, 1D).
-- Idempotent: safe if the table was already created in the SQL editor.

create table if not exists public.crypto_moving_averages (
  asset_id bigint not null
    references public.crypto_assets (id)
    on delete cascade,
  -- 1m, 5m, 15m, 1h, 4h, 1D
  timeframe integer not null
    check (timeframe in (1, 5, 15, 60, 240, 1440)),
  timestamp timestamptz not null,
  sma_20 double precision,
  sma_50 double precision,
  ema_9 double precision,
  ema_20 double precision,
  ema_50 double precision,
  primary key (asset_id, timeframe, timestamp)
);

create index if not exists idx_crypto_ma_lookup
  on public.crypto_moving_averages (asset_id, timeframe, timestamp desc);

comment on table public.crypto_moving_averages is
  'SMA/EMA values aligned to candle bucket starts. Written by /api/compute-crypto-ma cron.';

alter table public.crypto_moving_averages enable row level security;

drop policy if exists "Admin panel can read crypto_moving_averages" on public.crypto_moving_averages;
create policy "Admin panel can read crypto_moving_averages"
on public.crypto_moving_averages
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

grant select, insert, update, delete on table public.crypto_moving_averages to service_role;
grant select on table public.crypto_moving_averages to authenticated;
