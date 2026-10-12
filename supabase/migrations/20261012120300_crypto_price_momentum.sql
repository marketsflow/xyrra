-- Add momentum score column to crypto_price history rows.

alter table public.crypto_price
  add column if not exists momentum numeric(8, 4);

comment on column public.crypto_price.momentum is
  'From crypto_momentum at the same timestamp when present (prefers mom_4h; else first non-null mom_*). Null when no matching momentum row.';
