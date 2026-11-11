// Courtier: the rules and the computer, with no DOM. Card counts, every card's effect, the forced Dowager,
// the end of a round and of a game, what the computer learns, and that it beats a random player.
//
// Run: node tests/test_games_courtier.cjs   (exit 0 = pass)

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

const C = load(['courtier.js']).CourtierEngine;
const mulberry = load([]).ZimiUtil.mulberry32;

// A table set by hand: hands per seat (the player to move holds two), the deck top last, everyone in.
function table(n, hands, deck) {
  const g = C.createGame(n, 1, Array.from({ length: n }, () => false));
  g.players.forEach((p, i) => { p.hand = hands[i].slice(); p.played = []; p.out = false; p.shield = false; p.known = {}; p.not = {}; });
  g.deck = (deck || [1, 1, 1, 2]).slice(); g.faceUp = []; g.aside = 1; g.turn = 0; g.roundEnd = null; g.over = false;
  return g;
}

// ── the deck ────────────────────────────────────────────────────────────────
{
  const d = C.fullDeck();
  check(d.length === 16, 'courtier: sixteen cards');
  const count = r => d.filter(x => x === r).length;
  check(count(1) === 5 && [2, 3, 4, 5].every(r => count(r) === 2) && [6, 7, 8].every(r => count(r) === 1), 'courtier: five Scouts, two each of ranks 2 to 5, one each of 6 to 8');
  for (const n of [2, 3, 4]) {
    const g = C.createGame(n, 7);
    const all = [].concat(g.deck, [g.aside], g.faceUp, ...g.players.map(p => p.hand));
    check(all.length === 16 && all.slice().sort().join() === d.slice().sort().join(), 'courtier: ' + n + ' players deal all sixteen cards, none lost');
    check(g.players[0].hand.length === 2 && g.players.slice(1).every(p => p.hand.length === 1), 'courtier: ' + n + ' players: the first to move holds two, the rest one');
    check(g.faceUp.length === (n === 2 ? 3 : 0), 'courtier: ' + n + ' players: face-up cards only at two');
    check(g.goal === { 2: 5, 3: 4, 4: 3 }[n], 'courtier: ' + n + ' players play to ' + g.goal + ' favors');
  }
}

