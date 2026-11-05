// ZimCity's fixes to the micropolisJS engine (zimcity/ENGINE.md, "Fixes"), each one held by a check that fails on the
// upstream code: fire reaches its neighbours, crime is counted, a position can be copied and offset, a loaded city's
// people are not counted twice, a city asks for a hospital, underfunded police and fire count, and the climate's month
// reads the city's last whole count.
//
// Run: node tests/test_games_zimcity_engine_fixes.cjs   (exit 0 = pass)

const path = require('path');
const { pathToFileURL } = require('url');

const games = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
const mod = (p) => import(pathToFileURL(path.join(games, p)).href);

let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log('FAIL ' + label); } else console.log('ok   ' + label); };

(async () => {
  const { GameMap } = await mod('zimcity/engine/gameMap.js');
  const { MiscTiles } = await mod('zimcity/engine/miscTiles.js');
  const { BlockMap } = await mod('zimcity/engine/blockMap.js');
  const { BlockMapUtils } = await mod('zimcity/engine/blockMapUtils.js');
  const { Position } = await mod('zimcity/engine/position.js');
  const { Traffic } = await mod('zimcity/engine/traffic.js');
  const { Census } = await mod('zimcity/engine/census.js');
  const { Budget } = await mod('zimcity/engine/budget.js');
  const { Simulation } = await mod('zimcity/engine/simulation.js');
  const TV = await mod('zimcity/engine/tileValues.js');
  const TF = await mod('zimcity/engine/tileFlags.js');
  const Save = await mod('zimcity-save.js');
  await mod('zimcity-modern.js');
  const Climate = await mod('zimcity-climate.js');

  // Fire: a burning tile with woods beside it; every chance falls the fire's way.
  {
    const map = new GameMap(20, 20);
    map.setTile(10, 10, TV.FIRE, TF.ANIMBIT);
    for (const [x, y] of [[9, 10], [11, 10], [10, 9], [10, 11]]) map.setTile(x, y, TV.WOODS, TF.BLBNBIT);
    let fireFound = null;
    MiscTiles.registerHandlers({ addAction: (cond, fn) => { if (!fireFound) fireFound = fn; } }, null);
    const fireMap = new BlockMap(20, 20, 8);
    const real = Math.random;
    Math.random = () => 0;
    try {
      fireFound(map, 10, 10, { census: { firePop: 0 }, blockMaps: { fireStationEffectMap: fireMap }, spriteManager: { makeExplosionAt() {} } });
    } finally { Math.random = real; }
    const lit = [[9, 10], [11, 10], [10, 9], [10, 11]].filter(([x, y]) => { const v = map.getTileValue(x, y); return v >= TV.FIREBASE && v <= TV.LASTFIRE; });
    check(lit.length > 0, 'fire spreads to the woods beside it');
  }

  // Power: a wire that forks powers both branches. The scan's direction must start fresh for each branch it pops;
  // carried over from the last branch, it moved the next one off its fork and the branch stayed dark.
  {
    const { PowerManager } = await mod('zimcity/engine/powerManager.js');
    const map = new GameMap(30, 30);
    const wire = (x, y) => map.setTile(x, y, TV.HPOWER, TF.CONDBIT | TF.BURNBIT | TF.BULLBIT);
    for (let y = 5; y <= 20; y++) wire(15, y);           // a line down from the plant
    for (let x = 6; x < 15; x++) wire(x, 12);            // a branch west off it
    for (let x = 16; x <= 24; x++) wire(x, 16);          // and one east, further down
    const pm = new PowerManager(map);
    pm._powerStack.push(new Position(15, 5));
    pm.doPowerScan({ coalPowerPop: 1, nuclearPowerPop: 0 });
    const lit = (x, y) => pm.powerGridMap.worldGet(x, y) > 0;
    check(lit(6, 12) && lit(24, 16), 'both branches off a forked wire are powered');
  }

  // A coal plant at the very edge of the map (the Bluebird city has one) is found without throwing.
  {
    const { PowerManager } = await mod('zimcity/engine/powerManager.js');
    const map = new GameMap(30, 30);
    const pm = new PowerManager(map);
    let threw = null;
    try { pm.coalPowerFound(map, 29, 10, { census: { coalPowerPop: 0 } }); } catch (e) { threw = e; }
    check(!threw, 'a coal plant at the map edge is found without throwing');
  }

  // Score: a city that shrank a little keeps most of its score. Upstream took Math.floor of a ratio between -1 and 0,
  // so any dip scaled the score by -0.05 and the smoothed score halved every year (Tokyo, Boston, Rio lost at random).
  // getScore reads module state the page's problem scan fills, so this checks the scale itself.
  {
    const src = require('fs').readFileSync(path.join(games, 'zimcity/engine/evaluation.js'), 'utf8');
    const line = (src.match(/scale = 0\.95 \+[^;]*;/) || [''])[0];
    const scale = (pop, delta) => 0.95 + delta / (pop - delta);
    check(line && !/Math\.floor/.test(line) && scale(100000, -1000) > 0.9, 'a small dip in population keeps the score scale near 1');
  }

  // Crime: developed land with no police has crime.
  {
    const W = 40, H = 40, bm = (s) => new BlockMap(W, H, s);
    const maps = { policeStationMap: bm(8), policeStationEffectMap: bm(8), crimeRateMap: bm(2), landValueMap: bm(2), populationDensityMap: bm(2) };
    for (let x = 0; x < W; x += 2) for (let y = 0; y < H; y += 2) { maps.landValueMap.worldSet(x, y, 20); maps.populationDensityMap.worldSet(x, y, 200); }
    const census = { crimeAverage: 0 };
    BlockMapUtils.crimeScan(census, maps);
    check(census.crimeAverage > 0, 'crime is counted on developed land with no police');
  }

  // Position: the copy and offset forms traffic and the map generator use.
  {
    const p = new Position(3, 4), q = new Position(p), r = new Position(p, 1, -1);
    check(q.x === 3 && q.y === 4 && q !== p, 'new Position(p) copies');
    check(r.x === 4 && r.y === 3, 'new Position(p, dx, dy) offsets');
  }

  // Traffic: a car on a straight road reaches the building at its end (it copied its start as a broken position and
  // then moved an undefined one, so no trip ever arrived).
  {
    const map = new GameMap(30, 12);
    for (let x = 5; x <= 15; x++) map.setTile(x, 5, TV.ROADS, TF.BULLBIT | TF.BURNBIT);
    map.setTile(16, 5, TV.HOSPITAL, 0);
    const real = Math.random;
    Math.random = () => 0;
    let arrived;
    try { arrived = new Traffic(map, null).tryDrive(new Position(5, 5), (v) => v === TV.HOSPITAL); } finally { Math.random = real; }
    check(arrived === true, 'a trip along a road arrives');
  }

  // A loaded city's people are counted by the scan that follows the load, once.
  {
    const map = new GameMap(Save.MAP_W, Save.MAP_H);
    const sim = new Simulation(map, Simulation.LEVEL_EASY, Simulation.SPEED_MED);
    const sd = Save.packSim(sim);
    sd.resPop = 999999; sd.comPop = 999999; sd.indPop = 999999;
    const back = Save.unpackSim(sd, 0, Simulation.SPEED_MED);
    check(back.sim._census.resPop < 999999 && back.sim._census.indPop < 999999, 'a loaded city does not add the saved count to the scan');
  }

  // A city of 8,000 people with no hospital asks for one.
  {
    const c = new Census();
    c.resPop = 8000; c.hospitalPop = 0; c.needHospital = 0;
    c.take10Census({ cashFlow: 0 });
    check(c.needHospital === 1, 'a city with people and no hospital asks for one');
  }

  // Underfunded police and fire: the constants the evaluation and the simulation read exist.
  {
    const b = new Budget();
    check(b.MAX_POLICE_STATION_EFFECT === 1000 && b.MAX_FIRE_STATION_EFFECT === 1000, 'the funding effects have the names the city reads');
    check(b.policeEffect === 1000 && b.fireEffect === 1000, 'a new budget funds police and fire fully');
  }

  // The climate's month runs right after the census is cleared: it reads the last whole count.
  {
    const map = new GameMap(Save.MAP_W, Save.MAP_H);
    const sim = new Simulation(map, Simulation.LEVEL_EASY, Simulation.SPEED_MED);
    sim._census.coalPowerPop = 3;
    sim._clearCensus();
    const state = Climate.fresh();
    Climate.tick(sim, state, true, false);
    check(state.carbon >= 3, 'coal plants counted in the last scan warm the city');
  }

  console.log(failures ? failures + ' failed' : 'zimcity engine fixes: all passed');
  process.exit(failures ? 1 : 0);
})();
