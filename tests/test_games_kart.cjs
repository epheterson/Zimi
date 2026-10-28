// ZimiGames ZimiKart: the rules with no DOM. Tracks close and keep their laps in order, drifts charge by their thresholds, the five items
// do what they say and are drawn by place, the computer drivers stay on the road for a whole race, the camera's projection inverts.
//
// Run: node tests/test_games_kart.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(dir, 'util.js'), 'utf8'), sandbox, { filename: 'util.js' });
vm.runInContext(fs.readFileSync(path.join(dir, 'kart.js'), 'utf8'), sandbox, { filename: 'kart.js' });
const E = sandbox.KartEngine;

let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const DT = 1 / 60;
const NONE = { steer: 0, gas: false, brake: false, drift: false, item: false };

// ── tracks ──────────────────────────────────────────────────────────────────
check(E.TRACKS.length === 6 && E.CUPS.length === 2 && E.CUPS.every(c => c.tracks.length === 3), 'six tracks in two cups of three');
check(E.DRIVERS.length === 8, 'eight drivers');
E.TRACKS.forEach(def => {
  const T = E.buildTrack(def);
  const last = T.N - 1, gap = Math.hypot(T.x[0] - T.x[last], T.y[0] - T.y[last]);
  check(near(gap, T.ds, T.ds * 0.2), def.id + ': the loop closes (' + gap.toFixed(2) + ' between the last sample and the first)');
  check(T.L > 2000 && T.L < 3800, def.id + ': a lap of ' + Math.round(T.L) + ' units');
  let minSep = 1e9;
  for (let i = 0; i < T.N; i += 2) for (let j = i + 1; j < T.N; j += 2) {
    const d = Math.min(j - i, T.N - (j - i));
    if (d * T.ds < 150) continue;
    minSep = Math.min(minSep, Math.hypot(T.x[i] - T.x[j], T.y[i] - T.y[j]));
  }
  check(minSep > 2 * T.reach, def.id + ': no road comes within two reaches of another (' + minSep.toFixed(0) + ' > ' + 2 * T.reach + ')');
  let ok = true;
  for (let i = 0; i < T.N; i++) { const l = E.locate(T, T.x[i], T.y[i], -1); if (Math.abs(l.d) > 0.01 || Math.abs(l.s - i * T.ds) > 0.3) ok = false; }
  check(ok, def.id + ': every centre-line point locates to itself');
  const p = E.pointAt(T, 123.4, 10), l = E.locate(T, p.x, p.y, -1);
  check(near(l.s, 123.4, 0.5) && near(l.d, 10, 0.2), def.id + ': a point 10 to the right locates at +10');
});
check(E.buildTrack('redrock').gap && !E.buildTrack('tidewalk').gap, 'only the canyon has a jump');

// ── laps and checkpoints ────────────────────────────────────────────────────
{
  const T = E.buildTrack('tidewalk'), race = E.createRace(T, { humans: 1, driver: 0, seed: 3, laps: 2 });
  const me = race.karts.find(k => k.human === 0);
  check(me.total < 0 && me.cp === 1 && me.lap === 0, 'a kart starts behind the line, on checkpoint 1');
  // drive the line by hand
  let laps = 0, t = 0;
  while (!race.over && t < 300) {
    const inp = E.aiInput(race, me); me.speedScale = 1;
    E.step(race, [inp], DT).forEach(e => { if (e.type === 'lap' && e.kart === me) laps++; });
    t += DT;
  }
  check(me.finished != null && me.lap === 2 && laps === 2, 'two laps counted in order, then the finish');
  // a kart dropped just before the line without passing the checkpoints does not get a lap
  const r2 = E.createRace(T, { humans: 1, driver: 0, seed: 3, laps: 2 }), k2 = r2.karts.find(k => k.human === 0);
  E.step(r2, [NONE], 3.5);
  const pt = E.pointAt(T, T.L - 30, 0);
  k2.x = pt.x; k2.y = pt.y; k2.angle = k2.dir = pt.a; k2.v = 40; k2.idx = -1; k2.total = -30;
  for (let i = 0; i < 120; i++) E.step(r2, [{ steer: 0, gas: true, brake: false, drift: false }], DT);
  check(k2.lap === 0 && k2.cp === 1 && k2.total > 0, 'rolling over the start line is not a lap: the first lap is the whole way round');
  // reversing over the line does not count backwards or forwards a lap
  const r3 = E.createRace(T, { humans: 1, driver: 0, seed: 3, laps: 3 }), k3 = r3.karts.find(k => k.human === 0);
  E.step(r3, [NONE], 3.5);
  const before = k3.total;
  const pt3 = E.pointAt(T, 40, 0);
  k3.x = pt3.x; k3.y = pt3.y; k3.angle = pt3.a; k3.angle = pt3.a + Math.PI; k3.dir = pt3.a + Math.PI; k3.v = 30; k3.idx = -1; k3.total = 40; k3.s = 40;
  for (let i = 0; i < 60; i++) E.step(r3, [NONE], DT);
  check(k3.lap === 0 && k3.total < 40, 'driving the wrong way lowers progress and counts no lap');
  check(before < 0, 'progress is measured from behind the line');
}

