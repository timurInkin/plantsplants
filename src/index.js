// Точка входа: веб-сервер для Telegram и приложения плюс часы для напоминалок.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { config, MORNING_HOUR, EVENING_HOUR } from './config.js';
import { todayLocal, hourLocal, validDay } from './dates.js';
import * as db from './db.js';
import { setupTelegram, webhookSecret, userFromInitData, botUsername } from './telegram.js';
import { track } from './timing.js';
import { handleUpdate, remind, scanForUser, recheckForUser, notify } from './bot.js';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Фото слишком большое')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// Что можно делать в чужих цветах, которыми поделились: смотреть и отмечать полив.
const GUEST_OK = new Set(['/api/state', '/api/water', '/api/water/last', '/api/water-all']);
// Последний скан из приложения у каждого человека: { id, status: working | done | error, stage, scan, photos, error }.
const scanJobs = new Map();

// Скан идёт в фоне, а приложение спрашивает /api/scan/status, пока не будет готово.
function startScanJob(uid, label, run) {
  const job = { id: crypto.randomBytes(6).toString('hex'), status: 'working' };
  scanJobs.set(uid, job);
  track(label, () => run((text) => { job.stage = text; })).then(
    (r) => Object.assign(job, { status: 'done', scan: r.scan, photos: r.photos, shots: db.pendingShots(uid, r.photos, r.at) }),
    (e) => {
      if (!e.status) console.error(label + ' не удался', e);
      Object.assign(job, { status: 'error', error: e.message || 'Что-то сломалось' });
    });
  return { job: job.id };
}

const fail = (message, extra = {}) => Object.assign(new Error(message), { status: 400, ...extra });
const gone = () => fail('Доступ к этим цветам закрыли', { gone: true });

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c; };

async function shareInfo(uid, reset = false) {
  const [token, guests, name] = await Promise.all([db.shareToken(uid, reset), db.guestsOf(uid), botUsername()]);
  return { link: `https://t.me/${name}?start=g_${token}`, guests };
}

async function api(uid, path, req) {
  const today = todayLocal();
  // Чьи цветы на экране: свои или чужие, которыми поделились (заголовок X-Garden).
  const g = Number(req.headers['x-garden']) || uid;

  if (path === '/api/state') {
    const [gardens, state] = await Promise.all([db.gardensOf(uid), db.buildState(g)]);
    if (g !== uid && !gardens.some((x) => x.id === g)) throw gone();
    return { ...state, garden: g, own: g === uid, gardens: [{ id: uid, name: 'Мои цветы' }, ...gardens] };
  }
  if (g !== uid) {
    if (!GUEST_OK.has(path)) throw fail('Это можно только в своих цветах');
    if (!(await db.gardensOf(uid)).some((x) => x.id === g)) throw gone();
  }

  // Скан из приложения: принимаем фото и сразу отвечаем, а сам скан идёт в фоне.
  // Приложение спрашивает /api/scan/status, пока не будет готово: телефон может оборвать запрос длиной в минуту.
  if (path === '/api/scan') {
    const bytes = await readBody(req, 4_000_000);
    if (!bytes.length) throw new Error('Пустое фото');
    const q = new URL(req.url, 'http://x').searchParams;
    const more = q.get('more') === '1', plant = q.get('plant') || null;
    return startScanJob(uid, 'скан из приложения', (onStage) => scanForUser(uid, bytes, '', more, false, onStage, plant));
  }
  if (path === '/api/scan/undo') {
    const r = await db.undoPending(uid);
    return { ...r, shots: db.pendingShots(uid, r.photos, r.at) };
  }
  if (path === '/api/scan/status') {
    const job = scanJobs.get(uid);
    const id = new URL(req.url, 'http://x').searchParams.get('job');
    if (!job || job.id !== id) throw fail('Скан прервался, сфоткай ещё раз');
    if (job.status === 'working') return { status: 'working', stage: job.stage || '' };
    if (job.status === 'error') return { status: 'error', error: job.error };
    return { status: 'done', scan: job.scan, photos: job.photos, shots: job.shots };
  }

  const body = JSON.parse((await readBody(req, 100_000)).toString() || '{}');

  // Пересчитать советы под сорт, который человек знает точно.
  if (path === '/api/scan/recheck') {
    if (!String(body.name || '').trim() && !body.plant) throw fail('Напиши название сорта');
    return startScanJob(uid, 'пересчёт под сорт', (onStage) => recheckForUser(uid, { plant: body.plant || null, name: body.name, latin: body.latin }, onStage));
  }
  if (path === '/api/scan/drop') {
    const r = await db.dropPending(uid, Number(body.i));
    return { ...r, shots: db.pendingShots(uid, r.photos, r.at) };
  }
  if (path === '/api/scan/save') {
    const { plant, isNew } = await db.savePending(uid, body.target);
    notify(uid, isNew
      ? `🌿 Добавила «${esc(plant.name)}» в твои цветы. Полив раз в ${plant.every} ${plural(plant.every, 'день', 'дня', 'дней')}.`
      : `🌿 Обновила «${esc(plant.name)}»: новые фото и советы.`, plant.id);
    return { ...(await db.buildState(uid)), saved: plant.id, isNew };
  }
  if (path === '/api/water-all') {
    await db.waterAllDue(g, today);
    return db.buildState(g);
  }

  // Гостевой доступ: ссылка-приглашение, список гостей, закрыть доступ, отказаться от чужих цветов.
  if (path === '/api/share') return shareInfo(uid);
  if (path === '/api/share/reset') return shareInfo(uid, true);
  if (path === '/api/share/remove') {
    await db.removeShare(uid, Number(body.guest));
    return shareInfo(uid);
  }
  if (path === '/api/share/leave') {
    await db.removeShare(Number(body.owner), uid);
    return { ok: true };
  }

  const plant = await db.getPlant(g, body.plant);
  if (!plant) throw fail('Нет такого цветка');

  if (path === '/api/water') {
    await db.toggleWater(plant.id, today);
  } else if (path === '/api/water/last') {
    if (!validDay(body.day, today)) throw fail('Выбери день не позже сегодняшнего и не раньше, чем год назад');
    await db.setLastWatering(plant.id, body.day);
  } else if (path === '/api/plant/update') {
    const fields = {};
    if (body.every) fields.every = Math.min(60, Math.max(1, Math.round(body.every)));
    if (body.name) fields.name = String(body.name).trim().slice(0, 60);
    await db.updatePlant(uid, plant.id, fields);
  } else if (path === '/api/plant/delete') {
    await db.deletePlant(uid, plant);
    notify(uid, `🗑 Убрала «${esc(plant.name)}» из коллекции.`);
  } else if (path === '/api/plant/variety') {
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) throw fail('Напиши название сорта');
    const p = await db.setVariety(uid, plant, name, String(body.latin ?? '').trim().slice(0, 80));
    // quiet: следом приложение пересчитает советы, и в чат напишем уже после сохранения нового скана.
    if (!body.quiet) notify(uid, `✏️ Записала сорт: «${esc(p.name)}»${p.scan?.latin ? ` (<i>${esc(p.scan.latin)}</i>)` : ''}. Сканер его больше не поменяет.`, p.id);
  } else if (path === '/api/plant/detail/delete') {
    await db.deleteDetail(uid, plant, Number(body.i));
  } else {
    return null;
  }
  return db.buildState(g);
}

