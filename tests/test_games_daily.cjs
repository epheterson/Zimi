// ZimiGames' daily editions: one mechanism in shell.js (?daily=YYYY-MM-DD -> a seed from the date and the page), so a daily is
// the same deal for everyone that day on every Zimi, whatever a device's clock or time zone; the results it keeps (streaks,
// stats); and every page it names really takes part.
//
// Run: node tests/test_games_daily.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

// A page with the shell (and util.js, as a daily page has), at an address, with a device clock in a time zone of its own.
function page(pathname, search, opts) {
  const o = opts || {};
  const store = Object.assign({}, o.storage);
  const doc = {
    readyState: 'complete', body: { appendChild() {} }, head: { appendChild() {} }, createElement: () => ({}),
    documentElement: { setAttribute() {}, classList: { add() {}, remove() {} } },
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], title: 'Game - ZimiGames'
  };
  const RealDate = Date;
  const shift = o.at ? o.at - Date.now() : (o.clockShiftMs || 0);
  function ShiftedDate(...a) { return a.length ? new RealDate(...a) : new RealDate(RealDate.now() + shift); }
  ShiftedDate.UTC = RealDate.UTC; ShiftedDate.now = () => RealDate.now() + shift; ShiftedDate.prototype = RealDate.prototype;
  const sb = {
    console, document: doc, location: { pathname: '/w/zimi_games/' + pathname, search: search || '', hash: '' }, addEventListener() {},
    matchMedia: () => ({ matches: false }), Date: ShiftedDate, URL,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(read('util.js'), sb, { filename: 'util.js' });
  vm.runInContext(read('shell.js'), sb, { filename: 'shell.js' });
  return { S: sb.ZimiShell, U: sb.ZimiUtil, store, sb };
}

// ── the edition: the date in the address, not the device's clock ──
{
  const DAY = '2026-11-04';
  const a = page('sudoku.html', '?daily=' + DAY, { clockShiftMs: -11 * 3600e3 });   // Honolulu's evening
  const b = page('sudoku.html', '?daily=' + DAY, { clockShiftMs: 13 * 3600e3 });    // Auckland's next morning
  check(!!a.S.daily && a.S.daily.day === DAY, 'a page opened with ?daily= is that day\'s edition');
  check(a.S.seed() === b.S.seed() && a.U.newSeed() === b.U.newSeed(), 'two devices in different time zones get the same seed for the day');
  const ra = a.S.random(), rb = b.S.random();
  const seqA = [0, 0, 0, 0, 0].map(() => ra()), seqB = [0, 0, 0, 0, 0].map(() => rb());
  check(JSON.stringify(seqA) === JSON.stringify(seqB), 'and the same random sequence, so the same deal');
  check(a.S.seed() === a.S.dailySeed(DAY, 'sudoku.html'), 'the seed is the hash of the date and the page');
  check(a.S.dailySeed(DAY, 'sudoku.html') !== a.S.dailySeed(DAY, 'minesweeper.html'), 'each game has its own daily');
  check(a.S.dailySeed(DAY, 'sudoku.html') !== a.S.dailySeed('2026-11-05', 'sudoku.html'), 'and each day');
  check(a.S.dailySeed(DAY, 'sudoku.html') === 398805920, 'a day\'s seed never changes from one release to the next');
  check(a.S.day() === DAY && a.S.day('') === '20261104', 'the page plays the daily\'s day, in either form');
  const plain = page('sudoku.html', '');
  check(plain.S.daily === null && plain.S.seed() !== plain.S.seed(), 'without ?daily= a game is dealt by chance');
  check(page('sudoku.html', '?daily=2026-02-30').S.daily === null, 'a date that does not exist is no daily');
  check(page('chess.html', '?daily=' + DAY).S.daily === null, 'a game with no daily ignores ?daily=');
  let broken = null;
  try { broken = page('sudoku.html', '?daily=%E0%A4%A'); } catch (e) { broken = null; }
  check(!!broken && broken.S.daily === null, 'a broken ?daily= starts an ordinary game');
  const pz = page('puzzles/loopy.html', '?daily=' + DAY);
  check(pz.S.daily && pz.S.daily.kind === '10x10t0dn', 'a Tatham puzzle\'s daily carries its fixed type');
}

// ── an own-daily game opened from its ordinary tile plays the server's day ──
{
  const AT = Date.UTC(2026, 10, 4, 12, 0);   // noon UTC: Auckland is already on the 5th, Honolulu still on the 4th
  const nz = page('fiveletters.html', '', { at: AT, storage: { 'zimi.games.serverOffset': '780' } });
  const hi = page('fiveletters.html', '', { at: AT, storage: { 'zimi.games.serverOffset': '-600' } });
  check(nz.S.day() === '2026-11-05' && hi.S.day() === '2026-11-04', 'without ?daily= a page plays the server\'s day, from the offset it last answered');
  check(page('fiveletters.html', '?daily=2026-11-04', { at: AT, storage: { 'zimi.games.serverOffset': '780' } }).S.day() === '2026-11-04', 'a daily\'s own date still wins');
}

