(() => {
  'use strict';

  const CFG = window.PG_CONFIG || {};
  const PENZA = window.PENZA;
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
  function inPolygon(p, poly = PENZA.polygon) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if ((yi > p[0]) !== (yj > p[0]) && p[1] < (xj - xi) * (p[0] - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const lats = PENZA.polygon.map((p) => p[0]);
  const lons = PENZA.polygon.map((p) => p[1]);
  const BBOX = [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]];
  // «Размер карты» как в GeoGuessr — диагональ прямоугольника, в который вписана карта.
  const MAP_SIZE = distance(BBOX[0], BBOX[1]);

  // Точки на дорогах (js/roads.js) — панорама рядом находится почти всегда с первого запроса.
  // PENZA_URBAN — сколько многоэтажек рядом с точкой; по нему делим на «город» и «частный сектор».
  const ROADS = window.PENZA_ROADS || [];
  const URBAN = window.PENZA_URBAN || [];
  const ROAD_COUNT = Math.floor(ROADS.length / 2);
  const CITY_MIN = 3;
  const AREA_FILTERS = {
    all: () => true,
    city: (i) => (URBAN[i] || 0) >= CITY_MIN,
    private: (i) => (URBAN[i] || 0) === 0,
  };
  const areaPools = {};
  function areaPool() {
    const area = AREA_FILTERS[settings.area] ? settings.area : 'all';
    if (!areaPools[area]) {
      const f = AREA_FILTERS[area];
      areaPools[area] = [];
      for (let i = 0; i < ROAD_COUNT; i++) if (!URBAN.length || f(i)) areaPools[area].push(i);
    }
    return areaPools[area];
  }
  function randomPoint() {
    const pool = ROAD_COUNT ? areaPool() : [];
    if (pool.length) {
      const i = pool[Math.floor(Math.random() * pool.length)] * 2;
      return [ROADS[i], ROADS[i + 1]];
    }
    for (;;) {
      const p = [
        BBOX[0][0] + Math.random() * (BBOX[1][0] - BBOX[0][0]),
        BBOX[0][1] + Math.random() * (BBOX[1][1] - BBOX[0][1]),
      ];
      if (inPolygon(p)) return p;
    }
  }

  // Формула GeoGuessr: 5000 · e^(−10 · d / размер карты), в радиусе 25 м — 5000.
  function scoreFor(d) {
    if (d == null) return 0;
    if (d <= PERFECT_RADIUS) return MAX_SCORE;
    return Math.round(MAX_SCORE * Math.exp(-10 * d / MAP_SIZE));
  }

  function fmtDist(m) {
    if (m == null) return '—';
    if (m < 1000) return `${Math.round(m)} м`;
    return `${(m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',')} км`;
  }
  const fmtNum = (n) => n.toLocaleString('ru-RU');
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // ---------------- состояние ----------------
  const settings = { area: 'city', mode: 'moving', time: 0, rounds: 5 };
  const AREA_HINTS = {
    city: 'Многоэтажки, центр, Арбеково, Терновка — без деревень и частного сектора.',
    all: 'Любая улица города, включая частный сектор, окраины и объездную.',
    private: 'Только частный сектор и бывшие деревни — для хардкора.',
  };
  const MODE_HINTS = {
    moving: 'Ходи по панорамам, крути камеру, приближай.',
    nomove: 'Стоишь на месте, но можно крутить камеру и приближать.',
    nmpz: 'No Move, No Pan, No Zoom — только один кадр.',
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
  const API_KEY = (CFG.apiKey || storedKey()).trim();

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

  const KEY_ERROR = 'Яндекс не отдаёт панорамы без API-ключа.\nВставь ключ ниже (бесплатный, «JavaScript API и HTTP Геокодер»).';

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
    throw new Error('Не получилось найти панораму за несколько попыток. Попробуй ещё раз.');
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
      ? `Сегодня: ${u.locate} поисков панорам, ${u.move} переходов. Расход смотри в кабинете Яндекса → Статистика.`
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
    // старые рекорды (до выбора района) были по всей Пензе
    const area = settings.area === 'all' ? '' : `${settings.area}-`;
    return `pg-best-${area}${settings.mode}-${settings.time}-${settings.rounds}`;
  }
  function readBest() { try { return +localStorage.getItem(bestKey()) || 0; } catch { return 0; } }
  function writeBest(v) { try { localStorage.setItem(bestKey(), String(v)); } catch { /* ignore */ } }
  function renderBest() {
    const b = readBest();
    $('#best').textContent = b ? `Рекорд с этими настройками: ${fmtNum(b)} из ${fmtNum(settings.rounds * MAX_SCORE)}` : '';
    renderUsage();
  }

  // ---------------- меню ----------------
  $$('.seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
      const name = seg.dataset.name;
      const v = btn.dataset.value;
      settings[name] = (name === 'mode' || name === 'area') ? v : +v;
      if (name === 'mode') $('#modeHint').textContent = MODE_HINTS[v];
      if (name === 'area') $('#areaHint').textContent = AREA_HINTS[v];
      renderBest();
    });
  });

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
    $('#hudRound').textContent = `${game.index + 1} / ${settings.rounds}`;
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
    guessMap.setCenter(PENZA.center, 12);
    guessMap.container.fitToViewport();
    $('#loading').hidden = true;
    prefetch();
    startTimer();
  }

  function initGuessMap() {
    guessMap = new ymaps.Map('guessMap', {
      center: PENZA.center, zoom: 12, controls: ['zoomControl'],
    }, {
      suppressMapOpenBlock: true,
      autoFitToViewport: 'always',
      restrictMapArea: [[BBOX[0][0] - 0.05, BBOX[0][1] - 0.08], [BBOX[1][0] + 0.05, BBOX[1][1] + 0.08]],
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
      center: PENZA.center, zoom: 12, controls: ['zoomControl'],
    }, { suppressMapOpenBlock: true, autoFitToViewport: 'always' });
  }

  function drawPair(round, n) {
    const actual = new ymaps.Placemark(round.loc.pos, {
      iconContent: n != null ? String(n) : '',
      hintContent: round.loc.name || 'Правильное место',
    }, { preset: n != null ? 'islands#redIcon' : 'islands#redDotIcon' });
    resultMap.geoObjects.add(actual);
    const pts = [round.loc.pos];
    if (round.guess) {
      resultMap.geoObjects.add(new ymaps.Placemark(round.guess, { hintContent: 'Твоя метка' }, { preset: 'islands#blueCircleDotIcon' }));
      resultMap.geoObjects.add(new ymaps.Polyline([round.guess, round.loc.pos], {}, {
        strokeColor: '#1d2733', strokeWidth: 3, strokeStyle: 'dash', strokeOpacity: 0.8,
      }));
      pts.push(round.guess);
    }
    return pts;
  }

  function fitTo(points) {
    show('result'); // карта должна быть видимой, чтобы правильно посчитать размеры
    resultMap.container.fitToViewport();
    if (points.length === 1) { resultMap.setCenter(points[0], 15); return; }
    const la = points.map((p) => p[0]), lo = points.map((p) => p[1]);
    resultMap.setBounds([[Math.min(...la), Math.min(...lo)], [Math.max(...la), Math.max(...lo)]], {
      checkZoomRange: true, zoomMargin: 80,
    }).then(() => { if (resultMap.getZoom() > 17) resultMap.setZoom(17); });
  }

  function animateBar(score, max) {
    const bar = $('#resultBar');
    bar.style.transition = 'none';
    bar.style.width = '0';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bar.style.transition = '';
      bar.style.width = `${(score / max) * 100}%`;
    }));
  }

  function showRoundResult(round) {
    if (player) { player.destroy(); player = null; }
    ensureResultMap();
    const pts = drawPair(round);
    const last = game.index + 1 >= settings.rounds;
    $('#resultRound').textContent = `Раунд ${game.index + 1} из ${settings.rounds}`;
    $('#resultMain').innerHTML = round.guess
      ? `<em>${fmtNum(round.score)}</em> очков · мимо на ${fmtDist(round.dist)}`
      : `Время вышло — <em>0</em> очков`;
    $('#resultSub').textContent = (round.loc.name ? `Это было: ${round.loc.name}. ` : '') + `Всего: ${fmtNum(game.total)}`;
    $('#resultTable').innerHTML = '';
    $('#nextBtn').textContent = last ? 'Итоги игры' : 'Следующий раунд';
    $('#menuBtn').hidden = true;
    animateBar(round.score, MAX_SCORE);
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
    $('#resultRound').textContent = 'Игра окончена';
    $('#resultMain').innerHTML = `<em>${fmtNum(game.total)}</em> из ${fmtNum(max)}`;
    $('#resultSub').textContent = isRecord ? 'Новый рекорд!' : best ? `Рекорд: ${fmtNum(best)}` : '';
    $('#resultTable').innerHTML = game.rounds.map((r, i) =>
      `<div class="row"><span>Раунд ${i + 1}</span><span>${r.guess ? fmtDist(r.dist) : 'не угадал'}</span><span>${fmtNum(r.score)}</span></div>`
    ).join('');
    $('#nextBtn').textContent = 'Сыграть ещё';
    $('#menuBtn').hidden = false;
    game.finished = true;
    animateBar(game.total, max);
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
  loadYmaps().then(() => {
    if (!ymaps.panorama.isSupported()) throw new Error('Браузер не поддерживает панорамы Яндекса.');
    $('#startBtn').disabled = false;
    $('#startBtn').textContent = 'Играть';
  }).catch((e) => {
    $('#startBtn').textContent = 'Ошибка';
    $('#menuError').textContent = e.message || String(e);
  });

  // для отладки из консоли
  window.__pg = { usage, scoreFor, MAP_SIZE, distance, inPolygon, get player() { return player; }, get game() { return game; } };
})();
