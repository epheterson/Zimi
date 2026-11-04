/* ZimCity: a city you build with your thumb. Our own code, GPL-3.0; the simulation is micropolisJS (GPL-3.0, see
   zimcity/ENGINE.md), and nothing here changes how it simulates.

   This file is the page: the city (made, kept and brought back), the clock that runs it, what the strip and the status
   line say, the tray, and the sheets (budget, report, layers, speed, inspect). The map is zimcity-view.js, the fingers
   zimcity-input.js and the tools zimcity-tools.js. */

import { Simulation } from './zimcity/engine/simulation.js';
import { GameMap } from './zimcity/engine/gameMap.js';
import { MapGenerator } from './zimcity/engine/mapGenerator.js';
import * as Messages from './zimcity/engine/messages.js';
import { View } from './zimcity-view.js';
import { Input } from './zimcity-input.js';
import * as Tools from './zimcity-tools.js';
import * as Words from './zimcity-words.js';
import { budgetSheet, reportSheet, layersSheet, speedSheet, inspectSheet, moreSheet, settingsRows, newGameRows } from './zimcity-sheets.js';

var root = window, d = document, Shell = root.ZimiShell, Play = root.ArcadePlay, Util = root.ZimiUtil;
var T = function (k, v) { return root.ZimiText ? root.ZimiText.T(k, v) : k; };
var $ = function (id) { return d.getElementById(id); };

var MAP_W = 120, MAP_H = 100;
var START_SCALE = 2;                 // a tile 32 px wide on screen: a road is one finger wide
var STEPS_PER_SECOND = { 1: 10, 2: 20, 3: 60 };   // the engine's slow, normal and fast, as simulation steps a second
var MAX_STEPS_PER_FRAME = 4;
var FAST_FRAME_MS = 28;              // slower than this, held for FAST_PATIENCE_MS, and Fast is too much for this device
var FAST_PATIENCE_MS = 3000;
var MESSAGE_MS = 4000;               // the least time one message stays before the next replaces it
var SAVE_EVERY_MS = 20000;
var SUMMARY_EVERY_MS = 5000;
var STATS_KEY = 'zimi.zimcity.stats';

// ── the city ──
var city = null;                     // { sim, map, tools, seed, level, won, broke, built }
var held = '';                       // the tool in hand ('' for none)
var stroke = null;                   // the tiles of the stroke under way
var paused = false, speed = Simulation.SPEED_MED, fastOK = true, layer = 'off', disasters = false;
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

function makeCity(map, level, saved, seed) {
  var sim = new Simulation(map, level, speed === Simulation.SPEED_PAUSED ? Simulation.SPEED_MED : speed, saved);
  var c = { sim: sim, map: map, tools: Tools.makeTools(map), seed: seed, level: level, won: false, broke: false, built: !!saved };
  sim.disasterManager.disastersEnabled = disasters;
  listen(sim);
  return c;
}
function freshCity(level) {
  var seed = randomSeed();
  var map = seeded(seed, function () { return MapGenerator(MAP_W, MAP_H); });
  return makeCity(map, level, null, seed);
}
function install(c, cam) {
  if (held) Tools.drop(city, held);
  city = c; stroke = null;
  city.sim.setSpeed(speed === Simulation.SPEED_PAUSED ? Simulation.SPEED_MED : speed);
  view.setCity(city);
  view.resize();
  if (cam) { view.cam.x = cam.x; view.cam.y = cam.y; view.cam.s = cam.s; view.clamp(); }
  else { view.cam.s = START_SCALE; centreOnLand(); }
  messages.length = 0;
  strip();
  if (!city.built) say(T('city.start'));
}
// A new city opens over its best land: the middle of the map, nudged toward the most open ground near it.
function centreOnLand() {
  var map = city.map, best = null;
  for (var y = 20; y < MAP_H - 20; y += 5) {
    for (var x = 20; x < MAP_W - 20; x += 5) {
      var open = 0;
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) if (map.getTileValue(x + dx, y + dy) === 0) open++;
      var score = open - Math.hypot(x - MAP_W / 2, y - MAP_H / 2) / 4;
      if (!best || score > best.score) best = { x: x, y: y, score: score };
    }
  }
  view.centreOn(best.x, best.y);
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
  on(Messages.BUDGET_NEEDED, function () { setTimeout(function () { if (!city.ending) openBudget(true); }, 0); });
  on(Messages.FRONT_END_MESSAGE, function (m) { if (m && m.subject) heard(m.subject); });
}
function heard(subject) {
  var key = Words.MESSAGE[subject];
  if (!key) return;
  if (subject === Messages.NO_MONEY) { goneBroke(); return; }
  if (subject === Messages.REACHED_METROPOLIS && !city.won) { city.won = true; record('metropolis'); }
  say(T(key), Words.URGENT.indexOf(subject) >= 0);
  if (subject === Messages.REACHED_METROPOLIS) metropolis();
}

