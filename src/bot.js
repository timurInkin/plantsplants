// Что бот делает в чате: отвечает на фото сканом, сохраняет его по кнопке, спрашивает про последний полив,
// принимает приглашения в чужие цветы и напоминает о поливе. У каждого человека своя коллекция цветов.

import { EVENING_NUDGE } from './config.js';
import { todayLocal, addDays, dayLabel, dayShort, validDay } from './dates.js';
import {
  touchUser, getUser, getPlants, getPlant, uploadPending, setPending, undoPending, pendingImages, savePending, sameKind, downloadPhoto,
  waterAllDue, setLastWatering, buildState, acceptInvite, gardensOf, MAX_SCAN_PHOTOS,
} from './db.js';
import { scanPhoto, scanText } from './scan.js';
import { tg, downloadFile, appButton } from './telegram.js';

const html = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Скан с учётом досланных фото. more — явно «это дополнение» (кнопка «Доснять» в приложении).
// В чате (auto) новое фото добавляется к прошлому скану и без этого: если бот сам просил доснять
// (в течение 30 минут) или если фото пришли подряд, пачкой (в течение 2 минут).
// В приложении для этого есть кнопка, поэтому там новое фото без «Доснять» всегда начинает новый скан.
export async function scanForUser(uid, bytes, note = '', more = false, auto = true, onStage = null, plantId = null) {
  if (plantId) return detailScan(uid, plantId, bytes, note, onStage);
  const prev = (await getUser(uid))?.pending_scan;
  const age = prev?.at ? Date.now() - prev.at : Infinity;
  const join = prev?.photos > 0 && prev.photos < MAX_SCAN_PHOTOS &&
    (more || (auto && ((prev.needPhotos?.length && age < 30 * 60_000) || age < 2 * 60_000)));
  const images = join ? [...(await pendingImages(uid, prev.photos)), bytes] : [bytes];
  const detail = !!(join && prev.detail);
  // Фото кладём в хранилище, пока сканер думает, а не после.
  const upload = uploadPending(uid, images.length - 1, bytes);
  upload.catch(() => {});
  const scan = await scanPhoto(images, note, onStage, join ? prev : null, detail);
  await upload;
  // Прошлый результат храним: если досъёмка всё испортила, к нему можно вернуться.
  await setPending(uid, detail ? { ...scan, detail } : scan, images.length, join ? prev : null);
  return { scan, photos: images.length };
}

// Фото детали к цветку из коллекции: пятно, лист снизу, грунт. Сканер смотрит его вместе с основным фото цветка
// и знает, что за растение, поэтому заново вид не определяет, а обновляет состояние и советы.
// Основное фото становится первым фото скана, так что после сохранения в карточке остаётся оно, а не деталь.
// «Вернуть прошлый результат» вернёт то, что было в карточке.
async function detailScan(uid, plantId, bytes, note, onStage) {
  const plant = await getPlant(uid, plantId);
  if (!plant) throw Object.assign(new Error('Нет такого цветка'), { status: 400 });
  const base = plant.photo_path ? await downloadPhoto(plant.photo_path) : null;
  const images = base ? [base, bytes] : [bytes];
  const upload = Promise.all([base && uploadPending(uid, 0, base), uploadPending(uid, images.length - 1, bytes)]);
  upload.catch(() => {});
  const prior = plant.scan ? { ...plant.scan, photos: 1 } : null;
  const scan = await scanPhoto(images, note, onStage, prior, true);
  await upload;
  await setPending(uid, { ...scan, detail: true }, images.length, prior);
  return { scan, photos: images.length };
}

// Кнопки «Когда был последний полив?»: сегодня, вчера и ещё пять дней назад.
function lastWateringKeyboard(plantId) {
  const today = todayLocal();
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, -i));
  const btn = (day, i) => ({ text: i === 0 ? 'Сегодня' : i === 1 ? 'Вчера' : dayShort(day), callback_data: `wl:${plantId}:${day}` });
  const all = [...days.map(btn), { text: 'Не помню', callback_data: `wl:${plantId}:-` }];
  return { inline_keyboard: [all.slice(0, 2), all.slice(2, 5), all.slice(5)] };
}

function nextWateringText(day, every) {
  const next = addDays(day, every);
  const today = todayLocal();
  return next <= today ? 'Следующий полив уже пора: проверь грунт пальцем.' : `Следующий: ${dayLabel(next)}.`;
}