// ── drift ───────────────────────────────────────────────────────────────────
check(E.driftLevel(0) === 0 && E.driftLevel(E.CHARGE[0] - 0.01) === 0 && E.driftLevel(E.CHARGE[0]) === 1 && E.driftLevel(E.CHARGE[1]) === 2 && E.driftLevel(E.CHARGE[2]) === 3 && E.driftLevel(99) === 3, 'drift levels change at the three charge thresholds');
check(E.CHARGE[0] < E.CHARGE[1] && E.CHARGE[1] < E.CHARGE[2] && E.MINI[0] < E.MINI[1] && E.MINI[1] < E.MINI[2], 'longer drifts earn longer boosts');
{
  const T = E.buildTrack('tidewalk');
  function driftFor(seconds) {
    const k = E.newKart(0, E.DRIVERS[0], 0), p = E.pointAt(T, 300, 0);
    k.x = p.x; k.y = p.y; k.angle = k.dir = p.a; k.v = 66; k.idx = -1;
    const l = E.locate(T, k.x, k.y, -1); k.idx = l.i; k.s = l.s;
    const ev = [];
    for (let i = 0; i < seconds * 60; i++) {
      // hold a wide, gentle drift to the right and steer to stay on the road
      const want = Math.atan2(E.pointAt(T, k.s + 40, 0).y - k.y, E.pointAt(T, k.s + 40, 0).x - k.x);
      E.stepKart(T, k, { steer: Math.max(-1, Math.min(1, E.angDiff(want, k.angle) * 3)), gas: true, brake: false, drift: true }, DT, ev);
      if (k.drift === 0 && i > 3) break;
    }
    return { k, ev };
  }
  const k0 = E.newKart(0, E.DRIVERS[0], 0), p0 = E.pointAt(T, 300, 0);
  k0.x = p0.x; k0.y = p0.y; k0.angle = k0.dir = p0.a; k0.v = 66; k0.idx = -1; k0.steer = 1;
  const l0 = E.locate(T, k0.x, k0.y, -1); k0.idx = l0.i; k0.s = l0.s;
  const ev = [];
  E.stepKart(T, k0, { steer: 1, gas: true, brake: false, drift: true }, DT, ev);
  check(k0.drift === 1 && ev.some(e => e.type === 'drift'), 'holding drift while steering right starts a right drift');
  k0.charge = E.CHARGE[1] + 0.1;
  const ev2 = [];
  E.stepKart(T, k0, { steer: 1, gas: true, brake: false, drift: false }, DT, ev2);
  check(k0.drift === 0 && k0.boost >= E.MINI[1] - 0.05 && ev2.some(e => e.type === 'miniboost' && e.level === 2), 'letting go at level 2 gives the level 2 boost');
  const k1 = E.newKart(1, E.DRIVERS[0], 0); k1.drift = 1; k1.charge = E.CHARGE[0] - 0.2; k1.v = 60;
  check(E.endDrift(k1) === 0 && k1.boost === 0, 'letting go before level 1 gives nothing');
  const slow = E.newKart(2, E.DRIVERS[0], 0), ps = E.pointAt(T, 300, 0);
  slow.x = ps.x; slow.y = ps.y; slow.angle = slow.dir = ps.a; slow.v = E.DRIFT_MIN_V - 8; slow.idx = -1; slow.steer = 1;
  E.stepKart(T, slow, { steer: 1, gas: true, brake: false, drift: true }, DT, []);
  check(slow.drift === 0, 'no drift below the minimum speed');
  const st = E.newKart(3, E.DRIVERS[0], 0); st.x = ps.x; st.y = ps.y; st.angle = st.dir = ps.a; st.v = 66; st.idx = -1;
  E.stepKart(T, st, { steer: 0, gas: true, brake: false, drift: true }, DT, []);
  check(st.drift === 0, 'no drift without steering');
  // a drift held for a second and a half charges to level 2 and no further than its clock
  const kd = E.newKart(5, E.DRIVERS[0], 0), pd = E.pointAt(T, 100, 0);
  kd.x = pd.x; kd.y = pd.y; kd.angle = kd.dir = pd.a; kd.v = 66; kd.idx = -1;
  const ld = E.locate(T, kd.x, kd.y, -1); kd.idx = ld.i; kd.s = ld.s;
  E.stepKart(T, kd, { steer: 1, gas: true, brake: false, drift: true }, DT, []);
  for (let i = 0; i < 90 && kd.drift; i++) E.stepKart(T, kd, { steer: -1, gas: true, brake: false, drift: true }, DT, []);
  check(kd.drift === 1 && E.driftLevel(kd.charge) >= 1 && E.driftLevel(kd.charge) <= 2, 'a drift held for a second and a half has charged to level 1 or 2 (' + kd.charge.toFixed(2) + ' s)');
}

