// Сканер: отправляем фото в модель с поддержкой картинок и получаем короткий разбор.

import { config } from './config.js';
import { todayLocal } from './dates.js';
import { lookUpReferences } from './references.js';
import { step } from './timing.js';

// Роль для обеих моделей: специалист, который смотрит на растение как ботаник и фитопатолог,
// но отвечает коротко и по делу, без лекций.
const ROLE = `Ты ботаник и фитопатолог с большим опытом по комнатным растениям: ароидные, марантовые, геснериевые, фикусы, стрелиции и т.д.
Ты определяешь растения по диагностическим признакам, а не по общему впечатлению, и ставишь диагноз по симптомам, а не наугад.`;

const SCHEMA = `Ответь ТОЛЬКО JSON без пояснений и без markdown, строго по схеме:
{
  "name": "название по-русски, как в цветочном магазине; сорт, если узнаётся (например «Аглаонема Мария»)",
  "latin": "род и вид латынью, сорт в кавычках, если узнаётся (например Aglaonema commutatum 'Maria')",
  "confidence": "high | medium | low",
  "status": "ok | watch | help",
  "status_text": "состояние с конкретикой: что видно и где, до 12 слов",
  "why": "вероятная причина по симптомам, как у специалиста: симптом → причина → почему именно она, 1–2 предложения, до 35 слов; пустая строка, если всё хорошо",
  "pot": "ok | small | big | unknown",
  "pot_text": "про горшок и грунт с цифрами, если можно: диаметр относительно кроны/корней, дренаж, субстрат, до 14 слов",
  "water_every_days": число дней между поливами для этого вида в этом горшке в комнате (18–24 °C),
  "water_text": "критерий полива для этого вида: на сколько см должен просохнуть грунт или как выглядят листья, до 12 слов",
  "light": "свет для этого вида: тип и расстояние от окна или люксы, до 10 слов",
  "todo": ["конкретные действия с цифрами и названиями (препарат, субстрат, размер горшка), до 3 пунктов, по 8–15 слов; пустой массив, если всё хорошо"],
  "need_photos": ["какие фото прислать, чтобы ответить точно: что и с какого ракурса, по 5–12 слов, до 3 пунктов; пустой массив, если всего хватает"]
}
Правила:
- Только то, что нужно для ухода и лечения. Никакой истории, родины, ботанических справок, токсичности.
- Не выдумывай то, чего не видно. Если для уверенного вывода чего-то не хватает, попроси это в need_photos, а не гадай.
  Например: горшок снизу (корни в дренаже), растение целиком рядом с горшком (размер кроны и горшка), обратная сторона листа вблизи (вредители), пятно крупно при дневном свете, грунт сверху, корни, если растение легко вынуть.
  Пока фото нет, в соответствующем поле честно скажи, что не видно, и ставь pot unknown, если про горшок нельзя сказать уверенно.
- status: ok — здоровое и растёт; watch — есть мелочи или ранние симптомы; help — нужно лечить сейчас.
- pot: small — корни в дренаже или ком плотно оплетён, крона намного шире горшка; big — горшок явно больше корневой системы (риск закисания); unknown — горшка не видно.
- Пиши коротко и спокойно, по-разговорному, без канцелярита, но точно, как специалист.`;

// Один шаг: модель для фото сразу отвечает по схеме.
const SCAN_PROMPT = `${ROLE}
На фото комнатное растение (фото может быть несколько, это одно и то же растение с разных сторон). Сначала определи его по признакам (форма и жилкование листа, рисунок пестроты, черешки, стебель и узлы, тип роста),
сравни с 2–3 похожими видами и выбери. Потом оцени состояние: пятна, хлороз (на старых или молодых листьях), некроз краёв, вялость, деформации, вредители и их следы, грунт, горшок.
${SCHEMA}`;

