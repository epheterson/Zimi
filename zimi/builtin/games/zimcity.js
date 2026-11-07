/* ZimCity: a city you build with your thumb. Our own code, GPL-3.0; the simulation is micropolisJS (GPL-3.0, see
   zimcity/ENGINE.md), and nothing here changes how it simulates.

   This file is the page: the city (made, kept and brought back), the clock that runs it, what the strip and the status
   line say, the tray, and the sheets (budget, report, layers, speed, inspect). The map is zimcity-view.js, the fingers
   zimcity-input.js and the tools zimcity-tools.js. */

import { Simulation } from './zimcity/engine/simulation.js';
import { MapGenerator } from './zimcity/engine/mapGenerator.js';
import * as Messages from './zimcity/engine/messages.js';
import { View, TILE } from './zimcity-view.js';
import { Input } from './zimcity-input.js';
import * as Tools from './zimcity-tools.js';
import * as Words from './zimcity-words.js';
import * as Library from './zimcity-library.js';
import * as Save from './zimcity-save.js';
import { advise, runningOut, LOW_RUNWAY_YEARS } from './zimcity-advisor.js';
import * as Scen from './zimcity-scenarios.js';
import * as Climate from './zimcity-climate.js';
import * as Voices from './zimcity-voices.js';
import * as Follow from './zimcity-follow.js';
import * as Away from './zimcity-away.js';
import { isWater } from './zimcity-modern.js';
import { budgetSheet, reportSheet, layersSheet, speedSheet, inspectSheet, moreSheet, citiesSheet, scenariosSheet, climateSheet, followSheet, awayCard, settingsRows, newGameRows, howExtra } from './zimcity-sheets.js';

var root = window, d = document, Shell = root.ZimiShell, Play = root.ArcadePlay, Util = root.ZimiUtil;
var T = function (k, v) { return root.ZimiText ? root.ZimiText.T(k, v) : k; };
var $ = function (id) { return d.getElementById(id); };

var MAP_W = Save.MAP_W, MAP_H = Save.MAP_H;
var START_SCALE = 2;                 // a tile 32 px wide on screen: a road is one finger wide
var STEPS_PER_SECOND = { 1: 10, 2: 20, 3: 60 };   // the engine's slow, normal and fast, as simulation steps a second
var MAX_STEPS_PER_FRAME = 4;
var FAST_FRAME_MS = 28;              // slower than this, held for FAST_PATIENCE_MS, and Fast is too much for this device
var FAST_PATIENCE_MS = 3000;
var FINGER_PX = 28;                  // a ghost dragged by a finger rides this far above the fingertip
var MESSAGE_MS = 4000;               // the least time one message stays before the next replaces it
var SAVE_EVERY_MS = 20000;
var SUMMARY_EVERY_MS = 5000;
var ADVISE_EVERY_MS = 1000;          // the advisor looks again each second (a survey of the map is about a millisecond)
var STATS_KEY = 'zimi.zimcity.stats';

// ── the city ──
var city = null;                     // { sim, map, tools, seed, level, won, broke, built }
var held = '';                       // the tool in hand ('' for none)
var stroke = null;                   // the tiles of the stroke under way
var paused = false, speed = Simulation.SPEED_MED, fastOK = true, layer = 'off', disasters = false, climateOn = true;
var awayPace = Away.DEFAULT_PACE, catching = null;   // While I'm away, and what happened while the city caught up
var pendingLevel = Simulation.LEVEL_EASY;

var view = new View($('cy-map'), { tiles: new Image(), sprites: new Image() });
view.art.tiles.src = 'zimcity/tiles.png';
view.art.sprites.src = 'zimcity/sprites.png';

function randomSeed() { return Math.floor(Math.random() * 4294967296); }
// The engine draws its maps with Math.random; a seed makes a map one can have again.
function seeded(seed, fn) {
  var real = Math.random;
  Math.random = Util.mulberry32(seed);
  try { return fn(); } finally { Math.random = real; }
}

function cityOf(map, sim, level, seed) {
  var c = { sim: sim, map: map, tools: Tools.makeTools(map), seed: seed, level: level, won: false, broke: false, built: false, climate: Climate.fresh() };
  sim.disasterManager.disastersEnabled = disasters;
  listen(sim);
  return c;
}
function freshCity(level) {
  var seed = randomSeed();
  var map = seeded(seed, function () { return MapGenerator(MAP_W, MAP_H); });
  return cityOf(map, new Simulation(map, level, speed === Simulation.SPEED_PAUSED ? Simulation.SPEED_MED : speed), level, seed);
}
function install(c, cam) {
  // A catch-up still running belongs to the city being left: stop it and its sheet, so it never steps this one.
  if (awayJob) { var job = awayJob; awayJob = null; job.cancel(); if (awayWait) awayWait.close(); }
  awayWait = null; catching = null;
  if (held) Tools.drop(city, held);
  city = c; stroke = null; lastBuilt = null; undoBtn.disabled = true;
  city.bornAt = city.sim._cityTime;   // the census is measured afresh from here (complaints and news wait for it)
  unfollow();
  city.sim.setSpeed(speed === Simulation.SPEED_PAUSED ? Simulation.SPEED_MED : speed);
  view.setCity(city);
  view.resize();
  if (cam) { view.cam.x = cam.x; view.cam.y = cam.y; view.cam.s = cam.s; view.clamp(); }
  else { view.cam.s = START_SCALE; centreOnLand(); }
  messages.length = 0; status.say(''); shownAt = 0; shownLine = '';   // nothing of the last city is left on the line
  strip();
  advice = null; advisor();
}
// A new city opens over its best land: the window big enough for a first town (24 x 16 tiles) with the most ground to
// build on (clear ground counts most, woods a little less since they cost a dollar to clear, water nothing), the middle
// of the map winning a tie; never an island in a lake.
var START_W = 24, START_H = 16;
function centreOnLand() {
  var map = city.map, best = null, clear = [];
  for (var y = 0; y < MAP_H; y++) { clear[y] = []; for (var x = 0; x < MAP_W; x++) { var v = map.getTileValue(x, y); clear[y][x] = v === 0 ? 1 : isWater(v) ? 0 : 0.7; } }
  // a summed-area table answers "how much clear ground in this box" at once for every box
  var sum = [];
  for (y = 0; y <= MAP_H; y++) { sum[y] = []; for (x = 0; x <= MAP_W; x++) sum[y][x] = y && x ? clear[y - 1][x - 1] + sum[y - 1][x] + sum[y][x - 1] - sum[y - 1][x - 1] : 0; }
  for (y = 0; y + START_H <= MAP_H; y += 2) {
    for (x = 0; x + START_W <= MAP_W; x += 2) {
      var open = sum[y + START_H][x + START_W] - sum[y][x + START_W] - sum[y + START_H][x] + sum[y][x];
      var score = open - Math.hypot(x + START_W / 2 - MAP_W / 2, y + START_H / 2 - MAP_H / 2) / 8;
      if (!best || score > best.score) best = { x: x + START_W / 2, y: y + START_H / 2, score: score };
    }
  }
  view.centreOn(best.x, best.y);
  view.keepInside();
}

