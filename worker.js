// Бот Полины про растения: сканер по фото, статус каждого цветка и напоминалки о поливе.
// Работает на Cloudflare Workers. Нужны: KV-хранилище DB, Workers AI (binding AI) и секрет BOT_TOKEN.
// Необязательно: секрет ANTHROPIC_API_KEY — тогда сканер работает на Claude (точнее, но платно).

// ───────────── НАСТРОЙКИ (это можно менять) ─────────────

// С чего начинается коллекция. Потом цветы добавляются сканером, а интервал меняется в приложении.
const START_PLANTS = [
  { id: 'monstera1', name: 'Монстера №1', every: 3 },
  { id: 'monstera2', name: 'Монстера №2', every: 3 },
  { id: 'pinkprince', name: 'Филодендрон «Розовый принц»', every: 3 },
  { id: 'philodendron', name: 'Филодендрон', every: 3 },
  { id: 'violets', name: 'Фиалки', every: 3 },
  { id: 'maranta', name: 'Маранта', every: 3 },
  { id: 'caladium', name: 'Каладиумы', every: 3 },
  { id: 'alocasia', name: 'Алоказия', every: 4 },
  { id: 'strelitzia', name: 'Стрелиция', every: 5 },
  { id: 'aglaonema', name: 'Аглаонема', every: 7 },
  { id: 'ficus', name: 'Фикус эластика', every: 7 },
];

// Вечером (в 19:00) напомнить про тех, кого так и не полили.
const EVENING_NUDGE = true;

// Часовой пояс: Москва, UTC+3.
const TZ_OFFSET_HOURS = 3;

// Модели для сканера.
const CF_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const CLAUDE_MODEL = 'claude-sonnet-5-5';

// ───────────── дальше техническая часть ─────────────

const DAY = 86400000;

function todayLocal(now = Date.now()) {
  return new Date(now + TZ_OFFSET_HOURS * 3600000).toISOString().slice(0, 10);
}
function hourLocal(now = Date.now()) {
  return new Date(now + TZ_OFFSET_HOURS * 3600000).getUTCHours();
}
function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY);
}

// ───── хранилище ─────

async function getJSON(env, key, fallback) {
  const raw = await env.DB.get(key);
  return raw ? JSON.parse(raw) : fallback;
}
async function putJSON(env, key, value) {
  await env.DB.put(key, JSON.stringify(value));
}
async function getPlants(env) {
  return getJSON(env, 'plants', START_PLANTS.map((p) => ({ ...p, scan: null })));
}
const savePlants = (env, plants) => putJSON(env, 'plants', plants);
const getWater = (env) => getJSON(env, 'water', {});

async function savePhoto(env, plantId, bytes) {
  await env.DB.put('photo:' + plantId, bytes);
  const photos = await getJSON(env, 'photos', {});
  photos[plantId] = Date.now().toString(36);
  await putJSON(env, 'photos', photos);
}

// ───── полив ─────

function plantStatus(plants, water, photos, today) {
  return plants.map((p) => {
    const last = (water[p.id] || [])[0] || null;
    const dueIn = last ? p.every - daysBetween(last, today) : 0;
    return { ...p, last, dueIn, wateredToday: last === today, photo: photos[p.id] || null };
  });
}

async function buildState(env) {
  const today = todayLocal();
  return {
    today,
    plants: plantStatus(await getPlants(env), await getWater(env), await getJSON(env, 'photos', {}), today),
    ai: env.ANTHROPIC_API_KEY ? 'claude' : 'cloudflare',
  };
}

async function toggleWater(env, plantId, today) {
  const water = await getWater(env);
  const dates = water[plantId] || [];
  if (dates[0] === today) dates.shift(); // повторное нажатие отменяет
  else dates.unshift(today);
  water[plantId] = dates.slice(0, 60);
  await putJSON(env, 'water', water);
}

async function waterAllDue(env, today) {
  const state = await buildState(env);
  const due = state.plants.filter((p) => p.dueIn <= 0 && !p.wateredToday);
  const water = await getWater(env);
  for (const p of due) water[p.id] = [today, ...(water[p.id] || [])].slice(0, 60);
  await putJSON(env, 'water', water);
  return due.length;
}

// ───── сканер ─────

const SCAN_PROMPT = `Ты помогаешь с комнатными растениями. На фото растение (возможно, с горшком).
Ответь ТОЛЬКО JSON без пояснений и без markdown, строго по схеме:
{
  "name": "название по-русски, как в цветочном магазине",
  "latin": "латинское название, 1-3 слова",
  "confidence": "high | medium | low",
  "status": "ok | watch | help",
  "status_text": "состояние, до 8 слов",
  "pot": "ok | small | big | unknown",
  "pot_text": "про горшок, до 8 слов",
  "water_every_days": число дней между поливами в комнате,
  "water_text": "как понять, что пора поливать, до 8 слов",
  "light": "какой свет нужен, до 5 слов",
  "todo": ["что сделать прямо сейчас, до 3 пунктов, по 6-8 слов; пустой массив, если всё хорошо"]
}
Правила: только то, что видно на фото и что нужно для ухода. Никакой истории, ботаники, родины, токсичности.
status: ok — здоровое и растёт; watch — есть мелочи; help — нужно лечить. Смотри на пятна, желтизну, сухие края, вялость, вредителей.
pot: small — корни лезут, растение сильно больше горшка; big — горшок явно велик; unknown — горшка не видно.
Пиши коротко и спокойно, по-разговорному, без канцелярита.`;

function toBase64(bytes) {
  const arr = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i += 0x8000) bin += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000));
  return btoa(bin);
}

function parseLooseJSON(text) {
  if (text && typeof text === 'object') return text;
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Сканер ответил непонятно, попробуй ещё раз');
  return JSON.parse(m[0]);
}

