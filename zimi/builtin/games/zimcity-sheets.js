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
  var body = [Play.optionRow(s.T('city.speed'), choices, s.speed(), function (v) { s.speed(v); })];
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
  if (tile.isZone()) rows.unshift([T('city.q.power'), T(tile.isPowered() ? 'city.q.powerOn' : 'city.q.powerOff')]);
  Shell.sheet({ title: T(Words.kindOf(tile.getValue())), body: [list(rows)], actions: [{ label: T('shell.close'), primary: true }] });
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

export function newGameRows(s) {
  return [Play.optionRow(s.T('board.level'), [[Simulation.LEVEL_EASY, s.T('board.level.easy')], [Simulation.LEVEL_MED, s.T('board.level.medium')], [Simulation.LEVEL_HARD, s.T('board.level.hard')]], s.level(), function (v) { s.level(v); })];
}
export function settingsRows(s) {
  return [Play.optionRow(s.T('city.set.disasters'), [[false, s.T('shell.off')], [true, s.T('shell.on')]], s.disasters(), function (v) { s.disasters(v); })];
}
