-- Live Polymarket trades placed by the automation bot from Price Levels signals.

create table if not exists public.live_trades (
  id bigint generated always as identity primary key,
  timestamp timestamptz not null default now(),
  market_slug text not null,
  market_title text,
  token_id text not null,
  direction text not null,
  entry_poly_price numeric(6, 4) not null,
  entry_spot_price numeric(12, 2),
  strike_price numeric(12, 2),
  price_to_beat numeric(12, 6),
  price_level numeric(18, 6),
  crypto_price_at timestamptz,
  xyrra_confidence numeric(5, 4),
  signal_state text not null,
  signal_rule smallint,
  position_size_usd numeric(12, 2) not null,
  position_size_pct numeric(8, 4),
  order_id text,
  order_status text,
  making_amount text,
  taking_amount text,
  trade_ids text[],
  status text not null default 'OPEN',
  exit_poly_price numeric(6, 4),
  pnl_usd numeric(12, 2),
  pnl_percent numeric(8, 4),
  closed_at timestamptz,
  error_message text,
  constraint live_trades_direction_check
    check (direction = any (array['LONG_UP'::text, 'LONG_DOWN'::text])),
  constraint live_trades_status_check
    check (status = any (array['PENDING'::text, 'OPEN'::text, 'WIN'::text, 'LOSS'::text, 'FAILED'::text]))
);

comment on table public.live_trades is
  'Real Polymarket CLOB trades placed by the live automation bot (BTC 4h up/down).';

comment on column public.live_trades.signal_rule is
  'crypto_price.signal_rule that fired the live order (1–21).';

comment on column public.live_trades.status is
  'PENDING while placing; OPEN after accept; WIN/LOSS after window settle; FAILED on reject/error.';

create unique index if not exists live_trades_market_slug_uidx
  on public.live_trades (market_slug);

create index if not exists idx_live_trades_status
  on public.live_trades (status);

create index if not exists idx_live_trades_timestamp_idx
  on public.live_trades (timestamp desc);

alter table public.live_trades enable row level security;

drop policy if exists "Admin panel can read live_trades" on public.live_trades;
create policy "Admin panel can read live_trades"
on public.live_trades
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can update live_trades" on public.live_trades;
create policy "Admin panel can update live_trades"
on public.live_trades
for update
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
)
with check (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can delete live_trades" on public.live_trades;
create policy "Admin panel can delete live_trades"
on public.live_trades
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

grant select, update, delete on table public.live_trades to authenticated;
grant select, insert, update, delete on table public.live_trades to service_role;

do $$
begin
  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'S'
      and c.relname = 'live_trades_id_seq'
  ) then
    grant usage, select on sequence public.live_trades_id_seq to service_role;
  end if;
end $$;
