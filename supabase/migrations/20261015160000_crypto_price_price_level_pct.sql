-- % move of price_level vs the prior crypto_price bar (frozen at bar open).

alter table public.crypto_price
  add column if not exists price_level_pct numeric(18, 6);

comment on column public.crypto_price.price_level_pct is
  'Percent change vs prior bar price_level: (level - prev) / prev * 100. Fixed at bucket open; does not tick with live close.';
