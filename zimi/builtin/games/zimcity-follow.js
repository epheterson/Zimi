/* ZimCity: follow one citizen on the commute. Our own code, GPL-3.0.

   Nothing here changes the city. A citizen lives in a real home zone with people in it and works in a real commercial
   or industrial zone with jobs in it, joined by the city's roads: the route is the shortest one over road tiles (bridges
   and level crossings included) from a road beside the home to a road beside the work. The figure walks it at a pace
   the traffic on each tile sets (the engine's traffic density), spends a while at work, comes home, and goes again. If
   the roads change under the route, the next trip finds a new one; if there is none, the walk ends. */

import { Residential } from './zimcity/engine/residential.js';
import { Commercial } from './zimcity/engine/commercial.js';
import { Industrial } from './zimcity/engine/industrial.js';
import * as TV from './zimcity/engine/tileValues.js';
import { isRoad } from './zimcity-words.js';

export var TILES_PER_SECOND = 3.2;   // the pace on an empty road, at the middle speed
var JAM = 90;                        // traffic density at which the pace halves
var AT_WORK_S = 6, AT_HOME_S = 4;    // how long the figure stays, in seconds of running city
var LEVEL_CROSSINGS = [TV.HRAILROAD, TV.HRAILROAD + 1];
var AROUND = [[-2, -1], [-2, 0], [-2, 1], [2, -1], [2, 0], [2, 1], [-1, -2], [0, -2], [1, -2], [-1, 2], [0, 2], [1, 2]];
var STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function passable(v) { return isRoad(v) || LEVEL_CROSSINGS.indexOf(v) >= 0; }

// Every 3 x 3 zone with people (homes) or jobs (work) in it: [{x, y, kind, n}] with x, y its centre.
export function zones(map) {
  var homes = [], work = [];
  for (var y = 0; y < map.height; y++) for (var x = 0; x < map.width; x++) {
    var t = map.getTile(x, y);
    if (!t.isZone()) continue;
    var v = t.getValue(), n;
    if (v >= TV.RESBASE && v < TV.HOSPITALBASE) { n = Residential.getZonePopulation(map, x, y, v); if (n > 0) homes.push({ x: x, y: y, kind: 'home', n: n }); }
    else if (v >= TV.COMBASE && v < TV.INDBASE) { n = Commercial.getZonePopulation(map, x, y, v); if (n > 0) work.push({ x: x, y: y, kind: 'shops', n: n }); }
    else if (v >= TV.INDBASE && v < TV.PORTBASE) { n = Industrial.getZonePopulation(map, x, y, v); if (n > 0) work.push({ x: x, y: y, kind: 'industry', n: n }); }
  }
  return { homes: homes, work: work };
}

// The road tiles touching a 3 x 3 zone's edge.
function doors(map, z) {
  return AROUND.map(function (d) { return [z.x + d[0], z.y + d[1]]; })
    .filter(function (p) { return map.testBounds(p[0], p[1]) && passable(map.getTileValue(p[0], p[1])); });
}

// The shortest road route from any door of `from` to a door of any zone in `to`: {path: [[x, y], ...], to: zone} or null.
export function route(map, from, to) {
  var W = map.width, prev = new Int32Array(W * map.height).fill(-2), q = [], goal = {};
  [].concat(to).forEach(function (z) { doors(map, z).forEach(function (p) { if (!goal[p[1] * W + p[0]]) goal[p[1] * W + p[0]] = z; }); });
  doors(map, from).forEach(function (p) { var i = p[1] * W + p[0]; if (prev[i] === -2) { prev[i] = -1; q.push(i); } });
  for (var h = 0; h < q.length; h++) {
    var i = q[h];
    if (goal[i]) {
      var path = [];
      for (var k = i; k >= 0; k = prev[k]) path.push([k % W, Math.floor(k / W)]);
      return { path: path.reverse(), to: goal[i] };
    }
    var x = i % W, y = Math.floor(i / W);
    for (var s = 0; s < 4; s++) {
      var nx = x + STEPS[s][0], ny = y + STEPS[s][1], j = ny * W + nx;
      if (!map.testBounds(nx, ny) || prev[j] !== -2 || !passable(map.getTileValue(nx, ny))) continue;
      prev[j] = i; q.push(j);
    }
  }
  return null;
}

// A home and a job for a citizen, the same ones each time for the same city: homes are tried from the `pick`th on,
// and each goes to its nearest job by road, of the `prefer`red kind ('shops' or 'industry') when the roads reach one.
// Returns {home, work, path} or null.
export function commute(map, pick, prefer) {
  var z = zones(map);
  if (!z.homes.length || !z.work.length) return null;
  var liked = z.work.filter(function (w) { return w.kind === prefer; }), rest = z.work.filter(function (w) { return w.kind !== prefer; });
  for (var h = 0; h < z.homes.length; h++) {
    var home = z.homes[(pick + h) % z.homes.length];
    var r = (liked.length && route(map, home, liked)) || (rest.length && route(map, home, rest));
    if (r) return { home: home, work: r.to, path: r.path };
  }
  return null;
}

// One citizen's walk: phase 'toWork', 'atWork', 'toHome' or 'atHome'; `at` is the position in tiles (fractional).
export function Walk(trip) {
  this.trip = trip; this.phase = 'toWork'; this.i = 0; this.f = 0; this.wait = 0; this.slow = false;
  this.at = { x: trip.path[0][0], y: trip.path[0][1] };
}
// Advance by `dt` seconds of running city; `traffic(x, y)` is the engine's density there (0 to 240). Returns true when
// a trip has just ended (the page may look for a new route then).
Walk.prototype.advance = function (dt, traffic) {
  if (this.phase === 'atWork' || this.phase === 'atHome') {
    this.wait -= dt;
    if (this.wait > 0) return false;
    this.phase = this.phase === 'atWork' ? 'toHome' : 'toWork';
    this.i = 0; this.f = 0;
    return true;
  }
  var path = this.trip.path, dir = this.phase === 'toWork' ? 1 : -1;
  var idx = function (i) { return dir > 0 ? i : path.length - 1 - i; };
  while (dt > 0 && this.i < path.length - 1) {
    var here = path[idx(this.i)], d = traffic(here[0], here[1]);
    var pace = TILES_PER_SECOND / (1 + d / JAM);
    this.slow = d >= JAM;
    var need = (1 - this.f) / pace;
    if (dt < need) { this.f += dt * pace; dt = 0; } else { dt -= need; this.f = 0; this.i++; }
  }
  var a = path[idx(this.i)], b = path[idx(Math.min(this.i + 1, path.length - 1))];
  this.at = { x: a[0] + (b[0] - a[0]) * this.f, y: a[1] + (b[1] - a[1]) * this.f };
  if (this.i >= path.length - 1) {
    this.phase = this.phase === 'toWork' ? 'atWork' : 'atHome';
    this.wait = this.phase === 'atWork' ? AT_WORK_S : AT_HOME_S;
    this.slow = false;
  }
  return false;
};
