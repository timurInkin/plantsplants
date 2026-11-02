// Настройки бота. Секреты и адреса приходят из переменных окружения Amvera.

export const config = {
  botToken: need('BOT_TOKEN'),
  // Адрес приложения на Amvera, например https://plants.polina.msk0.amvera.tech
  publicUrl: withHttps(need('PUBLIC_URL')),
  supabaseUrl: need('SUPABASE_URL'),
  supabaseKey: need('SUPABASE_SERVICE_KEY'),
  // Сканер: любой OpenAI-совместимый API, по умолчанию OpenRouter.
  // Без ключа бот работает, только сканер отвечает, что пока не подключён.
  llmBaseUrl: (process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
  llmApiKey: process.env.LLM_API_KEY || '',
  // Модель, которая смотрит на фото.
  llmVisionModel: process.env.LLM_VISION_MODEL || process.env.LLM_MODEL || 'deepseek/deepseek-v4-flash-vision-exp',
  // Модель, которая по описанию фото пишет вывод и советы. Пустая строка — всё делает модель для фото.
  llmTextModel: process.env.LLM_TEXT_MODEL ?? '~deepseek/deepseek-v4-flash-latest',
  // Специализированная модель по растениям Plant.id (kindwise.com): определение вида и болезней.
  // Необязательно: без ключа бот обходится общими моделями.
  plantIdApiKey: process.env.PLANT_ID_API_KEY || '',
  port: Number(process.env.PORT) || 80,
};

// Часовой пояс: Москва, UTC+3.
export const TZ_OFFSET_HOURS = 3;

// Когда напоминать о поливе (по Москве). Вечером пишем только про тех, кого так и не полили.
export const MORNING_HOUR = 9;
export const EVENING_HOUR = 19;
export const EVENING_NUDGE = true;

// Корзина в Supabase Storage для фото цветов.
export const PHOTO_BUCKET = 'photos';

function need(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Не задана переменная окружения ${name}`);
  return value;
}

// Telegram ходит только на https: дописываем схему, если её забыли, и убираем слэш в конце.
function withHttps(url) {
  const clean = url.trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(clean) ? clean.replace(/^http:/, 'https:') : 'https://' + clean;
}
