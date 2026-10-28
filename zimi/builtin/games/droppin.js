/* ZimiGames: Drop Pin. A place is named; put a pin on it, and the score falls as the pin lands further away. With a StreetZim map
   in the library (Zimi) the map is the real thing, an offline street map in a frame that you pan and zoom until the cross at its
   middle is on the place, and the pin is wherever the map's middle is when you press Drop pin; the places are ones the map itself
   holds, so every game is somewhere on your own map. Without one it is the world outline in world-land.js, with well-known places
   (droppin-data.js) to find by tapping. The rules are pure functions (no DOM, so node can test them), then the page.
   Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  var Lib = root.GamesLib;

  // ── the rules ────────────────────────────────────────────────────────────
  var QUESTIONS = 5, EARTH_KM = 6371.0088, MAP_W = 800, MAP_H = 400, MAX_POINTS = 100, WORLD_SCALE_KM = 1500, DEFAULT_REGION_KM = 40, MIN_SCALE_KM = 2, MAX_SCALE_KM = 1500, DIAG_SHARE = 6;
  var MIN_ZOOM = 1, MAX_ZOOM = 12;

  function rad(d) { return d * Math.PI / 180; }
  // The distance over the ground between two points, in kilometres (the great circle).
  function haversine(a, b) {
    var dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // Points fall off with distance, gently: a pin one scale away keeps about a third.
  function pointsFor(km, scaleKm) { return Math.round(MAX_POINTS * Math.exp(-km / scaleKm)); }
  // How far is "far" on this map: a sixth of its diagonal, kept sensible.
  function scaleFor(bounds) {
    if (!bounds || bounds.length !== 4) return DEFAULT_REGION_KM;
    var diag = haversine({ lat: bounds[1], lon: bounds[0] }, { lat: bounds[3], lon: bounds[2] });
    return Math.max(MIN_SCALE_KM, Math.min(MAX_SCALE_KM, diag / DIAG_SHARE));
  }
  // The map's own address for where it is looking: StreetZim writes it in the page's hash as map=zoom/lat/lon.
  function parseHash(hash) {
    var m = /map=([\d.]+)\/(-?[\d.]+)\/(-?[\d.]+)/.exec(String(hash || ''));
    if (!m) return null;
    var p = { zoom: parseFloat(m[1]), lat: parseFloat(m[2]), lon: parseFloat(m[3]) };
    return isFinite(p.lat) && isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 ? p : null;
  }
  // A map ZIM's random entry as a place to find, or null: its name and where it is.
  function placeFromMap(r) {
    var p = parseHash(r && r.pos);
    return p && r.title ? { name: r.title, lat: p.lat, lon: p.lon } : null;
  }
  // The world outline's grid: equirectangular, longitude -180..180 across 800, latitude 90..-90 down 400.
  function project(lat, lon) { return { x: (lon + 180) * MAP_W / 360, y: (90 - lat) * MAP_H / 180 }; }
  function unproject(x, y) { return { lat: 90 - y * 180 / MAP_H, lon: x * 360 / MAP_W - 180 }; }
  function builtInRound(data, n, rng) { return Lib.sample(data, n, rng).map(function (p) { return { name: p[0], lat: p[1], lon: p[2] }; }); }

  root.DropPinEngine = { haversine: haversine, pointsFor: pointsFor, scaleFor: scaleFor, parseHash: parseHash, placeFromMap: placeFromMap, project: project, unproject: unproject, builtInRound: builtInRound, QUESTIONS: QUESTIONS, WORLD_SCALE_KM: WORLD_SCALE_KM };
  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T, NS = 'http://www.w3.org/2000/svg';
  Play.applyTheme();
  var BEST_KEY = 'zimi.games.droppin.best', ZOOM_STEP = 1.8, ASK_MS = 8000, MAP_ZOOM_TRUTH = 15, PIN_PX = 5, TAP_PX = 8;
  var els = { n: $('dp-n'), ask: $('dp-ask'), frame: $('dp-frame'), world: $('dp-world'), cross: $('dp-cross'), zoom: $('dp-zoom'), msg: $('dp-msg'), drop: $('dp-drop'), mapLink: $('dp-map'), next: $('dp-next'), score: $('dp-score'), newBtn: $('dp-new'), zin: $('dp-zin'), zout: $('dp-zout') };
  var status = Play.status(els.msg), g = null, libList = [], mapZim = '', mapBounds = null, building = false, done = false;
  var view = { x: 0, y: 0, w: MAP_W, h: MAP_H }, pin = null, layer = null, drag = null;

  var el = root.ZimiUtil.el;
  function svg(tag, attrs, parent) { var e = document.createElementNS(NS, tag); Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); }); if (parent) parent.appendChild(e); return e; }
  function q() { return g.qs[g.at]; }
  function paint() { Lib.englishNote(T, 'lang.enPlaces', !!g && g.mode === 'world'); els.n.textContent = g ? T('drop.question', { n: Math.min(g.at + 1, g.qs.length), total: g.qs.length }) : ''; els.score.textContent = g ? T('round.score', { n: g.total }) : ''; }
  function kmText(km) { return T('drop.km', { n: km < 10 ? Math.round(km * 10) / 10 : Math.round(km) }); }

  // ── the real map ──
  function mapUrl(hash) { return Lib.articleUrl(mapZim, 'index.html') + (hash ? '#' + hash : ''); }
  function showMap() {
    els.world.hidden = true; els.zoom.hidden = true; els.frame.hidden = false; els.cross.hidden = false;
    els.frame.src = mapUrl('');
  }
  function mapCenter() {
    try { return parseHash(els.frame.contentWindow.location.hash); } catch (e) { return null; }
  }
  // ── the world outline ──
  function buildWorld() {
    els.frame.hidden = true; els.cross.hidden = true; els.world.hidden = false; els.zoom.hidden = false;
    els.world.innerHTML = '';
    var grid = svg('g', { class: 'grid' }, els.world), i;
    for (i = -150; i <= 150; i += 30) { var x = project(0, i).x; svg('line', { x1: x, y1: 0, x2: x, y2: MAP_H }, grid); }
    for (i = -60; i <= 60; i += 30) { var y = project(i, 0).y; svg('line', { x1: 0, y1: y, x2: MAP_W, y2: y }, grid); }
    svg('path', { d: root.WORLD_LAND_D, class: 'land' }, els.world);
    layer = svg('g', {}, els.world);
    view = { x: 0, y: 0, w: MAP_W, h: MAP_H }; fitHeight(); view.y = (MAP_H - view.h) / 2; applyView();
  }
  // The viewBox keeps the shape of the box it is drawn in, so a tap lands where the finger is.
  function ratio() { return els.world.clientHeight / Math.max(1, els.world.clientWidth) || MAP_H / MAP_W; }
  function fitHeight() { view.h = view.w * ratio(); }
  // Up and down, the map may sit anywhere its box still shows some of it, centred when the box is taller than the map.
  function clampY(y, h) { var lo = Math.min(0, MAP_H - h), hi = Math.max(0, MAP_H - h); return Math.max(lo, Math.min(hi, y)); }
  function applyView() { els.world.setAttribute('viewBox', view.x + ' ' + view.y + ' ' + view.w + ' ' + view.h); }
  function unit() { return view.w / Math.max(1, els.world.clientWidth); }
  function zoomBy(f, at) {
    var w = Math.max(MAP_W / MAX_ZOOM, Math.min(MAP_W / MIN_ZOOM, view.w / f)), h = w * ratio(), fx = at ? at.fx : 0.5, fy = at ? at.fy : 0.5;
    view.x = Math.max(0, Math.min(MAP_W - w, view.x + (view.w - w) * fx)); view.y = clampY(view.y + (view.h - h) * fy, h); view.w = w; view.h = h; applyView(); paintPins();
  }
  function frac(e) { var r = els.world.getBoundingClientRect(); return { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height }; }
  function paintPins() {
    if (!layer) return;
    layer.innerHTML = ''; var u = unit();
    if (pin) { var p = project(pin.lat, pin.lon); svg('circle', { cx: p.x, cy: p.y, r: PIN_PX * u, class: 'pin', 'stroke-width': 2 }, layer); }
    if (g && g.ans) {
      var t = project(q().lat, q().lon), a = project(g.ans.lat, g.ans.lon);
      svg('line', { x1: a.x, y1: a.y, x2: t.x, y2: t.y, class: 'miss', 'stroke-width': 1.5 }, layer);
      svg('circle', { cx: t.x, cy: t.y, r: PIN_PX * u, class: 'truth', 'stroke-width': 2 }, layer);
      svg('circle', { cx: a.x, cy: a.y, r: PIN_PX * u, class: 'pin', 'stroke-width': 2 }, layer);
    }
  }
  els.world.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; try { els.world.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ } });
  els.world.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > TAP_PX) drag.moved = true;
    if (drag.moved) { var u = unit(); view.x = Math.max(0, Math.min(MAP_W - view.w, drag.vx - dx * u)); view.y = clampY(drag.vy - dy * u, view.h); applyView(); paintPins(); }
  });
  els.world.addEventListener('pointerup', function (e) {
    var was = drag; drag = null;
    if (!was || was.moved || done || (g && g.ans)) return;
    var f = frac(e), pt = unproject(view.x + f.fx * view.w, view.y + f.fy * view.h);
    pin = { lat: Math.max(-90, Math.min(90, pt.lat)), lon: Math.max(-180, Math.min(180, pt.lon)) }; paintPins(); els.drop.removeAttribute('aria-disabled');
  });
  els.zin.addEventListener('click', function () { zoomBy(ZOOM_STEP); });
  els.zout.addEventListener('click', function () { zoomBy(1 / ZOOM_STEP); });

  // ── the round ──
  function ask() {
    var x = q(); pin = null; els.mapLink.hidden = true; paint();
    els.ask.textContent = T(g.mode === 'map' ? 'drop.findOnMap' : 'drop.find', { name: Lib.iso(x.name) });
    els.next.hidden = true; els.drop.hidden = false;
    if (g.mode === 'map') { els.drop.removeAttribute('aria-disabled'); status.say(T('drop.panTo')); showMap(); }
    else { els.drop.setAttribute('aria-disabled', 'true'); status.say(T('drop.tapTo')); buildWorld(); }
    if (g.ans) reveal(g.ans, true);
  }
  function drop() {
    if (done || g.ans) return;
    var p = g.mode === 'map' ? mapCenter() : pin;
    if (!p) { status.reason(T(g.mode === 'map' ? 'drop.noMap' : 'drop.placeFirst')); return; }
    var km = haversine(p, q()), scale = g.mode === 'map' ? g.scale : WORLD_SCALE_KM, pts = pointsFor(km, scale);
    g.ans = { lat: p.lat, lon: p.lon, km: km, pts: pts }; g.total += pts;
    reveal(g.ans, false);
  }
  function reveal(a) {
    status.say(T('drop.result', { distance: kmText(a.km), points: a.pts }));
    mapLink(q());
    els.drop.hidden = true; els.next.hidden = false; els.next.textContent = T(g.at + 1 >= g.qs.length ? 'round.seeScore' : 'round.next'); els.next.focus();
    if (g.mode === 'map') { els.cross.hidden = true; try { els.frame.contentWindow.location.hash = 'map=' + MAP_ZOOM_TRUTH + '/' + q().lat + '/' + q().lon; } catch (e) { els.frame.src = mapUrl('map=' + MAP_ZOOM_TRUTH + '/' + q().lat + '/' + q().lon); } }
    else paintPins();
    paint();
  }
  // Inside Zimi, the place on the whole StreetZim map (the one it came from, else one whose box holds it), once the pin is down.
  function mapLink(x) {
    var m = Lib.hosted() && Lib.mapFor(libList, x.lat, x.lon, g.mode === 'map' ? g.zim : '');
    els.mapLink.hidden = !m;
    if (!m) return;
    Lib.articleLink(els.mapLink, m.zim, m.path); els.mapLink.textContent = T('learn.map', { place: x.name });
  }
  function advance() {
    if (!g.ans) return;
    if (g.at + 1 >= g.qs.length) return finish();
    g.at++; g.ans = null; ask();
  }
  function finish() {
    done = true; var best = Play.load(BEST_KEY, {}), key = g.mode, mine = best[key] || 0, max = g.qs.length * MAX_POINTS;
    if (g.total > mine) { best[key] = g.total; Play.save(BEST_KEY, best); }
    var line = T('round.verdict.' + Lib.verdict(g.total, max));
    status.say(line);
    ZimiShell.endSheet({ result: 'over', text: line, stats: [[T('play.score'), T('round.of', { n: g.total, total: max })], [T('play.best'), Play.num(Math.max(g.total, mine))]] });
  }

  // ── places ──
  function mapPlaces() {
    var out = [], seen = {}, asked = 0, failed = 0, lanes = [];
    function lane() {
      if (out.length >= QUESTIONS || asked >= QUESTIONS * 4 || failed > 6) return Promise.resolve();
      asked++;
      return Lib.json('/random?zim=' + encodeURIComponent(mapZim), ASK_MS).then(function (r) {
        var p = placeFromMap(r);
        if (p && !seen[p.name] && out.length < QUESTIONS) { seen[p.name] = true; out.push(p); }
      }, function () { failed++; }).then(lane);
    }
    for (var i = 0; i < 4; i++) lanes.push(lane());
    return Promise.all(lanes).then(function () { return out; });
  }
  function start() {
    if (building) return; building = true; done = false;
    status.say(T('drop.choosing'));
    var work = mapZim ? mapPlaces() : Promise.resolve([]);
    work.then(function (places) {
      var mode = places.length >= 3 ? 'map' : 'world';
      if (mode === 'world') { mapZim = ''; places = builtInRound(root.DROPPIN_PLACES, QUESTIONS, Math.random); }
      g = { mode: mode, zim: mapZim, scale: scaleFor(mapBounds), qs: places, at: 0, total: 0, ans: null };
      building = false; ask();
    });
  }

  els.drop.addEventListener('click', drop);
  els.next.addEventListener('click', advance);
  els.newBtn.addEventListener('click', start);
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || !g || document.querySelector('.ar-sheet:not([hidden])')) return;
    if ((e.key === 'Enter' || e.key === ' ') && g.ans && document.activeElement === document.body) { e.preventDefault(); advance(); }
  });
  ZimiShell.game({
    about: function () { return Lib.note(T, 'places', mapZim); },
    inProgress: function () { return !!g && !done && (g.at > 0 || !!g.ans); },
    stats: function () { var b = Play.load(BEST_KEY, {}); return Object.keys(b).map(function (k) { return [T(k === 'map' ? 'drop.bestMap' : 'drop.bestWorld'), Play.num(b[k])]; }); }
  });

  Lib.library().then(function (list) {
    libList = list || [];
    var m = (list || []).filter(function (z) { return z.kind === 'map' && z.map_search; })[0];
    mapZim = m ? m.name : ''; mapBounds = m && m.map_bounds ? m.map_bounds : null;
    var kept = ZimiShell.saved();
    if (kept && kept.g && kept.g.qs && kept.g.qs.length) { g = kept.g; mapZim = g.mode === 'map' ? g.zim : ''; ask(); }
    else { if (kept) ZimiShell.forget(); start(); }
  });
  ZimiShell.persist({ save: function () { return g && !done ? { g: g } : null; } });
  root.__drop = { get g() { return g; }, get zim() { return mapZim; } };
})(this);
