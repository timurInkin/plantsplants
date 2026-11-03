// Всё, что хранится в Supabase: люди, их цветы, поливы, фото и гостевой доступ.
// Бот многопользовательский: у каждого человека в Telegram своя коллекция цветов.
// Коллекцией можно поделиться: гость видит цветы, отмечает полив и получает напоминалки.
//
// Каждый запрос к Supabase — это поездка до сервера базы, поэтому их тут по возможности мало
// и независимые идут параллельно. Время всех запросов видно в логах (см. timing.js).

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { config, PHOTO_BUCKET } from './config.js';
import { todayLocal, daysBetween } from './dates.js';
import { timedFetch } from './timing.js';

export const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: false },
  global: { fetch: timedFetch },
});
const photos = () => supabase.storage.from(PHOTO_BUCKET);

function check({ data, error }) {
  if (error) throw new Error('База не ответила: ' + error.message);
  return data;
}

const fail = (message) => Object.assign(new Error(message), { status: 400 });
const notFound = () => fail('Нет такого цветка');

// ───── люди ─────

export async function getUser(id) {
  return check(await supabase.from('users').select('*').eq('id', id).maybeSingle());
}

// Человек появляется в базе, как только написал боту или открыл приложение. chat_id нужен для напоминалок.
// Кого уже видели с момента запуска, больше не проверяем: это лишний запрос на каждое нажатие.
const known = new Set();
export async function touchUser(id, chatId, name) {
  if (known.has(id)) return { isNew: false };
  let isNew = false;
  if (!(await getUser(id))) {
    check(await supabase.from('users').upsert({ id, chat_id: chatId, name: name || null }, { onConflict: 'id', ignoreDuplicates: true }));
    isNew = true;
  }
  known.add(id);
  return { isNew };
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
const newPlantId = () => 'p' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');

export async function updatePlant(uid, id, fields) {
  check(await supabase.from('plants').update(fields).eq('user_id', uid).eq('id', id));
}
export async function deletePlant(uid, plant) {
  check(await supabase.from('plants').delete().eq('user_id', uid).eq('id', plant.id));
  if (plant.photo_path) await photos().remove([plant.photo_path]);
}

// Похоже ли растение в карточке на то, что на новом скане: сравниваем род по латыни.
// false — точно разные растения, null — сравнить не по чему.
const genus = (latin) => String(latin || '').trim().split(/\s+/)[0].toLowerCase();
export function sameKind(plant, scan) {
  const a = genus(plant?.scan?.latin), b = genus(scan?.latin);
  return a && b ? a === b : null;
}

// ───── поливы ─────

// Отметка «полито сегодня». Повторное нажатие её снимает.
export async function toggleWater(plantId, day) {
  const removed = check(await supabase.from('waterings').delete().eq('plant_id', plantId).eq('day', day).select());
  if (!removed.length) check(await supabase.from('waterings').insert({ plant_id: plantId, day }));
}

// «Последний раз поливали тогда-то»: от этого дня считаем следующий полив, более поздние отметки убираем.
export async function setLastWatering(plantId, day) {
  check(await supabase.from('waterings').delete().eq('plant_id', plantId).gt('day', day));
  check(await supabase.from('waterings').upsert({ plant_id: plantId, day }));
}

export async function waterAllDue(uid, day) {
  const due = (await buildState(uid)).plants.filter((p) => p.dueIn <= 0 && !p.wateredToday);
  if (due.length) check(await supabase.from('waterings').upsert(due.map((p) => ({ plant_id: p.id, day }))));
  return due.length;
}

// Всё, что нужно экрану приложения. Один запрос: цветы вместе с последним поливом каждого.
export async function buildState(uid) {
  const today = todayLocal();
  const plants = check(await supabase.from('plants').select('*, waterings(day)').eq('user_id', uid)
    .order('created_at').order('id')
    .order('day', { referencedTable: 'waterings', ascending: false })
    .limit(1, { referencedTable: 'waterings' }));
  return {
    today,
    plants: plants.map((p) => {
      const lastDay = p.waterings?.[0]?.day || null;
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
  return photos().getPublicUrl(path).data.publicUrl;
}

// Последний скан ждёт, пока его сохранят: в новый цветок или в существующий. У каждого человека свой.
// Фото к нему может быть несколько (бот просил доснять), лежат как pending/<id>-0.jpg, -1, -2…
export const MAX_SCAN_PHOTOS = 4;
const pendingPath = (uid, i) => `pending/${uid}-${i}.jpg`;

export async function uploadPending(uid, i, bytes) {
  check(await photos().upload(pendingPath(uid, i), bytes, { contentType: 'image/jpeg', upsert: true }));
}

export async function setPending(uid, scan, count, prev = null) {
  const { prev: _older, ...previous } = prev || {};
  await updateUser(uid, { pending_scan: { ...scan, photos: count, at: Date.now(), ...(prev ? { prev: previous } : {}) } });
}

// Вернуть результат до последней досъёмки. Последнее фото остаётся в хранилище, но больше не учитывается.
export async function undoPending(uid) {
  const prev = (await getUser(uid))?.pending_scan?.prev;
  if (!prev) throw fail('Прошлого результата уже нет');
  await updateUser(uid, { pending_scan: { ...prev, at: Date.now() } });
  const { photos, at: _at, ...scan } = prev;
  return { scan, photos };
}

// Фото незавершённого скана, чтобы досланное фото разобрать вместе с ними.
export async function pendingImages(uid, count) {
  const got = await Promise.all(Array.from({ length: count }, (_, i) => photos().download(pendingPath(uid, i))));
  const out = [];
  for (const { data, error } of got) {
    if (error || !data) break;
    out.push(Buffer.from(await data.arrayBuffer()));
  }
  return out;
}

export async function savePending(uid, target) {
  const [user, existing] = await Promise.all([getUser(uid), target === 'new' ? null : getPlant(uid, target)]);
  const { photos: _count, at: _at, prev: _prev, ...scan } = user?.pending_scan || {};
  if (!scan.name) throw fail('Скан потерялся, сфоткай ещё раз');
  if (target !== 'new' && !existing) throw notFound();

  const id = existing ? existing.id : newPlantId();
  // Имя файла новое при каждом скане, чтобы телефон не показывал старое фото из кэша.
  const path = `${uid}/${id}-${Date.now().toString(36)}.jpg`;
  check(await photos().copy(pendingPath(uid, 0), path));

  let plant;
  if (existing) {
    const fields = { scan, photo_path: path };
    // Название меняется вместе со сканом, чтобы русское и латинское не расходились. Кроме случая, когда цветок переименовали вручную.
    if (!existing.scan || existing.name === existing.scan.name) fields.name = scan.name;
    await Promise.all([
      updatePlant(uid, id, fields),
      existing.photo_path ? photos().remove([existing.photo_path]) : null,
    ]);
    plant = { ...existing, ...fields };
  } else {
    plant = check(await supabase.from('plants')
      .insert({ id, user_id: uid, name: scan.name, every: scan.every, scan, photo_path: path }).select().single());
  }
  await updateUser(uid, { pending_scan: null });
  return { plant, isNew: !existing };
}

// ───── гостевой доступ ─────
// В ссылке-приглашении лежит share_token хозяина цветов. Кто её открыл, становится гостем (таблица shares).
// Пока в базе нет таблицы shares, гостевой доступ просто выключен, остальное работает.

let sharesWarned = false;
function noShares(error) {
  if (!sharesWarned) console.error('Гостевой доступ выключен: в базе нет таблицы shares. Выполни supabase/schema.sql.', error.message);
  sharesWarned = true;
  return [];
}

export async function shareToken(uid, reset = false) {
  if (!reset) {
    const user = await getUser(uid);
    if (user?.share_token) return user.share_token;
  }
  const token = crypto.randomBytes(9).toString('base64url');
  await updateUser(uid, { share_token: token });
  return token;
}

// Гость открыл ссылку. Возвращает { owner, self } или null, если ссылка недействительна.
export async function acceptInvite(guestId, token) {
  const owner = check(await supabase.from('users').select('id, name, chat_id').eq('share_token', token).maybeSingle());
  if (!owner) return null;
  if (owner.id === guestId) return { owner, self: true };
  const added = check(await supabase.from('shares')
    .upsert({ owner_id: owner.id, guest_id: guestId }, { onConflict: 'owner_id,guest_id', ignoreDuplicates: true }).select());
  return { owner, self: false, already: !added.length };
}

// Кому человек дал доступ к своим цветам: [{ id, name }].
export async function guestsOf(ownerId) {
  return check(await supabase.from('shares').select('guest_id, guest:users!shares_guest_id_fkey(name)')
    .eq('owner_id', ownerId).order('created_at'))
    .map((r) => ({ id: r.guest_id, name: r.guest?.name || 'Без имени' }));
}

// Чьи цветы человеку доверили: [{ id, name }].
export async function gardensOf(guestId) {
  const { data, error } = await supabase.from('shares').select('owner_id, owner:users!shares_owner_id_fkey(name)')
    .eq('guest_id', guestId).order('created_at');
  if (error) return noShares(error);
  return data.map((r) => ({ id: r.owner_id, name: r.owner?.name || 'Без имени' }));
}

// Все доступы разом, для утренних и вечерних напоминалок.
export async function allShares() {
  const { data, error } = await supabase.from('shares').select('owner_id, guest_id, owner:users!shares_owner_id_fkey(name)');
  if (error) return noShares(error);
  return data.map((r) => ({ owner: r.owner_id, guest: r.guest_id, name: r.owner?.name || 'Без имени' }));
}

export async function removeShare(ownerId, guestId) {
  check(await supabase.from('shares').delete().eq('owner_id', ownerId).eq('guest_id', guestId));
}