// The status line: one message at a time, each up for a few seconds; an urgent one (a fire, a crash) goes first.
var messages = [], shownAt = 0, msgTimer = 0;
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
  status.say(messages.shift());
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
  $('cy-when').textContent = T('city.when', { date: dateWords(), people: T('city.people', { n: people() }) });
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
  if (!held) { heldEl.textContent = T('city.idle'); return; }
  var name = T('city.tool.' + held);
  if (!r) { heldEl.textContent = T('city.held', { tool: name, cost: costWords(held) }); return; }
  heldEl.textContent = r.ok ? T('city.stroke', { tool: name, money: money(r.cost) })
    : r.why === 'money' ? T('city.why.money', { money: money(r.short) }) : T('city.why.' + r.why);
}

// ── strokes: the ghost while the finger is down, the city changed when it lifts ──
function strokeTiles(tile) {
  if (!Tools.isDrawn(held)) return [[tile.x, tile.y]];
  if (!stroke) stroke = [[tile.x, tile.y]];
  else {
    var last = stroke[stroke.length - 1];
    if (last[0] !== tile.x || last[1] !== tile.y) stroke = stroke.concat(Tools.steps(last, [tile.x, tile.y]));
  }
  return stroke;
}
function ghostOf(tiles, r) {
  var g = { tiles: r.tiles, ok: r.ok };
  if (!Tools.isDrawn(held)) {
    // A building's footprint, whether or not it fits: the engine corrects the finger's tile to the top left.
    var s = Tools.sizeOf(held), x = tiles[0][0] - 1, y = tiles[0][1] - 1;
    g.box = [x, y, x + s - 1, y + s - 1];
    if (!r.ok) { g.tiles = []; for (var dy = 0; dy < s; dy++) for (var dx = 0; dx < s; dx++) g.tiles.push([x + dx, y + dy, -1]); }
  }
  return g;
}
function onStroke(tile, done) {
  if (!held || !city) return;
  var tiles = strokeTiles(tile);
  if (!done) {
    var r = Tools.trial(city, held, tiles);
    Tools.drop(city, held);
    view.ghost = ghostOf(tiles, r);
    heldLine(r);
    return;
  }
  var built = Tools.build(city, held, tiles);
  stroke = null; view.ghost = null;
  if (built.ok) {
    if (!city.built) { city.built = true; messages.length = 0; status.say(''); shownAt = 0; }
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
  var r = Tools.trial(city, held, [[tile.x, tile.y]]);
  Tools.drop(city, held);
  view.ghost = ghostOf([[tile.x, tile.y]], r);
}

// ── the clock ──
var lastFrame = 0, owed = 0, slowSince = 0, lastSave = 0, lastSummary = 0;
function step() {
  if (city.sim.budget.awaitingValues) return;
  city.sim._simulate(city.sim._constructSimData());
  city.sim._updateTime();
}
function frame(now) {
  requestAnimationFrame(frame);
  if (!city || d.hidden) { lastFrame = now; return; }
  var dt = Math.min(250, now - (lastFrame || now));
  lastFrame = now;
  if (!paused && !sheetOpen()) {
    owed += dt / 1000 * STEPS_PER_SECOND[speed];
    var n = Math.min(MAX_STEPS_PER_FRAME, Math.floor(owed));
    owed -= n;
    if (owed > MAX_STEPS_PER_FRAME) owed = 0;     // a slow device runs behind rather than in bursts
    for (var i = 0; i < n; i++) step();
    city.sim.spriteManager.moveObjects(city.sim._constructSimData());
    watchFast(dt, now);
    if (now - lastSave > SAVE_EVERY_MS) { lastSave = now; Shell.saveNow(); }
  }
  view.paused = paused;
  view.draw(now);
  if (now - lastSummary > SUMMARY_EVERY_MS) { lastSummary = now; summary(); }
}
// Fast is offered only while the device keeps up with it: frames slower than FAST_FRAME_MS for a few seconds take it away.
function watchFast(dt, now) {
  if (speed !== Simulation.SPEED_FAST) { slowSince = 0; return; }
  if (dt < FAST_FRAME_MS) { slowSince = 0; return; }
  if (!slowSince) slowSince = now;
  if (now - slowSince > FAST_PATIENCE_MS) { fastOK = false; setSpeed(Simulation.SPEED_MED); say(T('city.s.fastGone'), true); }
}
// Any sheet up (the Menu's stays in the page, hidden, once it has opened) holds the city's clock.
function sheetOpen() { return !!d.querySelector('.ar-sheet:not([hidden])'); }
function setSpeed(s) { speed = s; if (city) city.sim.setSpeed(s); }
function summary() {
  $('cy-map').setAttribute('aria-label', T('city.summary', { date: dateWords(), people: T('city.people', { n: people() }), money: money(city.sim.budget.totalFunds) }));
}

// Pause in the bar: a tap pauses and resumes; leaving the page or opening the Menu pauses (the shell presses it).
var pauseBtn = $('cy-pause');
pauseBtn.addEventListener('click', function () { paused = !paused; Play.pauseLabel(pauseBtn, paused); if (!paused) owed = 0; });

// ── the end of a city, both ways ──
// Going broke ends the city once (the end sheet); after that the city may be nursed back, and the line says it again.
function goneBroke() {
  if (city.broke) { say(T('city.msg.broke'), true); return; }
  var c = city;
  c.broke = true; c.ending = true;
  record('broke');
  Shell.endSheet({ result: 'lose', title: T('city.end.broke'), text: T('city.end.brokeText'), stats: endStats(), onClose: function () { setTimeout(function () { if (city === c && c.ending) { c.ending = false; if (c.sim.budget.awaitingValues) openBudget(true); } }, 0); } });
}
function metropolis() {
  Shell.endSheet({ result: 'win', title: T('city.end.metropolis'), text: T('city.end.metropolisText'), stats: endStats(), newLabel: T('shell.menu.new') });
}
function endStats() { return [[T('city.r.people'), root.ZimiText.number(people())], [T('city.r.year'), String(city.sim.getDate().year)]]; }

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
  disasters: function (v) { if (v !== undefined) { disasters = v; if (city) city.sim.disasterManager.disastersEnabled = v; } return disasters; },
  level: function (v) { if (v !== undefined) pendingLevel = v; return pendingLevel; },
  hold: hold, held: function () { return held; }, iconSvg: iconSvg, costWords: costWords, strip: strip
};
function openBudget(forced) { budgetSheet(sheets, forced); }

