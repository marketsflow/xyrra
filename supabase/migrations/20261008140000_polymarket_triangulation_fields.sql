-- Triangulation fields for Polymarket BTC 4h ticks / events.

alter table public.polymarket_events
  add column if not exists price_to_beat numeric(18, 6);

alter table public.polymarket_ticks
  add column if not exists price_to_beat numeric(18, 6);

alter table public.polymarket_ticks
  add column if not exists spot_price numeric(18, 6);

alter table public.polymarket_ticks
  add column if not exists seconds_remaining integer;

alter table public.polymarket_ticks
  add column if not exists bid_depth_top5 numeric(18, 6);

alter table public.polymarket_ticks
  add column if not exists ask_depth_top5 numeric(18, 6);

alter table public.polymarket_ticks
  add column if not exists order_book_imbalance numeric(12, 6);

alter table public.polymarket_ticks
  add column if not exists market_start_at timestamptz;

comment on column public.polymarket_events.price_to_beat is
  'BTC strike / open price from Gamma eventMetadata.priceToBeat.';

comment on column public.polymarket_ticks.price_to_beat is
  'BTC Price to Beat (strike) at ingest time.';

comment on column public.polymarket_ticks.spot_price is
  'Underlying BTC/USD spot at the moment the tick was recorded.';

comment on column public.polymarket_ticks.seconds_remaining is
  'Seconds until market_end_at when the tick was recorded.';

comment on column public.polymarket_ticks.bid_depth_top5 is
  'Sum of UP-token bid size across the best 5 price levels.';

comment on column public.polymarket_ticks.ask_depth_top5 is
  'Sum of UP-token ask size across the best 5 price levels.';

comment on column public.polymarket_ticks.order_book_imbalance is
  'OBI = (bid_depth_top5 - ask_depth_top5) / (bid_depth_top5 + ask_depth_top5).';
