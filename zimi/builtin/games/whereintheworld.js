/* ZimiGames: Where in the World. A name appears; tap where it is on a map of the world, pinch or use the buttons
   to look closer, and the closer you are the more points. The places are shipped in whereintheworld-data.js
   and drawn on the land outline in world-land.js, so it is the same in Kiwix, from a folder, or in Zimi. Inside
   Zimi it can also ask about the places of the player's own offline maps (a StreetZim map in the library), and
   after each answer shows the first lines of the place's article from the player's Wikipedia. Our own code, GPL-3.0.
   The rules (pure functions, no DOM, so node can test them) and the page (only when there is a document). */
(function (root) {
  'use strict';
  var Lib = root.GamesLib;

  // ── the rules ────────────────────────────────────────────────────────────
  var MAP_W = 800, MAP_H = 400;           // the land outline's grid, equirectangular
  var ROUND = 10, MAX_POINTS = 100, SCALE_KM = 1500;   // points = 100 * exp(-distance / 1500 km)
  var EARTH_KM = 6371, MIN_VIEW_W = 24;

  function project(lat, lon) { return { x: (lon + 180) * MAP_W / 360, y: (90 - lat) * MAP_H / 180 }; }
  function unproject(x, y) { return { lat: 90 - y * 180 / MAP_H, lon: x * 360 / MAP_W - 180 }; }

  // Great-circle distance in kilometres.
  function haversine(a, b) {
    var rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function points(km) { return Math.round(MAX_POINTS * Math.exp(-km / SCALE_KM)); }

  // A view of the map: {x, y, w, h} in grid units, with the aspect of the screen. Zoom about a point of the view
  // (its fraction fx, fy across), keeping that point where it is; and never lose the world off the screen.
  function clampView(v) {
    var w = Math.min(Math.max(v.w, MIN_VIEW_W), MAP_W), h = w * v.h / v.w;
    var cx = Math.min(Math.max(v.x + v.w / 2, 0), MAP_W), cy = Math.min(Math.max(v.y + v.h / 2, 0), MAP_H);
    return { x: cx - w / 2, y: cy - h / 2, w: w, h: h };
  }
  function zoomView(v, factor, fx, fy) {
    var w = v.w / factor, h = v.h / factor, px = v.x + v.w * fx, py = v.y + v.h * fy;
    return clampView({ x: px - w * fx, y: py - h * fy, w: w, h: h });
  }
  function panView(v, dx, dy) { return clampView({ x: v.x + dx, y: v.y + dy, w: v.w, h: v.h }); }
  // A view that holds both points with room around them, in the screen's aspect.
  function fitView(a, b, aspect, pad) {
    var pa = project(a.lat, a.lon), pb = project(b.lat, b.lon);
    var cx = (pa.x + pb.x) / 2, cy = (pa.y + pb.y) / 2;
    var w = Math.max(Math.abs(pa.x - pb.x) * (1 + pad), Math.abs(pa.y - pb.y) * (1 + pad) * aspect, 60);
    return clampView({ x: cx - w / 2, y: cy - w / aspect / 2, w: w, h: w / aspect });
  }
  function wholeWorld(aspect) { return clampView({ x: 0, y: MAP_H / 2 - MAP_W / aspect / 2, w: MAP_W, h: MAP_W / aspect }); }

  // A place of a StreetZim map as /random answers it: {title, pos: "map=14/48.8567/2.3508"}.
  function placeFromMap(r) {
    var m = /map=[\d.]+\/(-?[\d.]+)\/(-?[\d.]+)/.exec((r && r.pos) || '');
    if (!m || !r.title) return null;
    var lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    return isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { name: r.title, lat: lat, lon: lon, kind: 'place on your map' } : null;
  }

  function roundFrom(list, n, rng) {
    return Lib.sample(list, n, rng).map(function (p) { return { name: p[0], lat: p[1], lon: p[2], kind: p[3] }; });
  }

  function verdict(total, max) {
    var r = max ? total / max : 0;
    return r >= 0.9 ? 'navigator' : r >= 0.7 ? 'veryGood' : r >= 0.45 ? 'good' : 'keepGoing';
  }

  var Engine = { project: project, unproject: unproject, haversine: haversine, points: points, clampView: clampView, zoomView: zoomView, panView: panView, fitView: fitView,
    wholeWorld: wholeWorld, placeFromMap: placeFromMap, roundFrom: roundFrom, verdict: verdict, ROUND: ROUND, MAX_POINTS: MAX_POINTS, MAP_W: MAP_W, MAP_H: MAP_H };
  root.WorldQuizEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T, NS = 'http://www.w3.org/2000/svg';
  Play.applyTheme();
  var BEST_KEY = 'zimi.games.whereintheworld.best';
  var ZOOM_STEP = 1.8, WHEEL_STEP = 1.15, KEY_PAN = 0.08, TAP_PX = 8, PIN_PX = 7, MAP_BATCH = 4;
  var els = { frame: $('wm-frame'), svg: $('wm-svg'), ask: $('wm-ask'), kind: $('wm-kind'), msg: $('wm-msg'), info: $('wm-info'), mapLink: $('wm-map'), n: $('wm-n'), score: $('wm-score'),
    guess: $('wm-guess'), next: $('wm-next'), zin: $('wm-zin'), zout: $('wm-zout'), newBtn: $('wm-new') };
  var status = Play.status(els.msg), pendingMaps = null, finished = false;
  var view = wholeWorld(2), round = [], at = 0, total = 0, pending = null, answered = false;
  var wikiZim = null, libList = [], mapZims = [], useMaps = false, layers = {}, busy = false;

  function svgEl(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(e);
    return e;
  }
  function buildMap() {
    els.svg.innerHTML = '';
    svgEl('rect', { x: -MAP_W * 2, y: -MAP_H * 2, width: MAP_W * 5, height: MAP_H * 5, class: 'wm-sea' }, els.svg);
    var grid = svgEl('g', { class: 'wm-grid' }, els.svg), i;
    for (i = -150; i <= 150; i += 30) { var gx = project(0, i).x; svgEl('line', { x1: gx, y1: 0, x2: gx, y2: MAP_H }, grid); }
    for (i = -60; i <= 60; i += 30) { var gy = project(i, 0).y; svgEl('line', { x1: 0, y1: gy, x2: MAP_W, y2: gy }, grid); }
    svgEl('path', { d: root.WORLD_LAND_D, class: 'wm-land' }, els.svg);
    layers.marks = svgEl('g', {}, els.svg);
  }
  // The map's shape on this screen (the style sheet gives a phone a squarer one).
  function aspect() { return els.svg.clientWidth && els.svg.clientHeight ? els.svg.clientWidth / els.svg.clientHeight : 1.6; }
  function applyView() {
    els.svg.setAttribute('viewBox', view.x + ' ' + view.y + ' ' + view.w + ' ' + view.h);
    paintMarks();
  }
  // One screen pixel in grid units: the pins keep their size however far in the map is.
  function px() { return view.w / els.svg.clientWidth; }

  function mark(lat, lon, cls) {
    var p = project(lat, lon), u = px();
    svgEl('circle', { cx: p.x, cy: p.y, r: PIN_PX * u, class: 'wm-pin ' + cls, 'stroke-width': 2 * u }, layers.marks);
  }
  function paintMarks() {
    if (!layers.marks) return;
    layers.marks.innerHTML = '';
    var u = px();
    if (answered && pending) {
      var t = round[at], a = project(pending.lat, pending.lon), b = project(t.lat, t.lon);
      svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'wm-line', 'stroke-width': 2 * u, 'stroke-dasharray': (6 * u) + ' ' + (5 * u) }, layers.marks);
      mark(t.lat, t.lon, 'target');
    }
    if (pending) mark(pending.lat, pending.lon, 'guess');
  }

  // ── a round ──
  function paintTop() {
    Lib.englishNote(T, 'lang.enPlaces', !!round.length && !round[0].zim && round[0].kind !== 'place on your map');
    els.n.textContent = round.length ? T('world.place', { n: at + 1, total: round.length }) : '';
    els.score.textContent = T('world.points', { n: total });
  }
  function ask() {
    var q = round[at]; pending = null; answered = false;
    els.ask.textContent = q.name; els.ask.dir = 'auto'; els.kind.textContent = T('world.kind.' + q.kind.replace(/ /g, '_'));
    els.guess.hidden = false; els.guess.disabled = true; els.next.hidden = true; els.mapLink.hidden = true;
    status.say(T('world.tap')); els.info.textContent = ''; els.info.hidden = true;
    view = wholeWorld(aspect()); applyView(); paintTop();
  }
  function setPending(p) { if (answered) return; pending = p; els.guess.disabled = false; status.say(T('world.move')); paintMarks(); }

  function confirmGuess() {
    if (answered || !pending) return;
    var q = round[at], km = haversine(pending, q), pts = points(km);
    answered = true; total += pts;
    status.say(T('world.away', { km: Math.round(km), n: pts }));
    els.guess.hidden = true; els.next.hidden = false; els.next.textContent = T(at + 1 >= round.length ? 'world.seeScore' : 'world.next');
    view = fitView(pending, q, view.w / view.h, 0.6); applyView(); paintTop();
    els.next.focus();
    about(q); mapLink(q);
  }
  // Inside Zimi, the place on the StreetZim map that holds it (the map it came from, else one whose box has it): the whole map, in the reader.
  function mapLink(q) {
    els.mapLink.hidden = true;
    var m = Lib.hosted() && Lib.mapFor(libList, q.lat, q.lon, q.zim);
    if (!m) return;
    Lib.articleLink(els.mapLink, m.zim, m.path); els.mapLink.textContent = T('learn.map', { place: q.name }); els.mapLink.hidden = false;
  }
  // From the player's Wikipedia: the first lines about this place, and a link to the article. Asked once, after the answer.
  function about(q) {
    if (!wikiZim) return;
    var ask = at;
    Lib.json('/search?q=' + encodeURIComponent(q.name) + '&zim=' + encodeURIComponent(wikiZim) + '&limit=1').then(function (r) {
      var hit = r && r.results && r.results[0];
      if (!hit || ask !== at) return;
      return Lib.json('/snippet?zim=' + encodeURIComponent(wikiZim) + '&path=' + encodeURIComponent(hit.path)).then(function (s) {
        if (ask !== at) return;
        els.info.innerHTML = '';
        var a = Lib.articleLink(document.createElement('a'), wikiZim, hit.path); a.textContent = hit.title;
        els.info.appendChild(a);
        els.info.appendChild(document.createTextNode(s && s.snippet ? T('world.snippet', { snippet: s.snippet }) : ''));
        els.info.hidden = false;
      });
    }).catch(function () { /* the article is a bonus */ });
  }
  function advance() {
    if (!answered) return;
    if (at + 1 >= round.length) return finish();
    at++; ask();
  }
  function finish() {
    var key = useMaps ? 'maps' : 'places', best = Play.load(BEST_KEY, {}), max = round.length * MAX_POINTS, mine = best[key] || 0;
    if (total > mine) { best[key] = total; Play.save(BEST_KEY, best); }
    finished = true;
    status.say(T('world.verdict.' + verdict(total, max)));
    ZimiShell.endSheet({ result: 'over', text: T('world.verdict.' + verdict(total, max)), stats: [[T('world.score'), T('world.of', { n: total, max: max })], [T('play.best'), Play.num(Math.max(total, mine))]] });
  }

  // Ten places drawn from the player's maps, four asked at a time.
  function drawMapPlaces(n) {
    var out = [], seen = {}, asked = 0, failed = 0;
    function lane() {
      if (out.length >= n || asked >= n * 3 || failed > 5) return Promise.resolve();
      asked++;
      var zim = mapZims[Math.floor(Math.random() * mapZims.length)];
      return Lib.json('/random?zim=' + encodeURIComponent(zim)).then(function (r) {
        var p = placeFromMap(r);
        if (p && !seen[p.name] && out.length < n) { seen[p.name] = true; p.zim = zim; out.push(p); }
      }, function () { failed++; }).then(lane);
    }
    var lanes = []; for (var i = 0; i < MAP_BATCH; i++) lanes.push(lane());
    return Promise.all(lanes).then(function () { return out; });
  }

  function newRound() {
    if (busy) return; busy = true; total = 0; at = 0; finished = false;
    if (pendingMaps !== null) { useMaps = pendingMaps && !!mapZims.length; pendingMaps = null; }
    var work = useMaps ? drawMapPlaces(ROUND) : Promise.resolve(roundFrom(root.WORLD_PLACES, ROUND, Math.random));
    status.say(useMaps ? T('world.choosing') : '');
    work.then(function (list) {
      busy = false;
      var short = list.length < 3;
      if (short) { useMaps = false; list = roundFrom(root.WORLD_PLACES, ROUND, Math.random); }
      round = list; ask();
      if (short) status.reason(T('world.builtIn'), 4000);
    });
  }
  // ── looking around: drag to move, pinch or buttons or wheel to zoom, arrows and + - from the keyboard ──
  var pointers = {}, gesture = null;
  function frac(e) { var r = els.svg.getBoundingClientRect(); return { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height }; }
  function pinchDistance() { var k = Object.keys(pointers); return k.length === 2 ? Math.hypot(pointers[k[0]].x - pointers[k[1]].x, pointers[k[0]].y - pointers[k[1]].y) : 0; }
  els.svg.addEventListener('pointerdown', function (e) {
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    try { els.svg.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
    var n = Object.keys(pointers).length;
    gesture = n === 1 ? { x: e.clientX, y: e.clientY, moved: false } : { pinch: pinchDistance(), moved: true };
  });
  els.svg.addEventListener('pointermove', function (e) {
    if (!pointers[e.pointerId] || !gesture) return;
    var prev = pointers[e.pointerId]; pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var r = els.svg.getBoundingClientRect(), n = Object.keys(pointers).length;
    if (n === 2) {
      var d = pinchDistance();
      if (gesture.pinch && d) { var k = Object.keys(pointers), cx = (pointers[k[0]].x + pointers[k[1]].x) / 2, cy = (pointers[k[0]].y + pointers[k[1]].y) / 2; view = zoomView(view, d / gesture.pinch, (cx - r.left) / r.width, (cy - r.top) / r.height); applyView(); }
      gesture.pinch = d; return;
    }
    if (!gesture.moved && Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) < TAP_PX) return;
    gesture.moved = true;
    view = panView(view, -(e.clientX - prev.x) / r.width * view.w, -(e.clientY - prev.y) / r.height * view.h); applyView();
  });
  function release(e) {
    if (!pointers[e.pointerId]) return;
    var wasTap = gesture && !gesture.moved && Object.keys(pointers).length === 1 && e.type === 'pointerup';
    delete pointers[e.pointerId];
    if (!Object.keys(pointers).length) gesture = null;
    if (wasTap) { var f = frac(e), g = unproject(view.x + view.w * f.fx, view.y + view.h * f.fy); setPending({ lat: Math.max(-90, Math.min(90, g.lat)), lon: Math.max(-180, Math.min(180, g.lon)) }); }
  }
  els.svg.addEventListener('pointerup', release);
  els.svg.addEventListener('pointercancel', release);
  els.svg.addEventListener('wheel', function (e) { e.preventDefault(); var f = frac(e); view = zoomView(view, e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, f.fx, f.fy); applyView(); }, { passive: false });
  function zoomBy(f) { view = zoomView(view, f, 0.5, 0.5); applyView(); }
  els.zin.addEventListener('click', function () { zoomBy(ZOOM_STEP); });
  els.zout.addEventListener('click', function () { zoomBy(1 / ZOOM_STEP); });
  els.frame.addEventListener('keydown', function (e) {
    var k = e.key, step = view.w * KEY_PAN;
    if (k === '+' || k === '=') zoomBy(ZOOM_STEP);
    else if (k === '-' || k === '_') zoomBy(1 / ZOOM_STEP);
    else if (k === 'Enter' && pending && !answered) confirmGuess();
    else if (/^Arrow/.test(k)) {
      e.preventDefault();
      var dx = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0, dy = k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0;
      if (answered) { view = panView(view, dx * step, dy * step); applyView(); return; }
      var c = pending ? project(pending.lat, pending.lon) : { x: view.x + view.w / 2, y: view.y + view.h / 2 };
      var g = unproject(Math.min(MAP_W, Math.max(0, c.x + dx * step / 2)), Math.min(MAP_H, Math.max(0, c.y + dy * step / 2)));
      setPending(g);
    } else return;
    e.preventDefault();
  });
  els.guess.addEventListener('click', confirmGuess);
  els.next.addEventListener('click', advance);
  els.newBtn.addEventListener('click', newRound);
  ZimiShell.game({
    about: function () { return Lib.note(T, 'places', useMaps ? mapZims[0] : ''); },
    inProgress: function () { return !finished && !busy && (at > 0 || !!pending || answered); },
    stats: function () {
      var best = Play.load(BEST_KEY, {}), lines = [];
      if (best.places) lines.push([T('world.bestPlaces'), Play.num(best.places)]);
      if (best.maps) lines.push([T('world.bestMaps'), Play.num(best.maps)]);
      return lines;
    },
    // Where the places come from is a choice about the game, so it sits in the New game pane (only when there are maps).
    menu: function () {
      return { options: mapZims.length ? [Play.optionRow(T('world.from'), [[false, T('world.builtInPlaces')], [true, T('world.maps')]], pendingMaps === null ? useMaps : pendingMaps, function (v) { pendingMaps = v; })] : [] };
    }
  });
  window.addEventListener('resize', function () { view = clampView({ x: view.x, y: view.y, w: view.w, h: view.w / aspect() }); applyView(); });

  buildMap();
  Lib.isZimi().then(function (yes) { return yes ? Lib.zims() : []; }).then(function (list) {
    var a = Lib.pickZim(list, 'wikipedia', Lib.uiLang());
    wikiZim = a ? a.zim.name : null;
    libList = list;
    mapZims = list.filter(function (z) { return z.kind === 'map' && z.map_search; }).map(function (z) { return z.name; });
    // Leaving and coming back keeps the round: its places, where you are, the pin and the answer just given.
    var kept = ZimiShell.saved();
    if (kept && kept.round && kept.round.length) {
      useMaps = !!kept.useMaps; round = kept.round; at = kept.at; total = kept.total; ask();
      if (kept.pending) {
        setPending(kept.pending);
        if (kept.answered) { total -= points(haversine(kept.pending, round[at])); confirmGuess(); if (kept.finished) advance(); }
      }
    } else { if (kept) ZimiShell.forget(); newRound(); }
  });
  ZimiShell.persist({
    save: function () { return round.length && (at > 0 || pending || answered) ? { useMaps: useMaps, round: round, at: at, total: total, pending: pending, answered: answered, finished: finished } : null; }
  });
  root.__world = { get round() { return round; }, get view() { return view; }, get pending() { return pending; }, get maps() { return mapZims; } };
})(this);
