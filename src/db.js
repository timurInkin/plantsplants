// Всё, что хранится в Supabase: люди, их цветы, поливы и фото.
// Бот многопользовательский: у каждого человека в Telegram своя коллекция цветов.

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { config, PHOTO_BUCKET } from './config.js';
import { todayLocal, daysBetween } from './dates.js';

export const supabase = createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false } });

function check({ data, error }) {
  if (error) throw new Error('База не ответила: ' + error.message);
  return data;
}

const notFound = () => Object.assign(new Error('Нет такого цветка'), { status: 400 });

// ───── люди ─────

export async function getUser(id) {
  return check(await supabase.from('users').select('*').eq('id', id).maybeSingle());
}

// Человек появляется в базе, как только написал боту. chat_id нужен для напоминалок.
export async function touchUser(id, chatId, name) {
  const user = await getUser(id);
  if (user) return { user, isNew: false };
  const created = check(await supabase.from('users').insert({ id, chat_id: chatId, name: name || null }).select().single());
  return { user: created, isNew: true };
}

export async function updateUser(id, fields) {
  check(await supabase.from('users').update(fields).eq('id', id));
}

export async function getUsers() {
  return check(await supabase.from('users').select('*'));
}

// ───── цветы ─────

export async function getPlants(uid) {
  return check(await supabase.from('plants').select('*').eq('user_id', uid).order('created_at').order('id'));
}
export async function getPlant(uid, id) {
  if (!id) return null;
  return check(await supabase.from('plants').select('*').eq('user_id', uid).eq('id', id).maybeSingle());
}
async function addPlant(uid, plant) {
  const id = 'p' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  return check(await supabase.from('plants').insert({ ...plant, id, user_id: uid }).select().single());
}
export async function updatePlant(uid, id, fields) {
  check(await supabase.from('plants').update(fields).eq('user_id', uid).eq('id', id));
}
export async function deletePlant(uid, id) {
  const plant = await getPlant(uid, id);
  if (!plant) throw notFound();
  check(await supabase.from('plants').delete().eq('user_id', uid).eq('id', id));
  if (plant.photo_path) await supabase.storage.from(PHOTO_BUCKET).remove([plant.photo_path]);
}

// ───── поливы ─────

async function lastWaterings(plantIds) {
  if (!plantIds.length) return {};
  const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const rows = check(await supabase.from('waterings').select('plant_id, day')
    .in('plant_id', plantIds).gte('day', since).order('day', { ascending: false }));
  const last = {};
  for (const r of rows) if (!last[r.plant_id]) last[r.plant_id] = r.day;
  return last;
}

export async function toggleWater(uid, plantId, day) {
  if (!(await getPlant(uid, plantId))) throw notFound();
  const exists = check(await supabase.from('waterings').select('day').eq('plant_id', plantId).eq('day', day).maybeSingle());
  if (exists) check(await supabase.from('waterings').delete().eq('plant_id', plantId).eq('day', day)); // повторное нажатие отменяет
  else check(await supabase.from('waterings').insert({ plant_id: plantId, day }));
}

export async function waterAllDue(uid, day) {
  const due = (await buildState(uid)).plants.filter((p) => p.dueIn <= 0 && !p.wateredToday);
  if (due.length) check(await supabase.from('waterings').upsert(due.map((p) => ({ plant_id: p.id, day }))));
  return due.length;
}

// Всё, что нужно экрану приложения.
export async function buildState(uid) {
  const today = todayLocal();
  const plants = await getPlants(uid);
  const last = await lastWaterings(plants.map((p) => p.id));
  return {
    today,
    plants: plants.map((p) => {
      const lastDay = last[p.id] || null;
      return {
        id: p.id, name: p.name, every: p.every, scan: p.scan,
        last: lastDay,
        dueIn: lastDay ? p.every - daysBetween(lastDay, today) : 0,
        wateredToday: lastDay === today,
        photo: p.photo_path ? photoUrl(p.photo_path) : null,
      };
    }),
  };
}

// ───── фото ─────

export function photoUrl(path) {
  return supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;
}

const pendingPath = (uid) => `pending/${uid}.jpg`;

// Последний скан ждёт, пока его сохранят: в новый цветок или в существующий. У каждого человека свой.
export async function keepPending(uid, bytes, scan) {
  check(await supabase.storage.from(PHOTO_BUCKET).upload(pendingPath(uid), bytes, { contentType: 'image/jpeg', upsert: true }));
  await updateUser(uid, { pending_scan: scan });
}

export async function savePending(uid, target) {
  const user = await getUser(uid);
  const scan = user?.pending_scan;
  if (!scan) throw Object.assign(new Error('Скан потерялся, сфоткай ещё раз'), { status: 400 });
  let plant;
  if (target === 'new') {
    plant = await addPlant(uid, { name: scan.name, every: scan.every, scan });
  } else {
    plant = await getPlant(uid, target);
    if (!plant) throw notFound();
  }
  // Имя файла новое при каждом скане, чтобы телефон не показывал старое фото из кэша.
  const path = `${uid}/${plant.id}-${Date.now().toString(36)}.jpg`;
  check(await supabase.storage.from(PHOTO_BUCKET).copy(pendingPath(uid), path));
  if (plant.photo_path) await supabase.storage.from(PHOTO_BUCKET).remove([plant.photo_path]);
  await updatePlant(uid, plant.id, { scan, photo_path: path });
  await updateUser(uid, { pending_scan: null });
  return plant;
}