// These buttons live in the Menu; the Menu closes (and hands focus back) after their click, so the sheet opens just after.
function fromMenu(id, open) { $(id).addEventListener('click', function () { setTimeout(open, 0); }); }
fromMenu('cy-budget', function () { openBudget(false); });
fromMenu('cy-report', function () { reportSheet(sheets); });
fromMenu('cy-layers', function () { layersSheet(sheets); });
fromMenu('cy-speed', function () { speedSheet(sheets); });
$('cy-new').addEventListener('click', function () {
  record('best');
  install(freshCity(pendingLevel));
  record('new');
  Shell.saveNow();
});

// ── what the shell keeps and asks ──
function pack() {
  var sd = {};
  city.sim.save(sd);
  sd.map = sd.map.map(function (t) { return t.value; });
  return { sim: sd, seed: city.seed, level: city.level, won: city.won, broke: city.broke, built: city.built, cam: { x: view.cam.x, y: view.cam.y, s: view.cam.s },
           speed: speed, layer: layer, disasters: disasters };
}
function unpack(k) {
  if (!k || !k.sim || !Array.isArray(k.sim.map) || k.sim.map.length !== MAP_W * MAP_H) return false;
  var sd = Object.assign({}, k.sim, { map: k.sim.map.map(function (v) { return { value: v }; }) });
  speed = [1, 2, 3].indexOf(k.speed) >= 0 ? k.speed : Simulation.SPEED_MED;
  disasters = !!k.disasters; layer = k.layer || 'off'; view.layer = layer;
  var c = makeCity(new GameMap(MAP_W, MAP_H), k.level || 0, sd, k.seed);
  c.won = !!k.won; c.broke = !!k.broke; c.built = k.built !== false;
  install(c, k.cam);
  return true;
}

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
  about: function () { return Words.credit(T); }
});

// ── start ──
var input = new Input(view, {
  tool: function () { return held; },
  stroke: onStroke,
  cancel: function () { stroke = null; view.ghost = null; if (held) Tools.drop(city, held); heldLine(); },
  inspect: function (x, y) { inspectSheet(sheets, x, y); },
  hover: onHover,
  cursor: function (x, y) { view.cursor = x === null || x === undefined ? null : { x: x, y: y }; if (view.cursor) { onHover(view.cursor); } },
  moved: function () {}
});
void input;
root.addEventListener('resize', function () { view.resize(); });
if (root.ResizeObserver) new root.ResizeObserver(function () { view.resize(); }).observe($('cy-map'));
buildTray();
if (root.ZimiText && root.ZimiText.onChange) root.ZimiText.onChange(function () { buildTray(); if (city) { strip(); demand(); summary(); } });

// The tests' handle (as every game has one): the city, the map, and the clock run ahead by n steps.
root.__zimcity = { get city() { return city; }, get view() { return view; }, step: function (n) { for (var i = 0; i < n; i++) step(); strip(); demand(); } };

Shell.persist({ save: function () { return city ? pack() : null; }, load: unpack });
if (!city) { install(freshCity(pendingLevel)); record('new'); }
demand();
summary();
requestAnimationFrame(frame);
