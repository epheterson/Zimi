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
import * as Modern from './zimcity-modern.js';
import { isRoad } from './zimcity-words.js';

// The tray, in the order a city is built: a road, power to it, then the three zones; Bulldoze last before More.
export var TRAY = ['road', 'wire', 'residential', 'commercial', 'industrial', 'bulldozer'];
// The rest, in the More sheet.
export var MORE = ['rail', 'park', 'police', 'fire', 'stadium', 'port', 'airport', 'coal', 'nuclear', 'solar', 'wind', 'datacenter'];

// [cost, centre tile, size, animated] for the buildings; the drawn tools say their cost per tile.
var BUILDINGS = {
  residential: [100, TV.FREEZ, 3, false], commercial: [100, TV.COMCLR, 3, false], industrial: [100, TV.INDCLR, 3, false],
  police: [500, TV.POLICESTATION, 3, false], fire: [500, TV.FIRESTATION, 3, false], stadium: [5000, TV.STADIUM, 4, false],
  port: [3000, TV.PORT, 4, false], airport: [10000, TV.AIRPORT, 6, false], coal: [3000, TV.POWERPLANT, 4, false],
  nuclear: [5000, TV.NUCLEAR, 4, true],
  // the patch layer's own (zimcity-modern.js), in the engine's spare 3 x 3 slots
  solar: [3500, Modern.SOLAR, 3, false], wind: [2500, Modern.WIND, 3, false], datacenter: [12000, Modern.DATACENTER, 3, false]
};
export var PER_TILE = { road: 10, wire: 5, rail: 20, park: 10, bulldozer: 1 };
// What a tile costs over water (the engine's bridges and lines laid across it), for the tools that have one.
export var OVER_WATER = { road: 50, wire: 25, rail: 100 };

export function makeTools(map) {
  var t = { road: new RoadTool(map), wire: new WireTool(map), rail: new RailTool(map), park: new ParkTool(map), bulldozer: new BulldozerTool(map) };
  Object.keys(BUILDINGS).forEach(function (k) { var b = BUILDINGS[k]; t[k] = new BuildingTool(b[0], b[1], map, b[2], b[3]); });
  return t;
}
export function isDrawn(name) { return name in PER_TILE; }
// A building put down one at a time (a plant, a station, the airport): dragged into place, not laid in a row as zones are.
var ZONES = ['residential', 'commercial', 'industrial'];
export function isSingle(name) { return !!BUILDINGS[name] && ZONES.indexOf(name) < 0; }
export function sizeOf(name) { return BUILDINGS[name] ? BUILDINGS[name][2] : 1; }
export function waterCostOf(name) { return OVER_WATER[name] || 0; }
export function costOf(name) { return BUILDINGS[name] ? BUILDINGS[name][0] : PER_TILE[name]; }

// Try a stroke: the tool along `tiles` ([[x, y]], in order; for a building, the centre of each footprint) on the pending
// layer, without touching the city. Returns { tiles: [[x, y, value]], parts: [[x, y, ok]], cost, ok, why, short } and leaves
// the pending layer filled (build() builds it, drop() lets it go). why is 'ok', 'blocked', 'clear' or 'money'.
export function trial(city, name, tiles) {
  var tool = city.tools[name], map = city.map, budget = city.sim.budget, any = false, last = tool.TOOLRESULT_FAILED, parts = [];
  tool.clear();
  tiles.forEach(function (p) {
    if (!map.testBounds(p[0], p[1])) return;
    // A footprint that fails part-way (a tree cleared, then a tile that cannot be) must leave nothing pending: its dirt and
    // its cost would otherwise be built with the footprint that did fit.
    var pendingWas = Object.assign({}, tool._worldEffects._data), costWas = tool._applicationCost;
    tool.doTool(p[0], p[1], city.sim.blockMaps);
    if (tool.result !== tool.TOOLRESULT_OK) { tool._worldEffects._data = pendingWas; tool._applicationCost = costWas; }
    last = tool.result;
    parts.push([p[0], p[1], tool.result === tool.TOOLRESULT_OK]);
    if (tool.result === tool.TOOLRESULT_OK) any = true;
  });
  var cost = tool._applicationCost, pending = tool._worldEffects._data, out = [];
  Object.keys(pending).forEach(function (k) {
    var xy = k.split(',');
    out.push([+xy[0], +xy[1], pending[k].getValue()]);
  });
  var why = 'ok', blocker = null;
  if (!any) {
    why = last === tool.TOOLRESULT_NEEDS_BULLDOZE ? 'clear' : 'blocked';
    if (BUILDINGS[name] && parts.length) blocker = inTheWay(map, parts[parts.length - 1], sizeOf(name));
  } else if (cost > budget.totalFunds) why = 'money';
  return { tiles: out, parts: parts, cost: cost, ok: why === 'ok', why: why, blocker: blocker, short: Math.max(0, cost - budget.totalFunds) };
}

