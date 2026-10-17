-- Simplify sizing to percent of CLOB collateral only (remove fixed USD mode).

update public.live_trade_settings
set position_sizing_mode = 'percent_collateral'
where position_sizing_mode is distinct from 'percent_collateral';

alter table public.live_trade_settings
  drop constraint if exists live_trade_settings_sizing_mode_check;

alter table public.live_trade_settings
  drop constraint if exists live_trade_settings_position_size_check;

alter table public.live_trade_settings
  drop column if exists position_sizing_mode;

alter table public.live_trade_settings
  drop column if exists position_size_usd;

comment on column public.live_trade_settings.position_size_pct is
  'Percent of current CLOB collateral to stake per live signal (e.g. 10 = 10%).';
