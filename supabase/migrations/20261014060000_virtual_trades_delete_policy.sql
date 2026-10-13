-- Allow admin/editor to delete virtual trades (for re-running simulations).

drop policy if exists "Admin panel can delete virtual_trades" on public.virtual_trades;
create policy "Admin panel can delete virtual_trades"
on public.virtual_trades
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role = any (array['admin'::text, 'editor'::text])
  )
);

grant delete on table public.virtual_trades to authenticated;
