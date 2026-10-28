// ZimiGames: seats for Snakes and Ladders and Mahjong for Four. The pages load handoff.js ahead of
// their scripts, keep the shell markers, and use ZimiSeats for who is a person; the rules the pages
// lean on (the seat kinds they save, who needs the "Pass to" cover during a claim round) are checked
// against handoff.js and the Mahjong engine. Run: node tests/test_games_hotseat3.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
let failures = 0, passed = 0;
const check = (ok, label) => {
  if (ok) { passed++; console.log('ok: ' + label); } else { console.error('FAIL: ' + label); failures++; }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

// ── the pages ──
for (const [page, script] of [['snakesandladders.html', 'snakesandladders.js'], ['mahjong4.html', 'mahjong4.js']]) {
  const html = read(page), src = read(script);
  const h = html.indexOf('<script src="handoff.js">'), g = html.indexOf('<script src="' + script + '">');
  check(h > 0 && g > h, page + ': handoff.js loads before ' + script);
  check(html.includes('<!-- zimi-shell -->') && html.includes('<!-- zimi-recent -->'), page + ': shell and recent markers kept');
  check(src.includes('ZimiSeats.create'), script + ' makes its seats with ZimiSeats');
  check(!src.includes('\u2014'), script + ': no em dashes');
}
check(!/\bME\b/.test(read('mahjong4.js')), 'mahjong4.js: no fixed seat 0 left (the viewer is seats.view())');
check(!read('snakesandladders.js').includes("key: 'mode'"), 'snakesandladders.js: the Who plays option is replaced by the seat rows');
check(read('snakesandladders.js').includes("'zimi.games.snakesandladders.seats'"), 'snakesandladders.js: a saved "People on this device" game is migrated once');

// ── handoff.js in a sandbox, as the pages use it ──
function load(store0) {
  const store = Object.assign({}, store0);
  const sandbox = { console, localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('text.js'), sandbox, { filename: 'text.js' });
  vm.runInContext(read('handoff.js'), sandbox, { filename: 'handoff.js' });
  return { Z: sandbox.ZimiSeats, store };
}

// Snakes and Ladders: seats sized to the player count, kinds survive a size change
{
  const { Z, store } = load({});
  const two = Z.create({ id: 'snakesandladders', seats: 2 });
  check(same(two.kinds(), ['person', 'cpu']) && !two.hotseat(), 'snakes: default is you against one computer');
  for (let i = 0; i < 4; i++) Z.create({ id: 'snakesandladders', seats: 4 }).setKind(i, 'person');
  const all = Z.create({ id: 'snakesandladders', seats: 4 });
  check(same(all.kinds(), ['person', 'person', 'person', 'person']) && all.hotseat(), 'snakes: four people');
  const three = Z.create({ id: 'snakesandladders', seats: 3 });
  check(same(three.kinds(), ['person', 'person', 'person']), 'snakes: dropping to three keeps the first three seats');
  check(three.name(1) === 'Player 2' && three.isYou(1) === false, 'snakes: people share the device by name, nobody is "You"');
  const cpu = Z.create({ id: 'snakesandladders', seats: 4, cpuNames: ['Blue', 'Red', 'Green', 'Gold'] });
  cpu.setKind(2, 'cpu');
  check(Z.create({ id: 'snakesandladders', seats: 4, cpuNames: ['Blue', 'Red', 'Green', 'Gold'] }).name(2) === 'Green', 'snakes: a computer seat keeps its colour name');
  check('zimi.games.snakesandladders.seats' in store, 'snakes: kinds are saved under the id the page checks for migration');
  const alone = Z.create({ id: 'x', seats: 3 });
  check(alone.name(0) === 'You' && alone.isYou(0), 'one person alone is "You"');
}

// Mahjong: the claim round asks people in turn after the discarder; computers never get a cover
{
  const { Z } = load({ 'zimi.games.mahjong4.seats': JSON.stringify({ kinds: ['person', 'cpu', 'person', 'person'] }) });
  const seats = Z.create({ id: 'mahjong4', seats: 4 });
  check(seats.hotseat() && same(seats.people(), [0, 2, 3]), 'mahjong: three people, one computer');
  check(seats.view() === 0 && seats.rel(2) === 2 && seats.rel(1) === 1, 'mahjong: the first person sits at the bottom, the others turn clockwise');
  // the page asks (discarder + d) % 4 for d = 1..3, persons only
  const order = (p) => [1, 2, 3].map((d) => (p + d) % 4).filter((q) => seats.person(q));
  check(same(order(0), [2, 3]) && same(order(2), [3, 0]) && same(order(1), [2, 3, 0]), 'mahjong: people are asked in turn order after the discarder');
  check(!Z.needsCover(['person', 'cpu', 'person', 'person'], 0, 1), 'mahjong: a computer seat never needs the cover');
  check(Z.needsCover(['person', 'cpu', 'person', 'person'], 0, 2) && !Z.needsCover(['person', 'cpu', 'person', 'person'], 2, 2), 'mahjong: a second person needs the cover, the one looking does not');
  const solo = Z.create({ id: 'mahjong4-solo', seats: 4 });
  check(!solo.hotseat() && solo.view() === 0 && !solo.needsCover(0), 'mahjong: one person alone never sees a cover');
}

// the engine hands every other seat a claim record, which is what the page reads per person
{
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('mahjong4-engine.js'), sandbox, { filename: 'mahjong4-engine.js' });
  const E = sandbox.Mahjong4Engine;
  const t = E.newHand({ dealer: 0, min: 1 });
  check(t.turn === 0 && E.discard(t, 0, t.hands[0][0]), 'engine: the dealer discards');
  check(same(Object.keys(t.claims).map(Number).sort(), [1, 2, 3]), 'engine: a claim record for each other seat, none for the discarder');
}

console.log(passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
