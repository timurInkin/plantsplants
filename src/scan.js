// Сканер: отправляем фото в модель с поддержкой картинок и получаем короткий разбор.

import { config } from './config.js';
import { todayLocal } from './dates.js';
import { lookUpReferences } from './references.js';
import { step, noteCall } from './timing.js';

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
  "need_photos": ["что ещё сфоткать, чтобы ответить точно: одно простое действие простыми словами, по 5–12 слов, до 2 пунктов; пустой массив, если всего хватает"],
  "photos": [{"n": номер фото: 2, 3 или 4, "seen": "что крупно на этом фото и что с этим не так, до 12 слов", "means": "что это значит: причина и насколько это серьёзно, до 25 слов", "todo": ["что сделать именно с этим, до 2 пунктов по 6–14 слов; пустой массив, если ничего не надо"]}]
}
Правила:
- Только то, что нужно для ухода и лечения. Никакой истории, родины, ботанических справок, токсичности.
- Не выдумывай то, чего не видно. Если для вывода о здоровье, поливе или горшке чего-то не хватает, попроси это в need_photos, а не гадай.
  Проси только то, что снимается за полминуты и не трогая растение:
  всё растение в горшке, отойдя на шаг, чтобы целиком влезли и листья, и горшок; горшок снизу, приподняв его (видно ли корни в дырках);
  лист с обратной стороны вблизи; пятно или сухой кончик крупно при дневном свете; грунт сверху.
  Никогда не проси вынуть растение из горшка, показать корни, пересадить, что-то срезать, мерить линейкой, переносить растение или ставить что-то рядом для масштаба.
  Не проси то, что уже видно на фото, и не проси фото только ради точного сорта, если на уход это не влияет.
  Пиши как просьбу другу, без терминов: «сфоткай горшок снизу: видно ли корни в дырках», а не «оценить корни в дренаже».
  Пока фото нет, в соответствующем поле честно скажи, что не видно, и ставь pot unknown, если про горшок нельзя сказать уверенно.
