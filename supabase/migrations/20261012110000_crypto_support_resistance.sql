-- Support / resistance cycles per asset + timeframe (5m, 15m, 1h, 4h, 1D).
-- Levels = min/max close over a 30-bar window. One active cycle per asset/TF;
-- a close beyond ±3% of a level ends the cycle and opens a new historical row.
--
-- Drop any prior draft shape (timestamp PK without cycle columns) before create.

drop table if exists public.crypto_support_resistance cascade;

create table public.crypto_support_resistance (
  -- Cycle identity (use this id when referring to a timeframe's level cycle)
  id uuid primary key default gen_random_uuid(),

  asset_id bigint not null
    references public.crypto_assets (id)
    on delete cascade,

  -- 5m, 15m, 1h, 4h, 1D
  timeframe integer not null
    check (timeframe in (5, 15, 60, 240, 1440)),

  -- Monotonic cycle sequence per asset + timeframe (1, 2, 3, ...)
  cycle_seq integer not null,

  -- Absolute levels from close prices at cycle open
  support numeric(20, 8) not null,
  resistance numeric(20, 8) not null,

  -- Lifecycle
  started_at timestamptz not null,
  ended_at timestamptz,
  status text not null default 'active'
    check (status in ('active', 'breached_support', 'breached_resistance')),

  -- Breach details (set when status leaves active)
  breach_close numeric(20, 8),
  breach_at timestamptz,

  -- Latest proximity event while active (or last state before breach)
  -- hover = close within ±3% of the level; ignored for cycle rollover
  hover_side text
    check (hover_side is null or hover_side in ('support', 'resistance')),
  hover_at timestamptz,
  last_close numeric(20, 8),
  last_checked_at timestamptz,

  created_at timestamptz not null default now(),

  unique (asset_id, timeframe, cycle_seq),
  check (resistance >= support),
  check (
    (status = 'active' and ended_at is null)
    or (status <> 'active' and ended_at is not null)
  )
);

-- Only one open cycle per asset + timeframe
create unique index crypto_support_resistance_active_uidx
  on public.crypto_support_resistance (asset_id, timeframe)
  where status = 'active';

create index idx_crypto_support_resistance_lookup
  on public.crypto_support_resistance (asset_id, timeframe, cycle_seq desc);

create index idx_crypto_support_resistance_started
  on public.crypto_support_resistance (asset_id, timeframe, started_at desc);

comment on table public.crypto_support_resistance is
  'Historical support/resistance cycles. id is the cycle id per asset/timeframe; new row on breach.';

comment on column public.crypto_support_resistance.id is
  'Cycle id — refer to this when joining other tables to a timeframe level cycle.';

comment on column public.crypto_support_resistance.support is
  'Lowest close in the 30-bar window at cycle open.';

comment on column public.crypto_support_resistance.resistance is
  'Highest close in the 30-bar window at cycle open.';

comment on column public.crypto_support_resistance.hover_side is
  'Most recent level the close was within ±3% of (does not open a new cycle).';

alter table public.crypto_support_resistance enable row level security;

drop policy if exists "Admin panel can read crypto_support_resistance"
  on public.crypto_support_resistance;
create policy "Admin panel can read crypto_support_resistance"
on public.crypto_support_resistance
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

grant select, insert, update, delete on table public.crypto_support_resistance to service_role;
grant select on table public.crypto_support_resistance to authenticated;
