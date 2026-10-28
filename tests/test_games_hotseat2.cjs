// ZimiGames: people on one device in the table card games (Big Two, Tien Len, Canasta,
// Blackjack, Hold'em, Bridge). With two or more person seats the table shows only the
// viewer's hand, face down when it is not their turn, and only a person other than the
// viewer needs the "Pass to" screen. No DOM beyond the stubs: the game files run their page
// wiring only when a #zc-table exists.
// Run: node tests/test_games_hotseat2.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
let failures = 0, passed = 0;
const check = (ok, label) => {
  if (ok) { passed++; console.log('ok: ' + label); } else { console.error('FAIL: ' + label); failures++; }
};

const sandbox = {
  console, Date, setTimeout, clearTimeout, setInterval, clearInterval,
  document: { addEventListener() {}, querySelector: () => null, getElementById: () => null, documentElement: { classList: { toggle() {} } }, hidden: false }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['text.js', 'cardbacks.js', 'courts.js', 'cards.js', 'handoff.js', 'cardtable.js', 'climbing.js', 'bigtwo.js', 'tienlen.js', 'canasta.js', 'blackjack.js', 'holdem.js', 'bridge.js']) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
}
const Z = sandbox.ZimiCards;
const lcg = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const metrics = () => ({ W: 390, H: 790, pad: 8, gap: 5, left: 8, cw: 48, ch: 67, step: 44, cols: 7 });
const faceUp = placed => placed.cards.filter(c => c.up).map(c => c.id);
// Face-up cards on the table that belong to a hand other than the viewer's.
const leaks = (placed, hands, viewer) => placed.cards.filter(c => c.up && hands.some((h, s) => s !== viewer && h.indexOf(c.id) >= 0));
const CARD_WORDS = /\b(ace|king|queen|jack|two|three|four|five|six|seven|eight|nine|ten|joker)\b/;

// ── The handoff rule the games rely on ──
{
  const S = sandbox.ZimiSeats;
  check(S.needsCover(['person', 'person', 'cpu', 'cpu'], 0, 1) && !S.needsCover(['person', 'person', 'cpu', 'cpu'], 1, 1), 'two people: the other person gets the Pass-to screen, the viewer does not');
  check(!S.needsCover(['person', 'cpu', 'cpu', 'cpu'], 0, 1) && !S.needsCover(['person', 'person', 'cpu', 'cpu'], 0, 2), 'a lone person, or a computer seat, never needs a cover');
}

// ── Big Two and Tien Len: the viewer's hand at the bottom, face down off their turn ──
for (const [name, G] of [['Big Two', sandbox.ZimiBigTwo], ['Tien Len', sandbox.ZimiTienLen]]) {
  const st = G.newHand(Z.shuffled(lcg(7)), [0, 0, 0, 0], 0, 0);
  const open = G.place(st, metrics(), { sel: [], viewer: 2, hideHand: false });
  const mine = open.cards.filter(c => c.pile[0] === 'h');
  check(mine.length === 13 && mine.every(c => c.up && st.hands[2].indexOf(c.id) >= 0), name + ': seat 2 looking sees its own 13 cards face up at the bottom');
  check(leaks(open, st.hands, 2).length === 0, name + ': nobody else\'s card is face up');
  const covered = G.place(st, metrics(), { sel: [], viewer: 2, hideHand: true });
  check(faceUp(covered).length === 0 && covered.cards.filter(c => c.pile[0] === 'h').length === 13, name + ': off the viewer\'s turn their hand is face down');
  check(covered.slots.every(s => !CARD_WORDS.test(s.label || '') || s.id === 'table'), name + ': hidden cards carry no card names');
  const solo = G.place(st, metrics(), { sel: [] });
  check(solo.cards.filter(c => c.pile[0] === 'h').every(c => c.up && st.hands[0].indexOf(c.id) >= 0), name + ': with no viewer set seat 0 is at the bottom, face up');
}

