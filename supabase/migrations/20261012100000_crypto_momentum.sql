-- Multi-timeframe momentum vectors per asset tick / bar close.
-- Unique on (asset_symbol, timestamp, config_id) for parameter-set variants.

create table if not exists public.crypto_momentum (
  -- Primary & Identity Keys
  id uuid primary key default gen_random_uuid(),
  asset_symbol varchar(20) not null,            -- e.g., 'BTC-USD', 'ETH-USD', or Polymarket Token ID
  timestamp timestamptz not null,               -- Tick / Bar close timestamp

  -- Configuration Reference
  config_id varchar(50) not null default 'default_v1',  -- ID of the user-defined momentum parameter set

  -- Multi-Timeframe Momentum Vectors (Normalized Range: -1.0 to +1.0 or Z-Scores)
  mom_1m numeric(8, 4),                         -- 1-minute window momentum score
  mom_5m numeric(8, 4),                         -- 5-minute window momentum score
  mom_15m numeric(8, 4),                        -- 15-minute window momentum score
  mom_1h numeric(8, 4),                         -- 1-hour window momentum score
  mom_4h numeric(8, 4),                         -- 4-hour window momentum score
  mom_1d numeric(8, 4),                         -- 1-day window momentum score

  -- Directional Confluence Metrics
  timeframe_confluence_score numeric(5, 4),     -- Alignment index across timeframes (-1.0 to +1.0)
  dominant_timeframe varchar(10),               -- Timeframe exhibiting highest momentum magnitude

  -- Raw Parameter & User Customization Metadata
  custom_params jsonb not null default '{}'::jsonb,  -- Stores user-defined calculation rules (e.g., weights, ROC periods)

  -- Model Training Metadata
  created_at timestamptz not null default now(),

  -- Constraints
  unique (asset_symbol, timestamp, config_id)
);

-- Time-series lookup indexes
create index if not exists idx_crypto_momentum_lookup
  on public.crypto_momentum (asset_symbol, timestamp desc);

create index if not exists idx_crypto_momentum_config
  on public.crypto_momentum (config_id);

comment on table public.crypto_momentum is
  'Multi-timeframe momentum scores and confluence metrics per asset/timestamp/config.';

alter table public.crypto_momentum enable row level security;

drop policy if exists "Admin panel can read crypto_momentum"
  on public.crypto_momentum;
create policy "Admin panel can read crypto_momentum"
on public.crypto_momentum
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

grant select, insert, update, delete on table public.crypto_momentum to service_role;
grant select on table public.crypto_momentum to authenticated;
