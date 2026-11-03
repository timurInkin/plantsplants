// Экран приложения внутри Telegram (Mini App).
function app() {
  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); }
  const initData = (tg && tg.initData) || '';

  // Тема: пока человек сам не выбрал, как в Telegram. Выбор хранится на телефоне и в облаке Telegram (на всех устройствах).
  const cloud = tg && tg.CloudStorage && tg.isVersionAtLeast && tg.isVersionAtLeast('6.9') ? tg.CloudStorage : null;
  let theme = null; // 'light' | 'dark' | null
  try { theme = localStorage.getItem('theme'); } catch (e) {}
  const isDark = () => (theme ? theme === 'dark' : !!(tg && tg.colorScheme === 'dark'));
  function applyTheme() {
    const dark = isDark();
    document.documentElement.classList.toggle('dark', dark);
    const c = dark ? '#121513' : '#EEF1EC';
    if (tg) try { tg.setHeaderColor(c); tg.setBackgroundColor(c); } catch (e) {}
  }
  function setTheme(t) {
    theme = t;
    try { localStorage.setItem('theme', t); } catch (e) {}
    if (cloud) try { cloud.setItem('theme', t); } catch (e) {}
    applyTheme();
  }
  applyTheme();
  if (tg) tg.onEvent('themeChanged', () => { if (!theme) { applyTheme(); render(); } });
  if (cloud) {
    try {
      cloud.getItem('theme', (err, v) => {
        if (!err && (v === 'light' || v === 'dark') && v !== theme) { theme = v; try { localStorage.setItem('theme', v); } catch (e) {} applyTheme(); render(); }
      });
    } catch (e) {}
  }

  const root = document.getElementById('root');
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const DAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
  const TABS = [['today', 'Сегодня'], ['plants', 'Цветы'], ['scan', 'Скан']];
  const STATUS = { ok: ['всё ок', 'sage', 'check_circle'], watch: ['присмотреться', 'lime', ''], help: ['подлечить', 'warm', 'healing'] };
  const POT = { ok: ['горшок норм', 'sage'], small: ['тесный горшок', 'warm'], big: ['горшок великоват', 'lime'] };

  let state = null;
  // Экран берём из адреса (#today, #plant/<id>, #g=<id>/today). Telegram может дописать к нему свои параметры
  // (#tgWebAppData=…), например когда приложение открыто кнопкой «Открыть» в профиле бота: их отбрасываем.
  let route = (location.hash || '').slice(1).split(/[?&]/)[0];
  if (!/^(today|plants|scan|share|plant\/[\w-]+|g=\d+(\/.*)?)$/.test(route)) route = 'today';
  // Чьи цветы на экране: null — свои, число — того, кто ими поделился. Ссылка из бота может открыть сразу их: #g=<id>/today
  let garden = null;
  const gm = route.match(/^g=(\d+)\/?(.*)$/);
  if (gm) { garden = Number(gm[1]); route = gm[2] || 'today'; }
  let scan = null;          // { status: 'loading' | 'done' | 'error', result, preview, error, target, started }
  let share = null;         // { status: 'loading' | 'done' | 'error', link, guests, error }
  let pickDay = null;       // у какого цветка открыт выбор дня последнего полива
  const plantSlides = {};   // какое фото открыто в галерее карточки цветка: { id: номер }
  let busy = false;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const dateLabel = (iso) => { const d = new Date(iso + 'T00:00:00Z'); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; };
  const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c; };
  const days = (n) => n + ' ' + plural(n, 'день', 'дня', 'дней');
  const haptic = () => { try { tg.HapticFeedback.impactOccurred('light'); } catch (e) {} };
  // Иконки: Google Material Symbols (Rounded)
  const ms = (name) => '<span class="ms">' + name + '</span>';
  const byId = (id) => state.plants.find((p) => p.id === id);
  const photoUrl = (p) => p.photo;
  const own = () => !state || state.own !== false;
  const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const shortLabel = (iso) => { const d = new Date(iso + 'T00:00:00Z'); return WEEKDAYS[d.getUTCDay()] + ', ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()].slice(0, 3); };
  const clock = (t0) => { const s = Math.max(0, Math.floor((Date.now() - t0) / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  // Похоже ли растение в карточке на новый скан: сравниваем род по латыни. false — точно разные.
  const genus = (latin) => String(latin || '').trim().split(/\s+/)[0].toLowerCase();
  const sameKind = (p, s) => { const a = genus(p && p.scan && p.scan.latin), b = genus(s && s.latin); return a && b ? a === b : null; };
  // Что можно в чужих цветах: смотреть и отмечать полив. Остальные запросы всегда про свои цветы.
  const GUEST_OK = ['/api/state', '/api/water', '/api/water/last', '/api/water-all'];

  async function api(path, body, raw) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': raw ? 'image/jpeg' : 'application/json', 'X-Init-Data': initData,
        'X-Garden': garden && GUEST_OK.includes(path) ? String(garden) : '',
      },
      body: raw ? body : body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403) throw new Error('Открой это из своего бота в Telegram');
    if (!res.ok) throw Object.assign(new Error(data.error || 'Что-то не грузится, попробуй ещё раз'), { gone: !!data.gone });
    return data;
  }

  // Ответы на действия приходят без списка коллекций: его храним с прошлого раза.
  function setState(s) { state = state && !s.gardens ? { ...state, ...s } : s; }

  const check = (done) => '<span class="check' + (done ? ' on' : '') + '">' + (done ? ms('check') : '') + '</span>';
  const chip = (text, cls, icon) => '<span class="chip ' + cls + '">' + (icon ? ms(icon) : '') + esc(text) + '</span>';
  // Текст модели после запятой: «Поливать, когда…» → «поливать, когда…». Аббревиатуры не трогаем.
  const lower = (t) => /^[A-ZА-ЯЁ][a-zа-яё]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
  const fact = (icon, text) => '<li>' + ms(icon) + '<span>' + esc(text) + '</span></li>';

  function when(p) {
    if (p.wateredToday) return ['полито', 'sage'];
    if (p.dueIn < 0) return [-p.dueIn === 1 ? 'с вчера' : (-p.dueIn) + ' дн. ждёт', 'warm'];
    if (p.dueIn === 0) return ['сегодня', 'lime'];
    if (p.dueIn === 1) return ['завтра', 'gray'];
    return ['через ' + p.dueIn + ' дн.', 'gray'];
  }

  function pic(p, cls) {
    return '<span class="' + cls + (p.photo ? '' : ' empty') + '">' + (p.photo ? '<img src="' + photoUrl(p) + '" alt="" loading="lazy">' : ms('potted_plant')) + '</span>';
  }

  function waterRow(p) {
    const w = when(p);
    return '<div class="row' + (p.wateredToday ? ' done' : '') + '">' +
      '<button class="hit" data-water="' + p.id + '">' + check(p.wateredToday) + '</button>' +
      '<button class="hit grow" data-open="' + p.id + '">' + pic(p, 'thumb') +
      '<span class="txt"><b>' + esc(p.name) + '</b><small>раз в ' + days(p.every) + '</small></span>' + chip(w[0], w[1]) + '</button></div>';
  }

  // Переключатель «Мои цветы / цветы, которые мне доверили». Виден, только если кто-то поделился.
  function gardenSwitch() {
    if (!state.gardens || state.gardens.length < 2) return '';
    return '<div class="gardens">' + state.gardens.map((g) => '<button data-garden="' + g.id + '" class="' + (g.id === state.garden ? 'on' : '') + '">' +
      ms(g.id === state.gardens[0].id ? 'potted_plant' : 'group') + esc(g.name) + '</button>').join('') + '</div>';
  }
  const gardenName = () => { const g = state.gardens && state.gardens.find((x) => x.id === state.garden); return g ? g.name : ''; };

  function headline(dark, gray, label) {
    return '<section class="headline">' + (label ? '<p class="label">' + label + '</p>' : '') +
      '<h1>' + esc(dark) + (gray ? '<br><span>' + esc(gray) + '</span>' : '') + '</h1></section>';
  }

  function scanFacts(s) {
    return '<ul class="facts">' +
      fact('eco', s.statusText || STATUS[s.status][0]) +
      (s.why ? fact('search', s.why) : '') +
      (s.pot !== 'unknown' ? fact('potted_plant', s.potText || POT[s.pot][0]) : '') +
      fact('water_drop', 'раз в ' + days(s.every) + (s.waterText ? ', ' + lower(s.waterText) : '')) +
      (s.light ? fact('light_mode', s.light) : '') +
      (s.identified ? fact('biotech', (s.identified.disputed ? s.identified.source + ' думает иначе: ' : 'вид по ' + s.identified.source + ': ') + s.identified.latin + ', ' + Math.round(s.identified.score * 100) + '%') : '') + '</ul>';
  }

  function scanChips(s) {
    return '<div class="chips">' + chip(STATUS[s.status][0], STATUS[s.status][1], STATUS[s.status][2]) +
      (POT[s.pot] ? chip(POT[s.pot][0], POT[s.pot][1], 'potted_plant') : '') + '</div>';
  }

  // Галерея из нескольких фото: листаются вбок, точки под ней показывают, какое открыто.
  // key — чья галерея: 'scan' или id цветка; slide — какое фото открыто.
  function gallery(key, urls, slide) {
    return '<section class="gallery"><div class="slides" data-gallery="' + esc(key) + '" data-slide="' + slide + '">' +
      urls.map((u) => '<div class="slide"><span class="photo"><img src="' + esc(u) + '" alt=""></span></div>').join('') + '</div>' +
      '<div class="dots">' + urls.map((_, i) => '<button data-slide-to="' + i + '" data-gallery="' + esc(key) + '" class="' + (i === slide ? 'on' : '') + '" aria-label="Фото ' + (i + 1) + '"></button>').join('') + '</div></section>';
  }

  // Разбор одного доснятого фото: что на нём, что это значит, что делать. remove — атрибуты кнопки «Убрать это фото».
  function detailCard(d, k, total, remove) {
    d = d || {};
    let h = (d.seen || d.means)
      ? '<section class="card"><div class="card-head"><div><h3>На этом фото</h3><p>фото ' + (k + 1) + ' из ' + total + '</p></div></div><ul class="facts">' +
        (d.seen ? fact('eco', d.seen) : '') + (d.means ? fact('lightbulb', d.means) : '') + '</ul></section>'
      : '<section class="card empty-card"><p>Про это фото отдельно сказать нечего, оно учтено в общем выводе на первом фото.</p></section>';
    if (d.todo && d.todo.length) {
      h += '<section class="card todo"><div class="card-head"><div><h3>Что с этим делать</h3></div></div><ul class="facts">' +
        d.todo.map((t) => fact('arrow_right_alt', t)).join('') + '</ul></section>';
    }
    if (remove) h += '<button class="link-btn" ' + remove + '>' + ms('delete') + 'Убрать это фото</button>';
    return h;
  }

  function todoCard(s) {
    if (!s.todo.length) return '';
    return '<section class="card todo"><div class="card-head"><div><h3>Сделать</h3></div></div><ul class="facts">' +
      s.todo.map((t) => fact('arrow_right_alt', t)).join('') + '</ul></section>';
  }

  // ── Сегодня ──
  function viewToday() {
    const due = state.plants.filter((p) => p.dueIn <= 0 || p.wateredToday);
    const left = due.filter((p) => !p.wateredToday).length;
    const care = state.plants.filter((p) => p.scan && (p.scan.status !== 'ok' || p.scan.pot === 'small'));
    const next = state.plants.filter((p) => p.dueIn > 0 && !p.wateredToday).sort((a, b) => a.dueIn - b.dueIn)[0];
    const d = new Date(state.today + 'T00:00:00Z');

    let h = gardenSwitch() + headline(
      left ? 'Полить ' + left + ' ' + plural(left, 'цветок', 'цветка', 'цветков') : 'Все напоены',
      care.length ? 'и ' + care.length + ' ' + plural(care.length, 'просит', 'просят', 'просят') + ' внимания' : 'остальные в порядке',
      DAYS[d.getUTCDay()] + ', ' + dateLabel(state.today) + (own() ? '' : ' · цветы: ' + esc(gardenName())));

    // Плашка полива. Маленький ярлык «Полив», дальше крупно главное: сколько осталось или сколько полито,
    // а потом уже какой цветок. Сама плашка не выше, чем нужно для этих строк.
    const tag = '<span class="tag">' + ms('water_drop') + 'Полив</span>';
    if (due.length) {
      const watered = due.length - left;
      h += '<section class="card green water"><div class="tag-row">' + tag + '<small>' + (left ? 'тыкай в квадратик, когда польёшь' : 'на сегодня всё') + '</small></div>' +
        '<div class="big">' + watered + '<span>/' + due.length + '</span></div><div class="segs">' +
        due.map((p) => '<span class="' + (p.wateredToday ? 'on' : '') + '"></span>').join('') + '</div>' +
        '<div class="inner">' + due.map(waterRow).join('') + '</div>' +
        (left > 1 ? '<button class="pill light" data-action="water-all"><span>Полила всех</span><i>' + ms('done_all') + '</i></button>' : '') + '</section>';
    } else if (next) {
      const same = state.plants.filter((p) => p.dueIn === next.dueIn && !p.wateredToday);
      h += '<section class="card green water"><button class="next-water" data-open="' + next.id + '"><span class="txt">' + tag +
        '<span class="line">дальше ' + esc(next.name) + (same.length > 1 ? ' и\u00a0ещё\u00a0' + (same.length - 1) : '') + ', ' + (next.dueIn === 1 ? 'завтра' : ('через ' + days(next.dueIn)).replace(/ /g, '\u00a0')) + '</span></span>' +
        pic(next, 'thumb') + '</button></section>';
    } else {
      h += '<section class="card green water"><div class="tag-row">' + tag + '<small>никого поливать не надо</small></div></section>';
    }

    if (care.length) {
      h += '<section class="card"><div class="card-head"><div><h3>Просят внимания</h3><p>по последнему скану</p></div></div><div class="rows">' +
        care.map((p) => {
          const s = STATUS[p.scan.status];
          return '<button class="row hit grow" data-open="' + p.id + '">' + pic(p, 'thumb') + '<span class="txt"><b>' + esc(p.name) + '</b><small>' +
            esc(p.scan.todo[0] || p.scan.statusText) + '</small></span>' +
            (p.scan.status !== 'ok' ? chip(s[0], s[1]) : chip(POT.small[0], POT.small[1])) + '</button>';
        }).join('') + '</div></section>';
    }

    if (own()) h += '<button class="card scan-cta" data-go="scan"><span class="circle">' + ms('photo_camera') + '</span><span class="txt"><b>Проверить цветок</b><small>сфоткай, скажу, всё ли ок</small></span>' + ms('chevron_right') + '</button>';
    return h;
  }

  // ── Цветы ──
  function viewPlants() {
    const sorted = state.plants.slice().sort((a, b) => a.dueIn - b.dueIn);
    let h = gardenSwitch() + headline(own() ? 'Мои цветы' : 'Цветы: ' + gardenName(), state.plants.length + ' ' + plural(state.plants.length, 'штука', 'штуки', 'штук'));
    h += '<div class="tiles">' + sorted.map((p) => {
      const w = when(p);
      const s = p.scan ? STATUS[p.scan.status] : null;
      return '<button class="tile" data-open="' + p.id + '">' + pic(p, 'pic') +
        (s && s[2] && p.scan.status !== 'ok' ? '<span class="flag ' + s[1] + '">' + ms(s[2]) + '</span>' : '') +
        '<span class="tile-body"><b>' + esc(p.name) + '</b>' + chip(w[0], w[1], 'water_drop') + '</span></button>';
    }).join('') +
      (own() ? '<button class="tile add" data-go="scan"><span class="pic">' + ms('add_a_photo') + '</span><span class="tile-body"><b>Добавить</b><small>через скан</small></span></button>' : '') + '</div>';
    if (own()) {
      h += '<button class="card scan-cta" data-action="share-open"><span class="circle">' + ms('group_add') + '</span><span class="txt"><b>Поделиться цветами</b><small>с тем, кто присмотрит, пока тебя нет</small></span>' + ms('chevron_right') + '</button>';
    }
    return h;
  }

  // ── Карточка цветка ──
  function viewPlant(id) {
    const p = byId(id);
    if (!p) return viewPlants();
    const s = p.scan;
    const w = when(p);
    let h = '<div class="topbar"><button class="circle" data-go="plants">' + ms('arrow_back') + '</button></div>';
    // Доснятые фото листаются вбок. Под каждым его разбор, под первым — вся карточка.
    const det = s && s.details && p.photo ? s.details : [];
    if (det.length) {
      const k = Math.min(plantSlides[p.id] || 0, det.length);
      h += gallery(p.id, [p.photo, ...det.map((d) => d.photo)], k);
      h += headline(p.name, s.latin || '');
      if (k > 0) return h + detailCard(det[k - 1], k, det.length + 1, own() ? 'data-unshot="' + p.id + '" data-i="' + (k - 1) + '"' : '');
    } else {
      h += '<section class="hero-photo">' + pic(p, 'photo') + '</section>';
      h += headline(p.name, s && s.latin ? s.latin : '');
    }
    if (s) h += scanChips(s);

    h += '<section class="card"><div class="card-head"><div><h3>Полив</h3><p>' +
      (p.wateredToday ? 'полито сегодня, следующий через ' + days(p.every) : p.last ? 'следующий ' + w[0] : 'ещё не отмечали') + '</p></div>' +
      '<button class="water-btn' + (p.wateredToday ? ' on' : '') + '" data-water="' + p.id + '">' + ms('water_drop') + (p.wateredToday ? 'Полито' : 'Полила') + '</button></div>' +
      (p.last ? '<button class="link-row" data-pickday="' + p.id + '">' + ms('event') + '<span>последний полив: ' + shortLabel(p.last) + '</span><b>' + (pickDay === p.id ? 'скрыть' : 'другой день') + '</b></button>' : '') +
      (!p.last || pickDay === p.id ? dayPicker(p) : '') +
      (own()
        ? '<div class="stepper"><span>Раз в</span><button class="circle" data-every="' + (p.every - 1) + '">' + ms('remove') + '</button><b>' + days(p.every) + '</b>' +
          '<button class="circle" data-every="' + (p.every + 1) + '">' + ms('add') + '</button></div>' +
          (s && s.every !== p.every ? '<button class="hint" data-every="' + s.every + '">' + ms('auto_awesome') + 'Скан советует раз в ' + days(s.every) + ', поставить?</button>' : '')
        : '<div class="stepper"><span>Раз в</span><b>' + days(p.every) + '</b></div>') +
      '</section>';

    if (s) {
      h += '<section class="card"><div class="card-head"><div><h3>Как дела</h3><p>скан от ' + dateLabel(s.date) + '</p></div></div>' + scanFacts(s) + '</section>';
      h += todoCard(s);
    } else {
      h += '<section class="card empty-card"><p>Этот цветок ещё не сканировали. Сфоткай его, и тут появится, всё ли с ним ок.</p></section>';
    }

    if (own()) {
      if (s) {
        h += '<button class="pill" data-detail="' + p.id + '"><span>Добавить фото детали<small>пятно, лист снизу, грунт: обновлю советы</small></span><i>' + ms('add_a_photo') + '</i></button>' +
          '<button class="link-btn" data-rescan="' + p.id + '">' + ms('photo_camera') + 'Пересканировать целиком</button>';
      } else {
        h += '<button class="pill" data-rescan="' + p.id + '"><span>Сканировать</span><i>' + ms('photo_camera') + '</i></button>';
      }
      h += '<button class="link-btn" data-delete="' + p.id + '">' + ms('delete') + 'Удалить из коллекции</button>';
    }
    return h;
  }

  // Когда был последний полив: сегодня, вчера, ещё пять дней или любой день в календаре.
  function dayPicker(p) {
    let chips = '';
    for (let i = 0; i < 7; i++) {
      const day = addDays(state.today, -i);
      chips += '<button class="toggle' + (p.last === day ? ' on' : '') + '" data-lastday="' + day + '" data-plant="' + p.id + '">' +
        (i === 0 ? 'сегодня' : i === 1 ? 'вчера' : shortLabel(day)) + '</button>';
    }
    chips += '<span class="toggle date">' + ms('calendar_month') + 'раньше<input type="date" data-plant="' + p.id + '" max="' + state.today + '" min="' + addDays(state.today, -365) + '"></span>';
    return '<div class="ask">' + (p.last ? '' : '<p><b>Когда был последний полив?</b> От этого дня посчитаю следующий.</p>') + '<div class="pick">' + chips + '</div></div>';
  }

  // ── Скан ──
  function viewScan() {
    if (!scan) {
      return headline('Проверить цветок', 'сфоткай целиком, вместе с горшком') +
        '<button class="card camera" data-action="shoot"><span class="lens">' + ms('photo_camera') + '</span><b>Сделать фото</b><small>или выбрать из галереи</small></button>';
    }
    let h = '<div class="topbar"><button class="circle" data-action="scan-reset">' + ms('close') + '</button></div>';
    // Пока идёт скан, сверху фото, которое только что сняли. Когда готово и фото несколько, они листаются вбок,
    // и открыто последнее: под ним разбор именно этого фото.
    const shots = scan.status === 'done' && scan.shots && scan.shots.length > 1 ? scan.shots.slice() : null;
    const slide = shots ? Math.min(scan.slide || 0, shots.length - 1) : 0;
    if (shots) {
      if (scan.lastPreview) shots[shots.length - 1] = scan.lastPreview;
      h += gallery('scan', shots, slide);
    } else {
      h += '<section class="hero-photo"><span class="photo"><img src="' + scan.preview + '" alt=""></span>' +
        (scan.status === 'loading' ? '<span class="scanning"><i></i></span>' : '') + '</section>';
    }
    if (scan.status === 'loading') {
      return h + headline('Смотрю…', scan.detail ? 'деталь вместе с фото цветка, минуту-полторы' : scanMore ? 'вместе с прошлыми фото, минуту-полторы' : 'обычно минуту-полторы') +
        '<p class="wait-line"><b id="elapsed">' + clock(scan.started) + '</b><span>' + esc(scan.stage || 'Определяю вид, разглядываю листья, грунт и горшок…') + '</span></p>';
    }
    if (scan.status === 'error') {
      return h + headline('Не получилось', scan.error) + '<button class="pill" data-action="shoot"><span>Сфоткать ещё раз</span><i>' + ms('photo_camera') + '</i></button>';
    }
    const s = scan.result;
    if (slide > 0) {
      h += headline(s.name, s.latin) + detailCard((s.details || [])[slide - 1], slide, shots.length, 'data-action="drop-shot" data-i="' + slide + '"');
    } else {
      h += headline(s.name, s.latin) + scanChips(s);
      if (s.confidence === 'low') h += '<p class="note">Не до конца уверена, что это он. Можно сфоткать поближе.</p>';
      h += '<section class="card">' + scanFacts(s) + '</section>' + todoCard(s);
    }
    if (slide === 0 && s.needPhotos && s.needPhotos.length) {
      h += '<section class="card"><div class="card-head"><div><h3>Чтобы ответить точнее</h3><p>' +
        (scan.photos > 1 ? 'учла ' + scan.photos + ' фото, ' : '') + 'сфоткай ещё</p></div></div><ul class="facts">' +
        s.needPhotos.map((t) => fact('add_a_photo', t)).join('') + '</ul>' +
        '<button class="pill" data-action="shoot-more"><span>Доснять</span><i>' + ms('photo_camera') + '</i></button></section>';
    }
    if (scan.photos > 1) {
      h += '<button class="link-btn" data-action="scan-undo">' + ms('undo') + (scan.detail && scan.photos === 2 ? 'Вернуть как было в карточке' : 'Вернуть прошлый результат, без последнего фото') + '</button>';
    }
    // Куда сохранить. Новый цветок всегда можно выбрать, а обновить карточку, на которую скан не похож, только после вопроса.
    const target = scan.target && byId(scan.target);
    const saveNew = '<button class="pill" data-save="new"><span>Это новый цветок</span><i>' + ms('add') + '</i></button>';
    if (target && sameKind(target, s) === false) {
      h += '<p class="note">Похоже, это не «' + esc(target.name) + '»: в карточке ' + esc(target.scan.latin) + ', а на фото ' + esc(s.latin || s.name) + '.</p>' + saveNew +
        '<button class="link-btn" data-save="' + target.id + '" data-sure="1">Всё равно обновить «' + esc(target.name) + '»</button>';
    } else if (target) {
      h += '<button class="pill" data-save="' + target.id + '"><span>Обновить «' + esc(target.name) + '»</span><i>' + ms('check') + '</i></button>' +
        (scan.detail ? '' : '<button class="link-btn" data-save="new">' + ms('add') + 'Нет, это другой цветок, сохранить как новый</button>');
    } else {
      h += '<section class="card"><div class="card-head"><div><h3>Сохранить</h3><p>фото и скан попадут в карточку цветка</p></div></div>' + saveNew +
        (state.plants.length ? '<p class="sub">Или это кто-то из твоих? Обновлю его фото и скан:</p><div class="pick">' +
          state.plants.map((p) => '<button class="toggle' + (sameKind(p, s) ? ' on' : '') + '" data-save="' + p.id + '">' + esc(p.name) + '</button>').join('') + '</div>' : '') +
        '</section>';
    }
    return h;
  }

  // ── Поделиться цветами ──
  function viewShare() {
    let h = '<div class="topbar"><button class="circle" data-go="plants">' + ms('arrow_back') + '</button></div>';
    h += headline('Поделиться цветами', 'с тем, кто присмотрит за ними');
    const ready = share && share.status === 'done';
    h += '<section class="card"><ul class="facts">' +
      fact('local_florist', 'Увидит все твои цветы и что с ними') +
      fact('water_drop', 'Сможет отмечать полив, ты увидишь это у себя') +
      fact('notifications', 'Будет получать напоминалки о поливе') +
      fact('lock', 'Удалять, добавлять и сканировать твои цветы не сможет') + '</ul>' +
      '<button class="pill" data-action="share-send"' + (ready ? '' : ' disabled') + '><span>Отправить приглашение</span><i>' + ms('send') + '</i></button>' +
      (ready ? '<button class="link-btn" data-action="share-copy">' + ms('content_copy') + 'Скопировать ссылку</button>' : '') + '</section>';
    if (!share || share.status === 'loading') h += '<div class="loading small"><span class="spinner"></span></div>';
    else if (share.status === 'error') h += '<p class="note">' + esc(share.error) + '</p>';
    else {
      if (share.guests.length) {
        h += '<section class="card"><div class="card-head"><div><h3>Есть доступ</h3><p>видят цветы и отмечают полив</p></div></div><div class="rows">' +
          share.guests.map((g) => '<div class="row"><span class="txt"><b>' + esc(g.name) + '</b></span><button class="toggle" data-unshare="' + g.id + '">Закрыть доступ</button></div>').join('') +
          '</div></section>';
      }
      h += '<button class="link-btn" data-action="share-reset">' + ms('link_off') + 'Сделать новую ссылку, старая перестанет работать</button>';
    }
    const others = (state.gardens || []).slice(1);
    if (others.length) {
      h += '<section class="card"><div class="card-head"><div><h3>Тебе доверили</h3><p>цветы других людей</p></div></div><div class="rows">' +
        others.map((g) => '<div class="row"><span class="txt"><b>' + esc(g.name) + '</b></span><button class="toggle" data-leave="' + g.id + '">Отказаться</button></div>').join('') +
        '</div></section>';
    }
    return h;
  }

  function render(error) {
    if (!state) {
      root.innerHTML = '<div class="loading">' + (error ? esc(error) : '<span class="spinner"></span>') + '</div>';
      return;
    }
    const tab = route.startsWith('plant/') || route === 'share' ? 'plants' : route;
    let view;
    if (route.startsWith('plant/')) view = viewPlant(route.slice(6));
    else if (route === 'plants') view = viewPlants();
    else if (route === 'scan') view = viewScan();
    else if (route === 'share') view = viewShare();
    else view = viewToday();
    patch(root, '<nav class="tabs">' + TABS.filter((t) => own() || t[0] !== 'scan').map((t) => '<button data-go="' + t[0] + '" class="' + (t[0] === tab ? 'on' : '') + '">' +
      (t[0] === 'scan' ? ms('photo_camera') : '') + t[1] + '</button>').join('') +
      '<button class="theme-btn" data-action="theme" aria-label="' + (isDark() ? 'Светлая тема' : 'Тёмная тема') + '">' + ms(isDark() ? 'light_mode' : 'dark_mode') + '</button>' +
      '</nav><main>' + view + '</main>');
    syncGalleries();
  }

  // Галерея прокручена на открытое фото. Если человек листает сам, ловим, на каком фото он остановился.
  function syncGalleries() {
    root.querySelectorAll('.slides').forEach((g) => {
      const k = Number(g.dataset.slide) || 0;
      if (g.clientWidth && Math.round(g.scrollLeft / g.clientWidth) !== k) g.scrollLeft = k * g.clientWidth;
    });
  }
  function showSlide(key, k, scrollTo) {
    if (key === 'scan') { if (!scan) return; scan.slide = k; } else plantSlides[key] = k;
    render();
    if (scrollTo) window.scrollTo(0, 0);
  }
  let slideTimer = null;
  root.addEventListener('scroll', (e) => {
    const g = e.target;
    if (!g.classList || !g.classList.contains('slides')) return;
    clearTimeout(slideTimer);
    slideTimer = setTimeout(() => {
      const k = Math.round(g.scrollLeft / (g.clientWidth || 1));
      if (k !== Number(g.dataset.slide)) showSlide(g.dataset.gallery, k);
    }, 120);
  }, true);

  // Экран не перерисовывается целиком: новая разметка сравнивается с той, что уже на экране,
  // и меняются только отличающиеся кусочки (галочка, надпись на кнопке, строчка). Фото и прокрутка остаются на месте.
  function patch(el, html) {
    const next = document.createElement('div');
    next.innerHTML = html;
    morphChildren(el, next);
  }
  function morphChildren(from, to) {
    const a = Array.from(from.childNodes), b = Array.from(to.childNodes);
    for (let i = 0; i < b.length; i++) {
      if (i < a.length) morph(a[i], b[i]);
      else from.appendChild(b[i]);
    }
    for (let i = b.length; i < a.length; i++) a[i].remove();
  }
  function morph(from, to) {
    if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName ||
      (from.nodeType === 1 && from.getAttribute('src') !== to.getAttribute('src'))) {
      from.replaceWith(to); // другой элемент или другое фото: проще заменить
      return;
    }
    if (from.nodeType !== 1) {
      if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
      return;
    }
    for (const at of Array.from(from.attributes)) if (!to.hasAttribute(at.name)) from.removeAttribute(at.name);
    for (const at of Array.from(to.attributes)) if (from.getAttribute(at.name) !== at.value) from.setAttribute(at.name, at.value);
    if (from.nodeName === 'INPUT' && from.value !== to.value) from.value = to.value;
    morphChildren(from, to);
  }

  function go(r) {
    // Скан всегда про свои цветы: из чужих сначала возвращаемся к своим.
    if ((r === 'scan' || r === 'share') && !own()) return switchGarden(null, r);
    route = r;
    history.replaceState(null, '', '#' + r);
    render(); window.scrollTo(0, 0);
  }

  // Ошибка запроса. Если доступ к чужим цветам закрыли, возвращаемся к своим.
  function oops(e) {
    alert(e.message);
    if (e.gone) switchGarden(null, 'today');
  }

  // Действие с ожиданием ответа: нажатая кнопка бледнеет, пока сервер не ответит.
  async function act(fn, btn) {
    if (busy) return;
    busy = true;
    if (btn) btn.classList.add('wait');
    try { setState(await fn()); render(); } catch (e) { if (btn) btn.classList.remove('wait'); oops(e); } finally { busy = false; }
  }

  // Полив отмечаем на экране сразу, а сервер догоняет. Нажатия идут в очередь, экран обновляется по последнему ответу.
  let waterQueue = Promise.resolve(), waterPending = 0;
  function water(id) {
    const p = byId(id);
    if (!p) return;
    haptic();
    p.wateredToday = !p.wateredToday;
    if (p.wateredToday) { p.last = state.today; p.dueIn = p.every; } else p.dueIn = 0;
    render();
    waterPending++;
    const g = garden;
    waterQueue = waterQueue
      .then(() => api('/api/water', { plant: id }))
      .then((s) => { if (--waterPending === 0 && g === garden) { setState(s); render(); } },
        (e) => { waterPending--; oops(e); reload(); });
  }

  function reload() {
    return api('/api/state').then((s) => { state = s; render(); }).catch((e) => (e.gone ? switchGarden(null, 'today') : render(e.message)));
  }

  // Переключиться на свои цветы (id = null) или на те, что доверили.
  function switchGarden(id, next) {
    const mine = state && state.gardens ? state.gardens[0].id : null;
    garden = id === mine ? null : id;
    pickDay = null;
    state = null; render();
    return api('/api/state').then((s) => {
      state = s;
      go(next || (route.startsWith('plant/') || route === 'share' ? 'plants' : route));
    }).catch((e) => { if (garden) { garden = null; reload(); } else render(e.message); });
  }

  async function loadShare(path, body) {
    share = { ...(share || {}), status: share && share.link ? 'done' : 'loading' };
    if (route === 'share') render();
    try { share = { status: 'done', ...(await api(path, body || {})) }; } catch (e) { share = { status: 'error', error: e.message }; }
    if (route === 'share') render();
  }

  function setLast(plant, day, btn) {
    if (!day) return;
    haptic();
    pickDay = null;
    act(() => api('/api/water/last', { plant, day }), btn);
  }

  // Фото: ужимаем до 1024px по длинной стороне прямо на телефоне.
  function shrink(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        c.toBlob((b) => (b ? resolve({ blob: b, preview: c.toDataURL('image/jpeg', 0.7) }) : reject(new Error('Не получилось прочитать фото'))), 'image/jpeg', 0.85);
      };
      img.onerror = () => reject(new Error('Не получилось прочитать фото'));
      img.src = URL.createObjectURL(file);
    });
  }

  const camera = document.createElement('input');
  camera.type = 'file'; camera.accept = 'image/*'; camera.hidden = true;
  document.body.appendChild(camera);
  let scanTarget = null;
  let scanMore = false;     // досылаем фото к текущему скану
  let scanDetail = false;   // фото детали к цветку из коллекции

  // Скан идёт минуту-полторы, а телефон может оборвать такой долгий запрос. Поэтому фото только отправляем,
  // а потом каждые 2 секунды спрашиваем сервер, готово ли.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitForScan(job, isCurrent) {
    let misses = 0;
    for (let i = 0; i < 150; i++) {
      await sleep(2000);
      if (!isCurrent()) return null;
      let r;
      try { r = await api('/api/scan/status?job=' + encodeURIComponent(job)); misses = 0; } catch (e) {
        if (e.message && !/грузится|Load failed|fetch/i.test(e.message)) throw e;
        if (++misses >= 5) throw e; // связь пропала надолго
        continue;
      }
      if (r.status === 'done') return r;
      if (r.status === 'error') throw new Error(r.error);
      if (r.stage && scan && scan.status === 'loading' && scan.stage !== r.stage) { scan.stage = r.stage; if (route === 'scan') render(); }
    }
    throw new Error('Скан слишком долго думает, попробуй ещё раз');
  }

  let scanSeq = 0;
  camera.addEventListener('change', async () => {
    const file = camera.files[0];
    camera.value = '';
    if (!file) return;
    const seq = ++scanSeq;
    const isCurrent = () => seq === scanSeq;
    try {
      const img = await shrink(file);
      // При досъёмке сверху остаётся первое, основное фото.
      // Сверху всегда фото, которое только что сняли. Прошлый результат помним: если досъёмка не удастся, вернём его.
      const keep = scanMore && scan && scan.result ? scan : null;
      const plant = scanDetail && byId(scanTarget);
      const detail = !!plant || !!(keep && keep.detail);
      scan = {
        status: 'loading', preview: img.preview, lastPreview: img.preview, prev: keep,
        target: scanTarget, detail, started: Date.now(),
      };
      go('scan');
      const { job } = await api('/api/scan' + (scanMore ? '?more=1' : plant ? '?plant=' + encodeURIComponent(plant.id) : ''), img.blob, true);
      const res = await waitForScan(job, isCurrent);
      if (!res || !isCurrent()) return;
      const n = res.photos || 1;
      scan = { ...scan, status: 'done', result: res.scan, photos: n, shots: res.shots || [], slide: n - 1, prev: null };
    } catch (e) {
      if (!isCurrent()) return;
      // Досъёмка не удалась: оставляем прошлый результат, он на сервере тоже не тронут.
      if (scan && scan.prev) {
        scan = { ...scan.prev, status: 'done' };
        if (route === 'scan') render();
        return alert('Не получилось доснять: ' + e.message + ' Оставила прошлый результат.');
      }
      scan = { ...(scan || {}), status: 'error', error: e.message };
    }
    if (route === 'scan') render();
  });

  function shoot(target, more, detail) {
    scanTarget = target || null;
    scanMore = !!more;
    scanDetail = !!detail && !more;
    camera.click();
  }

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.go) return go(d.go);
    if (d.open) { delete plantSlides[d.open]; return go('plant/' + d.open); }
    if (d.slideTo) return showSlide(d.gallery, Number(d.slideTo), true);
    if (d.unshot) {
      if (!confirm('Убрать это фото и его разбор?')) return;
      haptic();
      const k = Number(d.i);
      await act(() => api('/api/plant/detail/delete', { plant: d.unshot, i: k }), b);
      plantSlides[d.unshot] = k + 1; // открываем следующее фото, а если убрали последнее, то предыдущее
      return render();
    }
    if (d.garden) return switchGarden(Number(d.garden));
    if (d.water) return water(d.water);
    if (d.pickday) { pickDay = pickDay === d.pickday ? null : d.pickday; return render(); }
    if (d.lastday) return setLast(d.plant, d.lastday, b);
    if (d.every) {
      const p = byId(route.slice(6));
      const every = Number(d.every);
      if (!p || every < 1 || every > 60) return;
      haptic();
      return act(() => api('/api/plant/update', { plant: p.id, every }), b);
    }
    if (d.rescan) return shoot(d.rescan);
    if (d.detail) return shoot(d.detail, false, true);
    if (d.delete) {
      const p = byId(d.delete);
      if (!confirm('Удалить «' + p.name + '»?')) return;
      await act(() => api('/api/plant/delete', { plant: p.id }));
      return go('plants');
    }
    if (d.save) {
      const p = d.save !== 'new' && byId(d.save);
      if (p && !d.sure && sameKind(p, scan && scan.result) === false &&
        !confirm('На фото, похоже, другой цветок: ' + scan.result.name + '. Всё равно обновить «' + p.name + '»?')) return;
      haptic();
      let saved = null;
      await act(async () => { const r = await api('/api/scan/save', { target: d.save }); saved = r.saved; return r; }, b);
      if (saved) { scan = null; go('plant/' + saved); }
      return;
    }
    if (d.unshare) {
      const g = share.guests.find((x) => String(x.id) === d.unshare);
      if (!confirm('Закрыть доступ для ' + (g ? g.name : 'гостя') + '?')) return;
      return loadShare('/api/share/remove', { guest: Number(d.unshare) });
    }
    if (d.leave) {
      const g = state.gardens.find((x) => String(x.id) === d.leave);
      if (!confirm('Больше не присматривать за цветами: ' + (g ? g.name : '') + '?')) return;
      try { await api('/api/share/leave', { owner: Number(d.leave) }); } catch (err) { return alert(err.message); }
      return switchGarden(null, 'share');
    }
    if (d.action === 'share-open') { share = null; go('share'); return loadShare('/api/share'); }
    if (d.action === 'share-send' && share && share.link) {
      const text = 'Присмотришь за моими цветами? По ссылке бот покажет, кого и когда поливать 🌿';
      const url = 'https://t.me/share/url?url=' + encodeURIComponent(share.link) + '&text=' + encodeURIComponent(text);
      if (tg && tg.openTelegramLink) tg.openTelegramLink(url); else window.open(url, '_blank');
      return;
    }
    if (d.action === 'share-copy' && share && share.link) {
      const link = share.link;
      return navigator.clipboard.writeText(link).then(() => alert('Ссылка скопирована'), () => prompt('Скопируй ссылку', link));
    }
    if (d.action === 'share-reset') {
      if (!confirm('Сделать новую ссылку? По старой больше никто не сможет зайти. У тех, кто уже зашёл, доступ останется.')) return;
      return loadShare('/api/share/reset');
    }
    if (d.action === 'shoot') return shoot(scan && scan.target, false, scan && scan.detail && !scan.result);
    if (d.action === 'shoot-more') return shoot(scan && scan.target, true);
    if (d.action === 'scan-undo') {
      haptic();
      b.classList.add('wait');
      try {
        const r = await api('/api/scan/undo', {});
        scan = { ...scan, status: 'done', result: r.scan, photos: r.photos || 1, shots: r.shots || [], slide: 0, lastPreview: null };
        render(); window.scrollTo(0, 0);
      } catch (err) { b.classList.remove('wait'); alert(err.message); }
      return;
    }
    if (d.action === 'drop-shot') {
      if (!confirm('Убрать это фото и его разбор? Общий вывод останется.')) return;
      haptic();
      b.classList.add('wait');
      try {
        const r = await api('/api/scan/drop', { i: Number(d.i) });
        scan = { ...scan, result: r.scan, photos: r.photos, shots: r.shots || [], slide: Math.min(Number(d.i), r.photos - 1), lastPreview: null };
        render();
      } catch (err) { b.classList.remove('wait'); alert(err.message); }
      return;
    }
    if (d.action === 'scan-reset') { scan = null; scanSeq++; return go('scan'); }
    if (d.action === 'theme') { haptic(); setTheme(isDark() ? 'light' : 'dark'); return render(); }
    if (d.action === 'water-all') { haptic(); return act(() => api('/api/water-all', {}), b); }
  });

  // Выбор дня в календаре («раньше»).
  root.addEventListener('change', (e) => {
    const input = e.target;
    if (input.matches('input[type=date][data-plant]')) setLast(input.dataset.plant, input.value);
  });

  // Секундомер, пока идёт скан.
  setInterval(() => {
    const el = document.getElementById('elapsed');
    if (el && scan && scan.status === 'loading') el.textContent = clock(scan.started);
  }, 1000);

  render();
  reload();
}

app();
