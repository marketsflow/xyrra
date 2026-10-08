-- Virtual / paper trades for the Xyrra Predictive + Polymarket execution simulator.

create table if not exists public.virtual_trades (
  id bigint generated always as identity primary key,
  timestamp timestamptz not null default now(),
  market_slug text not null,
  token_id text not null,
  direction text not null,
  entry_poly_price numeric(6, 4) not null,
  entry_spot_price numeric(12, 2) not null,
  strike_price numeric(12, 2) not null,
  xyrra_confidence numeric(5, 4) not null,
  signal_state text not null,
  position_size_usd numeric(10, 2) not null default 100.00,
  status text not null default 'OPEN',
  exit_poly_price numeric(6, 4),
  pnl_usd numeric(10, 2),
  pnl_percent numeric(8, 4),
  closed_at timestamptz,
  constraint virtual_trades_direction_check
    check (direction = any (array['LONG_UP'::text, 'LONG_DOWN'::text])),
  constraint virtual_trades_status_check
    check (status = any (array['OPEN'::text, 'WIN'::text, 'LOSS'::text]))
);

comment on table public.virtual_trades is
  'Paper trades from the Xyrra virtual execution engine (Polymarket BTC up/down).';

create index if not exists idx_virtual_trades_status
  on public.virtual_trades (status);

create index if not exists idx_virtual_trades_timestamp_idx
  on public.virtual_trades (timestamp desc);

create index if not exists idx_virtual_trades_market_slug_idx
  on public.virtual_trades (market_slug);

alter table public.virtual_trades enable row level security;

drop policy if exists "Admin panel can read virtual_trades" on public.virtual_trades;
create policy "Admin panel can read virtual_trades"
on public.virtual_trades
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

grant select, insert, update, delete on table public.virtual_trades to service_role;
grant select on table public.virtual_trades to authenticated;

do $$
begin
  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'S'
      and c.relname = 'virtual_trades_id_seq'
  ) then
    grant usage, select on sequence public.virtual_trades_id_seq to service_role;
  end if;
end $$;
