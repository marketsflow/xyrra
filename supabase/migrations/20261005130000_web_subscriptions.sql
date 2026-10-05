-- Web app entitlements. Authenticated users can read their own row.
-- They cannot insert or update it. Checkout, webhooks, and the service role grant Pro.

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan text not null,
  status text not null default 'active',
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_plan_check check (plan in ('monthly', 'yearly')),
  constraint subscriptions_status_check check (status in ('active', 'trialing', 'canceled', 'past_due'))
);

alter table public.subscriptions enable row level security;

create policy "Users can read their own subscription"
on public.subscriptions
for select
to authenticated
using (auth.uid() = user_id);
