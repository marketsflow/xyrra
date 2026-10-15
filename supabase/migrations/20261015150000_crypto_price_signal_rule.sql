-- Which signal rule (1–9) produced crypto_price.signal; null when no signal.

alter table public.crypto_price
  add column if not exists signal_rule smallint;

comment on column public.crypto_price.signal_rule is
  'First-matching signal rule number (1–9) that set signal. Null when signal is null.';
