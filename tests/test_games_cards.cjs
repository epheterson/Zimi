// Arcade's card games (Solitaire, FreeCell) and the shared card module: the
// Microsoft deal (deal #1 and #617 against their documented layouts), the
// rules, scoring, undo, and the Moon on the night-sky back. No DOM: the game
// files run their page wiring only when a #zc-table exists.
//
// Run: node tests/test_games_cards.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A stand-in document: enough for createSession to wire itself, nothing more.
const listeners = [];
const fakeEl = () => ({ addEventListener: (t, f) => listeners.push([t, f]), textContent: '', disabled: false });
const sandbox = {
  console, Date, setTimeout, clearTimeout, setInterval, clearInterval,
  document: {
    addEventListener() {}, querySelector: () => null, getElementById: () => null,
    documentElement: { classList: { toggle() {} } }, hidden: false
  }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['text.js', 'cardbacks.js', 'courts.js', 'cards.js', 'solitaire.js', 'freecell.js']) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
}
const Z = sandbox.ZimiCards, K = sandbox.ZimiSolitaire, F = sandbox.ZimiFreeCell;
const L = 'A23456789TJQK', S = 'CDHS';
const name = id => L[Z.rank(id) - 1] + S[Z.suit(id)];
const id = (s) => Z.make(L.indexOf(s[0]) + 1, S.indexOf(s[1]));

// ── The Microsoft deal ──────────────────────────────────────────────────────
const rows = n => {
  const d = Z.msDeal(n).map(name), out = [];
  for (let r = 0; r < d.length; r += 8) out.push(d.slice(r, r + 8).join(' '));
  return out;
};
check(same(rows(1), [
  'JD 2D 9H JC 5D 7H 7C 5H', 'KD KC 9S 5S AD QC KH 3H', '2S KS 9D QD JS AS AH 3C', '4C 5C TS QH 4H AC 4D 7S',
  '3S TD 4S TH 8H 2C JH 7D', '6D 8S 8D QS 6C 3D 8C TC', '6S 9C 2H 6H']), 'FreeCell deal #1 matches the documented layout');
check(same(rows(617), [
  '7D AD 5C 3S 5S 8C 2D AH', 'TD 7S QD AC 6D 8H AS KH', 'TH QC 3H 9D 6S 8D 3D TC', 'KD 5H 9S 3C 8S 7H 4D JS',
  '4C QS 9C 9H 7C 6H 2C 2S', '4S TS 2H 5D JC 6C JH QH', 'JD KS KC 4H']), 'FreeCell deal #617 matches the documented layout');
const d11982 = Z.msDeal(11982);
check(d11982.length === 52 && new Set(d11982).size === 52, 'deal #11982 (the famous unwinnable one) deals 52 distinct cards');
check(!same(Z.msDeal(1), Z.msDeal(2)), 'different deal numbers deal differently');
check(same(Z.msDeal(32000), Z.msDeal(32000)), 'a deal number always deals the same');

// ── FreeCell ────────────────────────────────────────────────────────────────
const fc = F.newState(617);
check(F.COLUMNS.map(c => fc.piles[c].length).join() === '7,7,7,7,6,6,6,6', 'FreeCell deals 7,7,7,7,6,6,6,6');
check(F.CELLS.concat(F.FOUNDATION).every(p => fc.piles[p].length === 0), 'free cells and foundations start empty');
const emptyFc = () => {
  const s = F.newState(1);
  Object.keys(s.piles).forEach(p => { s.piles[p] = []; });
  return s;
};

check(F.maxMovable(4, 0, false) === 5, 'supermove: 4 free cells, no empty column -> 5 cards');
check(F.maxMovable(0, 0, false) === 1, 'supermove: nothing free -> 1 card');
check(F.maxMovable(3, 0, false) === 4, 'supermove: 3 free cells -> 4 cards');
check(F.maxMovable(4, 1, false) === 10, 'supermove: 4 cells + 1 empty column -> 10 cards');
check(F.maxMovable(4, 1, true) === 5, 'supermove: moving into the only empty column does not count it');
check(F.maxMovable(2, 2, false) === 12, 'supermove: 2 cells + 2 empty columns -> 12 cards');
check(F.maxMovable(1, 2, true) === 4, 'supermove: 1 cell + 2 empty columns, into one of them -> 4 cards');

