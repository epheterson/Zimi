// Following a citizen, without a page: a commute joins a home with people to a workplace with jobs by the city's roads
// (every step a road, each end beside its zone); the walk is slower in traffic, stays a while at work and comes home;
// a city without a road between them has no commute.
//
// Run: node tests/test_games_zimcity_follow.cjs   (exit 0 = pass)

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
  await mod('zimcity-modern.js');
  const { Simulation } = await mod('zimcity/engine/simulation.js');
  const { MapGenerator } = await mod('zimcity/engine/mapGenerator.js');
  const TV = await mod('zimcity/engine/tileValues.js');
  const Tools = await mod('zimcity-tools.js');
  const Follow = await mod('zimcity-follow.js');

  const W = 120, H = 100;
  function city(seed) {
    const map = seeded(seed, () => MapGenerator(W, H));
    for (let y = 20; y < 36; y++) for (let x = 20; x < 44; x++) map.setTile(x, y, TV.DIRT, 0);
    const sim = new Simulation(map, Simulation.LEVEL_EASY, Simulation.SPEED_MED);
    return { map, sim, tools: Tools.makeTools(map) };
  }
  const step = (c, n) => { for (let i = 0; i < n; i++) { c.sim._simulate(c.sim._constructSimData()); c.sim._updateTime(); } };

  // Homes north of the road, jobs south of it, powered: in some years people live and work there.
  const c = city(12);
  Tools.build(c, 'road', [[20, 24]].concat(Tools.steps([20, 24], [43, 24])));
  Tools.build(c, 'coal', [[22, 21]]);
  for (let i = 0; i < 6; i++) Tools.build(c, 'residential', [[26 + i * 3, 22]]);
  Tools.build(c, 'commercial', [[26, 26]]); Tools.build(c, 'industrial', [[29, 26]]);
  Tools.build(c, 'wire', [[24, 24], [24, 25]]);
  step(c, 6000);
  const z = Follow.zones(c.map);
  check(z.homes.length > 0 && z.work.length > 0, 'the town has homes with people and work with jobs (' + z.homes.length + ', ' + z.work.length + ')');

  const trip = Follow.commute(c.map, 0, 'industry');
  check(!!trip, 'a citizen has a commute');
  if (trip) {
    const near = (p, zone) => Math.abs(p[0] - zone.x) <= 2 && Math.abs(p[1] - zone.y) <= 2;
    check(trip.path.every((p) => Follow.passable(c.map.getTileValue(p[0], p[1]))), 'every step of it is a road');
    check(trip.path.every((p, i) => !i || Math.abs(p[0] - trip.path[i - 1][0]) + Math.abs(p[1] - trip.path[i - 1][1]) === 1), 'from neighbour to neighbour');
    check(near(trip.path[0], trip.home) && near(trip.path[trip.path.length - 1], trip.work), 'from beside the home to beside the work');
    check(trip.work.kind === 'industry', 'to the kind of work this citizen prefers (' + trip.work.kind + ')');
    check(JSON.stringify(Follow.commute(c.map, 0, 'industry')) === JSON.stringify(trip), 'the same citizen, the same commute');

    // A long straight route: the walk takes longer in a jam than on an empty road, then stays at work, then goes home.
    const long = { home: trip.home, work: trip.work, path: Array.from({ length: 21 }, (_, i) => [20 + i, 24]) };
    const time = (density) => { const w = new Follow.Walk(long); let t = 0; while (w.phase === 'toWork' && t < 100) { w.advance(0.05, () => density); t += 0.05; } return t; };
    const free = time(0), jammed = time(180);
    check(Math.abs(free - 20 / Follow.TILES_PER_SECOND) < 0.2, 'on an empty road it keeps its pace (' + free.toFixed(2) + ' s)');
    check(jammed > free * 2.5, 'in a jam it crawls (' + jammed.toFixed(2) + ' s)');
    const w = new Follow.Walk(long);
    let phases = [w.phase];
    for (let t = 0; t < 40; t += 0.1) { w.advance(0.1, () => 0); if (phases[phases.length - 1] !== w.phase) phases.push(w.phase); }
    check(phases.slice(0, 4).join() === 'toWork,atWork,toHome,atHome', 'to work, at work, home again (' + phases.join() + ')');
  }

  // Cut the road between them: nobody commutes.
  for (let x = 20; x < 44; x++) Tools.build(c, 'bulldozer', [[x, 24]]);
  check(Follow.commute(c.map, 0, 'industry') === null, 'with the road gone there is no commute');

  if (failures) { console.log(failures + ' failed'); process.exit(1); }
  console.log('zimcity follow: all passed');
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
