-- Public articles edited in /admin/articles and served at /articles/{slug}/

create table if not exists public.articles (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  title text not null,
  meta_title text,
  meta_description text,
  excerpt text,
  body_html text not null default '',
  key_points text[] not null default '{}',
  faqs jsonb not null default '[]'::jsonb,
  hero_image_url text,
  hero_image_alt text,
  keywords text[] not null default '{}',
  author_name text not null default 'Xyrra Editorial Team',
  status text not null default 'draft',
  published_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint articles_slug_key unique (slug),
  constraint articles_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint articles_status_check check (status in ('draft', 'published'))
);

create index if not exists articles_status_published_at_idx
  on public.articles (status, published_at desc);

create or replace function public.articles_before_save()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  if new.status = 'published' and new.published_at is null then
    new.published_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists articles_before_save on public.articles;
create trigger articles_before_save
before insert or update on public.articles
for each row execute function public.articles_before_save();

alter table public.articles enable row level security;

drop policy if exists "Published articles are public" on public.articles;
create policy "Published articles are public"
on public.articles
for select
to public
using (status = 'published');

drop policy if exists "Admin panel can read articles" on public.articles;
create policy "Admin panel can read articles"
on public.articles
for select
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can insert articles" on public.articles;
create policy "Admin panel can insert articles"
on public.articles
for insert
to authenticated
with check (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can update articles" on public.articles;
create policy "Admin panel can update articles"
on public.articles
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

drop policy if exists "Admin panel can delete articles" on public.articles;
create policy "Admin panel can delete articles"
on public.articles
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

insert into public.articles (
  slug,
  title,
  meta_title,
  meta_description,
  excerpt,
  body_html,
  key_points,
  faqs,
  keywords,
  author_name,
  status,
  published_at
) values (
  'how-xyrra-ai-insights-work',
  'How Xyrra AI insights work',
  'How Xyrra AI insights work',
  'Xyrra publishes AI insights for stocks, crypto, and portfolios. This article explains what those insights show, which time windows they use, and what they do not claim.',
  'Xyrra is an AI insights app for stocks, crypto, and portfolios. The public site shows performance, individual insights, and alerts that point back to the research. Those insights are educational. They are not financial advice.',
  '<h2>What an insight is</h2><p>An insight is a research note generated from Xyrra''s models. It names a stock, crypto asset, or portfolio and shows how that idea has performed over a recent window. The point of the page is to make the research readable, not to place a trade for you.</p><h2>Stocks, crypto, and portfolios</h2><p>AI Stocks and AI Crypto each have a live view, a performance view, and a historical view. The live view shows what is open now. Performance ranks recent results. History lists closed ideas.</p><p>AI Portfolios groups ideas into lists such as best performing, trending, AI recommended, and lower risk. A portfolio insight is about the basket, not a single ticker.</p><h2>The time windows</h2><p>Performance on the public dashboard is shown for the last 24 hours, 7 days, and 30 days. A short window can move a lot. A 30-day window is slower and often more useful for comparing ideas with each other.</p><h2>What this is not</h2><p>An insight is not a promise of future returns, and it is not a personal recommendation. Markets can move against a recent result. Read the research, then decide on your own or with a regulated adviser.</p>',
  array[
    'Insights cover stocks, crypto, and portfolios',
    'Performance uses 24-hour, 7-day, and 30-day windows',
    'Insights are educational and are not financial advice'
  ],
  '[
    {"question":"Are Xyrra insights financial advice?","answer":"No. Xyrra insights are educational research. They are not a recommendation to buy, sell, or hold any asset."},
    {"question":"Where can I see current insights?","answer":"The public pages are Performance, AI Stocks, AI Crypto, and AI Portfolios on xyrra.ai. Signing in opens the same research in the app."},
    {"question":"How often do the numbers change?","answer":"Live insights change as positions open and close. The 24-hour, 7-day, and 30-day performance windows are recalculated from those results."}
  ]'::jsonb,
  array['Xyrra', 'AI stock insights', 'AI crypto insights', 'AI portfolios'],
  'Xyrra Editorial Team',
  'published',
  '2026-10-06T04:00:00Z'
)
on conflict (slug) do nothing;