{ // a run of 3 needs two free cells
  const s = emptyFc();
  s.piles.c0 = [id('9S'), id('8D'), id('7C')]; s.piles.c1 = [id('TH')];
  ['fr0', 'fr1', 'fr2'].forEach((c, i) => { s.piles[c] = [id(['2C', '3C', '4C'][i])]; });
  s.piles.c2 = [id('KD')]; s.piles.c3 = [id('KC')]; s.piles.c4 = [id('KH')]; s.piles.c5 = [id('KS')]; s.piles.c6 = [id('QS')]; s.piles.c7 = [id('QD')];
  check(!F.legalMove(s, 'c0', 0, 'c1'), 'a 3-card run does not move with 1 free cell and no empty column');
  s.piles.fr0 = [];
  check(F.legalMove(s, 'c0', 0, 'c1'), 'a 3-card run moves with 2 free cells (cap 3)');
  check(F.legalMove(s, 'c0', 2, 'c1') === false, 'a 7 of clubs does not go on a 10 of hearts');
  check(F.canPick(s, 'c0', 0) && F.canPick(s, 'c0', 1), 'a descending alternating run can be picked up');
  check(!F.canPick(s, 'c2', 1), 'there is no card past the end of a column');
}
{ // runs must alternate colours
  const s = emptyFc();
  s.piles.c0 = [id('9S'), id('8C')];
  check(!F.canPick(s, 'c0', 0), 'two blacks in a row are not a run');
}
{ // empty column, free cell, foundation targets
  const s = emptyFc();
  s.piles.c0 = [id('5H'), id('4S')]; s.piles.fd0 = [id('AC'), id('2C')]; s.piles.c1 = [id('3C')];
  check(F.legalMove(s, 'c1', 0, 'fr0'), 'a card goes to an empty free cell');
  check(F.legalMove(s, 'c1', 0, 'fd0'), 'the next club goes up the foundation');
  check(!F.legalMove(s, 'c0', 1, 'fd0'), 'a spade does not go on the clubs');
  check(F.legalMove(s, 'c0', 1, 'c7'), 'any card goes to an empty column');
  s.piles.fr0 = [id('KS')];
  check(!F.legalMove(s, 'c1', 0, 'fr0'), 'an occupied free cell takes nothing');
  check(F.canPick(s, 'fr0', 0) && !F.canPick(s, 'fd0', 1), 'a free cell card can be picked up, a foundation card cannot');
  check(F.bestMove(s, 'c1', 0) === 'fd0', 'tap sends a card to its foundation first');
}
{ // safe auto-move
  const s = emptyFc();
  s.piles.c0 = [id('KH'), id('3C')]; s.piles.fd0 = [id('AC'), id('2C')];
  check(F.safeAutoMove(s) === null, 'a 3 of clubs is not safe while the red 2s are down');
  s.piles.fd1 = [id('AD'), id('2D')]; s.piles.fd2 = [id('AH'), id('2H')];
  const m = F.safeAutoMove(s);
  check(m && m.from === 'c0' && m.to === 'fd0', 'with both red 2s up, the 3 of clubs goes by itself');
  const s2 = emptyFc(); s2.piles.c0 = [id('KH'), id('AS')];
  check(F.safeAutoMove(s2) && F.safeAutoMove(s2).to === 'fd0', 'an ace is always safe');
}
{ // win
  const s = F.almostWon();
  check(!F.isWon(s), 'one move from a FreeCell win is not a win');
  const to = F.bestMove(s, 'c0', 0);
  check(to && F.isWon(F.applyMove(s, 'c0', 0, to)), 'the last king up wins FreeCell');
  check(F.applyMove(s, 'c0', 0, to).moves === s.moves + 1 && s.piles.c0.length === 1, 'moving leaves the old state untouched');
}

// ── Solitaire ───────────────────────────────────────────────────────────────
const deck = Array.from({ length: 52 }, (_, i) => i);
const ks = K.newState(deck, 1);
check(K.TABLEAU.map(t => ks.piles[t].length).join() === '1,2,3,4,5,6,7', 'Klondike deals 1..7 to the tableau');
check(ks.piles.stock.length === 24 && ks.piles.waste.length === 0, 'the stock holds the other 24');
check(K.TABLEAU.every(t => ks.piles[t].every((c, i, a) => c.up === (i === a.length - 1))), 'only each pile\'s top card is face up');
const everyCard = Object.keys(ks.piles).reduce((n, p) => n.concat(ks.piles[p].map(c => c.id)), []);
check(everyCard.length === 52 && new Set(everyCard).size === 52, 'all 52 cards are somewhere, once');
check(K.newState(deck, 3).draw === 3 && K.newState(deck, 7).draw === 1, 'draw is 1 or 3');

