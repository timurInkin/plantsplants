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
  // Сколько моделям «размышлять» перед ответом (OpenRouter reasoning effort): low | medium | high | off, пусто — как у модели.
  // Модели для фото думать почти не нужно, она только описывает, что видит: так скан заметно быстрее.
  llmLookEffort: process.env.LLM_LOOK_REASONING ?? 'low',
  llmAdviseEffort: process.env.LLM_ADVISE_REASONING ?? '',
  // Быстрый скан: одна модель сразу смотрит на фото и пишет вывод, за 10–20 секунд вместо минуты-двух.
  // Если она не ответила, скан идёт старым путём, двумя моделями выше. Пустая строка — быстрый скан выключен.
  llmFastModel: process.env.LLM_FAST_MODEL ?? 'google/gemini-3.6-flash',
  llmFastEffort: process.env.LLM_FAST_REASONING ?? 'low',
  // Справочные сервисы, необязательные: без ключей сканер обходится моделями.
  // Pl@ntNet (my.plantnet.org) определяет вид по фото, бесплатно 500 запросов в день.
  plantnetApiKey: process.env.PLANTNET_API_KEY || '',
  plantnetProject: process.env.PLANTNET_PROJECT || 'useful', // база культурных и декоративных растений
  plantnetType: process.env.PLANTNET_TYPE ?? 'kt',           // движок распознавания
  // Perenual (perenual.com) отдаёт режим полива и свет для вида, бесплатно 100 запросов в день.
  perenualApiKey: process.env.PERENUAL_API_KEY || '',
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
