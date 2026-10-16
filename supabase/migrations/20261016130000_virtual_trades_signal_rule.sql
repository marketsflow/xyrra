-- Store which crypto_price signal rule produced the trade signal at entry.

alter table public.virtual_trades
  add column if not exists signal_rule smallint;

comment on column public.virtual_trades.signal_rule is
  'crypto_price.signal_rule at entry (first-matching rule 1–12). Null when unknown.';