// Два шага: сначала модель для фото описывает, что видит, как специалист, потом текстовая модель делает вывод.
const LOOK_PROMPT = `${ROLE}
На фото комнатное растение (фото может быть несколько, это одно и то же растение с разных сторон). Опиши, что видно, как в заметке специалиста. Только наблюдения, без советов. Чего не видно, так и пиши: «не видно».

1. Определение.
   - Диагностические признаки: форма листовой пластинки и основания, жилкование, рисунок и цвет пестроты, черешок (длина, влагалище, крылатость), стебель и узлы, воздушные корни, тип роста (розетка, куст, лиана).
   - 2–3 кандидата (латынь + русское название) и чем они отличаются на этом фото.
   - Итог: род, вид, сорт если узнаётся, и уверенность (высокая / средняя / низкая).
2. Состояние.
   - Каждый симптом отдельно: что именно (хлороз, некроз, пятна с ореолом или без, мозаика, скручивание, этиоляция, потеря тургора), на каких листьях (старые нижние / молодые верхние), где на листе (край, кончик, между жилками), сколько листьев затронуто.
   - Следы вредителей: паутинка, серебристые штрихи, точки, ватные комочки, щитки, мошки над грунтом, липкость.
   - Новый рост: есть ли, нормального ли размера и цвета.
3. Грунт и горшок.
   - Грунт: сухой или влажный по цвету, корка, белый или зелёный налёт, плесень, тип субстрата (торф, кора, перлит).
   - Горшок: материал, примерный диаметр относительно кроны и стеблей, видны ли корни сверху или в дренаже.
4. Условия, если видно: свет (прямое солнце, рассеянный, тень), близость к окну или батарее.`;

const ADVISE_PROMPT = (seen, extra) => `${ROLE}
Вот заметка коллеги, который смотрел на фото растения:
${seen}
${extra}
Проверь определение по признакам из заметки и выбери самый вероятный вид. Если признаки противоречат итогу, исправь его.
Поставь диагноз: свяжи симптомы с причинами (полив, свет, влажность воздуха, питание, температура, корни, вредители, болезни), отсей маловероятные.
Дай уход именно для этого вида и этого состояния.
${SCHEMA}`;

const cut = (s, n) => String(s || '').trim().slice(0, n);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);

// Ищем JSON в тексте: модель может обернуть его в ```json или добавить слова до и после.
function findJSON(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export function normalizeScan(r) {
  return {
    name: cut(r.name, 60) || 'Неизвестный цветок',
    latin: cut(r.latin, 60),
    confidence: oneOf(r.confidence, ['high', 'medium', 'low'], 'medium'),
    status: oneOf(r.status, ['ok', 'watch', 'help'], 'ok'),
    statusText: cut(r.status_text, 120),
    why: cut(r.why, 300),
    pot: oneOf(r.pot, ['ok', 'small', 'big', 'unknown'], 'unknown'),
    potText: cut(r.pot_text, 140),
    every: Math.min(30, Math.max(1, Math.round(Number(r.water_every_days) || 7))),
    waterText: cut(r.water_text, 120),
    light: cut(r.light, 100),
    todo: (Array.isArray(r.todo) ? r.todo : []).map((t) => cut(t, 160)).filter(Boolean).slice(0, 3),
    needPhotos: (Array.isArray(r.need_photos) ? r.need_photos : []).map((t) => cut(t, 120)).filter(Boolean).slice(0, 3),
    date: todayLocal(),
  };
}

function partsText(c) {
  return (Array.isArray(c) ? c.map((part) => part?.text || '').join('') : c || '').trim();
}

// Запрос к модели. Возвращает основной ответ и «размышления»: модели с размышлениями иногда кладут ответ туда.
async function chat(model, content, { maxTokens, json = false } = {}) {
  const res = await fetch(config.llmBaseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + config.llmApiKey,
      'Content-Type': 'application/json',
      'X-Title': 'plantsplants',
    },
    body: JSON.stringify({
      model, max_tokens: maxTokens, temperature: 0.2,
      messages: [{ role: 'user', content }],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    console.error('Сканер: ошибка от', model, res.status, JSON.stringify(data.error || data).slice(0, 500));
    throw new Error('Сканер сейчас недоступен: ' + (data.error?.message || res.status));
  }
  const choice = data.choices?.[0];
  return {
    text: partsText(choice?.message?.content),
    reasoning: String(choice?.message?.reasoning || '').trim(),
    finish: choice?.finish_reason || '',
    raw: data,
  };
}

// Описание фото: берём ответ, а если он пустой — размышления.
async function look(content) {
  const r = await chat(config.llmVisionModel, content, { maxTokens: 12000 });
  const text = r.text || r.reasoning;
  if (!text) {
    console.error('Сканер: пустой ответ от', config.llmVisionModel, JSON.stringify(r.raw).slice(0, 1500));
    throw new Error(`Сканер ответил пустотой (${r.finish || 'без причины'}), попробуй ещё раз`);
  }
  return text;
}

// Вывод по схеме. Если JSON не нашёлся, переспрашиваем один раз построже.
async function verdict(model, content) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chat(model, attempt === 0 ? content : withStrict(content), { maxTokens: 12000, json: true });
    const parsed = findJSON(r.text) || findJSON(r.reasoning);
    if (parsed) return normalizeScan(parsed);
    console.error(`Сканер: нет JSON от ${model} (попытка ${attempt + 1}, ${r.finish})`, JSON.stringify(r.raw).slice(0, 1500));
  }
  throw new Error('Сканер ответил непонятно, попробуй ещё раз');
}

