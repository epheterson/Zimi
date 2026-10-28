// The one seeded generator: it gives exactly the numbers every game's own copy used to, so no deal changes,
// and no game carries a copy of its own any more.
//
// Run: node tests/test_games_rng.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(dir, 'util.js'), 'utf8'), sandbox, { filename: 'util.js' });
const R = sandbox.ZimiUtil;

let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};

// The implementation every game carried (23 byte-identical copies), kept here as the reference.
function reference(seed) { var a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const SEEDS = [];
for (let i = 0; i < 100; i++) SEEDS.push(i < 10 ? i : (i * 2654435761 + 12345) >>> 0);
SEEDS.push(4294967295, 2147483648, -1, 1.5e9);

let same = true, countedSame = true;
SEEDS.forEach(s => {
  const a = reference(s), b = R.mulberry32(s), c = R.counted(s);
  for (let k = 0; k < 200; k++) { const x = a(); if (b() !== x) same = false; if (c() !== x) countedSame = false; }
});
check(same, 'mulberry32 matches the reference over 100+ seeds x 200 draws');
check(countedSame, 'counted() is the same sequence');

const c = R.counted(77);
for (let k = 0; k < 30; k++) c();
const again = R.counted(c.seed, c.draws), next = [c(), c(), c()], resumed = [again(), again(), again()];
check(c.draws === 33 && again.draws === 33 && JSON.stringify(next) === JSON.stringify(resumed), 'counted(seed, draws) resumes exactly where it was');

const game = { turn: 2, dice: [1, 2, 3], rng: R.counted(5, 9) };
const snap = R.snapshot(game), back = R.restore(snap);
check(JSON.stringify(snap) === JSON.stringify({ turn: 2, dice: [1, 2, 3], rng: { seed: 5, draws: 9 } }), 'snapshot is plain JSON');
check(back.rng() === game.rng() && back.turn === 2, 'restore puts the generator back');
let threw = false; try { R.restore({ turn: 1 }); } catch (e) { threw = true; }
check(threw, 'a snapshot with no generator is refused');

// The small helpers give what each game's own copy gave.
check(R.clamp(5, 1, 3) === 3 && R.clamp(-5, 1, 3) === 1 && R.clamp(2, 1, 3) === 2 && R.clamp(1, 1, 3) === 1 && R.clamp(3, 1, 3) === 3, 'clamp holds a value between its bounds');
check(R.DAY_MS === 24 * 60 * 60 * 1000, 'DAY_MS is a day');
const oldKey = d => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
const oldDashed = d => d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
const days = [new Date(2026, 0, 1), new Date(2026, 9, 26), new Date(2027, 11, 31), new Date(2024, 1, 29), new Date()];
check(days.every(d => R.dayKey(d) === oldKey(d) && R.dayKey(d, '-') === oldDashed(d)), 'dayKey is YYYYMMDD, or YYYY-MM-DD with a dash, as before');
check(R.dayKey() === oldKey(new Date()) || R.dayKey() === oldKey(new Date(Date.now() - 1000)), 'dayKey is today by default');
const oldKeys = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', a: 'left', d: 'right', w: 'up', s: 'down' };
check(JSON.stringify(Object.entries(R.DIR_KEYS).sort()) === JSON.stringify(Object.entries(oldKeys).sort()), 'DIR_KEYS is the arrows and WASD');
check(Object.isFrozen(R.DIR_KEYS), 'DIR_KEYS is not edited in place');
const made = [];
const fake = { document: { createElement: tag => { const e = { tag, className: '', textContent: '' }; made.push(e); return e; } } };
vm.createContext(fake);
vm.runInContext(fs.readFileSync(path.join(dir, 'util.js'), 'utf8'), fake);
const e1 = fake.ZimiUtil.el('div', 'x', 'hi'), e2 = fake.ZimiUtil.el('span'), e3 = fake.ZimiUtil.el('b', '', 0);
check(e1.tag === 'div' && e1.className === 'x' && e1.textContent === 'hi' && e2.className === '' && e2.textContent === '' && e3.textContent === 0, 'el makes an element with a class and text, and 0 is text');

// No game carries a copy of its own.
const copies = fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'util.js' && fs.readFileSync(path.join(dir, f), 'utf8').includes('0x6D2B79F5'));
check(copies.length === 0, 'no other file implements the generator: ' + copies.join(', '));

process.exit(failures ? 1 : 0);
