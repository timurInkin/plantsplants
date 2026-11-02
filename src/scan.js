// Сканер: отправляем фото в модель с поддержкой картинок и получаем короткий разбор.

import { config } from './config.js';
import { todayLocal } from './dates.js';

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

export async function scanPhoto(bytes) {
  const res = await fetch(config.llmBaseUrl + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + config.llmApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.llmModel,
      max_tokens: 800,
      temperature: 0.2,
      messages: [{ role: 'user', content: [
        { type: 'text', text: SCAN_PROMPT },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + Buffer.from(bytes).toString('base64') } },
      ] }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Сканер сейчас недоступен: ' + (data.error?.message || res.status));
  return normalizeScan(parseLooseJSON(data.choices?.[0]?.message?.content));
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