// Ответ на скан с кнопками «куда сохранить». Цветы, на которые скан не похож, сохраняются только после вопроса «точно он?» (кнопка sc?:).
function scanMessage(scan, photos, plants) {
  const rows = [[{ text: '＋ Это новый цветок', callback_data: 'sc:new' }]];
  for (let i = 0; i < plants.length; i += 2) {
    rows.push(plants.slice(i, i + 2).map((p) => ({
      text: p.name, callback_data: (sameKind(p, scan) === false ? 'sc?:' : 'sc:') + p.id,
    })));
  }
  if (photos > 1) rows.push([{ text: '↩️ Вернуть прошлый результат', callback_data: 'undo' }]);
  return {
    parse_mode: 'HTML',
    text: (photos > 1 ? `Смотрю на все ${photos} фото вместе.\n\n` : '') + scanText(scan) +
      (plants.length ? '\n\nЭто новый цветок или кто-то из твоих? Если из твоих, обновлю его фото и скан.' : '\n\nСохранить в твои цветы?'),
    reply_markup: { inline_keyboard: rows },
  };
}

async function handleCallback(cb) {
  if (!cb.data || !cb.message) return;
  const uid = cb.from.id;
  const chat_id = cb.message.chat.id, message_id = cb.message.message_id;
  const answer = (text, alert = false) => tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text, show_alert: alert } : {}) });
  let answered = false;
  try {
    if (cb.data === 'w:all' || cb.data.startsWith('w:all:')) {
      const garden = Number(cb.data.slice(6)) || uid;
      if (garden !== uid && !(await gardensOf(uid)).some((g) => g.id === garden)) throw new Error('Доступ к этим цветам закрыли');
      const n = await waterAllDue(garden, todayLocal());
      await answer(n ? 'Отметила 💧' : 'Уже всё полито');
      await tg('editMessageText', { chat_id, message_id, text: 'Все политы 💧' });
    } else if (cb.data.startsWith('sc?:')) {
      // Сохранить в цветок, который на скан не похож: сначала переспрашиваем.
      const id = cb.data.slice(4);
      const name = cb.message.reply_markup?.inline_keyboard?.flat().find((b) => b.callback_data === cb.data)?.text || 'этот цветок';
      await answer(`На фото, похоже, другой цветок, не «${name}». Если это всё-таки он, нажми «Да, это ${name}».`, true);
      await tg('editMessageReplyMarkup', {
        chat_id, message_id, reply_markup: { inline_keyboard: [
          [{ text: '＋ Нет, это новый цветок', callback_data: 'sc:new' }],
          [{ text: `Да, это ${name}, обновить`, callback_data: 'sc:' + id }],
        ] },
      });
    } else if (cb.data.startsWith('sc:')) {
      await answer(); answered = true; // кнопка сразу перестаёт крутиться, сохраняем дальше
      const { plant, isNew } = await savePending(uid, cb.data.slice(3));
      await tg('editMessageReplyMarkup', {
        chat_id, message_id, reply_markup: { inline_keyboard: [[appButton(`Открыть: ${plant.name}`, 'plant/' + plant.id)]] },
      });
      if (isNew) {
        await tg('sendMessage', {
          chat_id, parse_mode: 'HTML',
          text: `Сохранила «${html(plant.name)}» 🌿\n\nКогда был последний полив? От этого дня посчитаю следующий.`,
          reply_markup: lastWateringKeyboard(plant.id),
        });
      }
    } else if (cb.data === 'undo') {
      // Досъёмка испортила результат: возвращаем то, что было до неё.
      const [{ scan, photos }, plants] = await Promise.all([undoPending(uid), getPlants(uid)]);
      await answer('Вернула прошлый результат');
      await tg('editMessageText', { chat_id, message_id, ...scanMessage(scan, photos, plants) });
    } else if (cb.data.startsWith('wl:')) {
      const [, id, day] = cb.data.split(':');
      const plant = await getPlant(uid, id);
      if (!plant) throw new Error('Нет такого цветка');
      const open = { inline_keyboard: [[appButton(`Открыть: ${plant.name}`, 'plant/' + plant.id)]] };
      if (day === '-') {
        await answer();
        await tg('editMessageText', {
          chat_id, message_id, reply_markup: open,
          text: `Хорошо. Проверь грунт у «${plant.name}» пальцем: если сухой на 2–3 см, полей и отметь в приложении.`,
        });
        return;
      }
      if (!validDay(day)) throw new Error('Этот день уже не выбрать, отметь полив в приложении');
      await setLastWatering(plant.id, day);
      await answer('Запомнила 💧');
      await tg('editMessageText', {
        chat_id, message_id, reply_markup: open,
        text: `💧 «${plant.name}»: последний полив ${dayLabel(day)}. ${nextWateringText(day, plant.every)}`,
      });
    }
  } catch (e) {
    if (!answered) await answer(e.message);
    else await tg('sendMessage', { chat_id, text: 'Не получилось: ' + e.message });
  }
}

