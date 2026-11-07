/* ZimCity's climate: a toy model, said as one. Our own code, GPL-3.0.

   The city's coal burns carbon (and its data centers, for the share of their power that comes from coal); the carbon
   adds up; the warming follows it, slowly; the sea follows the warming, more slowly still. Over decades a shore gives up
   a few tiles to the water, and summers bring heat waves that draw more power and, with disasters on, start fires.
   Solar, wind and nuclear add nothing. A real climate is warmed by the whole world, not one city: the sheet says so.

   One tick is one of the engine's 48 a year. Chance is seeded by the city's clock, so a city plays out the same way. */

import { mix, counted, isWater, WIND_LOW, WIND_SPAN } from './zimcity-modern.js';
import { DIRT, RIVER, REDGE, TREEBASE, WOODS5, RUBBLE, LASTRUBBLE } from './zimcity/engine/tileValues.js';

export var PER_DEGREE = 6000;     // carbon (a coal plant's tick is 1) for one degree of warming: a few plants, decades
export var MAX_WARM = 4;
export var SEA_PER_DEGREE = 0.3;  // metres of sea for each degree, reached slowly
var SEA_EASE = 0.004;             // the share of the way the sea moves toward that each tick
export var SEA_STEP = 0.05;       // each 5 cm more takes a little of the shore
var SHORE_TAKEN = 3;              // land tiles the water takes at each step
var HEAT_HEAT = 1.25;             // a heat wave's extra draw on the power
var DATA_COAL_SHARE = 0.7;        // a data center's carbon, per tick, at a fully coal-fired grid
var SUMMER = [5, 6, 7];           // June, July, August
var HEAT_CHANCE_PER_DEGREE = 0.2; // a summer month's chance of a heat wave, for each degree of warming
var HEAT_CHANCE_MAX = 0.6;        // ...at most
var FIRE_CHANCE_PER_DEGREE = 0.04; // a heat wave's chance each tick of starting a fire (disasters on), per degree

export function fresh() { return { carbon: 0, warm: 0, sea: 0, steps: 0, heat: false }; }

// A number in [0, 1) from the clock and a salt: the same city, the same weather.
function chance(t, salt) {
  var h = (t * 2654435761 + salt * 40503) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function bare(v) { return v === DIRT || (v >= TREEBASE && v <= WOODS5) || (v >= RUBBLE && v <= LASTRUBBLE); }

// The sea takes a few bare shore tiles (land beside water), the lowest first: those touching the most water.
function takeShore(map, n) {
  var shore = [];
  for (var y = 0; y < map.height; y++) for (var x = 0; x < map.width; x++) {
    if (!bare(map.getTileValue(x, y))) continue;
    var wet = 0;
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) { if (map.testBounds(x + d[0], y + d[1]) && isWater(map.getTileValue(x + d[0], y + d[1]))) wet++; });
    if (wet) shore.push([x, y, wet]);
  }
  shore.sort(function (a, b) { return b[2] - a[2] || a[1] - b[1] || a[0] - b[0]; });
  return shore.slice(0, n).map(function (p) { map.setTile(p[0], p[1], wetTile(p[2]), 0); return [p[0], p[1]]; });
}
function wetTile(wet) { return wet >= 3 ? RIVER : REDGE; }

// One tick. `state` is kept with the city; `on` is the Climate setting, `disasters` the Disasters one. Returns what
// happened this tick: a list of 'heatwave', 'sea' and 'fire'.
export function tick(sim, state, on, disasters) {
  var census = sim._census, t = sim._cityTime, out = [];
  if (!on) { census.zcHeat = 1; state.heat = false; return out; }   // a heat wave does not wait for the climate to come back on
  // Called right after the month's clear, so it reads the last whole count, not the census just emptied.
  var full = counted(census), m = mix(full), zc = full.zc || { data: 0 };
  state.carbon += full.coalPowerPop + zc.data * m.coal * DATA_COAL_SHARE;
  state.warm = Math.min(MAX_WARM, state.carbon / PER_DEGREE);
  state.sea += (state.warm * SEA_PER_DEGREE - state.sea) * SEA_EASE;
  var steps = Math.floor(state.sea / SEA_STEP);
  if (steps > state.steps) {
    state.steps = steps;
    if (takeShore(sim._map, SHORE_TAKEN).length) out.push('sea');
  }
  // Each month: the wind for the wind farms, and in summer perhaps a heat wave (likelier the warmer the city).
  if (t % 4 === 0) {
    census.zcWind = WIND_LOW + chance(t, 1) * WIND_SPAN;
    var month = (t % 48) >> 2, was = state.heat;
    state.heat = SUMMER.indexOf(month) >= 0 && chance(t, 2) < Math.min(HEAT_CHANCE_MAX, state.warm * HEAT_CHANCE_PER_DEGREE);
    if (state.heat && !was) out.push('heatwave');
  }
  census.zcHeat = state.heat ? HEAT_HEAT : 1;
  if (state.heat && disasters && chance(t, 3) < FIRE_CHANCE_PER_DEGREE * state.warm) { sim.disasterManager.makeFire(); out.push('fire'); }
  return out;
}

// What the sheet says: degrees, centimetres, the share of coal, and whether it is a heat wave.
export function summary(sim, state) {
  var m = mix(counted(sim._census));
  return { warm: state.warm, seaCm: Math.round(state.sea * 100), coal: m.coal, nuclear: m.nuclear, solar: m.solar, wind: m.wind, heat: state.heat };
}

