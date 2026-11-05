/* ZimCity's patch layer: what the 1989 simulation never had (an AI data center, solar and wind farms, and the warming
   the city's power causes). Our own code, GPL-3.0; it changes micropolisJS's behaviour from the outside, at load, and
   leaves the vendored files as they are (see zimcity/ENGINE.md).

   The new buildings use three of the engine's spare 3 x 3 tile slots (the "extended church" tiles 956 to 982 that the
   engine never grows), so its bulldozer, zone and fire code already treat them as 3 x 3 buildings. Each cycle the map
   scan counts them (census.zc); the power scan then adds their supply and the data centers' demand, the yearly tax adds
   the data centers' payments, and the land value scan lowers the land around a data center (its heat and hum). */

import { Simulation } from './zimcity/engine/simulation.js';
import { PowerManager } from './zimcity/engine/powerManager.js';
import { Budget } from './zimcity/engine/budget.js';
import { BlockMapUtils } from './zimcity/engine/blockMapUtils.js';
import { Position } from './zimcity/engine/position.js';
import { forEachCardinalDirection } from './zimcity/engine/direction.js';
import { NOT_ENOUGH_POWER } from './zimcity/engine/messages.js';
import { NUCLEAR, POWERPLANT, RIVER, LASTRIVEDGE } from './zimcity/engine/tileValues.js';
import { POWERBIT } from './zimcity/engine/tileFlags.js';

// The spare slots: [first tile, centre tile].
export var DATACENTER = 960, SOLAR = 969, WIND = 978;

var COAL = 700, NUCLEAR_POWER = 2000;   // the engine's own strengths, for the scan this layer runs
export var SOLAR_POWER = 300;           // a farm of panels: clean, steady, smaller than coal
export var WIND_MEAN = 250;            // a wind farm: clean, but the month's wind decides
// A month's wind, as a share of the mean: from WIND_LOW to WIND_LOW + WIND_SPAN (zimcity-climate.js draws it).
export var WIND_LOW = 0.2, WIND_SPAN = 1.6;
export var DATA_DEMAND = 500;           // a data center draws most of a coal plant
export var DATA_HOT = 1.5;              // with no water nearby to cool it, half as much again
export var DATA_TAX = 1500;             // and pays well, a year
var DATA_RADIUS = 6, DATA_LAND = 48;    // its heat and hum: land value down by this within this many tiles
var WATER_NEAR = 3;                     // water this close cools it

function fresh() { return { solar: 0, wind: 0, data: 0, cooled: 0, dataAt: [] }; }

// A tile of water (river, lake or sea, and its edges).
export function isWater(v) { return v >= RIVER && v <= LASTRIVEDGE; }

// Each cycle's counts start again with the engine's own census.
var clearCensus = Simulation.prototype._clearCensus;
Simulation.prototype._clearCensus = function () {
  clearCensus.call(this);
  this._census.zc = fresh();
  if (this._census.zcWind === undefined) this._census.zcWind = 1;
  if (this._census.zcHeat === undefined) this._census.zcHeat = 1;
};

function nearWater(map, x, y) {
  for (var dy = -WATER_NEAR; dy <= WATER_NEAR; dy++) for (var dx = -WATER_NEAR; dx <= WATER_NEAR; dx++) {
    if (!map.testBounds(x + dx, y + dy)) continue;
    var v = map.getTileValue(x + dx, y + dy);
    if (isWater(v)) return true;
  }
  return false;
}

// The map scan finds the new buildings by their centre tiles; a farm is a power source like a plant.
var init = Simulation.prototype.init;
Simulation.prototype.init = function () {
  var pm = this._powerManager;
  this._census.zc = fresh();
  this._mapScanner.addAction(SOLAR, function (map, x, y, simData) { simData.census.zc.solar++; pm._powerStack.push(new Position(x, y)); });
  this._mapScanner.addAction(WIND, function (map, x, y, simData) { simData.census.zc.wind++; pm._powerStack.push(new Position(x, y)); });
  this._mapScanner.addAction(DATACENTER, function (map, x, y, simData) {
    var z = simData.census.zc;
    z.data++; z.dataAt.push([x, y]);
    if (nearWater(map, x, y)) z.cooled++;
  });
  init.call(this);
};

