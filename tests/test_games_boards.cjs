// This server's boards, the games' side (shell.js): every board game's best kept in one shape (read from the game's own best,
// a best from before the boards included), a daily's run with how it ended and how long it took, and an arcade game's house
// table, the same on every device and labelled for what it is.
//
// Run: node tests/test_games_boards.cjs   (exit 0 = pass)

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

// ── a game's best in one shape ──
{
  const a = page('rocks.html', '', { storage: { 'zimi.games.rocks.best': JSON.stringify({ score: 1234 }) } });
  const kept = JSON.parse(a.store['zimi.games.best.rocks.html'] || 'null');
  check(kept && kept.score === 1234 && kept.better === 'high', 'a best from before the boards is carried into the one shape when the game opens');
  const b = page('rocks.html', '', { storage: { 'zimi.games.rocks.best': JSON.stringify({ score: 900 }), 'zimi.games.best.rocks.html': JSON.stringify({ score: 2000, better: 'high', at: 5 }) } });
  check(JSON.parse(b.store['zimi.games.best.rocks.html']).score === 2000, 'a lower score never replaces a kept best (another device\'s, say)');
  const c = page('echo.html', '', { storage: { 'zimi.games.echo.best': JSON.stringify({ length: 14 }) } });
  check(JSON.parse(c.store['zimi.games.best.echo.html']).score === 14, 'a game that counts its best its own way (Echo\'s length) comes in too');
  const s = page('sudoku.html', '', {});
  check(!('zimi.games.best.sudoku.html' in s.store), 'a game with no best board keeps none');
}

// ── a daily's run ──
{
  const DAY = '2026-11-04', p = page('sudoku.html', '?daily=' + DAY, {});
  p.store['zimi.games.day.' + DAY] = JSON.stringify({ 'sudoku.html': { start: Date.now() - 125000 } });
  p.S.boardParts.dayRun(DAY, 'win');
  const run = p.S.boardParts.dayRuns(DAY)['sudoku.html'];
  check(run.r === 'win' && run.ms >= 125000 && run.ms < 130000, 'a daily ends with how it ended and the time since it was first touched');
  p.S.boardParts.dayRun(DAY, 'lose');
  check(p.S.boardParts.dayRuns(DAY)['sudoku.html'].r === 'win', 'and is counted once');
}

// ── the house table ──
{
  const a = page('rocks.html', '', {}).S.boardParts.house('rocks.html'), b = page('rocks.html', '', {}).S.boardParts.house('rocks.html');
  check(a.length === 8 && JSON.stringify(a) === JSON.stringify(b), 'an arcade game\'s house table is the same every time, on every device');
  check(a.every((r) => r.house && /^[A-Z]{3}$/.test(r.name)), 'three-letter cabinet initials, each row marked as the house\'s');
  check(a.every((r, i) => i === 0 || r.score < a[i - 1].score), 'highest first');
  check(JSON.stringify(a) !== JSON.stringify(page('muncher.html', '', {}).S.boardParts.house('muncher.html')), 'each game has its own');
  check(page('sudoku.html', '', {}).S.boardParts.house('sudoku.html').length === 0, 'a game with no score board has none');
}

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all passed');
