/* ZimiGames: ZimiKart, the page: setup, Grand Prix and Time Trial, the race loop, keys and the touch pad, split screen, saving.
   The rules are in kart.js (KartEngine), the pictures in kart-art.js and kart-view.js. Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  var E = root.KartEngine, V = root.KartView, Play = root.ArcadePlay, $ = Play.$, Tx = Play.T, TRACKS = E.TRACKS, DRIVERS = E.DRIVERS;
  // The names the engine holds are English ids' labels; every one a player reads goes through T().
  function trackName(t) { return Tx('kart.track.' + t.id + '.name'); }
  function cupName(c) { return Tx('kart.cup.' + c.id); }
  function driverName(d) { return Tx('kart.driver.' + d.id + '.name'); }
  function driverNote(d) { return Tx('kart.driver.' + d.id + '.note'); }
  var STORE = 'zimi.games.kart', GHOST_KEY = 'zimi.games.kart.ghost.', TOAST_S = 1.6, MAX_W = 1180, BAR_H = 52, DPR_MAX = 2, MSG_GAP_S = 2.5;
  var FACE_PADS_PX = 168, TILT_RANGE = 24, TILT_DEAD = 0.06;
  Play.applyTheme();

  var coarse = false;
  try { coarse = matchMedia('(pointer: coarse)').matches; } catch (e) { /* desktop */ }
  if (coarse || 'ontouchstart' in root) document.body.classList.add('touch');
  document.addEventListener('touchstart', function () { document.body.classList.add('touch'); layout(); }, { once: true, passive: true });
  function isTouch() { return document.body.classList.contains('touch'); }

  var saved = Play.load(STORE, {});
  var prefs = { mode: saved.mode || 'gp', players: saved.players || 1, cup: saved.cup || 0, track: saved.track || 'tidewalk', diff: saved.diff || 'normal', driver: saved.driver == null ? 0 : saved.driver, driver2: saved.driver2 == null ? 1 : saved.driver2,
    auto: saved.auto == null ? isTouch() : !!saved.auto, tilt: !!saved.tilt, best: saved.best || {}, cups: saved.cups || {} };
  function savePrefs() { Play.save(STORE, prefs); }

  var els = { cv: $('kt-board'), stage: $('kt-stage'), pads: $('kt-pads'), msg: $('kt-msg'), pause: $('kt-pause'), newBtn: $('kt-new') };
  var status = Play.status(els.msg), openSheet = null;
  var ctx, cssW = 0, cssH = 0, pxs = 1;
  var g = { mode: 'setup', race: null, T: null, assets: null, cams: [], humans: [], gp: null, rects: [], split: false, banner: null, bannerT: 0, rec: null, ghost: null, ghostRec: null, lastPlace: [], lastSay: 0, assetsFor: '' };
  var keys = {}, pads = [{}, {}], tiltSteer = 0, assetCache = {};

  // ── tracks ───────────────────────────────────────────────────────────────
  function assetsFor(id) {
    if (!assetCache[id]) { var T = E.buildTrack(id); assetCache = {}; assetCache[id] = V.prepare(T); }
    return assetCache[id];
  }

  // ── starting a race ──────────────────────────────────────────────────────
  function trackFor() { return prefs.mode === 'gp' ? TRACKS[E.CUPS[prefs.cup].tracks[g.gp.race]] : E.track(prefs.track); }
  function startRace() {
    var def = trackFor(), a = assetsFor(def.id), humans = prefs.mode === 'trial' ? 1 : prefs.players;
    var opts = { humans: humans, driver: prefs.driver, driver2: prefs.driver2, diff: prefs.diff, laps: 3, seed: Math.floor(Math.random() * 1e9), trial: prefs.mode === 'trial' };
    if (prefs.mode === 'gp' && g.gp.race > 0) opts.grid = E.cupOrder(g.gp.totals);
    els.cv.style.visibility = '';
    g.opts = opts; g.T = a.T; g.assets = a; g.race = E.createRace(a.T, opts);
    g.humans = g.race.karts.filter(function (k) { return k.human >= 0; }).sort(function (x, y) { return x.human - y.human; });
    g.split = humans === 2; g.cams = g.humans.map(function (k) { var c = { x: 0, y: 0, yaw: 0, lift: 0 }; V.follow(c, k, 0, true); return c; });
    g.rec = prefs.mode === 'trial' ? E.ghostNew() : null; g.ghostRec = prefs.mode === 'trial' ? Play.load(GHOST_KEY + def.id, null) : null;
    g.lastPlace = []; g.banner = null; closeSheet(); say(Tx(isTouch() ? 'kart.hintTouch' : 'kart.hintKeys'));
    g.mode = 'playing'; Play.pauseLabel(els.pause, false); els.pause.disabled = false;
    buildPads(); layout(); loop.start();
  }
  function startCup() { g.gp = { race: 0, totals: DRIVERS.map(function () { return 0; }), cup: prefs.cup }; startRace(); }

  function toast(text) { g.banner = text; g.bannerT = TOAST_S; }
  function say(text) { status.say(text); }

  // ── the loop ─────────────────────────────────────────────────────────────
  function inputFor(p) {
    var n = g.humans.length, kb = n === 1 ? ONE : p === 0 ? P1 : P2, pd = pads[p], any = function (list) { return list.some(function (c) { return keys[c]; }); };
    var steer = (any(kb.right) || pd.right ? 1 : 0) - (any(kb.left) || pd.left ? 1 : 0);
    if (!steer && p === 0 && prefs.tilt) steer = tiltSteer;
    var brake = any(kb.brake) || !!pd.brake;
    return { steer: steer, gas: !brake && (prefs.auto || any(kb.gas) || !!pd.gas), brake: brake, drift: any(kb.drift) || !!pd.drift, item: any(kb.item) || !!pd.item };
  }
  var ONE = { left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'], gas: ['ArrowUp', 'KeyW'], brake: ['ArrowDown', 'KeyS'], drift: ['ShiftLeft', 'ShiftRight', 'KeyZ'], item: ['Space', 'Enter', 'NumpadEnter', 'KeyX'] };
  var P1 = { left: ['KeyA'], right: ['KeyD'], gas: ['KeyW'], brake: ['KeyS'], drift: ['ShiftLeft'], item: ['Space'] };
  var P2 = { left: ['ArrowLeft'], right: ['ArrowRight'], gas: ['ArrowUp'], brake: ['ArrowDown'], drift: ['ShiftRight', 'Slash'], item: ['Enter', 'NumpadEnter'] };
  var USED = {};
  [ONE, P1, P2].forEach(function (m) { Object.keys(m).forEach(function (k) { m[k].forEach(function (c) { USED[c] = true; }); }); });

  function update(dt) {
    var r = g.race, inputs = g.humans.map(function (k, p) { return inputFor(p); });
    var ev = E.step(r, inputs, dt), clock = E.clockOf(r);
    if (g.rec && r.go && g.humans[0].finished == null) E.ghostPush(g.rec, clock, g.humans[0]);
    ev.forEach(handle);
    g.humans.forEach(function (k, p) { V.follow(g.cams[p], k, dt, false); });
    if (g.bannerT > 0) { g.bannerT -= dt; if (g.bannerT <= 0) g.banner = null; }
    var lead = g.humans[0];
    if (lead && r.go && lead.place !== g.lastPlace[0] && r.t - g.lastSay > MSG_GAP_S) { if (g.lastPlace[0] != null) say(Tx('kart.placeSay', { place: Play.ordinal(lead.place) })); g.lastPlace[0] = lead.place; g.lastSay = r.t; }
    if (r.over && g.mode === 'playing') finishRace();
  }
  function isMine(k) { return k && k.human >= 0; }
  function handle(e) {
    var k = e.kart, one = g.humans.length === 1;
    if (!isMine(k)) return;
    function who(text) { return one ? text : Tx('kart.playerSays', { n: k.human + 1, text: text }); }
    if (e.type === 'lap' && k.finished == null) { var t = e.lap + 1 === g.race.laps ? Tx('kart.finalLap') : Tx('kart.lap', { n: e.lap + 1 }); if (one) toast(t); say(who(t)); }
    else if (e.type === 'finish') { var f = g.race.trial ? Tx('kart.finishedTrial') : Tx('kart.finished', { place: Play.ordinal(k.place) }); say(who(f)); toast(f); }
    else if (e.type === 'hit' && one) toast(Tx('kart.spun'));
    else if (e.type === 'blocked' && one) toast(Tx('kart.shield'));
    else if (e.type === 'fall' && one) toast(Tx('kart.missed'));
    else if (e.type === 'miniboost' && one) toast(Tx('kart.boost.' + e.level));
  }
  function render() {
    if (!g.race || !ctx) return;
    var r = g.race, t = performance.now() / 1000, reduced = Play.reducedMotion(), clock = E.clockOf(r);
    ctx.setTransform(pxs, 0, 0, pxs, 0, 0);
    var ghost = null;
    if (g.ghostRec && r.go) { var gp = E.ghostAt(g.ghostRec.rec || g.ghostRec, clock); if (gp) ghost = { x: gp.x, y: gp.y, a: gp.a, driver: DRIVERS[(g.ghostRec.driver || 0)] }; }
    g.humans.forEach(function (k, p) {
      var rc = g.rects[p], flip = g.face && p === 1; // face to face: player 2's half is drawn upside down, for the person across the table
      if (flip) { ctx.save(); ctx.translate(rc.x + rc.w / 2, rc.y + rc.h / 2); ctx.rotate(Math.PI); ctx.translate(-(rc.x + rc.w / 2), -(rc.y + rc.h / 2)); }
      V.draw(ctx, rc, g.cams[p], k, r, g.assets, { slot: p, t: t, still: reduced, ghost: ghost, small: g.split, banner: p === 0 || g.split ? (g.humans.length === 1 || p === 0 ? g.banner : null) : null });
      if (flip) ctx.restore();
    });
    if (g.split) { ctx.fillStyle = '#0e0e10'; var a = g.rects[0], b = g.rects[1]; if (a.y === b.y) ctx.fillRect(a.x + a.w, 0, b.x - a.x - a.w, cssH); else { var hi = a.y < b.y ? a : b, lo = hi === a ? b : a; ctx.fillRect(0, hi.y + hi.h, cssW, lo.y - hi.y - hi.h); } }
  }
  var loop = Play.loop(update, render, 60);

  // ── the end of a race ────────────────────────────────────────────────────
  // Results are a table, so they sit in a ZimiShell sheet: the title is the result, Close and one next step in amber.
  function finishRace() {
    g.mode = 'result'; loop.stop(); releaseAll(); els.pause.disabled = true; Play.pauseLabel(els.pause, false);
    var r = g.race, order = r.order || E.rankKarts(r), me = g.humans[0], clock = me.finished;
    if (prefs.mode === 'trial') return trialResult(me, clock);
    var drvOrder = order.map(function (k) { return k.drvIndex; });
    if (prefs.mode === 'gp') g.gp.totals = E.addPoints(g.gp.totals, drvOrder);
    var last = prefs.mode === 'gp' && g.gp.race === 2, title;
    if (prefs.mode === 'gp') title = Tx('kart.raceOf', { n: g.gp.race + 1, total: 3 });
    else title = g.humans.length === 2 ? Tx('shell.end.wins', { name: nameOf(order.filter(isMine)[0]) }) : Tx('kart.placeOf', { place: Play.ordinal(me.place), n: r.karts.length });
    sheet(title, function (b) {
      table(b, order.map(function (k, i) { return { me: isMine(k), cells: [Play.ordinal(i + 1), nameOf(k), k.finished != null ? E.fmtTime(k.finished) : '-', prefs.mode === 'gp' ? '+' + Play.num(E.GP_POINTS[i] || 0) : ''] }; }));
      if (prefs.mode !== 'gp') g.humans.forEach(function (k) { if (k.laps.length) note(b, g.humans.length > 1 ? Tx('kart.bestLapOf', { name: nameOf(k), time: E.fmtTime(Math.min.apply(null, k.laps)) }) : Tx('kart.bestLap', { time: E.fmtTime(Math.min.apply(null, k.laps)) })); });
    }, prefs.mode === 'gp' ? [[last ? Tx('kart.cupResult') : Tx('kart.next', { track: trackName(TRACKS[E.CUPS[prefs.cup].tracks[g.gp.race + 1]]) }), function () { if (last) cupResult(); else { g.gp.race++; startRace(); } }, true, true]] :
      [[Tx('shell.close')], [Tx('shell.menu.new'), startRace, true]]);
  }
  // The cup standings with the next race ready (also what a returning player sees).
  function standings() {
    var last = g.gp.race === 2, order = E.cupOrder(g.gp.totals), me = prefs.driver;
    sheet(Tx('kart.raceOf', { n: g.gp.race + 1, total: 3 }), function (b) {
      table(b, order.map(function (di, i) { return { me: di === me || (prefs.players === 2 && di === prefs.driver2), cells: [Play.ordinal(i + 1), driverName(DRIVERS[di]), '', Tx('kart.points', { n: g.gp.totals[di] })] }; }));
    }, [[last ? Tx('kart.cupResult') : Tx('kart.next', { track: trackName(TRACKS[E.CUPS[g.gp.cup].tracks[g.gp.race + 1]]) }), function () { if (last) cupResult(); else { g.gp.race++; startRace(); } }, true, true]]);
  }
  function nameOf(k) { return isMine(k) ? (g.humans.length > 1 ? Tx('kart.player', { n: k.human + 1, driver: driverName(k.driver) }) : Tx('kart.you', { driver: driverName(k.driver) })) : driverName(k.driver); }
  function medal(rank) { return rank <= 3 ? Tx('kart.medal.' + rank) : Play.ordinal(rank); }
  function cupResult() {
    var order = E.cupOrder(g.gp.totals), me = g.humans[0] ? g.humans[0].drvIndex : prefs.driver, rank = order.indexOf(me) + 1, cup = E.CUPS[prefs.cup];
    var rec = prefs.cups[cup.id];
    if (!rec || rank < rec.rank || (rank === rec.rank && g.gp.totals[me] > rec.points)) { prefs.cups[cup.id] = { rank: rank, points: g.gp.totals[me] }; savePrefs(); }
    sheet(Tx('kart.cupTitle', { cup: cupName(cup), medal: medal(rank) }), function (b) {
      table(b, order.map(function (di, i) { return { me: di === me || (g.humans[1] && di === g.humans[1].drvIndex), cells: [Play.ordinal(i + 1), driverName(DRIVERS[di]), '', Tx('kart.points', { n: g.gp.totals[di] })] }; }));
      if (rank > 3) note(b, Tx('kart.cupNote'));
    }, [[Tx('shell.close')], [Tx('shell.menu.new'), startCup, true]]);
  }
  function trialResult(me, ms) {
    var def = g.T.def, best = prefs.best[def.id], rec = !best || ms < best.ms, bestLap = Math.min.apply(null, me.laps);
    if (rec) { prefs.best[def.id] = { ms: ms, lap: bestLap }; savePrefs(); Play.save(GHOST_KEY + def.id, { rec: g.rec, driver: me.drvIndex }); }
    else if (best && bestLap < best.lap) { best.lap = bestLap; savePrefs(); }
    sheet(Tx('kart.trialTitle', { track: trackName(def), time: E.fmtTime(ms) }), function (b) {
      table(b, me.laps.map(function (l, i) { return { me: false, cells: [Tx('kart.lap', { n: i + 1 }), '', '', E.fmtTime(l)] }; }));
      note(b, rec ? (best ? Tx('kart.record.new', { time: E.fmtTime(best.ms - ms) }) : Tx('kart.record.first')) : Tx('kart.record.have', { time: E.fmtTime(best.ms) }));
    }, [[Tx('shell.close')], [Tx('shell.menu.new'), startRace, true]]);
  }

  // ── pause: the bar's button toggles; opening the Menu pauses too ──
  function pause() {
    if (g.mode !== 'playing') return;
    g.mode = 'paused'; loop.stop(); releaseAll(); Play.pauseLabel(els.pause, true); say(Tx('play.paused'));
  }
  function resume() { if (g.mode !== 'paused') return; g.mode = 'playing'; Play.pauseLabel(els.pause, false); say(''); loop.start(); }
  function toggle() { if (g.mode === 'playing') pause(); else resume(); }
  function releaseAll() { Object.keys(keys).forEach(function (k) { keys[k] = false; }); pads.forEach(function (p) { Object.keys(p).forEach(function (k) { p[k] = false; }); }); holds.forEach(function (h) { h.release(); }); }

  // ── sheets ───────────────────────────────────────────────────────────────
  // actions: [label, onclick, primary, keep]; no onclick just closes.
  function closeSheet() { if (openSheet) { var s = openSheet; openSheet = null; s.close(); } }
  function sheet(title, build, actions) {
    closeSheet();
    var body = document.createElement('div');
    build(body);
    openSheet = ZimiShell.sheet({ title: title, body: [body], actions: actions.map(function (a) { return { label: a[0], onclick: a[1], primary: !!a[2], keep: !!a[3] }; }), onClose: function () { openSheet = null; } });
    return openSheet;
  }
  function mk(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function note(parent, text) { parent.appendChild(mk('p', 'kt-note', text)); }
  function table(parent, rows) {
    var t = mk('table', 'kt-table'), tb = mk('tbody');
    rows.forEach(function (r) { var tr = mk('tr', r.me ? 'me' : ''); r.cells.forEach(function (c) { tr.appendChild(mk('td', '', c)); }); tb.appendChild(tr); });
    t.appendChild(tb); parent.appendChild(t);
  }
  // One option row of the setup: a labelled segmented control that keeps its choice in prefs.
  function seg(parent, label, key, choices, after) {
    parent.appendChild(Play.optionRow(label, choices, prefs[key], function (v) { prefs[key] = v; savePrefs(); if (after) after(); }));
  }
  var ON_OFF = function () { return [[false, Tx('shell.off')], [true, Tx('shell.on')]]; };
  function cast(parent, label, key, other) { // the critter to drive
    parent.appendChild(mk('div', 'kt-note', label));
    var grid = mk('div', 'kt-cast'), kids = [];
    grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', label);
    DRIVERS.forEach(function (d, i) {
      var b = mk('button', 'kt-pick'), cv = mk('canvas'), c;
      b.type = 'button'; b.setAttribute('aria-pressed', String(prefs[key] === i)); b.setAttribute('aria-label', driverName(d) + ', ' + driverNote(d)); cv.width = cv.height = 96;
      c = cv.getContext('2d'); V.drawKartPreview(c, d, 48, 90, 4.6, 'back');
      b.appendChild(cv); b.appendChild(mk('small', '', driverName(d))); kids.push(b);
      b.addEventListener('click', function () { prefs[key] = i; savePrefs(); kids.forEach(function (o, j) { o.setAttribute('aria-pressed', String(j === i)); }); if (other) other(); });
      grid.appendChild(b);
    });
    parent.appendChild(grid); return kids;
  }

  // The setup: the real choices (mode, cup or track, players, drivers). It is the start sheet and the New game pane.
  function setupNodes() {
    var top = mk('div'), detail = mk('div', 'kt-detail');
    function fill() {
      detail.textContent = '';
      var two = prefs.mode !== 'trial' && prefs.players === 2;
      if (prefs.mode === 'gp') {
        seg(detail, Tx('kart.cup'), 'cup', E.CUPS.map(function (c, i) { return [i, cupName(c)]; }), fill);
        var cup = E.CUPS[prefs.cup], rec = prefs.cups[cup.id], tracks = cup.tracks.map(function (t) { return trackName(TRACKS[t]); }).join(', ');
        note(detail, rec ? Tx('kart.cupBest', { tracks: tracks, medal: medal(rec.rank), n: rec.points }) : tracks);
      } else {
        var row = mk('div', 'gs-row'), lab = mk('label', '', Tx('kart.track')), sel = mk('select', 'kt-sel');
        sel.setAttribute('aria-label', Tx('kart.track'));
        TRACKS.forEach(function (t) { var o = mk('option', '', trackName(t) + (prefs.best[t.id] ? ' (' + E.fmtTime(prefs.best[t.id].ms / 1) + ')' : '')); o.value = t.id; o.selected = prefs.track === t.id; sel.appendChild(o); });
        sel.addEventListener('change', function () { prefs.track = sel.value; savePrefs(); });
        row.appendChild(lab); row.appendChild(sel); detail.appendChild(row);
        if (prefs.mode === 'trial') note(detail, Tx('kart.trialNote'));
      }
      if (prefs.mode !== 'trial') seg(detail, Tx('kart.players'), 'players', [[1, Play.num(1)], [2, Play.num(2)]], fill);
      if (two) note(detail, Tx(!isTouch() ? 'kart.splitKeys' : root.innerHeight >= root.document.documentElement.clientWidth ? 'kart.splitFace' : 'kart.splitTouch'));
      if (prefs.mode !== 'trial') seg(detail, Tx('kart.rivals'), 'diff', [['easy', Tx('kart.diff.easy')], ['normal', Tx('kart.diff.normal')], ['hard', Tx('kart.diff.hard')]]);
      cast(detail, two ? Tx('kart.p1drives') : Tx('kart.youDrive'), 'driver', function () { if (prefs.players === 2 && prefs.driver2 === prefs.driver) { prefs.driver2 = (prefs.driver + 1) % DRIVERS.length; fill(); } });
      if (two) cast(detail, Tx('kart.p2drives'), 'driver2', function () { if (prefs.driver2 === prefs.driver) { prefs.driver = (prefs.driver2 + 1) % DRIVERS.length; fill(); } });
      seg(detail, Tx('kart.auto'), 'auto', ON_OFF());
      if (isTouch() && root.DeviceOrientationEvent) seg(detail, Tx('kart.tilt'), 'tilt', ON_OFF(), function () { if (prefs.tilt) askTilt(); });
    }
    seg(top, Tx('kart.mode'), 'mode', [['gp', Tx('kart.mode.gp')], ['race', Tx('kart.mode.race')], ['trial', Tx('kart.mode.trial')]], fill);
    top.appendChild(detail); fill();
    return top;
  }
  // Leaving 'setup' first: closing the start sheet in that mode arms a tap-to-start that would restart the race on the first pad press.
  function begin() { g.mode = 'starting'; closeSheet(); if (prefs.mode === 'gp') startCup(); else startRace(); }
  // The board is not drawn until Start: the setup comes first.
  function goSetup() {
    g.mode = 'setup'; loop.stop(); releaseAll(); els.pause.disabled = true; Play.pauseLabel(els.pause, false); g.gp = null; say('');
    closeSheet();
    els.cv.style.visibility = 'hidden';
    // Closed without Start: the page is not left blank, a tap starts with the choices made so far.
    openSheet = ZimiShell.sheet({ title: 'ZimiKart', body: [setupNodes()], actions: [{ label: Tx('shell.start'), primary: true, keep: true, onclick: begin }], onClose: function () {
      openSheet = null;
      if (g.mode === 'setup') Play.ready({ say: say, target: els.stage, start: begin });
    } });
  }

  // ── input ────────────────────────────────────────────────────────────────
  var holds = [];
  function buildPads() {
    els.pads.textContent = ''; holds = []; els.pads.classList.toggle('over', g.split); els.stage.classList.toggle('kt-split', g.split);
    if (!isTouch()) return;
    g.humans.forEach(function (k, p) {
      var pad = mk('div', 'kt-pad'), steer = mk('div', 'kt-steer'), act = mk('div', 'kt-act');
      pad.setAttribute('role', 'group'); pad.setAttribute('aria-label', g.split ? Tx('kart.playerControls', { n: p + 1 }) : Tx('play.pad')); pad.dataset.p = p;
      function btn(parent, cls, text, aria, name) {
        var b = mk('button', 'kt-btn ' + cls, text); b.type = 'button'; b.setAttribute('aria-label', aria); b.setAttribute('aria-pressed', 'false'); parent.appendChild(b);
        holds.push(Play.hold(b, function (v) { pads[p][name] = v; }));
      }
      btn(steer, 'kt-left', '◀', Tx('kart.steerLeft'), 'left'); btn(steer, 'kt-right', '▶', Tx('kart.steerRight'), 'right');
      btn(act, 'kt-brake', Tx('play.brake'), Tx('play.brake'), 'brake'); btn(act, 'kt-item', Tx('kart.item'), Tx('kart.useItem'), 'item'); btn(act, 'kt-drift', Tx('kart.drift'), Tx('kart.drift'), 'drift');
      pad.appendChild(steer); pad.appendChild(act); els.pads.appendChild(pad);
    });
  }
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.ar-sheet:not([hidden])')) return;
    if (USED[e.code]) { e.preventDefault(); keys[e.code] = true; }
    else if (e.code === 'KeyP' || e.code === 'Escape') { e.preventDefault(); if (g.mode === 'playing' || g.mode === 'paused') toggle(); }
  });
  document.addEventListener('keyup', function (e) { keys[e.code] = false; });
  window.addEventListener('blur', function () { Object.keys(keys).forEach(function (k) { keys[k] = false; }); });
  els.pause.addEventListener('click', toggle);
  els.newBtn.addEventListener('click', begin);
  els.cv.addEventListener('pointerdown', function () { if (g.mode === 'paused') resume(); });
  Play.onHidden(pause);
  ZimiShell.game({
    inProgress: function () { return g.mode === 'playing' || g.mode === 'paused'; },
    stats: function () {
      var rows = TRACKS.filter(function (t) { return prefs.best[t.id]; }).map(function (t) { return [trackName(t), E.fmtTime(prefs.best[t.id].ms)]; });
      E.CUPS.forEach(function (c) { if (prefs.cups[c.id]) rows.push([cupName(c), medal(prefs.cups[c.id].rank)]); });
      return rows;
    },
    menu: function () { return { options: [setupNodes()] }; }
  });

  function askTilt() {
    try {
      if (root.DeviceOrientationEvent && DeviceOrientationEvent.requestPermission) DeviceOrientationEvent.requestPermission().catch(function () { prefs.tilt = false; savePrefs(); });
    } catch (e) { prefs.tilt = false; }
  }
  window.addEventListener('deviceorientation', function (e) {
    if (!prefs.tilt || e.gamma == null) return;
    var portrait = window.innerHeight >= window.innerWidth, ang = (screen.orientation && screen.orientation.angle) || 0;
    var v = portrait ? e.gamma : (ang === 270 ? -e.beta : e.beta);
    v = E.clamp((v || 0) / TILT_RANGE, -1, 1);
    tiltSteer = Math.abs(v) < TILT_DEAD ? 0 : v;
  });

  // ── layout ───────────────────────────────────────────────────────────────
  function layout() {
    var vw = document.documentElement.clientWidth, vh = window.innerHeight, touch = isTouch(), landscape = vw > vh, split = g.split;
    // Portrait with two people on a touch screen sits face to face: player 2's pad and view are turned round at the top, player 1's at the bottom.
    var face = touch && !landscape && split, padBelow = face ? FACE_PADS_PX : touch && !landscape && !split ? 190 : 0;
    var avail = vh - BAR_H - (touch && landscape ? 10 : 48) - padBelow - (touch ? 0 : 56);
    g.face = face; els.stage.classList.toggle('kt-face', face); els.pads.classList.toggle('over', split && !face);
    cssW = Math.floor(Math.min(vw - (touch ? 0 : 20), MAX_W));
    var ratio = face ? 2 : touch && !landscape && !split ? 1.5 : split && !touch ? 0.5 : 0.62;
    cssH = Math.floor(Math.max(220, Math.min(avail, cssW * ratio)));
    pxs = Math.min(root.devicePixelRatio || 1, DPR_MAX);
    els.cv.style.width = cssW + 'px'; els.cv.style.height = cssH + 'px';
    els.cv.width = Math.floor(cssW * pxs); els.cv.height = Math.floor(cssH * pxs);
    ctx = els.cv.getContext('2d'); ctx.setTransform(pxs, 0, 0, pxs, 0, 0);
    var gap = 4;
    if (!split) g.rects = [{ x: 0, y: 0, w: cssW, h: cssH }];
    else if (touch) { var hh = Math.floor((cssH - gap) / 2); var top = { x: 0, y: 0, w: cssW, h: hh }, bottom = { x: 0, y: hh + gap, w: cssW, h: hh }; g.rects = face ? [bottom, top] : [top, bottom]; }
    else { var ww = Math.floor((cssW - gap) / 2); g.rects = [{ x: 0, y: 0, w: ww, h: cssH }, { x: ww + gap, y: 0, w: ww, h: cssH }]; }
    // a pad per half over the canvas in split screen; one pad under (or over) the canvas otherwise
    Array.prototype.forEach.call(els.pads.children, function (pad, p) {
      if (!g.split || g.face) { pad.style.top = pad.style.bottom = ''; return; }
      var r = g.rects[p]; pad.style.top = (r.y + r.h - 62) + 'px'; pad.style.bottom = 'auto';
    });
    render();
  }
  window.addEventListener('resize', layout);
  layout();
  // Leaving and coming back keeps a race (not a time trial: its ghost needs the whole run): paused where it was.
  var restored = false;
  var RACE_SKIP = /^(T|rng|leadHuman|ranked|karts|events|order)$/;
  ZimiShell.persist({
    save: function () {
      // A Grand Prix between races is progress: the cup, the race it is on and the points come back as the standings.
      if (g.mode === 'result' && prefs.mode === 'gp' && g.gp) return { between: true, gp: g.gp };
      if ((g.mode !== 'playing' && g.mode !== 'paused') || !g.race || g.race.trial) return null;
      var rr = {};
      Object.keys(g.race).forEach(function (k) { if (!RACE_SKIP.test(k)) rr[k] = g.race[k]; });
      return { mode: prefs.mode, gp: g.gp, trackId: g.T.def.id, opts: g.opts, karts: g.race.karts, race: rr };
    },
    load: function (d) {
      if (d && d.between) {
        if (!d.gp || !d.gp.totals || !E.CUPS[d.gp.cup]) return false;
        prefs.mode = 'gp'; prefs.cup = d.gp.cup; g.gp = d.gp; g.mode = 'result'; els.pause.disabled = true; standings();
        restored = true;
        return true;
      }
      if (!d || !d.opts || !d.karts || !TRACKS.some(function (t) { return t.id === d.trackId; })) return false;
      prefs.mode = d.mode; if (d.mode === 'gp') { if (!d.gp) return false; g.gp = d.gp; prefs.cup = d.gp.cup; }
      var a = assetsFor(d.trackId), race = E.createRace(a.T, d.opts);
      race.karts.splice.apply(race.karts, [0, race.karts.length].concat(d.karts));
      Object.keys(d.race).forEach(function (k) { race[k] = d.race[k]; });
      g.opts = d.opts; g.T = a.T; g.assets = a; g.race = race; g.rec = null; g.ghostRec = null;
      g.humans = race.karts.filter(function (k) { return k.human >= 0; }).sort(function (x, y) { return x.human - y.human; });
      g.split = d.opts.humans === 2; g.cams = g.humans.map(function (k) { var c = { x: 0, y: 0, yaw: 0, lift: 0 }; V.follow(c, k, 0, true); return c; });
      g.lastPlace = []; g.banner = null; g.mode = 'paused'; els.pause.disabled = false; Play.pauseLabel(els.pause, true); say(Tx('play.paused'));
      buildPads(); layout();
      restored = true;
      return true;
    }
  });
  if (!restored) goSetup();
  root.__kart = { get g() { return g; }, prefs: prefs, keys: keys, pads: pads, E: E, startRace: startRace, startCup: startCup, update: update, render: render, loop: loop };
})(this);
