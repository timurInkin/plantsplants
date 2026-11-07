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
  const files = [plant.photo_path, ...(plant.scan?.details || []).map((d) => d.path)].filter(Boolean);
  if (files.length) await photos().remove(files);
}

// Убрать из карточки одно доснятое фото вместе с его разбором. i — номер среди доснятых, с нуля.
export async function deleteDetail(uid, plant, i) {
  const details = plant.scan?.details || [];
  const d = details[i];
  if (!d) throw fail('Этого фото уже нет');
  await Promise.all([
    updatePlant(uid, plant.id, { scan: { ...plant.scan, details: details.filter((_, k) => k !== i) } }),
    d.path ? photos().remove([d.path]) : null,
  ]);
}

// Сорт, который человек знает точно. Сканер его больше не меняет (manual), а строчку Pl@ntNet убираем: она про другое растение.
export async function setVariety(uid, plant, name, latin) {
  const fields = { name };
  if (plant.scan) {
    const { identified: _i, ...scan } = plant.scan;
    fields.scan = { ...scan, name, latin, manual: true, confidence: 'high' };
  }
  await updatePlant(uid, plant.id, fields);
  return { ...plant, ...fields };
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
  return !removed.length;
}
export async function setWatered(plantId, day, on) {
  if (on) check(await supabase.from('waterings').upsert({ plant_id: plantId, day }));
  else check(await supabase.from('waterings').delete().eq('plant_id', plantId).eq('day', day));
}

// «Последний раз поливали тогда-то»: от этого дня считаем следующий полив, более поздние отметки убираем.
export async function setLastWatering(plantId, day) {
  check(await supabase.from('waterings').delete().eq('plant_id', plantId).gt('day', day));
  check(await supabase.from('waterings').upsert({ plant_id: plantId, day }));
}

// mode: 'plain' — только обычный полив, 'feed' — только те, кого сегодня поливать с удобрением (им отмечаем и подкормку), 'all' — все.
export async function waterAllDue(uid, day, mode = 'all') {
  const state = await buildState(uid);
  const feedNow = (p) => !!p.feed?.due;
  const due = mode === 'feed'
    ? state.plants.filter((p) => (p.dueIn <= 0 || p.wateredToday) && feedNow(p))
    : state.plants.filter((p) => p.dueIn <= 0 && !p.wateredToday && (mode === 'all' || !feedNow(p)));
  if (due.length) check(await supabase.from('waterings').upsert(due.map((p) => ({ plant_id: p.id, day }))));
  const fed = mode === 'plain' ? [] : due.filter(feedNow);
  await Promise.all(fed.map((p) => markFed(uid, p.id, p.feed, day, true)));
  return due.length;
}

// ───── удобрения и подкормка ─────
// У цветка в plants.feed: { fert: id удобрения, every: раз во сколько дней (0 — пауза), dose, amount: сколько раствора вылить, why, last: день последней подкормки, prev }.
// Подкормка идёт вместе с поливом: цветок попадает в «Полив с удобрением», когда пора поливать и с прошлой подкормки прошло every дней.

const newFertId = () => 'f' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
// Пока в базе нет таблицы удобрений, остальное работает как раньше.
const noFerts = (error) => error && /fertilizers|feed/.test(error.message || '');

export async function getFertilizers(uid) {
  const { data, error } = await supabase.from('fertilizers').select('*').eq('user_id', uid).order('created_at');
  if (noFerts(error)) return [];
  return check({ data, error });
}
export async function getFertilizer(uid, id) {
  if (!id) return null;
  return check(await supabase.from('fertilizers').select('*').eq('user_id', uid).eq('id', id).maybeSingle());
}

// Фото упаковки: первое в photo_path, доснятые стороны — в info.photos.
export const MAX_FERT_PHOTOS = 4;
export const fertPhotoPaths = (row) => [row.photo_path, ...(row.info?.photos || [])].filter(Boolean);

async function uploadFertPhoto(uid, id, bytes) {
  const path = `${uid}/${id}-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}.jpg`;
  const { error } = await photos().upload(path, bytes, { contentType: 'image/jpeg', upsert: true });
  return error ? null : path;
}

export async function saveFertilizer(uid, fert, bytes) {
  const id = newFertId();
  const path = await uploadFertPhoto(uid, id, bytes);
  const { name, ...info } = fert;
  return check(await supabase.from('fertilizers')
    .insert({ id, user_id: uid, name, info: { ...info, applied: false }, photo_path: path }).select().single());
}