// A building aimed a tile or two wrong (its footprint is wider than a fingertip, so a tap beside a road lands on the road)
// goes to the nearest place it fits, preferring one flush against a road; one that fits where it was aimed does not move.
// Returns the tiles as they should be built: shifted by the same step when the first footprint had to move.
export var NUDGE_REACH = 2;
var BESIDE_ROAD_BONUS = 0.75;   // tiles of nudge a road beside the footprint is worth
// Whether every footprint of the row fits (a row is one tile for a tap, several for a drawn-out line of buildings).
function fits(city, name, row) {
  var r = trial(city, name, row);
  drop(city, name);
  return r.parts.length === row.length && r.parts.every(function (q) { return q[2]; });
}
function besideRoad(map, p, size) {
  var x0 = p[0] - 1, y0 = p[1] - 1;
  for (var i = 0; i < size; i++) {
    if ([[x0 + i, y0 - 1], [x0 + i, y0 + size], [x0 - 1, y0 + i], [x0 + size, y0 + i]].some(function (q) { return map.testBounds(q[0], q[1]) && isRoad(map.getTileValue(q[0], q[1])); })) return true;
  }
  return false;
}
export function nudge(city, name, tiles) {
  if (!BUILDINGS[name] || !tiles.length || fits(city, name, tiles)) return tiles;
  var at = tiles[0], size = sizeOf(name), best = null;
  for (var dy = -NUDGE_REACH; dy <= NUDGE_REACH; dy++) for (var dx = -NUDGE_REACH; dx <= NUDGE_REACH; dx++) {
    var p = [at[0] + dx, at[1] + dy], far = Math.hypot(dx, dy);
    if (!(dx || dy) || far > NUDGE_REACH + 0.5 || !fits(city, name, shifted(tiles, dx, dy))) continue;
    var score = far - (besideRoad(city.map, p, size) ? BESIDE_ROAD_BONUS : 0);
    if (!best || score < best.score) best = { dx: dx, dy: dy, score: score };
  }
  return best ? shifted(tiles, best.dx, best.dy) : tiles;
}
function shifted(tiles, dx, dy) { return tiles.map(function (q) { return [q[0] + dx, q[1] + dy]; }); }

// The first thing in a building's footprint (centre `p`, `size` square, as the engine lays it) that is not bare ground:
// a tile value, or null. A footprint centred on a finger beside a road overlaps the road, and the player is told so.
function inTheWay(map, p, size) {
  for (var y = p[1] - 1; y < p[1] - 1 + size; y++) for (var x = p[0] - 1; x < p[0] - 1 + size; x++) {
    if (!map.testBounds(x, y)) return TV.DIRT;   // past the edge
    var v = map.getTileValue(x, y);
    if (v !== TV.DIRT) return v;
  }
  return null;
}

// Build what trial() found: the money is spent and the city changes. The answer carries `undo`: each changed tile as it
// was and as it became, and the cost, so the last placement can be taken back while the city has not grown over it.
export function build(city, name, tiles) {
  var r = trial(city, name, tiles), tool = city.tools[name], map = city.map;
  if (!r.ok) { tool.clear(); return r; }
  var keys = Object.keys(tool._worldEffects._data).map(function (k) { return k.split(',').map(Number); });
  var was = keys.map(function (p) { return map.getTile(p[0], p[1]).getRawValue(); });
  tool.result = tool.TOOLRESULT_OK;
  tool.modifyIfEnoughFunding(city.sim.budget);
  r.undo = { cost: r.cost, tiles: keys.map(function (p, i) { return [p[0], p[1], was[i], map.getTile(p[0], p[1]).getRawValue()]; }) };
  return r;
}

// Take a placement back: every tile it changed must still be as it left it (a zone that has grown, a fire, a flood: no).
export function undo(city, rec) {
  var map = city.map;
  if (!rec || !rec.tiles.every(function (t) { return map.getTile(t[0], t[1]).getRawValue() === t[3]; })) return false;
  rec.tiles.forEach(function (t) { map.setTileValue(t[0], t[1], t[2]); });
  city.sim.budget.spend(-rec.cost);
  return true;
}

// A building drawn by dragging: footprints side by side along the way the finger went furthest, from where it began.
export function row(name, from, to) {
  var size = sizeOf(name), dx = to[0] - from[0], dy = to[1] - from[1], out = [from];
  var along = Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy)], n = Math.floor(Math.max(Math.abs(dx), Math.abs(dy)) / size);
  for (var k = 1; k <= n; k++) out.push([from[0] + along[0] * size * k, from[1] + along[1] * size * k]);
  return out;
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