// ── a daily keeps its own save ──
{
  const DAY = '2026-11-04';
  const p = page('sudoku.html', '?daily=' + DAY, { storage: { 'zimi.games.save.sudoku': '{"v":1,"data":{"ordinary":1}}' } });
  let got = null;
  p.S.persist({ save: () => ({ daily: 1 }), load: (d) => { got = d; } });
  check(got === null, 'a daily does not load the ordinary game\'s save');
}

// ── results: streaks and totals ──
{
  const { S } = page('index.html', '');
  const st = S.stats;
  let all = st.read();
  ['2026-11-01', '2026-11-02', '2026-11-03'].forEach((d) => { all = st.add(all, 'sudoku.html', 'win', d); });
  all = st.add(all, 'puzzles/loopy.html', 'win', '2026-11-03');
  check(st.streak(all, '2026-11-03') === 3, 'three days in a row with a daily is a three-day streak');
  check(st.streak(all, '2026-11-04') === 3, 'and it holds through today while today\'s is still to play');
  check(st.streak(all, '2026-11-05') === 0, 'a day missed ends it');
  check(st.streak(all, '2026-11-03', 'puzzles/loopy.html') === 1, 'a game has its own streak');
  all = st.add(all, 'chess.html', 'lose', null);
  const t = st.totals(all, '2026-11-03');
  check(t.finished === 5 && t.wins === 4 && t.kinds === 3 && t.dailies === 4 && t.best === 3, 'the totals count every finished game, dailies by day');
  check(t.earned.indexOf('firstWin') >= 0 && t.earned.indexOf('week') < 0, 'milestones are what the totals reach, nothing more');
  check(st.dayBefore('2026-03-01') === '2026-02-28' && st.dayBefore('2025-01-01') === '2024-12-31', 'the day before crosses months and years');
}

// ── every page DAILY names takes part ──
{
  const { S } = page('index.html', '');
  const rows = JSON.parse(read('games.json'));
  const shelf = new Set(rows.map((r) => r.path));
  const names = Object.keys(S.DAILY);
  check(names.every((p) => shelf.has(p)), 'every daily is a game on the shelf');
  check(names.filter((p) => p.startsWith('puzzles/')).length === rows.filter((r) => r.path.startsWith('puzzles/')).map((r) => r.path).filter((v, i, a) => a.indexOf(v) === i).length, 'every Tatham puzzle on the shelf has a daily');
  const seeded = names.filter((p) => S.DAILY[p] === true);
  const noUtil = seeded.filter((p) => !/<script src="util\.js"><\/script>/.test(read(p)));
  check(!noUtil.length, 'every seeded daily page loads util.js, the one generator: ' + noUtil.join(', '));
  const asks = /ZimiShell\.(seed|random)\(\)|ZimiUtil\.newSeed\(\)|Z\.random\(\)|ZimiShell\.daily\b/;
  const silent = seeded.filter((p) => !asks.test(read(p.replace('.html', '.js'))));
  check(!silent.length, 'every seeded daily deals from the day\'s seed: ' + silent.join(', '));
  const own = names.filter((p) => S.DAILY[p] === 'own');
  const ownSilent = own.filter((p) => !/daily: function/.test(read(p.replace('.html', '.js'))) || !/ZimiShell\.day\(|ZimiShell\.day\b/.test(read(p.replace('.html', '.js'))));
  check(!ownSilent.length, 'every own-daily game reads the shell\'s day and says when a round is the day\'s: ' + ownSilent.join(', '));
}

// ── one hash: the shell's is the only one in the games, and it is zimi/gamelinks.py's (tests/test_games_links.py pins the same) ──
{
  const { S } = page('index.html', '');
  check(S.hash('') === 0x811C9DC5 && S.hash('a') === 0xE40C292C && S.hash('foobar') === 0xBF9CF968, 'the shell\'s FNV-1a is gamelinks.py\'s');
  const copies = fs.readdirSync(dir).concat(fs.readdirSync(path.join(dir, 'puzzles')).map((f) => 'puzzles/' + f))
    .filter((f) => f.endsWith('.js') && f !== 'shell.js' && /0x811c9dc5/i.test(read(f)));
  check(!copies.length, 'no other games file carries a copy of the hash: ' + copies.join(', '));
}

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