// Подпись для строчки «⏱» в логах: что пришло из чата.
function updateLabel(u) {
  if (u.callback_query) return 'кнопка в чате ' + String(u.callback_query.data || '').split(':')[0];
  return u.message?.photo ? 'фото в чат' : 'сообщение в чат';
}

export const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  try {
    // Шрифты: имена файлов не меняются, поэтому телефон хранит их долго (новая версия — новый ?v= в index.html).
    if (req.method === 'GET' && /^\/fonts\/[\w-]+\.woff2$/.test(path)) {
      const font = await fs.readFile(new URL('../public' + path, import.meta.url)).catch(() => null);
      if (!font) return send(res, 404, 'not found', 'text/plain');
      res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable' });
      return res.end(font);
    }
    if (req.method === 'GET' && STATIC[path]) {
      const [file, type] = STATIC[path];
      return send(res, 200, await fs.readFile(new URL('../public/' + file, import.meta.url)), type);
    }

    if (path === '/webhook' && req.method === 'POST') {
      if (req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) return send(res, 403, 'forbidden', 'text/plain');
      const update = JSON.parse((await readBody(req, 1_000_000)).toString());
      send(res, 200, 'ok', 'text/plain'); // отвечаем сразу, чтобы Telegram не слал повторно, пока идёт скан
      await track(updateLabel(update), () => handleUpdate(update)).catch((e) => console.error('Ошибка в чате:', e));
      return;
    }

    if (path.startsWith('/api/')) {
      const user = userFromInitData(req.headers['x-init-data']);
      if (!user) return send(res, 403, { error: 'нет доступа' });
      const run = async () => {
        await db.touchUser(user.id, user.id, user.first_name); // в личке с ботом id чата совпадает с id человека
        return api(user.id, path, req);
      };
      // Опрос «скан готов?» идёт каждые 2 секунды, его в лог не пишем.
      const result = path === '/api/scan/status' ? await run() : await track(path, run);
      return result ? send(res, 200, result) : send(res, 404, { error: 'not found' });
    }

    send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    if (!e.status) console.error(path, e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message || 'Что-то сломалось', ...(e.gone ? { gone: true } : {}) });
  }
});

// Раз в минуту смотрим на часы. Отметка у человека в базе не даёт прислать одно напоминание дважды после перезапуска.
export async function tick() {
  const hour = hourLocal(), today = todayLocal();
  for (const [kind, from] of [['morning', MORNING_HOUR], ['evening', EVENING_HOUR]]) {
    if (hour < from || hour >= from + 3) continue;
    const field = 'reminded_' + kind;
    const due = (await db.getUsers()).filter((u) => u[field] !== today);
    if (!due.length) continue;
    const shares = await db.allShares(); // гостям напоминаем и про цветы, которые им доверили
    for (const user of due) {
      await db.updateUser(user.id, { [field]: today });
      const owners = shares.filter((s) => s.guest === user.id).map((s) => ({ id: s.owner, name: s.name }));
      await remind(user, kind === 'evening', owners).catch((e) => console.error('Напоминалка не ушла', user.id, e));
    }
  }
}

if (process.env.NODE_ENV !== 'test') {
  server.listen(config.port, () => console.log('Слушаю порт', config.port));
  setupTelegram().catch((e) => console.error('Не удалось подключить Telegram:', e));
  setInterval(() => tick().catch((e) => console.error('Напоминалка не ушла:', e)), 60_000);
}
