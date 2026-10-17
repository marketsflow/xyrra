-- Position sizing: fixed USD or percent of current CLOB collateral.

alter table public.live_trade_settings
  add column if not exists position_sizing_mode text not null default 'fixed_usd',
  add column if not exists position_size_pct numeric(6, 2) not null default 10.00;

alter table public.live_trade_settings
  drop constraint if exists live_trade_settings_sizing_mode_check;

alter table public.live_trade_settings
  add constraint live_trade_settings_sizing_mode_check
  check (position_sizing_mode = any (array['fixed_usd'::text, 'percent_collateral'::text]));

alter table public.live_trade_settings
  drop constraint if exists live_trade_settings_position_pct_check;

alter table public.live_trade_settings
  add constraint live_trade_settings_position_pct_check
  check (position_size_pct > 0 and position_size_pct <= 100);

comment on column public.live_trade_settings.position_sizing_mode is
  'fixed_usd = use position_size_usd; percent_collateral = stake = collateral × (position_size_pct / 100).';

comment on column public.live_trade_settings.position_size_pct is
  'Percent of current CLOB collateral to stake when mode is percent_collateral (e.g. 10 = 10%).';

comment on column public.live_trade_settings.position_size_usd is
  'Fixed USD stake per live signal when mode is fixed_usd.';