// ── what the engine says ──
var unlisten = [];
function listen(sim) {
  unlisten.forEach(function (f) { f(); });
  unlisten = [];
  function on(ev, fn) { sim.addEventListener(ev, fn); unlisten.push(function () { sim.removeEventListener(ev, fn); }); }
  on(Messages.FUNDS_CHANGED, strip);
  on(Messages.DATE_UPDATED, strip);
  on(Messages.POPULATION_UPDATED, strip);
  on(Messages.VALVES_UPDATED, demand);
  // The year's budget: asked once the moment has passed, unless the city has just gone broke (its sheet asks after it).
  on(Messages.BUDGET_NEEDED, function () { if (catching) { catching.budget = true; return; } setTimeout(function () { if (!city.ending) openBudget(true); }, 0); });
  on(Messages.FRONT_END_MESSAGE, function (m) { if (m && m.subject) heard(m.subject); });
  // The engine says a shortage at most every two real minutes; away, minutes are years, so the shortage itself is heard.
  var short = function () { city.shortAt = city.sim._cityTime; if (catching) caughtUp(Messages.NOT_ENOUGH_POWER, Words.MESSAGE[Messages.NOT_ENOUGH_POWER]); };
  sim._powerManager.addEventListener(Messages.NOT_ENOUGH_POWER, short);
  unlisten.push(function () { sim._powerManager.removeEventListener(Messages.NOT_ENOUGH_POWER, short); });
}
function heard(subject) {
  var key = Words.MESSAGE[subject];
  if (!key) return;
  if (!truthful(subject)) return;
  // "Brownouts: build another plant" is only true when the plants ran short; zones left off the grid need a line.
  if (subject === Messages.BLACKOUTS_REPORTED && !(city.shortAt >= city.sim._cityTime - SHORT_RECENT_TICKS)) { subject = null; key = 'city.adv.power'; }
  if (!subject) { if (catching) { if (catching.events.indexOf(key) < 0) catching.events.push(key); } else say(T(key)); return; }
  if (catching) { caughtUp(subject, key); return; }
  if (subject === Messages.NO_MONEY) { goneBroke(); return; }
  if (advice && Words.NAGS.indexOf(subject) >= 0) return;   // the advisor's step says it better
  if (city.settleUntil && city.sim._cityTime < city.settleUntil && Words.MILESTONES.indexOf(subject) >= 0) return;
  if (subject === Messages.REACHED_METROPOLIS && !city.won && !city.scenario) { city.won = true; record('metropolis'); }
  say(T(key), Words.URGENT.indexOf(subject) >= 0);
  news(key);
  if (subject === Messages.REACHED_METROPOLIS && !city.scenario) metropolis();   // a scenario is judged by its own goal
}

// The engine's complaints read the census's averages, which are taken only over tiles that have any pollution, crime or
// traffic at all, and which can stand from before the city was measured: one coal plant in an empty valley is "very
// high". A complaint is said only when people live there to complain, the average says so now, and the city has had a
// few months to be measured.
var COMPLAINTS = {}, COMPLAIN_PEOPLE = 20, SETTLE_TICKS = 16, SHORT_RECENT_TICKS = 16;
COMPLAINTS[Messages.HIGH_POLLUTION] = ['pollutionAverage', 60];
COMPLAINTS[Messages.HIGH_CRIME] = ['crimeAverage', 100];
COMPLAINTS[Messages.TRAFFIC_JAMS] = ['trafficAverage', 60];
function truthful(subject) {
  var c = COMPLAINTS[subject];
  if (!c) return true;
  return people() >= COMPLAIN_PEOPLE && city.sim._census[c[0]] > c[1] && city.sim._cityTime >= city.bornAt + SETTLE_TICKS;
}

// The news card: when something happens that the library has an article about (a fire, a jam, a town becoming a
// city), its lead sits over the top of the map for a while, one at a time, each story at most once in a while.
var NEWS_MS = 15000, NEWS_AGAIN_MS = 10 * 60000, newsAt = {}, newsTimer = 0, newsEl = $('cy-news');
function news(key) {
  if (city.sim._cityTime < city.bornAt + SETTLE_TICKS) return;   // not in a city's first months
  if (!Library.articleFor(key) || Date.now() - (newsAt[key] || 0) < NEWS_AGAIN_MS || !newsEl.hidden) return;
  newsAt[key] = Date.now();
  Library.lead(key).then(function (l) { if (l) showNews(l); });
}
function showNews(l) {
  newsEl.textContent = '';
  var link = d.createElement('a'), text = d.createElement('span'), close = d.createElement('button');
  link.className = 'cy-news-link';
  if (l.thumbnail) { var img = d.createElement('img'); img.src = l.thumbnail; img.alt = ''; img.className = 'cy-news-img'; link.appendChild(img); }
  text.className = 'cy-news-text';
  [['small', T('city.news')], ['b', l.title], ['span', l.blurb]].forEach(function (p) { var e = d.createElement(p[0]); e.textContent = p[1]; text.appendChild(e); });
  link.appendChild(text);
  root.GamesLib.articleLink(link, l.zim, l.path);
  close.type = 'button'; close.className = 'cy-news-close'; close.setAttribute('aria-label', T('shell.close')); close.textContent = '\u00d7';
  close.addEventListener('click', hideNews);
  newsEl.appendChild(link); newsEl.appendChild(close);
  newsEl.hidden = false;
  clearTimeout(newsTimer); newsTimer = setTimeout(hideNews, NEWS_MS);
}
$('cy-map').addEventListener('pointerdown', function () { if (!newsEl.hidden) hideNews(); });   // touching the map puts the card away
function hideNews() { clearTimeout(newsTimer); newsEl.hidden = true; newsEl.textContent = ''; }

