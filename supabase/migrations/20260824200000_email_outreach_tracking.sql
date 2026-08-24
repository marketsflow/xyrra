-- Resend open/click/delivery tracking for outreach recipients

alter table public.email_outreach_recipients
  add column if not exists delivery_status text not null default 'sent'
    check (delivery_status in ('sent', 'delivered', 'bounced', 'complained', 'failed')),
  add column if not exists open_count integer not null default 0 check (open_count >= 0),
  add column if not exists click_count integer not null default 0 check (click_count >= 0),
  add column if not exists first_opened_at timestamptz,
  add column if not exists last_opened_at timestamptz,
  add column if not exists first_clicked_at timestamptz,
  add column if not exists last_clicked_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

update public.email_outreach_recipients
set delivery_status = 'failed'
where status = 'failed'
  and delivery_status = 'sent';

comment on column public.email_outreach_recipients.delivery_status is
  'Resend delivery state for this recipient email (starts as sent/failed, then webhook updates).';

create unique index if not exists email_outreach_recipients_resend_email_id_uidx
  on public.email_outreach_recipients (resend_email_id)
  where resend_email_id is not null;

drop trigger if exists email_outreach_recipients_set_updated_at on public.email_outreach_recipients;
create trigger email_outreach_recipients_set_updated_at
before update on public.email_outreach_recipients
for each row execute function public.set_updated_at();

create table if not exists public.email_outreach_events (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.email_outreach_recipients (id) on delete cascade,
  event_type text not null check (event_type in ('opened', 'clicked', 'delivered', 'bounced', 'complained')),
  link_url text,
  ip_address text,
  user_agent text,
  occurred_at timestamptz not null,
  resend_event_id text not null unique,
  created_at timestamptz not null default now()
);

comment on table public.email_outreach_events is
  'Individual Resend webhook events (opens, clicks, delivery) for outreach recipient emails.';

create index if not exists email_outreach_events_recipient_id_idx
  on public.email_outreach_events (recipient_id);

create index if not exists email_outreach_events_occurred_at_idx
  on public.email_outreach_events (occurred_at desc);

alter table public.email_outreach_events enable row level security;

drop policy if exists "Admin panel can read email_outreach_events" on public.email_outreach_events;
create policy "Admin panel can read email_outreach_events"
on public.email_outreach_events
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

grant select, insert, update, delete on table public.email_outreach_events to anon, authenticated, service_role;
