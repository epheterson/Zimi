// ZimiGames: people sharing one device. The seat kinds, remembered names, the handoff
// rule (who needs a "Pass to" screen), the rotated table, and the handoff itself in a
// tiny fake DOM. Run: node tests/test_games_hotseat.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
let failures = 0, passed = 0;
const check = (ok, label) => {
  if (ok) { passed++; console.log('ok: ' + label); } else { console.error('FAIL: ' + label); failures++; }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A little fake DOM: enough for the handoff screen and the Players rows.
function fakeDom() {
  const body = { kids: [], appendChild(n) { this.kids.push(n); n.parent = this; return n; } };
  function node(tag) {
    const n = {
      tag, kids: [], className: '', textContent: '', dataset: {}, attrs: {}, handlers: {}, hidden: false, value: '',
      appendChild(c) { this.kids.push(c); c.parent = this; return c; },
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, f) { this.handlers[t] = f; },
      focus() { doc.activeElement = this; }, blur() {}, remove() { if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this); },
      get children() { return this.kids; }
    };
    return n;
  }
  const doc = {
    body, head: node('head'), documentElement: node('html'), activeElement: null,
    createElement: node, getElementById: () => null,
    querySelector(sel) { return sel === '.zs-cover' ? body.kids.find((k) => k.className === 'zs-cover') || null : null; }
  };
  return doc;
}
function load(storageInit) {
  const store = Object.assign({}, storageInit);
  const sandbox = {
    console, document: fakeDom(),
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(dir, 'text.js'), 'utf8'), sandbox, { filename: 'text.js' });
  vm.runInContext(fs.readFileSync(path.join(dir, 'handoff.js'), 'utf8'), sandbox, { filename: 'handoff.js' });
  return { S: sandbox.ZimiSeats, store, doc: sandbox.document };
}

// ── seat kinds ──
{
  const { S } = load({});
  check(same(S.cleanKinds(undefined, 4), ['person', 'cpu', 'cpu', 'cpu']), 'default: one person, the rest computers');
  check(same(S.cleanKinds(['cpu', 'cpu', 'cpu', 'cpu'], 4), ['person', 'cpu', 'cpu', 'cpu']), 'a table with no person gets one');
  check(same(S.cleanKinds(['person', 'person', 'bogus'], 4), ['person', 'person', 'cpu', 'cpu']), 'unknown kinds become computers; short lists are padded');
  check(same(S.cleanKinds(['cpu', 'person'], 2), ['cpu', 'person']), 'the person can sit in any seat');
  check(same(S.peopleOf(['person', 'cpu', 'person']), [0, 2]), 'peopleOf lists the person seats');
}

// ── names ──
{
  const { S } = load({});
  check(S.cleanName('  Ava   Lee  ', 0) === 'Ava Lee', 'names are trimmed and squeezed');
  check(S.cleanName('', 2) === 'Player 3', 'an empty name falls back to Player N');
  check(S.cleanName('x'.repeat(40), 0).length === 14, 'names are capped at 14 characters');
  const saved = load({ 'zimi.games.players': JSON.stringify(['Ava', '', 'Cy']) });
  check(same(saved.S.loadNames(4), ['Ava', 'Player 2', 'Cy', 'Player 4']), 'remembered names load, blanks fall back');
  const broken = load({ 'zimi.games.players': '{not json' });
  check(same(broken.S.loadNames(2), ['Player 1', 'Player 2']), 'broken storage falls back to defaults');
}

// ── the handoff rule ──
{
  const { S } = load({});
  const two = ['person', 'person', 'cpu', 'cpu'];
  check(S.needsCover(two, -1, 0) === true, 'two people: nobody has looked yet, the first person gets a handoff');
  check(S.needsCover(two, 0, 0) === false, 'two people: no handoff for the person already looking');
  check(S.needsCover(two, 0, 1) === true, 'two people: the other person gets a handoff');
  check(S.needsCover(two, 0, 2) === false, 'a computer seat never needs one');
  check(S.needsCover(['person', 'cpu', 'cpu', 'cpu'], -1, 0) === false, 'one person alone never sees a handoff');
  check(S.needsCover(['cpu', 'cpu', 'person', 'person'], 3, 2) === true, 'people in the back seats are covered too');
}

// ── the rotated table ──
{
  const { S } = load({});
  check(same([0, 1, 2, 3].map((s) => S.relOf(s, 0, 4)), [0, 1, 2, 3]), 'viewer in seat 0: the table is as dealt');
  check(same([0, 1, 2, 3].map((s) => S.relOf(s, 2, 4)), [2, 3, 0, 1]), 'viewer in seat 2: seat 2 is south, seat 0 north');
  check(S.relOf(1, 3, 4) === 2, 'viewer in seat 3: seat 1 is across');
  check(same([0, 1].map((s) => S.relOf(s, 1, 2)), [1, 0]), 'two seats: the other person is across');
  check(S.compassName(2, 1) === 'Zimi' && S.compassName(3, 2) === 'East' && S.compassName(4, 1) === 'West', 'compass names by seats at the table');
}