// The wind farms' power this month.
function windPower(census) {
  var z = census.zc || fresh();
  return Math.round(z.wind * WIND_MEAN * (census.zcWind || 1));
}
// What the city's power can give and what its data centers take, from this cycle's counts.
export function supply(census) {
  var z = census.zc || fresh();
  return census.coalPowerPop * COAL + census.nuclearPowerPop * NUCLEAR_POWER + z.solar * SOLAR_POWER + windPower(census);
}
export function dataDemand(census) {
  var z = census.zc || fresh(), heat = census.zcHeat || 1;
  return Math.round((z.cooled * DATA_DEMAND + (z.data - z.cooled) * DATA_DEMAND * DATA_HOT) * heat);
}
// The share of the city's power from each source, for the climate sheet and the warming.
export function mix(census) {
  var z = census.zc || fresh(), parts = { coal: census.coalPowerPop * COAL, nuclear: census.nuclearPowerPop * NUCLEAR_POWER,
    solar: z.solar * SOLAR_POWER, wind: windPower(census) };
  var all = parts.coal + parts.nuclear + parts.solar + parts.wind;
  Object.keys(parts).forEach(function (k) { parts[k] = all ? parts[k] / all : 0; });
  return parts;
}

// The engine's power scan, with the farms' supply and the data centers' demand (and a heat wave's extra draw on every
// tile) counted in. The flood fill is the engine's own, line for line.
PowerManager.prototype.doPowerScan = function (census) {
  this.powerGridMap.clear();
  var maxPower = supply(census), heat = census.zcHeat || 1;
  var powerConsumption = dataDemand(census);
  while (this._powerStack.length > 0) {
    var pos = this._powerStack.pop(), anyDir, conNum;
    do {
      powerConsumption += heat;
      if (powerConsumption > maxPower) { this._emitEvent(NOT_ENOUGH_POWER); return; }
      if (anyDir) pos = Position.move(pos, anyDir);
      this.powerGridMap.worldSet(pos.x, pos.y, 1);
      conNum = 0;
      forEachCardinalDirection((dir) => {
        if (conNum >= 2) return;
        if (this.testForConductive(pos, dir)) { conNum++; anyDir = dir; }
      });
      if (conNum > 1) this._powerStack.push(new Position(pos.x, pos.y));
    } while (conNum);
  }
};
// A farm's centre tile is powered as a plant's is.
var setTilePower = PowerManager.prototype.setTilePower;
PowerManager.prototype.setTilePower = function (x, y) {
  var v = this._map.getTileValue(x, y);
  if (v === SOLAR || v === WIND) { this._map.getTile(x, y).addFlags(POWERBIT); return; }
  setTilePower.call(this, x, y);
};

// The year's taxes, and what the data centers pay on top: paid straight into the funds (not into taxFund, which the
// budget window spends again when the year's budget is set by hand), and kept for the budget sheet to show.
var collectTax = Budget.prototype.collectTax;
Budget.prototype.collectTax = function (gameLevel, census) {
  collectTax.call(this, gameLevel, census);
  var paid = ((census.zc && census.zc.data) || 0) * DATA_TAX;
  this.zcDataPaid = paid;
  if (paid) this.spend(-paid);
};

// Land value, then the hum: land near a data center is worth less.
var landScan = BlockMapUtils.pollutionTerrainLandValueScan;
BlockMapUtils.pollutionTerrainLandValueScan = function (map, census, blockMaps) {
  landScan(map, census, blockMaps);
  var lv = blockMaps.landValueMap, at = (census.zc && census.zc.dataAt) || [];
  at.forEach(function (p) {
    for (var dy = -DATA_RADIUS; dy <= DATA_RADIUS; dy += lv.blockSize) for (var dx = -DATA_RADIUS; dx <= DATA_RADIUS; dx += lv.blockSize) {
      var x = p[0] + dx, y = p[1] + dy;
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      lv.worldSet(x, y, Math.max(0, lv.worldGet(x, y) - DATA_LAND));
    }
  });
};

export { NUCLEAR, POWERPLANT };
