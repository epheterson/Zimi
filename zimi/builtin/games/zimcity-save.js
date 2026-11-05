/* ZimCity: a city as it is kept (the page's save, and the kept cities) and as it comes back. Our own code, GPL-3.0.

   The engine saves its map as {value} objects; kept, the map is a plain list of tile numbers. Loading builds a fresh
   Simulation over the saved map. The engine then runs one whole-map scan to rebuild what it does not save (power,
   pollution, crime, the census), and that scan also gives each zone a turn to grow or decline, a step the saved city
   never took. The tiles are put back as they were saved after it, so a city comes back exactly as it was left: the
   rebuilt maps stand, and the zones take their next turn on the city's own clock. */

import { Simulation } from './zimcity/engine/simulation.js';
import { GameMap } from './zimcity/engine/gameMap.js';

export var MAP_W = 120, MAP_H = 100;

// The engine's state as plain JSON, its map as a list of tile numbers.
export function packSim(sim) {
  var sd = {};
  sim.save(sd);
  sd.map = sd.map.map(function (t) { return t.value; });
  return sd;
}

// A Simulation from packSim's answer (null when it is not a ZimCity save), with every tile as it was kept.
export function unpackSim(sd, level, speed) {
  if (!sd || !Array.isArray(sd.map) || sd.map.length !== MAP_W * MAP_H) return null;
  var engineSave = Object.assign({}, sd, { map: sd.map.map(function (v) { return { value: v }; }) });
  var map = new GameMap(MAP_W, MAP_H);
  // The scan that rebuilds what is not saved draws on chance (traffic's routes, a zone's turn): seeded from the save,
  // so the same save comes back the same, and a catch-up from it becomes the same city.
  var real = Math.random, sim;
  Math.random = rngFor(String(sd._cityTime) + '|' + String(sd.totalFunds) + '|' + String(sd.map.length));
  try { sim = new Simulation(map, level || 0, speed || Simulation.SPEED_MED, engineSave); } finally { Math.random = real; }
  for (var i = 0; i < sd.map.length; i++) map.setTileValue(i % MAP_W, Math.floor(i / MAP_W), sd.map[i]);
  return { sim: sim, map: map };
}

// A small seeded generator (FNV-1a of the key into mulberry32), so loading needs nothing from the page.
function rngFor(key) {
  var h = 2166136261 >>> 0;
  for (var i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return function () {
    h = (h + 0x6D2B79F5) >>> 0;
    var t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
