// ZimCity's modern layer without a page: a data center's power draw, taxes and hum; solar and wind as power; the
// climate warming with coal and not with sun; the sea taking shore; the citizens' moods read from the city.
//
// Run: node tests/test_games_zimcity_modern.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const games = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
const mod = (p) => import(pathToFileURL(path.join(games, p)).href);
const box = {};
vm.createContext(box);
vm.runInContext(fs.readFileSync(path.join(games, 'util.js'), 'utf8'), box, { filename: 'util.js' });
const Util = box.ZimiUtil;

let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log('FAIL ' + label); } };
function seeded(seed, fn) { const real = Math.random; Math.random = Util.mulberry32(seed); try { return fn(); } finally { Math.random = real; } }

(async () => {
  const Modern = await mod('zimcity-modern.js');   // first: it patches the engine
  const { Simulation } = await mod('zimcity/engine/simulation.js');
  const { MapGenerator } = await mod('zimcity/engine/mapGenerator.js');
  const Messages = await mod('zimcity/engine/messages.js');
  const TV = await mod('zimcity/engine/tileValues.js');
  const Tools = await mod('zimcity-tools.js');
  const Climate = await mod('zimcity-climate.js');
  const Voices = await mod('zimcity-voices.js');

  const W = 120, H = 100;
  // A dry block at 20..59 x 20..49 (no water near, so a data center runs hot), on a seeded map.
  function city(seed) {
    const map = seeded(seed, () => MapGenerator(W, H));
    for (let y = 14; y < 56; y++) for (let x = 14; x < 66; x++) map.setTile(x, y, TV.DIRT, 0);
    const sim = new Simulation(map, Simulation.LEVEL_EASY, Simulation.SPEED_MED);
    sim.budget.totalFunds = 100000;
    return { map, sim, tools: Tools.makeTools(map) };
  }
  const step = (c, n) => { for (let i = 0; i < n; i++) { c.sim._simulate(c.sim._constructSimData()); c.sim._updateTime(); } };
  const shortages = (c) => { const n = { v: 0 }; c.sim.addEventListener(Messages.FRONT_END_MESSAGE, (m) => { if (m.subject === Messages.NOT_ENOUGH_POWER) n.v++; }); return n; };

  // A coal plant (700) cannot carry a data center running hot (750); a solar farm beside it makes the difference.
  let c = city(21);
  const short = shortages(c);
  check(Tools.build(c, 'coal', [[22, 22]]).ok, 'a coal plant is built');
  check(Tools.build(c, 'datacenter', [[26, 22]]).ok, 'a data center is built beside it');
  step(c, 64);
  check(c.sim._census.zc.data === 1 && c.sim._census.zc.cooled === 0, 'the scan finds one data center, with no water near');
  check(Modern.dataDemand(c.sim._census) === Modern.DATA_DEMAND * Modern.DATA_HOT, 'it draws half again as much with no water to cool it');
  check(short.v > 0, 'and the city runs short of power (' + short.v + ')');
  check(Tools.build(c, 'solar', [[22, 26]]).ok, 'a solar farm goes in beside the plant');
  step(c, 64);
  check(Modern.supply(c.sim._census) === 700 + Modern.SOLAR_POWER, 'the farm adds its power to the plant\'s (' + Modern.supply(c.sim._census) + ')');
  const before = short.v; step(c, 128);
  check(short.v === before, 'and the shortage ends');

  // A year with a data center pays its tax on top; without one, not.
  const funds = (c2) => c2.sim.budget.totalFunds;
  const withDc = city(22), without = city(22);
  [withDc, without].forEach((x) => { Tools.build(x, 'coal', [[22, 22]]); Tools.build(x, 'nuclear', [[22, 26]]); });
  Tools.build(withDc, 'datacenter', [[26, 22]]);
  const a0 = funds(withDc), b0 = funds(without);
  step(withDc, 16 * 48); step(without, 16 * 48);
  check(withDc.sim.budget.zcDataPaid === Modern.DATA_TAX, 'the data center paid its year\'s tax (' + withDc.sim.budget.zcDataPaid + ')');
  check((funds(withDc) - a0) - (funds(without) - b0) >= Modern.DATA_TAX - 12000 - 100, 'the money shows in the funds, its building cost aside');
  // Its hum: the land beside it is worth less than the same land in the city without one.
  const lvA = withDc.sim.blockMaps.landValueMap.worldGet(30, 22), lvB = without.sim.blockMaps.landValueMap.worldGet(30, 22);
  check(lvA < lvB || lvA === 0, 'the land beside a data center is worth less (' + lvA + ' against ' + lvB + ')');

  // Coal warms the city's climate, sun does not; decades, not days.
  const coal = city(23), sun = city(23), sc = Climate.fresh(), ss = Climate.fresh();
  Tools.build(coal, 'coal', [[22, 22]]); Tools.build(coal, 'coal', [[30, 22]]); Tools.build(coal, 'coal', [[38, 22]]);
  Tools.build(sun, 'solar', [[22, 22]]); Tools.build(sun, 'wind', [[30, 22]]);
  for (let y = 0; y < 30 * 48; y++) {
    for (let k = 0; k < 16; k++) { coal.sim._simulate(coal.sim._constructSimData()); sun.sim._simulate(sun.sim._constructSimData()); }
    coal.sim._updateTime(); sun.sim._updateTime();
    Climate.tick(coal.sim, sc, true, false); Climate.tick(sun.sim, ss, true, false);
  }
  check(sc.warm > 0.5 && sc.warm < 1.5, 'three coal plants warm the city about a degree in 30 years (' + sc.warm.toFixed(2) + ')');
  check(ss.warm === 0 && ss.sea === 0, 'solar and wind warm nothing');
  check(Climate.tick(coal.sim, sc, false, false).length === 0 && coal.sim._census.zcHeat === 1, 'with the Climate setting off, nothing happens');

  // The sea, once it has risen a step, takes bare shore tiles (and nothing built).
  const wet = (m) => { let n = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = m.getTileValue(x, y); if (v >= TV.RIVER && v <= TV.LASTRIVEDGE) n++; } return n; };
  const shore = city(24), st = Climate.fresh(), w0 = wet(shore.map);
  st.carbon = Climate.PER_DEGREE * 3; st.sea = Climate.SEA_STEP * 1.01;
  const got = Climate.tick(shore.sim, st, true, false);
  check(got.indexOf('sea') >= 0 && wet(shore.map) > w0, 'a step of sea takes shore (' + w0 + ' to ' + wet(shore.map) + ')');

  // The citizens' moods follow the city.
  const base = { traffic: 50, demand: 0, land: 80, pollution: 50, warm: 0.5, approval: 50, data: 0 };
  check(Voices.mood('commuter', Object.assign({}, base, { traffic: 150 })) === 'bad', 'the commuter hates jams');
  check(Voices.mood('commuter', Object.assign({}, base, { traffic: 10 })) === 'good', 'and likes empty roads');
  check(Voices.mood('activist', Object.assign({}, base, { data: 2 })) === 'bad', 'the activist does not like data centers');
  check(Voices.mood('rival', Object.assign({}, base, { approval: 80 })) === 'bad', 'the rival is sour when the mayor is liked');
  check(Voices.next(Object.assign({}, base, { traffic: 150 }), 'rival').id === 'commuter', 'the strongest feeling speaks next');

  if (failures) { console.log(failures + ' failed'); process.exit(1); }
  console.log('zimcity modern: all passed');
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
