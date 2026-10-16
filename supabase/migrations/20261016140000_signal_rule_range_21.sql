-- Signal rules now span 1–21 (new winner clusters 15–21 on unsignaled BTC 4h bars).

comment on column public.crypto_price.signal_rule is
  'First-matching signal rule number (1–21) that set signal. Null when signal is null.';

comment on column public.virtual_trades.signal_rule is
  'crypto_price.signal_rule at entry (first-matching rule 1–21). Null when unknown.';
