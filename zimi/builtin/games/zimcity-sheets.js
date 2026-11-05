/* ZimCity: the sheets (budget, city report, layers, speed, a tile up close, the rest of the tools) and the rows the
   shell's New game and Settings panes show. Our own code, GPL-3.0. All of them are the shell's own sheet and option rows;
   `s` is what the page lends them: the city, the words and the few settings they change. */

import { Simulation } from './zimcity/engine/simulation.js';
import * as Tools from './zimcity-tools.js';
import * as Words from './zimcity-words.js';

var Shell = window.ZimiShell, Play = window.ArcadePlay;
var TAX_MAX = 20, FUND_STEP = 10;
var PROBLEM_IDS = ['crime', 'pollution', 'housing', 'taxes', 'traffic', 'unemployment', 'fire'];
var LAYER_IDS = ['off', 'traffic', 'pollution', 'crime', 'land'];

function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function list(rows) {
  var dl = el('dl', 'gs-statlist');
  rows.forEach(function (r) { dl.appendChild(el('dt', '', r[0])); dl.appendChild(el('dd', '', r[1])); });
  return dl;
}
function pct(s, n) { return s.T('city.pct', { n: Math.round(n) }); }

// A number to set with a step down and a step up: a label on the left, − value + on the right, each 44 px.
function stepper(label, value, min, max, step, words, onChange) {
  var row = el('div', 'gs-row cy-step'), lab = el('label', '', label), box = el('div', 'gs-seg cy-stepper');
  var down = el('button', 'ar-btn', '−'), out = el('output', 'cy-step-v'), up = el('button', 'ar-btn', '+');
  down.type = up.type = 'button';
  box.setAttribute('role', 'group'); box.setAttribute('aria-label', label);
  function paint() {
    out.textContent = words(value);
    down.disabled = value <= min; up.disabled = value >= max;
    down.setAttribute('aria-label', label + ' −'); up.setAttribute('aria-label', label + ' +');
  }
  function to(v) { value = Math.max(min, Math.min(max, v)); paint(); onChange(value); }
  down.addEventListener('click', function () { to(value - step); });
  up.addEventListener('click', function () { to(value + step); });
  box.appendChild(down); box.appendChild(out); box.appendChild(up);
  row.appendChild(lab); row.appendChild(box);
  paint();
  return row;
}

// The budget: the tax rate and how much of what roads, fire and police need is paid. When the year's budget is due
// (the engine waits on it), closing the sheet settles it.
export function budgetSheet(s, forced) {
  var c = s.city(), b = c.sim.budget;
  var v = { tax: b.cityTax, road: Math.round(b.roadPercent * 100), fire: Math.round(b.firePercent * 100), police: Math.round(b.policePercent * 100), auto: b.autoBudget };
  var costs = el('p', 'gs-text cy-costs');
  function paintCosts() {
    var spend = b.roadMaintenanceBudget * v.road / 100 + b.fireMaintenanceBudget * v.fire / 100 + b.policeMaintenanceBudget * v.police / 100;
    costs.textContent = s.T('city.b.year', { taxes: s.money(b.taxFund), costs: s.money(spend) });
  }
  function need(amount) { return function (n) { return s.T('city.b.of', { pct: pct(s, n), money: s.money(amount * n / 100) }); }; }
  var body = [
    list([[s.T('city.b.funds'), s.money(b.totalFunds)]]),
    stepper(s.T('city.b.tax'), v.tax, 0, TAX_MAX, 1, function (n) { return pct(s, n); }, function (n) { v.tax = n; paintCosts(); }),
    stepper(s.T('city.b.roads'), v.road, 0, 100, FUND_STEP, need(b.roadMaintenanceBudget), function (n) { v.road = n; paintCosts(); }),
    stepper(s.T('city.b.fire'), v.fire, 0, 100, FUND_STEP, need(b.fireMaintenanceBudget), function (n) { v.fire = n; paintCosts(); }),
    stepper(s.T('city.b.police'), v.police, 0, 100, FUND_STEP, need(b.policeMaintenanceBudget), function (n) { v.police = n; paintCosts(); }),
    Play.optionRow(s.T('city.b.auto'), [[false, s.T('shell.off')], [true, s.T('shell.on')]], v.auto, function (on) { v.auto = on; }),
    costs
  ];
  paintCosts();
  var settled = false;
  function settle() {
    if (settled) return;
    settled = true;
    b.roadPercent = v.road / 100; b.firePercent = v.fire / 100; b.policePercent = v.police / 100;
    b.setTax(v.tax);
    b.setAutoBudget(v.auto);
    if (b.awaitingValues) b.doBudgetWindow(); else b.updateFundEffects();
    s.strip();
  }
  Shell.sheet({ title: s.T(forced ? 'city.b.due' : 'city.budget'), text: forced ? s.T('city.b.dueText') : '', body: body,
                actions: [{ label: s.T('shell.close'), primary: true }], onClose: settle });
}