// ── Canasta: two people, each side's hand at the bottom for its own player ──
{
  const C = sandbox.ZimiCanasta, T = sandbox.ZimiTable;
  const all = Array.from({ length: C.TOTAL }, (_, i) => i);
  const st = C.newHand(T.shuffleOf(all, lcg(3)), [0, 0], 0, 5000);
  for (const V of [0, 1]) {
    const open = C.place(st, metrics(), { sel: [], viewer: V, hideHand: false });
    const mine = open.cards.filter(c => c.pile[0] === 'h');
    check(mine.length === st.hands[V].length && mine.every(c => c.up && st.hands[V].indexOf(c.id) >= 0), 'Canasta: side ' + V + ' looking sees its own hand face up');
    check(leaks(open, st.hands, V).length === 0, 'Canasta: side ' + V + ' looking, the other hand stays face down');
    const covered = C.place(st, metrics(), { sel: [], viewer: V, hideHand: true });
    check(faceUp(covered).every(id => st.hands[0].indexOf(id) < 0 && st.hands[1].indexOf(id) < 0) && covered.slots.every(s => !CARD_WORDS.test(s.label || '') || /pile|Stock/i.test(s.label)), 'Canasta: off side ' + V + '\'s turn neither hand shows');
  }
  const solo = C.place(st, metrics(), { sel: [] });
  check(solo.cards.filter(c => c.pile[0] === 'h').every(c => c.up && st.hands[0].indexOf(c.id) >= 0), 'Canasta: with no viewer set side 0 is at the bottom');
}

// ── Blackjack: people take a round each from one shoe, nothing but their own chips carries over ──
{
  const B = sandbox.ZimiBlackjack;
  let a = B.deal(B.setBet(B.newGame(lcg(5), { decks: 2 }), 50), lcg(6));
  while (B.canHit(a)) a = B.stand(a);
  const b = B.carry(a, { chips: 700, bet: 30 });
  check(b.chips === 700 && b.bet === 30 && b.phase === 'bet' && !b.hands.length && !b.dealer.length && !b.last.length, 'Blackjack: the next person starts a clean round with their own chips and bet');
  check(b.pos === a.pos && b.shoe.length === a.shoe.length && b.round === a.round, 'Blackjack: they play from the same shoe, where the last round left it');
  check(B.carry(a, { chips: 40, bet: 90 }).bet === 40, 'Blackjack: a bet is never more than the person\'s chips');
  const seen = a.hands[0].cards.concat(a.dealer);
  const c = B.deal(b, lcg(8));
  check(c.hands[0].cards.concat(c.dealer).every(id => seen.indexOf(id) < 0) || c.shuffled, 'Blackjack: cards already dealt are not dealt again');
  check(B.nextPlayer([0, 2], { 0: 100, 2: 100 }, 0) === 2 && B.nextPlayer([0, 2], { 0: 100, 2: 100 }, 2) === 0, 'Blackjack: the device goes round the people in seat order');
  check(B.nextPlayer([0, 1, 2], { 0: 100, 1: 5, 2: 100 }, 0) === 2 && B.nextPlayer([0, 1], { 0: 100, 1: 0 }, 0) === 0 && B.nextPlayer([0, 1], { 0: 0, 1: 0 }, 0) === -1, 'Blackjack: people without chips are skipped; nobody left ends the game');
}

// ── Hold'em: each person's two cards sit at the bottom for them alone ──
{
  const H = sandbox.ZimiHoldem;
  let st = H.startHand(H.newGame(lcg(11), 3), lcg(12));
  st.people = [0, 2];
  for (const V of [0, 2]) {
    const open = H.place(st, metrics(), { viewer: V, hideHand: false });
    const mine = open.cards.filter(c => c.pile === 'h0');
    check(mine.length === 2 && mine.every(c => c.up && st.players[V].hole.indexOf(c.id) >= 0), 'Hold\'em: seat ' + V + ' looking sees its own two cards face up at the bottom');
    check(open.cards.filter(c => c.up && c.pile !== 'b' && c.pile !== 'h0').length === 0, 'Hold\'em: seat ' + V + ' looking, every other hole card is face down');
    const covered = H.place(st, metrics(), { viewer: V, hideHand: true });
    check(covered.cards.filter(c => c.pile !== 'b' && c.up).length === 0, 'Hold\'em: off seat ' + V + '\'s turn no hole card shows');
  }
  const solo = H.place(st, metrics(), {});
  check(solo.cards.filter(c => c.pile === 'h0').every(c => c.up && st.players[0].hole.indexOf(c.id) >= 0), 'Hold\'em: with no viewer set seat 0 is at the bottom');
  const tops = H.place(st, metrics(), { viewer: 2, hideHand: true }).cards.filter(c => c.pile[0] === 'p').map(c => c.pile);
  check(tops.indexOf('p2') < 0 && tops.indexOf('p0') >= 0, 'Hold\'em: the viewer\'s own seat is not repeated across the top; seat 0 moves up there');
  // the game ends when no person has chips, or one player has them all
  const s2 = JSON.parse(JSON.stringify(st));
  s2.players.forEach((p, i) => { p.chips = i === 1 ? 500 : i === 3 ? 400 : 0; });
  check(H.gameState(s2) === 'lost', 'Hold\'em: both people busted, the game is lost');
  s2.players[2].chips = 300;
  check(H.gameState(s2) === '', 'Hold\'em: a person and two computers still hold chips, play on');
  s2.players[1].chips = 0; s2.players[3].chips = 0;
  check(H.gameState(s2) === 'won', 'Hold\'em: one person holds every chip, they win');
}

