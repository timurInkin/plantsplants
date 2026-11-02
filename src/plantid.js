// Plant.id (kindwise.com) — модель, обученная именно на растениях: определяет вид и болезни по фото.
// Её ответ идёт подсказкой общим моделям, а не готовым вердиктом: они сверяют его с тем, что видят.
// https://plant.id/docs

import { config } from './config.js';

const pct = (p) => Math.round((Number(p) || 0) * 100) + '%';

export async function askPlantId(images) {
  if (!config.plantIdApiKey) return null;
  try {
    const res = await fetch('https://plant.id/api/v3/identification?details=common_names&language=ru', {
      method: 'POST',
      headers: { 'Api-Key': config.plantIdApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        images: images.map((b) => 'data:image/jpeg;base64,' + Buffer.from(b).toString('base64')),
        similar_images: false,
        health: 'all',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('Plant.id ответил ошибкой', res.status, JSON.stringify(data).slice(0, 500));
      return null;
    }
    return summarize(data.result || {});
  } catch (e) {
    console.error('Plant.id недоступен', e.message);
    return null;
  }
}

// Короткая сводка для промпта.
function summarize(r) {
  const lines = [];
  if (r.is_plant && r.is_plant.binary === false) lines.push(`Похоже, на фото не растение (${pct(r.is_plant.probability)}).`);
  const species = (r.classification?.suggestions || []).slice(0, 4);
  if (species.length) {
    lines.push('Вид, кандидаты:');
    for (const s of species) {
      const ru = s.details?.common_names?.[0];
      lines.push(`- ${s.name}${ru ? ' (' + ru + ')' : ''} — ${pct(s.probability)}`);
    }
  }
  if (r.is_healthy) lines.push(`Здорово: ${r.is_healthy.binary ? 'да' : 'нет'} (${pct(r.is_healthy.probability)}).`);
  const issues = (r.disease?.suggestions || []).filter((d) => d.probability >= 0.1).slice(0, 4);
  if (issues.length) {
    lines.push('Возможные проблемы:');
    for (const d of issues) lines.push(`- ${d.details?.local_name || d.name} — ${pct(d.probability)}`);
  }
  return lines.length ? lines.join('\n') : null;
}
