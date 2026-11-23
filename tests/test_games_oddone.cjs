// Odd One Out and the pictures it plays with: the rules, with no DOM. Who is odd, the order, the options, the vote, the tie,
// the guess, the points, and that the pictures are real drawings.
//
// Run: node tests/test_games_oddone.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
function load(files) {
  const sandbox = {};
  vm.createContext(sandbox);
  ['util.js'].concat(files).forEach(f => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f }));
  return sandbox;
}
let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};

const sb = load(['pictures.js', 'oddone.js']);
const E = sb.OddOneOutEngine, sets = sb.ZimiPictures.sets;

// ── the pictures ────────────────────────────────────────────────────────────
{
  const keys = Object.keys(sets);
  check(keys.length >= 7 && keys.every(k => sets[k].pics.length >= E.GUESS_CHOICES), 'oddone: seven or more sets, each with enough pictures to offer a guess');
  const all = keys.flatMap(k => sets[k].pics);
  check(all.every(p => /^[A-Z][A-Za-z ]+$/.test(p[0]) && /^<(path|circle|ellipse|rect|g)/.test(p[1]) && (p[1].match(/</g) || []).length >= 1), 'oddone: every picture has a name and a drawing');
  const svg = p => p[1];
  check(new Set(all.map(svg)).size === all.length, 'oddone: no two pictures are the same drawing');
  check(new Set(all.map(p => p[0])).size === all.length, 'oddone: no two pictures share a name');
  check(all.every(p => !/(fill|stroke)="var\(/.test(p[1])) && all.every(p => !/<script|on[a-z]+=|href=/i.test(p[1])), 'oddone: the drawings are plain shapes with fixed colours');
}

// ── a round ─────────────────────────────────────────────────────────────────
{
  for (const n of [3, 4, 5, 6, 7, 8]) {
    const r = E.newRound(n, 'all', 40 + n);
    check(r.n === n && r.odd >= 0 && r.odd < n && r.order.slice().sort().join() === Array.from({ length: n }, (_, i) => i).join(), 'oddone: ' + n + ' players: one odd one, and everyone speaks once');
    check(r.options.length === E.GUESS_CHOICES && r.options.filter(o => o.cat === r.pic.cat && o.i === r.pic.i).length === 1 && r.options.every(o => o.cat === r.pic.cat), 'oddone: ' + n + ' players: the odd one chooses among six pictures of the same set, the real one among them');
  }
  check(E.newRound(2, 'all', 1).n === 3 && E.newRound(12, 'all', 1).n === 8, 'oddone: three to eight players');
  const a = E.newRound(5, 'food', 99), b = E.newRound(5, 'food', 99);
  check(JSON.stringify(a) === JSON.stringify(b), 'oddone: a seed deals the same round');
  check(E.newRound(5, 'food', 3).cat === 'food' && E.newRound(5, 'fun', 3).cat === 'fun', 'oddone: a chosen set deals only from it');
  const cats = new Set(); for (let s = 0; s < 80; s++) cats.add(E.newRound(4, 'all', s).cat);
  check(cats.size === E.categories().length, 'oddone: all sets come up when all are chosen');

  // Fair: everyone is odd about equally often; never the same player twice in a row with four or more.
  const times = Array(6).fill(0); let last = -1, repeats = 0;
  for (let s = 0; s < 1200; s++) { const r = E.newRound(6, 'all', 1000 + s, [], last); times[r.odd]++; if (r.odd === last) repeats++; last = r.odd; }
  check(Math.min(...times) > 140 && Math.max(...times) < 260, 'oddone: each of six players is odd about a sixth of the time (' + times.join(', ') + ')');
  check(repeats === 0, 'oddone: with four or more the same player is never odd twice running');

  // Pictures do not come round again until the rest have been.
  const recent = []; const seen = new Set(); let dup = false;
  const total = E.pool('animals').length;
  for (let s = 0; s < total; s++) { const r = E.newRound(4, 'animals', 7 + s, recent); const k = r.pic.i; if (seen.has(k)) dup = true; seen.add(k); recent.push(r.pic); }
  check(!dup && seen.size === total, 'oddone: no picture repeats until the whole set has been shown');
  check(E.newRound(4, 'animals', 1, E.pool('animals')).pic.cat === 'animals', 'oddone: with every picture recent it still deals one');
}

// ── the vote ────────────────────────────────────────────────────────────────
{
  const r = E.newRound(5, 'all', 5); r.odd = 2;
  check(!E.vote(r, 1, 1) && !E.vote(r, 1, 9) && !E.vote(r, 9, 1) && !E.vote(r, -1, 1), 'oddone: nobody votes for themselves or for someone who is not there');
  check(E.vote(r, 0, 2) && !E.vote(r, 0, 3), 'oddone: a vote is cast once');
  [[1, 2], [2, 3], [3, 2], [4, 2]].forEach(([v, t]) => E.vote(r, v, t));
  check(E.allVoted(r) && E.tally(r).join() === '0,0,4,1,0', 'oddone: the votes are counted');
  check(E.accused(r) === 2, 'oddone: the most votes is the accused');

  const t = E.newRound(4, 'all', 6); t.odd = 0;
  [[0, 1], [1, 0], [2, 1], [3, 0]].forEach(([v, x]) => E.vote(t, v, x));
  check(E.accused(t) === -1, 'oddone: a tie accuses no one');
}

// ── the end of a round and the points ───────────────────────────────────────
{
  const mk = (n, odd, votes) => { const r = E.newRound(n, 'fun', 11); r.odd = odd; votes.forEach((t, v) => E.vote(r, v, t)); return r; };
  let r = mk(4, 1, [1, 0, 1, 1]);
  let s = E.settle(r, null);
  check(s.caught && !s.oddWins && s.points.join() === '1,0,1,1', 'oddone: caught, and no right guess: every other player scores 1');
  s = E.settle(r, r.options.find(o => o.i !== r.pic.i));
  check(s.caught && s.guessed && !s.right && !s.oddWins, 'oddone: caught and guessing wrong still loses');
  s = E.settle(r, r.pic);
  check(s.right && s.oddWins && s.points.join() === '0,2,0,0', 'oddone: caught but naming the picture wins for the odd one, 2 points');
  r = mk(4, 1, [2, 0, 3, 2]);
  s = E.settle(r, null);
  check(!s.caught && s.oddWins && s.points.join() === '0,2,0,0' && s.accused === 2, 'oddone: the wrong player accused, the odd one wins');
  r = mk(4, 1, [1, 0, 1, 0]);
  s = E.settle(r, null);
  check(s.accused === -1 && !s.caught && s.oddWins, 'oddone: a tie, the odd one escapes');
  check(E.leaders([3, 5, 5, 1]).join() === '1,2' && E.leaders([0, 0, 0]).length === 3, 'oddone: the leaders share the top score');
}

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
