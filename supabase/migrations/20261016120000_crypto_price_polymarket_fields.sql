-- Polymarket market label + BTC price to beat on each crypto_price (4h) row.
-- Filled by compute-crypto-price from polymarket_events / ticks (BTC only).

alter table public.crypto_price
  add column if not exists market_title text,
  add column if not exists price_to_beat numeric(18, 6);

comment on column public.crypto_price.market_title is
  'Polymarket market label for this 4h window (e.g. Bitcoin Up or Down - October 16, 12:00AM-4:00AM ET). BTC only.';

comment on column public.crypto_price.price_to_beat is
  'Polymarket BTC price to beat (strike) for this 4h window from polymarket_events / ticks. BTC only.';
