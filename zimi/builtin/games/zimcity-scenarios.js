/* ZimCity's scenarios and ready-made cities: the original Micropolis files (zimcity/scenarios, zimcity/cities; GPL-3
   with its additional terms, see zimcity/NOTICE-cities.txt), read as they are. Our own code, GPL-3.0.

   A file is 27,120 bytes, big-endian 16-bit words: six histories of 240 words, 120 more (funds and the date among
   them), then the 120 x 100 map, column by column. A tile word is the engine's own: ten bits of tile and the six flag bits
   above them, so it is set on the map unchanged.

   A scenario is a city at a year, with money, one disaster at its moment, and a goal judged when its time is up, as the
   original's LoadScenario, ScenarioDisaster and DoScenarioScore (src/sim) have them. Their clocks count the city's ticks
   (48 a year). */

import { GameMap } from './zimcity/engine/gameMap.js';

export var W = 120, H = 100, FILE_BYTES = 27120, MAP_AT = 3120;

// id, file, year, funds, disaster [kind, ticks until it], the ticks until the goal is judged, the goal, and the real place
// (Wikidata ID, latitude, longitude) when there is one.
export var SCENARIOS = [
  { id: 'dullsville', file: 'snro.111', year: 1900, funds: 5000, disaster: null, judge: 30 * 48, goal: ['class', 4] },
  { id: 'sanfrancisco', file: 'snro.222', year: 1906, funds: 20000, disaster: ['earthquake', 10], judge: 5 * 48, goal: ['class', 4], place: ['Q62', 37.7775, -122.4164] },
  { id: 'hamburg', file: 'snro.333', year: 1944, funds: 20000, disaster: ['fires', 5], judge: 5 * 48, goal: ['class', 4], place: ['Q1055', 53.55, 10] },
  { id: 'bern', file: 'snro.444', year: 1965, funds: 20000, disaster: null, judge: 10 * 48, goal: ['traffic', 80], place: ['Q70', 46.948, 7.4475] },
  { id: 'tokyo', file: 'snro.555', year: 1957, funds: 20000, disaster: ['monster', 3], judge: 5 * 48, goal: ['score', 500], place: ['Q1490', 35.6897, 139.6922] },
  { id: 'detroit', file: 'snro.666', year: 1972, funds: 20000, disaster: null, judge: 10 * 48, goal: ['crime', 60], place: ['Q12439', 42.3317, -83.0458] },
  { id: 'boston', file: 'snro.777', year: 2010, funds: 20000, disaster: ['meltdown', 5], judge: 5 * 48, goal: ['score', 500], place: ['Q100', 42.3601, -71.0589] },
  { id: 'rio', file: 'snro.888', year: 2047, funds: 20000, disaster: ['floods', 2 * 48], judge: 10 * 48, goal: ['score', 500], place: ['Q8678', -22.9111, -43.2056] }
];
// The 24 ready-made cities; the ones named for a real place carry it.
export var CITIES = [
  ['about'], ['badnews'], ['bluebird'], ['bruce'], ['deadwood', 'Q262483', 44.3767, -103.7296], ['finnigan'], ['freds'],
  ['haight', 'Q1027700', 37.7699, -122.4469], ['happisle'], ['joffburg'], ['kamakura', 'Q200267', 35.3197, 139.5525],
  ['kobe', 'Q48320', 34.69, 135.1956], ['kowloon', 'Q239143', 22.3167, 114.1833], ['kyoto', 'Q34600', 35.0116, 135.7681],
  ['linecity'], ['med_isle'], ['ndulls'], ['neatmap'], ['radial'], ['senri'], ['southpac'], ['splats'], ['wetcity'],
  ['yokohama', 'Q38283', 35.4442, 139.6381]
];