// The status line: one message at a time, each up for a few seconds; an urgent one (a fire, a crash) goes first.
var messages = [], shownAt = 0, shownLine = '', msgTimer = 0;
var status = Play.status($('cy-msg'));
function say(text, urgent) {
  if (!text) return;
  if (messages.indexOf(text) >= 0) return;
  if (urgent) messages.unshift(text); else messages.push(text);
  if (messages.length > 3) messages.length = 3;
  pump();
}
function pump() {
  var wait = shownAt + MESSAGE_MS - Date.now();
  if (wait > 0) { clearTimeout(msgTimer); msgTimer = setTimeout(pump, wait); return; }
  if (!messages.length) return;
  shownLine = messages.shift();
  status.say(shownLine);
  shownAt = Date.now();
  if (messages.length) msgTimer = setTimeout(pump, MESSAGE_MS);
}

// ── the strip: demand first (it decides the next move), then the money, then when and how many ──
function money(n) { return T('city.money', { n: Math.round(n) }); }
function dateWords() {
  var dt = city.sim.getDate(), z = root.ZimiText;
  return T('city.date', { month: z ? z.month(dt.month, 'short') : String(dt.month + 1), year: z ? z.number(dt.year, { useGrouping: false }) : String(dt.year) });
}
function people() { return city.sim.evaluation.cityPop; }
function strip() {
  if (!city) return;
  $('cy-funds').textContent = money(city.sim.budget.totalFunds);
  $('cy-funds').classList.toggle('cy-low', runningOut(outlook()));
  $('cy-when').textContent = T('city.when', { date: dateWords(), people: T('city.people', { n: people() }) });
  goalStrip();
}
// Whether the bank will last: what the last budget left (taxes less the full cost of roads, fire and police) against the
// years the city has to last, a scenario's to its judging.
function outlook() {
  var b = city.sim.budget;
  return { funds: b.totalFunds, flow: b.cashFlow, horizon: city.scenario ? Math.max(LOW_RUNWAY_YEARS, city.scenario.judgeIn / Scen.TICKS_PER_YEAR) : LOW_RUNWAY_YEARS };
}
// A scenario's goal stays on screen under the strip, with where the city stands and the time left; it wraps rather than cuts.
var goalEl = $('cy-goal');
function goalPhrase(r) { return T('city.goal.' + r.kind, r.kind === 'class' ? { name: T('city.class.' + r.target) } : { n: r.target }); }
function goalNow(r) { return r.kind === 'class' ? T('city.class.' + r.now) : root.ZimiText.number(r.now); }
function goalStrip() {
  var sc = city.scenario && scenarioOf(city.scenario.id);
  goalEl.hidden = !sc;
  if (!sc) { goalEl.textContent = ''; return; }
  var r = Scen.reading(city.sim, sc), left = Scen.timeLeft(city.scenario.judgeIn);
  goalEl.textContent = '';
  var goal = d.createElement('b'), now = d.createElement('span');
  goal.textContent = T('city.goal.label', { goal: goalPhrase(r) });
  now.textContent = T('city.goal.status', { now: goalNow(r), left: T('city.goal.' + left.unit, { n: left.n }) });
  goalEl.appendChild(goal); goalEl.appendChild(d.createTextNode(' ')); goalEl.appendChild(now);
}
var DEMAND_MAX = { residential: 2000, commercial: 1500, industrial: 1500 };
function demand() {
  var v = city.sim._valves, vals = { residential: v.resValve, commercial: v.comValve, industrial: v.indValve };
  Array.prototype.forEach.call(d.querySelectorAll('.cy-dem'), function (el) {
    var k = el.getAttribute('data-k'), f = Math.max(-1, Math.min(1, vals[k] / DEMAND_MAX[k]));
    el.style.setProperty('--dem', Math.abs(f).toFixed(3));
    el.classList.toggle('cy-neg', f < 0);
  });
  var word = function (k) { var f = vals[k] / DEMAND_MAX[k]; return T(f > 0.1 ? 'city.demand.up' : f < -0.1 ? 'city.demand.down' : 'city.demand.flat'); };
  $('cy-rci').setAttribute('aria-label', T('city.demand', { homes: word('residential'), shops: word('commercial'), industry: word('industrial') }));
}

// ── the tray ──
var SVG_NS = 'http://www.w3.org/2000/svg';
function iconSvg(name) {
  var svg = d.createElementNS(SVG_NS, 'svg'), path = d.createElementNS(SVG_NS, 'path');
  svg.setAttribute('class', 'cy-icon cy-icon-' + name); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  path.setAttribute('d', Words.ICON[name]); svg.appendChild(path);
  return svg;
}
function costWords(name) {
  return Tools.isDrawn(name) ? T('city.cost.tile', { money: money(Tools.costOf(name)) }) : money(Tools.costOf(name));
}
function trayButton(name, label) {
  var b = d.createElement('button');
  b.type = 'button'; b.className = 'cy-tool'; b.setAttribute('data-tool', name);
  var l = d.createElement('span');
  l.className = 'cy-tool-l'; l.textContent = label;
  b.appendChild(iconSvg(name)); b.appendChild(l);
  b.setAttribute('aria-label', label);
  return b;
}
function buildTray() {
  var tray = $('cy-tray');
  tray.textContent = '';
  Tools.TRAY.forEach(function (name) {
    var b = trayButton(name, T('city.tool.' + name));
    b.addEventListener('click', function () { hold(held === name ? '' : name); });
    tray.appendChild(b);
  });
  var more = trayButton('more', T('city.tool.more'));
  more.setAttribute('aria-haspopup', 'dialog');
  more.addEventListener('click', function () { moreSheet(sheets); });
  tray.appendChild(more);
  paintTray();
}
function paintTray() {
  Array.prototype.forEach.call(d.querySelectorAll('.cy-tool'), function (b) {
    var n = b.getAttribute('data-tool'), on = n === held || (n === 'more' && Tools.MORE.indexOf(held) >= 0);
    b.setAttribute('aria-pressed', String(on));
  });
  heldLine();
}
function hold(name) {
  if (held) Tools.drop(city, held);
  held = name; stroke = null; view.ghost = null;
  paintTray();
}
var heldEl = $('cy-held');
function heldLine(r) {
  heldEl.classList.toggle('cy-bad', !!(r && !r.ok));
  // With no tool held the advisor is the one voice: the tray's own hint shows only while it has nothing to say.
  if (!held) { heldEl.textContent = advice ? '' : T('city.idle'); return; }
  var name = T('city.tool.' + held);
  if (!r) { heldEl.textContent = T('city.held', { tool: name, cost: costWords(held) }); return; }
  heldEl.textContent = r.ok ? T('city.stroke', { tool: name, money: money(r.cost) })
    : r.why === 'money' ? T('city.why.money', { money: money(r.short) })
    : r.blocker !== null && r.blocker !== undefined ? T('city.why.inway', { thing: T(Words.kindOf(r.blocker)) }) : T('city.why.' + r.why);
}

