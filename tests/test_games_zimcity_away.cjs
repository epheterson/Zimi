// ZimCity while you are away, without a page: an absence becomes game time at the chosen pace, never more than the cap,
// none at Pause; and the same save away the same time becomes the same city, however the time is cut into chunks.
//
// Run: node tests/test_games_zimcity_away.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const games = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
const mod = (p) => import(pathToFileURL(path.join(games, p)).href);
// The page's globals the city's modules use: ZimiUtil's generator and the shell's hash.
globalThis.ZimiUtil = globalThis.ZimiUtil || (() => { const b = {}; vm.createContext(b); vm.runInContext(fs.readFileSync(path.join(games, 'util.js'), 'utf8'), b); return b.ZimiUtil; })();
globalThis.ZimiShell = globalThis.ZimiShell || { hash: require(path.join(games, 'shell.js')).hash };
const box = {};
vm.createContext(box);
vm.runInContext(fs.readFileSync(path.join(games, 'util.js'), 'utf8'), box, { filename: 'util.js' });
const Util = box.ZimiUtil;

let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log('FAIL ' + label); } };
function seeded(seed, fn) { const real = Math.random; Math.random = Util.mulberry32(seed); try { return fn(); } finally { Math.random = real; } }
const HOUR = 3600000, DAY = 24 * HOUR;

(async () => {
  await mod('zimcity-modern.js');
  const { Simulation } = await mod('zimcity/engine/simulation.js');
  const { MapGenerator } = await mod('zimcity/engine/mapGenerator.js');
  const TV = await mod('zimcity/engine/tileValues.js');
  const Tools = await mod('zimcity-tools.js');
  const Save = await mod('zimcity-save.js');
  const Away = await mod('zimcity-away.js');

  // The pace: a game month an hour when Slow, the middle speed when Normal, nothing at Pause, five years at most.
  check(Away.ticksFor(HOUR, 'slow') === 4, 'an hour away at Slow is a game month (' + Away.ticksFor(HOUR, 'slow') + ' ticks)');
  check(Away.ticksFor(30 * DAY, 'slow') === 5 * 48, 'a month away at Slow stops at five years');
  check(Away.ticksFor(60000, 'normal') === 75, 'a minute away at Normal is a minute of play (75 ticks)');
  check(Away.ticksFor(DAY, 'normal') === 5 * 48, 'a day away at Normal stops at five years');
  check(Away.ticksFor(30 * DAY, 'pause') === 0, 'at Pause nothing happens');
  check(Away.ticksFor(-HOUR, 'slow') === 0, 'a clock behind the save adds nothing');
  check(Away.ticksFor(NaN, 'slow') === 0 && Away.ticksFor(Date.now() - undefined, 'normal') === 0, 'a save with no time on it adds nothing');

  // A grown town, saved; brought back twice and left the same time, it becomes the same city both times.
  const map = seeded(12, () => MapGenerator(120, 100));
  for (let y = 20; y < 36; y++) for (let x = 20; x < 44; x++) map.setTile(x, y, TV.DIRT, 0);
  const sim = new Simulation(map, Simulation.LEVEL_EASY, Simulation.SPEED_MED), c = { map, sim, tools: Tools.makeTools(map) };
  Tools.build(c, 'road', [[20, 24]].concat(Tools.steps([20, 24], [43, 24])));
  Tools.build(c, 'coal', [[22, 21]]);
  for (let i = 0; i < 6; i++) Tools.build(c, 'residential', [[26 + i * 3, 22]]);
  Tools.build(c, 'commercial', [[26, 26]]); Tools.build(c, 'industrial', [[29, 26]]);
  Tools.build(c, 'wire', [[24, 24], [24, 25]]);
  seeded(3, () => { for (let i = 0; i < 2000; i++) { sim._simulate(sim._constructSimData()); sim._updateTime(); } });
  const saved = JSON.stringify(Save.packSim(sim));

  function away(ticks, seed) {
    return new Promise((done) => {
      const b = Save.unpackSim(JSON.parse(saved), Simulation.LEVEL_EASY, Simulation.SPEED_MED), s = b.sim;
      Away.run({ ticks, random: Util.mulberry32(seed), time: () => s._cityTime,
        step: () => { if (s.budget.awaitingValues) return false; s._simulate(s._constructSimData()); s._updateTime(); return true; },
        done: (r) => { const v = []; for (let y = 0; y < 100; y++) for (let x = 0; x < 120; x++) v.push(b.map.getTileValue(x, y));
          done({ r, t: s._cityTime, funds: s.budget.totalFunds,  tiles: v.join() }); } });
      // something else in the page drawing on Math.random between chunks must not change the city
      const noise = setInterval(() => Math.random(), 0); setTimeout(() => clearInterval(noise), 50);
    });
  }
  const seed = Away.seedFor(12, 1700000000000, 96);
  const one = await away(96, seed), two = await away(96, seed), other = await away(96, Away.seedFor(12, 1700000000000, 95));
  check(one.r.ran === 96 && !one.r.stalled, 'two game years run (' + one.r.ran + ' ticks)');
  check(one.tiles === two.tiles && one.funds === two.funds && one.t === two.t, 'the same save, the same time away: the same city');
  check(one.tiles !== other.tiles || one.funds !== other.funds, 'another absence, another city');
  const before = []; for (let y = 0; y < 100; y++) for (let x = 0; x < 120; x++) before.push(map.getTileValue(x, y));
  check(one.tiles !== before.join(), 'and the town changed while it ran');

  // Stopped part way, it stops at a chunk's end.
  const part = await new Promise((done) => {
    const b = Save.unpackSim(JSON.parse(saved), Simulation.LEVEL_EASY, Simulation.SPEED_MED), s = b.sim;
    const job = Away.run({ ticks: 240, random: Util.mulberry32(1), time: () => s._cityTime,
      step: () => { s._simulate(s._constructSimData()); s._updateTime(); return true; },
      progress: (n) => { if (n >= 24) job.cancel(); }, done: done });
  });
  check(part.cancelled && part.ran >= 24 && part.ran < 240, 'Stop here stops it (' + part.ran + ' ticks)');

  // No ticks (or NaN ones) finish at once instead of stepping forever.
  const none = await new Promise((done) => { let n = 0;
    Away.run({ ticks: NaN, random: Util.mulberry32(1), time: () => 0, step: () => { n++; return n < 100000; }, done: (r) => done({ r, n }) }); });
  check(none.n === 0 && none.r.ran === 0, 'a run of no ticks ends at once without stepping');

  if (failures) { console.log(failures + ' failed'); process.exit(1); }
  console.log('zimcity away: all passed');
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
