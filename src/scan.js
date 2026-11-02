// Сканер: отправляем фото в модель с поддержкой картинок и получаем короткий разбор.

import { config } from './config.js';
import { todayLocal } from './dates.js';

const SCHEMA = `Ответь ТОЛЬКО JSON без пояснений и без markdown, строго по схеме:
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
Правила: только то, что нужно для ухода. Никакой истории, ботаники, родины, токсичности.
status: ok — здоровое и растёт; watch — есть мелочи; help — нужно лечить.
pot: small — корни лезут, растение сильно больше горшка; big — горшок явно велик; unknown — горшка не видно.
Пиши коротко и спокойно, по-разговорному, без канцелярита.`;

// Один шаг: модель для фото сразу отвечает по схеме.
const SCAN_PROMPT = `Ты помогаешь с комнатными растениями. На фото растение (возможно, с горшком).
Смотри на пятна, желтизну, сухие края, вялость, вредителей, размер горшка.
${SCHEMA}`;

// Два шага: сначала модель для фото описывает, что видит, потом текстовая модель делает вывод.
const LOOK_PROMPT = `На фото комнатное растение. Опиши только то, что видно, коротко, списком:
- что это за растение (по-русски и латынью) и насколько ты уверена;
- листья и стебли: цвет, пятна, желтизна, сухие или бурые края, вялость, следы вредителей, новые листья;
- грунт, если виден: сухой или мокрый, налёт;
- горшок относительно растения: впору, тесный (корни лезут), явно велик, не виден;
- где стоит и какой свет, если понятно.
Без советов и без лишних слов.`;

const ADVISE_PROMPT = (seen) => `Ты помогаешь с комнатными растениями. Вот что видно на фото растения:
${seen}

По этому описанию сделай вывод о состоянии и короткие рекомендации.
${SCHEMA}`;

const cut = (s, n) => String(s || '').trim().slice(0, n);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);

function parseLooseJSON(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Сканер ответил непонятно, попробуй ещё раз');
  return JSON.parse(m[0]);
}

export function normalizeScan(r) {
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

// Достаём текст ответа. Модели с «размышлениями» иногда кладут всё в reasoning, а content оставляют пустым,
// а некоторые отдают content списком кусочков.
function replyText(message) {
  const c = message?.content;
  const text = Array.isArray(c) ? c.map((part) => part?.text || '').join('') : c || '';
  return text.trim() || String(message?.reasoning || '').trim();
}

async function chat(model, content, maxTokens) {
  const res = await fetch(config.llmBaseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + config.llmApiKey,
      'Content-Type': 'application/json',
      'X-Title': 'plantsplants',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.2, messages: [{ role: 'user', content }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    console.error('Сканер: ошибка от', model, res.status, JSON.stringify(data.error || data).slice(0, 500));
    throw new Error('Сканер сейчас недоступен: ' + (data.error?.message || res.status));
  }
  const choice = data.choices?.[0];
  const text = replyText(choice?.message);
  if (!text) {
    console.error('Сканер: пустой ответ от', model, JSON.stringify(data).slice(0, 1000));
    throw new Error(`Сканер ответил пустотой (${model}, ${choice?.finish_reason || 'без причины'}), попробуй ещё раз`);
  }
  return text;
}

export async function scanPhoto(bytes) {
  if (!config.llmApiKey) throw new Error('Сканер пока не подключён. Полив и напоминалки работают.');
  const image = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + Buffer.from(bytes).toString('base64') } };
  if (!config.llmTextModel) {
    return normalizeScan(parseLooseJSON(await chat(config.llmVisionModel, [{ type: 'text', text: SCAN_PROMPT }, image], 4000)));
  }
  const seen = await chat(config.llmVisionModel, [{ type: 'text', text: LOOK_PROMPT }, image], 3000);
  return normalizeScan(parseLooseJSON(await chat(config.llmTextModel, ADVISE_PROMPT(seen), 4000)));
}

const STATUS = { ok: 'всё ок', watch: 'присмотреться', help: 'подлечить' };
const POT = { ok: 'горшок норм', small: 'тесный горшок', big: 'горшок великоват', unknown: '' };
const html = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Текст ответа в чате.
export function scanText(s) {
  const lines = [`🌿 <b>${html(s.name)}</b>${s.latin ? ' · <i>' + html(s.latin) + '</i>' : ''}`, ''];
  lines.push(`Состояние: ${STATUS[s.status]}${s.statusText ? ', ' + html(s.statusText) : ''}`);
  if (s.pot !== 'unknown') lines.push(`Горшок: ${html(s.potText || POT[s.pot])}`);
  lines.push(`Полив: раз в ${s.every} дн.${s.waterText ? ', ' + html(s.waterText) : ''}`);
  if (s.light) lines.push(`Свет: ${html(s.light)}`);
  if (s.todo.length) lines.push('', '<b>Сделать:</b>', ...s.todo.map((t) => '• ' + html(t)));
  if (s.confidence === 'low') lines.push('', 'Не до конца уверена, что это за цветок. Можно сфоткать поближе.');
  return lines.join('\n');
}
