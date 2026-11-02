-- Выполнить один раз в Supabase: SQL Editor → New query → вставить всё → Run.

create table if not exists plants (
  id text primary key,
  name text not null,
  every int not null default 7 check (every between 1 and 60),
  scan jsonb,
  photo_path text,
  created_at timestamptz not null default now()
);

create table if not exists waterings (
  plant_id text not null references plants(id) on delete cascade,
  day date not null,
  primary key (plant_id, day)
);

create table if not exists kv (
  key text primary key,
  value jsonb
);

-- Доступ только у сервера (по секретному ключу service_role), снаружи таблицы закрыты.
alter table plants enable row level security;
alter table waterings enable row level security;
alter table kv enable row level security;

-- Публичная корзина для фото цветов.
insert into storage.buckets (id, name, public) values ('photos', 'photos', true)
on conflict (id) do nothing;

-- Стартовая коллекция. Дальше цветы добавляются сканером.
insert into plants (id, name, every, created_at) values
  ('monstera1', 'Монстера №1', 3, now()),
  ('monstera2', 'Монстера №2', 3, now() + interval '1 second'),
  ('pinkprince', 'Филодендрон «Розовый принц»', 3, now() + interval '2 seconds'),
  ('philodendron', 'Филодендрон', 3, now() + interval '3 seconds'),
  ('violets', 'Фиалки', 3, now() + interval '4 seconds'),
  ('maranta', 'Маранта', 3, now() + interval '5 seconds'),
  ('caladium', 'Каладиумы', 3, now() + interval '6 seconds'),
  ('alocasia', 'Алоказия', 4, now() + interval '7 seconds'),
  ('strelitzia', 'Стрелиция', 5, now() + interval '8 seconds'),
  ('aglaonema', 'Аглаонема', 7, now() + interval '9 seconds'),
  ('ficus', 'Фикус эластика', 7, now() + interval '10 seconds')
on conflict (id) do nothing;