// Поставить в график: каждому цветку из плана — это удобрение, как часто и сколько. Прошлую подкормку помним.
export async function applyFertilizer(uid, fert) {
  const plants = await getPlants(uid);
  const plan = new Map((fert.info.plan || []).map((x) => [x.plant, x]));
  const changes = plants.filter((p) => plan.has(p.id) || p.feed?.fert === fert.id).map((p) => {
    const x = plan.get(p.id);
    // Пауза для цветка, у которого уже есть другое удобрение, его не сбивает.
    if (x && x.every === 0 && p.feed?.fert && p.feed.fert !== fert.id) return null;
    const feed = x ? { fert: fert.id, every: x.every, dose: x.dose || fert.info.dose || '', amount: x.amount || fert.info.amount || '', why: x.why || '', last: p.feed?.last || null } : null;
    return updatePlant(uid, p.id, { feed });
  }).filter(Boolean);
  await Promise.all([...changes, supabase.from('fertilizers').update({ info: { ...fert.info, applied: true } }).eq('id', fert.id).then(check)]);
  return changes.length;
}

// Новый разбор того же удобрения: план меняется, а в график он попадёт, только когда человек снова нажмёт «Поставить в график».
// bytes — доснятая сторона упаковки: добавляется к фото этого удобрения.
export async function updateFertilizer(uid, row, fert, bytes = null) {
  const added = bytes ? await uploadFertPhoto(uid, row.id, bytes) : null;
  const paths = [...fertPhotoPaths(row), added].filter(Boolean);
  const { name, ...info } = fert;
  check(await supabase.from('fertilizers')
    .update({ name, photo_path: paths[0] || null, info: { ...info, photos: paths.slice(1), applied: false } }).eq('user_id', uid).eq('id', row.id));
}

export async function deleteFertilizer(uid, fert) {
  const plants = (await getPlants(uid)).filter((p) => p.feed?.fert === fert.id);
  check(await supabase.from('fertilizers').delete().eq('user_id', uid).eq('id', fert.id));
  await Promise.all([
    ...plants.map((p) => updatePlant(uid, p.id, { feed: null })),
    fertPhotoPaths(fert).length ? photos().remove(fertPhotoPaths(fert)) : null,
  ]);
}

export async function setFeedEvery(uid, plant, every) {
  if (!plant.feed) throw fail('У этого цветка нет удобрения в графике');
  await updatePlant(uid, plant.id, { feed: { ...plant.feed, every } });
}

// Отметка «подкормила сегодня» и её отмена: прошлый день подкормки возвращается.
export async function markFed(uid, plantId, feed, day, on) {
  if (!feed) return;
  const next = on
    ? { ...feed, prev: feed.last === day ? feed.prev ?? null : feed.last ?? null, last: day }
    : { ...feed, last: feed.last === day ? feed.prev ?? null : feed.last, prev: null };
  const { fedToday: _f, due: _d, name: _n, nextIn: _x, ...clean } = next;
  check(await supabase.from('plants').update({ feed: clean }).eq('id', plantId));
}