// How the city is doing: what people think of the mayor, the score, the size, and what they complain about most.
export function reportSheet(s) {
  var c = s.city(), e = c.sim.evaluation;
  var rows = [[s.T('city.r.approval'), pct(s, e.cityYes)], [s.T('city.r.score'), window.ZimiText.number(e.cityScore)],
              [s.T('city.r.people'), window.ZimiText.number(s.people())], [s.T('city.r.size'), s.T('city.class.' + String(e.cityClass).toLowerCase())]];   // the engine names the sizes VILLAGE to MEGALOPOLIS
  var votes = e.problemVotes.filter(function (p) { return p.voteCount > 0; }).slice(0, 4);
  var body = [list(rows), el('h3', 'cy-sub', s.T('city.r.problems'))];
  if (!votes.length) body.push(el('p', 'gs-text', s.T('city.r.none')));
  else body.push(list(votes.map(function (p) { return [s.T('city.p.' + PROBLEM_IDS[p.index]), pct(s, p.voteCount)]; })));
  Shell.sheet({ title: s.T('city.report'), body: body, actions: [{ label: s.T('shell.close'), primary: true }] });
}

// One tint over the map for one fact; Off is the plain map.
export function layersSheet(s) {
  var row = Play.optionRow(s.T('city.layers'), LAYER_IDS.map(function (k) { return [k, k === 'off' ? s.T('shell.off') : s.T('city.l.' + k)]; }), s.layer(), function (v) { s.layer(v); }, 'pl-grid');
  Shell.sheet({ title: s.T('city.layers'), text: s.T('city.l.text'), body: [row], actions: [{ label: s.T('shell.close'), primary: true }] });
}

// Slow, Normal and Fast; Fast only while the device keeps up with it.
export function speedSheet(s) {
  var choices = [[Simulation.SPEED_SLOW, s.T('city.s.slow')], [Simulation.SPEED_MED, s.T('city.s.normal')]];
  if (s.fastOK()) choices.push([Simulation.SPEED_FAST, s.T('city.s.fast')]);
  // Paused is a speed too: inside Zimi's own header only Undo fits, so this is where the city stops and goes on there.
  choices.unshift([0, s.T('city.s.paused')]);
  var body = [Play.optionRow(s.T('city.speed'), choices, s.paused() ? 0 : s.speed(), function (v) { if (v) { s.paused(false); s.speed(v); } else s.paused(true); }, 'pl-grid')];
  if (!s.fastOK()) body.push(el('p', 'gs-text', s.T('city.s.fastOff')));
  Shell.sheet({ title: s.T('city.speed'), body: body, actions: [{ label: s.T('shell.close'), primary: true }] });
}