// ── strokes: the ghost while the finger is down, the city changed when it lifts ──
function strokeTiles(tile) {
  if (!stroke) { stroke = [[tile.x, tile.y]]; return stroke; }
  if (Tools.isSingle(held)) return (stroke = [[tile.x, tile.y]]);   // a single building follows the finger
  if (!Tools.isDrawn(held)) return Tools.row(held, stroke[0], [tile.x, tile.y]);   // zones side by side
  var last = stroke[stroke.length - 1];
  if (last[0] !== tile.x || last[1] !== tile.y) stroke = stroke.concat(Tools.steps(last, [tile.x, tile.y]));
  return stroke;
}
// The ghost: the tiles the stroke would lay, and for buildings each footprint's outline in its own colour (the engine
// corrects a building's centre to its top left corner).
function ghostOf(r) {
  var g = { tiles: r.tiles, ok: r.ok, boxes: [] };
  if (!Tools.isDrawn(held)) {
    var s = Tools.sizeOf(held), afford = r.why !== 'money';
    g.boxes = r.parts.map(function (p) { return [p[0] - 1, p[1] - 1, p[0] - 2 + s, p[1] - 2 + s, p[2] && afford]; });
    if (!r.ok) g.tiles = [];
  }
  return g;
}
// A building lands where it fits nearest the finger (see Tools.nudge); a drawn stroke goes exactly where it was drawn.
function aimed(tiles) { return Tools.isDrawn(held) ? tiles : Tools.nudge(city, held, tiles); }
function onStroke(tile, done) {
  if (!held || !city) return;
  var tiles = aimed(strokeTiles(tile));
  if (!done) {
    var r = Tools.trial(city, held, tiles);
    Tools.drop(city, held);
    view.ghost = ghostOf(r);
    heldLine(r);
    return;
  }
  var built = Tools.build(city, held, tiles);
  stroke = null; view.ghost = null;
  if (built.ok) {
    lastBuilt = built.undo; undoBtn.disabled = false;
    if (OPENING[held]) { say(T(OPENING[held])); news(OPENING[held]); react(held); }
    if (!city.built) city.built = true;
    advisor();
    Play.haptic(10);
    strip();
    heldLine();
    Shell.saveNow();
  } else {
    heldLine(built);
    Shell.shake(heldEl);
  }
}
function onHover(tile) {
  if (!held || Tools.isDrawn(held) || !tile) { if (!stroke) view.ghost = null; return; }
  var r = Tools.trial(city, held, aimed([[tile.x, tile.y]]));
  Tools.drop(city, held);
  view.ghost = ghostOf(r);
}

// The advisor: the next useful step, said once when it changes (and again only after something else was said).
var advice = null;
// A step that is no longer the next one is never shown late: it leaves the queue, and if it is on the line now, the new
// step replaces it at once (the few seconds a message is given are for news, not for stale advice).
function advisor() {
  var next = advise(city.map, outlook());
  if (next === advice) return;
  var old = advice ? T(advice) : null;
  advice = next;
  if (old) {
    var at = messages.indexOf(old);
    if (at >= 0) messages.splice(at, 1);
    if (shownLine === old) { shownAt = 0; shownLine = ''; if (!next) status.say(''); }
  }
  if (next) say(T(next));
  if (!held) heldLine();
}

// ── the clock ──
var lastFrame = 0, owed = 0, slowSince = 0, lastSave = 0, lastSummary = 0, lastAdvice = 0;
function step() {
  if (city.sim.budget.awaitingValues) return;
  var t = city.sim._cityTime;
  city.sim._simulate(city.sim._constructSimData());
  city.sim._updateTime();
  if (city.sim._cityTime === t) return;
  if (city.scenario && !catching) scenarioTick();
  Climate.tick(city.sim, city.climate, climateOn, disasters).forEach(happened);
}

// ── what the modern city adds: the climate's events, the new buildings' news, and the citizens' voices ──
var NEWS_KEYS = { heatwave: 'city.msg.heatwave', sea: 'city.msg.sea' };
function happened(what) {
  if (catching) { if (NEWS_KEYS[what]) catching.events.push(NEWS_KEYS[what]); return; }
  if (NEWS_KEYS[what]) { say(T(NEWS_KEYS[what]), true); news(NEWS_KEYS[what]); }
  react(what);
}
// One citizen answers what just happened (the first of those who care, in turn).
var reacted = {};
function react(what) {
  var who = Voices.REACT[what];
  if (!who) return;
  var id = who[(reacted[what] = ((reacted[what] || 0) + 1)) % who.length], p = Voices.PEOPLE.filter(function (x) { return x.id === id; })[0];
  say(T('city.v.say', { name: p.name, line: T('city.v.ev.' + what + '.' + id) }));
  lastVoice = id; voiceAt = Date.now();
}
// Now and then, while the city runs, the citizen with the strongest feeling says it.
var VOICE_EVERY_MS = 75000, voiceAt = Date.now(), lastVoice = '';
function voices(now) {
  if (Date.now() - voiceAt < VOICE_EVERY_MS || messages.length) return;
  var st = Voices.stats(city.sim, city.climate.warm), p = Voices.next(st, lastVoice), m = Voices.mood(p.id, st);
  var n = Math.floor(now / VOICE_EVERY_MS) % Voices.LINES;
  say(T('city.v.say', { name: p.name, line: T('city.v.' + p.id + '.' + m + '.' + n) }));
  lastVoice = p.id; voiceAt = Date.now();
}
// What a new building of the modern kind says when it opens.
var OPENING = { datacenter: 'city.msg.datacenter', solar: 'city.msg.solar', wind: 'city.msg.wind' };

