// Замер времени. Каждый запрос приложения и каждое событие в чате пишет в лог одну строчку «⏱ …»:
// сколько всё заняло, сколько запросов ушло в базу и сколько думал сканер. Их видно в логах Railway.

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage();
const now = () => performance.now();
const sec = (ms) => (ms / 1000).toFixed(1) + ' с';

export function track(label, fn) {
  const t = { t0: now(), db: 0, dbCount: 0, dbMax: 0, steps: [], calls: [] };
  return store.run(t, async () => {
    try {
      return await fn();
    } finally {
      const parts = [`⏱ ${label}: ${Math.round(now() - t.t0)} мс`];
      if (t.dbCount) parts.push(`база ${t.dbCount} запр., в сумме ${Math.round(t.db)} мс, самый долгий ${Math.round(t.dbMax)} мс`);
      for (const [name, ms] of t.steps) parts.push(`${name} ${sec(ms)}`);
      console.log(parts.join(' · '));
    }
  });
}

// Отдельный шаг внутри запроса, например «Pl@ntNet» или «модель для фото».
export async function step(name, promise) {
  const t0 = now();
  try {
    return await promise;
  } finally {
    store.getStore()?.steps.push([name, now() - t0]);
  }
}

// Что уже набралось в текущем запросе: шаги и вызовы моделей. Скан записывает это в базу (таблица scan_runs).
export function currentRun() {
  const t = store.getStore();
  if (!t) return { steps: [], calls: [], db: 0 };
  return { steps: t.steps.map(([name, ms]) => [name, Math.round(ms)]), calls: t.calls, db: Math.round(t.db) };
}
export function noteCall(call) {
  store.getStore()?.calls.push(call);
}

// fetch для Supabase: засекает каждый запрос к базе и хранилищу фото.
export async function timedFetch(url, opts) {
  const t0 = now();
  try {
    return await fetch(url, opts);
  } finally {
    const t = store.getStore();
    if (t) {
      const ms = now() - t0;
      t.db += ms; t.dbCount++; t.dbMax = Math.max(t.dbMax, ms);
    }
  }
}
