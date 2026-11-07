// ZimCity's engine and tools without a page: the city grows, a stroke's ghost tells the truth about what building it
// will do, two cities in one page do not hear each other, and a kept city comes back the same.
//
// Run: node tests/test_games_zimcity.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const games = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
const mod = (p) => import(pathToFileURL(path.join(games, p)).href);
// The page's globals the city's modules use: ZimiUtil's generator and the shell's hash.
globalThis.ZimiUtil = globalThis.ZimiUtil || (() => { const b = {}; vm.createContext(b); vm.runInContext(fs.readFileSync(path.join(games, 'util.js'), 'utf8'), b); return b.ZimiUtil; })();
globalThis.ZimiShell = globalThis.ZimiShell || { hash: require(path.join(games, 'shell.js')).hash };
// util.js is a plain script that sets ZimiUtil on its global, as in a page.
const box = {};
vm.createContext(box);
vm.runInContext(fs.readFileSync(path.join(games, 'util.js'), 'utf8'), box, { filename: 'util.js' });
const Util = box.ZimiUtil;

let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log('FAIL ' + label); } };

// The page seeds the engine's Math.random the same way (zimcity.js, seeded()).
function seeded(seed, fn) {
  const real = Math.random;
  Math.random = Util.mulberry32(seed);
  try { return fn(); } finally { Math.random = real; }
}