// ── scenarios and ready-made cities ──
var PLACE_TITLES = { Q62: 'San Francisco', Q1055: 'Hamburg', Q70: 'Bern', Q1490: 'Tokyo', Q12439: 'Detroit', Q100: 'Boston', Q8678: 'Rio de Janeiro',
  Q262483: 'Deadwood, South Dakota', Q1027700: 'Haight-Ashbury', Q200267: 'Kamakura', Q48320: 'Kobe', Q239143: 'Kowloon', Q34600: 'Kyoto', Q38283: 'Yokohama' };
var places = {};
Scen.SCENARIOS.forEach(function (sc) { if (sc.place) places['place.' + sc.id] = [sc.place[0], PLACE_TITLES[sc.place[0]]]; });
Scen.CITIES.forEach(function (c) { if (c[1]) places['place.' + c[0]] = [c[1], PLACE_TITLES[c[1]]]; });
Library.add(places);
function scenarioOf(id) { return Scen.SCENARIOS.filter(function (x) { return x.id === id; })[0]; }
function scenarioTick() {
  var sc = scenarioOf(city.scenario.id), out = Scen.tick(city.sim, sc, city.scenario);
  if (!out) return;
  var name = T('city.sct.' + sc.id), c = city, r = Scen.reading(c.sim, sc);
  c.scenario = null;   // judged once: the city goes on as a city of its own
  goalStrip();
  Shell.endSheet({ result: out === 'win' ? 'win' : 'lose', title: T(out === 'win' ? 'city.end.scWin' : 'city.end.scLose'),
                   text: T(out === 'win' ? 'city.end.scWinText' : 'city.end.scLoseText', { city: name, goal: goalPhrase(r), now: goalNow(r) }), stats: endStats() });
}
// Open a scenario (`sc`) or a ready-made city (`file` under zimcity/cities) from its file; the city in progress is left
// for a new one, as New game does.
function openFile(path, sc, title) {
  return fetch(path).then(function (r) { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }).then(function (buf) {
    var map = Scen.mapOf(buf);
    if (!map) throw new Error('not a city');
    var level = Simulation.LEVEL_EASY, sim = new Simulation(map, level, speed === Simulation.SPEED_PAUSED ? Simulation.SPEED_MED : speed);
    var start = Scen.startOf(buf);
    sim._cityTime = sc ? (sc.year - 1900) * 48 + 2 : start.time;
    sim.budget.setFunds(sc ? sc.funds : start.funds);
    sim.budget.cityTax = 7;
    sim._updateTime();
    sim._simulate(sim._constructSimData());   // the engine's first step evaluates the city, so its people show at once
    var c = cityOf(map, sim, level, 0);
    // A city that arrives grown: its milestones are not news, and becoming a metropolis is not a win of the player's
    // (a scenario has its own judging). For its first year the "now a city" messages say nothing.
    c.built = true; c.name = title; c.won = true; c.settleUntil = sim._cityTime + 48;
    if (sc) c.scenario = { id: sc.id, left: sc.disaster ? sc.disaster[1] : 0, judgeIn: sc.judge };
    record('best');
    install(c);
    view.cam.s = 1; centreOnCity();
    say(sc ? T('city.scl.' + sc.id) : title);
    Shell.saveNow();
  }).catch(function () { say(T('city.sc.failed'), true); });
}
// A city loaded from a file opens over its middle of things: the box holding its zones.
function centreOnCity() {
  var map = city.map, sx = 0, sy = 0, n = 0;
  for (var y = 0; y < MAP_H; y++) for (var x = 0; x < MAP_W; x++) if (map.getTile(x, y).isZone()) { sx += x; sy += y; n++; }
  if (n) view.centreOn(sx / n, sy / n); else view.centreOn(MAP_W / 2, MAP_H / 2);
}
var scenarios = {
  list: Scen.SCENARIOS, maps: Scen.CITIES,
  play: function (sc) { openFile('zimcity/scenarios/' + sc.file, sc, T('city.sct.' + sc.id)); },
  open: function (c) { openFile('zimcity/cities/' + c[0] + '.cty', null, T('city.map.' + c[0])); }
};
function frame(now) {
  requestAnimationFrame(frame);
  if (!city || d.hidden) { lastFrame = now; return; }
  var dt = Math.min(250, now - (lastFrame || now));
  lastFrame = now;
  if (!paused && !sheetOpen() && !catching) {
    owed += dt / 1000 * STEPS_PER_SECOND[speed];
    var n = Math.min(MAX_STEPS_PER_FRAME, Math.floor(owed));
    owed -= n;
    if (owed > MAX_STEPS_PER_FRAME) owed = 0;     // a slow device runs behind rather than in bursts
    for (var i = 0; i < n; i++) step();
    city.sim.spriteManager.moveObjects(city.sim._constructSimData());
    watchFast(dt, now);
    voices(now);
    walk(dt * STEPS_PER_SECOND[speed] / STEPS_PER_SECOND[Simulation.SPEED_MED] / 1000);
    if (now - lastSave > SAVE_EVERY_MS) { lastSave = now; Shell.saveNow(); }
  }
  if (menuPaused && !sheetOpen()) { menuPaused = false; if (paused) pauseBtn.click(); }
  view.paused = paused;
  if (following) keepInView(dt);
  view.draw(now);
  if (now - lastSummary > SUMMARY_EVERY_MS) { lastSummary = now; summary(); }
  if (now - lastAdvice > ADVISE_EVERY_MS) { lastAdvice = now; advisor(); }
}
// Fast is offered only while the device keeps up with it: frames slower than FAST_FRAME_MS for a few seconds take it away.
function watchFast(dt, now) {
  if (speed !== Simulation.SPEED_FAST) { slowSince = 0; return; }
  if (dt < FAST_FRAME_MS) { slowSince = 0; return; }
  if (!slowSince) slowSince = now;
  if (now - slowSince > FAST_PATIENCE_MS) { fastOK = false; setSpeed(Simulation.SPEED_MED); say(T('city.s.fastGone'), true); }
}
// Any sheet up (the Menu's stays in the page, hidden, once it has opened) holds the city's clock.
// ── following one citizen to work and back (cosmetic: it reads the city and changes nothing) ──
var following = null, followEl = $('cy-follow-card');
var PREFER = { commuter: 'industry', developer: 'shops', activist: 'shops', rival: 'industry' };
var CAMERA_EASE = 0.006;   // the share of the way to the figure the camera moves each millisecond
var FOLLOW_ZOOM = 2;       // close enough to see the figure among the houses
function tripFor(i, id) { return Follow.commute(city.map, i * 5, PREFER[id]); }
function follow(id) {
  var i = Voices.PEOPLE.findIndex(function (p) { return p.id === id; }), trip = tripFor(i, id);
  if (!trip) return false;
  following = { p: Voices.PEOPLE[i], i: i, walk: new Follow.Walk(trip), cam: true, said: '' };
  view.zoomAt(view.w / 2, view.h / 2, Math.max(view.cam.s, FOLLOW_ZOOM));
  followCard(true);
  return true;
}
function unfollow() { following = null; view.follower = null; if (followEl) { followEl.hidden = true; followEl.textContent = ''; } }
// Each trip finds its way again, so a road built or bulldozed since is taken into account.
function walk(sec) {
  if (!following) return;
  var f = following, traffic = city.sim.blockMaps.trafficDensityMap;
  if (f.walk.advance(sec, function (x, y) { return traffic.worldGet(x, y); })) {
    var r = Follow.route(city.map, f.walk.trip.home, [f.walk.trip.work]), trip = r ? { home: f.walk.trip.home, work: r.to, path: r.path } : tripFor(f.i, f.p.id);
    if (!trip) { say(T('city.fw.lost', { name: f.p.name }), true); unfollow(); return; }
    var phase = f.walk.phase; f.walk = new Follow.Walk(trip); f.walk.phase = phase;
    if (phase === 'toHome') f.walk.at = { x: trip.path[trip.path.length - 1][0], y: trip.path[trip.path.length - 1][1] };
    followCard(true);   // a new trip, and what they think of the city now
    return;
  }
  followCard(false);
}
function keepInView(dt) {
  var w = following.walk, at = w.phase === 'atWork' ? w.trip.work : w.phase === 'atHome' ? w.trip.home : w.at;
  view.follower = { x: at.x, y: at.y, name: following.p.name, slow: following.walk.slow };
  if (!following.cam) return;
  var c = view.cam, k = Math.min(1, dt * CAMERA_EASE);
  c.x += ((at.x + 0.5) * TILE - view.w / c.s / 2 - c.x) * k;
  c.y += ((at.y + 0.5) * TILE - view.h / c.s / 2 - c.y) * k;
  view.clamp();
}
// The card under the map: who, where they are, and what they think (their mood, read from the city).
function followCard(fresh) {
  var f = following, w = f.walk, status = T('city.fw.' + w.phase);
  if (w.slow) status = T('city.fw.jam', { status: status });
  if (!fresh && status === f.said && !f.camChanged) return;
  f.said = status; f.camChanged = false;
  followEl.textContent = '';
  var who = d.createElement('span'), name = d.createElement('b'), what = d.createElement('small'), quote = d.createElement('q');
  who.className = 'cy-fw-who'; name.textContent = f.p.name; what.textContent = status; what.setAttribute('aria-live', 'polite');
  if (fresh) {
    var st = Voices.stats(city.sim, city.climate.warm), mood = Voices.mood(f.p.id, st);
    f.quote = T('city.v.' + f.p.id + '.' + mood + '.' + (f.i % Voices.LINES));
  }
  quote.textContent = f.quote;
  who.appendChild(name); who.appendChild(what); who.appendChild(quote);
  followEl.appendChild(who);
  if (!f.cam) {
    var back = d.createElement('button'); back.type = 'button'; back.className = 'ar-btn cy-fw-view'; back.textContent = T('city.fw.view');
    back.addEventListener('click', function () { if (following) { following.cam = true; following.camChanged = true; followCard(false); } });
    followEl.appendChild(back);
  }
  var stop = d.createElement('button'); stop.type = 'button'; stop.className = 'cy-news-close'; stop.textContent = '\u00d7';
  stop.setAttribute('aria-label', T('city.fw.stop'));
  stop.addEventListener('click', unfollow);
  followEl.appendChild(stop);
  followEl.hidden = false;
}
function sheetOpen() { return !!d.querySelector('.ar-sheet:not([hidden])'); }
function setSpeed(s) { speed = s; if (city) city.sim.setSpeed(s); }
function summary() {
  $('cy-map').setAttribute('aria-label', T('city.summary', { date: dateWords(), people: T('city.people', { n: people() }), money: money(city.sim.budget.totalFunds) }));
}

