// ZimiGames' national-deck card games (Koi-Koi, Truco, Belote, Skat, Teen
// Patti): the rules as pure functions on plain states. Yaku scoring, envido
// and trick comparison, belote scoring, skat game values, hand ranking, and
// whole games played by the computer players with every play checked legal
// and every card accounted for. No DOM: the game files run their page wiring
// only when a #zc-table exists.
//
// Run: node tests/test_games_cards3.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
let failures = 0, passed = 0;
const check = (ok, label) => {
  if (ok) { passed++; console.log('ok: ' + label); } else { console.error('FAIL: ' + label); failures++; }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const sandbox = {
  console, Date, setTimeout, clearTimeout, setInterval, clearInterval,
  document: { addEventListener() {}, querySelector: () => null, getElementById: () => null, documentElement: { classList: { toggle() {} } }, hidden: false }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['text.js', 'cardbacks.js', 'courts.js', 'courts-es.js', 'hanafuda-art.js', 'cards.js', 'cardtable.js', 'koikoi.js', 'truco.js', 'belote.js', 'skat.js', 'teenpatti.js']) {
  if (!fs.existsSync(path.join(dir, f))) continue;
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
}
const Z = sandbox.ZimiCards;
const lcg = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const orderOf = (seed, n) => Z.shuffled(lcg(seed)).filter(c => c < n);
const sorted = a => a.slice().sort((x, y) => x - y);

// ── The decks ───────────────────────────────────────────────────────────────
{
  const kinds = {};
  for (let i = 0; i < 48; i++) { const c = Z.hanafudaCard(i); kinds[c.kind] = (kinds[c.kind] || 0) + 1; }
  check(kinds.bright === 5 && kinds.animal === 9 && kinds.ribbon === 10 && kinds.chaff === 24, 'the Hanafuda deck: 5 brights, 9 animals, 10 ribbons, 24 chaff');
  check(Z.hanafudaCard(40).name === 'rain man' && Z.hanafudaCard(40).kind === 'bright' && Z.hanafudaCard(1).ribbon === 'poetry' && Z.hanafudaCard(32).sake === true, 'ids are month * 4 + k: the rain man is November’s first card, the sake cup September’s');
  let ok = true;
  for (let i = 0; i < 48; i++) { const s = Z.hanafudaFaceMarkup(i, true); if (!s.startsWith('<svg') || !s.endsWith('</svg>')) ok = false; }
  for (let i = 0; i < 40; i++) { const s = Z.spanishFaceMarkup(i, true); if (!s.startsWith('<svg') || !s.endsWith('</svg>')) ok = false; }
  check(ok, 'every Hanafuda and Spanish face is a complete svg');
  check(Z.spanishName(2) === '3 of coins' && Z.spanishName(39) === 'king of clubs', 'Spanish names');
}

// ── Koi-Koi ─────────────────────────────────────────────────────────────────
{
  const K = sandbox.ZimiKoiKoi;
  // Card ids by month * 4 + k.
  const CRANE = 0, POETRY1 = 1, WARBLER = 4, CURTAIN = 8, MOON = 28, RAIN = 40, PHOENIX = 44, BOAR = 24, DEER = 36, BUTTERFLIES = 20, SAKE = 32;
  const keys = ids => K.yakuOf(ids).map(y => y.key + ':' + y.pts).join(',');
  check(keys([CRANE, CURTAIN, MOON]) === 'sanko:5', 'three brights without the rain man: 5');
  check(keys([CRANE, CURTAIN, MOON, RAIN]) === 'ame:7', 'four brights with the rain man (rainy): 7');
  check(keys([CRANE, CURTAIN, MOON, PHOENIX]) === 'shiko:8', 'four brights without the rain man: 8');
  check(keys([CRANE, CURTAIN, MOON, PHOENIX, RAIN]) === 'goko:10', 'five brights: 10');
  check(keys([CRANE, CURTAIN, RAIN]) === '', 'three brights including the rain man: nothing');
  check(keys([BOAR, DEER, BUTTERFLIES]) === 'ino:5', 'boar, deer and butterfly: 5');
  check(keys([BOAR, DEER, BUTTERFLIES, WARBLER]) === 'ino:6', 'a fourth animal adds 1 to boar-deer-butterfly');
  check(keys([BOAR, DEER, BUTTERFLIES, WARBLER, 12]) === 'ino:7,tane:1', 'five animals also score Animals: 1');
  check(keys([1, 5, 9]) === 'akatan:5', 'the three poetry ribbons: 5');
  check(keys([21, 33, 37]) === 'aotan:5', 'the three blue ribbons: 5');
  check(keys([1, 5, 9, 21, 33, 37]) === 'akatan:5,aotan:5,tan:2', 'poetry and blue together, six ribbons');
  check(keys([1, 5, 9, 13, 17]) === 'akatan:5,tan:1', 'five ribbons: 1, plus poetry 5');
  const chaff = [2, 3, 6, 7, 10, 11, 14, 15, 18, 19];
  check(keys(chaff) === 'kasu:1' && keys(chaff.concat([22])) === 'kasu:2', 'ten chaff: 1, each extra +1');
  check(keys(chaff.slice(0, 9).concat([SAKE])) === 'kasu:1', 'the sake cup counts as chaff');
  check(keys([MOON, SAKE]) === 'tsuki:5' && keys([CURTAIN, SAKE]) === 'hanami:5', 'moon viewing and flower viewing');
  check(keys([MOON, CURTAIN, CRANE, SAKE]) === 'sanko:5,tsuki:5,hanami:5', 'viewing sets score on top of the brights');
  // Seen yaku: only a new or bigger one is offered again.
  check(K.isNewYaku(K.yakuOf([1, 5, 9]), {}) && !K.isNewYaku(K.yakuOf([1, 5, 9]), { akatan: 5 }) && K.isNewYaku(K.yakuOf([1, 5, 9, 13, 17]), { akatan: 5 }), 'a yaku is offered once, again when it grows');
  check(K.multiplier(5, false) === 1 && K.multiplier(7, false) === 2 && K.multiplier(3, true) === 2 && K.multiplier(8, true) === 4, 'doubling at 7 and after the other side’s koi-koi');
  // Table rules.
  check(same(K.takes([8, 12], 0), []) && same(K.takes([2, 8], 3), [2]) && same(K.takes([0, 1, 2], 3), [0, 1, 2]) && K.takes([0, 1], 2) === null && same(K.takes([0, 1], 2, 1), [1]), 'matching: none stays, one takes, two need a choice, three take all');
  // Hands, a month and a whole game.
  const st = K.newGame(orderOf(5, 48), 6, 0);
  check(st.hands[0].length === 8 && st.hands[1].length === 8 && st.table.length === 8 && st.deck.length === 24 && sorted(st.hands[0].concat(st.hands[1], st.table, st.deck)).join() === [...Array(48).keys()].join(), 'a deal: 8, 8, 8 and 24 left, every card once');
  let bad = 0, games = 0, monthsPlayed = 0, scoring = 0, koiCalls = 0;
  for (let seed = 1; seed <= 60; seed++) {
    let s = K.newGame(orderOf(seed, 48), seed % 2 ? 6 : 12, seed % 2), guard = 0;
    while (s.phase !== 'over' && guard++ < 4000) {
      const total = s.deck.length + s.hands[0].length + s.hands[1].length + s.table.length + s.captured[0].length + s.captured[1].length;
      if (total !== 48) bad++;
      if (s.phase === 'monthEnd') { monthsPlayed++; if (s.result.winner >= 0) scoring++; s = K.nextMonth(s, orderOf(seed * 100 + s.month, 48)); continue; }
      const seat = s.turn, before = s.moves;
      if (s.phase === 'koi') { const k = K.aiKoi(s, seat); if (k) koiCalls++; s = K.decide(s, seat, k); }
      else if (s.step === 'hand') { const mv = K.aiHand(s, seat); if (!K.isLegal(s, seat, mv.id, mv.target)) { bad++; break; } s = K.playHand(s, seat, mv.id, mv.target); }
      else { const tg = K.aiTarget(s, seat); if (!K.canDraw(s, seat, tg)) { bad++; break; } s = K.draw(s, seat, tg); }
      if (s.moves === before) { bad++; break; }
    }
    if (s.phase !== 'over') bad++; else games++;
  }
  check(bad === 0 && games === 60, 'sixty computer-vs-computer games finish, every card accounted for, every play legal');
  check(scoring > 20 && koiCalls > 0, 'months are scored (' + scoring + ' of ' + monthsPlayed + ') and the computer sometimes calls koi-koi (' + koiCalls + ')');
}

// ── Truco ───────────────────────────────────────────────────────────────────
{
  const TR = sandbox.ZimiTruco;
  // Spanish ids: suit * 10 + k, suits oros 0, copas 1, espadas 2, bastos 3; k 0..9 = 1..7, sota, caballo, rey.
  const C = (rank, suit) => suit * 10 + [1, 2, 3, 4, 5, 6, 7, 10, 11, 12].indexOf(rank);
  const [OROS, COPAS, ESPADAS, BASTOS] = [0, 1, 2, 3];
  const order = [C(1, ESPADAS), C(1, BASTOS), C(7, ESPADAS), C(7, OROS), C(3, COPAS), C(2, OROS), C(1, COPAS), C(1, OROS), C(12, ESPADAS), C(11, COPAS), C(10, BASTOS), C(7, COPAS), C(7, BASTOS), C(6, OROS), C(5, OROS), C(4, OROS)];
  let ok = true;
  for (let i = 0; i + 1 < order.length; i++) { const a = TR.power(order[i]), b = TR.power(order[i + 1]); if (!(a >= b)) ok = false; }
  check(ok && TR.power(C(1, ESPADAS)) > TR.power(C(1, BASTOS)) && TR.power(C(1, BASTOS)) > TR.power(C(7, ESPADAS)) && TR.power(C(7, OROS)) > TR.power(C(3, COPAS)), 'the truco order: macho, ace of bastos, 7 espadas, 7 oros, the threes...');
  check(TR.power(C(3, OROS)) === TR.power(C(3, BASTOS)) && TR.power(C(1, COPAS)) === TR.power(C(1, OROS)) && TR.power(C(1, COPAS)) < TR.power(C(2, COPAS)) && TR.power(C(7, COPAS)) < TR.power(C(10, OROS)) && TR.power(C(7, COPAS)) > TR.power(C(6, OROS)), 'equal cards tie: the threes, the false aces; the other sevens sit under the figures');
  // Envido: 20 + two cards of a suit (figures 0); otherwise the best single card.
  check(TR.envidoPoints([C(7, ESPADAS), C(6, ESPADAS), C(1, OROS)]) === 33, 'envido: 7 and 6 of a suit make 33');
  check(TR.envidoPoints([C(12, OROS), C(11, OROS), C(4, COPAS)]) === 20 && TR.envidoPoints([C(12, OROS), C(5, OROS), C(4, COPAS)]) === 25, 'envido: figures count 0');
  check(TR.envidoPoints([C(7, OROS), C(6, COPAS), C(5, BASTOS)]) === 7 && TR.envidoPoints([C(12, OROS), C(11, COPAS), C(10, BASTOS)]) === 0, 'envido: no pair is the best card, figures 0');
  check(TR.envidoPoints([C(7, ESPADAS), C(6, ESPADAS), C(5, ESPADAS)]) === 33, 'envido with three of a suit uses the best two');
  // Hand winner from the trick results.
  const w = (a, b, c, mano = 0) => TR.handWinner([a, b, c].filter(x => x !== undefined).map(x => ({ winner: x })), mano);
  check(w(0, 0) === 0 && w(1, 1) === 1 && w(0, 1) === -1, 'two tricks win; a split goes to a third');
  check(w(-1, 1) === 1 && w(0, -1) === 0 && w(-1, -1) === -1, 'a tied first trick goes to the second’s winner, a tied second to the first’s');
  check(w(0, 1, 1) === 1 && w(0, 1, -1, 0) === 0 && w(0, 1, -1, 1) === 1 && w(-1, -1, -1, 1) === 1 && w(-1, -1, 0) === 0, 'the third trick decides; a tie there is mano’s');
  // A hand played through: a fixed deal.
  const deal = [C(1, ESPADAS), C(4, COPAS), C(12, OROS), C(3, OROS), C(2, COPAS), C(5, BASTOS), ...Array(34).fill(0)];
  let s = TR.dealHand(deal, 0, [0, 0], 0, 15, false);
  check(s.turn === 0 && TR.actions(s, 0).some(a => a.type === 'envido') && !TR.actions(s, 1).length, 'mano acts first and may call envido; North waits');
  s = TR.act(s, 0, 'play', C(12, OROS));
  s = TR.act(s, 1, 'play', C(3, OROS));
  check(s.done.length === 1 && s.done[0].winner === 1 && s.turn === 1, 'the three beats the king; the winner leads');
  // Envido, accepted: 2 points to the higher; the hand's own points follow.
  let e = TR.dealHand([C(7, ESPADAS), C(6, ESPADAS), C(1, OROS), C(7, COPAS), C(12, COPAS), C(4, BASTOS), ...Array(34).fill(0)], 0, [0, 0], 0, 15, false);
  e = TR.act(e, 0, 'envido'); check(e.ask === 1 && TR.actions(e, 1).some(a => a.type === 'real') && !TR.actions(e, 0).length, 'envido is a call North must answer');
  e = TR.act(e, 1, 'quiero');
  check(e.scores[0] === 2 && e.scores[1] === 0 && e.envido.points[0] === 33 && e.envido.points[1] === 27 && !e.call, 'envido accepted: 33 beats 27, 2 points');
  check(!TR.actions(e, 0).some(a => a.type === 'envido'), 'envido is called once per hand');
  let r = TR.dealHand([C(4, ESPADAS), C(5, OROS), C(6, BASTOS), C(7, OROS), C(7, COPAS), C(4, BASTOS), ...Array(34).fill(0)], 0, [0, 0], 0, 15, false);
  r = TR.act(r, 0, 'envido'); r = TR.act(r, 1, 'envido');
  check(r.call.chain.join() === 'envido,envido' && r.ask === 0, 'envido, envido');
  r = TR.act(r, 0, 'noquiero');
  check(r.scores[1] === 2 && r.scores[0] === 0, 'refusing the second envido gives the caller the first: 2');
  let q = TR.dealHand([C(4, ESPADAS), C(5, OROS), C(6, BASTOS), C(7, OROS), C(7, COPAS), C(4, BASTOS), ...Array(34).fill(0)], 0, [3, 9], 0, 15, false);
  q = TR.act(q, 0, 'falta'); check(TR.faltaPoints(q) === 6, 'falta envido is what the leader still needs (15 - 9)');
  q = TR.act(q, 1, 'quiero'); check(q.scores[1] + q.scores[0] === 3 + 9 + 6, 'falta envido accepted: 6 points to the winner');
  let f = TR.dealHand(deal, 0, [0, 0], 0, 15, false); f = TR.act(f, 0, 'falta'); f = TR.act(f, 1, 'noquiero');
  check(f.scores[0] === 1, 'falta envido refused alone: 1 point');
  // Truco: accepted, raised, refused.
  let u = TR.dealHand(deal, 0, [0, 0], 0, 15, false);
  u = TR.act(u, 0, 'truco'); check(u.call.level === 1 && u.ask === 1 && TR.actions(u, 1).some(a => a.type === 'truco') && TR.actions(u, 1).some(a => a.type === 'envido'), 'truco: North may accept, refuse, raise or call envido first');
  u = TR.act(u, 1, 'quiero'); check(TR.stake(u) === 2 && u.truco.owner === 1 && !TR.actions(u, 0).some(a => a.type === 'truco') && TR.actions(u, 1).length === 0, 'accepted truco is worth 2; only North may raise');
  u = TR.act(u, 0, 'play', C(1, ESPADAS)); check(TR.actions(u, 1).some(a => a.type === 'truco'), 'North may call retruco on its turn');
  u = TR.act(u, 1, 'truco'); u = TR.act(u, 0, 'truco');
  check(u.call.level === 3 && u.truco.level === 2 && TR.stake(u) === 3, 'retruco then vale cuatro raises');
  u = TR.act(u, 1, 'noquiero'); check(u.phase === 'handEnd' && u.scores[0] === 3 && u.result.reason === 'refused', 'refusing vale cuatro gives the caller 3 (retruco’s value)');
  let v = TR.dealHand(deal, 0, [0, 0], 0, 15, false); v = TR.act(v, 0, 'truco'); v = TR.act(v, 1, 'noquiero');
  check(v.scores[0] === 1 && v.phase === 'handEnd', 'refusing truco gives 1');
  let m = TR.dealHand(deal, 0, [0, 0], 0, 15, false); m = TR.act(m, 0, 'truco'); m = TR.act(m, 1, 'quiero'); m = TR.act(m, 0, 'mazo');
  check(m.scores[1] === 2, 'folding after an accepted truco gives the other 2');
  // Envido under a pending truco comes first, then the truco is asked again.
  let x = TR.dealHand(deal, 0, [0, 0], 0, 15, false); x = TR.act(x, 0, 'truco'); x = TR.act(x, 1, 'envido');
  check(x.call.kind === 'envido' && x.hold.kind === 'truco' && x.ask === 0, 'envido answers a truco and goes first');
  x = TR.act(x, 0, 'quiero');
  check(x.call.kind === 'truco' && x.ask === 1 && x.envido.done, 'then the truco question comes back');
  // Flor.
  const florDeal = [C(1, OROS), C(4, OROS), C(7, OROS), C(1, COPAS), C(2, COPAS), C(3, BASTOS), ...Array(34).fill(0)];
  const fl = TR.dealHand(florDeal, 0, [0, 0], 0, 15, true);
  check(fl.scores[0] === 3 && fl.scores[1] === 0 && !TR.actions(fl, 0).some(a => a.type === 'envido') && TR.dealHand(florDeal, 0, [0, 0], 0, 15, false).scores[0] === 0, 'flor (when on) scores 3 and stops envido; off by default');
  // Whole games between two computer players.
  const rng = lcg(42), rnd = () => rng();
  let games = 0, bad = 0, refused = 0, envidos = 0, hands = 0;
  for (let seed = 1; seed <= 80; seed++) {
    let g = TR.newGame(orderOf(seed, 40), seed % 2 ? 15 : 30, seed % 2, seed % 5 === 0), guard = 0;
    while (g.phase !== 'over' && guard++ < 6000) {
      if (g.phase === 'handEnd') { hands++; if (g.result.reason === 'refused') refused++; if (g.envido.done) envidos++; g = TR.nextHand(g, orderOf(seed * 1000 + g.handNo, 40)); continue; }
      const seat = g.call ? g.ask : g.turn, a = TR.aiAct(g, seat, rnd), before = g.moves;
      if (!TR.isLegal(g, seat, a.type, a.id)) { bad++; break; }
      g = TR.act(g, seat, a.type, a.id);
      if (g.moves === before) { bad++; break; }
    }
    if (g.phase === 'over') games++;
  }
  check(bad === 0 && games === 80, 'eighty computer-vs-computer games to 15 and 30 finish, every action legal');
  check(refused > 20 && envidos > 20, 'the computer calls and answers truco and envido (refused ' + refused + ', envido ' + envidos + ' in ' + hands + ' hands)');
}


// ── Belote ──────────────────────────────────────────────────────────────────
{
  const B = sandbox.ZimiBelote;
  const RK = { A: 1, T: 10, J: 11, Q: 12, K: 13 }, SUi = 'CDHS';
  const id = s => Z.make(RK[s[0]] || +s[0], SUi.indexOf(s[1]));
  const ids = str => str.split(' ').map(id);
  const HEARTS = 2, SPADES = 3;
  check(B.points(id('JH'), HEARTS) === 20 && B.points(id('9H'), HEARTS) === 14 && B.points(id('JS'), HEARTS) === 2 && B.points(id('9S'), HEARTS) === 0, 'jack 20 and nine 14 as trump; jack 2 and nine 0 otherwise');
  const total = B.DECK.reduce((n, c) => n + B.points(c, HEARTS), 0);
  check(B.DECK.length === 32 && total === 152, 'the 32 cards are worth 152 with the dix de der making 162');
  check(B.power(id('JH'), HEARTS) > B.power(id('9H'), HEARTS) && B.power(id('9H'), HEARTS) > B.power(id('AH'), HEARTS) && B.power(id('AH'), HEARTS) > B.power(id('AS'), HEARTS) && B.power(id('TS'), HEARTS) > B.power(id('KS'), HEARTS) && B.power(id('KS'), HEARTS) > B.power(id('JS'), HEARTS), 'trump order J 9 A 10 K Q; plain A 10 K Q J');
  // A hand in play, for the obligations: trump hearts.
  const mk = (hands, trick, trump = HEARTS, turn = 0) => ({ phase: 'play', hands: hands.map(h => ids(h)), trick: trick.map(([seat, c]) => ({ seat, id: id(c) })), trump, turn });
  const legal = (st, seat) => B.legalPlays(st, seat).map(c => c).sort((a, b) => a - b).join();
  const set = str => ids(str).sort((a, b) => a - b).join();
  let st = mk([ '7S 8S 7C KH', 'x', 'x', 'x' ].map(h => h === 'x' ? '7D' : h), [[3, 'AS']]);
  check(legal(st, 0) === set('7S 8S'), 'follow suit');
  st = mk(['7C 8C KH 7H', '7D', '7D', '7D'], [[3, 'AS']]);
  check(legal(st, 0) === set('KH 7H'), 'void in the suit led: you must trump');
  st = mk(['7C 8C KH 7H', '7D', '7D', '7D'], [[3, 'AS'], [1, 'QH']]);
  // the highest trump so far is the queen: the king beats it, the seven does not
  check(legal(st, 0) === set('KH'), 'you must over-trump when you can');
  st = mk(['7C 8C 7H 8H', '7D', '7D', '7D'], [[3, 'AS'], [1, 'QH']]);
  check(legal(st, 0) === set('7H 8H'), 'if you cannot over-trump you still play a trump');
  st = mk(['7C 8C KH 7H', '7D', '7D', '7D'], [[2, 'AS'], [3, '7S']].map(([s, c]) => [s, c]), HEARTS, 0);
  st.trick = [{ seat: 2, id: id('AS') }, { seat: 3, id: id('7S') }]; // partner (north, seat 2) is winning
  check(legal(st, 0) === set('7C 8C KH 7H'), 'with your partner winning you may play anything');
  st = mk(['7C 8C KH 7H JH', '7D', '7D', '7D'], [[3, 'QH']]);
  check(legal(st, 0) === set('KH JH'), 'when trump is led, play higher if you can');
  st = mk(['7C 8C KS', '7D', '7D', '7D'], [[3, 'QH']]);
  check(legal(st, 0) === set('7C 8C KS'), 'trump led and you have none: anything');
  // Scoring a finished hand: takers (seat 0) with the cards in `won`.
  const hand = (won0, won1, tricks, extra = {}) => Object.assign({ trump: HEARTS, taker: 0, won: [ids(won0), ids(won1), [], []], tricksWon: tricks, belote: { seat: -1, shown: 0 }, lastWinner: 0 }, extra);
  let sc = B.scoreHand(Object.assign(hand('', '', [8, 0]), { won: [B.DECK.slice(), [], [], []] }));
  check(sc.capot === 0 && sc.add[0] === 252 && sc.made, 'capot is worth 252');
  sc = B.scoreHand(Object.assign(hand('', '', [8, 0]), { won: [B.DECK.slice(), [], [], []], belote: { seat: 2, shown: 2 } }));
  check(sc.add[0] === 272 && sc.belote === 0, 'capot plus belote: 272');
  // 82 needed: takers hold JH 9H (34) + AS AD AC (33) + TS TD TC (30) = 97, plus dix de der.
  sc = B.scoreHand(hand('JH 9H AS AD AC TS TD TC', 'KS KD KC QS QD QC AH TH KH QH', [5, 3]));
  check(sc.pts[0] === 97 + 10 && sc.pts[1] === 49 && sc.made && sc.add[0] === sc.pts[0] && sc.add[1] === sc.pts[1], 'a made contract: each side scores its own points (' + sc.pts + ')');
  sc = B.scoreHand(hand('JH AS', 'JS JD JC 9H AH TH', [1, 7], { lastWinner: 1 }));
  check(!sc.made && sc.add[0] === 0 && sc.add[1] === 162, 'failed takers: the others score 162');
  sc = B.scoreHand(Object.assign(hand('JH AS', 'JS JD JC 9H AH TH', [4, 4], { lastWinner: 1 }), { belote: { seat: 0, shown: 2 } }));
  check(sc.belote === 0 && sc.add[0] === 20 && sc.add[1] === 162, 'failed takers keep their belote: 20, the others 162');
  sc = B.scoreHand(Object.assign(hand('JH 9H AS AD AC TS TD', 'KS KD KC QS QD QC AH TH KH QH TC', [4, 4], { lastWinner: 1 }), { belote: { seat: 1, shown: 2 } }));
  check(sc.totals[0] === 34 + 33 + 20 && sc.belote === 1 && sc.totals[1] === sc.pts[1] + 20, 'belote counts toward its side’s total');
  check(B.gameWinner([510, 400], 501) === 0 && B.gameWinner([300, 400], 501) === -1 && B.gameWinner([520, 530], 501) === 1, 'game end at the target; the higher total wins');
  // Bidding: round 1 takes the upcard's suit, round 2 another, all pass deals again.
  const o = orderOf(11, 52);
  let b = B.newGame(o, 3, 501);
  check(b.hands.every(h => h.length === 5) && b.phase === 'bid1' && b.turn === 0 && B.DECK.indexOf(b.upcard) >= 0, 'a deal: five cards each, one turned up, you bid first');
  let t1 = B.take(b, 0);
  check(t1.phase === 'play' && t1.hands.every(h => h.length === 8) && t1.trump === Z.suit(b.upcard) && t1.hands[0].indexOf(b.upcard) >= 0, 'taking gives the taker the upcard and everyone eight cards');
  let p = b; for (let i = 0; i < 4; i++) p = B.pass(p, p.turn);
  check(p.phase === 'bid2' && B.take(p, p.turn, Z.suit(p.upcard)).phase === 'bid2' && B.take(p, p.turn, (Z.suit(p.upcard) + 1) % 4).phase === 'play', 'round two: any suit but the one turned up');
  for (let i = 0; i < 4; i++) p = B.pass(p, p.turn);
  check(p.phase === 'redeal', 'all pass twice: deal again');
  // Whole games between four computer players.
  let games = 0, bad = 0, hands = 0, made = 0, belotes = 0, redeals = 0;
  for (let seed = 1; seed <= 40; seed++) {
    let g = B.newGame(orderOf(seed, 52), seed % 4, seed % 2 ? 301 : 501), guard = 0;
    while (g.phase !== 'over' && guard++ < 8000) {
      if (g.phase === 'redeal') { redeals++; g = B.nextHand(g, orderOf(seed * 500 + g.handNo + guard, 52)); continue; }
      if (g.phase === 'handEnd') { hands++; if (g.result.made) made++; if (g.result.belote >= 0) belotes++; g = B.nextHand(g, orderOf(seed * 500 + g.handNo, 52)); continue; }
      if (g.phase === 'bid1' || g.phase === 'bid2') { const c = B.aiBid(g, g.turn); g = c.take ? B.take(g, g.turn, c.suit) : B.pass(g, g.turn); continue; }
      if (g.trick.length === 4) { g = B.resolveTrick(g); continue; }
      const seat = g.turn, c = B.aiPick(g, seat);
      if (!B.isLegal(g, seat, c)) { bad++; break; }
      const cards = g.hands.reduce((n, h) => n + h.length, 0) + g.trick.length + g.won.reduce((n, w) => n + w.length, 0);
      if (cards !== 32) { bad++; break; }
      g = B.playCard(g, seat, c);
    }
    if (g.phase === 'over') games++;
  }
  check(bad === 0 && games === 40, 'forty computer games finish, every play legal, 32 cards always accounted for');
  check(hands > 100 && made > 30 && made < hands, 'contracts are made and missed (' + made + ' made of ' + hands + ', belote ' + belotes + ', redeals ' + redeals + ')');
}

// ── Skat ────────────────────────────────────────────────────────────────────
{
  const SK = sandbox.ZimiSkat;
  const RK = { A: 1, T: 10, J: 11, Q: 12, K: 13 }, SUi = 'CDHS';
  const id = s => Z.make(RK[s[0]] || +s[0], SUi.indexOf(s[1]));
  const ids = str => (str ? str.split(' ').map(id) : []);
  const [CLUBS, DIAMONDS, HEARTS, SPADES] = [0, 1, 2, 3];
  const suitG = s => ({ type: 'suit', suit: s, hand: false }), grand = { type: 'grand', suit: -1, hand: false };
  check(SK.BID_VALUES.slice(0, 11).join() === '18,20,22,23,24,27,30,33,35,36,40' && SK.nextBid(0) === 18 && SK.nextBid(24) === 27 && SK.nextBid(46) === 48, 'the bidding values run 18, 20, 22, 23, 24, 27, 30 ...');
  // Matadors.
  const mt = (cards, g) => SK.matadors(ids(cards), g);
  check(mt('JC JS JH AD TD', suitG(DIAMONDS)).with === true && mt('JC JS JH AD TD', suitG(DIAMONDS)).n === 3, 'with three: the top three jacks');
  check(mt('JC JS JH JD AD TD KD', suitG(DIAMONDS)).n === 7 && mt('JC JS JH JD AD TD KD', suitG(DIAMONDS)).with, 'with seven: four jacks and the ace, ten, king of the suit');
  check(mt('JS JH AH TH', suitG(HEARTS)).n === 1 && !mt('JS JH AH TH', suitG(HEARTS)).with, 'without one: the club jack is missing');
  check(mt('JC JD AH', grand).n === 1 && mt('JC JD AH', grand).with && mt('JS JH JD AC', grand).n === 1 && !mt('JS JH JD AC', grand).with, 'grand counts the jacks only');
  // Game values: base * (matadors + game + hand + schneider + schwarz).
  const val = (cards, g, o = {}) => SK.gameValue(g, ids(cards), o);
  check(val('JC JS AH', suitG(HEARTS)) === 10 * 3, 'hearts with two: 10 x 3 = 30');
  check(val('JC JS AH', suitG(HEARTS), { schneider: true }) === 40 && val('JC JS AH', suitG(HEARTS), { schneider: true, schwarz: true }) === 50, 'schneider and schwarz each add a multiplier');
  check(val('JC JS AH', { type: 'suit', suit: HEARTS, hand: true }) === 40, 'hand adds a multiplier');
  check(val('JS JH AD', grand) === 24 * 2 && val('JC JS JH JD AC', grand) === 24 * 5, 'grand: 24 x (matadors + 1)');
  check(val('7C', { type: 'null', hand: false }) === 23 && val('7C', { type: 'null', hand: true }) === 35, 'null 23, null hand 35');
  check(val('JC JS JH JD AC TC KC QC 9C 8C 7C', suitG(CLUBS)) === 12 * 12, 'with eleven in clubs: 12 x 12');
  // Card order and following.
  const g = suitG(HEARTS);
  check(SK.power(id('JC'), g) > SK.power(id('JS'), g) && SK.power(id('JD'), g) > SK.power(id('AH'), g) && SK.power(id('AH'), g) > SK.power(id('TH'), g) && SK.power(id('7H'), g) > SK.power(id('AS'), g), 'trump: jacks C S H D, then A 10 K Q 9 8 7 of the suit, above every other suit');
  check(SK.effSuit(id('JD'), g) === 4 && SK.effSuit(id('JD'), { type: 'null' }) === 1 && SK.effSuit(id('7H'), g) === 4 && SK.effSuit(id('7H'), grand) === HEARTS, 'jacks are trump in suit and grand games, not in null');
  const nl = { type: 'null' };
  check(SK.power(id('AS'), nl) > SK.power(id('KS'), nl) && SK.power(id('QS'), nl) > SK.power(id('JS'), nl) && SK.power(id('JS'), nl) > SK.power(id('TS'), nl) && SK.power(id('TS'), nl) > SK.power(id('9S'), nl), 'null order: A K Q J 10 9 8 7');
  const hand0 = ids('JD 9H 7S 8S AC'), game = { type: 'suit', suit: HEARTS, hand: false };
  const st = { phase: 'play', hands: [hand0, [], []], trick: [{ seat: 2, id: id('AS') }], turn: 0, game };
  check(SK.legalPlays(st, 0).sort().join() === ids('7S 8S').sort().join(), 'follow the suit led');
  check(SK.legalPlays(Object.assign({}, st, { trick: [{ seat: 2, id: id('KH') }] }), 0).sort().join() === ids('JD 9H').sort().join(), 'a trump led: follow with a trump (the jack is trump)');
  check(SK.legalPlays(Object.assign({}, st, { trick: [{ seat: 2, id: id('9C') }] }), 0).join() === ids('AC').join(), 'follow clubs with the ace of clubs');
  check(SK.trickWinner([{ seat: 0, id: id('AS') }, { seat: 1, id: id('7H') }, { seat: 2, id: id('TS') }], game) === 1 && SK.trickWinner([{ seat: 0, id: id('7S') }, { seat: 1, id: id('KS') }, { seat: 2, id: id('AH') }], game) === 2 && SK.trickWinner([{ seat: 0, id: id('JD') }, { seat: 1, id: id('JC') }, { seat: 2, id: id('AH') }], game) === 1, 'tricks: trump beats plain, higher beats lower, the club jack beats everything');
  // Bidding. West deals: you are middle hand, East forehand, West rear hand.
  const order = orderOf(7, 52);
  let b = SK.dealHand(order, 0, [0, 0, 0], 1, 6);
  check(b.hands.every(h => h.length === 10) && b.skat.length === 2 && b.turn === 0 && b.bid.caller === 0 && b.bid.listener === 2, 'a deal: ten each and two in the skat; with West dealing you bid first, to East');
  b = SK.bidAct(b, 0, 'bid'); check(b.bid.value === 18 && b.turn === 2 && SK.bidActions(b, 2).join() === 'hold,pass', 'the middle hand bids 18; the forehand holds or passes');
  b = SK.bidAct(b, 2, 'hold'); b = SK.bidAct(b, 0, 'bid'); check(b.bid.value === 20 && SK.bidAct(b, 2, 'bid') === b, 'the caller goes on to 20; only the listener answers');
  b = SK.bidAct(b, 2, 'pass');
  check(b.bid.stage === 2 && b.bid.listener === 0 && b.bid.caller === 1 && b.bid.value === 20 && b.turn === 1, 'the forehand passes: you answer the rear hand at 20');
  b = SK.bidAct(b, 1, 'bid'); check(b.bid.value === 22 && b.turn === 0, 'the rear hand bids 22');
  b = SK.bidAct(b, 0, 'pass'); check(b.phase === 'pick' && b.declarer === 1 && SK.bidValue(b) === 22, 'you pass: the rear hand declares at 22');
  let allPass = SK.dealHand(order, 0, [0, 0, 0], 1, 6);
  allPass = SK.bidAct(allPass, 0, 'pass'); allPass = SK.bidAct(allPass, 1, 'pass');
  check(allPass.phase === 'pick' && allPass.declarer === 2 && allPass.bid.value === 0 && SK.pickAct(allPass, 2, 'throw').phase === 'passout' && SK.pickAct(b, 1, 'throw') === b, 'everyone passes: the forehand may throw the hand in (nobody else may)');
  // Pick up, put back, declare.
  let p = SK.pickAct(b, 1, 'take');
  check(p.phase === 'discard' && p.hands[1].length === 12, 'taking the skat gives twelve cards');
  const put = p.hands[1].slice(0, 2);
  p = SK.discard(p, 1, put);
  check(p.phase === 'declare' && p.hands[1].length === 10 && same(p.skat.slice().sort(), put.slice().sort()), 'two cards go back to the skat');
  p = SK.declare(p, 1, 'suit', HEARTS);
  check(p.phase === 'play' && p.game.hand === false && p.turn === 2 && p.game.suit === HEARTS, 'declared; the forehand leads');
  const h2 = SK.declare(SK.pickAct(b, 1, 'hand'), 1, 'grand');
  check(h2.game.hand === true && h2.hands[1].length === 10, 'playing from the hand is a hand game');
  // Scoring a played hand (declarer is seat 0).
  const mk = (cardsWon, tricks, orig, skat, gm, bid = 18) => ({ declarer: 0, game: gm, bid: { value: bid }, won: [ids(cardsWon), [], []], skat: ids(skat), skat0: ids(skat), orig: [ids(orig), [], []], tricks });
  const OWN = 'JC JS AD KD TH 9H 8H 7H 8C 9C';
  let r = SK.scoreHand(mk('AC TC KC QC AS TS KS QS KH QH', [4, 3, 3], OWN, '7C 8S', suitG(HEARTS)));
  check(r.points === 63 && r.won && r.matadors.n === 2 && r.matadors.with && r.value === 30 && r.delta[0] === 80 && r.delta[1] === 0, 'a won hearts game with two: 63 points, 10 x 3 = 30, 50 + 30');
  r = SK.scoreHand(mk('AC TC KC QC AS TS KS QS KH QH', [4, 3, 3], OWN, '7C 8S', suitG(HEARTS), 33));
  check(!r.won && r.value === 40 && r.overbid && r.delta[0] === -(50 + 80) && r.delta[1] === 30 && r.delta[2] === 30, 'overbid: a 63-point game worth 30 under a bid of 33 is lost at 40 (the next multiple of 10): -130, defenders +30');
  r = SK.scoreHand(mk('AC TC', [2, 4, 4], OWN, '7C 8S', suitG(HEARTS)));
  check(!r.won && r.schneider && r.value === 40 && r.delta[0] === -(50 + 80), 'a loss with 21 points is schneider: value 40, doubled and a 50 penalty');
  r = SK.scoreHand(mk('AC TC KC QC AS TS KS QS AH TH KH QH AD TD KD QD', [10, 0, 0], OWN, '7C 8S', suitG(HEARTS)));
  check(r.won && r.schneider && r.schwarz && r.value === 10 * (2 + 1 + 1 + 1), 'every trick: schneider and schwarz, 10 x 5');
  r = SK.scoreHand(mk('', [0, 5, 5], 'AC 7C 8C 9C TD', '7S 8S', { type: 'null', hand: false }));
  check(r.won && r.value === 23 && r.delta[0] === 73, 'null with no trick: 50 + 23');
  r = SK.scoreHand(mk('', [1, 5, 4], 'AC 7C 8C 9C TD', '7S 8S', { type: 'null', hand: true }));
  check(!r.won && r.value === 35 && r.delta[0] === -(50 + 70), 'null hand with a trick: lost, -(50 + 70)');
  // Whole series between three computer players.
  let series = 0, bad = 0, hands = 0, thrown = 0;
  for (let seed = 1; seed <= 40; seed++) {
    let gm = SK.newGame(orderOf(seed, 52), seed % 2 ? 6 : 12, seed % 3), guard = 0;
    while (gm.phase !== 'over' && guard++ < 12000) {
      if (gm.phase === 'passout') { thrown++; gm = SK.nextHand(gm, orderOf(seed * 700 + guard, 52), true); continue; }
      if (gm.phase === 'handEnd') { hands++; gm = SK.nextHand(gm, orderOf(seed * 700 + gm.round, 52)); continue; }
      if (gm.phase === 'bid') { const a = SK.aiBid(gm, gm.turn); gm = SK.bidAct(gm, gm.turn, a); continue; }
      if (gm.phase === 'pick') { gm = SK.pickAct(gm, gm.declarer, SK.aiPick(gm, gm.declarer)); continue; }
      if (gm.phase === 'discard') { gm = SK.discard(gm, gm.declarer, SK.aiDiscard(gm, gm.declarer)); if (gm.phase === 'discard') { bad++; break; } continue; }
      if (gm.phase === 'declare') { const c = SK.aiDeclare(gm, gm.declarer); gm = SK.declare(gm, gm.declarer, c.type, c.suit); if (gm.phase === 'declare') { bad++; break; } continue; }
      if (gm.trick.length === 3) { gm = SK.resolveTrick(gm); continue; }
      const seat = gm.turn, c = SK.aiCard(gm, seat);
      if (!SK.isLegal(gm, seat, c)) { bad++; break; }
      const total = gm.hands.reduce((n, h) => n + h.length, 0) + gm.trick.length + gm.won.reduce((n, w) => n + w.length, 0) + gm.skat.length;
      if (total !== 32) { bad++; break; }
      gm = SK.playCard(gm, seat, c);
    }
    if (gm.phase === 'over') series++;
  }
  check(bad === 0 && series === 40, 'forty computer series finish, every play legal, 32 cards always accounted for');
  check(hands > 150, 'hands are played, not just thrown in (' + hands + ' hands, ' + thrown + ' thrown in)');
}

// ── Teen Patti ──────────────────────────────────────────────────────────────
{
  const TP = sandbox.ZimiTeenPatti;
  const RK = { A: 1, T: 10, J: 11, Q: 12, K: 13 }, SUi = 'CDHS';
  const id = s => Z.make(RK[s[0]] || +s[0], SUi.indexOf(s[1]));
  const hand = str => str.split(' ').map(id);
  const rank = str => TP.evaluate(hand(str));
  const beats = (a, b) => TP.compare(rank(a), rank(b)) > 0;
  // Hand ranking: trail > pure sequence > sequence > colour > pair > high card.
  check(beats('2C 2D 2H', 'AC KC QC') && beats('AC KC QC', 'AC KD QH') && beats('AC KD QH', 'AC AD 2H'), 'a trail beats a pure sequence beats a sequence; a sequence beats a pair');
  check(beats('AC KD QH', 'AC 7C 4C') && beats('AC 7C 4C', 'KC KD 2H') && beats('KC KD 2H', 'AC KD QH') === false, 'sequence > colour > pair');
  check(beats('KC KD 2H', 'AC QD JH') && beats('AC QD JH', 'AC QD TH') && beats('AC QD TH', 'AC JD TH'), 'pair > high card; high cards compare card by card');
  check(TP.describe(hand('2C 2D 2H')) === 'trail' && TP.describe(hand('4H 5H 6H')) === 'pure sequence' && TP.describe(hand('4H 5D 6H')) === 'sequence' && TP.describe(hand('4H 9H 6H')) === 'colour' && TP.describe(hand('4H 4D 6H')) === 'pair' && TP.describe(hand('4H 9D 6H')) === 'high card', 'hand names');
  check(beats('AC 2D 3H', 'AC KD QH') && beats('AC KD QH', 'KC QD JH') && beats('4C 3D 2H', 'KC QD JH') === false && beats('5C 4D 3H', '4C 3D 2H'), 'sequences: A-2-3 is highest, then A-K-Q, down to 4-3-2');
  check(beats('AC 2D 3H', 'AC AD AH') === false && beats('AC AD AH', 'KC KD KH') && beats('3C 3D 3H', '2C 2D 2H'), 'trails: aces highest, then down');
  check(beats('QC QD 2H', 'JC JD AH') && beats('QC QD 5H', 'QC QD 4H') && TP.compare(rank('AC KD 4H'), rank('AD KH 4C')) === 0, 'pairs by rank then kicker; equal hands tie');
  check(beats('AC 2C 3C', 'AC KC QC') && TP.compare(rank('AC KC QC'), rank('AD KD QD')) === 0, 'pure sequences: A-2-3 first; suits do not matter');
  // A hand: boot, blind and seen costs, raising.
  const order = Z.shuffled(lcg(9));
  let s = TP.deal(order, 0, [1000, 1000, 1000, 1000], 3);
  check(s.pot === 40 && s.chips.every(c => c === 990) && s.hands.every(h => h.length === 3) && s.turn === 0 && s.stake === 10, 'a deal: boot 10 each into a pot of 40, you first (the dealer is East)');
  const costs = a => a.map(x => x.type + ':' + x.cost).join(' ');
  check(costs(TP.actions(s, 0)) === 'see:0 blind:10 blindRaise:20 pack:0', 'blind: see, play for the stake, raise, or pack');
  s = TP.act(s, 0, 'see'); check(s.seen[0] && s.turn === 0 && costs(TP.actions(s, 0)) === 'chaal:20 raise:40 pack:0', 'seen: chaal is double the stake, a raise four times');
  s = TP.act(s, 0, 'raise'); check(s.stake === 20 && s.pot === 80 && s.chips[0] === 950 && s.turn === 1, 'a seen raise doubles the stake and the turn passes');
  s = TP.act(s, 1, 'blindRaise'); check(s.stake === 40 && s.chips[1] === 990 - 40 && s.pot === 120, 'a blind raise pays double the stake and doubles it');
  s = TP.act(s, 2, 'blind'); check(s.chips[2] === 990 - 40 && s.stake === 40, 'a blind bet pays the stake');
  s = TP.act(s, 3, 'pack'); check(s.folded[3] && TP.active(s).length === 3 && s.turn === 0, 'packing leaves three in');
  // Side show: only for a seen player, against a seen player just before.
  check(!TP.actions(s, 0).some(a => a.type === 'sideshow'), 'no side show when the player before is blind or packed (East packed, North not seen)');
  let ss = TP.deal(order, 0, [1000, 1000, 1000, 1000], 3);
  ss = TP.act(ss, 0, 'see'); ss = TP.act(ss, 0, 'chaal'); ss = TP.act(ss, 1, 'see'); ss = TP.act(ss, 1, 'chaal');
  check(TP.prevActive(ss, 2) === 1 && !TP.actions(ss, 2).some(a => a.type === 'sideshow') && (ss = TP.act(ss, 2, 'see')) && TP.actions(ss, 2).some(a => a.type === 'sideshow'), 'a seen player may ask the seen player before him');
  const before = ss.pot;
  ss = TP.act(ss, 2, 'sideshow');
  check(ss.phase === 'side' && ss.side.from === 2 && ss.side.to === 1 && ss.pot === before + 2 * ss.stake, 'the side show is asked after paying a chaal');
  const w1 = TP.compare(TP.evaluate(ss.hands[2]), TP.evaluate(ss.hands[1]));
  const acc = TP.respondSide(ss, 1, true);
  check(acc.phase === 'bet' && acc.folded[w1 > 0 ? 1 : 2] === true && acc.folded[w1 > 0 ? 2 : 1] === false, 'accepted: the weaker hand packs (a tie sends the asker out)');
  const ref = TP.respondSide(ss, 1, false);
  check(ref.phase === 'bet' && !ref.folded[1] && !ref.folded[2] && ref.turn === 3, 'refused: nobody packs and play goes on');
  // Show with two left: the higher hand wins the pot; a tie goes to the one who did not ask.
  let sh = TP.deal([id('AC'), id('KD'), id('4H'), id('AD'), id('KH'), id('4C'), id('2C'), id('7D'), id('9H'), id('3C'), id('5D'), id('8H'), ...Array(40).fill(0)].map((c, i) => c), 0, [1000, 1000, 1000, 1000], 3);
  sh.folded = [false, false, true, true]; sh.seen = [true, true, false, false];
  check(TP.actions(sh, 0).some(a => a.type === 'show') && !TP.actions(sh, 0).some(a => a.type === 'sideshow'), 'with two left: show, no side show');
  const potBefore = sh.pot;
  const shown = TP.act(sh, 0, 'show');
  check(shown.result.kind === 'show' && shown.result.winner === 1 && shown.chips[1] === sh.chips[1] + potBefore + 2 * sh.stake && shown.pot === 0, 'a tied show goes to the player who did not ask; the winner takes the pot');
  // Chips are conserved, whole games finish.
  let games = 0, bad = 0, hands = 0, shows = 0, sides = 0, folds = 0, packs = 0;
  const rng = lcg(5), rnd = () => rng();
  for (let seed = 1; seed <= 30; seed++) {
    let g = TP.newGame(orderOf(seed, 52).concat(orderOf(seed + 99, 52)), seed % 4), guard = 0;
    while (g.phase !== 'over' && guard++ < 6000) {
      const total = g.chips.reduce((n, c) => n + c, 0) + g.pot;
      if (total !== 4000) { bad++; break; }
      if (g.phase === 'handEnd') { hands++; if (g.result.kind === 'show') shows++; if (g.result.kind === 'fold') folds++; g = TP.nextHand(g, Z.shuffled(lcg(seed * 31 + g.round))); continue; }
      if (g.phase === 'side') { sides++; g = TP.respondSide(g, g.side.to, TP.aiRespond(g, g.side.to, rnd)); continue; }
      const seat = g.turn, a = TP.aiAct(g, seat, rnd), before = g.moves;
      if (!TP.isLegal(g, seat, a.type)) { bad++; break; }
      if (a.type === 'pack') packs++;
      g = TP.act(g, seat, a.type);
      if (g.moves === before) { bad++; break; }
    }
    if (g.phase === 'over') games++;
  }
  check(bad === 0 && games >= 28, 'computer-vs-computer games run (' + games + ' of 30 reached a winner), every action legal, 4000 chips always accounted for');
  check(shows > 20 && folds > 20 && sides > 20 && packs > 100, 'the styles use show (' + shows + '), side shows (' + sides + '), packs (' + packs + ') and folds win pots (' + folds + ') over ' + hands + ' hands');
}

// ── The licensed art: Spanish courts (1860 print) and the 48 Hanafuda cards ──
{
  const es = [];
  for (let su = 0; su < 4; su++) for (const k of [7, 8, 9]) es.push(Z.spanishFaceMarkup(su * 10 + k, false));
  check(es.every(m => m.includes('<image href="data:image/webp;base64,')) && new Set(es).size === 12, 'the twelve Spanish courts are twelve different scans');
  check(!Z.spanishFaceMarkup(6, false).includes('<image'), 'the Spanish pips keep their own drawing');
  const hana = [];
  for (let i = 0; i < 48; i++) hana.push(Z.hanafudaFaceMarkup(i, false));
  check(hana.every(m => m.includes('viewBox="16 16 944 1568"')) && new Set(hana).size === 48, 'all 48 Hanafuda cards are 48 different drawings of the licensed set');
  const allowed = new Set(['#b3261e', '#1b1b1b', '#e09400', '#fdfcf8', '#000000', '#992d17', '#ffeb5c', '#5d4e8c', '#ff8db6', '#80e3ed', '#50b271', '#ffb85a', '#592116']);
  const stray = new Set();
  hana.forEach(m => ((m.match(/<svg x=[\s\S]*?<\/svg>/) || [''])[0].match(/(?:fill|stroke)="#[0-9a-fA-F]{6}"/g) || []).forEach(x => { const c = x.split('"')[1].toLowerCase(); if (!allowed.has(c)) stray.add(c); }));
  check(stray.size === 0, 'the Hanafuda faces use the listed colours only' + (stray.size ? ' (stray ' + [...stray] + ')' : ''));
  for (const [f, cap] of [['courts-es.js', 400], ['hanafuda-art.js', 850]]) check(fs.statSync(path.join(dir, f)).size < cap * 1024, f + ' stays under ' + cap + ' KB');
}

if (failures) { console.error(failures + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log('all passed (' + passed + ')');
