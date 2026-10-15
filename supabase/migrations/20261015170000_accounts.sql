-- Paper trading account: starts at $10, balance moves with settled virtual_trades P&L.

create table if not exists public.accounts (
  id bigint generated always as identity primary key,
  name text not null default 'Virtual paper account',
  starting_balance_usd numeric(12, 2) not null default 10.00,
  balance_usd numeric(12, 2) not null default 10.00,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounts_starting_balance_check check (starting_balance_usd >= 0)
);

comment on table public.accounts is
  'Paper account balance for the virtual trades simulator. Starts at $10; updates from settled P&L.';

create table if not exists public.account_transactions (
  id bigint generated always as identity primary key,
  account_id bigint not null references public.accounts (id) on delete cascade,
  virtual_trade_id bigint references public.virtual_trades (id) on delete set null,
  kind text not null,
  amount_usd numeric(12, 2) not null,
  balance_after_usd numeric(12, 2) not null,
  description text,
  created_at timestamptz not null default now(),
  constraint account_transactions_kind_check
    check (kind = any (array[
      'opening'::text,
      'trade_pnl'::text,
      'trade_pnl_reversal'::text,
      'adjustment'::text
    ]))
);

comment on table public.account_transactions is
  'Ledger rows for accounts: opening balance and each virtual trade P&L (or reversal).';

create index if not exists idx_account_transactions_account_created
  on public.account_transactions (account_id, created_at desc);

create unique index if not exists account_transactions_trade_pnl_uidx
  on public.account_transactions (virtual_trade_id)
  where kind = 'trade_pnl' and virtual_trade_id is not null;

-- Seed the single paper account used by admin.
insert into public.accounts (name, starting_balance_usd, balance_usd)
select 'Virtual paper account', 10.00, 10.00
where not exists (select 1 from public.accounts);

insert into public.account_transactions (account_id, kind, amount_usd, balance_after_usd, description)
select a.id, 'opening', a.starting_balance_usd, a.starting_balance_usd, 'Opening balance'
from public.accounts a
where not exists (
  select 1 from public.account_transactions t
  where t.account_id = a.id and t.kind = 'opening'
);

-- Apply P&L when a virtual trade is settled (OPEN → WIN/LOSS with pnl_usd).
create or replace function public.apply_virtual_trade_pnl_to_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  acct public.accounts%rowtype;
  pnl numeric(12, 2);
  new_balance numeric(12, 2);
begin
  if tg_op = 'UPDATE' then
    -- Settled for the first time
    if old.status = 'OPEN'
       and new.status in ('WIN', 'LOSS')
       and new.pnl_usd is not null then
      select * into acct from public.accounts order by id asc limit 1 for update;
      if not found then
        return new;
      end if;

      -- Skip if already booked for this trade
      if exists (
        select 1 from public.account_transactions
        where virtual_trade_id = new.id and kind = 'trade_pnl'
      ) then
        return new;
      end if;

      pnl := new.pnl_usd;
      new_balance := acct.balance_usd + pnl;

      update public.accounts
      set balance_usd = new_balance, updated_at = now()
      where id = acct.id;

      insert into public.account_transactions (
        account_id, virtual_trade_id, kind, amount_usd, balance_after_usd, description
      ) values (
        acct.id,
        new.id,
        'trade_pnl',
        pnl,
        new_balance,
        coalesce(new.market_title, new.market_slug) || ' · ' || new.status
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists virtual_trades_apply_pnl_to_account on public.virtual_trades;
create trigger virtual_trades_apply_pnl_to_account
after update of status, pnl_usd on public.virtual_trades
for each row
execute function public.apply_virtual_trade_pnl_to_account();

-- Reverse booked P&L when a settled trade is deleted.
create or replace function public.reverse_virtual_trade_pnl_on_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  acct public.accounts%rowtype;
  booked numeric(12, 2);
  new_balance numeric(12, 2);
begin
  if old.status not in ('WIN', 'LOSS') or old.pnl_usd is null then
    return old;
  end if;

  select amount_usd into booked
  from public.account_transactions
  where virtual_trade_id = old.id and kind = 'trade_pnl'
  limit 1;

  if booked is null then
    return old;
  end if;

  select * into acct from public.accounts order by id asc limit 1 for update;
  if not found then
    return old;
  end if;

  new_balance := acct.balance_usd - booked;

  update public.accounts
  set balance_usd = new_balance, updated_at = now()
  where id = acct.id;

  insert into public.account_transactions (
    account_id, virtual_trade_id, kind, amount_usd, balance_after_usd, description
  ) values (
    acct.id,
    null,
    'trade_pnl_reversal',
    -booked,
    new_balance,
    'Reversal · deleted trade #' || old.id || ' · '
      || coalesce(old.market_title, old.market_slug)
  );

  delete from public.account_transactions
  where virtual_trade_id = old.id and kind = 'trade_pnl';

  return old;
end;
$$;

drop trigger if exists virtual_trades_reverse_pnl_on_delete on public.virtual_trades;
create trigger virtual_trades_reverse_pnl_on_delete
before delete on public.virtual_trades
for each row
execute function public.reverse_virtual_trade_pnl_on_delete();

-- Backfill: book P&L for already-settled trades that have no ledger row yet.
do $$
declare
  acct public.accounts%rowtype;
  trade record;
  new_balance numeric(12, 2);
begin
  select * into acct from public.accounts order by id asc limit 1 for update;
  if not found then
    return;
  end if;

  new_balance := acct.balance_usd;

  for trade in
    select vt.*
    from public.virtual_trades vt
    where vt.status in ('WIN', 'LOSS')
      and vt.pnl_usd is not null
      and not exists (
        select 1 from public.account_transactions t
        where t.virtual_trade_id = vt.id and t.kind = 'trade_pnl'
      )
    order by coalesce(vt.closed_at, vt.timestamp) asc, vt.id asc
  loop
    new_balance := new_balance + trade.pnl_usd;
    insert into public.account_transactions (
      account_id, virtual_trade_id, kind, amount_usd, balance_after_usd, description, created_at
    ) values (
      acct.id,
      trade.id,
      'trade_pnl',
      trade.pnl_usd,
      new_balance,
      coalesce(trade.market_title, trade.market_slug) || ' · ' || trade.status,
      coalesce(trade.closed_at, trade.timestamp, now())
    );
  end loop;

  update public.accounts
  set balance_usd = new_balance, updated_at = now()
  where id = acct.id;
end $$;

alter table public.accounts enable row level security;
alter table public.account_transactions enable row level security;

drop policy if exists "Admin panel can read accounts" on public.accounts;
create policy "Admin panel can read accounts"
on public.accounts
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can read account_transactions" on public.account_transactions;
create policy "Admin panel can read account_transactions"
on public.account_transactions
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

grant select on table public.accounts to authenticated;
grant select on table public.account_transactions to authenticated;
grant select, insert, update, delete on table public.accounts to service_role;
grant select, insert, update, delete on table public.account_transactions to service_role;

do $$
begin
  if exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S' and c.relname = 'accounts_id_seq'
  ) then
    grant usage, select on sequence public.accounts_id_seq to service_role;
  end if;
  if exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S' and c.relname = 'account_transactions_id_seq'
  ) then
    grant usage, select on sequence public.account_transactions_id_seq to service_role;
  end if;
end $$;
