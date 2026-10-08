-- Polymarket short-window event metadata + price ticks (BTC up/down, etc.)
-- Safe to re-run when tables already exist with a partial / older schema.

create table if not exists public.polymarket_events (
  id text primary key
);

alter table public.polymarket_events add column if not exists asset text;
alter table public.polymarket_events add column if not exists slug text;
alter table public.polymarket_events add column if not exists title text;
alter table public.polymarket_events add column if not exists market_id text;
alter table public.polymarket_events add column if not exists condition_id text;
alter table public.polymarket_events add column if not exists up_token_id text;
alter table public.polymarket_events add column if not exists down_token_id text;
alter table public.polymarket_events add column if not exists start_at timestamptz;
alter table public.polymarket_events add column if not exists end_at timestamptz;
alter table public.polymarket_events add column if not exists updated_at timestamptz default now();

update public.polymarket_events set asset = coalesce(asset, 'btc') where asset is null;
update public.polymarket_events set slug = coalesce(slug, id) where slug is null;
update public.polymarket_events set updated_at = coalesce(updated_at, now()) where updated_at is null;

alter table public.polymarket_events alter column asset set not null;
alter table public.polymarket_events alter column slug set not null;
alter table public.polymarket_events alter column updated_at set default now();
alter table public.polymarket_events alter column updated_at set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'polymarket_events_slug_unique'
      and conrelid = 'public.polymarket_events'::regclass
  ) then
    alter table public.polymarket_events
      add constraint polymarket_events_slug_unique unique (slug);
  end if;
end $$;

comment on table public.polymarket_events is
  'Active/recent Polymarket up/down events discovered during ingest.';

create index if not exists polymarket_events_asset_end_at_idx
  on public.polymarket_events (asset, end_at desc);

create table if not exists public.polymarket_ticks (
  id bigint generated always as identity primary key
);

alter table public.polymarket_ticks add column if not exists asset text;
alter table public.polymarket_ticks add column if not exists symbol text;
alter table public.polymarket_ticks add column if not exists event_id text;
alter table public.polymarket_ticks add column if not exists event_slug text;
alter table public.polymarket_ticks add column if not exists market_id text;
alter table public.polymarket_ticks add column if not exists question text;
alter table public.polymarket_ticks add column if not exists condition_id text;
alter table public.polymarket_ticks add column if not exists up_token_id text;
alter table public.polymarket_ticks add column if not exists down_token_id text;
alter table public.polymarket_ticks add column if not exists up_price numeric(12, 6);
alter table public.polymarket_ticks add column if not exists down_price numeric(12, 6);
alter table public.polymarket_ticks add column if not exists up_bid numeric(12, 6);
alter table public.polymarket_ticks add column if not exists up_ask numeric(12, 6);
alter table public.polymarket_ticks add column if not exists down_bid numeric(12, 6);
alter table public.polymarket_ticks add column if not exists down_ask numeric(12, 6);
alter table public.polymarket_ticks add column if not exists market_end_at timestamptz;
alter table public.polymarket_ticks add column if not exists recorded_at timestamptz default now();

-- Prefer an existing timestamp column if the table was created earlier without recorded_at.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'polymarket_ticks' and column_name = 'created_at'
  ) then
    update public.polymarket_ticks
    set recorded_at = coalesce(recorded_at, created_at, now())
    where recorded_at is null;
  else
    update public.polymarket_ticks
    set recorded_at = coalesce(recorded_at, now())
    where recorded_at is null;
  end if;
end $$;

update public.polymarket_ticks set asset = coalesce(asset, 'btc') where asset is null;
update public.polymarket_ticks set symbol = coalesce(symbol, 'BTC') where symbol is null;

alter table public.polymarket_ticks alter column asset set not null;
alter table public.polymarket_ticks alter column symbol set not null;
alter table public.polymarket_ticks alter column recorded_at set default now();
alter table public.polymarket_ticks alter column recorded_at set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'polymarket_ticks_event_id_fkey'
      and conrelid = 'public.polymarket_ticks'::regclass
  ) then
    begin
      alter table public.polymarket_ticks
        add constraint polymarket_ticks_event_id_fkey
        foreign key (event_id) references public.polymarket_events (id)
        on delete set null;
    exception
      when others then
        -- Skip FK if existing rows cannot satisfy it.
        raise notice 'Skipping polymarket_ticks_event_id_fkey: %', sqlerrm;
    end;
  end if;
end $$;

comment on table public.polymarket_ticks is
  'Point-in-time Polymarket Up/Down prices polled by /api/ingest-polymarket.';

create index if not exists polymarket_ticks_recorded_at_idx
  on public.polymarket_ticks (recorded_at desc);

create index if not exists polymarket_ticks_asset_recorded_at_idx
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

do $$
begin
  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'S'
      and c.relname = 'polymarket_ticks_id_seq'
  ) then
    grant usage, select on sequence public.polymarket_ticks_id_seq to service_role;
  end if;
end $$;