const emptyK = draw => K.blankState(draw || 1);
const up = ids => ids.map(x => ({ id: id(x), up: true }));
const down = ids => ids.map(x => ({ id: id(x), up: false }));
{ // tableau moves
  const s = emptyK();
  s.piles.t0 = up(['6H']); s.piles.t1 = up(['7S']); s.piles.t2 = up(['7C', '6D']); s.piles.t3 = up(['KD']); s.piles.t4 = [];
  check(K.legalMove(s, 't0', 0, 't1'), 'red 6 goes on a black 7');
  check(!K.legalMove(s, 't0', 0, 't2'), 'red 6 does not go on a red 6');
  check(K.legalMove(s, 't2', 1, 't1'), 'red 6 moves from one black 7 to another');
  check(K.legalMove(s, 't3', 0, 't4'), 'a king goes to an empty column');
  s.piles.t4 = []; s.piles.t0 = up(['QH']);
  check(!K.legalMove(s, 't0', 0, 't4'), 'a queen does not go to an empty column');
  check(!K.legalMove(s, 't0', 0, 't0'), 'a pile is not a legal target for itself');
}
{ // runs and face-down cards
  const s = emptyK();
  s.piles.t0 = down(['9D']).concat(up(['8S', '7H', '6C'])); s.piles.t1 = up(['9H']);
  check(K.canPick(s, 't0', 1) && K.canPick(s, 't0', 2) && !K.canPick(s, 't0', 0), 'a face-up run can be picked, a face-down card cannot');
  check(K.legalMove(s, 't0', 1, 't1'), 'the 8-7-6 run moves onto a red 9');
  s.piles.t1 = up(['9D']);
  const m = K.applyMove(s, 't0', 1, 't1');
  check(m.piles.t1.length === 4 && m.piles.t0.length === 1 && m.piles.t0[0].up === true, 'the run moves and the card under it turns face up');
  check(m.score === K.SCORE.turnOver, 'turning a card over scores +5');
  check(s.piles.t0.length === 4 && s.score === 0, 'the original state is untouched (undo has something to return to)');
}
{ // foundations
  const s = emptyK();
  s.piles.t0 = up(['AH']); s.piles.t1 = up(['2H']); s.piles.t2 = up(['2S']);
  check(K.legalMove(s, 't0', 0, 'f2'), 'an ace goes to any empty foundation');
  const a = K.applyMove(s, 't0', 0, 'f2');
  check(a.score === K.SCORE.foundation, 'a card up to a foundation scores +10');
  check(K.legalMove(a, 't1', 0, 'f2') && !K.legalMove(a, 't2', 0, 'f2'), 'then the same suit one higher, and nothing else');
  check(K.bestMove(a, 't1', 0) === 'f2', 'tap sends the card to its own suit\'s foundation');
  const b = emptyK(); b.piles.f0 = up(['AH', '2H']); b.piles.t3 = up(['3S']); b.score = 20;
  const back = K.applyMove(b, 'f0', 1, 't3');
  check(K.legalMove(b, 'f0', 1, 't3') && back.score === 20 + K.SCORE.foundationToTableau, 'a foundation card can come back down, for -15');
  b.score = 5;
  check(K.applyMove(b, 'f0', 1, 't3').score === 0, 'and the score never goes below 0');
}
{ // waste
  const s = emptyK();
  s.piles.waste = up(['6D']); s.piles.t0 = up(['7C']);
  const m = K.applyMove(s, 'waste', 0, 't0');
  check(m.score === K.SCORE.wasteToTableau, 'waste to tableau scores +5');
  check(K.bestMove(s, 'waste', 0) === 't0', 'tap sends the waste card to the tableau when no foundation takes it');
}
{ // draw 1, draw 3, recycling
  const s = K.newState(deck, 1);
  const a = K.drawStock(s);
  check(a.piles.waste.length === 1 && a.piles.stock.length === 23 && a.piles.waste[0].up, 'draw 1 turns one card up onto the waste');
  const s3 = K.newState(deck, 3), b = K.drawStock(s3);
  check(b.piles.waste.length === 3 && b.piles.stock.length === 21, 'draw 3 turns three');
  let x = K.newState(deck, 3); x.piles.stock = x.piles.stock.slice(0, 2);
  check(K.drawStock(x).piles.waste.length === 2, 'draw 3 with 2 left turns the 2');
  const one = K.newState([], 1); one.piles.waste = up(['AS', '2S']); one.score = 150;
  const r = K.drawStock(one);
  check(r.piles.stock.length === 2 && r.piles.waste.length === 0 && r.piles.stock.every(c => !c.up), 'an empty stock turns the waste back over');
  check(r.piles.stock[r.piles.stock.length - 1].id === id('AS'), 'recycling keeps the original order (the first drawn comes round first)');
  check(r.score === 50, 'recycling costs 100 in draw 1');
  const three = K.newState([], 3); three.piles.waste = up(['AS']); three.score = 100;
  let y = three;
  for (let pass = 1; pass <= 4; pass++) {
    y.piles.waste = up(['AS']); y.piles.stock = [];
    y = K.drawStock(y);
    if (pass <= 3) check(y.score === 100, 'draw 3: pass ' + pass + ' of the stock is free');
    else check(y.score === 80, 'draw 3: later passes cost 20');
  }
  const none = K.newState([], 1);
  check(K.drawStock(none) === null, 'nothing to draw or recycle is not a move');
}
{ // win and auto finish
  const s = K.almostWon(1);
  check(!K.isWon(s) && K.canAutoFinish(s), 'one move from a Klondike win; nothing is face down');
  const step = K.autoFinishStep(s);
  check(step && step.from === 't0' && step.to === 'f3', 'auto finish finds the last king');
  check(K.isWon(K.applyMove(s, step.from, step.idx, step.to)), 'and the last king up wins Klondike');
  const g = K.newState(deck, 1);
  check(!K.canAutoFinish(g), 'a fresh deal cannot auto finish');
}
check(K.timeBonus(10) === 0 && K.timeBonus(100) === 7000 && K.timeBonus(700) === 1000, 'time bonus is 700000 / seconds from 30 s on');