// A tile up close: what it is, and the block maps' four-step readings where it stands.
export function inspectSheet(s, x, y) {
  var c = s.city(), map = c.map;
  if (!map.testBounds(x, y)) return;
  var bm = c.sim.blockMaps, tile = map.getTile(x, y), T = s.T;
  var rows = [
    [T('city.q.density'), T('city.lvl.density.' + Words.quarter(bm.populationDensityMap.worldGet(x, y)))],
    [T('city.q.value'), T('city.lvl.value.' + Words.landStep(bm.landValueMap.worldGet(x, y)))],
    [T('city.q.crime'), T('city.lvl.crime.' + Words.quarter(bm.crimeRateMap.worldGet(x, y)))],
    [T('city.q.pollution'), T('city.lvl.pollution.' + Words.quarter(bm.pollutionDensityMap.worldGet(x, y)))],
    [T('city.q.growth'), T('city.lvl.growth.' + Words.growthStep(bm.rateOfGrowthMap.worldGet(x, y)))]
  ];
  var kind = Words.kindOf(tile.getValue()), centre = zoneCentre(map, x, y), body = [];
  if (centre) {
    rows.unshift([T('city.q.power'), T(centre.tile.isPowered() ? 'city.q.powerOn' : 'city.q.powerOff')]);
    var held = holdingBack(c, kind, centre, x, y);
    if (held.length) body.push(el('p', 'gs-text cy-why', T('city.why2.title', { reasons: held.map(function (k) { return T('city.why2.' + k); }).join(T('city.why2.and')) })));
  }
  body.unshift(list(rows));
  var read = s.library.link(kind, T);
  if (read) body.push(read);
  Shell.sheet({ title: T(kind), body: body, actions: [{ label: T('shell.close'), primary: true }] });
}

// The zone a tile belongs to: its centre tile carries the zone flag (a 3 x 3 zone's centre is at most one step away).
function zoneCentre(map, x, y) {
  for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
    if (map.testBounds(x + dx, y + dy) && map.getTile(x + dx, y + dy).isZone()) return { tile: map.getTile(x + dx, y + dy), cx: x + dx, cy: y + dy };
  }
  return null;
}
// Why homes, shops or industry are not growing, in the order a player can fix it: power, a road beside it, demand,
// then what keeps people away (pollution and crime for homes).
var DEMAND = { 'city.kind.residential': '_resValve', 'city.kind.commercial': '_comValve', 'city.kind.industrial': '_indValve' };
function holdingBack(c, kind, centre, x, y) {
  if (!DEMAND[kind]) return [];
  var map = c.map, bm = c.sim.blockMaps, out = [], road = false;
  if (!centre.tile.isPowered()) out.push('power');
  for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
    var tx = centre.cx + dx, ty = centre.cy + dy;
    if (map.testBounds(tx, ty) && Words.isRoad(map.getTileValue(tx, ty))) road = true;
  }
  if (!road) out.push('road');
  var valve = { '_resValve': c.sim._valves.resValve, '_comValve': c.sim._valves.comValve, '_indValve': c.sim._valves.indValve }[DEMAND[kind]];
  if (valve <= 0) out.push('demand');
  if (kind === 'city.kind.residential') {
    if (Words.quarter(bm.pollutionDensityMap.worldGet(x, y)) >= 2) out.push('pollution');
    if (Words.quarter(bm.crimeRateMap.worldGet(x, y)) >= 2) out.push('crime');
  }
  return out;
}

// The rest of the tools: each with its icon, name and cost; choosing one puts it in the hand.
export function moreSheet(s) {
  var grid = el('div', 'cy-more'), api = null;
  Tools.MORE.forEach(function (name) {
    var b = el('button', 'cy-more-tool'), label = s.T('city.tool.' + name);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(s.held() === name));
    b.appendChild(s.iconSvg(name));
    b.appendChild(el('span', 'cy-more-l', label));
    b.appendChild(el('small', 'cy-more-c', s.costWords(name)));
    b.addEventListener('click', function () { s.hold(name); if (api) api.close(); });
    grid.appendChild(b);
  });
  api = Shell.sheet({ title: s.T('city.more'), body: [grid], actions: [{ label: s.T('shell.close') }] });
}