// ── Bridge: any seat can be a person; hands are hidden, except dummy once it is down ──
{
  const BR = sandbox.ZimiBridge, T = sandbox.ZimiTable;
  let st = BR.newGame(Z.shuffled(lcg(5)));
  const auction = BR.place(st, metrics(), { viewer: 1, hideHand: false });
  const mine = auction.cards.filter(c => c.pile[0] === 'h');
  check(mine.length === 13 && mine.every(c => c.up && st.hands[1].indexOf(c.id) >= 0), 'Bridge: West looking sees its own 13 cards at the bottom during the auction');
  check(leaks(auction, st.hands, 1).length === 0, 'Bridge: West looking, nobody else\'s hand is face up');
  check(BR.place(st, metrics(), { viewer: 1, hideHand: true }).cards.every(c => !c.up), 'Bridge: off West\'s turn to call their hand is face down');
  st = BR.applyCall(st, 2, '1H'); st = BR.applyCall(st, 3, 'P'); st = BR.applyCall(st, 0, 'P'); st = BR.applyCall(st, 1, 'P');
  st = BR.playCard(st, st.turn, BR.legalPlays(st, st.turn)[0]);
  check(st.phase === 'play' && st.contract.declarer === 2 && st.contract.dummy === 0 && st.dummyShown, 'Bridge: North declares, South is dummy and goes down after the lead');
  const dummyHand = st.hands[0].slice(), led = st.trick[0];
  const defender = BR.place(st, metrics(), { viewer: 1, hideHand: true });
  const up = defender.cards.filter(c => c.up && c.pile !== 'trick');
  check(up.length === dummyHand.length && up.every(c => c.pile[0] === 'd' && dummyHand.indexOf(c.id) >= 0), 'Bridge: a defender off turn sees only dummy face up, not their own hand or declarer\'s');
  check(defender.cards.filter(c => c.pile[0] === 'h').length === st.hands[1].length && defender.cards.filter(c => c.pile[0] === 'h').every(c => !c.up), 'Bridge: the defender\'s own hand stays face down');
  const g = BR.geo(metrics()), spot = defender.cards.find(c => c.pile === 'trick');
  const want = T.trickSpot(g, (led.seat - 1 + 4) % 4);
  check(spot && spot.x === Math.round(want.x) && spot.y === Math.round(want.y), 'Bridge: a played card lands where its seat sits for the viewer');
  const declarer = BR.place(st, metrics(), { viewer: 2, hideHand: false });
  check(declarer.cards.filter(c => c.pile[0] === 'h').every(c => c.up && st.hands[2].indexOf(c.id) >= 0) && declarer.cards.filter(c => c.pile[0] === 'd').length === dummyHand.length, 'Bridge: declarer on turn sees their hand and dummy, both face up');
  const solo = BR.place(st, metrics(), {});
  check(solo.cards.filter(c => c.pile[0] === 'h').every(c => c.up && st.hands[0].indexOf(c.id) >= 0), 'Bridge: with no viewer set South is at the bottom');
}

console.log(failures ? failures + ' failure(s), ' + passed + ' passed' : 'all passed (' + passed + ')');
process.exit(failures ? 1 : 0);