- В todo не советуй вынимать растение и смотреть корни, если нет явных признаков беды с корнями (вялость при мокром грунте, запах, корни лезут из дырок).
- photos: если фото больше одного, по объекту на каждое фото, начиная со второго (первое — общий план, его разбор в остальных полях). Если фото одно, пустой массив.
  Пиши про то, что видно именно на этом фото. Например, на фото один жёлтый лист: это перелив, нехватка света или старый лист отмирает, и срезать ли его.
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
Пиши сжато, тезисами, без вводных фраз и повторов: только признаки, которые есть на фото. Вся заметка до 180 слов.

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
4. Условия, если видно: свет (прямое солнце, рассеянный, тень), близость к окну или батарее.
5. Если фото несколько: для каждого фото, начиная со второго, отдельная строка «Фото N: что на нём крупно и какие на нём симптомы».
Пропускай пункты, о которых на фото ничего не сказать. На каждое фото, начиная со второго, можно ещё до 40 слов.`;

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
    needPhotos: (Array.isArray(r.need_photos) ? r.need_photos : []).map((t) => cut(t, 120)).filter(Boolean).slice(0, 2),
    details: (Array.isArray(r.photos) ? r.photos : []).filter((x) => x && typeof x === 'object').map((x) => ({
      n: Math.round(Number(x.n)) || 0, seen: cut(x.seen, 140), means: cut(x.means, 260),
      todo: (Array.isArray(x.todo) ? x.todo : []).map((t) => cut(t, 160)).filter(Boolean).slice(0, 2),
    })),
    date: todayLocal(),
  };
}

function partsText(c) {
  return (Array.isArray(c) ? c.map((part) => part?.text || '').join('') : c || '').trim();
}

// Запрос к модели. Возвращает основной ответ и «размышления»: модели с размышлениями иногда кладут ответ туда.
// В OpenRouter просим самого быстрого провайдера модели и, если задано, меньше «размышлений» (reasoning).
const openRouter = () => config.llmBaseUrl.includes('openrouter.ai');
function reasoningParam(effort) {
  if (!effort || !openRouter()) return {};
  return { reasoning: effort === 'off' ? { enabled: false } : { effort } };
}

async function chat(model, content, { maxTokens, json = false, effort = '' } = {}) {
  const t0 = Date.now();
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
      ...(openRouter() ? { provider: { sort: 'throughput' } } : {}),
      ...reasoningParam(effort),
    }),
  });
  const data = await res.json().catch(() => ({}));
  // Сколько модель думала и писала: по этим строчкам видно, на чём теряется время.
  const u = data.usage || {};
  noteCall({ model, provider: data.provider || '', s: Math.round((Date.now() - t0) / 100) / 10, in: u.prompt_tokens ?? null, out: u.completion_tokens ?? null,
    thinking: u.completion_tokens_details?.reasoning_tokens ?? null, ok: res.ok && !data.error });
  console.log(`🧠 ${model}${data.provider ? ' через ' + data.provider : ''}: ${((Date.now() - t0) / 1000).toFixed(1)} с, ` +
    `фото и текст на входе ${u.prompt_tokens ?? '?'} ток., ответ ${u.completion_tokens ?? '?'} ток.` +
    (u.completion_tokens_details?.reasoning_tokens ? `, из них размышления ${u.completion_tokens_details.reasoning_tokens}` : ''));
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
  const r = await chat(config.llmVisionModel, content, { maxTokens: 12000, effort: config.llmLookEffort });
  const text = r.text || r.reasoning;
  if (!text) {
    console.error('Сканер: пустой ответ от', config.llmVisionModel, JSON.stringify(r.raw).slice(0, 1500));
    throw new Error(`Сканер ответил пустотой (${r.finish || 'без причины'}), попробуй ещё раз`);
  }
  return text;
}

// Вывод по схеме. Если JSON не нашёлся, переспрашиваем один раз построже.
async function verdict(model, content, effort = config.llmAdviseEffort) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chat(model, attempt === 0 ? content : withStrict(content), { maxTokens: 12000, json: true, effort });
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

// Подсказки к промпту: справочные сервисы, комментарий человека к фото и сколько фото уже прислали.
// prior — что показал скан по первым фото, если эти фото досняты к нему.
function extras(references, note, count = 1, prior = null, forLook = false, detail = false) {
  let t = '';
  if (count > 1 && detail) {
    t += '\nПервое фото — растение целиком, его уже разбирали. Остальные — крупные планы деталей, которые хозяйка специально показывает ' +
      '(пятно, лист, стебель, грунт). Разгляди эти детали внимательно и обнови состояние, причину и советы с их учётом.';
    t += forLook ? '\n' : ' Ещё фото проси, только если без них вывод будет неверным.\n';
  } else if (count > 1) {
    t += '\nПервое фото основное для определения вида. Остальные досняты по просьбе: горшок, грунт, листья поближе.';
    t += forLook ? '\n' : ` Это уже ${count} фото, ещё фото проси, только если без них вывод будет неверным.\n`;
  }
  if (prior?.latin) {
    t += `\nПо первым фото растение уже определено как ${prior.name} (${prior.latin}). Не меняй вид, если на новых фото нет явного признака другого вида: ` +
      'досъёмка нужна, чтобы уточнить состояние, горшок и грунт.\n';
  }
  if (references) t += `\nСправочные данные по этим фото:\n${references}\n`;
  if (note) t += `\nХозяйка растения пишет: «${String(note).slice(0, 500)}». Учти это.\n`;
  return t;
}

// images — одно или несколько фото одного растения; note — подпись человека к фото;
// onStage(text) — по ходу скана сообщает, что сейчас происходит («похоже, это …», «пишу советы»), чтобы ждать было не вслепую;
// prior — результат скана по первым фото, если новые фото досняты к нему; detail — новые фото это крупные планы деталей цветка из коллекции.
// Справочники и модель для фото работают одновременно, чтобы не ждать их по очереди:
// подсказки Pl@ntNet и Perenual получает модель, которая пишет вывод.
export async function scanPhoto(images, note = '', onStage = null, prior = null, detail = false) {
  if (!config.llmApiKey) throw new Error('Сканер пока не подключён. Полив и напоминалки работают.');
  images = [].concat(images);
  const pics = images.map((b) => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + Buffer.from(b).toString('base64') } }));
  let guess = '';
  const say = (text) => { try { onStage?.(text); } catch {} };
  const refsJob = step('справочники', lookUpReferences(images)).then((r) => {
    if (r.identified) {
      guess = `Похоже, это ${r.identified.latin} (${Math.round(r.identified.score * 100)}% по Pl@ntNet). `;
      say(guess + 'Разглядываю листья, грунт и горшок…');
    }
    return r;
  });
  let scan, refs;
  // Быстрый путь: одна модель сразу пишет вывод. Ждём только справочники (Pl@ntNet), и не дольше 8 секунд.
  if (config.llmFastModel) {
    try {
      refs = await Promise.race([refsJob, new Promise((r) => setTimeout(() => r({ text: '' }), 8000))]);
      say(guess + 'Пишу вывод и советы, ещё немного…');
      scan = await step('быстрая модель', verdict(config.llmFastModel,
        [{ type: 'text', text: SCAN_PROMPT + extras(refs.text, note, images.length, prior, false, detail) }, ...pics], config.llmFastEffort));
    } catch (e) {
      console.error('Быстрая модель не ответила, сканирую обычным путём:', e.message);
      scan = null;
    }
  }
  if (scan) {
    // Быстрая модель справилась.
  } else if (!config.llmTextModel) {
    refs = await refsJob;
    scan = await step('модель', verdict(config.llmVisionModel, [{ type: 'text', text: SCAN_PROMPT + extras(refs.text, note, images.length, prior, false, detail) }, ...pics]));
  } else {
    const seenJob = step('модель для фото', look([{ type: 'text', text: LOOK_PROMPT + extras('', note, images.length, prior, true, detail) }, ...pics]));
    [refs] = await Promise.all([refsJob, seenJob]);
    say(guess + 'Пишу вывод и советы, ещё немного…');
    scan = await step('модель для вывода', verdict(config.llmTextModel, ADVISE_PROMPT(await seenJob, extras(refs.text, note, images.length, prior, false, detail))));
  }
  scan.details = alignDetails(scan.details, images.length);
  const genus = (l) => String(l || '').trim().split(/\s+/)[0].toLowerCase();
  if (prior?.latin && genus(scan.latin) === genus(prior.latin)) {
    // Вид уже определили по первым фото. Новые фото обычно крупные планы, по ним Pl@ntNet узнаёт хуже,
    // поэтому оставляем то определение и ту уверенность, а не пугаем «не уверена, что это он».
    delete scan.identified;
    if (prior.identified) scan.identified = prior.identified;
    if (prior.confidence) scan.confidence = prior.confidence;
  } else if (refs.identified) {
    scan.identified = refs.identified;
    // Модель не согласилась с Pl@ntNet по роду: показываем оба мнения и честно снижаем уверенность.
    if (refs.identified.score >= 0.25 && genus(scan.latin) !== genus(refs.identified.latin)) {
      scan.identified.disputed = true;
      scan.confidence = 'low';
    }
  }
  // Полив держим в разумных пределах справочника: модель может сдвинуть его под горшок, но не в разы.
  if (refs.every) {
    const lo = Math.max(1, Math.floor(refs.every.min * 0.5)), hi = Math.ceil(refs.every.max * 1.5);
    scan.every = Math.min(hi, Math.max(lo, scan.every));
  }
  return scan;
}

// Разбор по каждому фото, начиная со второго, ровно по числу фото. Модель нумерует их сама: если номера странные, берём по порядку.
function alignDetails(details, count) {
  const ns = details.map((d) => d.n);
  const byNumber = ns.every((n) => n >= 2 && n <= count) && new Set(ns).size === ns.length;
  const empty = { seen: '', means: '', todo: [] };
  return Array.from({ length: Math.max(0, count - 1) }, (_, i) => {
    const d = (byNumber ? details.find((x) => x.n === i + 2) : details[i]) || empty;
    return { seen: d.seen, means: d.means, todo: d.todo };
  });
}

const STATUS = { ok: 'всё ок', watch: 'присмотреться', help: 'подлечить' };
const POT = { ok: 'горшок норм', small: 'тесный горшок', big: 'горшок великоват', unknown: '' };
const lower = (t) => /^[A-ZА-ЯЁ][a-zа-яё]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
const html = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Текст ответа в чате.
export function scanText(s) {
  const lines = [`🌿 <b>${html(s.name)}</b>${s.latin ? ' · <i>' + html(s.latin) + '</i>' : ''}`, ''];
  lines.push(`Состояние: ${STATUS[s.status]}${s.statusText ? ', ' + html(lower(s.statusText)) : ''}`);
  if (s.why) lines.push(`Почему: ${html(s.why)}`);
  if (s.pot !== 'unknown') lines.push(`Горшок: ${html(s.potText || POT[s.pot])}`);
  lines.push(`Полив: раз в ${s.every} дн.${s.waterText ? ', ' + html(lower(s.waterText)) : ''}`);
  if (s.light) lines.push(`Свет: ${html(s.light)}`);
  if (s.identified) {
    lines.push(`${s.identified.disputed ? `${s.identified.source} думает иначе` : `Вид по ${s.identified.source}`}: <i>${html(s.identified.latin)}</i>, ${Math.round(s.identified.score * 100)}%`);
  }
  if (s.todo.length) lines.push('', '<b>Сделать:</b>', ...s.todo.map((t) => '• ' + html(t)));
  (s.details || []).forEach((d, i) => {
    if (!d.seen && !d.means) return;
    lines.push('', `📷 <b>Фото ${i + 2}:</b> ${html(d.seen)}`);
    if (d.means) lines.push(html(d.means));
    lines.push(...d.todo.map((t) => '• ' + html(t)));
  });
  if (s.needPhotos?.length) {
    lines.push('', '📸 <b>Чтобы ответить точнее, пришли ещё:</b>', ...s.needPhotos.map((t) => '• ' + html(t)),
      'Просто отправь следующим сообщением, я учту все фото вместе.');
  } else if (s.confidence === 'low') lines.push('', 'Не до конца уверена, что это за цветок. Можно сфоткать поближе.');
  return lines.join('\n');
}
