-- Public images uploaded from /admin/articles for hero images and article body images

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'article-images',
  'article-images',
  true,
  6291456,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public can read article images" on storage.objects;
create policy "Public can read article images"
on storage.objects
for select
to public
using (bucket_id = 'article-images');

drop policy if exists "Admin panel can upload article images" on storage.objects;
create policy "Admin panel can upload article images"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'article-images'
  and exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can update article images" on storage.objects;
create policy "Admin panel can update article images"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'article-images'
  and exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can delete article images" on storage.objects;
create policy "Admin panel can delete article images"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'article-images'
  and exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);
