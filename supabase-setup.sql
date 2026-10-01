-- Выполнить один раз: Supabase → SQL Editor → New query → вставить всё → Run.

-- Места на карте. Всё содержимое метки хранится в поле data (jsonb).
create table if not exists public.places (
  id          text primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Кто может редактировать карту.
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

alter table public.places enable row level security;
alter table public.admins enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- Смотреть места могут все.
drop policy if exists "places: read for everyone" on public.places;
create policy "places: read for everyone" on public.places
  for select using (true);

-- Добавлять / менять / удалять — только админы.
drop policy if exists "places: write for admins" on public.places;
create policy "places: write for admins" on public.places
  for all using (public.is_admin()) with check (public.is_admin());

-- Админ видит только свою запись (нужно сайту, чтобы понять, что ты админ).
drop policy if exists "admins: read own" on public.admins;
create policy "admins: read own" on public.admins
  for select using (user_id = auth.uid());

-- ↓ После того как создашь себе пользователя (Authentication → Users → Add user),
--   впиши его email и выполни эту строку отдельно:
-- insert into public.admins (user_id) select id from auth.users where email = 'ТВОЙ_EMAIL';