// ── items ───────────────────────────────────────────────────────────────────
{
  const n = 8, lead = E.itemWeights(1, n), last = E.itemWeights(n, n);
  check(lead.magnet === 0, 'the leader never draws the magnet');
  check(last.slick === 0 && last.magnet > lead.magnet && last.spark > lead.spark && last.boost > lead.boost, 'the last car draws the helpers, not the slick');
  check(lead.shield > last.shield && lead.slick > last.slick, 'the leader draws the shield and the slick');
  let mono = true;
  for (let r = 1; r < n; r++) if (E.itemWeights(r + 1, n).magnet < E.itemWeights(r, n).magnet || E.itemWeights(r + 1, n).shield > E.itemWeights(r, n).shield) mono = false;
  check(mono, 'weights move smoothly from first to last place');
  // the draw follows the weights
  const rng = E.mulberry(5), count = { boost: 0, slick: 0, spark: 0, shield: 0, magnet: 0 };
  for (let i = 0; i < 20000; i++) count[E.drawItem(n, n, rng)]++;
  const tot = Object.values(count).reduce((a, b) => a + b, 0), w = E.itemWeights(n, n), wt = Object.values(w).reduce((a, b) => a + b, 0);
  check(E.ITEMS.every(it => near(count[it] / tot, w[it] / wt, 0.02)), 'the draw for the last car matches its weights');
  check(count.slick === 0, 'the last car is never dealt a slick');
  const c1 = { boost: 0, slick: 0, spark: 0, shield: 0, magnet: 0 };
  for (let i = 0; i < 20000; i++) c1[E.drawItem(1, n, rng)]++;
  check(c1.magnet === 0 && c1.shield > c1.boost, 'the leader is dealt no magnet and mostly shields');

  const T = E.buildTrack('tidewalk'), race = E.createRace(T, { humans: 1, driver: 0, seed: 9 });
  E.step(race, [NONE], 3.5);
  const me = race.karts.find(k => k.human === 0), foe = race.karts.find(k => k !== me && k.total > me.total) || race.karts.find(k => k !== me);
  // boost
  me.item = 'boost'; me.roll = 0; E.useItem(race, me);
  check(me.item === null && me.boost > 1, 'a boost item sets a boost running and is used up');
  // slick
  me.item = 'slick'; me.v = 40; E.useItem(race, me);
  check(race.oils.length === 1, 'a slick drops one oil patch');
  const oil = race.oils[0], victim = foe;
  victim.x = oil.x; victim.y = oil.y; victim.air = 0; victim.spin = 0; victim.inv = 0; victim.shield = 0; victim.v = 50;
  E.step(race, [NONE], DT);
  check(victim.spin > 0 && victim.v < 30 && race.oils.length === 0, 'a kart rolling over oil spins out, loses speed, and the patch is gone');
  // shield
  const v2 = race.karts.find(k => k !== me && k !== victim);
  v2.shield = 5; v2.inv = 0; v2.spin = 0;
  check(E.hitKart(race, v2, 'spark') === 'blocked' && v2.shield === 0 && v2.spin === 0, 'a shield blocks one hit and breaks');
  check(E.hitKart(race, v2, 'spark') === 'hit' && v2.spin > 0, 'the next hit lands');
  check(E.hitKart(race, v2, 'spark') === 'ignored', 'a kart that was just hit cannot be hit again at once');
  me.item = 'shield'; E.useItem(race, me);
  check(me.shield >= E.SHIELD_S - 0.01, 'the shield item raises a shield');
  // magnet
  me.item = 'magnet'; E.useItem(race, me);
  check(me.magnet >= E.MAGNET_S - 0.01, 'the magnet item starts the pull');
  // spark
  const r2 = E.createRace(T, { humans: 1, driver: 0, seed: 9 }); E.step(r2, [NONE], 3.5);
  const a = r2.karts.find(k => k.human === 0), ahead = r2.karts.filter(k => k !== a).sort((p, q) => q.total - p.total)[0];
  a.total = ahead.total - 40; r2.karts.forEach(k => { if (k !== a && k !== ahead) k.total = a.total - 500; }); a.item = 'spark'; a.roll = 0; E.useItem(r2, a);
  check(r2.orbs.length === 1 && r2.orbs[0].target === ahead.id, 'a spark targets the nearest kart ahead');
  ahead.shield = 0; ahead.inv = 0; ahead.spin = 0; ahead.air = 0; ahead.v = 0;
  const o = r2.orbs[0]; o.x = ahead.x - 20; o.y = ahead.y; o.a = 0;
  for (let i = 0; i < 90 && ahead.spin <= 0; i++) E.step(r2, [NONE], DT);
  check(ahead.spin > 0, 'the spark homes in and spins its target out');
  const r3 = E.createRace(T, { humans: 1, driver: 0, seed: 9 }); E.step(r3, [NONE], 3.5);
  const lead1 = r3.karts.slice().sort((p, q) => q.total - p.total)[0]; lead1.total += 5000; lead1.item = 'spark'; lead1.roll = 0; E.useItem(r3, lead1);
  check(r3.orbs[0].target === -1, 'the leader has nobody ahead, so the spark has no target');
}