// ── a seat object over a fake page ──
{
  const { S, store, doc } = load({});
  let changes = 0;
  const seats = S.create({ id: 'hearts', seats: 4, onChange: () => { changes++; } });
  check(seats.person(0) && !seats.person(1) && !seats.hotseat(), 'defaults: you and three computers');
  check(seats.name(0) === 'You' && seats.name(1) === 'West' && seats.name(2) === 'North' && seats.name(3) === 'East', 'one person: You and the compass names, as before');
  let ran = 0;
  seats.begin(() => { ran++; });
  check(ran === 1 && doc.querySelector('.zs-cover') === null, 'one person: a new game runs at once, no handoff');

  seats.setKind(2, 'person'); seats.setName(0, 'Ava'); seats.setName(2, 'Cy');
  check(same(JSON.parse(store['zimi.games.hearts.seats']).kinds, ['person', 'cpu', 'person', 'cpu']), 'seat kinds are remembered per game');
  check(same(JSON.parse(store['zimi.games.players']).slice(0, 3), ['Ava', 'Player 2', 'Cy']), 'names are remembered for every game');
  check(seats.hotseat() && seats.name(0) === 'Ava' && seats.name(2) === 'Cy' && seats.name(1) === 'West', 'two people: their names, the computer by place');

  ran = 0;
  seats.begin(() => { ran++; });
  const cover = doc.querySelector('.zs-cover');
  check(cover !== null && ran === 0, 'two people: a new game waits behind the handoff');
  const card = cover.kids[0], text = JSON.stringify(card.kids.map((k) => k.textContent));
  check(text.indexOf('Ava') >= 0 && text.indexOf('Pass to') >= 0, 'the handoff names who it is for');
  const button = card.kids.find((k) => k.tag === 'button');
  check(button.textContent === "I'm Ava, show my cards", 'the button says who is taking the screen');
  check(cover.attrs['aria-modal'] === 'true' && cover.attrs.role === 'dialog', 'the handoff is a modal dialog');
  let prevented = 0;
  cover.handlers.keydown({ key: 'Escape', stopPropagation() {}, preventDefault() { prevented++; } });
  check(doc.querySelector('.zs-cover') !== null && prevented === 1, 'Escape does not dismiss the handoff');
  seats.cover(2, () => { throw new Error('a second handoff must not stack'); });
  check(doc.body.kids.filter((k) => k.className === 'zs-cover').length === 1, 'only one handoff at a time');
  button.handlers.click();
  check(doc.querySelector('.zs-cover') === null && ran === 1 && seats.view() === 0 && changes >= 1, 'tapping shows the cards: the viewer is set, the game goes on');

  check(seats.needsCover(2) && !seats.needsCover(0) && !seats.needsCover(1), 'then only the other person needs a handoff');
  check(same([0, 1, 2, 3].map((s) => seats.rel(s)), [0, 1, 2, 3]), 'the table is seen from Ava');
  let after = 0;
  seats.ensure(2, () => { after++; });
  doc.body.kids.find((k) => k.className === 'zs-cover').kids[0].kids.find((k) => k.tag === 'button').handlers.click();
  check(after === 1 && seats.view() === 2 && same([0, 1, 2, 3].map((s) => seats.rel(s)), [2, 3, 0, 1]), 'Cy takes the screen: the table turns so Cy is south');
  let direct = 0;
  seats.ensure(2, () => { direct++; });
  check(direct === 1 && doc.querySelector('.zs-cover') === null, 'ensure runs straight through for the person already looking');
  seats.ensure(1, () => { direct++; });
  check(direct === 2 && doc.querySelector('.zs-cover') === null, 'ensure runs straight through for a computer seat');
  seats.begin(() => {});
  check(seats.view() === 0 && doc.querySelector('.zs-cover') !== null, 'a new deal forgets who was looking and covers again');
}

