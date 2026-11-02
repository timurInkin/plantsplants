// Обращения к Telegram и проверка, что запрос из приложения пришёл от хозяйки бота.

import crypto from 'node:crypto';
import { config } from './config.js';
import { getValue } from './db.js';

export async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json();
}

export async function downloadFile(fileId) {
  const file = await tg('getFile', { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.result.file_path}`);
  return Buffer.from(await res.arrayBuffer());
}

export const appButton = (text, screen) => ({ text, web_app: { url: `${config.publicUrl}/#${screen}` } });

export const webhookSecret = crypto.createHash('sha256').update('hook:' + config.botToken).digest('hex').slice(0, 32);

// При запуске подключаем вебхук и кнопку «Мои цветы» в чате.
export async function setupTelegram() {
  const results = await Promise.all([
    tg('setWebhook', { url: config.publicUrl + '/webhook', secret_token: webhookSecret, allowed_updates: ['message', 'callback_query'] }),
    tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Мои цветы', web_app: { url: config.publicUrl + '/#today' } } }),
    tg('setMyCommands', { commands: [{ command: 'start', description: 'Начать' }] }),
  ]);
  const failed = results.find((r) => !r.ok);
  if (failed) console.error('Telegram не принял настройки, проверь BOT_TOKEN и PUBLIC_URL:', failed.description);
  else console.log('Telegram подключён:', config.publicUrl);
}

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export async function isOwnerRequest(initData) {
  const params = new URLSearchParams(initData || '');
  const hash = params.get('hash');
  if (!hash) return false;
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  const sig = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (sig !== hash) return false;
  const user = JSON.parse(params.get('user') || '{}');
  const owner = await getValue('owner');
  return owner != null && String(user.id) === String(owner);
}