// ── the computer drivers ────────────────────────────────────────────────────
E.TRACKS.forEach(def => {
  const T = E.buildTrack(def), race = E.createRace(T, { humans: 0, laps: 3, seed: 5, diff: 'normal' });
  let t = 0, maxD = 0, out = false;
  while (!race.over && t < 400) {
    E.step(race, [], DT); t += DT;
    race.karts.forEach(k => { maxD = Math.max(maxD, Math.abs(k.d)); if (Math.abs(k.d) > T.reach + 0.01) out = true; });
  }
  check(race.karts.every(k => k.finished != null), def.id + ': all eight drivers finish three laps (last at ' + Math.max.apply(null, race.karts.map(k => k.finished)).toFixed(0) + ' s)');
  check(!out && maxD <= T.reach + 0.01, def.id + ': nobody left the road (furthest ' + maxD.toFixed(1) + ' of ' + T.reach + ')');
  const spread = Math.max.apply(null, race.karts.map(k => k.finished)) - Math.min.apply(null, race.karts.map(k => k.finished));
  check(spread < 22, def.id + ': a close field (' + spread.toFixed(1) + ' s from first to last)');
});
{
  const T = E.buildTrack('redrock'), race = E.createRace(T, { humans: 0, laps: 3, seed: 5 });
  let jumps = 0, falls = 0;
  for (let t = 0; t < 400 && !race.over; t += DT) E.step(race, [], DT).forEach(e => { if (e.type === 'jump') jumps++; if (e.type === 'fall') falls++; });
  check(jumps >= 8 * 3 - 4 && falls <= 4, 'the computer drivers clear the canyon jump (' + jumps + ' jumps, ' + falls + ' falls)');
  const k = E.newKart(0, E.DRIVERS[0], 0), p = E.pointAt(T, T.gap.from + 10, 0);
  k.x = p.x; k.y = p.y; k.angle = k.dir = p.a; k.v = 10; k.idx = -1;
  const ev = []; E.stepKart(T, k, NONE, DT, ev);
  check(ev.some(e => e.type === 'fall'), 'a kart in the gap without a jump falls');
}
{
  // gentle rubber band: a driver far behind a person is a little faster, far ahead a little slower, never by more than a few percent
  const T = E.buildTrack('tidewalk'), race = E.createRace(T, { humans: 1, driver: 0, seed: 2, diff: 'normal' });
  E.step(race, [NONE], 3.5);
  const me = race.karts.find(k => k.human === 0), cpu = race.karts.find(k => k !== me);
  me.total = 5000; E.aiInput(race, cpu); const behind = cpu.speedScale;
  me.total = -5000; E.aiInput(race, cpu); const ahead = cpu.speedScale;
  check(behind > ahead && behind / E.DIFFICULTY.normal < 1.07 && ahead / E.DIFFICULTY.normal > 0.95, 'the rubber band is gentle (+' + ((behind / 0.98 - 1) * 100).toFixed(1) + '% behind, ' + ((ahead / 0.98 - 1) * 100).toFixed(1) + '% ahead)');
  check(E.DRIVERS.every(d => d.skill >= 0.9 && d.skill <= 1), 'every driver has a skill between 0.9 and 1');
  check(new Set(E.DRIVERS.map(d => d.kart)).size === 8 && new Set(E.DRIVERS.map(d => d.name)).size === 8, 'eight different names and kart colours');
}