// Undo in the bar: the last placement, while the city has not grown over it (the money comes back).
var lastBuilt = null, undoBtn = $('cy-undo');
undoBtn.addEventListener('click', function () {
  if (!lastBuilt) return;
  if (Tools.undo(city, lastBuilt)) { status.say(T('city.undo.done')); shownAt = Date.now(); strip(); advisor(); }
  else say(T('city.undo.grown'), true);
  lastBuilt = null; undoBtn.disabled = true;
  Shell.saveNow();
});

// Pause in the bar: a tap pauses and resumes; leaving the page or opening the Menu pauses (the shell presses it).
var pauseBtn = $('cy-pause');
pauseBtn.addEventListener('click', function () {
  paused = !paused; Play.pauseLabel(pauseBtn, paused); if (!paused) owed = 0;
  menuPaused = paused && Shell.pausing === 'menu';   // the Menu's pause ends with the Menu; one the player chose stays
});
var menuPaused = false;

// ── the end of a city, both ways ──
// Going broke ends the city once (the end sheet); after that the city may be nursed back, and the line says it again.
function goneBroke() {
  if (city.broke) { say(T('city.msg.broke'), true); return; }
  var c = city;
  c.broke = true; c.ending = true;
  record('broke');
  Shell.endSheet({ result: 'lose', title: T('city.end.broke'), text: brokeText(), stats: endStats(), onClose: function () { setTimeout(function () { if (city === c && c.ending) { c.ending = false; if (c.sim.budget.awaitingValues) openBudget(true); } }, 0); } });
}
// What went wrong in the bank's own figures, so the sheet and the strip agree: what is there, what the year costs, what taxes bring.
// A city under a scenario's clock also says the goal it was after and where it stood.
function brokeText() {
  var b = city.sim.budget, sc = city.scenario && scenarioOf(city.scenario.id);
  var text = T('city.end.brokeText', { funds: money(b.totalFunds), costs: money(b.roadMaintenanceBudget + b.fireMaintenanceBudget + b.policeMaintenanceBudget), taxes: money(b.taxFund) });
  if (!sc) return text;
  var r = Scen.reading(city.sim, sc);
  return text + ' ' + T('city.end.brokeGoal', { goal: goalPhrase(r), now: goalNow(r) });
}
function metropolis() {
  Shell.endSheet({ result: 'win', title: T('city.end.metropolis'), text: T('city.end.metropolisText'), stats: endStats(), newLabel: T('shell.menu.new') });
}
function endStats() { return [[T('city.r.people'), root.ZimiText.number(people())], [T('city.r.year'), String(city.sim.getDate().year), 'static']]; }

