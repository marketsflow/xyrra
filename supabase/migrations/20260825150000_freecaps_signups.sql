-- Free Caps Community giveaway signups (/freecaps-community)

create table if not exists public.freecaps_signups (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null,
  kickstarter_notify_confirmed boolean not null default false,
  signed_up_at timestamptz not null default now(),
  constraint freecaps_signups_email_unique unique (email),
  constraint freecaps_signups_kickstarter_notify_confirmed_check
    check (kickstarter_notify_confirmed = true)
);

comment on table public.freecaps_signups is
  'Giveaway signups from /freecaps-community. Kickstarter notify confirmation required.';

create index if not exists freecaps_signups_signed_up_at_idx
  on public.freecaps_signups (signed_up_at desc);

create index if not exists freecaps_signups_email_idx
  on public.freecaps_signups (email);

alter table public.freecaps_signups enable row level security;

drop policy if exists "Admin panel can read freecaps_signups" on public.freecaps_signups;
create policy "Admin panel can read freecaps_signups"
on public.freecaps_signups
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

grant select, insert, update, delete on table public.freecaps_signups to service_role;
grant select on table public.freecaps_signups to authenticated;
