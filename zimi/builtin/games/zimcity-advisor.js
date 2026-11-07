/* ZimCity's advisor: the next useful step, read from the city as it stands. Our own code, GPL-3.0.
   It looks at the map itself (the engine's census is cleared and refilled within each cycle, so it is never whole when
   the page asks). One answer at a time, in the order a city is built; null once the city stands on its own feet. */

import * as TV from './zimcity/engine/tileValues.js';
import { kindOf, isRoad } from './zimcity-words.js';
import { SOLAR, WIND } from './zimcity-modern.js';

var ZONES = { 'city.kind.residential': 'res', 'city.kind.commercial': 'com', 'city.kind.industrial': 'ind' };

function hasRoadBeside(map, cx, cy) {
  for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
    if (map.testBounds(cx + dx, cy + dy) && isRoad(map.getTileValue(cx + dx, cy + dy))) return true;
  }
  return false;
}

// What the city has: roads, plants, and its zones by kind, with those unpowered and those with no road.
export function survey(map) {
  var s = { roads: 0, plants: 0, res: 0, com: 0, ind: 0, unpowered: 0, roadless: 0 };
  for (var y = 0; y < map.height; y++) {
    for (var x = 0; x < map.width; x++) {
      var t = map.getTile(x, y), v = t.getValue();
      if (isRoad(v)) s.roads++;
      if (!t.isZone()) continue;
      if (v === TV.POWERPLANT || v === TV.NUCLEAR || v === SOLAR || v === WIND) s.plants++;
      var z = ZONES[kindOf(v)];
      if (!z || (z === 'res' && v >= TV.HOSPITALBASE)) continue;   // a hospital or a church is not a home
      s[z]++;
      if (!t.isPowered()) s.unpowered++;
      if (!hasRoadBeside(map, x, y)) s.roadless++;
    }
  }
  return s;
}

// Money is running out when the year's costs outrun its taxes and the bank will not last the horizon (years): the
// engine's cash flow is last year's taxes less the full cost of roads, fire and police.
export var LOW_RUNWAY_YEARS = 4;
export function runningOut(money) {
  return !!money && money.flow < 0 && money.funds / -money.flow < money.horizon;
}

// A few zones off the grid in a big, grown city (a file's own) are not the next step: the share of zones that must be unpowered.
var POWER_SHARE = 0.05;

// The string id of the next step, or null. `money` is {funds, flow, horizon}, when the page knows it.
export function advise(map, money) {
  if (runningOut(money)) return 'city.adv.money';
  var s = survey(map);
  if (!s.roads) return 'city.adv.road';
  if (!s.plants) return 'city.adv.plant';
  if (!s.res && !s.com && !s.ind) return 'city.adv.zone';
  if (s.unpowered && s.unpowered >= (s.res + s.com + s.ind) * POWER_SHARE) return 'city.adv.power';
  if (s.roadless) return 'city.adv.roadless';
  if (!s.res) return 'city.adv.homes';
  if (!s.com && !s.ind) return 'city.adv.jobs';
  return null;
}