// ── stats, kept across cities ──
function stats() { return Play.load(STATS_KEY, { cities: 0, best: 0, metropolis: 0, broke: 0 }); }
function record(what) {
  var s = stats();
  if (what === 'new') s.cities++;
  if (what === 'metropolis') s.metropolis++;
  if (what === 'broke') s.broke++;
  s.best = Math.max(s.best, people());
  Play.save(STATS_KEY, s);
}

var sheets = {
  city: function () { return city; }, T: T, money: money, people: people,
  layer: function (v) { if (v !== undefined) { layer = v; view.layer = v; } return layer; },
  speed: function (v) { if (v !== undefined) setSpeed(v); return speed; }, fastOK: function () { return fastOK; },
  paused: function (v) { if (v !== undefined && v !== paused) pauseBtn.click(); return paused; },
  disasters: function (v) { if (v !== undefined) { disasters = v; if (city) city.sim.disasterManager.disastersEnabled = v; } return disasters; },
  climateOn: function (v) { if (v !== undefined) climateOn = v; return climateOn; },
  away: function (v) { if (v !== undefined) awayPace = v; return awayPace; },
  climate: function () { return Climate.summary(city.sim, city.climate); },
  commutes: function () { var z = Follow.zones(city.map); return z.homes.length && z.work.length; },
  follow: follow, mood: function (id) { var st = Voices.stats(city.sim, city.climate.warm); return Voices.mood(id, st); },
  level: function (v) { if (v !== undefined) pendingLevel = v; return pendingLevel; },
  library: Library, get cities() { return cities; }, get scenarios() { return scenarios; }, dateOf: function (m, y) { var z = root.ZimiText; return T('city.date', { month: z.month(m, 'short'), year: z.number(y, { useGrouping: false }) }); }, hold: hold, held: function () { return held; }, iconSvg: iconSvg, costWords: costWords, strip: strip
};
function openBudget(forced) { budgetSheet(sheets, forced); }

// These buttons live in the Menu; the Menu closes (and hands focus back) after their click, so the sheet opens just after.
function fromMenu(id, open) { $(id).addEventListener('click', function () { setTimeout(open, 0); }); }
fromMenu('cy-budget', function () { openBudget(false); });
fromMenu('cy-report', function () { reportSheet(sheets); });
fromMenu('cy-layers', function () { layersSheet(sheets); });
fromMenu('cy-speed', function () { speedSheet(sheets); });
fromMenu('cy-cities', function () { citiesSheet(sheets); });
fromMenu('cy-scenarios', function () { scenariosSheet(sheets); });
fromMenu('cy-climate', function () { climateSheet(sheets); });
fromMenu('cy-follow', function () { followSheet(sheets); });
$('cy-new').addEventListener('click', function () {
  record('best');
  install(freshCity(pendingLevel));
  record('new');
  Shell.saveNow();
});

// ── what the shell keeps and asks ──
function pack() {
  return { sim: Save.packSim(city.sim), settleUntil: city.settleUntil || 0, seed: city.seed, level: city.level, won: city.won, broke: city.broke, built: city.built, scenario: city.scenario || null, name: city.name || '', climate: city.climate, climateOn: climateOn, away: awayPace, savedAt: Date.now(), people: people(),
           cam: { x: view.cam.x, y: view.cam.y, s: view.cam.s }, speed: speed, layer: layer, disasters: disasters };
}
function unpack(k) {
  if (!k || !k.sim) return false;
  speed = [1, 2, 3].indexOf(k.speed) >= 0 ? k.speed : Simulation.SPEED_MED;
  var back = Save.unpackSim(k.sim, k.level || 0, speed);
  if (!back) return false;
  disasters = !!k.disasters; layer = k.layer || 'off'; view.layer = layer;
  var c = cityOf(back.map, back.sim, k.level || 0, k.seed);
  c.won = !!k.won; c.broke = !!k.broke; c.built = k.built !== false; c.name = k.name || ''; c.settleUntil = k.settleUntil || 0;
  if (k.scenario && scenarioOf(k.scenario.id)) c.scenario = k.scenario;
  if (k.climate && typeof k.climate.carbon === 'number') c.climate = Object.assign(Climate.fresh(), k.climate);   // older cities start with none
  climateOn = k.climateOn !== false;
  awayPace = Away.PACES.indexOf(k.away) >= 0 ? k.away : Away.DEFAULT_PACE;
  install(c, k.cam);
  return true;
}

