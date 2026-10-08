-- Reset Polymarket tables to the ingest schema.
-- Earlier partial tables kept legacy NOT NULL columns that blocked inserts.

drop table if exists public.polymarket_ticks cascade;
drop table if exists public.polymarket_events cascade;

create table public.polymarket_events (
  id text primary key,
  asset text not null,
  slug text not null,
  title text,
  market_id text,
  condition_id text,
  up_token_id text,
  down_token_id text,
  price_to_beat numeric(18, 6),
  start_at timestamptz,
  end_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint polymarket_events_slug_unique unique (slug)
);

comment on table public.polymarket_events is
  'Active/recent Polymarket up/down events discovered during ingest.';

create index polymarket_events_asset_end_at_idx
  on public.polymarket_events (asset, end_at desc);

create table public.polymarket_ticks (
  id bigint generated always as identity primary key,
  asset text not null,
  symbol text not null,
  event_id text references public.polymarket_events (id) on delete set null,
  event_slug text,
  market_id text,
  question text,
  condition_id text,
  up_token_id text,
  down_token_id text,
  up_price numeric(12, 6),
  down_price numeric(12, 6),
  up_bid numeric(12, 6),
  up_ask numeric(12, 6),
  down_bid numeric(12, 6),
  down_ask numeric(12, 6),
  price_to_beat numeric(18, 6),
  spot_price numeric(18, 6),
  seconds_remaining integer,
  bid_depth_top5 numeric(18, 6),
  ask_depth_top5 numeric(18, 6),
  order_book_imbalance numeric(12, 6),
  market_start_at timestamptz,
  market_end_at timestamptz,
  recorded_at timestamptz not null default now()
);

comment on table public.polymarket_ticks is
  'Point-in-time Polymarket Up/Down prices polled by /api/ingest-polymarket.';

create index polymarket_ticks_recorded_at_idx
  on public.polymarket_ticks (recorded_at desc);

create index polymarket_ticks_asset_recorded_at_idx
  on public.polymarket_ticks (asset, recorded_at desc);

alter table public.polymarket_events enable row level security;
alter table public.polymarket_ticks enable row level security;

drop policy if exists "Admin panel can read polymarket_events" on public.polymarket_events;
create policy "Admin panel can read polymarket_events"
on public.polymarket_events
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can read polymarket_ticks" on public.polymarket_ticks;
create policy "Admin panel can read polymarket_ticks"
on public.polymarket_ticks
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

grant select, insert, update, delete on table public.polymarket_events to service_role;
grant select, insert, update, delete on table public.polymarket_ticks to service_role;
grant select on table public.polymarket_events to authenticated;
grant select on table public.polymarket_ticks to authenticated;
grant usage, select on sequence public.polymarket_ticks_id_seq to service_role;
