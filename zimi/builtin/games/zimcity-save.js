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
  var sim = new Simulation(map, level || 0, speed || Simulation.SPEED_MED, engineSave);
  for (var i = 0; i < sd.map.length; i++) map.setTileValue(i % MAP_W, Math.floor(i / MAP_W), sd.map[i]);
  return { sim: sim, map: map };
}