// Kept cities: keep the one in progress (up to five), open one (the city in progress takes its place), or delete one.
export function citiesSheet(s) {
  var c = s.cities, api = null, body = [], list = c.list();
  var keep = el('button', 'ar-btn cy-keep', s.T('city.k.keep'));
  keep.type = 'button';
  if (list.length >= c.max) { keep.disabled = true; body.push(el('p', 'gs-text', s.T('city.k.full', { n: c.max }))); }
  keep.addEventListener('click', function () { if (c.keep()) { api.close(); citiesSheet(s); } });
  body.unshift(keep);
  if (!list.length) body.push(el('p', 'gs-text', s.T('city.k.none')));
  list.forEach(function (k, i) {
    var row = el('div', 'gs-row cy-kept'), what = el('span', 'cy-kept-what');
    what.appendChild(el('b', '', s.dateOf(k.month, k.year)));
    what.appendChild(el('small', '', s.T('city.k.line', { people: s.T('city.people', { n: k.people }), money: s.money(k.funds) })));
    var open = el('button', 'ar-btn', s.T('city.k.open')), del = el('button', 'ar-btn', s.T('city.k.delete'));
    open.type = del.type = 'button';
    open.addEventListener('click', function () { api.close(); c.open(i); });
    // Delete asks once, in place: the button says so, and a second tap deletes.
    del.addEventListener('click', function () {
      if (del.dataset.sure) { c.remove(i); api.close(); citiesSheet(s); return; }
      del.dataset.sure = '1'; del.textContent = s.T('city.k.sure');
    });
    var acts = el('span', 'cy-kept-acts'); acts.appendChild(open); acts.appendChild(del);
    row.appendChild(what); row.appendChild(acts);
    body.push(row);
  });
  api = Shell.sheet({ title: s.T('city.cities'), text: s.T('city.k.text'), body: body, actions: [{ label: s.T('shell.close'), primary: true }] });
}

// Scenarios (the original's eight, each a real city in trouble with a goal and a deadline) and the 24 ready-made
// cities. A real place links to its article and, where an installed map holds it, to the map.
export function scenariosSheet(s) {
  var sc = s.scenarios, api = null, body = [];
  function placeLinks(row, key, lat, lon, label) {
    var read = s.library.link(key, s.T);
    var box = el('span', 'cy-sc-links');
    if (read) { read.className = 'cy-sc-read'; box.appendChild(read.firstChild); }
    s.library.mapLink(lat, lon, label, s.T).then(function (a) { if (a) { if (box.childNodes.length) box.appendChild(document.createTextNode(' \u00b7 ')); box.appendChild(a); } });
    row.appendChild(box);
  }
  sc.list.forEach(function (x) {
    var row = el('div', 'gs-row cy-sc'), what = el('span', 'cy-kept-what'), play = el('button', 'ar-btn', s.T('city.sc.play'));
    what.appendChild(el('b', '', s.T('city.sct.' + x.id))); what.appendChild(el('small', '', s.T('city.scl.' + x.id)));
    if (x.place) placeLinks(what, 'place.' + x.id, x.place[1], x.place[2], s.T('city.sct.' + x.id).split(',')[0]);
    play.type = 'button'; play.addEventListener('click', function () { api.close(); sc.play(x); });
    row.appendChild(what); row.appendChild(play); body.push(row);
  });
  body.push(el('h3', 'cy-sub', s.T('city.sc.maps')));
  var grid = el('div', 'cy-maps');
  sc.maps.forEach(function (m) {
    var b = el('button', 'ar-btn', s.T('city.map.' + m[0]));
    b.type = 'button'; b.addEventListener('click', function () { api.close(); sc.open(m); });
    grid.appendChild(b);
  });
  body.push(grid);
  body.push(el('p', 'gs-text cy-sc-note', s.T('city.sc.credit')));
  api = Shell.sheet({ title: s.T('city.scenarios'), text: s.T('city.sc.text'), body: body, actions: [{ label: s.T('shell.close'), primary: true }] });
}