// A map from a file's bytes (an ArrayBuffer), or null when it is not one.
// What a ready-made city's file says of its money and its date (scenarios set their own).
export function startOf(buffer) {
  var v = new DataView(buffer), word = function (i) { return v.getUint16(2880 + i * 2, false); };
  var funds = (word(50) << 16 | word(51)) >>> 0, time = (word(8) << 16 | word(9)) >>> 0;
  return { funds: funds > 0 && funds < 1e7 ? funds : 20000, time: time < 48 * 1000 ? time : 0 };
}
export function mapOf(buffer) {
  if (!buffer || buffer.byteLength !== FILE_BYTES) return null;
  var view = new DataView(buffer), map = new GameMap(W, H);
  for (var x = 0; x < W; x++) for (var y = 0; y < H; y++) map.setTileValue(x, y, view.getUint16(MAP_AT + (x * H + y) * 2, false));
  return map;
}

// The disaster's moment and the judging, one tick of the city's clock at a time. `run` is {left, judgeIn} (kept with
// the city); returns 'win', 'lose' or null.
export function tick(sim, sc, run) {
  if (sc.disaster && run.left > 0) {
    var kind = sc.disaster[0], d = sim.disasterManager;
    if (kind === 'fires') d.makeFire();                         // Hamburg: fires all through its wait
    else if (kind === 'floods' && run.left % 24 === 0) d.makeFlood();
    else if (run.left === 1) {
      if (kind === 'earthquake') d.makeEarthquake();
      if (kind === 'monster') sim.spriteManager.makeMonster();
      if (kind === 'meltdown') d.makeMeltdown();
    }
    run.left--;
  }
  if (run.judgeIn > 0 && --run.judgeIn === 0) return judge(sim, sc) ? 'win' : 'lose';
  return null;
}
var CLASSES = ['VILLAGE', 'TOWN', 'CITY', 'CAPITAL', 'METROPOLIS', 'MEGALOPOLIS'];
export function judge(sim, sc) {
  var g = sc.goal, e = sim.evaluation, census = sim._census;
  if (g[0] === 'class') return CLASSES.indexOf(e.cityClass) >= g[1];
  if (g[0] === 'score') return e.cityScore > g[1];
  if (g[0] === 'crime') return census.crimeAverage < g[1];
  if (g[0] === 'traffic') return trafficAverage(sim) < g[1];
  return false;
}
// Where the city stands against the goal, for the strip and the end sheets: {kind, target, now}. A class goal names the
// size wanted and the size now; the others are numbers (the score, the crime and traffic averages), rounded.
export function reading(sim, sc) {
  var g = sc.goal, e = sim.evaluation, census = sim._census;
  if (g[0] === 'class') return { kind: 'class', target: CLASSES[g[1]].toLowerCase(), now: String(e.cityClass).toLowerCase() };
  var now = g[0] === 'score' ? e.cityScore : g[0] === 'crime' ? census.crimeAverage : trafficAverage(sim);
  return { kind: g[0], target: g[1], now: Math.round(now) };
}
// The time left to the judging, as {n, unit}: whole years, and months once less than a year is left.
export var TICKS_PER_YEAR = 48, TICKS_PER_MONTH = 4;
export function timeLeft(ticks) {
  return ticks > TICKS_PER_YEAR ? { n: Math.ceil(ticks / TICKS_PER_YEAR), unit: 'years' } : { n: Math.max(1, Math.ceil(ticks / TICKS_PER_MONTH)), unit: 'months' };
}
// The original's TrafficAverage, as the engine's evaluation works it out (evaluation.js getTrafficAverage, which does not keep
// it): the traffic map's mean over the blocks that have land value, a floor, times 2.4. Without that 2.4 Bern's goal (below 80)
// was met by a city whose real figure was twice that.
var TRAFFIC_SCALE = 2.4;
export function trafficAverage(sim) {
  var t = sim.blockMaps.trafficDensityMap, lv = sim.blockMaps.landValueMap, sum = 0, n = 1;
  for (var x = 0; x < lv.gameMapWidth; x += lv.blockSize) {
    for (var y = 0; y < lv.gameMapHeight; y += lv.blockSize) if (lv.worldGet(x, y) > 0) { sum += t.worldGet(x, y); n++; }
  }
  return Math.floor(sum / n) * TRAFFIC_SCALE;
}
