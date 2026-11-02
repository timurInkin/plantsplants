// Настройки бота. Секреты и адреса приходят из переменных окружения Amvera.

export const config = {
  botToken: need('BOT_TOKEN'),
  // Адрес приложения на Amvera, например https://plants.polina.msk0.amvera.tech
  publicUrl: need('PUBLIC_URL').replace(/\/+$/, ''),
  supabaseUrl: need('SUPABASE_URL'),
  supabaseKey: need('SUPABASE_SERVICE_KEY'),
  // Сканер: любой OpenAI-совместимый API с поддержкой картинок. По умолчанию LLM от Amvera.
  llmBaseUrl: (process.env.LLM_BASE_URL || 'https://inference.waw0.amvera.ru/v1').replace(/\/+$/, ''),
  // Без ключа бот работает, только сканер отвечает, что пока не подключён.
  llmApiKey: process.env.LLM_API_KEY || '',
  llmModel: process.env.LLM_MODEL || 'gpt-4.1',
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
