-- Email outreach campaigns sent from the admin console

create table if not exists public.email_outreach (
  id uuid primary key default gen_random_uuid(),
  template_id uuid references public.email_templates (id) on delete set null,
  list_id uuid references public.email_lists (id) on delete set null,
  subject text not null,
  from_email text not null,
  body_html text not null,
  recipient_count integer not null default 0 check (recipient_count >= 0),
  sent_count integer not null default 0 check (sent_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  status text not null default 'draft' check (status in ('draft', 'sending', 'sent', 'failed', 'partial')),
  sent_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.email_outreach is
  'Bulk email sends from the admin Email Outreach page.';

create index if not exists email_outreach_created_at_idx
  on public.email_outreach (created_at desc);

create index if not exists email_outreach_template_id_idx
  on public.email_outreach (template_id);

create index if not exists email_outreach_list_id_idx
  on public.email_outreach (list_id);

drop trigger if exists email_outreach_set_updated_at on public.email_outreach;
create trigger email_outreach_set_updated_at
before update on public.email_outreach
for each row execute function public.set_updated_at();

create table if not exists public.email_outreach_recipients (
  id uuid primary key default gen_random_uuid(),
  outreach_id uuid not null references public.email_outreach (id) on delete cascade,
  list_member_id uuid references public.email_list_members (id) on delete set null,
  name text,
  email text not null,
  resend_email_id text,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.email_outreach_recipients is
  'Per-recipient delivery results for an email outreach send.';

create index if not exists email_outreach_recipients_outreach_id_idx
  on public.email_outreach_recipients (outreach_id);

create index if not exists email_outreach_recipients_email_idx
  on public.email_outreach_recipients (email);

alter table public.email_outreach enable row level security;
alter table public.email_outreach_recipients enable row level security;

drop policy if exists "Admin panel can read email_outreach" on public.email_outreach;
create policy "Admin panel can read email_outreach"
on public.email_outreach
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can insert email_outreach" on public.email_outreach;
create policy "Admin panel can insert email_outreach"
on public.email_outreach
for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can update email_outreach" on public.email_outreach;
create policy "Admin panel can update email_outreach"
on public.email_outreach
for update
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
)
with check (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can delete email_outreach" on public.email_outreach;
create policy "Admin panel can delete email_outreach"
on public.email_outreach
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can read email_outreach_recipients" on public.email_outreach_recipients;
create policy "Admin panel can read email_outreach_recipients"
on public.email_outreach_recipients
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can insert email_outreach_recipients" on public.email_outreach_recipients;
create policy "Admin panel can insert email_outreach_recipients"
on public.email_outreach_recipients
for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can update email_outreach_recipients" on public.email_outreach_recipients;
create policy "Admin panel can update email_outreach_recipients"
on public.email_outreach_recipients
for update
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
)
with check (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can delete email_outreach_recipients" on public.email_outreach_recipients;
create policy "Admin panel can delete email_outreach_recipients"
on public.email_outreach_recipients
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

grant select, insert, update, delete on table public.email_outreach to anon, authenticated, service_role;
grant select, insert, update, delete on table public.email_outreach_recipients to anon, authenticated, service_role;