const STRICT = '\n\nВажно: в ответе должен быть только один JSON-объект по схеме выше, без размышлений и текста вокруг.';
function withStrict(content) {
  if (typeof content === 'string') return content + STRICT;
  return content.map((part) => (part.type === 'text' ? { ...part, text: part.text + STRICT } : part));
}

// Подсказки к промпту: справочные сервисы и комментарий человека к фото.
function extras(references, note) {
  let t = '';
  if (references) t += `\nСправочные данные по этим фото:\n${references}\n`;
  if (note) t += `\nХозяйка растения пишет: «${String(note).slice(0, 500)}». Учти это.\n`;
  return t;
}

// images — одно или несколько фото одного растения; note — подпись человека к фото.
// Справочники и модель для фото работают одновременно, чтобы не ждать их по очереди:
// подсказки Pl@ntNet и Perenual получает модель, которая пишет вывод.
export async function scanPhoto(images, note = '') {
  if (!config.llmApiKey) throw new Error('Сканер пока не подключён. Полив и напоминалки работают.');
  images = [].concat(images);
  const pics = images.map((b) => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + Buffer.from(b).toString('base64') } }));
  const refsJob = step('справочники', lookUpReferences(images));
  let scan, refs;
  if (!config.llmTextModel) {
    refs = await refsJob;
    scan = await step('модель', verdict(config.llmVisionModel, [{ type: 'text', text: SCAN_PROMPT + extras(refs.text, note) }, ...pics]));
  } else {
    const seenJob = step('модель для фото', look([{ type: 'text', text: LOOK_PROMPT + extras('', note) }, ...pics]));
    [refs] = await Promise.all([refsJob, seenJob]);
    scan = await step('модель для вывода', verdict(config.llmTextModel, ADVISE_PROMPT(await seenJob, extras(refs.text, note))));
  }
  if (refs.identified) scan.identified = refs.identified;
  // Полив держим в разумных пределах справочника: модель может сдвинуть его под горшок, но не в разы.
  if (refs.every) {
    const lo = Math.max(1, Math.floor(refs.every.min * 0.5)), hi = Math.ceil(refs.every.max * 1.5);
    scan.every = Math.min(hi, Math.max(lo, scan.every));
  }
  return scan;
}

const STATUS = { ok: 'всё ок', watch: 'присмотреться', help: 'подлечить' };
const POT = { ok: 'горшок норм', small: 'тесный горшок', big: 'горшок великоват', unknown: '' };
const html = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Текст ответа в чате.
export function scanText(s) {
  const lines = [`🌿 <b>${html(s.name)}</b>${s.latin ? ' · <i>' + html(s.latin) + '</i>' : ''}`, ''];
  lines.push(`Состояние: ${STATUS[s.status]}${s.statusText ? ', ' + html(s.statusText) : ''}`);
  if (s.why) lines.push(`Почему: ${html(s.why)}`);
  if (s.pot !== 'unknown') lines.push(`Горшок: ${html(s.potText || POT[s.pot])}`);
  lines.push(`Полив: раз в ${s.every} дн.${s.waterText ? ', ' + html(s.waterText) : ''}`);
  if (s.light) lines.push(`Свет: ${html(s.light)}`);
  if (s.identified) lines.push(`Вид по ${s.identified.source}: <i>${html(s.identified.latin)}</i>, ${Math.round(s.identified.score * 100)}%`);
  if (s.todo.length) lines.push('', '<b>Сделать:</b>', ...s.todo.map((t) => '• ' + html(t)));
  if (s.needPhotos?.length) {
    lines.push('', '📸 <b>Чтобы ответить точнее, пришли ещё:</b>', ...s.needPhotos.map((t) => '• ' + html(t)),
      'Просто отправь следующим сообщением, я учту все фото вместе.');
  } else if (s.confidence === 'low') lines.push('', 'Не до конца уверена, что это за цветок. Можно сфоткать поближе.');
  return lines.join('\n');
}