const cut = (s, n) => String(s || '').trim().slice(0, n);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);

function normalizeScan(r) {
  return {
    name: cut(r.name, 60) || 'Неизвестный цветок',
    latin: cut(r.latin, 60),
    confidence: oneOf(r.confidence, ['high', 'medium', 'low'], 'medium'),
    status: oneOf(r.status, ['ok', 'watch', 'help'], 'ok'),
    statusText: cut(r.status_text, 80),
    pot: oneOf(r.pot, ['ok', 'small', 'big', 'unknown'], 'unknown'),
    potText: cut(r.pot_text, 80),
    every: Math.min(30, Math.max(1, Math.round(Number(r.water_every_days) || 7))),
    waterText: cut(r.water_text, 80),
    light: cut(r.light, 60),
    todo: (Array.isArray(r.todo) ? r.todo : []).map((t) => cut(t, 90)).filter(Boolean).slice(0, 3),
    date: todayLocal(),
  };
}

async function scanPhoto(env, bytes) {
  const b64 = toBase64(bytes);
  let text;
  if (env.ANTHROPIC_API_KEY) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: CLAUDE_MODEL, max_tokens: 800,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: SCAN_PROMPT },
        ] }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error('Сканер сейчас недоступен: ' + (data.error?.message || res.status));
    text = data.content.map((c) => c.text || '').join('');
  } else {
    const out = await env.AI.run(CF_MODEL, {
      messages: [{ role: 'user', content: [
        { type: 'text', text: SCAN_PROMPT },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } },
      ] }],
      max_tokens: 800, temperature: 0.2,
    });
    text = out.response;
  }
  return normalizeScan(parseLooseJSON(text));
}

// Последний скан ждёт, пока его сохранят: в новый цветок или в существующий.
async function keepPending(env, bytes, scan) {
  await env.DB.put('photo:pending', bytes);
  await putJSON(env, 'scan:pending', scan);
}

async function savePending(env, target) {
  const scan = await getJSON(env, 'scan:pending', null);
  const bytes = await env.DB.get('photo:pending', { type: 'arrayBuffer' });
  if (!scan || !bytes) throw new Error('Скан потерялся, сфоткай ещё раз');
  const plants = await getPlants(env);
  let plant;
  if (target === 'new') {
    plant = { id: 'p' + Date.now().toString(36), name: scan.name, every: scan.every, scan };
    plants.push(plant);
  } else {
    plant = plants.find((p) => p.id === target);
    if (!plant) throw new Error('Нет такого цветка');
    plant.scan = scan;
  }
  await savePlants(env, plants);
  await savePhoto(env, plant.id, bytes);
  await env.DB.delete('scan:pending');
  await env.DB.delete('photo:pending');
  return plant;
}

const STATUS = { ok: 'всё ок', watch: 'присмотреться', help: 'подлечить' };
const POT = { ok: 'горшок норм', small: 'тесный горшок', big: 'горшок великоват', unknown: '' };

function scanText(s) {
  const lines = [`🌿 <b>${s.name}</b>${s.latin ? ' · <i>' + s.latin + '</i>' : ''}`, ''];
  lines.push(`Состояние: ${STATUS[s.status]}${s.statusText ? ', ' + s.statusText : ''}`);
  if (s.pot !== 'unknown') lines.push(`Горшок: ${s.potText || POT[s.pot]}`);
  lines.push(`Полив: раз в ${s.every} дн.${s.waterText ? ', ' + s.waterText : ''}`);
  if (s.light) lines.push(`Свет: ${s.light}`);
  if (s.todo.length) lines.push('', '<b>Сделать:</b>', ...s.todo.map((t) => '• ' + t));
  if (s.confidence === 'low') lines.push('', 'Не до конца уверена, что это за цветок. Можно сфоткать поближе.');
  return lines.join('\n');
}

// ───── Telegram ─────

async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json();
}

async function appButton(env, text, screen) {
  const origin = await env.DB.get('origin');
  return { text, web_app: { url: `${origin}/#${screen}` } };
}

async function webhookSecret(env) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('hook:' + env.BOT_TOKEN));
  return [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, typeof data === 'string' ? new TextEncoder().encode(data) : data));
}

// Проверяем, что запрос пришёл из Telegram и от хозяйки бота.
async function checkUser(request, env) {
  const params = new URLSearchParams(request.headers.get('X-Init-Data') || '');
  const hash = params.get('hash');
  if (!hash) return false;
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = await hmac(new TextEncoder().encode('WebAppData'), env.BOT_TOKEN);
  const sig = [...(await hmac(secret, check))].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (sig !== hash) return false;
  const user = JSON.parse(params.get('user') || '{}');
  const owner = await env.DB.get('owner');
  return owner && String(user.id) === owner;
}

async function handleCallback(env, cb) {
  const owner = await env.DB.get('owner');
  if (String(cb.from.id) !== owner || !cb.data) return;
  const chat_id = cb.message.chat.id, message_id = cb.message.message_id;
  try {
    if (cb.data === 'w:all') {
      const n = await waterAllDue(env, todayLocal());
      await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: n ? 'Отметила 💧' : 'Уже всё полито' });
      await tg(env, 'editMessageText', { chat_id, message_id, text: 'Все политы 💧' });
    } else if (cb.data.startsWith('sc:')) {
      const plant = await savePending(env, cb.data.slice(3));
      await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id });
      await tg(env, 'editMessageReplyMarkup', {
        chat_id, message_id, reply_markup: { inline_keyboard: [[await appButton(env, `Открыть: ${plant.name}`, 'plant/' + plant.id)]] },
      });
    }
  } catch (e) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: e.message });
  }
}

