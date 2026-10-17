-- Singleton live-trading bot settings (admin-controlled). Automation stays off until enabled.

create table if not exists public.live_trade_settings (
  id smallint primary key default 1 check (id = 1),
  automation_enabled boolean not null default false,
  position_size_usd numeric(12, 2) not null default 1.00,
  max_open_trades integer not null default 1,
  daily_loss_limit_usd numeric(12, 2),
  allowed_signal_rules smallint[] not null default '{}'::smallint[],
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint live_trade_settings_position_size_check
    check (position_size_usd > 0 and position_size_usd <= 10000),
  constraint live_trade_settings_max_open_check
    check (max_open_trades >= 1 and max_open_trades <= 50),
  constraint live_trade_settings_daily_loss_check
    check (daily_loss_limit_usd is null or daily_loss_limit_usd > 0),
  constraint live_trade_settings_rules_check
    check (
      allowed_signal_rules <@ array[
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
        11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21
      ]::smallint[]
    )
);

comment on table public.live_trade_settings is
  'Singleton admin settings for Polymarket live trading automation. One row (id=1).';

comment on column public.live_trade_settings.automation_enabled is
  'Master switch. When false, no live orders may be placed by the bot.';

comment on column public.live_trade_settings.position_size_usd is
  'USD stake per live signal (CLOB collateral).';

comment on column public.live_trade_settings.max_open_trades is
  'Maximum concurrent OPEN live positions.';

comment on column public.live_trade_settings.daily_loss_limit_usd is
  'Optional kill switch: halt automation after this USD of realized loss today. Null = disabled.';

comment on column public.live_trade_settings.allowed_signal_rules is
  'crypto_price.signal_rule values (1–21) that may fire live. Empty = no rules (no trades).';

insert into public.live_trade_settings (
  id,
  automation_enabled,
  position_size_usd,
  max_open_trades,
  daily_loss_limit_usd,
  allowed_signal_rules,
  notes
)
values (
  1,
  false,
  1.00,
  1,
  null,
  '{}'::smallint[],
  null
)
on conflict (id) do nothing;

create or replace function public.touch_live_trade_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists live_trade_settings_touch_updated_at on public.live_trade_settings;
create trigger live_trade_settings_touch_updated_at
before update on public.live_trade_settings
for each row
execute function public.touch_live_trade_settings_updated_at();

alter table public.live_trade_settings enable row level security;

drop policy if exists "Admin panel can read live_trade_settings" on public.live_trade_settings;
create policy "Admin panel can read live_trade_settings"
on public.live_trade_settings
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can update live_trade_settings" on public.live_trade_settings;
create policy "Admin panel can update live_trade_settings"
on public.live_trade_settings
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

grant select, update on table public.live_trade_settings to authenticated;
grant select, insert, update, delete on table public.live_trade_settings to service_role;