// ── a seat game with the person in a back seat, and storage that throws ──
{
  const { S } = load({ 'zimi.games.gin.seats': JSON.stringify({ kinds: ['cpu', 'person'] }) });
  const seats = S.create({ id: 'gin', seats: 2 });
  check(seats.view() === 1 && seats.rel(1) === 0 && seats.rel(0) === 1, 'one person in seat 1 sits south, the computer across');
  check(seats.name(1) === 'You' && seats.name(0) === 'Zimi', 'names follow the table (the one computer at a two-seat table is Zimi)');
  const sandbox = { console, document: fakeDom(), localStorage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } };
  sandbox.window = sandbox; vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(dir, 'text.js'), 'utf8'), sandbox, { filename: 'text.js' });
  vm.runInContext(fs.readFileSync(path.join(dir, 'handoff.js'), 'utf8'), sandbox);
  const s2 = sandbox.ZimiSeats.create({ id: 'x', seats: 2 });
  s2.setKind(1, 'person'); s2.setName(0, 'Zed');
  check(s2.hotseat() && s2.name(0) === 'Zed', 'blocked storage: the choices still work for this visit');
}

// ── the Players rows ──
{
  const { S } = load({});
  const seats = S.create({ id: 'spades', seats: 4 });
  const box = seats.block();
  const rows = box.kids.filter((k) => k.className === 'gs-row gs-seat-row');
  check(rows.length === 4, 'the Players block has a row per seat');
  const kindButtons = rows[1].kids[1].kids;
  check(same(kindButtons.map((b) => b.textContent), ['Computer', 'Person']), 'each seat offers Computer or Person');
  check(kindButtons[0].attrs['aria-pressed'] === 'true' && kindButtons[1].attrs['aria-pressed'] === 'false', 'the computer is the default');
  check(rows[1].kids[2].hidden === true && rows[0].kids[2].hidden === true, 'name boxes stay hidden while one person plays');
  kindButtons[1].handlers.click();
  check(seats.person(1) && rows[0].kids[2].hidden === false && rows[1].kids[2].hidden === false, 'a second person: names appear');
  check(rows[2].kids[2].hidden === true, 'a computer seat has no name box');
}

// ── Hearts: the table seen by the person in seat 2, hands hidden between people ──
{
  const sb = { console, Date, setTimeout, clearTimeout, setInterval, clearInterval,
    document: { addEventListener() {}, querySelector: () => null, getElementById: () => null, documentElement: { classList: { toggle() {} } }, hidden: false } };
  sb.window = sb; vm.createContext(sb);
  for (const f of ['text.js', 'cardbacks.js', 'courts.js', 'cards.js', 'cardtable.js', 'hearts.js']) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sb, { filename: f });
  const H = sb.ZimiHearts, Z = sb.ZimiCards;
  const lcg = (seed) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const st = H.newGame(Z.shuffled(lcg(7)));
  const m = { W: 390, H: 790, pad: 8, gap: 5, left: 8, cw: 48, ch: 67, step: 44, cols: 7 };
  const mine = (pl) => pl.cards.filter((c) => c.pile[0] === 'h');
  const seen = (pl) => pl.cards.filter((c) => c.up && c.pile[0] === 'h').map((c) => c.id);
  const a = H.place(st, m, { chosen: [], sweep: null });
  check(same(seen(a), st.hands[0]) && mine(a).length === 13, 'Hearts: by default your own hand is the one face up');
  const b = H.place(st, m, { chosen: [], sweep: null, viewer: 2, hideHand: false });
  check(same(seen(b).slice().sort((x, y) => x - y), st.hands[2].slice().sort((x, y) => x - y)), 'Hearts: the person in seat 2 sees seat 2\'s hand and no other');
  const left = b.cards.filter((c) => c.pile === 'p1').map((c) => c.id), across = b.cards.filter((c) => c.pile === 'p2').map((c) => c.id);
  check(same(left.slice().sort((x, y) => x - y), st.hands[3].slice().sort((x, y) => x - y)) && same(across.slice().sort((x, y) => x - y), st.hands[0].slice().sort((x, y) => x - y)), 'Hearts: from seat 2, seat 3 is on the left and seat 0 across');
  const hid = H.place(st, m, { chosen: [], sweep: null, viewer: 1, hideHand: true });
  check(hid.cards.filter((c) => c.up).length === 0, 'Hearts: between turns every card is face down, including the viewer\'s');
  check(hid.cards.length === 52 && hid.slots.filter((x) => x.id[0] === 'h').length === 13, 'Hearts: hidden or not, all 52 cards are placed');
  const mid = H.playCard(Object.assign(H.dealHand(Z.shuffled(lcg(9)), 3, [0, 0, 0, 0]), {}), 0, H.dealHand(Z.shuffled(lcg(9)), 3, [0, 0, 0, 0]).hands[0][0]);
  const played = H.place(Object.assign({}, mid, { trick: [{ seat: 3, id: mid.trick[0].id }] }), m, { chosen: [], sweep: null, viewer: 3, hideHand: false });
  const spot = played.cards.find((c) => c.pile === 'trick');
  check(spot && spot.x < 195, 'Hearts: the viewer\'s own card in the trick sits at the bottom of the middle');
}

console.log(passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
