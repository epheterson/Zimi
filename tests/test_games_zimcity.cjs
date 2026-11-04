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

  // A kept city comes back the same: map, money and date.
  const kept = {};
  cy.sim.save(kept);
  const json = JSON.parse(JSON.stringify(kept));
  const back = new Simulation(new GameMap(W, H), Simulation.LEVEL_EASY, Simulation.SPEED_MED, json);
  // The engine runs one map scan as it loads (upstream does too), which can move a zone a step; the rest is tile for tile.
  const was = values(cy.map), now = values(back._map), moved = was.filter((v, i) => v !== now[i]).length;
  check(moved < W * H / 200, 'the map comes back, but for a zone the loading scan moved (' + moved + ' differ)');
  check([[25, 24], [40, 24], [21, 20], [24, 23], [24, 25]].every((p) => back._map.getTileValue(p[0], p[1]) === cy.map.getTileValue(p[0], p[1])), 'the roads, the plant and the power line are where they were');
  check(back.budget.totalFunds === cy.sim.budget.totalFunds && back.getDate().year === cy.sim.getDate().year, 'the money and the year come back');

  if (failures) { console.log(failures + ' failed'); process.exit(1); }
  console.log('zimcity: all passed');
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
