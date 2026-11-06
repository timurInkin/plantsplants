// Скан удобрения: модель читает упаковку и составляет график подкормки под цветы человека и под сезон.

import { config } from './config.js';
import { step } from './timing.js';
import { chat, cut, findJSON } from './scan.js';

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const FORMS = ['жидкое', 'гранулы', 'палочки', 'порошок', 'другое'];

const fail = (message) => Object.assign(new Error(message), { status: 400 });

function prompt(plants, others, month) {
  const list = plants.map((p) => {
    const s = p.scan || {};
    const fert = p.feed?.fert && others[p.feed.fert];
    return `- id ${p.id}: ${p.name}${s.latin ? ` (${s.latin})` : ''}; состояние: ${s.statusText || 'не сканировали'}` +
      `${s.pot === 'small' ? '; горшок тесный' : ''}; удобрение сейчас: ${fert ? `«${fert}», раз в ${p.feed.every} дн.` : 'нет'}`;
  }).join('\n');
  return `Ты агроном и специалист по комнатным растениям. На фото упаковка удобрения для растений.
Прочитай, что написано на упаковке, и составь график подкормки для цветов хозяйки.
Сейчас ${month}, квартира в Москве: отопление, сухой воздух, ${['ноябрь', 'декабрь', 'январь', 'февраль'].includes(month) ? 'короткий световой день' : 'светлое время года'}.

Цветы хозяйки:
${list || '(пока ни одного)'}

Ответь ТОЛЬКО JSON без пояснений и без markdown, строго по схеме:
{
  "is_fertilizer": true, если на фото удобрение или подкормка для растений; иначе false,
  "name": "название с упаковки: бренд и линейка, как написано, по-русски, если на упаковке есть русский",
  "kind": "для чего, коротко: универсальное, для цветущих, для декоративно-лиственных, для кактусов и суккулентов, для орхидей и т.п.",
  "npk": "N-P-K с упаковки, например 7-3-6; пустая строка, если не видно",
  "form": "жидкое | гранулы | палочки | порошок | другое",
  "dose": "доза для полива по инструкции с упаковки, например «5 мл на 1 л воды»; если инструкции не видно, обычная для такого удобрения",
  "note": "главное правило применения, до 12 слов (например «только по влажному грунту, после обычного полива»)",
  "plan": [{"plant": "id цветка из списка", "every_days": через сколько дней подкармливать сейчас, число; 0 — сейчас не подкармливать, "dose": "доза для этого цветка, если отличается от общей, иначе пустая строка", "why": "почему так, до 10 слов"}]
}
Правила:
- В plan каждый цветок из списка ровно один раз.
- Учитывай сезон: с ноября по февраль большинство комнатных растений растёт медленно, подкармливай реже (обычно раз в 4–6 недель) или сделай паузу; с марта по сентябрь — по инструкции.
- Больные, ослабленные и недавно пересаженные растения не подкармливай: every_days 0 и причина.
- Если удобрение не подходит растению (например, кактусам, суккулентам или орхидеям обычное универсальное), every_days 0 и причина, или половинная доза, если так принято.
- Палочки и гранулы длительного действия: every_days — как часто их менять по инструкции.
- Если у цветка уже есть другое удобрение, которое подходит ему лучше, every_days 0 и причина «лучше оставить …».
- Пиши грамотно, коротко и простыми словами.`;
}

// plants — цветы человека; others — { id удобрения: название } для тех, что уже есть.
export async function scanFertilizer(bytes, plants, others = {}, today = new Date()) {
  if (!config.llmApiKey) throw new Error('Сканер пока не подключён');
  const month = MONTHS[new Date(today).getUTCMonth()];
  const content = [
    { type: 'text', text: prompt(plants, others, month) },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + Buffer.from(bytes).toString('base64') } },
  ];
  const models = [config.llmFastModel, config.llmVisionModel].filter(Boolean);
  let r = null, lastError = null;
  for (const model of models) {
    try {
      const res = await step('удобрение: ' + model, chat(model, content, { maxTokens: 8000, json: true, effort: model === config.llmFastModel ? config.llmFastEffort : config.llmLookEffort }));
      r = findJSON(res.text) || findJSON(res.reasoning);
      if (r) break;
      console.error('Удобрение: нет JSON от', model, String(res.text).slice(0, 500));
    } catch (e) {
      lastError = e;
      console.error('Удобрение: модель не ответила', model, e.message);
    }
  }
  if (!r) throw lastError || new Error('Сканер ответил непонятно, попробуй ещё раз');
  if (r.is_fertilizer === false) throw fail('Не похоже на удобрение. Сфоткай упаковку так, чтобы было видно название и инструкцию.');
  return normalizeFertilizer(r, plants);
}

export function normalizeFertilizer(r, plants) {
  const ids = new Set(plants.map((p) => p.id));
  const seen = new Set();
  const plan = (Array.isArray(r.plan) ? r.plan : []).filter((x) => x && ids.has(String(x.plant)) && !seen.has(String(x.plant)) && seen.add(String(x.plant)))
    .map((x) => ({
      plant: String(x.plant),
      every: Math.min(120, Math.max(0, Math.round(Number(x.every_days)) || 0)),
      dose: cut(x.dose, 60),
      why: cut(x.why, 100),
    }));
  return {
    name: cut(r.name, 60) || 'Удобрение',
    kind: cut(r.kind, 60),
    npk: cut(r.npk, 20),
    form: FORMS.includes(r.form) ? r.form : '',
    dose: cut(r.dose, 80),
    note: cut(r.note, 120),
    plan,
  };
}
