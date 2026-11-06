-- Выполнить один раз в Supabase: SQL Editor → New query → вставить всё → Run.
-- Бот многопользовательский: у каждого человека в Telegram свои цветы.

create table if not exists users (
  id bigint primary key,              -- id человека в Telegram
  chat_id bigint not null,            -- куда слать напоминалки
  name text,
  pending_scan jsonb,                 -- последний скан, который ещё не сохранили
  reminded_morning date,
  reminded_evening date,
  share_token text unique,            -- ссылка-приглашение в свои цветы
  created_at timestamptz not null default now()
);
alter table users add column if not exists share_token text unique;

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

-- Гостевой доступ: хозяин поделился цветами, гость видит их, отмечает полив и получает напоминалки.
create table if not exists shares (
  owner_id bigint not null references users(id) on delete cascade,
  guest_id bigint not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, guest_id)
);
create index if not exists shares_guest_id on shares(guest_id);

-- Доступ только у сервера (по секретному ключу service_role), снаружи таблицы закрыты.
alter table users enable row level security;
alter table plants enable row level security;
alter table waterings enable row level security;
alter table shares enable row level security;

-- Публичная корзина для фото цветов.
insert into storage.buckets (id, name, public) values ('photos', 'photos', true)
on conflict (id) do nothing;

-- Замеры скана: сколько шёл каждый скан, на каких шагах и какие модели отвечали.
create table if not exists scan_runs (
  id bigserial primary key,
  user_id bigint,
  created_at timestamptz not null default now(),
  total_ms integer,
  photos integer,
  model text,
  steps jsonb,
  calls jsonb,
  error text
);
create index if not exists scan_runs_created_at on scan_runs (created_at desc);
alter table scan_runs enable row level security;

-- Удобрения: что сфоткали и какой график подкормки предложила модель. У цветка в plants.feed — его удобрение,
-- как часто подкармливать и когда подкармливали последний раз.
create table if not exists fertilizers (
  id text primary key,
  user_id bigint not null references users(id) on delete cascade,
  name text not null,
  info jsonb not null default '{}'::jsonb,   -- kind, npk, form, dose, note, plan, applied
  photo_path text,
  created_at timestamptz not null default now()
);
create index if not exists fertilizers_user_id on fertilizers(user_id);
alter table fertilizers enable row level security;
alter table plants add column if not exists feed jsonb;