async function handleUpdate(env, update) {
  if (update.callback_query) return handleCallback(env, update.callback_query);
  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private') return;
  const owner = await env.DB.get('owner');
  if (!owner) await env.DB.put('owner', String(msg.from.id));
  else if (owner !== String(msg.from.id)) {
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: 'Это личный бот, извини 🌿' });
    return;
  }

  if (msg.photo) {
    await tg(env, 'sendChatAction', { chat_id: msg.chat.id, action: 'typing' });
    const size = msg.photo.find((ph) => ph.width >= 1000) || msg.photo[msg.photo.length - 1];
    const file = await tg(env, 'getFile', { file_id: size.file_id });
    const bytes = await (await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.result.file_path}`)).arrayBuffer();
    let scan;
    try {
      scan = await scanPhoto(env, bytes);
    } catch (e) {
      await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: 'Не получилось разглядеть 😕 ' + e.message });
      return;
    }
    await keepPending(env, bytes, scan);
    const plants = await getPlants(env);
    const rows = [[{ text: '＋ Это новый цветок', callback_data: 'sc:new' }]];
    for (let i = 0; i < plants.length; i += 2) {
      rows.push(plants.slice(i, i + 2).map((p) => ({ text: p.name, callback_data: 'sc:' + p.id })));
    }
    await tg(env, 'sendMessage', {
      chat_id: msg.chat.id, parse_mode: 'HTML',
      text: scanText(scan) + '\n\nКуда сохранить?',
      reply_markup: { inline_keyboard: rows },
    });
    return;
  }

  await tg(env, 'sendMessage', {
    chat_id: msg.chat.id,
    text: msg.text && msg.text.startsWith('/start')
      ? 'Привет 🌿\n\nПришли фото цветка, и я скажу, кто это, всё ли с ним ок и норм ли горшок. Коротко, без лекций.\n\n' +
        'Утром напишу, кого пора полить. Все цветы в приложении 👇'
      : 'Кидай фото цветка, посмотрю. Или открой приложение 👇',
    reply_markup: { inline_keyboard: [[await appButton(env, 'Мои цветы', 'today')]] },
  });
}

// ───── напоминалки ─────

async function remind(env, evening) {
  if (evening && !EVENING_NUDGE) return;
  const chatId = await env.DB.get('owner');
  if (!chatId) return;
  const state = await buildState(env);
  const due = state.plants.filter((p) => p.dueIn <= 0 && !p.wateredToday);
  if (!due.length) return;
  const text = (evening ? '🌙 <b>Ещё не политы:</b>\n' : '💧 <b>Сегодня пить хотят:</b>\n') + due.map((p) => '• ' + p.name).join('\n');
  await tg(env, 'sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: 'Полила всех', callback_data: 'w:all' }, await appButton(env, 'Открыть', 'today')]] },
  });
}

// ───── входная точка ─────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });

    if (url.pathname === '/setup') {
      await env.DB.put('origin', url.origin);
      const results = [
        await tg(env, 'setWebhook', { url: url.origin + '/webhook', secret_token: await webhookSecret(env), allowed_updates: ['message', 'callback_query'] }),
        await tg(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Мои цветы', web_app: { url: url.origin + '/#today' } } }),
        await tg(env, 'setMyCommands', { commands: [{ command: 'start', description: 'Начать' }] }),
      ];
      const ok = results.every((r) => r.ok);
      return new Response(ok
        ? '<meta charset="utf-8"><h2>Готово! ✅</h2><p>Теперь открой своего бота в Telegram и нажми «Начать» (/start).</p>'
        : '<meta charset="utf-8"><h2>Что-то не так 😕</h2><p>Проверь, что BOT_TOKEN вставлен правильно.</p><pre>' + JSON.stringify(results, null, 2) + '</pre>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (url.pathname === '/webhook' && request.method === 'POST') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== (await webhookSecret(env))) {
        return new Response('forbidden', { status: 403 });
      }
      await handleUpdate(env, await request.json());
      return new Response('ok');
    }

    if (url.pathname.startsWith('/photo/')) {
      const img = await env.DB.get('photo:' + url.pathname.slice(7), { type: 'arrayBuffer' });
      if (!img) return new Response('нет фото', { status: 404 });
      return new Response(img, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' } });
    }

    if (url.pathname.startsWith('/api/')) {
      if (!(await checkUser(request, env))) return json({ error: 'нет доступа' }, 403);
      const today = todayLocal();
      try {
        if (url.pathname === '/api/state') return json(await buildState(env));

        if (url.pathname === '/api/scan') {
          const bytes = await request.arrayBuffer();
          if (!bytes.byteLength || bytes.byteLength > 4_000_000) return json({ error: 'Фото слишком большое' }, 400);
          const scan = await scanPhoto(env, bytes);
          await keepPending(env, bytes, scan);
          return json({ scan });
        }

        const body = request.method === 'POST' ? await request.json() : {};
        const plants = await getPlants(env);
        const plant = plants.find((p) => p.id === body.plant);

        if (url.pathname === '/api/scan/save') {
          const saved = await savePending(env, body.target);
          return json({ ...(await buildState(env)), saved: saved.id });
        }
        if (url.pathname === '/api/water-all') {
          await waterAllDue(env, today);
          return json(await buildState(env));
        }
        if (!plant) return json({ error: 'Нет такого цветка' }, 400);

        if (url.pathname === '/api/water') {
          await toggleWater(env, plant.id, today);
          return json(await buildState(env));
        }
        if (url.pathname === '/api/plant/update') {
          if (body.every) plant.every = Math.min(60, Math.max(1, Math.round(body.every)));
          if (body.name) plant.name = cut(body.name, 60);
          await savePlants(env, plants);
          return json(await buildState(env));
        }
        if (url.pathname === '/api/plant/delete') {
          await savePlants(env, plants.filter((p) => p !== plant));
          await env.DB.delete('photo:' + plant.id);
          return json(await buildState(env));
        }
        return json({ error: 'not found' }, 404);
      } catch (e) {
        return json({ error: e.message || 'Что-то сломалось' }, 500);
      }
    }

    return new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(remind(env, hourLocal() >= 14));
  },
};

// ───────────── экран приложения ─────────────

function app() {
  const tg = window.Telegram && window.Telegram.WebApp;
  const dark = tg && tg.colorScheme === 'dark';
  if (tg) {
    tg.ready(); tg.expand();
    try { tg.setHeaderColor(dark ? '#121513' : '#EEF1EC'); tg.setBackgroundColor(dark ? '#121513' : '#EEF1EC'); } catch (e) {}
  }
  if (dark) document.documentElement.classList.add('dark');
  const initData = (tg && tg.initData) || '';

  const root = document.getElementById('root');
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const DAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
  const TABS = [['today', 'Сегодня'], ['plants', 'Цветы'], ['scan', 'Скан']];
  const STATUS = { ok: ['всё ок', 'sage', 'check_circle'], watch: ['присмотреться', 'lime', 'visibility'], help: ['подлечить', 'warm', 'healing'] };
  const POT = { ok: ['горшок норм', 'sage'], small: ['тесный горшок', 'warm'], big: ['горшок великоват', 'lime'] };

  let state = null;
  let route = (location.hash || '#today').slice(1);
  let scan = null;          // { status: 'loading' | 'done' | 'error', result, preview, error, target }
  let busy = false;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const dateLabel = (iso) => { const d = new Date(iso + 'T00:00:00Z'); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; };
  const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c; };
  const days = (n) => n + ' ' + plural(n, 'день', 'дня', 'дней');
  const haptic = () => { try { tg.HapticFeedback.impactOccurred('light'); } catch (e) {} };
  // Иконки: Google Material Symbols (Rounded)
  const ms = (name) => '<span class="ms">' + name + '</span>';
  const byId = (id) => state.plants.find((p) => p.id === id);
  const photoUrl = (p) => '/photo/' + p.id + '?v=' + p.photo;

  async function api(path, body, raw) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': raw ? 'image/jpeg' : 'application/json', 'X-Init-Data': initData },
      body: raw ? body : body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403) throw new Error('Открой это из своего бота в Telegram');
    if (!res.ok) throw new Error(data.error || 'Что-то не грузится, попробуй ещё раз');
    return data;
  }

  const check = (done) => '<span class="check' + (done ? ' on' : '') + '">' + (done ? ms('check') : '') + '</span>';
  const chip = (text, cls, icon) => '<span class="chip ' + cls + '">' + (icon ? ms(icon) : '') + esc(text) + '</span>';
  const fact = (icon, text) => '<li>' + ms(icon) + '<span>' + esc(text) + '</span></li>';

  function when(p) {
    if (p.wateredToday) return ['полито', 'sage'];
    if (p.dueIn < 0) return [-p.dueIn === 1 ? 'с вчера' : (-p.dueIn) + ' дн. ждёт', 'warm'];
    if (p.dueIn === 0) return ['сегодня', 'lime'];
    if (p.dueIn === 1) return ['завтра', 'gray'];
    return ['через ' + p.dueIn + ' дн.', 'gray'];
  }

  function pic(p, cls) {
    return '<span class="' + cls + (p.photo ? '' : ' empty') + '">' + (p.photo ? '<img src="' + photoUrl(p) + '" alt="" loading="lazy">' : ms('potted_plant')) + '</span>';
  }

  function waterRow(p) {
    const w = when(p);
    return '<div class="row' + (p.wateredToday ? ' done' : '') + '">' +
      '<button class="hit" data-water="' + p.id + '">' + check(p.wateredToday) + '</button>' +
      '<button class="hit grow" data-open="' + p.id + '">' + pic(p, 'thumb') +
      '<span class="txt"><b>' + esc(p.name) + '</b><small>раз в ' + days(p.every) + '</small></span>' + chip(w[0], w[1]) + '</button></div>';
  }

  function headline(dark, gray, label) {
    return '<section class="headline">' + (label ? '<p class="label">' + label + '</p>' : '') +
      '<h1>' + esc(dark) + (gray ? '<br><span>' + esc(gray) + '</span>' : '') + '</h1></section>';
  }

  function scanFacts(s) {
    return '<ul class="facts">' +
      fact('eco', s.statusText || STATUS[s.status][0]) +
      (s.pot !== 'unknown' ? fact('potted_plant', s.potText || POT[s.pot][0]) : '') +
      fact('water_drop', 'раз в ' + days(s.every) + (s.waterText ? ', ' + s.waterText : '')) +
      (s.light ? fact('light_mode', s.light) : '') + '</ul>';
  }

  function scanChips(s) {
    return '<div class="chips">' + chip(STATUS[s.status][0], STATUS[s.status][1], STATUS[s.status][2]) +
      (POT[s.pot] ? chip(POT[s.pot][0], POT[s.pot][1], 'potted_plant') : '') + '</div>';
  }

  function todoCard(s) {
    if (!s.todo.length) return '';
    return '<section class="card todo"><div class="card-head"><div><h3>Сделать</h3></div></div><ul class="facts">' +
      s.todo.map((t) => fact('arrow_right_alt', t)).join('') + '</ul></section>';
  }

  // ── Сегодня ──
  function viewToday() {
    const due = state.plants.filter((p) => p.dueIn <= 0 || p.wateredToday);
    const left = due.filter((p) => !p.wateredToday).length;
    const care = state.plants.filter((p) => p.scan && (p.scan.status !== 'ok' || p.scan.pot === 'small'));
    const next = state.plants.filter((p) => p.dueIn > 0 && !p.wateredToday).sort((a, b) => a.dueIn - b.dueIn)[0];
    const d = new Date(state.today + 'T00:00:00Z');

    let h = headline(
      left ? 'Полить ' + left + ' ' + plural(left, 'цветок', 'цветка', 'цветков') : 'Все напоены',
      care.length ? 'и ' + care.length + ' ' + plural(care.length, 'просит', 'просят', 'просят') + ' внимания' : 'остальные в порядке',
      DAYS[d.getUTCDay()] + ', ' + dateLabel(state.today));

    h += '<section class="card green"><div class="card-head"><div><h3>Полив</h3><p>' +
      (due.length ? 'тыкай в квадратик, когда польёшь' : next ? 'дальше ' + next.name + ', ' + when(next)[0] : 'никого поливать не надо') +
      '</p></div><span class="circle light">' + ms('water_drop') + '</span></div>';
    if (due.length) {
      const watered = due.length - left;
      h += '<div class="big">' + watered + '<span>/' + due.length + '</span></div><div class="segs">' +
        due.map((p) => '<span class="' + (p.wateredToday ? 'on' : '') + '"></span>').join('') + '</div>' +
        '<div class="inner">' + due.map(waterRow).join('') + '</div>' +
        (left > 1 ? '<button class="pill light" data-action="water-all"><span>Полила всех</span><i>' + ms('done_all') + '</i></button>' : '');
    }
    h += '</section>';

    if (care.length) {
      h += '<section class="card"><div class="card-head"><div><h3>Просят внимания</h3><p>по последнему скану</p></div></div><div class="rows">' +
        care.map((p) => {
          const s = STATUS[p.scan.status];
          return '<button class="row hit grow" data-open="' + p.id + '">' + pic(p, 'thumb') + '<span class="txt"><b>' + esc(p.name) + '</b><small>' +
            esc(p.scan.todo[0] || p.scan.statusText) + '</small></span>' +
            (p.scan.status !== 'ok' ? chip(s[0], s[1]) : chip(POT.small[0], POT.small[1])) + '</button>';
        }).join('') + '</div></section>';
    }

    h += '<button class="card scan-cta" data-go="scan"><span class="circle">' + ms('photo_camera') + '</span><span class="txt"><b>Проверить цветок</b><small>сфоткай, скажу, всё ли ок</small></span>' + ms('chevron_right') + '</button>';
    return h;
  }

  // ── Цветы ──
  function viewPlants() {
    const sorted = state.plants.slice().sort((a, b) => a.dueIn - b.dueIn);
    let h = headline('Мои цветы', state.plants.length + ' ' + plural(state.plants.length, 'штука', 'штуки', 'штук'));
    h += '<div class="tiles">' + sorted.map((p) => {
      const w = when(p);
      const s = p.scan ? STATUS[p.scan.status] : null;
      return '<button class="tile" data-open="' + p.id + '">' + pic(p, 'pic') +
        (s && p.scan.status !== 'ok' ? '<span class="flag ' + s[1] + '">' + ms(s[2]) + '</span>' : '') +
        '<span class="tile-body"><b>' + esc(p.name) + '</b>' + chip(w[0], w[1], 'water_drop') + '</span></button>';
    }).join('') +
      '<button class="tile add" data-go="scan"><span class="pic">' + ms('add_a_photo') + '</span><span class="tile-body"><b>Добавить</b><small>через скан</small></span></button></div>';
    return h;
  }

  // ── Карточка цветка ──
  function viewPlant(id) {
    const p = byId(id);
    if (!p) return viewPlants();
    const s = p.scan;
    const w = when(p);
    let h = '<div class="topbar"><button class="circle" data-go="plants">' + ms('arrow_back') + '</button></div>';
    h += '<section class="hero-photo">' + pic(p, 'photo') + '</section>';
    h += headline(p.name, s && s.latin ? s.latin : '');
    if (s) h += scanChips(s);

    h += '<section class="card"><div class="card-head"><div><h3>Полив</h3><p>' +
      (p.wateredToday ? 'полито сегодня, следующий через ' + days(p.every) : (p.last ? 'последний ' + dateLabel(p.last) + ', ' : '') + 'следующий ' + w[0]) + '</p></div>' +
      '<button class="water-btn' + (p.wateredToday ? ' on' : '') + '" data-water="' + p.id + '">' + ms('water_drop') + (p.wateredToday ? 'Полито' : 'Полила') + '</button></div>' +
      '<div class="stepper"><span>Раз в</span><button class="circle" data-every="' + (p.every - 1) + '">' + ms('remove') + '</button><b>' + days(p.every) + '</b>' +
      '<button class="circle" data-every="' + (p.every + 1) + '">' + ms('add') + '</button></div>' +
      (s && s.every !== p.every ? '<button class="hint" data-every="' + s.every + '">' + ms('auto_awesome') + 'Скан советует раз в ' + days(s.every) + ', поставить?</button>' : '') +
      '</section>';

    if (s) {
      h += '<section class="card"><div class="card-head"><div><h3>Как дела</h3><p>скан от ' + dateLabel(s.date) + '</p></div></div>' + scanFacts(s) + '</section>';
      h += todoCard(s);
    } else {
      h += '<section class="card empty-card"><p>Этот цветок ещё не сканировали. Сфоткай его, и тут появится, всё ли с ним ок.</p></section>';
    }

    h += '<button class="pill" data-rescan="' + p.id + '"><span>' + (s ? 'Пересканировать' : 'Сканировать') + '</span><i>' + ms('photo_camera') + '</i></button>';
    h += '<button class="link-btn" data-delete="' + p.id + '">' + ms('delete') + 'Удалить из коллекции</button>';
    return h;
  }

  // ── Скан ──
  function viewScan() {
    if (!scan) {
      return headline('Проверить цветок', 'сфоткай целиком, вместе с горшком') +
        '<button class="card camera" data-action="shoot"><span class="lens">' + ms('photo_camera') + '</span><b>Сделать фото</b><small>или выбрать из галереи</small></button>';
    }
    let h = '<div class="topbar"><button class="circle" data-action="scan-reset">' + ms('close') + '</button></div>';
    h += '<section class="hero-photo"><span class="photo"><img src="' + scan.preview + '" alt=""></span>' +
      (scan.status === 'loading' ? '<span class="scanning"><i></i></span>' : '') + '</section>';
    if (scan.status === 'loading') return h + headline('Смотрю…', 'пара секунд');
    if (scan.status === 'error') {
      return h + headline('Не получилось', scan.error) + '<button class="pill" data-action="shoot"><span>Сфоткать ещё раз</span><i>' + ms('photo_camera') + '</i></button>';
    }
    const s = scan.result;
    h += headline(s.name, s.latin) + scanChips(s);
    if (s.confidence === 'low') h += '<p class="note">Не до конца уверена, что это он. Можно сфоткать поближе.</p>';
    h += '<section class="card">' + scanFacts(s) + '</section>' + todoCard(s);
    const target = scan.target && byId(scan.target);
    if (target) {
      h += '<button class="pill" data-save="' + target.id + '"><span>Сохранить в «' + esc(target.name) + '»</span><i>' + ms('check') + '</i></button>';
    } else {
      h += '<section class="card"><div class="card-head"><div><h3>Это кто из твоих?</h3><p>сохраню фото и скан в карточку</p></div></div>' +
        '<div class="pick">' + state.plants.map((p) => '<button class="toggle" data-save="' + p.id + '">' + esc(p.name) + '</button>').join('') + '</div>' +
        '<button class="pill" data-save="new"><span>Это новый цветок</span><i>' + ms('add') + '</i></button></section>';
    }
    return h;
  }

  function render(error) {
    if (!state) {
      root.innerHTML = '<div class="loading">' + (error ? esc(error) : '<span class="spinner"></span>') + '</div>';
      return;
    }
    const tab = route.startsWith('plant/') ? 'plants' : route;
    let view;
    if (route.startsWith('plant/')) view = viewPlant(route.slice(6));
    else if (route === 'plants') view = viewPlants();
    else if (route === 'scan') view = viewScan();
    else view = viewToday();
    root.innerHTML = '<nav class="tabs">' + TABS.map((t) => '<button data-go="' + t[0] + '" class="' + (t[0] === tab ? 'on' : '') + '">' +
      (t[0] === 'scan' ? ms('photo_camera') : '') + t[1] + '</button>').join('') + '</nav><main>' + view + '</main>';
  }

  function go(r) {
    route = r;
    history.replaceState(null, '', '#' + r);
    render(); window.scrollTo(0, 0);
  }

  async function act(fn) {
    if (busy) return;
    busy = true;
    try { state = await fn(); render(); } catch (e) { alert(e.message); } finally { busy = false; }
  }

  // Фото: ужимаем до 1024px по длинной стороне прямо на телефоне.
  function shrink(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        c.toBlob((b) => (b ? resolve({ blob: b, preview: c.toDataURL('image/jpeg', 0.7) }) : reject(new Error('Не получилось прочитать фото'))), 'image/jpeg', 0.85);
      };
      img.onerror = () => reject(new Error('Не получилось прочитать фото'));
      img.src = URL.createObjectURL(file);
    });
  }

  const camera = document.createElement('input');
  camera.type = 'file'; camera.accept = 'image/*'; camera.hidden = true;
  document.body.appendChild(camera);
  let scanTarget = null;

  camera.addEventListener('change', async () => {
    const file = camera.files[0];
    camera.value = '';
    if (!file) return;
    try {
      const img = await shrink(file);
      scan = { status: 'loading', preview: img.preview, target: scanTarget };
      go('scan');
      const res = await api('/api/scan', img.blob, true);
      scan = { ...scan, status: 'done', result: res.scan };
    } catch (e) {
      scan = { ...(scan || {}), status: 'error', error: e.message };
    }
    if (route === 'scan') render();
  });

  function shoot(target) {
    scanTarget = target || null;
    camera.click();
  }

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.go) return go(d.go);
    if (d.open) return go('plant/' + d.open);
    if (d.water) { haptic(); return act(() => api('/api/water', { plant: d.water })); }
    if (d.every) {
      const p = byId(route.slice(6));
      const every = Number(d.every);
      if (!p || every < 1 || every > 60) return;
      haptic();
      return act(() => api('/api/plant/update', { plant: p.id, every }));
    }
    if (d.rescan) return shoot(d.rescan);
    if (d.delete) {
      const p = byId(d.delete);
      if (!confirm('Удалить «' + p.name + '»?')) return;
      await act(() => api('/api/plant/delete', { plant: p.id }));
      return go('plants');
    }
    if (d.save) {
      haptic();
      let saved = null;
      await act(async () => { const r = await api('/api/scan/save', { target: d.save }); saved = r.saved; return r; });
      if (saved) { scan = null; go('plant/' + saved); }
      return;
    }
    if (d.action === 'shoot') return shoot(scan && scan.target);
    if (d.action === 'scan-reset') { scan = null; return go('scan'); }
    if (d.action === 'water-all') { haptic(); return act(() => api('/api/water-all', {})); }
  });

  render();
  api('/api/state').then((s) => { state = s; render(); }).catch((e) => render(e.message));
}

const PAGE = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Мои цветы</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,300..500,0..1,0&display=block" rel="stylesheet">
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root {
  --bg:#EEF1EC; --card:#FFFFFF; --soft:#F4F6F3; --text:#1C211D; --muted:#8A938B; --line:#ECEFEA; --ring:#D3DACF;
  --sage:#5E7C55; --sage-dark:#3E5638; --sage-soft:#E3EBDE; --lime:#EBF1D2; --lime-text:#5E6B2A; --warm:#F6E9DD; --warm-text:#9A5B32;
  --ink:#1F2621; --ink-text:#FFFFFF;
  --green:linear-gradient(155deg, #7D9970 0%, #5E7C55 45%, #3F5839 100%);
}
.dark {
  --bg:#121513; --card:#1B1F1C; --soft:#222723; --text:#EDF1EB; --muted:#7E877F; --line:#262B27; --ring:#3A423B;
  --sage:#86A67A; --sage-dark:#A9C69C; --sage-soft:#26311F; --lime:#2C3220; --lime-text:#C9D69A; --warm:#33271E; --warm-text:#E2A57A;
  --ink:#EDF1EB; --ink-text:#121513;
  --green:linear-gradient(155deg, #5B7651 0%, #435E3D 50%, #2D4029 100%);
}
* { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.4 Manrope, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing:antialiased; }
button { font:inherit; color:inherit; }
main { padding:8px 16px 40px; max-width:560px; margin:0 auto; display:flex; flex-direction:column; gap:12px; }

.ms { font-family:'Material Symbols Rounded'; font-weight:normal; font-style:normal; font-size:20px; line-height:1; letter-spacing:normal; text-transform:none; white-space:nowrap; direction:ltr; font-feature-settings:'liga'; -webkit-font-feature-settings:'liga'; font-variation-settings:'FILL' 0, 'wght' 400, 'opsz' 24; display:inline-block; }

.tabs { position:sticky; top:0; z-index:5; display:flex; gap:4px; margin:0 auto; max-width:560px; padding:12px 16px 10px; background:var(--bg); }
.tabs button { flex:1; display:flex; align-items:center; justify-content:center; gap:6px; border:0; background:var(--card); color:var(--muted); font-size:13.5px; font-weight:500; padding:10px 0; border-radius:99px; cursor:pointer; }
.tabs button .ms { font-size:18px; }
.tabs button.on { background:var(--sage); color:#fff; }

.headline { padding:14px 4px 4px; }
.label { margin:0 0 10px; font-size:13px; color:var(--muted); }
h1 { margin:0; font-size:30px; line-height:1.12; font-weight:400; letter-spacing:-.035em; }
h1 span { color:var(--muted); font-weight:300; }
.topbar { display:flex; padding-top:4px; }

.card { background:var(--card); border-radius:28px; padding:20px; border:0; text-align:left; }
.card-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:14px; }
h3 { margin:0; font-size:19px; font-weight:500; letter-spacing:-.02em; }
.card-head p { margin:3px 0 0; font-size:13px; color:var(--muted); }
.circle { flex:none; width:40px; height:40px; border-radius:50%; border:1px solid var(--line); background:var(--card); display:grid; place-items:center; cursor:pointer; color:var(--text); padding:0; }

.card.green { background:var(--green); color:#fff; }
.card.green .card-head p { color:rgba(255,255,255,.72); }
.circle.light { background:rgba(255,255,255,.14); border-color:rgba(255,255,255,.22); color:#fff; }
.big { font-size:44px; font-weight:300; letter-spacing:-.04em; line-height:1; margin:4px 0 14px; }
.big span { opacity:.55; font-size:26px; }
.segs { display:flex; gap:3px; height:30px; border-radius:10px; overflow:hidden; margin-bottom:16px; }
.segs span { flex:1; background:rgba(255,255,255,.16); transition:background .3s; }
.segs span.on { background:rgba(255,255,255,.88); }
.inner { background:var(--card); color:var(--text); border-radius:20px; padding:4px 10px; }

.rows { margin:0 -4px; }
.row { display:flex; align-items:center; gap:6px; width:100%; padding:8px 0; border:0; border-top:1px solid var(--line); background:none; text-align:left; }
.rows .row:first-child, .inner .row:first-child { border-top:0; }
.hit { display:flex; align-items:center; gap:12px; border:0; background:none; padding:4px; cursor:pointer; text-align:left; }
.hit.grow { flex:1; min-width:0; }
.row.done .txt b { color:var(--muted); }
.txt { flex:1; display:flex; flex-direction:column; gap:1px; min-width:0; }
.txt b { font-weight:500; font-size:15px; }
.txt small { color:var(--muted); font-size:12.5px; }
.check { flex:none; width:26px; height:26px; border-radius:9px; border:1.5px solid var(--ring); display:grid; place-items:center; color:#fff; transition:all .2s; }
.check.on { background:var(--sage); border-color:var(--sage); }
.check .ms { font-size:18px; font-variation-settings:'FILL' 0, 'wght' 600, 'opsz' 20; }
.thumb { flex:none; width:44px; height:44px; border-radius:14px; overflow:hidden; background:var(--soft); display:grid; place-items:center; color:var(--muted); }
.thumb img, .pic img, .photo img { width:100%; height:100%; object-fit:cover; display:block; }
.row.done .thumb img { opacity:.6; }

.chip { flex:none; display:inline-flex; align-items:center; gap:4px; font-size:12px; font-weight:500; padding:5px 10px; border-radius:99px; background:var(--soft); color:var(--muted); white-space:nowrap; }
.chip .ms { font-size:15px; }
.chip.sage { background:var(--sage-soft); color:var(--sage-dark); }
.chip.lime { background:var(--lime); color:var(--lime-text); }
.chip.warm { background:var(--warm); color:var(--warm-text); }
.chips { display:flex; flex-wrap:wrap; gap:6px; padding:0 4px; }
.chips .chip { font-size:13px; padding:7px 12px; }

.pill { display:flex; align-items:center; justify-content:space-between; width:100%; padding:6px 6px 6px 22px; border:0; border-radius:99px; background:var(--ink); color:var(--ink-text); font-weight:500; cursor:pointer; }
.pill i { width:42px; height:42px; border-radius:50%; background:var(--sage); color:#fff; display:grid; place-items:center; font-style:normal; }
.pill.light { margin-top:12px; background:rgba(255,255,255,.95); color:#2D4029; }
.card .pill { margin-top:16px; }

.scan-cta { display:flex; align-items:center; gap:14px; width:100%; cursor:pointer; color:var(--text); }
.scan-cta .circle { background:var(--sage-soft); border:0; color:var(--sage-dark); }

.tiles { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.tile { position:relative; display:flex; flex-direction:column; border:0; padding:6px; border-radius:24px; background:var(--card); text-align:left; cursor:pointer; }
.pic { display:grid; place-items:center; aspect-ratio:1; border-radius:19px; overflow:hidden; background:var(--soft); color:var(--muted); }
.pic .ms { font-size:30px; }
.tile.add .pic { border:1.5px dashed var(--ring); background:none; }
.tile-body { display:flex; flex-direction:column; align-items:flex-start; gap:8px; padding:10px 8px 6px; }
.tile-body b { font-weight:500; font-size:14px; line-height:1.25; min-height:2.5em; }
.tile-body small { color:var(--muted); font-size:12.5px; margin-top:-6px; }
.flag { position:absolute; top:14px; right:14px; width:32px; height:32px; border-radius:50%; display:grid; place-items:center; }
.flag.lime { background:var(--lime); color:var(--lime-text); } .flag.warm { background:var(--warm); color:var(--warm-text); }
.flag .ms { font-size:18px; }

.hero-photo { position:relative; }
.photo { display:grid; place-items:center; width:100%; aspect-ratio:4/3; border-radius:28px; overflow:hidden; background:var(--card); color:var(--muted); }
.photo .ms { font-size:44px; }
.scanning { position:absolute; inset:0; border-radius:28px; overflow:hidden; background:rgba(30,40,30,.25); }
.scanning i { position:absolute; left:0; right:0; height:3px; background:#fff; box-shadow:0 0 18px 4px rgba(255,255,255,.7); animation:sweep 1.6s ease-in-out infinite alternate; }
@keyframes sweep { from { top:6%; } to { top:94%; } }

.water-btn { flex:none; display:flex; align-items:center; gap:6px; border:0; border-radius:99px; padding:9px 14px 9px 12px; background:var(--sage-soft); color:var(--sage-dark); font-weight:500; font-size:14px; cursor:pointer; }
.water-btn.on { background:var(--sage); color:#fff; }
.water-btn .ms { font-size:18px; }
.stepper { display:flex; align-items:center; gap:10px; background:var(--soft); border-radius:18px; padding:8px 8px 8px 16px; }
.stepper span { color:var(--muted); font-size:14px; flex:1; }
.stepper b { font-weight:500; font-size:16px; min-width:72px; text-align:center; }
.hint { display:flex; align-items:center; gap:8px; width:100%; margin-top:10px; border:0; background:var(--lime); color:var(--lime-text); border-radius:14px; padding:10px 12px; font-size:13px; font-weight:500; text-align:left; cursor:pointer; }
.hint .ms { font-size:18px; }

.facts { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:12px; }
.facts li { display:flex; gap:12px; align-items:flex-start; font-size:15px; }
.facts .ms { flex:none; width:32px; height:32px; border-radius:10px; background:var(--soft); color:var(--sage); display:grid; place-items:center; font-size:19px; }
.facts span:last-child { padding-top:5px; }
.card.todo { background:var(--warm); }
.card.todo .facts .ms { background:rgba(255,255,255,.6); color:var(--warm-text); }
.dark .card.todo .facts .ms { background:rgba(0,0,0,.2); }
.empty-card p { margin:0; color:var(--muted); }
.note { margin:0 4px; font-size:13px; color:var(--warm-text); }
.link-btn { display:flex; align-items:center; justify-content:center; gap:6px; border:0; background:none; color:var(--muted); font-size:13px; padding:8px; cursor:pointer; }
.link-btn .ms { font-size:17px; }

.camera { display:flex; flex-direction:column; align-items:center; gap:6px; width:100%; padding:44px 20px; cursor:pointer; color:var(--text); text-align:center; }
.lens { width:84px; height:84px; border-radius:50%; background:var(--green); color:#fff; display:grid; place-items:center; margin-bottom:10px; }
.lens .ms { font-size:36px; }
.camera b { font-weight:500; font-size:18px; }
.camera small { color:var(--muted); }
.pick { display:flex; flex-wrap:wrap; gap:6px; }
.toggle { border:1px solid var(--ring); background:none; font-size:13px; font-weight:500; padding:7px 13px; border-radius:99px; cursor:pointer; }

.loading { min-height:80vh; display:grid; place-items:center; padding:24px; text-align:center; font-size:16px; color:var(--muted); }
.spinner { width:28px; height:28px; border-radius:50%; border:3px solid var(--ring); border-top-color:var(--sage); animation:spin 1s linear infinite; }
@keyframes spin { to { rotate:360deg; } }
</style></head>
<body><div id="root"></div>
<script>(${app.toString()})();</script>
</body></html>`;
