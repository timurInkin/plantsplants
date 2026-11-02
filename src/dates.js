import { TZ_OFFSET_HOURS } from './config.js';

const DAY = 86400000;
const local = (now) => new Date(now + TZ_OFFSET_HOURS * 3600000);

export const todayLocal = (now = Date.now()) => local(now).toISOString().slice(0, 10);
export const hourLocal = (now = Date.now()) => local(now).getUTCHours();
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
