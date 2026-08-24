-- Email templates, lists, members, and imported users (created in local Studio)

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.old_users (
  id uuid primary key default gen_random_uuid(),
  old_id bigint unique,
  name text,
  f_name text,
  l_name text,
  email text,
  created timestamptz not null default now()
);

create index if not exists old_users_email_idx on public.old_users (email);

create table if not exists public.email_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subject text not null,
  body_html text not null,
  from_email text not null default 'Xyrra <onboarding@resend.dev>',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_templates_name_idx on public.email_templates (name);
create index if not exists email_templates_updated_at_idx on public.email_templates (updated_at desc);

drop trigger if exists email_templates_set_updated_at on public.email_templates;
create trigger email_templates_set_updated_at
before update on public.email_templates
for each row execute function public.set_updated_at();

create table if not exists public.email_lists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_lists_name_idx on public.email_lists (name);
create index if not exists email_lists_updated_at_idx on public.email_lists (updated_at desc);

drop trigger if exists email_lists_set_updated_at on public.email_lists;
create trigger email_lists_set_updated_at
before update on public.email_lists
for each row execute function public.set_updated_at();

create table if not exists public.email_list_members (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.email_lists (id) on delete cascade,
  name text,
  email text not null,
  created_at timestamptz not null default now(),
  old_user_id uuid references public.old_users (id) on delete set null,
  constraint email_list_members_list_email_unique unique (list_id, email)
);

create index if not exists email_list_members_email_idx on public.email_list_members (email);
create index if not exists email_list_members_list_id_idx on public.email_list_members (list_id);
create index if not exists email_list_members_old_user_id_idx on public.email_list_members (old_user_id);

alter table public.old_users enable row level security;
alter table public.email_templates enable row level security;
alter table public.email_lists enable row level security;
alter table public.email_list_members enable row level security;

drop policy if exists "Admin panel can read old_users" on public.old_users;
create policy "Admin panel can read old_users"
on public.old_users
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can read email_templates" on public.email_templates;
create policy "Admin panel can read email_templates"
on public.email_templates
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can insert email_templates" on public.email_templates;
create policy "Admin panel can insert email_templates"
on public.email_templates
for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can update email_templates" on public.email_templates;
create policy "Admin panel can update email_templates"
on public.email_templates
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

drop policy if exists "Admin panel can delete email_templates" on public.email_templates;
create policy "Admin panel can delete email_templates"
on public.email_templates
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can read email_lists" on public.email_lists;
create policy "Admin panel can read email_lists"
on public.email_lists
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can insert email_lists" on public.email_lists;
create policy "Admin panel can insert email_lists"
on public.email_lists
for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can update email_lists" on public.email_lists;
create policy "Admin panel can update email_lists"
on public.email_lists
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

drop policy if exists "Admin panel can delete email_lists" on public.email_lists;
create policy "Admin panel can delete email_lists"
on public.email_lists
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can read email_list_members" on public.email_list_members;
create policy "Admin panel can read email_list_members"
on public.email_list_members
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can insert email_list_members" on public.email_list_members;
create policy "Admin panel can insert email_list_members"
on public.email_list_members
for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can update email_list_members" on public.email_list_members;
create policy "Admin panel can update email_list_members"
on public.email_list_members
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

drop policy if exists "Admin panel can delete email_list_members" on public.email_list_members;
create policy "Admin panel can delete email_list_members"
on public.email_list_members
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

grant select, insert, update, delete on table public.old_users to anon, authenticated, service_role;
grant select, insert, update, delete on table public.email_templates to anon, authenticated, service_role;
grant select, insert, update, delete on table public.email_lists to anon, authenticated, service_role;
grant select, insert, update, delete on table public.email_list_members to anon, authenticated, service_role;
