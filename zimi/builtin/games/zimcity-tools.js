/* ZimCity: the tools, and what a stroke of one would cost before it is built. Our own code, GPL-3.0.

   Every tool is the engine's own (road, rail, power line, park, bulldozer, the zones and buildings). A stroke is
   tried on the engine's pending layer (WorldEffects) without touching the city: that gives the tiles it would lay,
   its total cost and whether it can be built, so the ghost on the map tells the truth. Building does the same try
   again on the city as it is at that moment and spends the money. */

import { BuildingTool } from './zimcity/engine/buildingTool.js';
import { BulldozerTool } from './zimcity/engine/bulldozerTool.js';
import { ParkTool } from './zimcity/engine/parkTool.js';
import { RailTool } from './zimcity/engine/railTool.js';
import { RoadTool } from './zimcity/engine/roadTool.js';
import { WireTool } from './zimcity/engine/wireTool.js';
import * as TV from './zimcity/engine/tileValues.js';

// The tray, in the order a city is built: a road, power to it, then the three zones; Bulldoze last before More.
export var TRAY = ['road', 'wire', 'residential', 'commercial', 'industrial', 'bulldozer'];
// The rest, in the More sheet.
export var MORE = ['rail', 'park', 'police', 'fire', 'stadium', 'port', 'airport', 'coal', 'nuclear'];

// [cost, centre tile, size, animated] for the buildings; the drawn tools say their cost per tile.
var BUILDINGS = {
  residential: [100, TV.FREEZ, 3, false], commercial: [100, TV.COMCLR, 3, false], industrial: [100, TV.INDCLR, 3, false],
  police: [500, TV.POLICESTATION, 3, false], fire: [500, TV.FIRESTATION, 3, false], stadium: [5000, TV.STADIUM, 4, false],
  port: [3000, TV.PORT, 4, false], airport: [10000, TV.AIRPORT, 6, false], coal: [3000, TV.POWERPLANT, 4, false],
  nuclear: [5000, TV.NUCLEAR, 4, true]
};
export var PER_TILE = { road: 10, wire: 5, rail: 20, park: 10, bulldozer: 1 };

export function makeTools(map) {
  var t = { road: new RoadTool(map), wire: new WireTool(map), rail: new RailTool(map), park: new ParkTool(map), bulldozer: new BulldozerTool(map) };
  Object.keys(BUILDINGS).forEach(function (k) { var b = BUILDINGS[k]; t[k] = new BuildingTool(b[0], b[1], map, b[2], b[3]); });
  return t;
}
export function isDrawn(name) { return name in PER_TILE; }
export function sizeOf(name) { return BUILDINGS[name] ? BUILDINGS[name][2] : 1; }
export function costOf(name) { return BUILDINGS[name] ? BUILDINGS[name][0] : PER_TILE[name]; }

// Why a stroke cannot be built, in the order a person should hear it.
export var WHY = { ok: '', blocked: 'zc.why.blocked', clear: 'zc.why.clear', money: 'zc.why.money' };

// Try a stroke: the tool along `tiles` ([[x, y]], in order) on the pending layer. Returns
// { tiles: [[x, y, value]], cost, ok, why, short } and leaves the pending layer filled (apply() builds it, clear() drops it).
export function trial(city, name, tiles) {
  var tool = city.tools[name], map = city.map, budget = city.sim.budget, any = false, last = tool.TOOLRESULT_FAILED;
  tool.clear();
  tiles.forEach(function (p) {
    if (!map.testBounds(p[0], p[1])) return;
    tool.doTool(p[0], p[1], city.sim.blockMaps);
    last = tool.result;
    if (tool.result === tool.TOOLRESULT_OK) any = true;
  });
  var cost = tool._applicationCost, pending = tool._worldEffects._data, out = [];
  Object.keys(pending).forEach(function (k) {
    var xy = k.split(','), tile = pending[k];
    out.push([+xy[0], +xy[1], tile.getValue()]);
  });
  var why = 'ok';
  if (!any) why = last === tool.TOOLRESULT_NEEDS_BULLDOZE ? 'clear' : 'blocked';
  else if (cost > budget.totalFunds) why = 'money';
  return { tiles: out, cost: cost, ok: why === 'ok', why: why, short: Math.max(0, cost - budget.totalFunds) };
}

// Build what trial() found: the money is spent and the city changes. Returns the trial's answer.
export function build(city, name, tiles) {
  var r = trial(city, name, tiles), tool = city.tools[name];
  if (!r.ok) { tool.clear(); return r; }
  tool.result = tool.TOOLRESULT_OK;
  tool.modifyIfEnoughFunding(city.sim.budget);
  return r;
}

export function drop(city, name) { if (name && city.tools[name]) city.tools[name].clear(); }

// The tiles a finger crossed between two tiles, each a step up, down, left or right from the one before it, so a
// diagonal stroke still lays a road that connects.
export function steps(a, b) {
  var out = [], x = a[0], y = a[1], dx = Math.abs(b[0] - x), dy = Math.abs(b[1] - y), sx = x < b[0] ? 1 : -1, sy = y < b[1] ? 1 : -1, err = dx - dy;
  while (x !== b[0] || y !== b[1]) {
    var e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; } else { err += dx; y += sy; }
    out.push([x, y]);
  }
  return out;
}