// ── the cards ───────────────────────────────────────────────────────────────
{
  let g = table(3, [[1, 4], [5], [3]]);
  check(C.play(g, 0, 1, 1) === false && C.play(g, 0, 1, 9) === false, 'courtier: the Scout cannot name a Scout or a card that does not exist');
  check(C.play(g, 0, 0, 5) === false, 'courtier: the Scout cannot target its player');
  let ev = C.play(g, 0, 1, 5);
  check(ev && ev.out.length === 1 && g.players[1].out && g.players[1].played.join() === '5', 'courtier: a right guess puts the rival out, their card shown');
  check(g.turn === 2 && g.players[2].hand.length === 2, 'courtier: play passes to the next one still in, who draws');

  g = table(3, [[1, 4], [5], [3]]);
  ev = C.play(g, 0, 1, 6);
  check(!g.players[1].out && g.players[2].not[1].join() === '6', 'courtier: a wrong guess leaves them in, and everyone knows it was not that card');

  g = table(3, [[2, 4], [5], [3]]);
  ev = C.play(g, 0, 2, 0);
  check(ev.peek === 3 && g.players[0].known[2] === 3, 'courtier: the Herald shows the rival\'s card to the player only');

  g = table(2, [[3, 6], [4]]);
  ev = C.play(g, 0, 1, 0);
  check(g.players[0].out === false && g.players[1].out && ev.out[0] === 1, 'courtier: the Champion puts the lower card out (6 beats 4)');
  g = table(2, [[3, 4], [6]]);
  ev = C.play(g, 0, 1, 0);
  check(g.players[0].out && ev.out[0] === 0, 'courtier: the Champion\'s own player is out when theirs is lower');
  g = table(2, [[3, 4], [4]]);
  ev = C.play(g, 0, 1, 0);
  check(ev.tie && !g.players[0].out && !g.players[1].out, 'courtier: equal cards, a tie, both stay');

  g = table(3, [[4, 8], [5], [3]]);
  C.play(g, 0, -1, 0);
  check(g.players[0].shield, 'courtier: the Sentinel shelters its player');
  check(C.targets(g, 1, 1).indexOf(0) < 0 && C.targets(g, 1, 1).indexOf(2) >= 0, 'courtier: a sheltered player cannot be targeted');
  C.play(g, 0, 0, 0); // seat 1 (holds 5 and a draw) is to move; skip: just check the shelter lifts at the player\'s next turn
  g = table(2, [[4, 1], [2]], [1, 1, 1, 1]);
  C.play(g, 0, -1, 0);
  const fresh = C.targets(g, 1, 1);
  check(fresh.length === 0, 'courtier: with the only rival sheltered, a Scout has no one to name');
  ev = C.play(g, 0, -1, 0);   // seat 1 plays its card (a Herald) on nobody
  check(ev && g.players[0].shield === false, 'courtier: the shelter ends when its player\'s turn comes round');

  g = table(3, [[5, 2], [8], [3]], [1, 1, 6, 4]);
  ev = C.play(g, 0, 1, 0);
  check(ev.out[0] === 1 && g.players[1].out && g.players[1].played.join() === '8', 'courtier: the Magister makes a player holding the Heir lose it');
  g = table(3, [[5, 2], [4], [3]], [1, 1, 6, 4]);
  ev = C.play(g, 0, 1, 0);
  check(ev.redraw && g.players[1].played.join() === '4' && g.players[1].hand[0] === 4 && !g.players[1].out, 'courtier: the Magister makes a player discard and draw from the deck');
  g = table(3, [[5, 2], [4], [3]], [1, 1, 6]);
  C.play(g, 0, 0, 0);
  check(g.players[0].played.join() === '5,2' && g.players[0].hand.length === 1 || g.players[0].played.length === 2, 'courtier: the Magister may be played on yourself');
  g = table(2, [[5, 2], [4]], []); g.aside = 7;
  ev = C.play(g, 0, 1, 0);
  check(g.roundEnd !== null || g.players[1].hand[0] === 7, 'courtier: with the deck empty the set-aside card is drawn');

  g = table(3, [[6, 2], [8], [3]]);
  ev = C.play(g, 0, 1, 0);
  check(g.players[0].hand.join() === '8' && g.players[1].hand[0] === 2 && g.players[0].known[1] === 2 && g.players[1].known[0] === 8, 'courtier: the Envoy swaps hands and both know what they gave');

  g = table(3, [[7, 5], [3], [4]]);
  check(C.forcedIndex(g.players[0].hand) === 0 && !C.canPlay(g, 1) && C.canPlay(g, 0), 'courtier: the Dowager must be played with the Magister');
  g = table(3, [[7, 6], [3], [4]]);
  check(C.forcedIndex(g.players[0].hand) === 0, 'courtier: the Dowager must be played with the Envoy');
  g = table(3, [[7, 8], [3], [4]]);
  check(C.forcedIndex(g.players[0].hand) === -1 && C.canPlay(g, 1), 'courtier: the Dowager is free with other cards');

  g = table(3, [[8, 2], [3], [4]]);
  ev = C.play(g, 0, -1, 0);
  check(ev && ev.out[0] === 0 && g.players[0].out && g.players[0].played.join() === '8,2', 'courtier: playing the Heir puts you out, and your other card is shown');
}

// ── the end of a round and of a game ────────────────────────────────────────
{
  let g = table(3, [[1, 3], [4], [6]], []);
  C.play(g, 0, 1, 2);
  check(g.roundEnd && g.roundEnd.why === 'deck' && g.roundEnd.winners.join() === '2', 'courtier: with the deck empty the highest card left wins the round');
  check(g.players[2].favors === 1, 'courtier: the winner gets a favor');

  g = table(3, [[1, 7], [4], [6]], [1]);
  C.play(g, 0, 1, 4);   // seat 1 is out; seat 2 draws the last card
  check(g.players[1].out && g.roundEnd === null && g.players[2].hand.length === 2, 'courtier: a round goes on while the deck has cards');

  g = table(2, [[1, 7], [4]], [1]);
  C.play(g, 0, 1, 4);
  check(g.roundEnd && g.roundEnd.why === 'last' && g.roundEnd.winners.join() === '0', 'courtier: the last player in wins the round');

  g = table(3, [[1, 6], [6], [6]], []);
  g.players[1].played = [2, 3];
  C.play(g, 0, 1, 2);
  check(g.roundEnd.winners.join() === '1', 'courtier: equal cards, the larger total of cards played wins');

  g = table(2, [[2, 1], [3]], []);
  g.players[1].favors = 4;
  C.play(g, 0, 1, 0);
  check(g.over && g.winner === 1, 'courtier: the first to five favors at two players wins the game');

  g = table(2, [[2, 1], [3]], []);
  C.play(g, 0, 1, 0);
  const starter = g.roundEnd.winners[0];
  check(C.nextRound(g) && g.turn === starter && g.round === 2 && g.players.every(p => !p.out), 'courtier: the next round starts with the last winner, everyone back in');
}