// Всё, что нужно экрану приложения. Один запрос: цветы вместе с последним поливом каждого.
export async function buildState(uid) {
  const today = todayLocal();
  const [plants, ferts] = await Promise.all([
    supabase.from('plants').select('*, waterings(day)').eq('user_id', uid)
      .order('created_at').order('id')
      .order('day', { referencedTable: 'waterings', ascending: false })
      .limit(1, { referencedTable: 'waterings' }).then(check),
    getFertilizers(uid),
  ]);
  const fertName = Object.fromEntries(ferts.map((f) => [f.id, f.name]));
  return {
    today,
    fertilizers: ferts.map((f) => ({
      id: f.id, name: f.name, ...f.info, photo: f.photo_path ? photoUrl(f.photo_path) : null, photos: fertPhotoPaths(f).map(photoUrl),
      count: plants.filter((p) => p.feed?.fert === f.id && p.feed.every > 0).length,
    })),
    plants: plants.map((p) => {
      const lastDay = p.waterings?.[0]?.day || null;
      // Подкормка: пора ли (по интервалу), была ли сегодня, через сколько дней следующая.
      const f = p.feed && fertName[p.feed.fert] ? p.feed : null;
      const since = f?.last ? daysBetween(f.last, today) : null;
      const feed = f && {
        fert: f.fert, name: fertName[f.fert], every: f.every, dose: f.dose || '', amount: f.amount || '', why: f.why || '', last: f.last || null,
        fedToday: f.last === today,
        due: f.every > 0 && f.last !== today && (since === null || since >= f.every),
        nextIn: f.every > 0 ? (since === null ? 0 : Math.max(0, f.every - since)) : null,
      };
      return {
        feed,
        id: p.id, name: p.name, every: p.every,
        scan: p.scan && { ...p.scan, details: (p.scan.details || []).filter((d) => d.path).map((d) => ({ ...d, photo: photoUrl(d.path) })) },
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
  const at = Date.now();
  await updateUser(uid, { pending_scan: { ...scan, photos: count, at, ...(prev ? { prev: previous } : {}) } });
  return at;
}

// Ссылки на фото незавершённого скана для галереи. Файлы каждый раз те же, поэтому в ссылке время скана: иначе телефон покажет старое фото из кэша.
export function pendingShots(uid, count, at) {
  return Array.from({ length: count }, (_, i) => photoUrl(pendingPath(uid, i)) + '?v=' + at);
}

// Убрать из скана одно доснятое фото (не первое) вместе с его разбором. Следующие фото сдвигаются на его место.
// Общий вывод не пересчитываем: он остаётся как был.
export async function dropPending(uid, i) {
  const p = (await getUser(uid))?.pending_scan;
  const count = p?.photos || 0;
  if (!p || !(i >= 1 && i < count)) throw fail('Этого фото уже нет');
  for (let j = i + 1; j < count; j++) {
    const { data, error } = await photos().download(pendingPath(uid, j));
    if (error || !data) throw new Error('Не получилось убрать фото, попробуй ещё раз');
    await uploadPending(uid, j - 1, Buffer.from(await data.arrayBuffer()));
  }
  const { prev, ...rest } = p;
  const next = { ...rest, details: (p.details || []).filter((_, k) => k !== i - 1), photos: count - 1, at: Date.now() };
  // «Вернуть прошлый результат» остаётся, только если убранное фото в нём не участвовало.
  if (prev && prev.photos <= i) next.prev = prev;
  await updateUser(uid, { pending_scan: next });
  const { photos: n, at, prev: _p, detail: _d, ...scan } = next;
  return { scan, photos: n, at };
}

// Вернуть результат до последней досъёмки. Последнее фото остаётся в хранилище, но больше не учитывается.
export async function undoPending(uid) {
  const prev = (await getUser(uid))?.pending_scan?.prev;
  if (!prev) throw fail('Прошлого результата уже нет');
  const at = Date.now();
  await updateUser(uid, { pending_scan: { ...prev, at } });
  const { photos, at: _at, detail: _d, ...scan } = prev;
  return { scan, photos, at };
}

// Основное фото цветка из коллекции, чтобы разобрать его вместе с фото детали.
export async function downloadPhoto(path) {
  const { data, error } = await photos().download(path);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
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
  const { photos: _count, at: _at, prev: _prev, detail: _detail, ...scan } = user?.pending_scan || {};
  if (!scan.name) throw fail('Скан потерялся, сфоткай ещё раз');
  if (scan.notPlant) throw fail('На фото нет растения, сохранять нечего');
  if (target !== 'new' && !existing) throw notFound();

  const id = existing ? existing.id : newPlantId();
  // Все фото скана переезжают в карточку: первое — основное, остальные — доснятые детали со своим разбором.
  // Имена файлов новые при каждом скане, чтобы телефон не показывал старое фото из кэша.
  const count = Math.max(1, user.pending_scan.photos || 1);
  const stamp = Date.now().toString(36);
  const paths = Array.from({ length: count }, (_, i) => `${uid}/${id}-${stamp}${i ? '-' + i : ''}.jpg`);
  const copied = await Promise.all(paths.map(async (to, i) => {
    const { error } = await photos().copy(pendingPath(uid, i), to);
    if (error && i === 0) throw new Error('База не ответила: ' + error.message);
    return !error;
  }));
  const path = paths[0];
  scan.details = (scan.details || []).slice(0, count - 1)
    .map((d, i) => (copied[i + 1] ? { seen: d.seen, means: d.means, todo: d.todo || [], path: paths[i + 1] } : null)).filter(Boolean);

  // Сорт хозяйка указала сама: новый скан этого цветка его не меняет.
  if (existing?.scan?.manual && !scan.manual) {
    Object.assign(scan, { name: existing.scan.name, latin: existing.scan.latin || '', manual: true, confidence: 'high' });
    delete scan.identified;
  }

  let plant;
  if (existing) {
    const fields = { scan, photo_path: path };
    // Название меняется вместе со сканом, чтобы русское и латинское не расходились. Кроме случая, когда цветок переименовали вручную.
    if (!existing.scan || existing.name === existing.scan.name) fields.name = scan.name;
    const old = [existing.photo_path, ...(existing.scan?.details || []).map((d) => d.path)].filter(Boolean);
    await Promise.all([
      updatePlant(uid, id, fields),
      old.length ? photos().remove(old) : null,
    ]);
    plant = { ...existing, ...fields };
  } else {
    plant = check(await supabase.from('plants')
      .insert({ id, user_id: uid, name: scan.name, every: scan.every, scan, photo_path: path }).select().single());
  }
  await updateUser(uid, { pending_scan: null });
  return { plant, isNew: !existing };
}

// ───── замеры скана ─────
// Сколько шёл каждый скан и какие модели отвечали: по таблице scan_runs видно, стал ли скан быстрее.
// Пока таблицы нет, просто ничего не пишем.
let runsWarned = false;
export async function logScan(row) {
  const { error } = await supabase.from('scan_runs').insert(row);
  if (error && !runsWarned) { runsWarned = true; console.error('Замеры скана не пишутся:', error.message); }
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