// Человек открыл ссылку-приглашение от хозяина цветов.
async function handleInvite(msg, token) {
  const uid = msg.from.id;
  const res = await acceptInvite(uid, token).catch((e) => { console.error('Приглашение не сработало', e); return undefined; });
  if (res === undefined) return tg('sendMessage', { chat_id: msg.chat.id, text: 'Не получилось открыть приглашение, попробуй чуть позже.' });
  if (!res) return tg('sendMessage', { chat_id: msg.chat.id, text: 'Эта ссылка больше не работает. Попроси новую 🌿' });
  if (res.self) {
    return tg('sendMessage', {
      chat_id: msg.chat.id,
      text: 'Это твоя ссылка для гостей. Отправь её тому, кто присмотрит за цветами: он увидит их в приложении и будет получать напоминалки о поливе.',
    });
  }
  const owner = res.owner.name || 'Хозяин цветов';
  await tg('sendMessage', {
    chat_id: msg.chat.id, parse_mode: 'HTML',
    text: `🌿 <b>${html(owner)}</b> делится с тобой своими цветами.\n\n` +
      'Утром напишу, кого из них пора полить. Отмечай полив в приложении, отметки общие.',
    reply_markup: { inline_keyboard: [[appButton('Открыть цветы', `g=${res.owner.id}/today`)]] },
  });
  if (!res.already) {
    await tg('sendMessage', {
      chat_id: res.owner.chat_id, parse_mode: 'HTML',
      text: `👋 <b>${html(msg.from.first_name || 'Гость')}</b> теперь присматривает за твоими цветами: видит их, получает напоминалки и отмечает полив.\n\n` +
        'Закрыть доступ: приложение → Цветы → Поделиться.',
    });
  }
}

export async function handleUpdate(update) {
  if (update.callback_query) return handleCallback(update.callback_query);
  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private' || !msg.from) return;
  const uid = msg.from.id;
  const { isNew } = await touchUser(uid, msg.chat.id, msg.from.first_name);

  if (msg.photo) {
    // Скан идёт около минуты: сразу показываем, что работаем, потом заменяем это сообщение ответом.
    const wait = await tg('sendMessage', {
      chat_id: msg.chat.id,
      text: '🔍 Смотрю на фото. Обычно это минуту-полторы: определяю вид, разглядываю листья, грунт и горшок.',
    });
    const waitId = wait?.result?.message_id;
    const reply = (body) => (waitId
      ? tg('editMessageText', { chat_id: msg.chat.id, message_id: waitId, ...body })
      : tg('sendMessage', { chat_id: msg.chat.id, ...body }));

    // Пока скан идёт, обновляем это сообщение: что уже понятно и что сейчас происходит.
    let finished = false;
    const onStage = (text) => {
      if (waitId && !finished) tg('editMessageText', { chat_id: msg.chat.id, message_id: waitId, text: '🔍 ' + text }).catch(() => {});
    };

    const size = msg.photo.find((ph) => ph.width >= 1000) || msg.photo[msg.photo.length - 1];
    let scan, photos, plants;
    try {
      const bytes = await downloadFile(size.file_id);
      [{ scan, photos }, plants] = await Promise.all([scanForUser(uid, bytes, msg.caption, false, true, onStage), getPlants(uid)]);
      finished = true;
    } catch (e) {
      finished = true;
      await reply({ text: 'Не получилось разглядеть 😕 ' + e.message });
      return;
    }
    await reply(scanMessage(scan, photos, plants));
    return;
  }

  const invite = msg.text?.match(/^\/start g_([\w-]+)/);
  if (invite) return handleInvite(msg, invite[1]);

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

// Напоминалка одному человеку: кого пора полить. Сначала его цветы, потом те, что ему доверили (owners).
export async function remind(user, evening, owners = []) {
  if (evening && !EVENING_NUDGE) return;
  for (const g of [{ id: user.id, name: null }, ...owners]) {
    const state = await buildState(g.id);
    const due = state.plants.filter((p) => p.dueIn <= 0 && !p.wateredToday);
    if (!due.length) continue;
    const text = (g.name ? `🪴 <b>Цветы: ${html(g.name)}</b>\n` : '') +
      (evening ? '🌙 <b>Ещё не политы:</b>\n' : '💧 <b>Сегодня пить хотят:</b>\n') + due.map((p) => '• ' + html(p.name)).join('\n');
    await tg('sendMessage', {
      chat_id: user.chat_id, text, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        g.name ? { text: 'Все политы ✓', callback_data: 'w:all:' + g.id } : { text: 'Полила всех', callback_data: 'w:all' },
        appButton('Открыть', g.name ? `g=${g.id}/today` : 'today'),
      ]] },
    });
  }
}