// ── while you were away: the time since the save, lived at the chosen pace, then what happened ──
// A scenario waits (its clock is the challenge); so does a city whose save has no time on it (made before this).
var awayJob = null, awayWait = null;
function awayFrom(k) {
  if (!city || city.scenario || !k.savedAt) return;
  var ticks = Away.ticksFor(Date.now() - k.savedAt, awayPace);
  if (ticks < 1) return;
  catchUp(ticks, Away.seedFor(k.seed, k.savedAt, ticks), k.people);
}
// `before` is the population the save recorded: just opened, the evaluation that counts people has not run yet.
function catchUp(ticks, seed, before) {
  var c = city, date = c.sim.getDate();
  catching = { events: [], budget: false, broke: false, metropolis: false, ticks: ticks,
               before: { people: typeof before === 'number' ? before : people(), funds: c.sim.budget.totalFunds, month: date.month, year: date.year } };
  var line = d.createElement('p'), bar = d.createElement('progress');
  line.className = 'gs-text'; bar.className = 'cy-aw-bar'; bar.max = ticks; bar.value = 0;
  line.textContent = T('city.aw.busy', { date: dateWords() });
  var wait = awayWait = Shell.sheet({ title: T('city.aw.title'), body: [line, bar], actions: [{ label: T('city.aw.cancel') }],
                           onClose: function () { if (awayJob) awayJob.cancel(); } });
  awayJob = Away.run({
    ticks: ticks, random: root.ZimiUtil.mulberry32(seed),
    time: function () { return c.sim._cityTime; },
    step: function () { if (city !== c || c.sim.budget.awaitingValues) return false; step(); return true; },
    progress: function (n) { bar.value = n; line.textContent = T('city.aw.busy', { date: dateWords() }); },
    done: function (r) { awayJob = null; awayWait = null; wait.close(); if (city === c) awaySheet(r); else catching = null; }
  });
}
// What the engine said while the city caught up: the notable things, in order, once each.
function caughtUp(subject, key) {
  if (subject === Messages.NO_MONEY) { catching.broke = true; return; }
  if (Words.NAGS.indexOf(subject) >= 0) return;
  if (subject === Messages.REACHED_METROPOLIS && !city.won) { city.won = true; record('metropolis'); catching.metropolis = true; }
  if (catching.events.indexOf(key) < 0) catching.events.push(key);
}
function awaySheet(r) {
  var a = catching, c = city, now = c.sim.getDate(), b = a.before, z = root.ZimiText;
  catching = null;
  var note = a.broke ? 'city.aw.broke' : r.stalled || a.budget ? 'city.aw.budget' : r.cancelled ? 'city.aw.cut'
           : a.ticks >= Away.CAP_YEARS * Away.TICKS_PER_YEAR ? 'city.aw.capped' : '';
  var st = Voices.stats(c.sim, c.climate.warm), p = Voices.next(st, '');
  if (a.broke) { c.broke = true; record('broke'); }
  strip(); demand(); advisor();
  Shell.saveNow();
  awayCard(sheets, {
    rows: [[T('city.aw.from'), sheets.dateOf(b.month, b.year)], [T('city.aw.to'), sheets.dateOf(now.month, now.year)],
           [T('city.r.people'), T('city.aw.change', { from: z.number(b.people), to: z.number(people()) })],
           [T('city.aw.money'), T('city.aw.change', { from: money(b.funds), to: money(c.sim.budget.totalFunds) })]],
    note: note && T(note, { date: dateWords(), n: Away.CAP_YEARS }),
    events: a.events.map(function (k) { return T(k); }),
    budgetWaiting: c.sim.budget.awaitingValues,
    voice: people() ? T('city.v.say', { name: p.name, line: T('city.v.' + p.id + '.' + Voices.mood(p.id, st) + '.0') }) : '',   // nobody lives here to say it
    done: function () {
      if (city !== c) return;
      if (c.sim.budget.awaitingValues && !sheetOpen()) openBudget(true);
      else if (a.metropolis) metropolis();
    }
  });
}

// ── kept cities: up to five, beside the one in progress ──
var KEPT_KEY = 'zimi.zimcity.kept', KEPT_MAX = 5;
function kept() { try { var v = JSON.parse(localStorage.getItem(KEPT_KEY)); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
function putKept(list) { try { localStorage.setItem(KEPT_KEY, JSON.stringify(list)); return true; } catch (e) { return false; } }
function card() { var dt = city.sim.getDate(); return { at: Date.now(), month: dt.month, year: dt.year, people: people(), funds: city.sim.budget.totalFunds, data: pack() }; }
var cities = {
  list: kept, max: KEPT_MAX,
  keep: function () { var l = kept(); if (l.length >= KEPT_MAX) return false; l.unshift(card()); return putKept(l); },
  remove: function (i) { var l = kept(); l.splice(i, 1); putKept(l); },
  // Opening a kept city puts the one in progress in its place (when anything has been built), so nothing is lost.
  open: function (i) {
    var l = kept(), want = l[i];
    if (!want) return;
    if (city.built) l[i] = card(); else l.splice(i, 1);
    putKept(l);
    unpack(want.data);
    Shell.saveNow();
  }
};

Shell.game({
  inProgress: function () { return !!city && city.built; },
  menu: function () { return { options: newGameRows(sheets) }; },
  settings: function () { return settingsRows(sheets); },
  stats: function () {
    var s = stats();
    if (!s.cities) return null;
    return [[T('city.st.cities'), root.ZimiText.number(s.cities)], [T('city.st.best'), T('city.people', { n: Math.max(s.best, city ? people() : 0) })],
            [T('city.st.metropolis'), root.ZimiText.number(s.metropolis)]];
  },
  about: function () { return Words.credit(T); },
  // How to play: the fingers and the sizes shown, and the keys only when there is a keyboard to press them on.
  help: function () { return root.matchMedia && root.matchMedia('(pointer: coarse)').matches ? { keys: '', extra: howExtra(sheets) } : { extra: howExtra(sheets) }; }
});

// ── start ──
var input = new Input(view, {
  tool: function () { return held; },
  stroke: onStroke,
  cancel: function () { stroke = null; view.ghost = null; if (held) Tools.drop(city, held); heldLine(); },
  inspect: function (x, y) { inspectSheet(sheets, x, y); },
  hover: onHover,
  lift: function () { return held && Tools.isSingle(held) ? Tools.sizeOf(held) * TILE * view.cam.s / 2 + FINGER_PX : 0; },
  cursor: function (x, y) { view.cursor = x === null || x === undefined ? null : { x: x, y: y }; if (view.cursor) { onHover(view.cursor); } },
  moved: function () {},
  panned: function () { if (following && following.cam) { following.cam = false; following.camChanged = true; followCard(false); } }
});
void input;
root.addEventListener('resize', function () { view.resize(); });
if (root.ResizeObserver) new root.ResizeObserver(function () { view.resize(); }).observe($('cy-map'));
buildTray();
if (root.ZimiText && root.ZimiText.onChange) root.ZimiText.onChange(function () { buildTray(); if (city) { strip(); demand(); summary(); } });

// The tests' handle (as every game has one): the city, the map, and the clock run ahead by n steps.
root.__zimcity = { get city() { return city; }, get view() { return view; }, step: function (n) { for (var i = 0; i < n; i++) step(); strip(); demand(); advisor(); }, news: news, library: Library, happened: happened, land: centreOnLand, said: function () { return messages.concat(shownLine); }, get catching() { return catching; }, catchUp: catchUp, follow: follow, get following() { return following; }, voice: function () { voiceAt = 0; voices(performance.now()); } };

Shell.persist({ save: function () { return city ? pack() : null; }, load: function (k) { if (!unpack(k)) return false; awayFrom(k); return true; } });
if (!city) { install(freshCity(pendingLevel)); record('new'); }
demand();
summary();
Library.find();
requestAnimationFrame(frame);