// ── grand prix and ghosts ───────────────────────────────────────────────────
{
  let totals = E.DRIVERS.map(() => 0);
  totals = E.addPoints(totals, [3, 1, 0, 2, 4, 5, 6, 7]);
  check(totals[3] === 15 && totals[1] === 12 && totals[7] === 1, 'cup points go 15, 12, 10, ... 1 by finishing order');
  totals = E.addPoints(totals, [1, 3, 0, 2, 4, 5, 6, 7]);
  check(E.cupOrder(totals)[0] === 3 || E.cupOrder(totals)[0] === 1, 'the cup order follows the totals');
  check(totals[1] === 27 && totals[3] === 27 && E.cupOrder(totals)[0] === 1, 'equal totals keep the lower driver number first');
  const rec = E.ghostNew(), k = { x: 100.25, y: 200.5, angle: 1.5 };
  for (let t = 0; t < 2; t += DT) { k.x += 1; E.ghostPush(rec, t, k); }
  const g = E.ghostAt(rec, 1);
  check(rec.n >= 19 && rec.n <= 21 && g && near(g.x, 100.25 + 60, 3) && near(g.a, 1.5, 0.01), 'a ghost keeps ten samples a second and plays them back');
  check(E.ghostAt(rec, 99) === null && E.ghostAt(E.ghostNew(), 0) === null, 'a ghost ends where it ended');
  check(JSON.stringify(rec).length < 12000, 'two seconds of ghost fits in a small JSON');
}

// ── the camera ──────────────────────────────────────────────────────────────
{
  const view = { w: 300, h: 21, f: 250, hz: 90 }, cam = E.makeCamera(400, 300, 0.7, view);
  let ok = true;
  [[10, 10], [-30, 5], [60, -20], [0, 100]].forEach(([fx, fy]) => {
    // a point `fx` ahead and `fy` to the right of the camera
    const x = cam.x + cam.fx * (fx + 40) + cam.rx * fy, y = cam.y + cam.fy * (fx + 40) + cam.ry * fy;
    const p = E.project(cam, x, y);
    if (!p) { ok = false; return; }
    const q = E.groundAt(cam, p.sx, p.sy);
    if (!q || Math.hypot(q.x - x, q.y - y) > 0.01) ok = false;
  });
  check(ok, 'projecting a ground point and reading it back from the screen returns the same point');
  const ahead = E.project(cam, cam.x + cam.fx * 100, cam.y + cam.fy * 100), left = E.project(cam, cam.x + cam.fx * 100 - cam.rx * 30, cam.y + cam.fy * 100 - cam.ry * 30);
  check(near(ahead.sx, 150, 1e-6) && near(ahead.sy, 90 + 21 * 250 / 100, 1e-6), 'straight ahead is the middle column, below the horizon by height x focal / distance');
  check(left.sx < ahead.sx && near(ahead.sx - left.sx, 30 * 250 / 100, 1e-6), 'a point to the left lands left, by focal x side / distance');
  check(E.project(cam, cam.x - cam.fx * 50, cam.y - cam.fy * 50) === null, 'a point behind the camera is not drawn');
  const near1 = E.project(cam, cam.x + cam.fx * 50, cam.y + cam.fy * 50), far1 = E.project(cam, cam.x + cam.fx * 200, cam.y + cam.fy * 200);
  check(near(near1.scale, 4 * far1.scale, 1e-9) && near1.sy > far1.sy, 'twice as far is half as big and nearer the horizon');
  check(E.groundAt(cam, 100, 80) === null, 'a pixel above the horizon has no ground');
}

check(E.ordinal(1) === '1st' && E.ordinal(2) === '2nd' && E.ordinal(3) === '3rd' && E.ordinal(8) === '8th' && E.ordinal(11) === '11th' && E.fmtTime(75.34) === '1:15.3', 'ordinals and times read well');

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
