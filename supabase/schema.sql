-- Выполнить один раз в Supabase: SQL Editor → New query → вставить всё → Run.
-- Бот многопользовательский: у каждого человека в Telegram свои цветы.

create table if not exists users (
  id bigint primary key,              -- id человека в Telegram
  chat_id bigint not null,            -- куда слать напоминалки
  name text,
  pending_scan jsonb,                 -- последний скан, который ещё не сохранили
  reminded_morning date,
  reminded_evening date,
  created_at timestamptz not null default now()
);

create table if not exists plants (
  id text primary key,
  user_id bigint references users(id) on delete cascade,
  name text not null,
  every int not null default 7 check (every between 1 and 60),
  scan jsonb,
  photo_path text,
  created_at timestamptz not null default now()
);
create index if not exists plants_user_id on plants(user_id);

create table if not exists waterings (
  plant_id text not null references plants(id) on delete cascade,
  day date not null,
  primary key (plant_id, day)
);

-- Доступ только у сервера (по секретному ключу service_role), снаружи таблицы закрыты.
alter table users enable row level security;
alter table plants enable row level security;
alter table waterings enable row level security;

-- Публичная корзина для фото цветов.
insert into storage.buckets (id, name, public) values ('photos', 'photos', true)
on conflict (id) do nothing;
