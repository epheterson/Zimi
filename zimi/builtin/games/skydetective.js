/* ZimiGames: Sky Detective. The sky over where you are, tonight, worked out on the page by skykit.js: a dome with the Moon, the
   planets that are up and the bright stars, none of them named. Six clues: "What is this?" with a ring round one, and "Find
   Jupiter" by tapping it. It is the real sky for a real place and time, so it is a different game every night, and it needs no ZIM
   (so it plays the same in Zimi, Kiwix and from a folder); with a Wikipedia in the library each answer links to its article.
   Before the first question the player studies the sky: inside Zimi the Almanac's own sky view opens over the page (names on, drag
   and pinch; static/almanac-gamesky.js through the {zimi: 'game-sky'} message), anywhere else this page's own dome is drawn with
   its names. Each answer can then be seen again in that same sky.
   The rules are pure functions (no DOM, so node can test them), then the page. Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  var Lib = root.GamesLib, Sky = root.SkyKit;

  // ── the rules ────────────────────────────────────────────────────────────
  var QUESTIONS = 6, CHOICES = 4, MIN_ALT = 8, NIGHT_SUN_ALT = -6, MIN_ELONGATION = 14, STAR_MAG = 2.0, TARGET_STAR_MAG = 1.6, TAP_TOLERANCE = 0.075;
  var SOUTHERN = /^(Australia\/|Pacific\/(Auckland|Fiji|Tongatapu|Chatham)|America\/(Sao_Paulo|Argentina\/|Buenos_Aires|Santiago|Lima|La_Paz|Montevideo|Asuncion|Cordoba)|Africa\/(Johannesburg|Maputo|Harare|Lusaka|Windhoek|Luanda|Gaborone|Maseru|Mbabane)|Indian\/(Mauritius|Reunion|Antananarivo)|Antarctica\/)/;
  var SHOW_FOV = 60, DEFAULT_LAT = 40, SOUTH_LAT = -33, EVENING_HOUR = 21, DAY_MS = root.ZimiUtil.DAY_MS, HOUR_MS = 3600000;

  // Where a person probably is, from their time zone alone (no request is made): the longitude the clock's offset gives, a
  // mid-latitude of the hemisphere their zone is in. Good enough for the sky to look right; "My location" is exact.
  function guessPlace(tzName, offsetMinutes) {
    var lat = SOUTHERN.test(String(tzName || '')) ? SOUTH_LAT : DEFAULT_LAT;
    return { lat: lat, lon: clampLon(-offsetMinutes / 4), kind: 'guess' };   // 4 minutes of clock a degree of longitude
  }
  function clampLon(x) { return Math.max(-180, Math.min(180, x)); }

  function sunAlt(ms, lat, lon) { var jd = Sky.julian(ms), s = Sky.sun(jd); return Sky.altaz(s.ra, s.dec, jd, lat, lon).alt; }
  function isNight(ms, lat, lon) { return sunAlt(ms, lat, lon) < NIGHT_SUN_ALT; }
  // The moment to look: 9 in the evening by the clock for "tonight" (or now, if it is later and dark), or now. The next dark hour
  // when that is not dark (daylight, or a polar summer): a sky with only the Sun in it is no game.
  function momentFor(now, lat, lon, when, evening) {
    var d = new Date(now); d.setHours(evening === undefined ? EVENING_HOUR : evening, 0, 0, 0);
    var t = when === 'now' ? now : (d.getTime() < now ? now : d.getTime());
    for (var i = 0; i < 24 && !isNight(t, lat, lon); i++) t += HOUR_MS;
    return isNight(t, lat, lon) ? t : (when === 'now' ? now : d.getTime());
  }

  // What is up and worth naming: above the horizon, the Sun left out, a planet lost in the Sun's glare left out.
  function visibleObjects(ms, lat, lon) {
    return Sky.objects(ms, lat, lon, STAR_MAG).filter(function (o) { return o.alt >= MIN_ALT && o.kind !== 'sun' && !(o.kind === 'planet' && o.elongation < MIN_ELONGATION); });
  }
  function everyName(ms, lat, lon) { return Sky.objects(ms, lat, lon, STAR_MAG).filter(function (o) { return o.kind !== 'sun'; }); }
  function nameOf(o, T) { return o.kind === 'star' ? o.name : T('sky.name.' + o.id); }

  // Six clues, "name" and "find" taking turns, no object twice. A name question's choices are other objects of the sky
  // (the ones that are up first, for the tough ones; then the ones that are down).
  function makeQuestions(vis, all, count, rng, T) {
    var pool = Lib.shuffle(vis.filter(function (o) { return o.kind !== 'star' || o.mag <= TARGET_STAR_MAG; }), rng), out = [];
    var names = function (o) { return nameOf(o, T); };
    for (var i = 0; i < pool.length && out.length < count; i++) {
      var o = pool[i], kind = out.length % 2 ? 'find' : 'name', q = { kind: kind, id: o.id };
      if (kind === 'name') {
        var others = Lib.shuffle(vis.filter(function (x) { return x.id !== o.id; }), rng).concat(Lib.shuffle(all.filter(function (x) { return x.id !== o.id && vis.indexOf(x) < 0; }), rng));
        var seen = [names(o)], picks = [];
        others.forEach(function (x) { if (picks.length < CHOICES - 1 && seen.indexOf(names(x)) < 0) { seen.push(names(x)); picks.push(names(x)); } });
        q.answer = names(o); q.choices = Lib.shuffle([names(o)].concat(picks), rng);
      }
      out.push(q);
    }
    return out;
  }
  // Was a tap on the dome (fractions of its radius from the centre, x right, y down) on the object? Within a little way of it.
  function tapHit(o, tap) {
    var p = Sky.dome(o.alt, o.az);
    return Math.hypot(p.x - tap.x, p.y - tap.y) <= TAP_TOLERANCE;
  }
  // The visible object nearest a tap, or null.
  function nearest(vis, tap) {
    var best = null, d = Infinity;
    vis.forEach(function (o) { var p = Sky.dome(o.alt, o.az), k = Math.hypot(p.x - tap.x, p.y - tap.y); if (k < d) { d = k; best = o; } });
    return best;
  }

  root.SkyDetectiveEngine = { guessPlace: guessPlace, isNight: isNight, momentFor: momentFor, visibleObjects: visibleObjects, makeQuestions: makeQuestions, tapHit: tapHit, nearest: nearest, nameOf: nameOf, sunAlt: sunAlt, QUESTIONS: QUESTIONS };
  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  Play.applyTheme();
  var BEST_KEY = 'zimi.games.skydetective.best', PLACE_KEY = 'zimi.games.skydetective.place', GPS_MS = 8000;
  var els = { where: $('sk-where'), dome: $('sk-dome'), q: $('sk-q'), choices: $('sk-choices'), msg: $('sk-msg'), fact: $('sk-fact'), read: $('sk-read'), look: $('sk-look'), sky: $('sk-sky'), next: $('sk-next'), score: $('sk-score'), newBtn: $('sk-new') };
  var status = Play.status(els.msg), ctx = els.dome.getContext('2d');
  var wikiZim = '', g = null, vis = [], all = [], pending = { where: 'guess', when: 'tonight' }, cursor = 0, building = false, done = false;
  var PLANET_COLOR = { mercury: '#b9b4a8', venus: '#fff4c8', mars: '#ff7a4a', jupiter: '#f2d9a8', saturn: '#e6cf8a' };
  var SKY_TOP = '#0b1226', SKY_EDGE = '#1c2748', STAR = '#f4f6ff', RING = '#f59e0b';

  var el = root.ZimiUtil.el;
  function has(k) { return root.ZimiText && root.ZimiText.has ? root.ZimiText.has(k) : false; }
  function name(o) { return nameOf(o, T); }
  function q() { return g.qs[g.at]; }
  function target() { var id = q().id; return vis.filter(function (o) { return o.id === id; })[0]; }

  // ── drawing ──
  function size() { var w = Math.max(240, Math.round(els.dome.getBoundingClientRect().width)), dpr = root.devicePixelRatio || 1; els.dome.width = Math.round(w * dpr); els.dome.height = Math.round(w * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); return w; }
  function pt(o, w) { var p = Sky.dome(o.alt, o.az), r = w / 2 - 22; return { x: w / 2 + p.x * r, y: w / 2 + p.y * r, r: r }; }
  function moon(c, o) {
    var R = 9, k = o.illumination, lit = '#ecebdc', dark = '#2a3350';
    ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = lit; ctx.beginPath();
    var rx = Math.abs(1 - 2 * k) * R;
    ctx.arc(c.x, c.y, R, -Math.PI / 2, Math.PI / 2, o.waxing ? false : true);
    ctx.ellipse(c.x, c.y, rx, R, 0, Math.PI / 2, -Math.PI / 2, o.waxing === (k < 0.5));
    ctx.fill();
  }
  function draw(reveal) {
    var w = size(), cx = w / 2, R = w / 2 - 22;
    ctx.clearRect(0, 0, w, w);
    var grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, R + 22); grad.addColorStop(0, SKY_TOP); grad.addColorStop(1, SKY_EDGE);
    ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(cx, cx, w / 2, 0, 2 * Math.PI); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1;
    [1 / 3, 2 / 3].forEach(function (f) { ctx.beginPath(); ctx.arc(cx, cx, R * f, 0, 2 * Math.PI); ctx.stroke(); });
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cx, R, 0, 2 * Math.PI); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = '600 13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    [['n', 0, -1], ['e', -1, 0], ['s', 0, 1], ['w', 1, 0]].forEach(function (d) { ctx.fillText(T('sky.dir.' + d[0]), cx + d[1] * (R + 12), cx + d[2] * (R + 12)); });
    vis.slice().sort(function (a, b) { return b.mag - a.mag; }).forEach(function (o) {
      var c = pt(o, w);
      if (o.kind === 'star') { ctx.fillStyle = STAR; ctx.globalAlpha = Math.min(1, 0.55 + (2.2 - o.mag) * 0.25); ctx.beginPath(); ctx.arc(c.x, c.y, 1.3 + Math.max(0, 2.2 - o.mag) * 1.15, 0, 2 * Math.PI); ctx.fill(); ctx.globalAlpha = 1; }
      else if (o.kind === 'planet') { ctx.fillStyle = PLANET_COLOR[o.id]; ctx.beginPath(); ctx.arc(c.x, c.y, 4.5, 0, 2 * Math.PI); ctx.fill(); }
      else moon(c, o);
    });
    if (g && g.study) nameAll(w);
    var t = g && !done && !g.study ? target() : null;
    if (t && (q().kind === 'name' || reveal)) {
      var c = pt(t, w); ctx.strokeStyle = RING; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(c.x, c.y, 15, 0, 2 * Math.PI); ctx.stroke();
      if (reveal) { ctx.fillStyle = '#fff'; ctx.textAlign = c.x > w / 2 ? 'right' : 'left'; ctx.fillText(name(t), c.x + (c.x > w / 2 ? -20 : 20), c.y - 20); }
    }
    if (g && g.tap && reveal) { var s = { x: cx + g.tap.x * R, y: cx + g.tap.y * R }; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(s.x - 6, s.y - 6); ctx.lineTo(s.x + 6, s.y + 6); ctx.moveTo(s.x + 6, s.y - 6); ctx.lineTo(s.x - 6, s.y + 6); ctx.stroke(); }
    if (g && !reveal && q() && q().kind === 'find' && cursorOn) {
      var f = vis[cursor % vis.length], p = pt(f, w); ctx.strokeStyle = '#fff'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x, p.y, 13, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  var cursorOn = false;

  // The study's dome: every object named, each label beside its object, inside the dome and clear of the others (brightest first).
  var LABEL_PX = 12, LABEL_GAP = { star: 6, planet: 9, moon: 13 }, LABEL_HALF_H = 8, LABEL_EDGE = 4;
  function nameAll(w) {
    ctx.font = '600 ' + LABEL_PX + 'px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.lineWidth = 3;
    var taken = [], rim = w / 2 - LABEL_EDGE, mid = w / 2;
    vis.slice().sort(function (a, b) { return a.mag - b.mag; }).forEach(function (o) {
      var c = pt(o, w), text = name(o), tw = ctx.measureText(text).width, gap = LABEL_GAP[o.kind] || LABEL_GAP.star;
      [1, -1].some(function (side) {
        var x0 = side > 0 ? c.x + gap : c.x - gap - tw, box = { x0: x0, x1: x0 + tw, y0: c.y - LABEL_HALF_H, y1: c.y + LABEL_HALF_H };
        var inside = [[box.x0, box.y0], [box.x0, box.y1], [box.x1, box.y0], [box.x1, box.y1]].every(function (p) { return Math.hypot(p[0] - mid, p[1] - mid) <= rim; });
        if (!inside || taken.some(function (t) { return box.x0 < t.x1 && box.x1 > t.x0 && box.y0 < t.y1 && box.y1 > t.y0; })) return false;
        taken.push(box);
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.strokeText(text, x0, c.y); ctx.fillStyle = 'rgba(240,244,252,0.92)'; ctx.fillText(text, x0, c.y);
        return true;
      });
    });
  }

  // ── studying the sky first ──
  // Before the first question: tonight's sky for the place, to look at. Inside Zimi the Almanac's own sky opens over the page
  // (names on, drag and pinch); the page's own dome, named, is always here under it and is the whole study anywhere else.
  function skyAsk(extra) {
    var m = { zimi: 'game-sky', place: { lat: g.place.lat, lon: g.place.lon }, ms: g.ms, title: T('sky.over', { where: placeText(), when: whenText() }), hint: T('sky.study.hint'), close: T('shell.close') };
    return Lib.tell(Object.assign(m, extra));
  }
  function study(auto) {
    els.where.textContent = T('sky.over', { where: placeText(), when: whenText() });
    els.q.textContent = T('sky.study.lead');
    els.choices.innerHTML = ''; els.choices.hidden = true;
    els.fact.hidden = els.read.hidden = els.sky.hidden = true; status.say(''); paintScore();
    els.next.hidden = false; els.next.textContent = T('shell.start');
    els.look.hidden = !Lib.hosted(); els.look.textContent = T('sky.study.open');
    draw(false);
    if (auto) skyAsk({ start: T('shell.start') });
  }
  function begin() {
    if (!g || !g.study) return;
    g.study = false; cursor = 0; ask();
  }
  // An answer, seen again in the real sky: the view turned to it and ringed.
  function skyShow(t) { skyAsk({ title: name(t), az: t.az, alt: t.alt, fov: SHOW_FOV, ring: true }); }

  // ── the round ──
  function whenText() {
    var d = new Date(g.ms);
    try { return new Intl.DateTimeFormat(Lib.uiLang(), { weekday: 'long', hour: 'numeric', minute: '2-digit' }).format(d); } catch (e) { return d.toLocaleString(); }
  }
  function placeText() {
    var lat = T(g.place.lat >= 0 ? 'sky.lat.N' : 'sky.lat.S', { n: Play.num(Math.round(Math.abs(g.place.lat))) });
    return g.place.kind === 'gps' ? T('sky.here', { lat: lat }) : T('sky.near', { lat: lat });
  }
  function paintScore() { els.score.textContent = g ? T('round.score', { n: g.score }) : ''; }
  function ask() {
    var x = q(), answered = g.ans !== null && g.ans !== undefined;
    els.where.textContent = T('sky.over', { where: placeText(), when: whenText() });
    els.q.textContent = x.kind === 'name' ? T('sky.whatIsThis', { n: g.at + 1, total: g.qs.length }) : T('sky.find', { name: name(target()), n: g.at + 1, total: g.qs.length });
    els.choices.innerHTML = ''; els.choices.hidden = x.kind !== 'name';
    if (x.kind === 'name') {
      x.choices.forEach(function (c, i) {
        var b = el('button', 'rk-choice'); b.type = 'button'; b.dataset.i = i;
        b.appendChild(el('span', 'rk-num', Play.num(i + 1))); b.appendChild(el('span', 'rk-text', c)); els.choices.appendChild(b);
      });
    }
    els.fact.hidden = els.read.hidden = els.next.hidden = els.look.hidden = els.sky.hidden = true; status.say(''); paintScore();
    draw(false);
    if (answered) showAnswer(); else if (x.kind === 'find') status.say(T('sky.tapIt'));
  }
  function finishAnswer(ok, said) {
    var t = target();
    if (ok) g.score++;
    status.say(ok ? T('round.right') : said);
    var k = 'sky.fact.' + t.id;
    if (t.kind === 'moon') els.fact.textContent = T('sky.fact.moon', { n: Math.round(t.illumination * 100) });
    else els.fact.textContent = has(k) ? T(k) : '';
    els.fact.hidden = !els.fact.textContent;
    if (wikiZim) {
      var title = t.kind === 'star' ? t.name : T('sky.article.' + t.id);
      Lib.pageHead(wikiZim, [title.replace(/ /g, '_')], 64).then(function (got) { if (got && q() && target() === t) { Lib.articleLink(els.read, wikiZim, got.path); els.read.textContent = T('round.read', { answer: name(t) }); els.read.hidden = false; } });
    }
    els.sky.hidden = !Lib.hosted(); els.sky.textContent = T('sky.study.again');
    els.next.hidden = false; els.next.textContent = T(g.at + 1 >= g.qs.length ? 'round.seeScore' : 'round.next'); els.next.focus();
    paintScore(); draw(true);
  }
  function showAnswer() {   // an answer already given, drawn again (after leaving and returning)
    var x = q(), t = target(), ok;
    if (x.kind === 'name') { ok = x.choices[g.ans] === x.answer; var b = els.choices.children; for (var k = 0; k < b.length; k++) { b[k].disabled = true; if (x.choices[k] === x.answer) b[k].classList.add('right'); } if (!ok && b[g.ans]) b[g.ans].classList.add('wrong'); }
    else ok = tapHit(t, g.tap);
    g.score -= ok ? 1 : 0;   // finishAnswer counts it again
    finishAnswer(ok, x.kind === 'name' ? T('round.itWas', { answer: x.answer }) : T('sky.itWasHere', { name: name(t) }));
  }
  function chooseName(i) {
    if (g.study || g.ans !== null && g.ans !== undefined || q().kind !== 'name') return;
    g.ans = i; var x = q(), b = els.choices.children, ok = x.choices[i] === x.answer;
    for (var k = 0; k < b.length; k++) { b[k].disabled = true; if (x.choices[k] === x.answer) b[k].classList.add('right'); }
    if (!ok) b[i].classList.add('wrong');
    finishAnswer(ok, T('round.itWas', { answer: x.answer }));
  }
  function tapDome(e) {
    if (g.study || g.ans !== null && g.ans !== undefined || q().kind !== 'find' || done) return;
    var r = els.dome.getBoundingClientRect(), R = r.width / 2 - 22;
    var tap = { x: (e.clientX - r.left - r.width / 2) / R, y: (e.clientY - r.top - r.height / 2) / R };
    answerFind(tap);
  }
  function answerFind(tap) {
    g.ans = 1; g.tap = tap;
    var t = target(), ok = tapHit(t, tap);
    finishAnswer(ok, T('sky.itWasHere', { name: name(t) }));
  }
  function advance() {
    if (g.ans === null || g.ans === undefined) return;
    if (g.at + 1 >= g.qs.length) return finish();
    g.at++; g.ans = null; g.tap = null; cursorOn = false; ask();
  }
  function finish() {
    done = true; var best = Play.load(BEST_KEY, {}), mine = best.score || 0;
    if (g.score > mine) { best.score = g.score; Play.save(BEST_KEY, best); }
    var line = T('round.verdict.' + Lib.verdict(g.score, g.qs.length));
    status.say(line); draw(false);
    ZimiShell.endSheet({ result: 'over', text: line, stats: [[T('play.score'), T('round.of', { n: g.score, total: g.qs.length })], [T('play.best'), Play.num(Math.max(g.score, mine))]] });
  }

  // ── starting ──
  function placeNow() {
    var chosen = pending.where;
    var guess = guessPlace(Intl.DateTimeFormat().resolvedOptions().timeZone, new Date().getTimezoneOffset());
    if (chosen === 'n') return Promise.resolve({ lat: DEFAULT_LAT, lon: guess.lon, kind: 'guess' });
    if (chosen === 's') return Promise.resolve({ lat: SOUTH_LAT, lon: guess.lon, kind: 'guess' });
    if (chosen === 'gps' && navigator.geolocation) {
      return new Promise(function (ok) {
        navigator.geolocation.getCurrentPosition(function (p) { var pl = { lat: p.coords.latitude, lon: p.coords.longitude, kind: 'gps' }; Play.save(PLACE_KEY, pl); ok(pl); }, function () { ok(Play.load(PLACE_KEY, null) || guess); }, { timeout: GPS_MS, maximumAge: 3600000 });
      });
    }
    return Promise.resolve(chosen === 'gps' ? (Play.load(PLACE_KEY, null) || guess) : guess);
  }
  function start() {
    if (building) return; building = true; done = false;
    status.say(T('sky.looking'));
    placeNow().then(function (place) {
      var ms = momentFor(Date.now(), place.lat, place.lon, pending.when);
      vis = visibleObjects(ms, place.lat, place.lon); all = everyName(ms, place.lat, place.lon);
      var qs = makeQuestions(vis, all, QUESTIONS, Math.random, T);
      building = false;
      if (qs.length < 3) { status.say(T('sky.empty')); return; }
      g = { place: place, ms: ms, qs: qs, at: 0, score: 0, ans: null, tap: null, study: true };
      study(true);
    });
  }

  els.choices.addEventListener('click', function (e) { var b = e.target.closest('.rk-choice'); if (b) chooseName(+b.dataset.i); });
  els.dome.addEventListener('click', tapDome);
  els.dome.tabIndex = 0;
  els.dome.addEventListener('keydown', function (e) {
    if (!g || done || g.study || q().kind !== 'find' || (g.ans !== null && g.ans !== undefined)) return;
    var order = vis.slice().sort(function (a, b) { return a.az - b.az; });
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); cursorOn = true; var i = order.indexOf(vis[cursor % vis.length]); cursor = vis.indexOf(order[(i + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length]); draw(false); }
    else if (e.key === 'Enter' && cursorOn) { e.preventDefault(); var p = Sky.dome(vis[cursor % vis.length].alt, vis[cursor % vis.length].az); answerFind({ x: p.x, y: p.y }); }
  });
  els.next.addEventListener('click', function () { if (g && g.study) begin(); else advance(); });
  els.look.addEventListener('click', function () { if (g) skyAsk({ start: g.study ? T('shell.start') : '' }); });
  els.sky.addEventListener('click', function () { if (g && !g.study) skyShow(target()); });
  root.addEventListener('message', function (e) {   // the sky over the page was closed: with Start, the questions begin
    if (e.source !== root.parent || e.origin !== root.location.origin || !e.data || e.data.zimi !== 'game-sky-done') return;
    if (e.data.started) begin();
  });
  els.newBtn.addEventListener('click', start);
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || !g || document.querySelector('.ar-sheet:not([hidden])')) return;
    if (g.study) { if ((e.key === 'Enter' || e.key === ' ') && document.activeElement !== els.look && document.activeElement !== els.next) { e.preventDefault(); begin(); } return; }
    if (/^[1-4]$/.test(e.key) && q().kind === 'name') chooseName(+e.key - 1);
    else if ((e.key === 'Enter' || e.key === ' ') && g.ans !== null && g.ans !== undefined && document.activeElement !== els.read && document.activeElement !== els.dome) { e.preventDefault(); advance(); }
  });
  root.addEventListener('resize', function () { if (g) draw(g.ans !== null && g.ans !== undefined); });
  ZimiShell.game({
    about: function () { return T('sky.about'); },
    inProgress: function () { return !!g && !done && (g.at > 0 || g.ans !== null && g.ans !== undefined); },
    menu: function () {
      return { options: [
        Play.optionRow(T('sky.where'), [['guess', T('sky.where.guess')], ['gps', T('sky.where.gps')], ['n', T('sky.where.n')], ['s', T('sky.where.s')]], pending.where, function (v) { pending.where = v; }, 'pl-grid'),
        Play.optionRow(T('sky.when'), [['tonight', T('sky.when.tonight')], ['now', T('sky.when.now')]], pending.when, function (v) { pending.when = v; })
      ] };
    },
    stats: function () { var b = Play.load(BEST_KEY, {}); return b.score ? [[T('play.best'), T('round.of', { n: b.score, total: QUESTIONS })]] : []; }
  });

  Lib.library().then(function (list) {
    var a = Lib.pickZim(list, 'wikipedia', Lib.uiLang());
    wikiZim = a && Lib.primaryLang(a.zim.language) === 'en' ? a.zim.name : '';
    var kept = ZimiShell.saved();
    if (kept && kept.g && kept.g.qs && kept.g.qs.length) {
      g = kept.g; vis = visibleObjects(g.ms, g.place.lat, g.place.lon); all = everyName(g.ms, g.place.lat, g.place.lon);
      // A round kept before the study existed (no study flag) and not yet answered starts with the study, as a new one does.
      if (!('study' in g) && g.at === 0 && (g.ans === null || g.ans === undefined)) g.study = true;
      if (g.study) study(false); else ask();
    } else { if (kept) ZimiShell.forget(); start(); }
  });
  ZimiShell.persist({ save: function () { return g && !done ? { g: g } : null; } });
  root.__sky = { get g() { return g; }, get vis() { return vis; }, get zim() { return wikiZim; } };
})(this);
