-- Remove country from freecaps_signups (if the initial migration was already applied)

alter table public.freecaps_signups
  drop column if exists country;
