/* ZimiGames: Zimi Pet, a small creature to look after. Our own code and art, GPL-3.0. No network, no modules.
   An egg hatches, and Mip needs a meal, a game, a wash and some sleep. It grows up over real days: the page works out
   what happened while it was closed from the time you last looked (nothing runs in the background). Nothing ever
   dies: a neglected Mip sulks and turns away, and comes round again once you care for it.
   The rules are pure functions of a pet and a clock (no DOM) so node can test them; the page draws it at 120 x 120. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var HOUR = 3600000, MIN = 60000;
  var EGG_MS = 3 * MIN;                       // an egg hatches three minutes after it is found
  var CHUNK_MS = 15 * MIN, MAX_AWAY_MS = 60 * 24 * HOUR;   // time is worked out in quarter hours, up to sixty days at a go
  // How fast things change, per hour. food, joy, clean and energy are 0 to 100; asleep, energy comes back.
  var RATES = { awake: { food: 2.4, joy: 1.8, clean: 1.2, energy: 2.2 }, asleep: { food: 0.6, joy: 0.3, clean: 0.3, energy: -10 } };
  var POOP_EVERY_H = 4, MAX_MESS = 3, MESS_CLEAN_H = 1.0, NAP_MIN_H = 2, NIGHT_FROM = 22, NIGHT_TO = 7;
  var STAGES = ['egg', 'baby', 'child', 'teen', 'adult'];
  var GROWTH_H = { child: 24, teen: 72, adult: 168 };   // hours of being looked after to reach each stage
  var SULK_AVG = 25, RECOVER_AVG = 40, RECOVER_MIN = 10, BRIGHT_CARE = 60, TIRED = 15, FULL = 90, MAX_SNACKS = 3;
  var MEAL = { food: 35, joy: 3 }, SNACK = { food: 12, joy: 12 }, GAME = { joy: 8, perWin: 8, energy: 10, food: 5 }, ROUNDS = 5;
  var NAMES = ['Mip', 'Pib', 'Nub', 'Tuft', 'Bim', 'Pom'];
  var MAX_PETS = 3;

  var clamp = root.ZimiUtil.clamp;
  var mulberry = root.ZimiUtil.mulberry32;

  function newPet(now, name, id) {
    return { id: id || String(now), name: name || NAMES[0], stage: 'egg', born: now, hatched: 0, t: now, food: 70, joy: 70, clean: 100, energy: 100, mess: 0, messAcc: 0,
      asleep: false, bed: false, bedKey: '', sleptH: 0, growth: 0, careAcc: 0, form: null, sulking: false, snacks: 0, meals: 0, games: 0 };
  }
  function average(p) { return (p.food + p.joy + p.clean + p.energy) / 4; }
  function lowest(p) { return Math.min(p.food, p.joy, p.clean, p.energy); }
  function ageDays(p, now) { return p.hatched ? Math.floor((now - p.hatched) / (24 * HOUR)) + 1 : 0; }
  // How it looks right now: 'egg', 'sleep', 'sulk', 'sad', 'ok' or 'happy'.
  function mood(p) {
    if (p.stage === 'egg') return 'egg';
    if (p.asleep) return 'sleep';
    if (p.sulking) return 'sulk';
    var a = average(p);
    return a < 45 || lowest(p) < 15 ? 'sad' : a >= 75 ? 'happy' : 'ok';
  }
  // The thing that most needs doing, or null.
  function need(p) {
    if (p.stage === 'egg') return null;
    if (p.asleep) return null;
    if (p.mess > 0 && p.clean < 40) return 'clean';
    var order = [['food', 'feed'], ['energy', 'sleep'], ['clean', 'clean'], ['joy', 'play']], worst = null, wv = 50;
    order.forEach(function (o) { if (p[o[0]] < wv) { wv = p[o[0]]; worst = o[1]; } });
    return worst;
  }

  function stageFor(growthH) { return growthH >= GROWTH_H.adult ? 'adult' : growthH >= GROWTH_H.teen ? 'teen' : growthH >= GROWTH_H.child ? 'child' : 'baby'; }

  // `h` hours go by.
  function stepHours(p, h, ev) {
    var r = p.asleep ? RATES.asleep : RATES.awake;
    p.food = clamp(p.food - r.food * h, 0, 100); p.joy = clamp(p.joy - r.joy * h, 0, 100);
    p.clean = clamp(p.clean - (r.clean + (p.asleep ? 0.3 : MESS_CLEAN_H) * p.mess) * h, 0, 100);
    p.energy = clamp(p.energy - r.energy * h, 0, 100);
    if (!p.asleep && p.food > 15 && p.mess < MAX_MESS) {
      p.messAcc += h;
      while (p.messAcc >= POOP_EVERY_H && p.mess < MAX_MESS) { p.messAcc -= POOP_EVERY_H; p.mess++; ev.push('mess'); }
    }
    if (p.asleep) { p.sleptH += h; if (!p.bed && p.energy >= 100 && p.sleptH >= NAP_MIN_H) { p.asleep = false; p.sleptH = 0; ev.push('woke'); } }
    else if (p.energy <= 5) { p.asleep = true; p.sleptH = 0; ev.push('dozed'); }
    var avg = average(p);
    if (!p.sulking && (lowest(p) <= 0 || avg < SULK_AVG)) { p.sulking = true; ev.push('sulk'); }
    else if (p.sulking && lowest(p) > RECOVER_MIN && avg >= RECOVER_AVG) { p.sulking = false; ev.push('recovered'); }
    if (!p.sulking) {
      p.growth += h; p.careAcc += avg * h;
      var s = stageFor(p.growth);
      if (s !== p.stage && STAGES.indexOf(s) > STAGES.indexOf(p.stage)) {
        p.stage = s; ev.push('grew:' + s);
        if (s === 'adult') p.form = p.careAcc / p.growth >= BRIGHT_CARE ? 'bright' : 'plain';
      }
    }
  }

  // Bring a pet up to `now`. Returns what happened: 'hatched', 'mess', 'dozed', 'woke', 'sulk', 'recovered', 'grew:<stage>'.
  function advance(p, now) {
    var ev = [];
    if (now < p.t) { p.t = now; return ev; }    // the clock went backwards: nothing happens
    if (p.stage === 'egg') {
      if (now - p.born < EGG_MS) { p.t = now; return ev; }
      p.stage = 'baby'; p.hatched = p.born + EGG_MS; p.t = p.hatched; p.growth = 0; ev.push('hatched');
    }
    var left = Math.min(now - p.t, MAX_AWAY_MS);
    while (left > 0) {
      var c = Math.min(left, CHUNK_MS), mid = p.t + c / 2, night = Engine.isNight(mid), key = nightKey(mid);
      // it goes to bed once each night, by itself, and wakes in the morning (you may put the lights on early)
      if (night && !p.asleep && p.bedKey !== key && p.stage !== 'egg') { p.asleep = true; p.bed = true; p.bedKey = key; p.sleptH = 0; ev.push('bed'); }
      if (!night && p.asleep && p.bed && p.sleptH >= NAP_MIN_H) { p.asleep = false; p.bed = false; p.sleptH = 0; ev.push('woke'); }
      stepHours(p, c / HOUR, ev); left -= c; p.t += c;
    }
    p.t = now;
    return ev;
  }
  // Night is 22:00 to 07:00 where the pet lives (the device's own clock).
  function isNight(ts) { var h = new Date(ts).getHours(); return h >= NIGHT_FROM || h < NIGHT_TO; }
  // One key for each night (a night that runs past midnight is still the same night: it is dated by its evening,
  // twelve hours before the morning that ends it, so a night of any length between noon and noon keeps one key).
  function nightKey(ts) { return new Date(ts - 12 * HOUR).toDateString(); }

  // Where the pet lives, if Zimi knows (the Almanac's chosen place, kept by the page that holds this one): night is then
  // the Sun's, from its real sunset to its real sunrise, with the same formulas as the Almanac (_solarB, _solarDeclination,
  // _eqOfTime in almanac.js; 90.833 degrees is refraction and the Sun's radius). Where the Sun does not set or rise that
  // day, or there is no place, the fixed hours above stand.
  var BED_EARLIEST_MIN = 19 * 60, WAKE_LATEST_MIN = 8 * 60, PLACE_KEY = 'zimi_almanac_place', SUN_HORIZON = 90.833, DAY_MS = root.ZimiUtil.DAY_MS, DEG = Math.PI / 180;
  function sunNight(place) {
    var lat = place ? Number(place.lat) : NaN, lon = place ? Number(place.lon) : NaN;
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return function (ts) {
      var solar = ts + lon * 4 * MIN, day = Math.floor(solar / DAY_MS), minutes = (solar - day * DAY_MS) / MIN;   // the place's own mean solar time
      var d = new Date(day * DAY_MS), doy = Math.floor((day * DAY_MS - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS) + 1, B = (doy - 1) * 2 * Math.PI / 365;
      var decl = 0.006918 - 0.399912 * Math.cos(B) + 0.070257 * Math.sin(B) - 0.006758 * Math.cos(2 * B) + 0.000907 * Math.sin(2 * B) - 0.002697 * Math.cos(3 * B) + 0.00148 * Math.sin(3 * B);
      var eot = 229.18 * (0.000075 + 0.001868 * Math.cos(B) - 0.032077 * Math.sin(B) - 0.014615 * Math.cos(2 * B) - 0.04089 * Math.sin(2 * B));
      var cosHA = (Math.cos(SUN_HORIZON * DEG) - Math.sin(lat * DEG) * Math.sin(decl)) / (Math.cos(lat * DEG) * Math.cos(decl));
      if (cosHA > 1 || cosHA < -1) return isNight(ts);
      var ha = Math.acos(cosHA) / DEG * 4, noon = 720 - eot;
      // Bed at the real sunset but not before 19:00, up at sunrise but not after 08:00: a winter night is not fifteen hours.
      return minutes < Math.min(noon - ha, WAKE_LATEST_MIN) || minutes >= Math.max(noon + ha, BED_EARLIEST_MIN);
    };
  }
  // Use the place kept in `storage` (a localStorage), if there is one. Returns whether the Sun now decides.
  function usePlace(storage) {
    var place = null, fn;
    try { place = JSON.parse(storage.getItem(PLACE_KEY)); } catch (e) { /* none kept */ }
    fn = sunNight(place);
    Engine.isNight = fn || isNight;
    return !!fn;
  }

  // ── what you can do ── each returns { ok, msg } and changes the pet when ok
  function feed(p, kind) {
    if (p.stage === 'egg') return { ok: false, msg: 'egg' };
    if (p.asleep) return { ok: false, msg: 'asleep' };
    if (p.food >= FULL) return { ok: false, msg: 'full' };
    if (kind === 'snack') {
      if (p.snacks >= MAX_SNACKS) return { ok: false, msg: 'snacks' };
      p.snacks++; p.food = clamp(p.food + SNACK.food, 0, 100); p.joy = clamp(p.joy + SNACK.joy, 0, 100);
    } else { p.snacks = 0; p.meals++; p.food = clamp(p.food + MEAL.food, 0, 100); p.joy = clamp(p.joy + MEAL.joy, 0, 100); }
    return { ok: true, msg: kind === 'snack' ? 'snack' : 'meal' };
  }
  // wins: how many of the five rounds of the little game were won
  function play(p, wins) {
    if (p.stage === 'egg') return { ok: false, msg: 'egg' };
    if (p.asleep) return { ok: false, msg: 'asleep' };
    if (p.sulking) return { ok: false, msg: 'sulk' };
    if (p.energy < TIRED) return { ok: false, msg: 'tired' };
    p.games++; p.joy = clamp(p.joy + GAME.joy + GAME.perWin * clamp(wins, 0, ROUNDS), 0, 100);
    p.energy = clamp(p.energy - GAME.energy, 0, 100); p.food = clamp(p.food - GAME.food, 0, 100);
    return { ok: true, msg: 'played' };
  }
  function wash(p) {
    if (p.stage === 'egg') return { ok: false, msg: 'egg' };
    if (p.asleep) return { ok: false, msg: 'asleep' };
    p.mess = 0; p.messAcc = 0; p.clean = 100;
    return { ok: true, msg: 'clean' };
  }
  function lights(p) {
    if (p.stage === 'egg') return { ok: false, msg: 'egg' };
    p.asleep = !p.asleep; p.sleptH = 0; p.bed = false; p.bedKey = nightKey(p.t);
    return { ok: true, msg: p.asleep ? 'sleep' : 'wake' };
  }
  // One round of the little game: Mip looks left or right and you guess which.
  function round(rng, guess) { var look = rng() < 0.5 ? 'left' : 'right'; return { look: look, win: look === guess }; }

  // The device's pets: a list (up to three) and which one is showing.
  function newStore(now) { return { v: 1, pets: [newPet(now, NAMES[0], 'p1')], active: 0 }; }
  function addPet(store, now) {
    if (store.pets.length >= MAX_PETS) return null;
    var used = store.pets.map(function (p) { return p.name; }), name = NAMES.filter(function (n) { return used.indexOf(n) < 0; })[0] || NAMES[0], p = newPet(now, name, 'p' + (store.pets.length + 1) + '-' + now);
    store.pets.push(p); store.active = store.pets.length - 1;
    return p;
  }
  function validStore(s) { return !!(s && s.v === 1 && Array.isArray(s.pets) && s.pets.length && s.pets.length <= MAX_PETS && s.pets.every(function (p) { return p && STAGES.indexOf(p.stage) >= 0 && typeof p.t === 'number' && typeof p.food === 'number'; })); }
  function cleanName(text) { var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 12); return t || NAMES[0]; }
  var Engine = { isNight: isNight, nightKey: nightKey, sunNight: sunNight, usePlace: usePlace, HOUR: HOUR, MIN: MIN, EGG_MS: EGG_MS, RATES: RATES, GROWTH_H: GROWTH_H, STAGES: STAGES, ROUNDS: ROUNDS, MAX_PETS: MAX_PETS, MAX_MESS: MAX_MESS, NAMES: NAMES, newPet: newPet, advance: advance, feed: feed, play: play, wash: wash, lights: lights, round: round,
    mood: mood, need: need, average: average, lowest: lowest, ageDays: ageDays, newStore: newStore, addPet: addPet, validStore: validStore, cleanName: cleanName, mulberry: mulberry, MAX_AWAY_MS: MAX_AWAY_MS, MAX_SNACKS: MAX_SNACKS };
  root.PetEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, Kit = root.PixelKit, $ = Play.$, T = Play.T;
  var SAVE_KEY = 'zimi.games.pet', SIZE = 120, CHROME_PX = 360, MAX_SCALE = 3, ROUND_COUNT = 5, SAVE_EVERY_MS = 30000;
  Play.applyTheme();
  // A pet is always under way: the shelf's tile shows it as you left it.
  ZimiShell.game({ inProgress: function () { return true; }, stats: function () { return [[T('pet.stats.pets'), Play.num(store.pets.length)], [T('pet.stats.meals'), Play.num(pet ? pet.meals : 0)], [T('pet.stats.games'), Play.num(pet ? pet.games : 0)]]; } });
  var els = { cv: $('pt-screen'), msg: $('pt-msg'), tabs: $('pt-tabs'), care: $('pt-actions'), name: $('pt-name'), age: $('pt-age'), egg: $('pt-egg'),
    bars: { food: $('pt-food'), joy: $('pt-joy'), clean: $('pt-wash'), energy: $('pt-energy') } };
  var line = Play.status(els.msg);
  var reduced = Play.reducedMotion(), ctx, store = Play.load(SAVE_KEY, null), pet, lastSave = 0, scale = 3, doing = null, rng = mulberry(Date.now());
  // The six first names are the language's own (a Mip in Latin letters inside a Chinese or Arabic page reads as a leftover).
  NAMES = NAMES.map(function (n, i) { var t = T('pet.name.' + i); return t === 'pet.name.' + i ? n : t; });
  if (!validStore(store)) store = newStore(Date.now());
  try { usePlace(root.localStorage); } catch (e) { /* no storage: the fixed hours */ }

  function now() { return Date.now(); }
  function current() { return store.pets[store.active]; }
  function save() { Play.save(SAVE_KEY, store); lastSave = now(); }
  function layout() { var f = Kit.fit(els.cv, SIZE, SIZE, CHROME_PX, MAX_SCALE); ctx = f.ctx; scale = f.scale; draw(); }

  // ── art ──
  var FORMS = {
    baby: { w: 14, h: 12, body: '#9be0ad', belly: '#d8f5e0', edge: '#2f6b48', ears: 0 },
    child: { w: 18, h: 16, body: '#6fd1c8', belly: '#cdf4ef', edge: '#1f6f68', ears: 3 },
    teen: { w: 22, h: 19, body: '#7aa8f0', belly: '#d3e3fb', edge: '#27508f', ears: 5 },
    adult: { w: 26, h: 22, body: '#ffc857', belly: '#fff0c4', edge: '#8a5a10', ears: 6 }
  };
  var PLAIN = { body: '#b4bccd', belly: '#e6e9f0', edge: '#4d5568' };
  function rect(x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); }
  function blob(cx, by, w, h, col, edge) {
    // a rounded body standing on y = by, centred on cx, edge-lined
    var top = by - h, r = Math.max(2, Math.floor(h / 4)), y;
    for (y = 0; y < h; y++) {
      var inset = y < r ? r - y : y >= h - 2 ? 1 : 0, x0 = cx - Math.floor(w / 2) + inset, ww = w - inset * 2;
      rect(x0, top + y, ww, 1, edge); rect(x0 + 1, top + y, ww - 2, 1, y === 0 || y === h - 1 ? edge : col);
    }
    return top;
  }
  function drawPet(p, bx, by) {
    var f = FORMS[p.stage], cols = p.stage === 'adult' && p.form === 'plain' ? PLAIN : f, m = mood(p), cx = bx;
    var bob = reduced || m === 'sleep' ? 0 : Math.floor(now() / 700) % 2;
    by -= bob;
    // ears and tail behind
    var top = by - f.h;
    if (f.ears) { rect(cx - f.w / 2 + 2, top - f.ears + 1, 4, f.ears, f.edge); rect(cx - f.w / 2 + 3, top - f.ears + 2, 2, f.ears - 1, cols.body); rect(cx + f.w / 2 - 6, top - f.ears + 1, 4, f.ears, f.edge); rect(cx + f.w / 2 - 5, top - f.ears + 2, 2, f.ears - 1, cols.body); }
    if (p.stage === 'teen') { rect(cx - 5, top - 2, 2, 2, '#ffd23f'); rect(cx + 3, top - 2, 2, 2, '#ffd23f'); }
    if (p.stage === 'adult' && p.form === 'bright') { rect(cx - 5, top - 3, 10, 2, '#ff7a3d'); rect(cx - 3, top - 5, 6, 2, '#ff7a3d'); }
    rect(cx + f.w / 2 - 1, by - 7, 4, 3, f.edge); rect(cx + f.w / 2, by - 7, 3, 2, cols.body);
    blob(cx, by, f.w, f.h, cols.body, cols.edge);
    // belly and feet
    var bw = Math.floor(f.w * 0.55), bh = Math.floor(f.h * 0.4);
    rect(cx - bw / 2, by - bh - 2, bw, bh, cols.belly);
    rect(cx - f.w / 2 + 2, by - 1, 4, 2, cols.edge); rect(cx + f.w / 2 - 6, by - 1, 4, 2, cols.edge);
    // face
    var ey = top + Math.floor(f.h * 0.34), ex1 = cx - Math.floor(f.w * 0.26), ex2 = cx + Math.floor(f.w * 0.26) - 2;
    if (m === 'sulk') {
      // turned away: just the back of the head, a little cloud over it
      rect(cx - 4, top + 3, 8, 2, cols.edge); rect(cx - 6, top - f.ears - 8, 12, 3, '#9aa3b8'); rect(cx - 4, top - f.ears - 10, 8, 3, '#9aa3b8'); rect(cx - 1, top - f.ears - 5, 1, 3, '#6fb3f2'); rect(cx + 2, top - f.ears - 4, 1, 2, '#6fb3f2');
      return;
    }
    if (m === 'sleep') { rect(ex1, ey + 1, 3, 1, '#1b2233'); rect(ex2, ey + 1, 3, 1, '#1b2233'); rect(cx - 1, ey + 4, 2, 1, '#1b2233'); }
    else {
      var blink = !reduced && Math.floor(now() / 300) % 14 === 0;
      if (blink) { rect(ex1, ey + 1, 3, 1, '#1b2233'); rect(ex2, ey + 1, 3, 1, '#1b2233'); }
      else { rect(ex1, ey, 2, 3, '#1b2233'); rect(ex2, ey, 2, 3, '#1b2233'); rect(ex1, ey, 1, 1, '#ffffff'); rect(ex2, ey, 1, 1, '#ffffff'); }
      var my = ey + 5;
      if (m === 'happy') { rect(cx - 2, my, 4, 1, '#1b2233'); rect(cx - 3, my - 1, 1, 1, '#1b2233'); rect(cx + 2, my - 1, 1, 1, '#1b2233'); rect(ex1 - 2, my - 1, 2, 1, '#f08a9a'); rect(ex2 + 2, my - 1, 2, 1, '#f08a9a'); }
      else if (m === 'sad') { rect(cx - 2, my, 4, 1, '#1b2233'); rect(cx - 3, my + 1, 1, 1, '#1b2233'); rect(cx + 2, my + 1, 1, 1, '#1b2233'); rect(ex1 + 1, ey + 4, 1, 2, '#6fb3f2'); }
      else rect(cx - 2, my, 4, 1, '#1b2233');
    }
    if (p.stage === 'adult' && p.form === 'bright') { rect(cx - 1, top + 3, 2, 1, '#ff7a3d'); rect(cx, top + 2, 1, 3, '#ff7a3d'); }
  }
  function drawEgg(p) {
    var age = now() - p.born, frac = clamp(age / EGG_MS, 0, 1), wob = reduced ? 0 : Math.round(Math.sin(now() / 140) * (frac > 0.6 ? 2 : frac > 0.3 ? 1 : 0)), cx = 60 + wob, by = 92, w = 22, h = 28, y;
    for (y = 0; y < h; y++) {
      var t = y / h, half = Math.round(Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.58) / 0.58, 2))) * (w / 2));
      rect(cx - half, by - h + y, half * 2, 1, '#2c3a52'); rect(cx - half + 1, by - h + y, Math.max(0, half * 2 - 2), 1, y % 7 < 3 ? '#fff4d6' : '#f7e4b4');
    }
    for (var s = 0; s < 6; s++) rect(cx - 7 + (s * 5) % 14, by - h + 7 + (s * 7) % 16, 3, 3, s % 2 ? '#f08a9a' : '#6fd1c8');
    if (frac > 0.5) { rect(cx - 3, by - 17, 2, 2, '#2c3a52'); rect(cx - 1, by - 15, 2, 2, '#2c3a52'); rect(cx + 1, by - 17, 2, 2, '#2c3a52'); }
    rect(cx - 8, by - 24, 3, 2, '#ffffff');
  }
  function drawMess(i) { var x = 18 + i * 30, y = 100 - (i % 2) * 4; rect(x, y, 10, 2, '#6b4325'); rect(x + 1, y - 2, 8, 2, '#8a5a35'); rect(x + 3, y - 4, 4, 2, '#8a5a35'); if (!reduced && Math.floor(now() / 500) % 2) { rect(x + 8, y - 6, 1, 1, '#3a2a10'); rect(x + 10, y - 5, 1, 1, '#3a2a10'); } }
  function drawFood(kind, t) { var fx = 60 + Math.round((1 - t) * 24), fy = 62 + Math.round((1 - t) * 8); if (kind === 'meal') { rect(fx - 4, fy, 8, 4, '#cfd8ea'); rect(fx - 3, fy - 2, 6, 3, '#e5484d'); } else { rect(fx - 2, fy, 5, 5, '#f5a524'); rect(fx - 1, fy + 1, 1, 1, '#ffffff'); } }
  function draw() {
    if (!ctx || !pet) return;
    var m = mood(pet), night = pet.asleep;
    // the room
    rect(0, 0, SIZE, 84, '#e7d5b8'); for (var i = 0; i < SIZE; i += 12) rect(i, 0, 6, 84, '#ddc9a8');
    rect(0, 84, SIZE, 36, '#b98a5a'); for (var j = 0; j < SIZE; j += 20) rect(j, 84, 1, 36, '#a37848'); rect(0, 84, SIZE, 2, '#8a6038');
    rect(76, 14, 28, 26, '#f4efe6'); rect(78, 16, 24, 22, night ? '#1b2650' : '#8fd0f5'); rect(89, 16, 2, 22, '#f4efe6'); rect(78, 26, 24, 2, '#f4efe6');
    if (night) { rect(82, 20, 1, 1, '#ffffff'); rect(96, 22, 1, 1, '#ffffff'); rect(94, 32, 1, 1, '#ffffff'); rect(83, 31, 2, 2, '#ffe9a8'); } else { rect(94, 19, 5, 5, '#ffd23f'); rect(83, 30, 7, 2, '#ffffff'); }
    rect(12, 20, 20, 16, '#cfa774'); rect(14, 22, 16, 12, '#f0d9a8');   // a little picture on the wall
    rect(18, 28, 8, 4, '#6fd1c8'); rect(20, 24, 4, 4, '#ffc857');
    for (var k = 0; k < pet.mess; k++) drawMess(k);
    if (pet.stage === 'egg') drawEgg(pet);
    else {
      drawPet(pet, 60, 96);
      if (doing) { var t = clamp((now() - doing.at) / doing.ms, 0, 1); if (doing.kind === 'meal' || doing.kind === 'snack') drawFood(doing.kind, t); }
      if (m === 'sleep') { var zo = reduced ? 0 : Math.floor(now() / 600) % 3; Kit.text(ctx, 'Z', 76 + zo * 2, 54 - zo * 3, '#ffffff', 2); Kit.text(ctx, 'Z', 86 + zo, 44 - zo * 2, '#dfe6f4', 1); }
      if (doing && doing.kind === 'wash' && !reduced) for (var b = 0; b < 8; b++) rect(40 + (b * 11) % 40, 50 + ((now() / 40 + b * 13) % 40), 3, 3, 'rgba(255,255,255,0.8)');
    }
    if (night) { ctx.fillStyle = 'rgba(10,14,50,0.45)'; ctx.fillRect(0, 0, SIZE, SIZE); }
  }

  // ── the page's state ──
  var BARS = ['food', 'joy', 'clean', 'energy'], LOW_BAR = 30;
  function say(text) { line.say(text); }
  // The care buttons that apply right now, in order: an egg needs none, a sleeper can only be woken, a sulking or tired pet is not asked to play.
  function careActions() {
    if (pet.stage === 'egg') return [];
    if (pet.asleep) return ['lights'];
    var out = ['feed'];
    if (!pet.sulking && pet.energy >= TIRED) out.push('play');
    return out.concat(['clean', 'lights']);
  }
  function hud() {
    if (!pet) return;
    els.name.textContent = pet.name; els.name.setAttribute('aria-label', T('pet.rename', { name: pet.name }));
    els.age.textContent = pet.stage === 'egg' ? T('pet.stage.egg') : T(pet.form === 'bright' ? 'pet.ageBright' : 'pet.age', { stage: T('pet.stage.' + pet.stage), n: ageDays(pet, now()) });
    BARS.forEach(function (k) { var el = els.bars[k], v = Math.round(pet[k]); el.style.setProperty('--v', v + '%'); el.setAttribute('aria-valuenow', String(v)); el.dataset.low = v < LOW_BAR ? '1' : '0'; });
    var egg = pet.stage === 'egg';
    els.egg.hidden = !egg;
    if (egg) els.egg.textContent = T('pet.hatchIn', { n: Math.max(1, Math.ceil((pet.born + EGG_MS - now()) / MIN)) });
    paintCare(); tabs();
  }
  var careKey = '';
  function paintCare() {
    var list = careActions(), key = list.join() + (pet.asleep ? 'z' : '');
    if (key === careKey) return;
    careKey = key; els.care.textContent = '';
    els.care.hidden = !list.length;
    list.forEach(function (id) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'ar-btn'; b.id = 'pt-' + id;
      b.textContent = T(id === 'lights' ? (pet.asleep ? 'pet.wake' : 'pet.sleep') : 'pet.' + id);
      b.addEventListener('click', ACT[id]); els.care.appendChild(b);
    });
  }
  // One pet each, as a segmented control, and a last segment that finds another egg while there is room.
  function tabs() {
    var seg = els.tabs; seg.textContent = '';
    store.pets.forEach(function (p, i) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'ar-btn'; b.textContent = p.stage === 'egg' ? T('pet.stage.egg') : p.name; b.setAttribute('aria-pressed', String(i === store.active));
      b.addEventListener('click', function () { store.active = i; pet = current(); careKey = ''; catchUp(); save(); say(''); });
      seg.appendChild(b);
    });
    if (store.pets.length < MAX_PETS) {
      var a = document.createElement('button'); a.type = 'button'; a.className = 'ar-btn'; a.textContent = T('pet.addEgg'); a.setAttribute('aria-pressed', 'false'); a.setAttribute('aria-label', T('pet.findEgg'));
      a.addEventListener('click', function () { addPet(store, now()); pet = current(); careKey = ''; save(); say(T('pet.foundEgg')); hud(); });
      seg.appendChild(a);
    }
  }
  function report(ev, away) {
    var out = [], n = pet.name;
    ev.forEach(function (e) {
      if (e.indexOf('grew:') === 0) out.push(T('pet.grew', { name: n, stage: T('pet.form.' + e.slice(5)) }));
      else if (e === 'hatched' || e === 'sulk' || e === 'recovered') out.push(T('pet.ev.' + e, { name: n }));
    });
    if (!out.length && away && ev.indexOf('mess') >= 0) out.push(T('pet.ev.mess', { name: n }));
    if (out.length) say(away ? T('pet.whileAway', { text: out.join(' ') }) : out.join(' '));
  }
  // Work out what happened since the last look (this is the whole of "time passes while the page is closed").
  function catchUp() {
    var t0 = pet.t, ev = advance(pet, now()), away = now() - t0 > 2 * MIN;
    if (ev.length) report(ev, away); else if (away && !els.msg.textContent) say(T('pet.glad', { name: pet.name }));
    hud();
  }

  // ── what a person does: choose a meal, play the game, give a name (each a sheet with one anatomy) ──
  function result(r) {
    if (!r.ok) { ZimiShell.shake(els.care); line.reason(T('pet.no.' + r.msg, { name: pet.name })); return; }
    say(T('pet.did.' + r.msg, { name: pet.name }));
  }
  function animate(kind, ms) { if (reduced) return; doing = { kind: kind, at: now(), ms: ms }; setTimeout(function () { if (doing && doing.kind === kind) doing = null; }, ms); }
  function after() { careKey = ''; save(); hud(); }
  var ACT = {
    feed: function () {
      catchUp();
      function eat(kind, ms) { var res = feed(pet, kind); result(res); if (res.ok) animate(kind, ms); after(); }
      ZimiShell.sheet({ title: T('pet.feedTitle', { name: pet.name }), text: T('pet.feedText'), actions: [{ label: T('pet.snack'), onclick: function () { eat('snack', 800); } }, { label: T('pet.meal'), primary: true, onclick: function () { eat('meal', 1000); } }] });
    },
    clean: function () { catchUp(); var res = wash(pet); result(res); if (res.ok) animate('wash', 1000); after(); },
    lights: function () { catchUp(); var res = lights(pet); result(res); after(); },
    play: function () {
      catchUp();
      var chk = pet.asleep ? 'asleep' : pet.sulking ? 'sulk' : pet.energy < TIRED ? 'tired' : null;
      if (chk) { result({ ok: false, msg: chk }); return; }
      var wins = 0, played = 0, sheet, statusP = document.createElement('p');
      statusP.setAttribute('role', 'status'); statusP.setAttribute('aria-live', 'polite'); statusP.className = 'gs-text';
      statusP.textContent = T('pet.round', { n: 1, total: ROUND_COUNT });
      function pick(g) {
        var res = round(rng, g); played++; if (res.win) wins++;
        statusP.textContent = T('pet.looked', { name: pet.name, side: T('pet.side.' + res.look), result: T(res.win ? 'pet.right' : 'pet.wrong') }) + (played < ROUND_COUNT ? ' ' + T('pet.round', { n: played + 1, total: ROUND_COUNT }) : '');
        if (played >= ROUND_COUNT) {
          var res2 = play(pet, wins), row = sheet.el.querySelector('.ar-sheet-actions'); row.textContent = '';
          statusP.textContent += ' ' + T('pet.score', { wins: wins, total: ROUND_COUNT });
          var done = document.createElement('button'); done.type = 'button'; done.className = 'ar-btn gs-primary'; done.setAttribute('aria-pressed', 'true'); done.textContent = T('shell.close');
          done.addEventListener('click', function () { sheet.close(); result(res2); animate('play', 600); after(); }); row.appendChild(done); done.focus();
        }
      }
      sheet = ZimiShell.sheet({ title: T('pet.playTitle', { name: pet.name }), text: T('pet.playText'), body: [statusP],
        actions: [{ label: T('play.left'), keep: true, onclick: function () { pick('left'); } }, { label: T('play.right'), keep: true, onclick: function () { pick('right'); } }] });
    }
  };
  els.name.addEventListener('click', function () {
    var inp = document.createElement('input'); inp.type = 'text'; inp.maxLength = 12; inp.value = pet.name; inp.className = 'pt-input'; inp.setAttribute('aria-label', T('pet.nameLabel'));
    var sheet = ZimiShell.sheet({ title: T('pet.nameTitle'), body: [inp], actions: [{ label: T('shell.cancel') }, { label: T('pet.save'), primary: true, keep: true, onclick: done }] });
    function done() { pet.name = cleanName(inp.value); sheet.close(); save(); hud(); }
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); done(); } });
  });

  // ── the clock: one look every second while the page is showing ──
  var tickT = 0;
  var loop = Play.loop(function (dt) {
    tickT += dt;
    if (tickT >= 1) { tickT = 0; var ev = advance(pet, now()); if (ev.length) report(ev, false); hud(); if (now() - lastSave > SAVE_EVERY_MS) save(); }
  }, function () { draw(); }, 20);
  Play.onHidden(function () { loop.stop(); save(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { catchUp(); save(); loop.start(); } });
  window.addEventListener('pagehide', save);
  window.addEventListener('resize', layout);

  pet = current(); layout(); catchUp(); save(); loop.start();
  root.__pet = { get store() { return store; }, get pet() { return pet; }, catchUp: catchUp, save: save, now: now };
})(this);
