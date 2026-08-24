-- Public storage bucket for images inserted into email template bodies

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'email-templates',
  'email-templates',
  true,
  6291456,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public can read email template images" on storage.objects;
create policy "Public can read email template images"
on storage.objects
for select
to public
using (bucket_id = 'email-templates');

drop policy if exists "Admin panel can upload email template images" on storage.objects;
create policy "Admin panel can upload email template images"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'email-templates'
  and exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

drop policy if exists "Admin panel can delete email template images" on storage.objects;
create policy "Admin panel can delete email template images"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'email-templates'
  and exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);
