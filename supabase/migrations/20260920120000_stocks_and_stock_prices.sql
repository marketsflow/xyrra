-- Stocks + end-of-day stock prices (structure ported from mysql_strowz.stocks / mysql_strowz.stock_prices)

create table if not exists public.stocks (
  id bigint generated always as identity primary key,
  stock text not null,
  enable_for_trading boolean not null default false,
  created_at timestamptz not null default now(),
  constraint stocks_stock_unique unique (stock)
);

comment on table public.stocks is
  'Tradable stock symbols. Structure ported from mysql_strowz.stocks.';

create index if not exists stocks_enable_for_trading_idx
  on public.stocks (enable_for_trading);

alter table public.stocks enable row level security;

drop policy if exists "Admin panel can read stocks" on public.stocks;
create policy "Admin panel can read stocks"
on public.stocks
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

grant select, insert, update, delete on table public.stocks to service_role;
grant select on table public.stocks to authenticated;

-- Ported from mysql_strowz.stock_prices, with open/high/low added for full EOD candles.
create table if not exists public.stock_prices (
  id bigint generated always as identity primary key,
  stock text not null references public.stocks (stock) on delete cascade,
  stock_cycle_id text,
  stock_portfolio integer not null default 0,
  date date not null,
  open numeric(10, 3),
  high numeric(10, 3),
  low numeric(10, 3),
  close numeric(10, 3) not null,
  volume bigint,
  percent numeric(10, 2),
  peak_fall numeric(10, 2),
  trough_rise numeric(10, 2),
  wk_percent numeric(10, 2),
  created_at timestamptz not null default now(),
  constraint stock_prices_stock_date_unique unique (stock, date)
);

comment on table public.stock_prices is
  'End-of-day stock prices fetched from the EODHD API. Structure ported from mysql_strowz.stock_prices, plus open/high/low.';

create index if not exists stock_prices_stock_idx
  on public.stock_prices (stock);

create index if not exists stock_prices_date_idx
  on public.stock_prices (date desc);

alter table public.stock_prices enable row level security;

drop policy if exists "Admin panel can read stock_prices" on public.stock_prices;
create policy "Admin panel can read stock_prices"
on public.stock_prices
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

grant select, insert, update, delete on table public.stock_prices to service_role;
grant select on table public.stock_prices to authenticated;
