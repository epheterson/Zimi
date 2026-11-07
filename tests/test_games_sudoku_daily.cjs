// Sudoku's daily is the Medium it asks for (every day, not most days), and the pad key that completes a digit pops by less than the
// gap to its neighbours, so a ring larger than the other keys is never what a player sees.
//
// Run: node tests/test_games_sudoku_daily.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};

const sb = {};
vm.createContext(sb);
['util.js', 'sudoku.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sb, { filename: f }));
const D = sb.SudokuEngine;
const dailySeed = (day) => {
  // the shell's own seed for a day, as a daily page works it out
  const shell = {};
  vm.createContext(shell);
  shell.location = { pathname: '/w/zimi_games/sudoku.html', search: '?daily=' + day, hash: '' };
  shell.document = { readyState: 'complete', body: { appendChild() {} }, head: { appendChild() {} }, createElement: () => ({}), documentElement: { setAttribute() {}, classList: { add() {}, remove() {} } }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], title: 'x' };
  shell.addEventListener = () => {};
  shell.matchMedia = () => ({ matches: false });
  shell.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  shell.URL = URL; shell.Date = Date; shell.console = console; shell.window = shell;
  ['util.js', 'shell.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), shell, { filename: f }));
  return shell.ZimiShell.dailySeed(day, 'sudoku.html');
};

let notMedium = [];
for (let i = 0; i < 60; i++) {
  const d = new Date(Date.UTC(2026, 10, 1 + i)), day = d.toISOString().slice(0, 10);
  const g = D.generate('medium', dailySeed(day));
  if (g.difficulty !== 'medium') notMedium.push(day + ':' + g.difficulty);
}
check(notMedium.length === 0, 'sixty days of dailies are all Medium (' + notMedium.join(',') + ')');
check(/ZimiShell\.daily \? 'medium'/.test(fs.readFileSync(path.join(dir, 'sudoku.js'), 'utf8')), 'a daily asks for Medium');

const css = fs.readFileSync(path.join(dir, 'sudoku.css'), 'utf8');
const pop = /@keyframes su-key-pop \{([^@]*?)\}\s*\n/.exec(css)[1], scales = (pop.match(/scale:\s*([\d.]+)/g) || []).map((s) => parseFloat(s.replace(/scale:\s*/, '')));
check(Math.max.apply(null, scales) <= 1.05, 'the key pop is at most 5% (' + scales.join(',') + '): its ring stays between its neighbours');

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('sudoku daily: all passed');
