import { TZ_OFFSET_HOURS } from './config.js';

const DAY = 86400000;
const local = (now) => new Date(now + TZ_OFFSET_HOURS * 3600000);

export const todayLocal = (now = Date.now()) => local(now).toISOString().slice(0, 10);
export const hourLocal = (now = Date.now()) => local(now).getUTCHours();
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
export const addDays = (iso, n) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const parts = (iso) => { const d = new Date(iso + 'T00:00:00Z'); return [WEEKDAYS[d.getUTCDay()], d.getUTCDate(), d.getUTCMonth()]; };

// «чт, 29 октября»
export const dayLabel = (iso) => { const [w, d, m] = parts(iso); return `${w}, ${d} ${MONTHS[m]}`; };
// «чт, 29 окт»
export const dayShort = (iso) => { const [w, d, m] = parts(iso); return `${w}, ${d} ${MONTHS_SHORT[m]}`; };

// День последнего полива, который человек выбрал сам: не в будущем и не раньше, чем год назад.
export function validDay(day, today = todayLocal()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day)) || Number.isNaN(Date.parse(day))) return false;
  const ago = daysBetween(day, today);
  return ago >= 0 && ago <= 365;
}