// ── Undo, through the session ───────────────────────────────────────────────
{
  const board = { renders: 0, render() { this.renders++; }, clearSelection() {}, cascade() {} };
  const els = { undo: fakeEl(), newBtn: fakeEl(), menu: fakeEl(), stat: fakeEl() };
  const session = Z.createSession({ id: 'test', board, els, newGame() {}, openMenu() {}, statText: sec => Z.fmtTime(sec), cascadeOrder: () => [], winLines: () => [] });
  const start = K.newState(deck, 1);
  session.reset(start);
  check(els.undo.disabled === true, 'undo is off before the first move');
  const one = K.drawStock(start), two = K.drawStock(one);
  session.commit(one); session.commit(two);
  check(els.undo.disabled === false && session.state === two, 'moves are committed');
  session.undo();
  check(same(session.state, one), 'undo returns to the state before the last move');
  session.undo();
  check(same(session.state, start) && els.undo.disabled === true, 'undo is unlimited, back to the deal');
  session.undo();
  check(same(session.state, start), 'undo at the start does nothing');
  session.commit(one); session.follow(two); session.undo();
  check(same(session.state, start), 'an auto-move is undone together with the move that led to it');
}

// ── Faces, backs, the Moon ──────────────────────────────────────────────────
check(deck.every(c => /^<svg[\s\S]*<\/svg>$/.test(Z.faceMarkup(c, false)) && !/NaN|undefined/.test(Z.faceMarkup(c, true))), 'all 52 faces draw, as page markup and as standalone images');
check(Z.faceMarkup(id('7H'), false).split('<use').length - 1 === 7 + 2 + 2, 'a 7 shows 7 pips, a small suit in each corner, and the small-card index and body');
check(Z.faceMarkup(id('7H'), true).split('<use').length === 1, 'a standalone face has no sprite references');
check(Z.faceMarkup(id('AS'), true).includes('zc-g-mark') && !Z.faceMarkup(id('AH'), true).includes('url(#zc-g-mark)'), 'only the Ace of Spades carries the mark');
var italian = []; for (var ii = 0; ii < 40; ii++) italian.push(ii);
check(italian.every(c => /^<svg[\s\S]*<\/svg>$/.test(Z.italianFaceMarkup(c, false)) && !/NaN|undefined/.test(Z.italianFaceMarkup(c, true))), 'all 40 Italian faces draw');
check(Z.italianName(19) === 're of cups' && Z.italianName(0) === 'ace of coins', 'Italian cards are named in their own suits');
check(!/NaN|undefined/.test(Z.jokerMarkup(true, false) + Z.jokerMarkup(false, true)), 'both jokers draw');
check(/^<svg[\s\S]*<\/svg>$/.test(Z.markSvg()) && Z.markSvg().includes('aria-label="ZimiGames"') && !/NaN|undefined/.test(Z.markSvg()) && Z.BACKS[0].id === 'zimi', 'the pebble mark and the Zimi back exist');
check(Z.faceMarkup(id('AS'), true).includes('xmlns'), 'the standalone face is a complete SVG document');
Z.BACKS.forEach(b => check(Z.backMarkup(b.id).includes('zc-bk') && !/NaN|undefined/.test(Z.backMarkup(b.id)), 'the ' + b.name + ' back draws'));
check(Z.BACKS.length >= 4, 'at least four animated backs plus the classic one');

