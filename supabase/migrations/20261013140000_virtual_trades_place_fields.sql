-- Extend virtual_trades for admin "Place Trade" from crypto_price + Polymarket ticks.

alter table public.virtual_trades
  add column if not exists market_title text,
  add column if not exists crypto_price_at timestamptz,
  add column if not exists price_level numeric(20, 8),
  add column if not exists price_to_beat numeric(18, 6);

comment on column public.virtual_trades.market_title is
  'Polymarket-style label, e.g. Bitcoin Up or Down - October 13, 12:00AM-4:00AM ET';

comment on column public.virtual_trades.crypto_price_at is
  'crypto_price.bucket_start used for signal / price_level (typically the 4h window start).';

comment on column public.virtual_trades.price_level is
  'crypto_price.price_level at crypto_price_at.';

comment on column public.virtual_trades.price_to_beat is
  'Polymarket strike (price to beat) at trade entry. Mirrors strike_price when both are set.';

comment on column public.virtual_trades.strike_price is
  'Polymarket price to beat at entry (legacy column; prefer price_to_beat).';

comment on column public.virtual_trades.signal_state is
  'crypto_price.signal at entry (e.g. Above / Below).';

comment on column public.virtual_trades.entry_spot_price is
  'Spot from the first available Polymarket tick at/after the 4h window start.';

-- One virtual trade per market window.
create unique index if not exists virtual_trades_market_slug_uidx
  on public.virtual_trades (market_slug);

drop policy if exists "Admin panel can insert virtual_trades" on public.virtual_trades;
create policy "Admin panel can insert virtual_trades"
on public.virtual_trades
for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can update virtual_trades" on public.virtual_trades;
create policy "Admin panel can update virtual_trades"
on public.virtual_trades
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

grant insert, update, delete on table public.virtual_trades to authenticated;
