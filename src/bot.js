// Что бот делает в чате: отвечает на фото сканом, сохраняет его по кнопке и напоминает о поливе.
// Каждый, кто написал боту, получает свою коллекцию цветов.

import { EVENING_NUDGE } from './config.js';
import { todayLocal } from './dates.js';
import { touchUser, getUser, getPlants, keepPending, savePending, waterAllDue, buildState } from './db.js';
import { scanPhoto, scanText } from './scan.js';
import { tg, downloadFile, appButton } from './telegram.js';

async function handleCallback(cb) {
  if (!cb.data || !cb.message) return;
  const uid = cb.from.id;
  const chat_id = cb.message.chat.id, message_id = cb.message.message_id;
  try {
    if (!(await getUser(uid))) throw new Error('Напиши боту /start');
    if (cb.data === 'w:all') {
      const n = await waterAllDue(uid, todayLocal());
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: n ? 'Отметила 💧' : 'Уже всё полито' });
      await tg('editMessageText', { chat_id, message_id, text: 'Все политы 💧' });
    } else if (cb.data.startsWith('sc:')) {
      const plant = await savePending(uid, cb.data.slice(3));
      await tg('answerCallbackQuery', { callback_query_id: cb.id });
      await tg('editMessageReplyMarkup', {
        chat_id, message_id, reply_markup: { inline_keyboard: [[appButton(`Открыть: ${plant.name}`, 'plant/' + plant.id)]] },
      });
    }
  } catch (e) {
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: e.message });
  }
}

export async function handleUpdate(update) {
  if (update.callback_query) return handleCallback(update.callback_query);
  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private' || !msg.from) return;
  const uid = msg.from.id;
  const { isNew } = await touchUser(uid, msg.chat.id, msg.from.first_name);

  if (msg.photo) {
    await tg('sendChatAction', { chat_id: msg.chat.id, action: 'typing' });
    const size = msg.photo.find((ph) => ph.width >= 1000) || msg.photo[msg.photo.length - 1];
    const bytes = await downloadFile(size.file_id);
    let scan;
    try {
      scan = await scanPhoto(bytes);
    } catch (e) {
      await tg('sendMessage', { chat_id: msg.chat.id, text: 'Не получилось разглядеть 😕 ' + e.message });
      return;
    }
    await keepPending(uid, bytes, scan);
    const plants = await getPlants(uid);
    const rows = [[{ text: '＋ Это новый цветок', callback_data: 'sc:new' }]];
    for (let i = 0; i < plants.length; i += 2) {
      rows.push(plants.slice(i, i + 2).map((p) => ({ text: p.name, callback_data: 'sc:' + p.id })));
    }
    await tg('sendMessage', {
      chat_id: msg.chat.id, parse_mode: 'HTML',
      text: scanText(scan) + (plants.length ? '\n\nКуда сохранить?' : '\n\nСохранить в твои цветы?'),
      reply_markup: { inline_keyboard: rows },
    });
    return;
  }

  const start = isNew || (msg.text && msg.text.startsWith('/start'));
  await tg('sendMessage', {
    chat_id: msg.chat.id,
    text: start
      ? 'Привет 🌿\n\nПришли фото цветка, и я скажу, кто это, всё ли с ним ок и норм ли горшок. Коротко, без лекций. ' +
        'Каждый скан можно сохранить в свои цветы.\n\nУтром напишу, кого пора полить. Все цветы в приложении 👇'
      : 'Кидай фото цветка, посмотрю. Или открой приложение 👇',
    reply_markup: { inline_keyboard: [[appButton('Мои цветы', 'today')]] },
  });
}

// Напоминалка одному человеку: кого пора полить.
export async function remind(user, evening) {
  if (evening && !EVENING_NUDGE) return;
  const state = await buildState(user.id);
  const due = state.plants.filter((p) => p.dueIn <= 0 && !p.wateredToday);
  if (!due.length) return;
  const text = (evening ? '🌙 <b>Ещё не политы:</b>\n' : '💧 <b>Сегодня пить хотят:</b>\n') + due.map((p) => '• ' + p.name).join('\n');
  await tg('sendMessage', {
    chat_id: user.chat_id, text, parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: 'Полила всех', callback_data: 'w:all' }, appButton('Открыть', 'today')]] },
  });
}