(async () => {
  const { Simulation } = await mod('zimcity/engine/simulation.js');
  const { GameMap } = await mod('zimcity/engine/gameMap.js');
  const { MapGenerator } = await mod('zimcity/engine/mapGenerator.js');
  const Messages = await mod('zimcity/engine/messages.js');
  const TV = await mod('zimcity/engine/tileValues.js');
  const Tools = await mod('zimcity-tools.js');

  const W = 120, H = 100;
  const values = (map) => { const v = []; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) v.push(map.getTileValue(x, y)); return v; };
  // A city on a seeded map with a cleared block at 20..43 x 20..35, so the tests build on known ground.
  function city(seed) {
    const map = seeded(seed, () => MapGenerator(W, H));
    for (let y = 20; y < 36; y++) for (let x = 20; x < 44; x++) map.setTile(x, y, TV.DIRT, 0);
    const sim = new Simulation(map, Simulation.LEVEL_EASY, Simulation.SPEED_MED);
    return { map, sim, tools: Tools.makeTools(map) };
  }
  const step = (c, n) => { for (let i = 0; i < n; i++) { c.sim._simulate(c.sim._constructSimData()); c.sim._updateTime(); } };

  // A seed is a map one can have again.
  const a = seeded(7, () => MapGenerator(W, H)), b = seeded(7, () => MapGenerator(W, H)), c8 = seeded(8, () => MapGenerator(W, H));
  check(values(a).join() === values(b).join(), 'the same seed draws the same map');
  check(values(a).join() !== values(c8).join(), 'another seed draws another map');

  // A finger's stroke becomes steps up, down, left or right, ending where the finger is.
  const s = Tools.steps([0, 0], [5, -3]);
  check(s.length === 8 && s[s.length - 1].join() === '5,-3', 'a diagonal stroke is eight single steps to its end');
  check(s.every((p, i) => { const q = i ? s[i - 1] : [0, 0]; return Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) === 1; }), 'every step is to a neighbour');

  // The ghost is the truth: trying a road changes nothing; building it costs exactly what the try said.
  let cy = city(11);
  const road = [[20, 24]].concat(Tools.steps([20, 24], [30, 24]));
  const before = values(cy.map).join(), funds = cy.sim.budget.totalFunds;
  const r = Tools.trial(cy, 'road', road);
  Tools.drop(cy, 'road');
  check(r.ok && r.cost === 11 * 10 && r.tiles.length === 11, 'eleven tiles of road on clear ground: ok, $110 (' + JSON.stringify([r.ok, r.cost, r.tiles.length]) + ')');
  check(values(cy.map).join() === before && cy.sim.budget.totalFunds === funds, 'a try changes neither the map nor the money');
  const built = Tools.build(cy, 'road', road);
  check(built.ok && cy.sim.budget.totalFunds === funds - r.cost, 'building spends what the ghost said');
  check(cy.map.getTileValue(25, 24) !== TV.DIRT, 'and the road is on the map');

  // A zone on the road needs bulldozing first; a city short of money is told by how much, and nothing is built.
  const onRoad = Tools.trial(cy, 'residential', [[25, 24]]);
  Tools.drop(cy, 'residential');
  check(!onRoad.ok && onRoad.why === 'clear', 'a zone over the road is "bulldoze it first" (' + onRoad.why + ')');
  // Aimed with a fingertip beside the road, a footprint that lands on the road moves to the nearest place it fits, flush
  // against the road; one that fits where it was aimed, and one with nowhere to go, stay put.
  const flush = Tools.nudge(cy, 'residential', [[25, 25]]);
  check(flush.length === 1 && flush[0].join() === '25,26', 'a home aimed one tile under the road lands flush under it (' + flush.join('|') + ')');
  check(Tools.nudge(cy, 'residential', [[25, 30]])[0].join() === '25,30', 'a home that fits where it was aimed does not move');
  check(Tools.nudge(cy, 'residential', [[25, 25], [28, 25]]).map((p) => p.join()).join('|') === '25,26|28,26', 'a row moves together');
  const plantAt = Tools.nudge(cy, 'coal', [[26, 26]]);
  check(Tools.trial(cy, 'coal', plantAt).ok && plantAt[0][1] >= 26, 'a plant aimed over the road lands where it fits (' + plantAt.join('|') + ')');
  Tools.drop(cy, 'coal');
  check(Tools.nudge(cy, 'road', [[25, 25]])[0].join() === '25,25', 'a drawn tool is never moved');
  cy.sim.budget.totalFunds = 2000;
  const plant = Tools.build(cy, 'coal', [[22, 30]]);
  check(!plant.ok && plant.why === 'money' && plant.short === 1000 && cy.sim.budget.totalFunds === 2000, 'a $3,000 plant with $2,000 is short by $1,000 and not built');
  check(cy.map.getTileValue(22, 30) === TV.DIRT, 'the ground under it is untouched');

  // A powered city grows (the census and tax steps run: upstream passed a stray `budget` to them).
  cy = city(12);
  Tools.build(cy, 'road', [[20, 24]].concat(Tools.steps([20, 24], [43, 24])));
  Tools.build(cy, 'coal', [[22, 21]]);
  for (let i = 0; i < 6; i++) Tools.build(cy, 'residential', [[26 + i * 3, 22]]);
  Tools.build(cy, 'commercial', [[26, 26]]); Tools.build(cy, 'industrial', [[29, 26]]);
  Tools.build(cy, 'wire', [[24, 24], [24, 25]]);   // power across the road to the jobs
  let threw = null;
  try { step(cy, 6000); } catch (e) { threw = e; }
  check(!threw, 'six thousand steps run (' + (threw && threw.message) + ')');
  check(cy.sim._census.resPop > 0 && cy.sim.getDate().year > 1900, 'people move in over the years (' + cy.sim._census.resPop + ')');

  // Two cities in one page: the second city's money is not the first's news.
  const one = city(13), heard = [];
  one.sim.addEventListener(Messages.FUNDS_CHANGED, (v) => heard.push(v));
  const two = city(14);
  Tools.build(two, 'road', [[20, 24], [21, 24]]);
  two.sim.budget.spend(500);
  check(heard.length === 0, 'the first city hears nothing of the second (' + heard.length + ' events)');

  // A kept city comes back the same: every tile, the money and the date (the loading scan's extra growth step is undone).
  const Save = await mod('zimcity-save.js');
  const kept = JSON.parse(JSON.stringify(Save.packSim(cy.sim)));
  const back = Save.unpackSim(kept, Simulation.LEVEL_EASY, Simulation.SPEED_MED);
  const was = values(cy.map), now = values(back.map), moved = was.filter((v, i) => v !== now[i]).length;
  check(moved === 0, 'the map comes back tile for tile (' + moved + ' differ)');
  check(back.sim.budget.totalFunds === cy.sim.budget.totalFunds && back.sim.getDate().year === cy.sim.getDate().year, 'the money and the year come back');
  let goesOn = null;
  try { for (let i = 0; i < 500; i++) { back.sim._simulate(back.sim._constructSimData()); back.sim._updateTime(); } } catch (e) { goesOn = e; }
  check(!goesOn && back.sim._census.resPop > 0, 'and it carries on from there');
  check(Save.unpackSim({ map: [1, 2] }) === null, 'a save of the wrong size is refused');

  // The advisor names the next step as a city is built, and falls quiet once it stands.
  const { advise, runningOut } = await mod('zimcity-advisor.js');
  const ad = city(15), steps = [];
  steps.push(advise(ad.map));
  Tools.build(ad, 'road', [[20, 24]].concat(Tools.steps([20, 24], [43, 24]))); steps.push(advise(ad.map));
  Tools.build(ad, 'coal', [[22, 21]]); steps.push(advise(ad.map));
  Tools.build(ad, 'residential', [[40, 30]]); steps.push(advise(ad.map));   // far from power and the road
  step(ad, 256); steps.push(advise(ad.map));
  Tools.build(ad, 'bulldozer', [[40, 30]]);
  Tools.build(ad, 'residential', [[26, 22]]); step(ad, 256); steps.push(advise(ad.map));
  Tools.build(ad, 'commercial', [[26, 26]]); Tools.build(ad, 'wire', [[24, 24], [24, 25]]); step(ad, 256); steps.push(advise(ad.map));
  check(steps.join() === 'city.adv.road,city.adv.plant,city.adv.zone,city.adv.power,city.adv.power,city.adv.jobs,', 'the advisor walks the first steps (' + steps.join() + ')');

  // The original scenario and city files read as maps, and a scenario's disaster and judging keep the original's clocks.
  const Scen = await mod('zimcity-scenarios.js');
  const all = Scen.SCENARIOS.map((x) => 'zimcity/scenarios/' + x.file).concat(Scen.CITIES.map((c) => 'zimcity/cities/' + c[0] + '.cty'));
  let read = 0;
  for (const f of all) {
    const buf = fs.readFileSync(path.join(games, f)), map = Scen.mapOf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    const vs = map ? values(map) : [];
    if (map && vs.every((v) => v >= 0 && v < TV.TILE_COUNT) && new Set(vs).size > 3) read++;   // some are bare land, one is a picture
  }
  check(read === 32, 'all 8 scenarios and 24 cities read as maps of real tiles (' + read + ')');
  const sf = Scen.SCENARIOS[1], sfBuf = fs.readFileSync(path.join(games, 'zimcity/scenarios/' + sf.file));
  const sfMap = Scen.mapOf(sfBuf.buffer.slice(sfBuf.byteOffset, sfBuf.byteOffset + sfBuf.length));
  const sfSim = new Simulation(sfMap, 0, Simulation.SPEED_MED), quakes = [];
  sfSim.addEventListener(Messages.FRONT_END_MESSAGE, (m) => { if (m.subject === Messages.EARTHQUAKE) quakes.push(1); });
  const run = { left: sf.disaster[1], judgeIn: sf.judge };
  let out = null, ticks = 0;
  while (!out && ticks < sf.judge + 5) { out = Scen.tick(sfSim, sf, run); ticks++; if (ticks === 9) check(!quakes.length, 'no earthquake before its tenth tick'); }
  check(quakes.length === 1, 'San Francisco shakes once (' + quakes.length + ')');
  check(ticks === sf.judge && (out === 'win' || out === 'lose'), 'and is judged after five years of ticks (' + ticks + ', ' + out + ')');
  check(Scen.mapOf(new ArrayBuffer(10)) === null, 'a file of the wrong size is refused');

  // The traffic goal reads the figure the engine's evaluation does (floor of the mean over blocks with land value, times 2.4),
  // and the goal strip's time left is years, then months in the last year.
  const fakeSim = { blockMaps: { trafficDensityMap: { worldGet: () => 10 }, landValueMap: { gameMapWidth: 16, gameMapHeight: 16, blockSize: 8, worldGet: () => 1 } } };
  check(Math.abs(Scen.trafficAverage(fakeSim) - 19.2) < 1e-9, 'the traffic average is the engine\'s, with its 2.4 (' + Scen.trafficAverage(fakeSim) + ')');

  // Bern: the file holds no traffic, so the page lives the first half year out of sight (warmUp) and the opening reading is a
  // measured city's, over the goal; the money and the date come back as they were. Left alone it never gets under the goal;
  // rail laid along the busiest road tiles does (the player's lever), so the goal is neither won at the start nor out of reach.
  const bern = Scen.SCENARIOS.find((x) => x.id === 'bern'), bernBuf = fs.readFileSync(path.join(games, 'zimcity/scenarios/' + bern.file));
  const unpowered = (m) => { let n = 0, all = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = m.getTile(x, y); if (t.isZone()) { all++; if (!t.isPowered()) n++; } } return n / all; };
  const bernCity = (seed, warm) => seeded(seed, () => {
    const map = Scen.mapOf(bernBuf.buffer.slice(bernBuf.byteOffset, bernBuf.byteOffset + bernBuf.length));
    const sim = new Simulation(map, Simulation.LEVEL_EASY, Simulation.SPEED_MED);
    sim._cityTime = (bern.year - 1900) * 48 + 2; sim.budget.setFunds(bern.funds); sim.budget.cityTax = 7; sim._updateTime();
    sim._simulate(sim._constructSimData());
    return { map, sim, tools: Tools.makeTools(map), warmed: warm ? (() => { const was = [sim.budget.totalFunds, sim._cityTime, unpowered(map)]; Scen.warmUp(sim, bern.warm); return was; })() : null };
  });
  const cold = bernCity(1, false);
  check(Scen.reading(cold.sim, bern).now < bern.goal[1], 'an unwarmed Bern reads under its goal at the start (' + Scen.reading(cold.sim, bern).now + '): the defect');
  for (const seed of [1, 2, 3]) {
    const c = bernCity(seed, true), r = Scen.reading(c.sim, bern);
    check(r.now > bern.goal[1], 'Bern opens over its goal of ' + bern.goal[1] + ' on seed ' + seed + ' (reads ' + r.now + ')');
    check(c.sim.budget.totalFunds === c.warmed[0] && c.sim._cityTime === c.warmed[1], 'the warm-up leaves the money and the date as they were');
    check(c.warmed[2] > 0.9 && unpowered(c.map) < 0.1, 'and the zones that all flashed "no power" are on the grid (' + c.warmed[2].toFixed(2) + ' off before, ' + unpowered(c.map).toFixed(2) + ' after)');
  }
  const judged = (c, lever) => {
    if (lever) {
      const t = c.sim.blockMaps.trafficDensityMap, cells = [];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = c.map.getTileValue(x, y); if (v >= 64 && v < 208 && !c.map.getTile(x, y).isZone()) cells.push([x, y, t.worldGet(x, y)]); }
      cells.sort((a, b) => b[2] - a[2]);
      c.sim.budget.totalFunds = 1e7;
      cells.slice(0, 150).forEach((p) => { Tools.build(c, 'bulldozer', [[p[0], p[1]]]); Tools.build(c, 'rail', [[p[0], p[1]]]); });
    }
    return seeded(5, () => { const run = { left: 0, judgeIn: bern.judge }; let out = null; while (!out) { Scen.runTicks(c.sim, 1); out = Scen.tick(c.sim, bern, run); } return out; });
  };
  check(judged(bernCity(2, true), false) === 'lose', 'a Bern left alone for ten years is lost');
  check(judged(bernCity(2, true), true) === 'win', 'and won with rail laid on the busiest 150 road tiles');
  check(JSON.stringify([Scen.timeLeft(480), Scen.timeLeft(49), Scen.timeLeft(48), Scen.timeLeft(30), Scen.timeLeft(4), Scen.timeLeft(1)]) ===
    JSON.stringify([{ n: 10, unit: 'years' }, { n: 2, unit: 'years' }, { n: 12, unit: 'months' }, { n: 8, unit: 'months' }, { n: 1, unit: 'months' }, { n: 1, unit: 'months' }]), 'the time left is whole years, then months');
  check(runningOut({ funds: 7000, flow: -2400, horizon: 4 }) && !runningOut({ funds: 20000, flow: -2400, horizon: 4 }) && !runningOut({ funds: 100, flow: 500, horizon: 4 }), 'money is running out only when the bank will not last the horizon');
  check(advise(ad.map, { funds: 7000, flow: -2400, horizon: 4 }) === 'city.adv.money', 'the advisor says the money is running out before any other step');

  if (failures) { console.log(failures + ' failed'); process.exit(1); }
  console.log('zimcity: all passed');
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