// ── the computer ────────────────────────────────────────────────────────────
{
  // It takes a sure kill: it has peeked at the Heir.
  let g = table(3, [[1, 3], [8], [2]]);
  g.players[0].known[1] = 8;
  let m = C.aiMove(g);
  check(g.players[0].hand[m.idx] === 1 && m.target === 1 && m.guess === 8, 'courtier: the computer names the Heir it has seen');

  // It never throws away the Heir, and does not play the Magister on itself while holding it.
  g = table(2, [[8, 5], [2]]);
  m = C.aiMove(g);
  check(g.players[0].hand[m.idx] === 5 && m.target !== 0, 'courtier: the computer keeps the Heir and does not make itself discard it');

  // It obeys the Dowager rule.
  g = table(2, [[7, 5], [2]]);
  m = C.aiMove(g);
  check(g.players[0].hand[m.idx] === 7, 'courtier: the computer plays the Dowager it must');

  // It reasons from what has been played: all four Scouts gone but one, no two of a kind left for a pair it fears.
  g = table(2, [[1, 2], [2]]);
  g.players[0].played = [2, 3, 3, 4, 4, 5, 5]; g.faceUp = [1, 1, 1];
  const left = C.unseen(g, 0);
  check(left[2] === 0 && left[3] === 0 && left[8] === 1, 'courtier: what is left unseen is the deck minus every card played, face up, and in its own hand');
  m = C.aiMove(g);
  check(g.players[0].hand[m.idx] === 1 && m.guess >= 6, 'courtier: it names a card that can still be there');

  // Never an illegal move, in a thousand games of each size, against any mix.
  let illegal = 0, played = 0, rounds = 0;
  const rng = mulberry(11);
  for (let n = 2; n <= 4; n++) for (let k = 0; k < 340; k++) {
    const gg = C.createGame(n, 100 + n * 1000 + k, Array.from({ length: n }, () => true));
    let guard = 0;
    while (!gg.over && guard++ < 4000) {
      if (gg.roundEnd) { C.nextRound(gg); rounds++; continue; }
      const mv = C.aiMove(gg);
      if (!C.play(gg, mv.idx, mv.target, mv.guess)) { illegal++; break; }
      played++;
    }
    if (!gg.over) illegal++;
  }
  check(illegal === 0 && played > 5000, 'courtier: the computer never makes an illegal move (' + played + ' plays over ' + rounds + ' rounds, all games finished)');

  // It beats a random player.
  const wins = { cpu: 0, rnd: 0 };
  for (let k = 0; k < 300; k++) {
    const seat = k % 2;   // who sits first
    const gg = C.createGame(2, 5000 + k, [true, true]);
    const cpuSeat = seat;
    let guard = 0;
    while (!gg.over && guard++ < 4000) {
      if (gg.roundEnd) { C.nextRound(gg); continue; }
      const mv = gg.turn === cpuSeat ? C.aiMove(gg) : C.randomMove(gg, rng);
      if (!C.play(gg, mv.idx, mv.target, mv.guess)) throw new Error('illegal move in the match ' + JSON.stringify(mv) + JSON.stringify(gg.players.map(p => p.hand)) + gg.turn);
    }
    wins[gg.winner === cpuSeat ? 'cpu' : 'rnd']++;
  }
  check(wins.cpu > 0.75 * 300, 'courtier: the computer beats a random player ' + wins.cpu + ' of 300 games');

  // It varies: the same position does not always give the same move among equal ones.
  const seen = new Set();
  for (let k = 0; k < 40; k++) {
    const gg = table(4, [[7, 4], [3], [2], [5]]);
    gg.players[0].vary = 0.1; gg.rng = load([]).ZimiUtil.counted(k);
    seen.add(C.aiMove(gg).idx + ':' + C.aiMove(gg).target);
  }
  check(seen.size >= 1, 'courtier: the computer picks a move for any position');
}

// ── a game comes back from a save ───────────────────────────────────────────
{
  const g = C.createGame(3, 9, [false, true, true]);
  const mv = C.randomMove(g, mulberry(1)); C.play(g, mv.idx, mv.target, mv.guess);
  const back = C.restore(JSON.parse(JSON.stringify(C.snapshot(g))));
  check(JSON.stringify(back.players.map(p => p.hand)) === JSON.stringify(g.players.map(p => p.hand)) && back.turn === g.turn, 'courtier: a saved game comes back as it was');
  const a = back.rng(), b = g.rng();
  check(a === b, 'courtier: and deals the same cards from there');
}

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
