// Всё, что хранится в Supabase: цветы, поливы, фото и пара служебных значений.

import { createClient } from '@supabase/supabase-js';
import { config, PHOTO_BUCKET } from './config.js';
import { todayLocal, daysBetween } from './dates.js';

export const supabase = createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false } });

function check({ data, error }) {
  if (error) throw new Error('База не ответила: ' + error.message);
  return data;
}

// ───── служебные значения (хозяйка бота, последний скан, отметки о напоминалках) ─────

export async function getValue(key) {
  const row = check(await supabase.from('kv').select('value').eq('key', key).maybeSingle());
  return row ? row.value : null;
}
export async function setValue(key, value) {
  check(await supabase.from('kv').upsert({ key, value }));
}
export async function deleteValue(key) {
  check(await supabase.from('kv').delete().eq('key', key));
}

// ───── цветы ─────

export async function getPlants() {
  return check(await supabase.from('plants').select('*').order('created_at').order('id'));
}
export async function getPlant(id) {
  return check(await supabase.from('plants').select('*').eq('id', id).maybeSingle());
}
export async function addPlant(plant) {
  return check(await supabase.from('plants').insert(plant).select().single());
}
export async function updatePlant(id, fields) {
  check(await supabase.from('plants').update(fields).eq('id', id));
}
export async function deletePlant(id) {
  const plant = await getPlant(id);
  check(await supabase.from('plants').delete().eq('id', id));
  if (plant?.photo_path) await supabase.storage.from(PHOTO_BUCKET).remove([plant.photo_path]);
}

// ───── поливы ─────

async function lastWaterings() {
  const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const rows = check(await supabase.from('waterings').select('plant_id, day').gte('day', since).order('day', { ascending: false }));
  const last = {};
  for (const r of rows) if (!last[r.plant_id]) last[r.plant_id] = r.day;
  return last;
}

export async function toggleWater(plantId, day) {
  const exists = check(await supabase.from('waterings').select('day').eq('plant_id', plantId).eq('day', day).maybeSingle());
  if (exists) check(await supabase.from('waterings').delete().eq('plant_id', plantId).eq('day', day)); // повторное нажатие отменяет
  else check(await supabase.from('waterings').insert({ plant_id: plantId, day }));
}

export async function waterAllDue(day) {
  const due = (await buildState()).plants.filter((p) => p.dueIn <= 0 && !p.wateredToday);
  if (due.length) check(await supabase.from('waterings').upsert(due.map((p) => ({ plant_id: p.id, day }))));
  return due.length;
}

// Всё, что нужно экрану приложения.
export async function buildState() {
  const today = todayLocal();
  const [plants, last] = await Promise.all([getPlants(), lastWaterings()]);
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

export async function uploadPhoto(path, bytes) {
  check(await supabase.storage.from(PHOTO_BUCKET).upload(path, bytes, { contentType: 'image/jpeg', upsert: true }));
}

// Последний скан ждёт, пока его сохранят: в новый цветок или в существующий.
export async function keepPending(bytes, scan) {
  await uploadPhoto('pending.jpg', bytes);
  await setValue('scan:pending', scan);
}

export async function savePending(target) {
  const scan = await getValue('scan:pending');
  if (!scan) throw Object.assign(new Error('Скан потерялся, сфоткай ещё раз'), { status: 400 });
  let plant;
  if (target === 'new') {
    plant = await addPlant({ id: 'p' + Date.now().toString(36), name: scan.name, every: scan.every, scan });
  } else {
    plant = await getPlant(target);
    if (!plant) throw Object.assign(new Error('Нет такого цветка'), { status: 400 });
  }
  // Имя файла новое при каждом скане, чтобы телефон не показывал старое фото из кэша.
  const path = `${plant.id}-${Date.now().toString(36)}.jpg`;
  check(await supabase.storage.from(PHOTO_BUCKET).copy('pending.jpg', path));
  if (plant.photo_path) await supabase.storage.from(PHOTO_BUCKET).remove([plant.photo_path]);
  await updatePlant(plant.id, { scan, photo_path: path });
  await deleteValue('scan:pending');
  return plant;
}
