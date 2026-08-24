-- Global email unsubscribe list used by outreach sends and the public unsubscribe page

create table if not exists public.email_unsubscribes (
  email text primary key,
  created_at timestamptz not null default now()
);

comment on table public.email_unsubscribes is
  'Lowercased emails that have opted out of Xyrra outreach campaigns.';

create index if not exists email_unsubscribes_created_at_idx
  on public.email_unsubscribes (created_at desc);

alter table public.email_unsubscribes enable row level security;

drop policy if exists "Admin panel can read email_unsubscribes" on public.email_unsubscribes;
create policy "Admin panel can read email_unsubscribes"
on public.email_unsubscribes
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

grant select, insert, update, delete on table public.email_unsubscribes to service_role;
grant select on table public.email_unsubscribes to authenticated;
