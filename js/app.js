(() => {
  'use strict';

  const CFG = window.PG_CONFIG || {};
  const MAX_SCORE = 5000;
  const PERFECT_RADIUS = 25;       // м — ближе этого всегда 5000
  const MIN_SPREAD = 400;          // м — локации в одной игре не ближе друг к другу

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  // ---------------- геометрия ----------------
  const R = 6371008.8;
  const rad = (d) => d * Math.PI / 180;
  function distance(a, b) {
    const dLat = rad(b[0] - a[0]);
    const dLon = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function inPolygon(p, poly = C.geo.polygon) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if ((yi > p[0]) !== (yj > p[0]) && p[1] < (xj - xi) * (p[0] - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // ---------------- города ----------------
  // Точки на дорогах (js/roads*.js) — панорама рядом находится почти всегда с первого запроса.
  // *_URBAN — сколько многоэтажек рядом с точкой; по нему делим на «город» и «частный сектор».
  const CITIES = {
    penza: {
      id: 'penza', name: 'Пенза', inName: 'в Пензе', allName: 'Вся Пенза',
      cityHint: 'Многоэтажки, центр, Арбеково, Терновка',
      geo: window.PENZA, roads: window.PENZA_ROADS || [], urban: window.PENZA_URBAN || [],
    },
    minsk: {
      id: 'minsk', name: 'Минск', inName: 'в Минске', allName: 'Весь Минск',
      cityHint: 'Многоэтажки, центр, спальные районы',
      geo: window.MINSK, roads: window.MINSK_ROADS || [], urban: window.MINSK_URBAN || [],
    },
  };
  for (const c of Object.values(CITIES)) {
    const la = c.geo.polygon.map((p) => p[0]), lo = c.geo.polygon.map((p) => p[1]);
    c.bbox = [[Math.min(...la), Math.min(...lo)], [Math.max(...la), Math.max(...lo)]];
    // «Размер карты» как в GeoGuessr — диагональ прямоугольника, в который вписана карта.
    c.mapSize = distance(c.bbox[0], c.bbox[1]);
    c.count = Math.floor(c.roads.length / 2);
    c.pools = {};
  }
  let C = CITIES.penza;

  const CITY_MIN = 3;
  const AREA_FILTERS = {
    all: () => true,
    city: (u) => u >= CITY_MIN,
    private: (u) => u === 0,
  };
  function areaPool() {
    const area = AREA_FILTERS[settings.area] ? settings.area : 'all';
    if (!C.pools[area]) {
      const f = AREA_FILTERS[area];
      const pool = [];
      for (let i = 0; i < C.count; i++) if (!C.urban.length || f(C.urban[i] || 0)) pool.push(i);
      C.pools[area] = pool;
    }
    return C.pools[area];
  }
  function randomPoint() {
    const pool = C.count ? areaPool() : [];
    if (pool.length) {
      const i = pool[Math.floor(Math.random() * pool.length)] * 2;
      return [C.roads[i], C.roads[i + 1]];
    }
    for (;;) {
      const p = [
        C.bbox[0][0] + Math.random() * (C.bbox[1][0] - C.bbox[0][0]),
        C.bbox[0][1] + Math.random() * (C.bbox[1][1] - C.bbox[0][1]),
      ];
      if (inPolygon(p)) return p;
    }
  }

  // Формула GeoGuessr: 5000 · e^(−10 · d / размер карты), в радиусе 25 м — 5000.
  function scoreFor(d, city = C) {
    if (d == null) return 0;
    if (d <= PERFECT_RADIUS) return MAX_SCORE;
    return Math.round(MAX_SCORE * Math.exp(-10 * d / city.mapSize));
  }

  function fmtDist(m) {
    if (m == null) return '—';
    if (m < 1000) return `${Math.round(m)} м`;
    return `${(m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',')} км`;
  }
  const fmtNum = (n) => n.toLocaleString('ru-RU');
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // ---------------- состояние ----------------
  const settings = { city: 'penza', area: 'city', mode: 'moving', time: 0, rounds: 5 };
  const AREA_HINTS = {
    city: () => C.cityHint,
    all: () => 'Любая улица, включая окраины',
    private: () => 'Частный сектор и бывшие деревни',
  };
  const MODE_HINTS = {
    moving: 'Ходишь, крутишь, приближаешь',
    nomove: 'Стоишь на месте, крутишь камеру',
    nmpz: 'Один кадр, без поворота и зума',
  };
  let game = null;
  let player = null;
  let guessMap = null, guessMark = null;
  let resultMap = null;
  let timerId = null;
  let nextLocation = null;
  let roundToken = 0;

  // ---------------- загрузка API ----------------
  function storedKey() { try { return localStorage.getItem('pg-apikey') || ''; } catch { return ''; } }
  const API_KEY = (storedKey() || (CFG.apiKeys && CFG.apiKeys[location.hostname]) || CFG.apiKey || '').trim();

  function loadYmaps() {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://api-maps.yandex.ru/2.1/?lang=ru_RU' + (API_KEY ? '&apikey=' + encodeURIComponent(API_KEY) : '');
      s.onload = () => ymaps.ready(resolve, reject);
      s.onerror = () => reject(new Error('Не удалось загрузить API Яндекс Карт. Проверь интернет.'));
      document.head.appendChild(s);
    });
  }

  // ---------------- панорамы без подписей ----------------
  // Оборачиваем объект панорамы: всё как в оригинале, но без маркеров
  // (номера домов, названия, объекты), а в режимах без ходьбы — без стрелок переходов.
  // Переходы (стрелки, перекрёстки, клик по дороге) тоже оборачиваем, чтобы плеер
  // сразу получал очищенную панораму — иначе успевает нарисовать номера домов.
  function wrapLink(link, owner) {
    const l = Object.create(link);
    l.getPanorama = () => owner;
    l.getConnectedPanorama = () => {
      usage.add('move');
      return link.getConnectedPanorama().then(sanitize);
    };
    return l;
  }

  function sanitizeGraph(graph, owner, moving) {
    if (!graph) return graph;
    const map = new Map();
    const nodes = moving ? graph.getNodes().map((n) => { const wn = wrapLink(n, owner); map.set(n, wn); return wn; }) : [];
    const edges = moving ? graph.getEdges().map((e) => {
      const we = Object.create(e);
      we.getEndNodes = () => e.getEndNodes().map((x) => map.get(x) || x);
      return we;
    }) : [];
    const g = Object.create(graph);
    g.getPanorama = () => owner;
    g.getNodes = () => nodes;
    g.getEdges = () => edges;
    return g;
  }

  function sanitize(pano) {
    if (!pano || pano.__pg) return pano;
    const moving = settings.mode === 'moving';
    const w = Object.create(pano);
    w.__pg = true;
    w.__orig = pano;
    w.getMarkers = () => [];
    w.getConnectionMarkers = () => [];
    w.getName = () => '';
    const arrows = moving ? (pano.getConnectionArrows() || []).map((a) => wrapLink(a, w)) : [];
    w.getConnectionArrows = () => arrows;
    if (pano.getThoroughfares) {
      const th = moving ? (pano.getThoroughfares() || []).map((t) => wrapLink(t, w)) : [];
      w.getThoroughfares = () => th;
    }
    if (pano.getGraph) {
      let g;
      try { g = sanitizeGraph(pano.getGraph(), w, moving); } catch (e) { console.warn('graph', e); g = pano.getGraph(); }
      w.getGraph = () => g;
    }
    return w;
  }

  const KEY_ERROR = 'Яндекс не отдал панораму. Либо этот сайт не разрешён в настройках ключа (HTTP Referer), либо на сегодня кончился лимит запросов';

  // Бесплатный ключ — 100 запросов в сутки, а панорамы, по слухам, считаются дороже.
  // Поэтому каждое место ищем максимум за несколько запросов и ведём счётчик за день.
  const MAX_ATTEMPTS = 4;
  function pickPoint(used) {
    for (let i = 0; i < 200; i++) {
      const p = randomPoint();
      if (!used.some((u) => distance(u, p) < MIN_SPREAD)) return p;
    }
    return randomPoint();
  }

  async function findLocation(used) {
    let errors = 0;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const p = pickPoint(used);
      let panos;
      try {
        usage.add('locate');
        panos = await ymaps.panorama.locate(p, { layer: 'yandex#panorama' });
      } catch (e) {
        console.warn('locate error', e);
        if (++errors >= 2) {
          const err = new Error(KEY_ERROR);
          err.keyProblem = true;
          throw err;
        }
        continue;
      }
      if (!panos || !panos.length) continue;
      const pano = panos[0];
      const pos = pano.getPosition().slice(0, 2);
      if (!inPolygon(pos) || distance(p, pos) > 300) continue;
      return { pano, pos, name: safeName(pano) };
    }
    throw new Error('Не получилось найти панораму за несколько попыток, попробуй ещё раз');
  }

  // Счётчик обращений к панорамам за сегодня (только в этом браузере).
  const usage = (() => {
    const key = () => 'pg-usage-' + new Date().toISOString().slice(0, 10);
    const read = () => { try { return JSON.parse(localStorage.getItem(key())) || { locate: 0, move: 0 }; } catch { return { locate: 0, move: 0 }; } };
    return {
      read,
      add(kind) {
        const u = read();
        u[kind] = (u[kind] || 0) + 1;
        try { localStorage.setItem(key(), JSON.stringify(u)); } catch { /* ignore */ }
      },
    };
  })();
  function renderUsage() {
    const u = usage.read();
    $('#usage').textContent = (u.locate || u.move)
      ? `Сегодня с этого браузера: ${u.locate} панорам, ${u.move} шагов`
      : '';
  }
  function safeName(p) { try { return p.getName() || ''; } catch { return ''; } }

  function ensurePlayer(pano, direction) {
    const lock = settings.mode === 'nmpz';
    const options = {
      controls: lock ? [] : ['zoomControl'],
      suppressMapOpenBlock: true,
      hotkeysEnabled: !lock,
      scrollZoomBehavior: !lock,
      direction,
    };
    if (player) { player.destroy(); player = null; }
    player = new ymaps.panorama.Player('pano', pano, options);
    // Переход по стрелкам грузит «сырую» панораму — подменяем на очищенную.
    player.events.add('panoramachange', () => {
      const p = player.getPanorama();
      if (p && !p.__pg) {
        console.warn('raw panorama slipped through, re-wrapping');
        const dir = player.getDirection();
        player.setPanorama(sanitize(p));
        try { player.setDirection(dir); } catch { /* ignore */ }
      }
    });
    $('#panoLock').hidden = !lock;
    $('#returnBtn').hidden = settings.mode !== 'moving';
  }

  // ---------------- экраны ----------------
  function show(id) {
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  }

  function bestKey() {
    // старые рекорды (до выбора района и города) были по всей Пензе
    const city = settings.city === 'penza' ? '' : `${settings.city}-`;
    const area = settings.area === 'all' ? '' : `${settings.area}-`;
    return `pg-best-${city}${area}${settings.mode}-${settings.time}-${settings.rounds}`;
  }
  function readBest() { try { return +localStorage.getItem(bestKey()) || 0; } catch { return 0; } }
  function writeBest(v) { try { localStorage.setItem(bestKey(), String(v)); } catch { /* ignore */ } }
  function renderBest() {
    const b = readBest();
    $('#best').textContent = b ? `Рекорд с этими настройками: ${fmtNum(b)} из ${fmtNum(settings.rounds * MAX_SCORE)}` : '';
    renderUsage();
  }

  // ---------------- карта города из точек улиц ----------------
  // Каждая точка — кусок улицы из OSM. Жёлтым — где сейчас может выпасть место.
  const cityMap = (() => {
    const canvas = $('#cityCanvas');
    const ctx = canvas.getContext('2d');
    let proj = null;
    let shown = null;     // текущая яркость каждой точки 0..1
    let anim = 0;

    function layout() {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      const R = C.roads;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      const k = Math.cos(rad(C.geo.center[0]));
      for (let i = 0; i < C.count; i++) {
        const x = R[2 * i + 1] * k, y = -R[2 * i];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      const pad = 24 * dpr;
      const s = Math.min((canvas.width - 2 * pad) / (maxX - minX), (canvas.height - 2 * pad - 24 * dpr) / (maxY - minY));
      const ox = (canvas.width - (maxX - minX) * s) / 2;
      const oy = (canvas.height - 24 * dpr - (maxY - minY) * s) / 2;
      // чем плотнее улицы на экране, тем мельче точки
      const density = Math.sqrt((canvas.width * canvas.height) / Math.max(1, C.count));
      const unit = Math.max(1.6 * dpr, Math.min(2.2 * dpr, density / 6));
      proj = { k, s, ox, oy, minX, minY, unit, city: C };
    }

    function draw() {
      if (!proj || !shown || proj.city !== C || shown.length !== C.count) return;
      const { k, s, ox, oy, minX, minY, unit } = proj;
      const R = C.roads;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const dim = unit * 0.75, lit = unit;
      ctx.fillStyle = 'rgba(237, 237, 237, 0.16)';
      for (let i = 0; i < C.count; i++) {
        if (shown[i] >= 1) continue;
        const x = ox + (R[2 * i + 1] * k - minX) * s, y = oy + (-R[2 * i] - minY) * s;
        ctx.fillRect(x - dim / 2, y - dim / 2, dim, dim);
      }
      ctx.fillStyle = '#ffcc33';
      for (let i = 0; i < C.count; i++) {
        const a = shown[i];
        if (a <= 0) continue;
        ctx.globalAlpha = a;
        const x = ox + (R[2 * i + 1] * k - minX) * s, y = oy + (-R[2 * i] - minY) * s;
        ctx.fillRect(x - lit / 2, y - lit / 2, lit, lit);
      }
      ctx.globalAlpha = 1;
    }

    function update(animate = true) {
      const f = AREA_FILTERS[settings.area] || AREA_FILTERS.all;
      const target = new Float32Array(C.count);
      let n = 0;
      for (let i = 0; i < C.count; i++) if (!C.urban.length || f(C.urban[i] || 0)) { target[i] = 1; n++; }
      $('#cityCaption').textContent = `${C.name} · ${fmtNum(n)} из ${fmtNum(C.count)} точек улиц · OpenStreetMap`;
      cancelAnimationFrame(anim);
      if (!shown || !animate || shown.length !== C.count) { shown = target; draw(); return; }
      const from = shown.slice();
      const t0 = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - t0) / 360);
        const e = 1 - Math.pow(1 - t, 3);
        for (let i = 0; i < C.count; i++) shown[i] = from[i] + (target[i] - from[i]) * e;
        draw();
        if (t < 1) anim = requestAnimationFrame(step);
      };
      anim = requestAnimationFrame(step);
    }

    // смена города: новая раскладка и плавное появление
    function switchCity() {
      shown = null;
      layout();
      canvas.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      update(false);
    }

    new ResizeObserver(() => { layout(); draw(); }).observe(canvas);
    return { update, switchCity };
  })();

  // ---------------- меню ----------------
  $$('.seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
      const name = seg.dataset.name;
      const v = btn.dataset.value;
      settings[name] = (name === 'mode' || name === 'area' || name === 'city') ? v : +v;
      if (name === 'mode') $('#modeHint').textContent = MODE_HINTS[v];
      if (name === 'area') { $('#areaHint').textContent = AREA_HINTS[v](); cityMap.update(); }
      if (name === 'city') { applyCity(); cityMap.switchCity(); }
      renderBest();
    });
  });

  function applyCity() {
    C = CITIES[settings.city] || CITIES.penza;
    $('#title').innerHTML = `Где это ${C.inName}?`;
    $('[data-name=area] [data-value=all]').textContent = C.allName;
    $('#areaHint').textContent = AREA_HINTS[settings.area]();
    try { localStorage.setItem('pg-city', settings.city); } catch { /* ignore */ }
  }

  $('#startBtn').addEventListener('click', startGame);

  // ---------------- игра ----------------
  function startGame() {
    game = { rounds: [], index: -1, total: 0, used: [] };
    nextLocation = null;
    show('game');
    if (!guessMap) initGuessMap();
    nextRound();
  }

  function prefetch() {
    if (game.index + 1 >= settings.rounds) { nextLocation = null; return; }
    const used = game.used.slice();
    nextLocation = findLocation(used).then((loc) => { game.used.push(loc.pos); return loc; });
    nextLocation.catch(() => {});
  }

  async function nextRound() {
    const token = ++roundToken;
    game.index++;
    $('#hudRound').textContent = `${game.index + 1}/${settings.rounds}`;
    $('#hudScore').textContent = fmtNum(game.total);
    $('#loading').hidden = false;
    $('#guessBtn').disabled = true;
    $('#guessBtn').textContent = 'Поставь метку на карте';
    clearGuess();
    stopTimer();
    show('game');

    let loc;
    try {
      if (nextLocation) loc = await nextLocation;
      else { loc = await findLocation(game.used); game.used.push(loc.pos); }
    } catch (e) {
      if (token !== roundToken) return;
      console.error(e);
      $('#loading').hidden = true;
      show('menu');
      $('#menuError').textContent = e.message;
      if (e.keyProblem) $('#keyBox').hidden = false;
      return;
    }
    if (token !== roundToken) return;

    const round = { loc, guess: null, dist: null, score: 0, startDir: [Math.random() * 360, 0] };
    game.rounds.push(round);
    ensurePlayer(sanitize(loc.pano), round.startDir);
    guessMap.options.set('restrictMapArea', restrictFor(C));
    guessMap.setCenter(C.geo.center, 12);
    guessMap.container.fitToViewport();
    $('#loading').hidden = true;
    prefetch();
    startTimer();
  }

  const restrictFor = (c) => [[c.bbox[0][0] - 0.05, c.bbox[0][1] - 0.08], [c.bbox[1][0] + 0.05, c.bbox[1][1] + 0.08]];

  function initGuessMap() {
    guessMap = new ymaps.Map('guessMap', {
      center: C.geo.center, zoom: 12, controls: ['zoomControl'],
    }, {
      suppressMapOpenBlock: true,
      autoFitToViewport: 'always',
      restrictMapArea: restrictFor(C),
      minZoom: 11,
    });
    guessMap.events.add('click', (e) => setGuess(e.get('coords')));
    const box = $('#guessBox');
    const refit = () => setTimeout(() => guessMap.container.fitToViewport(), 200);
    $('#guessMap').addEventListener('transitionend', () => guessMap.container.fitToViewport());
    box.addEventListener('mouseenter', refit);
    box.addEventListener('mouseleave', refit);
    box.addEventListener('touchstart', () => { box.classList.add('touched'); refit(); }, { passive: true });
    $('#pano').addEventListener('touchstart', () => { box.classList.remove('touched'); refit(); }, { passive: true });
    let size = 0;
    $$('.guess-size [data-size]').forEach((b) => b.addEventListener('click', () => {
      size = Math.max(-1, Math.min(2, size + +b.dataset.size));
      box.style.setProperty('--wx', `${560 + size * 180}px`);
      box.style.setProperty('--hx', `${400 + size * 130}px`);
      refit();
    }));
    $('#pinBtn').addEventListener('click', () => {
      box.classList.toggle('pinned');
      $('#pinBtn').classList.toggle('on', box.classList.contains('pinned'));
      refit();
    });
  }

  function setGuess(coords) {
    const round = game && game.rounds[game.index];
    if (!round || round.done) return;
    round.guess = coords;
    if (!guessMark) {
      guessMark = new ymaps.Placemark(coords, {}, { preset: 'islands#blueCircleDotIcon', draggable: true });
      guessMark.events.add('dragend', () => {
        const r = game.rounds[game.index];
        if (r && !r.done) r.guess = guessMark.geometry.getCoordinates();
      });
      guessMap.geoObjects.add(guessMark);
    } else {
      guessMark.geometry.setCoordinates(coords);
    }
    $('#guessBtn').disabled = false;
    $('#guessBtn').textContent = 'Угадать';
  }

  function clearGuess() {
    if (guessMark && guessMap) guessMap.geoObjects.remove(guessMark);
    guessMark = null;
  }

  function startTimer() {
    if (!settings.time) { $('#hudTimerBox').hidden = true; return; }
    const round = game.rounds[game.index];
    let left = settings.time;
    const box = $('#hudTimerBox');
    box.hidden = false;
    box.classList.remove('warn');
    $('#hudTimer').textContent = fmtTime(left);
    timerId = setInterval(() => {
      left--;
      $('#hudTimer').textContent = fmtTime(Math.max(0, left));
      box.classList.toggle('warn', left <= 10);
      if (left <= 0) { stopTimer(); if (!round.done) makeGuess(); }
    }, 1000);
  }
  function stopTimer() { if (timerId) clearInterval(timerId); timerId = null; }

  function makeGuess() {
    const round = game.rounds[game.index];
    if (!round || round.done) return;
    round.done = true;
    stopTimer();
    round.dist = round.guess ? distance(round.guess, round.loc.pos) : null;
    round.score = scoreFor(round.dist);
    game.total += round.score;
    showRoundResult(round);
  }

  $('#guessBtn').addEventListener('click', makeGuess);
  $('#returnBtn').addEventListener('click', () => {
    const r = game && game.rounds[game.index];
    if (r && player) ensurePlayer(sanitize(r.loc.pano), r.startDir);
  });
  $('#quitBtn').addEventListener('click', () => {
    if (!confirm('Выйти в меню? Прогресс игры пропадёт.')) return;
    roundToken++;
    stopTimer();
    if (player) { player.destroy(); player = null; }
    show('menu');
    renderBest();
  });

  // ---------------- результаты ----------------
  function ensureResultMap() {
    if (resultMap) { resultMap.geoObjects.removeAll(); return; }
    resultMap = new ymaps.Map('resultMap', {
      center: C.geo.center, zoom: 12, controls: [],
    }, { suppressMapOpenBlock: true, autoFitToViewport: 'always' });
    // слева лежит билет — зум справа
    resultMap.controls.add('zoomControl', { size: 'small', position: { right: 16, top: 96 } });
  }

  function drawPair(round, n) {
    const actual = new ymaps.Placemark(round.loc.pos, {
      iconContent: n != null ? String(n) : '',
      hintContent: round.loc.name || 'Правильное место',
    }, { preset: n != null ? 'islands#redIcon' : 'islands#redDotIcon' });
    resultMap.geoObjects.add(actual);
    const pts = [round.loc.pos];
    if (round.guess) {
      resultMap.geoObjects.add(new ymaps.Placemark(round.guess, { hintContent: 'Твоя метка' }, { preset: 'islands#blackCircleDotIcon' }));
      resultMap.geoObjects.add(new ymaps.Polyline([round.guess, round.loc.pos], {}, {
        strokeColor: '#1f1b16', strokeWidth: 3, strokeStyle: 'dash', strokeOpacity: 0.85,
      }));
      pts.push(round.guess);
    }
    return pts;
  }

  const isNarrow = () => window.matchMedia('(max-width: 700px)').matches;

  function fitTo(points) {
    show('result'); // карта должна быть видимой, чтобы правильно посчитать размеры
    resultMap.container.fitToViewport();
    // слева на десктопе лежит билет — не прячем под него метки
    const margin = isNarrow() ? 40 : [64, 64, 64, 444];
    if (points.length === 1) {
      // одна точка (метки не было) — сдвигаем центр так, чтобы флаг был правее билета
      const p = points[0];
      resultMap.setCenter(isNarrow() ? p : [p[0], p[1] - 0.006], 15);
      return;
    }
    const la = points.map((p) => p[0]), lo = points.map((p) => p[1]);
    resultMap.setBounds([[Math.min(...la), Math.min(...lo)], [Math.max(...la), Math.max(...lo)]], {
      checkZoomRange: true, zoomMargin: margin,
    }).then(() => { if (resultMap.getZoom() > 17) resultMap.setZoom(17); });
  }

  // Номер билета — промах в метрах. Счастливый, если суммы первых и последних трёх цифр равны.
  function ticketNumber(dist) {
    const n = dist == null ? Math.floor(Math.random() * 1e6) : Math.min(999999, Math.round(dist));
    const s = String(n).padStart(6, '0');
    const sum = (t) => [...t].reduce((a, c) => a + +c, 0);
    return { text: s, lucky: sum(s.slice(0, 3)) === sum(s.slice(3)) };
  }

  function fillBar(share) {
    const bar = $('#tkBar');
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(0)';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bar.style.transition = '';
      bar.style.transform = `scaleX(${share})`;
    }));
  }

  function restartTicket() {
    const t = $('#ticket');
    t.style.animation = 'none';
    void t.offsetWidth;
    t.style.animation = '';
  }

  function stamp(text) {
    const el = $('#tkStamp');
    el.textContent = text || '';
    el.hidden = !text;
  }

  // Число очков «прокручивается» до итога
  function countUp(el, to, suffix = '') {
    const t0 = performance.now();
    const dur = 700;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      el.innerHTML = fmtNum(Math.round(to * e)) + suffix;
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function showRoundResult(round) {
    if (player) { player.destroy(); player = null; }
    ensureResultMap();
    const pts = drawPair(round);
    const last = game.index + 1 >= settings.rounds;
    const no = ticketNumber(round.dist);
    restartTicket();
    $('#tkRoute').textContent = `${C.name} · раунд ${game.index + 1} из ${settings.rounds}`;
    $('#tkNumber').textContent = `Билет ${no.text}`;
    $('#tkLabel').textContent = 'Очки за раунд';
    countUp($('#tkScore'), round.score, '<small>/ 5000</small>');
    $('#tkLine').textContent = round.guess ? `Мимо на ${fmtDist(round.dist)}` : 'Время вышло, метки нет';
    $('#tkPlace').textContent = round.loc.name ? `Это было: ${round.loc.name}` : '';
    $('#tkRows').innerHTML = '';
    $('#tkTotal').textContent = `Всего ${fmtNum(game.total)}`;
    stamp(round.score === MAX_SCORE ? 'В точку' : no.lucky && round.guess ? 'Счастливый билет' : '');
    $('#nextLabel').textContent = last ? 'Итоги игры' : 'Следующий раунд';
    $('#menuBtn').hidden = true;
    fillBar(round.score / MAX_SCORE);
    fitTo(pts);
  }

  function showFinal() {
    ensureResultMap();
    let pts = [];
    game.rounds.forEach((r, i) => { pts = pts.concat(drawPair(r, i + 1)); });
    const max = settings.rounds * MAX_SCORE;
    const best = readBest();
    const isRecord = game.total > best;
    if (isRecord) writeBest(game.total);
    const areaName = { city: 'город', all: C.allName.toLowerCase(), private: 'частный сектор' }[settings.area];
    restartTicket();
    $('#tkRoute').textContent = `${C.name} · ${areaName} · итог`;
    $('#tkNumber').textContent = `Билет ${String(game.total).padStart(6, "0")}`;
    $('#tkLabel').textContent = `Очки за ${settings.rounds} раундов`;
    countUp($('#tkScore'), game.total, `<small>/ ${fmtNum(max)}</small>`);
    $('#tkLine').textContent = '';
    $('#tkPlace').textContent = '';
    $('#tkRows').innerHTML = game.rounds.map((r, i) =>
      `<div class="row"><span>Раунд ${i + 1}</span><span>${r.guess ? fmtDist(r.dist) : 'без метки'}</span><span>${fmtNum(r.score)}</span></div>`
    ).join('');
    $('#tkTotal').textContent = isRecord ? '' : best ? `Рекорд ${fmtNum(best)}` : '';
    stamp(isRecord ? 'Новый рекорд' : '');
    $('#nextLabel').textContent = 'Сыграть ещё';
    $('#menuBtn').hidden = false;
    game.finished = true;
    fillBar(game.total / max);
    fitTo(pts);
  }

  $('#nextBtn').addEventListener('click', () => {
    if (!game) return;
    if (game.finished) return startGame();
    if (game.index + 1 >= settings.rounds) return showFinal();
    nextRound();
  });
  $('#menuBtn').addEventListener('click', () => { show('menu'); renderBest(); });

  // ---------------- клавиатура ----------------
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    const active = document.querySelector('.screen.active').id;
    if ((e.code === 'Space' || e.code === 'Enter') && active === 'game') {
      const r = game && game.rounds[game.index];
      if (r && r.guess && !r.done) { e.preventDefault(); makeGuess(); }
    } else if ((e.code === 'Space' || e.code === 'Enter') && active === 'result') {
      e.preventDefault(); $('#nextBtn').click();
    } else if (e.code === 'KeyR' && active === 'game' && settings.mode === 'moving') {
      $('#returnBtn').click();
    }
  });

  // ---------------- ключ API ----------------
  $('#keyInput').value = API_KEY;
  if (!API_KEY) $('#keyBox').hidden = false;
  $('#keySave').addEventListener('click', () => {
    const v = $('#keyInput').value.trim();
    try { v ? localStorage.setItem('pg-apikey', v) : localStorage.removeItem('pg-apikey'); } catch { /* ignore */ }
    location.reload();
  });

  // ---------------- старт ----------------
  renderBest();
  try {
    const saved = localStorage.getItem('pg-city');
    if (saved && CITIES[saved]) {
      settings.city = saved;
      $$('[data-name=city] button').forEach((b) => b.classList.toggle('on', b.dataset.value === saved));
    }
  } catch { /* ignore */ }
  applyCity();
  $('#modeHint').textContent = MODE_HINTS[settings.mode];
  cityMap.update(false);
  loadYmaps().then(() => {
    if (!ymaps.panorama.isSupported()) throw new Error('Браузер не поддерживает панорамы Яндекса.');
    $('#startBtn').disabled = false;
    $('#startBtn').textContent = 'Играть';
  }).catch((e) => {
    $('#startBtn').textContent = 'Ошибка';
    $('#menuError').textContent = e.message || String(e);
  });

  // для отладки из консоли
  window.__pg = { usage, scoreFor, CITIES, get city() { return C; }, distance, inPolygon, get player() { return player; }, get game() { return game; } };
})();