const phase = iso => Z.moonPhase(new Date(iso));
check(Math.abs(phase('2000-01-06T18:14:00Z')) < 0.01 || phase('2000-01-06T18:14:00Z') > 0.99, 'the Moon is new at the reference new moon');
check(Math.abs(phase('2024-01-25T17:54:00Z') - 0.5) < 0.04, 'the Moon is about full on 2024-01-25 (a real full moon)');
check(Math.abs(phase('2024-04-08T18:21:00Z') - 0) < 0.04 || phase('2024-04-08T18:21:00Z') > 0.96, 'and about new on 2024-04-08 (the eclipse)');
check(phase('2026-10-23T12:00:00Z') >= 0 && phase('1990-01-01T00:00:00Z') < 1 && phase('1990-01-01T00:00:00Z') >= 0, 'the phase is always in [0, 1)');
check(Z.moonLitPath(0.25, 0, 0, 10).includes('A0 10') && Z.moonLitPath(0.5, 0, 0, 10).includes('A10 10'), 'half moon has a straight terminator, full moon a round one');
check(/^M0 -10A10 10 0 0 1 0 10A/.test(Z.moonLitPath(0.1, 0, 0, 10)) && /^M0 -10A10 10 0 0 0 0 10A/.test(Z.moonLitPath(0.9, 0, 0, 10)), 'waxing is lit on the right, waning on the left');

// ── Shared rules ────────────────────────────────────────────────────────────
check(Z.foundationAccepts(id('AH'), null, 0) && !Z.foundationAccepts(id('2H'), null, 0), 'only an ace starts a foundation');
check(Z.stacksOn(id('7S'), id('6H')) && !Z.stacksOn(id('7S'), id('6C')) && !Z.stacksOn(id('7S'), id('5H')), 'stacking is opposite colour, one rank down');
check(Z.fmtTime(0) === '0:00' && Z.fmtTime(75) === '1:15' && Z.fmtTime(3600) === '1:00:00' && Z.fmtTime(-5) === '0:00', 'times read m:ss, with hours from an hour');
check(Z.shuffled(() => 0.5).length === 52 && new Set(Z.shuffled(Math.random)).size === 52, 'a shuffle keeps all 52');

// ── The court cards: public-domain art (courts.js), recoloured to the card palette ──
{
  const palette = new Set(['#b3261e', '#1b1b1b', '#e09400', '#1d3b7a', '#2f5ca8', '#fdfcf8', 'none']);
  const courtIds = [];
  for (let su = 0; su < 4; su++) for (const r of [11, 12, 13]) courtIds.push(su * 13 + r - 1);
  const faces = courtIds.map(c => Z.faceMarkup(c, false));
  check(faces.every(f => f.includes('viewBox="0 0 1300 2000"') && f.includes('zc-small')), 'all twelve French courts carry the courts.js art and a small-card figure');
  check(new Set(faces).size === 12, 'the twelve French courts are twelve different drawings');
  const colours = new Set();
  faces.forEach(f => (f.match(/(?:fill|stroke)="(#[0-9a-fA-F]{3,6}|none)"/g) || []).forEach(m => colours.add(m.split('"')[1].toLowerCase())));
  check([...colours].every(c => palette.has(c)), 'the courts use only the card palette (' + [...colours].join(' ') + ')');
  const bytes = fs.statSync(path.join(dir, 'courts.js')).size;
  check(bytes < 200 * 1024, 'courts.js stays under 200 KB (' + Math.round(bytes / 1024) + ' KB)');
  const ace = Z.faceMarkup(id('AS'), false);
  check(!ace.includes('viewBox="0 0 1300 2000"'), 'the Ace of Spades keeps its own drawing');
}

console.log(failures ? failures + ' failure(s)' : 'all passed');
process.exit(failures ? 1 : 0);
