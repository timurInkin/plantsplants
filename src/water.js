// Сколько воды лить за полив (% от объёма горшка) для цветов, отсканированных до того, как сканер начал это писать.
// Считаем по уже сохранённому скану, без фото и без пересканирования: одна текстовая просьба на пачку цветов.

import { config } from './config.js';
import { supabase } from './db.js';
import { chat, findJSON, cut, waterPct, monthNow, WATER_PCT_RULE } from './scan.js';

export function waterPctPrompt(plants, month) {
  const list = plants.map((p, i) => {
    const s = p.scan || {};
    return `${i + 1}. ${p.name}${s.latin ? ` (${s.latin})` : ''}; горшок: ${s.potText || 'неизвестно'}; состояние: ${s.statusText || 'неизвестно'}; полив раз в ${p.every} дн.` +
      (s.waterText ? `, ${s.waterText}` : '');
  }).join('\n');
  return `Ты ботаник, специалист по комнатным растениям. Сейчас ${month}, квартира в Москве с отоплением.
Для каждого цветка скажи, сколько воды лить за один полив, в процентах от объёма горшка.
${WATER_PCT_RULE}

Цветы:
${list}

Ответь ТОЛЬКО JSON без пояснений и без markdown:
{"plants": [{"n": номер цветка из списка, "water_pct": целое число, "why": "почему столько, по-простому, до 10 слов"}]}
Каждый цветок из списка ровно один раз. Пиши грамотно.`;
}

let running = null;
export function fillWaterPct(opts) {
  running ||= fill(opts).finally(() => { running = null; });
  return running;
}

async function fill({ batch = 25 } = {}) {
  if (!config.llmApiKey) return 0;
  const { data, error } = await supabase.from('plants').select('id, user_id, name, every, scan').not('scan', 'is', null);
  if (error) throw error;
  const todo = (data || []).filter((p) => p.scan && !p.scan.notPlant && p.scan.waterPct == null);
  if (!todo.length) return 0;
  const model = config.llmFastModel || config.llmTextModel || config.llmVisionModel;
  let done = 0;
  for (let i = 0; i < todo.length; i += batch) {
    const part = todo.slice(i, i + batch);
    try {
      const res = await chat(model, waterPctPrompt(part, monthNow()), { maxTokens: 4000, json: true, effort: config.llmFastEffort });
      const r = findJSON(res.text) || findJSON(res.reasoning);
      for (const x of Array.isArray(r?.plants) ? r.plants : []) {
        const p = part[Math.round(Number(x?.n)) - 1];
        const pct = waterPct(x?.water_pct);
        if (!p || !pct) continue;
        // Берём свежий скан: цветок могли пересканировать, пока модель думала.
        const { data: cur } = await supabase.from('plants').select('scan').eq('id', p.id).eq('user_id', p.user_id).maybeSingle();
        if (!cur?.scan || cur.scan.waterPct != null) continue;
        const { error: e } = await supabase.from('plants').update({ scan: { ...cur.scan, waterPct: pct, waterPctWhy: cut(x.why, 100) } }).eq('id', p.id).eq('user_id', p.user_id);
        if (!e) done++;
      }
    } catch (e) {
      console.error('💧 Не посчитала, сколько воды лить:', e.message);
    }
  }
  console.log(`💧 Посчитала, сколько воды лить: ${done} из ${todo.length}`);
  return done;
}
