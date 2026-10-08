-- Crypto assets + multi-timeframe OHLCV (1m is source of truth; higher TFs materialized on close).
-- Idempotent: remote may already have a partial crypto_assets table from the SQL editor.

create table if not exists public.crypto_assets (
  id bigint generated always as identity primary key,
  symbol text not null,
  name text,
  exchange text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  constraint crypto_assets_symbol_unique unique (symbol)
);

alter table public.crypto_assets
  add column if not exists name text;

alter table public.crypto_assets
  add column if not exists exchange text;

alter table public.crypto_assets
  add column if not exists enabled boolean not null default true;

alter table public.crypto_assets
  add column if not exists created_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'crypto_assets_symbol_unique'
      and conrelid = 'public.crypto_assets'::regclass
  ) then
    alter table public.crypto_assets
      add constraint crypto_assets_symbol_unique unique (symbol);
  end if;
end $$;

comment on table public.crypto_assets is
  'Tradable crypto symbols. Dimension table for candle data.';

create index if not exists crypto_assets_enabled_idx
  on public.crypto_assets (enabled);

create table if not exists public.crypto_prices (
  asset_id bigint not null
    references public.crypto_assets (id)
    on delete cascade,
  -- Timeframe in minutes:
  --   1     = 1m   (raw captured data)
  --   5     = 5m
  --   15    = 15m
  --   30    = 30m
  --   60    = 1h
  --   120   = 2h
  --   240   = 4h
  --   360   = 6h
  --   720   = 12h
  --   1440  = 1D
  --   10080 = 1W
  timeframe smallint not null
    check (timeframe in (1, 5, 15, 30, 60, 120, 240, 360, 720, 1440, 10080)),
  bucket_start timestamptz not null, -- candle open time (UTC, truncated to timeframe)
  open numeric(24, 8) not null,
  high numeric(24, 8) not null,
  low numeric(24, 8) not null,
  close numeric(24, 8) not null,
  volume numeric(28, 8),
  primary key (asset_id, timeframe, bucket_start)
);

comment on table public.crypto_prices is
  'OHLCV candles. Capture timeframe=1 every minute; materialize higher TFs on candle close.';

create index if not exists crypto_prices_bucket_start_idx
  on public.crypto_prices (bucket_start);

alter table public.crypto_assets enable row level security;
alter table public.crypto_prices enable row level security;

drop policy if exists "Admin panel can read crypto_assets" on public.crypto_assets;
create policy "Admin panel can read crypto_assets"
on public.crypto_assets
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can read crypto_prices" on public.crypto_prices;
create policy "Admin panel can read crypto_prices"
on public.crypto_prices
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

grant select, insert, update, delete on table public.crypto_assets to service_role;
grant select on table public.crypto_assets to authenticated;

grant select, insert, update, delete on table public.crypto_prices to service_role;
grant select on table public.crypto_prices to authenticated;

do $$
begin
  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'S'
      and c.relname = 'crypto_assets_id_seq'
  ) then
    grant usage, select on sequence public.crypto_assets_id_seq to service_role;
  end if;
end $$;

-- Seed BTC for Binance USDT 1m ingest. Existing remote schema may require base/quote.
do $$
declare
  has_base boolean;
  has_quote boolean;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'crypto_assets' and column_name = 'base_asset'
  ) into has_base;
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'crypto_assets' and column_name = 'quote_asset'
  ) into has_quote;

  if has_base and has_quote then
    execute $sql$
      insert into public.crypto_assets (symbol, name, exchange, base_asset, quote_asset)
      values ('BTC', 'Bitcoin', 'binance', 'BTC', 'USDT')
      on conflict (symbol) do update
      set
        name = coalesce(public.crypto_assets.name, excluded.name),
        exchange = coalesce(public.crypto_assets.exchange, excluded.exchange),
        base_asset = coalesce(public.crypto_assets.base_asset, excluded.base_asset),
        quote_asset = coalesce(public.crypto_assets.quote_asset, excluded.quote_asset)
    $sql$;
  else
    insert into public.crypto_assets (symbol, name, exchange)
    values ('BTC', 'Bitcoin', 'binance')
    on conflict (symbol) do update
    set
      name = coalesce(public.crypto_assets.name, excluded.name),
      exchange = coalesce(public.crypto_assets.exchange, excluded.exchange);
  end if;
end $$;
