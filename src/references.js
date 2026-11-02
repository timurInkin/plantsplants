// Справочные сервисы для сканера.
// Pl@ntNet определяет вид по фото (база культурных и декоративных растений), Perenual отдаёт режим полива и свет для этого вида.
// Их ответы идут подсказкой моделям: те сверяют вид с признаками на фото и подстраивают уход под конкретный горшок.
// https://my.plantnet.org/doc  ·  https://perenual.com/docs/api

import { config } from './config.js';

const pct = (p) => Math.round((Number(p) || 0) * 100) + '%';

// ───── Pl@ntNet ─────

async function plantnetRequest(images, withType) {
  const params = new URLSearchParams({ 'api-key': config.plantnetApiKey, lang: 'ru', 'nb-results': '5' });
  if (withType && config.plantnetType) params.set('type', config.plantnetType);
  const form = new FormData();
  images.slice(0, 5).forEach((b, i) => {
    form.append('images', new Blob([b], { type: 'image/jpeg' }), `photo${i}.jpg`);
    form.append('organs', 'auto');
  });
  return fetch(`https://my-api.plantnet.org/v2/identify/${config.plantnetProject}?${params}`, { method: 'POST', body: form });
}

// Кандидаты вида: [{ latin, genus, family, common, score }], лучший первый. null — если не получилось.
export async function identifyPlantNet(images) {
  if (!config.plantnetApiKey) return null;
  try {
    let res = await plantnetRequest(images, true);
    // Если движок type не принят, пробуем без него.
    if (res.status === 400 && config.plantnetType) res = await plantnetRequest(images, false);
    if (res.status === 404) return []; // Pl@ntNet не узнал растение
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('Pl@ntNet ответил ошибкой', res.status, JSON.stringify(data).slice(0, 500));
      return null;
    }
    return (data.results || []).map((r) => ({
      latin: r.species?.scientificNameWithoutAuthor || '',
      genus: r.species?.genus?.scientificNameWithoutAuthor || '',
      family: r.species?.family?.scientificNameWithoutAuthor || '',
      common: (r.species?.commonNames || []).slice(0, 2),
      score: Number(r.score) || 0,
    })).filter((r) => r.latin);
  } catch (e) {
    console.error('Pl@ntNet недоступен', e.message);
    return null;
  }
}

// ───── Perenual ─────

const careCache = new Map(); // бесплатно 100 запросов в день, поэтому запоминаем ответы

const clean = (v) => (typeof v === 'string' && !/upgrade/i.test(v) ? v : '');
const list = (v) => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);

async function perenual(path, params = {}) {
  const q = new URLSearchParams({ key: config.perenualApiKey, ...params });
  const res = await fetch(`https://perenual.com/api/v2/${path}?${q}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Perenual ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// Режим ухода по латинскому названию: { name, watering, every: {min, max} | null, sunlight, careLevel, soil }.
export async function careFromPerenual(latin, genus) {
  if (!config.perenualApiKey || !latin) return null;
  if (careCache.has(latin)) return careCache.get(latin);
  try {
    let found = null;
    for (const q of [latin, genus].filter(Boolean)) {
      const hits = (await perenual('species-list', { q })).data || [];
      found = hits.find((h) => (h.scientific_name || []).some((n) => n.toLowerCase().startsWith(latin.toLowerCase()))) || hits[0];
      if (found) break;
    }
    if (!found) { careCache.set(latin, null); return null; }
    const d = await perenual(`species/details/${found.id}`).catch((e) => { console.error(e.message); return found; });
    const bench = d.watering_general_benchmark || {};
    const nums = String(clean(bench.value) || '').match(/\d+/g)?.map(Number) || [];
    const days = /day/i.test(clean(bench.unit) || 'days');
    const care = {
      name: (list(d.scientific_name)[0] || clean(d.common_name) || latin),
      watering: clean(d.watering),
      every: nums.length && days ? { min: Math.min(...nums), max: Math.max(...nums) } : null,
      sunlight: list(d.sunlight),
      careLevel: clean(d.care_level),
      soil: list(d.soil),
    };
    careCache.set(latin, care);
    return care;
  } catch (e) {
    console.error('Perenual недоступен', e.message);
    return null;
  }
}

// ───── Сводка для промпта ─────

export async function lookUpReferences(images) {
  const candidates = await identifyPlantNet(images);
  const best = candidates?.[0] || null;
  const care = best && best.score >= 0.2 ? await careFromPerenual(best.latin, best.genus) : null;

  const lines = [];
  if (candidates) {
    if (!candidates.length) lines.push('Pl@ntNet (база культурных и декоративных растений) не узнал растение по этим фото.');
    else {
      lines.push('Pl@ntNet (определитель по фото, база культурных и декоративных растений) предлагает:');
      for (const c of candidates.slice(0, 4)) {
        lines.push(`- ${c.latin}${c.common.length ? ' (' + c.common.join(', ') + ')' : ''}, семейство ${c.family || '?'} — ${pct(c.score)}`);
      }
      if (best.score >= 0.5) lines.push('Лучший вариант уверенный: бери его, если признаки на фото явно не говорят об ином.');
      else lines.push('Уверенность невысокая: выбирай по признакам на фото, кандидаты — только ориентир.');
    }
  }
  if (care) {
    lines.push(`Справочник Perenual для ${care.name}:`);
    if (care.watering || care.every) {
      lines.push(`- полив: ${care.watering || '—'}${care.every ? `, в среднем раз в ${care.every.min}–${care.every.max} дн.` : ''}`);
    }
    if (care.sunlight.length) lines.push(`- свет: ${care.sunlight.join(', ')}`);
    if (care.soil.length) lines.push(`- грунт: ${care.soil.join(', ')}`);
    if (care.careLevel) lines.push(`- сложность ухода: ${care.careLevel}`);
    lines.push('Это усреднённые нормы для вида: подстрой полив под горшок, грунт и состояние на фото.');
  }
  return {
    text: lines.join('\n'),
    identified: best && best.score >= 0.2 ? { source: 'Pl@ntNet', latin: best.latin, score: best.score } : null,
    every: care?.every || null,
  };
}
