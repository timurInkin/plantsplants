// Точка входа: веб-сервер для Telegram и приложения плюс часы для напоминалок.

import http from 'node:http';
import fs from 'node:fs/promises';
import { config, MORNING_HOUR, EVENING_HOUR } from './config.js';
import { todayLocal, hourLocal } from './dates.js';
import * as db from './db.js';
import { scanPhoto } from './scan.js';
import { setupTelegram, webhookSecret, userFromInitData } from './telegram.js';
import { handleUpdate, remind } from './bot.js';

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

async function api(uid, path, req) {
  const today = todayLocal();
  if (path === '/api/state') return db.buildState(uid);

  if (path === '/api/scan') {
    const bytes = await readBody(req, 4_000_000);
    if (!bytes.length) throw new Error('Пустое фото');
    const scan = await scanPhoto(bytes);
    await db.keepPending(uid, bytes, scan);
    return { scan };
  }

  const body = JSON.parse((await readBody(req, 100_000)).toString() || '{}');

  if (path === '/api/scan/save') {
    const saved = await db.savePending(uid, body.target);
    return { ...(await db.buildState(uid)), saved: saved.id };
  }
  if (path === '/api/water-all') {
    await db.waterAllDue(uid, today);
    return db.buildState(uid);
  }

  const plant = await db.getPlant(uid, body.plant);
  if (!plant) throw Object.assign(new Error('Нет такого цветка'), { status: 400 });

  if (path === '/api/water') {
    await db.toggleWater(uid, plant.id, today);
  } else if (path === '/api/plant/update') {
    const fields = {};
    if (body.every) fields.every = Math.min(60, Math.max(1, Math.round(body.every)));
    if (body.name) fields.name = String(body.name).trim().slice(0, 60);
    await db.updatePlant(uid, plant.id, fields);
  } else if (path === '/api/plant/delete') {
    await db.deletePlant(uid, plant.id);
  } else {
    return null;
  }
  return db.buildState(uid);
}

export const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  try {
    if (req.method === 'GET' && STATIC[path]) {
      const [file, type] = STATIC[path];
      return send(res, 200, await fs.readFile(new URL('../public/' + file, import.meta.url)), type);
    }

    if (path === '/webhook' && req.method === 'POST') {
      if (req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) return send(res, 403, 'forbidden', 'text/plain');
      const update = JSON.parse((await readBody(req, 1_000_000)).toString());
      send(res, 200, 'ok', 'text/plain'); // отвечаем сразу, чтобы Telegram не слал повторно, пока идёт скан
      await handleUpdate(update).catch((e) => console.error('Ошибка в чате:', e));
      return;
    }

    if (path.startsWith('/api/')) {
      const user = userFromInitData(req.headers['x-init-data']);
      if (!user) return send(res, 403, { error: 'нет доступа' });
      await db.touchUser(user.id, user.id, user.first_name); // в личке с ботом id чата совпадает с id человека
      const result = await api(user.id, path, req);
      return result ? send(res, 200, result) : send(res, 404, { error: 'not found' });
    }

    send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    if (!e.status) console.error(path, e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message || 'Что-то сломалось' });
  }
});

// Раз в минуту смотрим на часы. Отметка у человека в базе не даёт прислать одно напоминание дважды после перезапуска.
export async function tick() {
  const hour = hourLocal(), today = todayLocal();
  for (const [kind, from] of [['morning', MORNING_HOUR], ['evening', EVENING_HOUR]]) {
    if (hour < from || hour >= from + 3) continue;
    const field = 'reminded_' + kind;
    for (const user of await db.getUsers()) {
      if (user[field] === today) continue;
      await db.updateUser(user.id, { [field]: today });
      await remind(user, kind === 'evening').catch((e) => console.error('Напоминалка не ушла', user.id, e));
    }
  }
}

if (process.env.NODE_ENV !== 'test') {
  server.listen(config.port, () => console.log('Слушаю порт', config.port));
  setupTelegram().catch((e) => console.error('Не удалось подключить Telegram:', e));
  setInterval(() => tick().catch((e) => console.error('Напоминалка не ушла:', e)), 60_000);
}
