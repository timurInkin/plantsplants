// Экран приложения внутри Telegram (Mini App).
function app() {
  const tg = window.Telegram && window.Telegram.WebApp;
  const dark = tg && tg.colorScheme === 'dark';
  if (tg) {
    tg.ready(); tg.expand();
    try { tg.setHeaderColor(dark ? '#121513' : '#EEF1EC'); tg.setBackgroundColor(dark ? '#121513' : '#EEF1EC'); } catch (e) {}
  }
  if (dark) document.documentElement.classList.add('dark');
  const initData = (tg && tg.initData) || '';

  const root = document.getElementById('root');
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const DAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
  const TABS = [['today', 'Сегодня'], ['plants', 'Цветы'], ['scan', 'Скан']];
  const STATUS = { ok: ['всё ок', 'sage', 'check_circle'], watch: ['присмотреться', 'lime', 'visibility'], help: ['подлечить', 'warm', 'healing'] };
  const POT = { ok: ['горшок норм', 'sage'], small: ['тесный горшок', 'warm'], big: ['горшок великоват', 'lime'] };

  let state = null;
  let route = (location.hash || '#today').slice(1);
  let scan = null;          // { status: 'loading' | 'done' | 'error', result, preview, error, target }
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

  async function api(path, body, raw) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': raw ? 'image/jpeg' : 'application/json', 'X-Init-Data': initData },
      body: raw ? body : body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403) throw new Error('Открой это из своего бота в Telegram');
    if (!res.ok) throw new Error(data.error || 'Что-то не грузится, попробуй ещё раз');
    return data;
  }

  const check = (done) => '<span class="check' + (done ? ' on' : '') + '">' + (done ? ms('check') : '') + '</span>';
  const chip = (text, cls, icon) => '<span class="chip ' + cls + '">' + (icon ? ms(icon) : '') + esc(text) + '</span>';
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

  function headline(dark, gray, label) {
    return '<section class="headline">' + (label ? '<p class="label">' + label + '</p>' : '') +
      '<h1>' + esc(dark) + (gray ? '<br><span>' + esc(gray) + '</span>' : '') + '</h1></section>';
  }

  function scanFacts(s) {
    return '<ul class="facts">' +
      fact('eco', s.statusText || STATUS[s.status][0]) +
      (s.why ? fact('search', s.why) : '') +
      (s.pot !== 'unknown' ? fact('potted_plant', s.potText || POT[s.pot][0]) : '') +
      fact('water_drop', 'раз в ' + days(s.every) + (s.waterText ? ', ' + s.waterText : '')) +
      (s.light ? fact('light_mode', s.light) : '') +
      (s.identified ? fact('biotech', 'вид по ' + s.identified.source + ': ' + s.identified.latin + ', ' + Math.round(s.identified.score * 100) + '%') : '') + '</ul>';
  }

  function scanChips(s) {
    return '<div class="chips">' + chip(STATUS[s.status][0], STATUS[s.status][1], STATUS[s.status][2]) +
      (POT[s.pot] ? chip(POT[s.pot][0], POT[s.pot][1], 'potted_plant') : '') + '</div>';
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

    let h = headline(
      left ? 'Полить ' + left + ' ' + plural(left, 'цветок', 'цветка', 'цветков') : 'Все напоены',
      care.length ? 'и ' + care.length + ' ' + plural(care.length, 'просит', 'просят', 'просят') + ' внимания' : 'остальные в порядке',
      DAYS[d.getUTCDay()] + ', ' + dateLabel(state.today));

    h += '<section class="card green"><div class="card-head"><div><h3>Полив</h3><p>' +
      (due.length ? 'тыкай в квадратик, когда польёшь' : next ? 'дальше ' + next.name + ', ' + when(next)[0] : 'никого поливать не надо') +
      '</p></div><span class="circle light">' + ms('water_drop') + '</span></div>';
    if (due.length) {
      const watered = due.length - left;
      h += '<div class="big">' + watered + '<span>/' + due.length + '</span></div><div class="segs">' +
        due.map((p) => '<span class="' + (p.wateredToday ? 'on' : '') + '"></span>').join('') + '</div>' +
        '<div class="inner">' + due.map(waterRow).join('') + '</div>' +
        (left > 1 ? '<button class="pill light" data-action="water-all"><span>Полила всех</span><i>' + ms('done_all') + '</i></button>' : '');
    }
    h += '</section>';

    if (care.length) {
      h += '<section class="card"><div class="card-head"><div><h3>Просят внимания</h3><p>по последнему скану</p></div></div><div class="rows">' +
        care.map((p) => {
          const s = STATUS[p.scan.status];
          return '<button class="row hit grow" data-open="' + p.id + '">' + pic(p, 'thumb') + '<span class="txt"><b>' + esc(p.name) + '</b><small>' +
            esc(p.scan.todo[0] || p.scan.statusText) + '</small></span>' +
            (p.scan.status !== 'ok' ? chip(s[0], s[1]) : chip(POT.small[0], POT.small[1])) + '</button>';
        }).join('') + '</div></section>';
    }

    h += '<button class="card scan-cta" data-go="scan"><span class="circle">' + ms('photo_camera') + '</span><span class="txt"><b>Проверить цветок</b><small>сфоткай, скажу, всё ли ок</small></span>' + ms('chevron_right') + '</button>';
    return h;
  }

  // ── Цветы ──
  function viewPlants() {
    const sorted = state.plants.slice().sort((a, b) => a.dueIn - b.dueIn);
    let h = headline('Мои цветы', state.plants.length + ' ' + plural(state.plants.length, 'штука', 'штуки', 'штук'));
    h += '<div class="tiles">' + sorted.map((p) => {
      const w = when(p);
      const s = p.scan ? STATUS[p.scan.status] : null;
      return '<button class="tile" data-open="' + p.id + '">' + pic(p, 'pic') +
        (s && p.scan.status !== 'ok' ? '<span class="flag ' + s[1] + '">' + ms(s[2]) + '</span>' : '') +
        '<span class="tile-body"><b>' + esc(p.name) + '</b>' + chip(w[0], w[1], 'water_drop') + '</span></button>';
    }).join('') +
      '<button class="tile add" data-go="scan"><span class="pic">' + ms('add_a_photo') + '</span><span class="tile-body"><b>Добавить</b><small>через скан</small></span></button></div>';
    return h;
  }

  // ── Карточка цветка ──
  function viewPlant(id) {
    const p = byId(id);
    if (!p) return viewPlants();
    const s = p.scan;
    const w = when(p);
    let h = '<div class="topbar"><button class="circle" data-go="plants">' + ms('arrow_back') + '</button></div>';
    h += '<section class="hero-photo">' + pic(p, 'photo') + '</section>';
    h += headline(p.name, s && s.latin ? s.latin : '');
    if (s) h += scanChips(s);

    h += '<section class="card"><div class="card-head"><div><h3>Полив</h3><p>' +
      (p.wateredToday ? 'полито сегодня, следующий через ' + days(p.every) : (p.last ? 'последний ' + dateLabel(p.last) + ', ' : '') + 'следующий ' + w[0]) + '</p></div>' +
      '<button class="water-btn' + (p.wateredToday ? ' on' : '') + '" data-water="' + p.id + '">' + ms('water_drop') + (p.wateredToday ? 'Полито' : 'Полила') + '</button></div>' +
      '<div class="stepper"><span>Раз в</span><button class="circle" data-every="' + (p.every - 1) + '">' + ms('remove') + '</button><b>' + days(p.every) + '</b>' +
      '<button class="circle" data-every="' + (p.every + 1) + '">' + ms('add') + '</button></div>' +
      (s && s.every !== p.every ? '<button class="hint" data-every="' + s.every + '">' + ms('auto_awesome') + 'Скан советует раз в ' + days(s.every) + ', поставить?</button>' : '') +
      '</section>';

    if (s) {
      h += '<section class="card"><div class="card-head"><div><h3>Как дела</h3><p>скан от ' + dateLabel(s.date) + '</p></div></div>' + scanFacts(s) + '</section>';
      h += todoCard(s);
    } else {
      h += '<section class="card empty-card"><p>Этот цветок ещё не сканировали. Сфоткай его, и тут появится, всё ли с ним ок.</p></section>';
    }

    h += '<button class="pill" data-rescan="' + p.id + '"><span>' + (s ? 'Пересканировать' : 'Сканировать') + '</span><i>' + ms('photo_camera') + '</i></button>';
    h += '<button class="link-btn" data-delete="' + p.id + '">' + ms('delete') + 'Удалить из коллекции</button>';
    return h;
  }

  // ── Скан ──
  function viewScan() {
    if (!scan) {
      return headline('Проверить цветок', 'сфоткай целиком, вместе с горшком') +
        '<button class="card camera" data-action="shoot"><span class="lens">' + ms('photo_camera') + '</span><b>Сделать фото</b><small>или выбрать из галереи</small></button>';
    }
    let h = '<div class="topbar"><button class="circle" data-action="scan-reset">' + ms('close') + '</button></div>';
    h += '<section class="hero-photo"><span class="photo"><img src="' + scan.preview + '" alt=""></span>' +
      (scan.status === 'loading' ? '<span class="scanning"><i></i></span>' : '') + '</section>';
    if (scan.status === 'loading') return h + headline('Смотрю…', scanMore ? 'вместе с прошлыми фото' : 'пара секунд');
    if (scan.status === 'error') {
      return h + headline('Не получилось', scan.error) + '<button class="pill" data-action="shoot"><span>Сфоткать ещё раз</span><i>' + ms('photo_camera') + '</i></button>';
    }
    const s = scan.result;
    h += headline(s.name, s.latin) + scanChips(s);
    if (s.confidence === 'low') h += '<p class="note">Не до конца уверена, что это он. Можно сфоткать поближе.</p>';
    h += '<section class="card">' + scanFacts(s) + '</section>' + todoCard(s);
    if (s.needPhotos && s.needPhotos.length) {
      h += '<section class="card"><div class="card-head"><div><h3>Чтобы ответить точнее</h3><p>' +
        (scan.photos > 1 ? 'учла ' + scan.photos + ' фото, ' : '') + 'сфоткай ещё</p></div></div><ul class="facts">' +
        s.needPhotos.map((t) => fact('add_a_photo', t)).join('') + '</ul>' +
        '<button class="pill" data-action="shoot-more"><span>Доснять</span><i>' + ms('photo_camera') + '</i></button></section>';
    }
    const target = scan.target && byId(scan.target);
    if (target) {
      h += '<button class="pill" data-save="' + target.id + '"><span>Сохранить в «' + esc(target.name) + '»</span><i>' + ms('check') + '</i></button>';
    } else {
      h += '<section class="card"><div class="card-head"><div><h3>Это кто из твоих?</h3><p>сохраню фото и скан в карточку</p></div></div>' +
        '<div class="pick">' + state.plants.map((p) => '<button class="toggle" data-save="' + p.id + '">' + esc(p.name) + '</button>').join('') + '</div>' +
        '<button class="pill" data-save="new"><span>Это новый цветок</span><i>' + ms('add') + '</i></button></section>';
    }
    return h;
  }

  function render(error) {
    if (!state) {
      root.innerHTML = '<div class="loading">' + (error ? esc(error) : '<span class="spinner"></span>') + '</div>';
      return;
    }
    const tab = route.startsWith('plant/') ? 'plants' : route;
    let view;
    if (route.startsWith('plant/')) view = viewPlant(route.slice(6));
    else if (route === 'plants') view = viewPlants();
    else if (route === 'scan') view = viewScan();
    else view = viewToday();
    root.innerHTML = '<nav class="tabs">' + TABS.map((t) => '<button data-go="' + t[0] + '" class="' + (t[0] === tab ? 'on' : '') + '">' +
      (t[0] === 'scan' ? ms('photo_camera') : '') + t[1] + '</button>').join('') + '</nav><main>' + view + '</main>';
  }

  function go(r) {
    route = r;
    history.replaceState(null, '', '#' + r);
    render(); window.scrollTo(0, 0);
  }

  async function act(fn) {
    if (busy) return;
    busy = true;
    try { state = await fn(); render(); } catch (e) { alert(e.message); } finally { busy = false; }
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

  camera.addEventListener('change', async () => {
    const file = camera.files[0];
    camera.value = '';
    if (!file) return;
    try {
      const img = await shrink(file);
      scan = { status: 'loading', preview: img.preview, target: scanTarget };
      go('scan');
      const res = await api('/api/scan' + (scanMore ? '?more=1' : ''), img.blob, true);
      scan = { ...scan, status: 'done', result: res.scan, photos: res.photos || 1 };
    } catch (e) {
      scan = { ...(scan || {}), status: 'error', error: e.message };
    }
    if (route === 'scan') render();
  });

  function shoot(target, more) {
    scanTarget = target || null;
    scanMore = !!more;
    camera.click();
  }

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.go) return go(d.go);
    if (d.open) return go('plant/' + d.open);
    if (d.water) { haptic(); return act(() => api('/api/water', { plant: d.water })); }
    if (d.every) {
      const p = byId(route.slice(6));
      const every = Number(d.every);
      if (!p || every < 1 || every > 60) return;
      haptic();
      return act(() => api('/api/plant/update', { plant: p.id, every }));
    }
    if (d.rescan) return shoot(d.rescan);
    if (d.delete) {
      const p = byId(d.delete);
      if (!confirm('Удалить «' + p.name + '»?')) return;
      await act(() => api('/api/plant/delete', { plant: p.id }));
      return go('plants');
    }
    if (d.save) {
      haptic();
      let saved = null;
      await act(async () => { const r = await api('/api/scan/save', { target: d.save }); saved = r.saved; return r; });
      if (saved) { scan = null; go('plant/' + saved); }
      return;
    }
    if (d.action === 'shoot') return shoot(scan && scan.target);
    if (d.action === 'shoot-more') return shoot(scan && scan.target, true);
    if (d.action === 'scan-reset') { scan = null; return go('scan'); }
    if (d.action === 'water-all') { haptic(); return act(() => api('/api/water-all', {})); }
  });

  render();
  api('/api/state').then((s) => { state = s; render(); }).catch((e) => render(e.message));
}

app();
