-- Xyrra admin: profiles table + role-based access (mirrors BeAnywhere pattern)

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  email text,
  avatar_url text,
  role text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_role_check check (role in ('user', 'editor', 'admin'))
);

create index if not exists profiles_role_idx on public.profiles (role);

alter table public.profiles enable row level security;

create policy "Profiles are viewable by everyone"
on public.profiles
for select
to public
using (true);

create policy "Users can insert their own profile"
on public.profiles
for insert
to authenticated
with check (auth.uid() = id);

create policy "Users can update their own profile"
on public.profiles
for update
to authenticated
using (auth.uid() = id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m jsonb;
  v_full text;
  v_email text;
  v_avatar text;
begin
  m := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_email := new.email;

  v_full := nullif(btrim(m->>'full_name'), '');
  if v_full is null then
    v_full := nullif(btrim(m->>'name'), '');
  end if;

  v_avatar := nullif(btrim(coalesce(m->>'avatar_url', m->>'picture')), '');

  insert into public.profiles (id, full_name, email, avatar_url)
  values (new.id, v_full, v_email, v_avatar)
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();