export function newGameRows(s) {
  return [Play.optionRow(s.T('board.level'), [[Simulation.LEVEL_EASY, s.T('board.level.easy')], [Simulation.LEVEL_MED, s.T('board.level.medium')], [Simulation.LEVEL_HARD, s.T('board.level.hard')]], s.level(), function (v) { s.level(v); })];
}
export function settingsRows(s) {
  return [Play.optionRow(s.T('city.set.disasters'), [[false, s.T('shell.off')], [true, s.T('shell.on')]], s.disasters(), function (v) { s.disasters(v); }),
          Play.optionRow(s.T('city.set.climate'), [[false, s.T('shell.off')], [true, s.T('shell.on')]], s.climateOn(), function (v) { s.climateOn(v); })];
}

// Follow someone: the four citizens, each with what they do and what they think right now, and Follow. With no home
// and job joined by a road yet, it says so instead.
var PEOPLE_IDS = [['commuter', 'Dale Pemberton'], ['developer', 'Vivian Crane'], ['activist', 'Juniper Ash'], ['rival', 'Gordon Plumb']];
export function followSheet(s) {
  var T = s.T, api = null, body = [];
  if (!s.commutes()) body.push(el('p', 'gs-text', T('city.fw.none')));
  else PEOPLE_IDS.forEach(function (p, i) {
    var row = el('div', 'gs-row cy-fw-row'), what = el('span', 'cy-kept-what');
    what.appendChild(el('b', '', p[1]));
    what.appendChild(el('small', '', T('city.fw.role.' + p[0])));
    what.appendChild(el('q', 'cy-fw-q', T('city.v.' + p[0] + '.' + s.mood(p[0]) + '.' + (i % 2))));
    var go = el('button', 'ar-btn', T('city.fw.go')); go.type = 'button';
    go.addEventListener('click', function () {
      if (s.follow(p[0])) { api.close(); return; }
      go.disabled = true; go.textContent = T('city.fw.noway');
    });
    row.appendChild(what); row.appendChild(go); body.push(row);
  });
  api = Shell.sheet({ title: T('city.follow'), text: s.commutes() ? T('city.fw.text') : '', body: body, actions: [{ label: T('shell.close'), primary: !s.commutes() }] });
}

// The climate, plainly: how much warmer, how much higher the sea, where the power comes from, and a heat wave if there
// is one; that it is a toy model; and the real articles, when the library has them.
export function climateSheet(s) {
  var c = s.climate(), Z = window.ZimiText, T = s.T;
  var deg = Z.number(c.warm, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var rows = [[T('city.cl.warm'), T('city.cl.deg', { n: deg })], [T('city.cl.sea'), T('city.cl.cm', { n: c.seaCm })],
              [T('city.cl.coal'), pct(s, c.coal * 100)], [T('city.cl.clean'), pct(s, (c.solar + c.wind + c.nuclear) * 100)],
              [T('city.cl.summer'), T(c.heat ? 'city.cl.heatNow' : 'city.cl.heatNone')]];
  var body = [list(rows), el('p', 'gs-text', T(c.coal + c.nuclear + c.solar + c.wind === 0 ? 'city.cl.noPower' : c.coal > 0.5 ? 'city.cl.mostlyCoal' : c.coal > 0 ? 'city.cl.someCoal' : 'city.cl.noCoal')),
              el('p', 'gs-text cy-sc-note', T('city.cl.toy'))];
  if (!s.climateOn()) body.unshift(el('p', 'gs-text', T('city.cl.off')));
  ['climate.change', 'climate.sea', 'climate.heat'].forEach(function (k) { var a = s.library.link(k, T); if (a) body.push(a); });
  Shell.sheet({ title: T('city.climate'), body: body, actions: [{ label: T('shell.close'), primary: true }] });
}
