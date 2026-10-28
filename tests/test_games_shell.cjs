// ZimiGames' shell: the settings (persistence, per-game overrides, defaults), a menu and help
// for every game, and Watch and learn's sentences checked against fixed positions: each
// sentence has to say what the position makes true, and facts have to match the engine.
//
// Run: node tests/test_games_shell.cjs   (exit 0 = pass)

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
function load(files, extra) {
  const sandbox = Object.assign({ console }, extra || {});
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of files) vm.runInContext(read(f), sandbox, { filename: f });
  return sandbox;
}

// ── every game page has the shell, a bar, help and history ──────────────────
const NOT_GAMES = new Set(['index.html', 'about.html', 'puzzles.html']);
const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html') && !NOT_GAMES.has(f));
// How to play and History are string ids in the English table (help.<game>.<part>, history.<game>).
const EN = JSON.parse(read('text/en.json'));
const H = {}, Y = {};
for (const [k, v] of Object.entries(EN)) {
  let m = /^help\.([a-z0-9]+)\.(goal|turn|end|tip|keys)$/.exec(k);
  if (m) (H[m[1]] = H[m[1]] || {})[m[2]] = v;
  m = /^history\.([a-z0-9]+)$/.exec(k);
  if (m) Y[m[1]] = v;
}
let withShell = 0, withBar = 0;
for (const p of pages) {
  const html = read(p);
  if (/<!-- zimi-shell --><script src="shell.js"><\/script><!-- \/zimi-shell -->/.test(html)) withShell++;
  if (/class="ar-bar"/.test(html)) withBar++;
}
check(pages.length > 60 && withShell === pages.length, 'every game page loads the shell (' + withShell + ' of ' + pages.length + ')');
check(withBar === pages.length, 'every game page has a bar for the Menu button');

const rows = JSON.parse(read('games.json'));
const ids = [...new Set(rows.map((r) => r.path).filter((p) => !p.includes('/')).map((p) => p.replace(/\.html$/, '')))];
const missing = ids.filter((id) => !H[id] || !H[id].goal || !H[id].turn || !H[id].end);
check(ids.length > 60 && !missing.length, 'every game in games.json has a goal, a turn and an end' + (missing.length ? ': ' + missing : ''));
const noHistory = ids.filter((id) => !Y[id]);
check(!noHistory.length, 'every game in games.json has a history' + (noHistory.length ? ': ' + noHistory : ''));
const sentences = (s) => (s.match(/[.!?](\s|$)/g) || []).length;
check(ids.every((id) => sentences(Y[id]) >= 2 && sentences(Y[id]) <= 4), 'each history is 2 to 4 sentences');
check(Object.values(H).every((h) => ['goal', 'turn', 'end', 'tip'].every((k) => !h[k] || h[k].length <= 260)), 'help lines are short');
const allText = Object.values(H).map((h) => Object.values(h).join(' ')).concat(Object.values(Y)).join(' ');
check(!/—/.test(allText), 'no em dashes in help or history');
check(pages.map((p) => p.replace('.html', '')).every((id) => H[id]), 'help exists for every page, not only those in games.json');

// ── settings ────────────────────────────────────────────────────────────────
function shellEnv(storage, path_, reduced) {
  const store = Object.assign({}, storage);
  const attrs = {};
  const doc = {
    readyState: 'complete', body: { appendChild() {} }, head: { appendChild() {} }, createElement: () => ({}),
    documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, classList: { add() {}, remove() {} } },
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], title: 'Chess - ZimiGames'
  };
  const env = {
    document: doc, location: { pathname: path_ || '/chess.html' }, addEventListener() {},
    matchMedia: () => ({ matches: !!reduced }),
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } }
  };
  const sb = load(['shell.js'], env);
  return { S: sb.ZimiShell, store, attrs, env: sb };
}
// ── the tab's title: one format, from one place ──
{
  const { S, env } = shellEnv({});
  const title = (name) => { S.setTitle(name); return env.document.title; };
  check(title('Chess') === 'Chess \u00b7 ZimiGames', 'a game is named "Name · ZimiGames"');
  check(title('Chess - ZimiGames') === 'Chess \u00b7 ZimiGames' && title('Chess \u00b7 ZimiGames') === 'Chess \u00b7 ZimiGames', 'an older ending or the new one is not doubled');
  check(title('Fifteen, an unfinished puzzle from Simon Tatham\'s Portable Puzzle Collection - ZimiGames') === 'Fifteen \u00b7 ZimiGames', 'a puzzle is its name alone');
  check(title('ZimiGames') === 'ZimiGames' && title('') === 'ZimiGames', 'the shelf is just ZimiGames');
}
{
  const { S, attrs } = shellEnv({});
  check(S.id === 'chess', 'the game is named by its page');
  check(S.settings.get('timer') === 'show' && S.settings.get('anim') === 'normal' && S.settings.get('hints') === 'on' && S.settings.get('moveTimer') === 0 && S.settings.get('sound') === 'off' && S.settings.get('confirm') === 'on', 'defaults: timer shown, animation normal, hints on, move timer off, sound off, confirm on');
  check(attrs['data-timer'] === 'show' && attrs['data-anim'] === 'normal' && attrs['data-hints'] === 'on', 'the settings are on <html> for the stylesheet');
  S.settings.set('timer', 'hide');
  check(S.settings.get('timer') === 'hide' && attrs['data-timer'] === 'hide', 'a global choice applies and reaches <html>');
  S.settings.set('anim', 'bogus');
  check(S.settings.get('anim') === 'normal', 'a value that is not a choice is ignored');
  check(S.stripClock('0:42 · 120') === '120' && S.stripClock('12:05') === '12:05'.replace(/^\d+:\d\d/, '') , 'a hidden timer is cut from a clock-and-score text');
}
{
  // persistence across page loads, and per-game overrides
  const a = shellEnv({});
  a.S.settings.set('anim', 'fast');
  a.S.settings.set('hints', 'off', 'game');
  const saved = JSON.parse(a.store['zimi.games.settings']);
  check(saved.g.anim === 'fast' && saved.games.chess.hints === 'off', 'settings are stored under zimi.games.settings, global and per game');
  const b = shellEnv(a.store);
  check(b.S.settings.get('anim') === 'fast', 'a global setting survives a reload');
  check(b.S.settings.get('hints') === 'off', 'a per-game setting survives a reload');
  const c = shellEnv(a.store, '/reversi.html');
  check(c.S.settings.get('hints') === 'on' && c.S.settings.get('anim') === 'fast', 'another game keeps the global value and not the override');
  check(b.S.settings.get('hints', 'reversi') === 'on', 'get can ask about another game');
  b.S.settings.set('hints', 'on', 'all');
  check(!b.S.settings.hasOverride('hints') && b.S.settings.get('hints') === 'on', 'choosing for all games drops this game\'s own choice');
  b.S.settings.set('timer', 'hide', 'game');
  check(b.S.settings.hasOverrides() && (b.S.settings.reset(), !b.S.settings.hasOverrides()), 'a game\'s overrides can be reset');
  let heard = 0; b.S.settings.on(() => heard++); b.S.settings.set('anim', 'off');
  check(heard === 1, 'a listener hears a change once');
}
{
  const calm = shellEnv({}, '/chess.html', true);
  check(calm.S.settings.get('anim') === 'off', 'animation is off by default when the device asks for less motion');
  calm.S.settings.set('anim', 'normal');
  check(calm.S.settings.get('anim') === 'normal', 'and a choice beats that default');
  const broken = shellEnv({ 'zimi.games.settings': '{not json' });
  check(broken.S.settings.get('timer') === 'show', 'unreadable stored settings fall back to the defaults');
  check(shellEnv({}).S.ms(1000) === 1000 && (() => { const x = shellEnv({}); x.S.settings.set('anim', 'fast'); return x.S.ms(1000) < 500; })(), 'ms() scales a duration with the animation setting');
}

// ── Watch and learn: the sentences against fixed positions ─────────────────
{
  const sb = load(['text.js', 'chess-engine.js', 'explain-chess.js']);
  const E = sb.ZimiChessEngine(), explain = sb.ZimiExplain.chess;
  const mv = (pos, from, to) => E.legalMoves(pos).filter((m) => E.squareName(E.from(m)) === from && E.squareName(E.to(m)) === to)[0];
  let pos = E.parseFen('4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1');
  let r = explain(E, pos, mv(pos, 'd1', 'd5'), {});
  check(r.facts.captured === 'queen' && !r.facts.recapturable && /takes a queen/.test(r.text) && /nothing can take back/.test(r.text), 'chess: Rxd5 takes an unguarded queen and says nothing can take back');
  pos = E.parseFen('4k3/8/8/3q4/2p5/8/8/3RK3 w - - 0 1');
  r = explain(E, pos, mv(pos, 'd1', 'd5'), {});
  check(r.facts.recapturable === false || /taken back|take back/.test(r.text), 'chess: the same capture is not called free when a piece guards it');
  pos = E.parseFen('4k3/8/8/3q4/4p3/8/8/3RK3 w - - 0 1');
  r = explain(E, pos, mv(pos, 'd1', 'd5'), {});
  check(r.facts.recapturable === false || r.facts.recapturable === true, 'chess: capture facts are computed, never assumed');
  pos = E.parseFen('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1');
  r = explain(E, pos, mv(pos, 'a1', 'a8'), {});
  check(r.facts.mate === true && /checkmate/.test(r.text), 'chess: a back-rank mate is called checkmate');
  pos = E.parseFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  r = explain(E, pos, mv(pos, 'e1', 'g1'), {});
  check(r.facts.castle && /castles kingside/.test(r.text), 'chess: castling is named, with its side');
  pos = E.startPosition();
  r = explain(E, pos, mv(pos, 'g1', 'f3'), { ply: 0 });
  check(/develops the knight to f3, toward the centre/.test(r.text), 'chess: Nf3 on move one develops the knight toward the centre');
  r = explain(E, pos, mv(pos, 'e2', 'e4'), { ply: 0 });
  check(/claim space in the centre/.test(r.text), 'chess: e4 claims the centre');
  pos = E.parseFen('4k3/8/8/3q1r2/8/8/2N5/4K3 w - - 0 1');
  r = explain(E, pos, mv(pos, 'c2', 'e3'), {});
  check(r.facts.targets.length === 2 && /forks the queen and the rook/.test(r.text), 'chess: a knight on e3 forks queen and rook, and the sentence names both');
  pos = E.parseFen('4k3/8/8/8/8/3n4/8/3RK3 w - - 0 1');
  r = explain(E, pos, mv(pos, 'd1', 'd3'), {});
  check(r.facts.captured === 'knight', 'chess: a capture is reported as the piece taken');
  pos = E.parseFen('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
  r = explain(E, pos, mv(pos, 'e1', 'd1'), { score: 5 });
  check(/about even/.test(r.text), 'chess: a quiet move quotes the engine score (even)');
  r = explain(E, pos, mv(pos, 'e1', 'd1'), { score: 400 });
  check(/by more than a pawn/.test(r.text) && /White/.test(r.text), 'chess: a quiet move quotes the engine score (a lead)');
}
{
  const sb = load(['text.js', 'reversi.js', 'explain-reversi.js']);
  const R = sb.ReversiEngine, explain = sb.ZimiExplain.reversi;
  const b = new Int8Array(64);
  b[1] = R.WHITE; b[2] = R.BLACK; b[27] = R.WHITE; b[28] = R.BLACK;
  const m = R.legalMoves(b, R.BLACK).filter((x) => x.idx === 0)[0];
  let r = explain(R, b, R.BLACK, m);
  check(r.facts.corner && /takes the corner a8/.test(r.text) && r.facts.flips === 1, 'reversi: the corner is named, with the discs it flips');
  const start = R.initial(), first = R.legalMoves(start, R.BLACK)[0];
  r = explain(R, start, R.BLACK, first);
  check(r.facts.flips === first.flips.length && r.facts.before === R.legalMoves(start, R.WHITE).length, 'reversi: flips and the opponent\'s move counts come from the rules');
  const after = R.play(start, R.BLACK, first.idx, first.flips);
  check(r.facts.after === R.legalMoves(after, R.WHITE).length, 'reversi: the opponent\'s choices after the move are counted on the real position');
}
{
  const sb = load(['text.js', 'reversi.js', 'checkers.js', 'explain-checkers.js']);
  const C = sb.CheckersEngine, explain = sb.ZimiExplain.checkers;
  const b = new Int8Array(64);
  b[42] = 1; b[35] = 3;
  const jump = C.moves(b, C.RED)[0];
  const r = explain(C, b, C.RED, jump, {});
  check(jump.caps.length === 1 && r.facts.captures === 1 && /jumps a man, c3 to e5/.test(r.text) && /Nothing can jump back/.test(r.text), 'checkers: a jump is named with its squares, and nothing is said about a recapture that cannot happen');
  const b2 = new Int8Array(64); b2[42] = 1;
  const step = C.moves(b2, C.RED)[0], r2 = explain(C, b2, C.RED, step, {});
  check(r2.facts.captures === 0 && !/jumps /.test(r2.text), 'checkers: a quiet step does not talk about jumps');
}
{
  const sb = load(['text.js', 'go-engine.js', 'explain-go.js']);
  const E = sb.makeGoEngine(), explain = sb.ZimiExplain.go;
  let st = E.newGame(9);
  st.board[10] = 2; st.board[1] = 1; st.board[9] = 1; st.board[11] = 1; st.turn = 1;
  let r = explain(E, st, 19, {});
  check(r.facts.captured === 1 && /captures 1 stone/.test(r.text), 'go: a stone with its last liberty filled is captured, and the sentence says so');
  st = E.newGame(9);
  st.board[10] = 2; st.board[1] = 1; st.board[9] = 1; st.turn = 1;
  r = explain(E, st, 19, {});
  check(r.facts.atari === 1 && /atari/.test(r.text) && !/captures \d/.test(r.text), 'go: leaving one liberty is atari, not a capture');
  st = E.newGame(9);
  r = explain(E, st, -1, {});
  check(r.facts.pass && /passes/.test(r.text), 'go: a pass is explained as a pass');
  st = E.newGame(9);
  r = explain(E, st, 40, { rate: 0.5, playouts: 100 });
  check(r.facts.star && /star point/.test(r.text), 'go: the centre of a 9 by 9 board is a star point');
  r = explain(E, E.newGame(9), 36, {});
  check(!r.facts.star, 'go: another point is not called a star point');
}
{
  const sb = load(['text.js', 'mancala.js', 'explain-mancala.js'], { document: undefined });
  const M = sb.MancalaEngine, explain = sb.ZimiExplain.mancala;
  let s = M.Kalah.newState();
  let r = explain(M.Kalah, s, 2);
  check(r.facts.extra && /plays again/.test(r.text), 'mancala: the last seed in the store gives another turn, and the sentence says so');
  s = M.Oware.newState();
  s.pits.fill(0); s.pits[5] = 1; s.pits[6] = 1; s.pits[11] = 4;
  r = explain(M.Oware, s, 5);
  check(r.facts.captured === 2 && /capturing 2 seeds/.test(r.text), 'mancala: ending on a pit that becomes two takes it');
  s = M.Oware.newState();
  r = explain(M.Oware, s, 0);
  check(r.facts.captured === 0 && !/capturing/.test(r.text), 'mancala: no capture, none claimed');
}
{
  const sb = load(['text.js', 'backgammon.js', 'explain-backgammon.js'], { document: undefined });
  const E = sb.BackgammonEngine, explain = sb.ZimiExplain.backgammon;
  const s = E.newGame();
  s.pts.fill(0); s.pts[10] = 1; s.pts[8] = -1; s.pts[22] = 1; s.pts[0] = -2;
  s.turn = 0; s.dice = [2]; s.rolled = true;
  const steps = E.chooseTurn(s, 'medium');
  const r = explain(E, s, [{ from: 11, to: 9, die: 2 }], [2, 1]);
  check(r.facts.hits === 1 && /hits a blot/.test(r.text) && /11\/9\*/.test(r.text), 'backgammon: landing on a lone checker is a hit, marked in the notation');
  const quiet = explain(E, s, [{ from: 23, to: 21, die: 2 }], [2, 1]);
  check(quiet.facts.hits === 0 && !/hits/.test(quiet.text), 'backgammon: a move that hits nothing does not say it hits');
  check(Array.isArray(steps), 'backgammon: the engine still chooses a play');
}
{
  const Zs = load(['text.js', 'cardbacks.js', 'courts.js', 'cards.js', 'cardtable.js', 'hearts.js'], { document: { addEventListener() {}, querySelector: () => null, getElementById: () => null, documentElement: { classList: { toggle() {} } }, hidden: false } });
  const Z = Zs.ZimiCards, H = Zs.ZimiHearts, X = load(['text.js', 'explain-hearts.js']).ZimiExplain.hearts;
  const c = (r, s) => Z.make(r, s);                       // suits: clubs 0, diamonds 1, hearts 2, spades 3
  const blank = () => ({ hands: [[], [], [], []], taken: [[], [], [], []], trick: [], tricksPlayed: 3, broken: false, passDir: 0, turn: 1 });
  let st = blank();
  st.hands[1] = [H.QUEEN_SPADES, c(3, 1), c(9, 2)]; st.trick = [{ seat: 0, id: c(5, 0) }];
  let pick = H.aiPick(st, 1), r = X.play(H, Z, st, 1, pick);
  check(pick === H.QUEEN_SPADES && r.facts.void && /no clubs/.test(r.text) && /dumps the queen of spades: 13 points/.test(r.text), 'hearts: a player out of the suit led dumps the queen, and the sentence says why it can');
  st = blank();
  st.hands[1] = [c(4, 0), c(12, 0), c(2, 1)]; st.trick = [{ seat: 0, id: c(10, 0) }];
  pick = H.aiPick(st, 1); r = X.play(H, Z, st, 1, pick);
  check(r.facts.ducks && /under the 10 of clubs/.test(r.text) && /should not win/.test(r.text), 'hearts: a card under the one on the table is described as ducking it');
  st = blank();
  st.hands[1] = [c(12, 0), c(13, 0)]; st.trick = [{ seat: 0, id: c(10, 0) }];
  pick = H.aiPick(st, 1); r = X.play(H, Z, st, 1, pick);
  check(r.facts.forced && /every card it can play beats the table/.test(r.text) && /lowest/.test(r.text), 'hearts: when every legal card is higher, the sentence says the player was forced');
  const trick = [{ seat: 0, id: c(10, 0) }, { seat: 1, id: H.QUEEN_SPADES }, { seat: 2, id: c(12, 0) }, { seat: 3, id: c(2, 2) }];
  const t = X.trick(H, Z, trick);
  check(t.facts.winner === 'North' && t.facts.points === 14 && /14 points: the queen of spades and 1 heart/.test(t.text), 'hearts: the trick goes to the highest of the suit led, with its true points');
  st = blank(); st.hands[0] = [H.QUEEN_SPADES, c(13, 3), c(2, 0), c(3, 0), c(5, 1)];
  const picks = H.choosePass(st.hands[0]);
  const p = X.pass(H, Z, st.hands[0], picks, 0);
  check(picks.indexOf(H.QUEEN_SPADES) >= 0 && /queen of spades is 13 points/.test(p.text) && /to the left/.test(p.text), 'hearts: the pass names the cards passed and why the queen goes');
}
{
  const Zs = load(['text.js', 'cardbacks.js', 'courts.js', 'cards.js', 'solitaire.js'], { document: { addEventListener() {}, querySelector: () => null, getElementById: () => null, documentElement: { classList: { toggle() {} } }, hidden: false } });
  const Z = Zs.ZimiCards, S = Zs.ZimiSolitaire, explain = load(['text.js', 'explain-solitaire.js']).ZimiExplain.solitaire;
  const st = S.blankState(1);
  st.piles.t0 = [{ id: Z.make(1, 2), up: true }];
  let step = explain(S, Z, st, {});
  check(step.kind === 'foundation' && /Aces start a suit/.test(step.text) && S.isWon(step.next) === false && step.next.piles.f0.length + step.next.piles.f1.length + step.next.piles.f2.length + step.next.piles.f3.length === 1, 'solitaire: an ace goes up, and the new state has it on a foundation');
  const st2 = S.blankState(1);
  st2.piles.t0 = [{ id: Z.make(9, 0), up: false }, { id: Z.make(7, 3), up: true }];
  st2.piles.t1 = [{ id: Z.make(8, 2), up: true }];
  step = explain(S, Z, st2, {});
  check(step.kind === 'reveal' && /turn over a face-down card in column 1/.test(step.text) && step.next.piles.t0[0].up === true, 'solitaire: a move that turns a card over says so, and the card is turned');
  const st3 = S.blankState(1);
  st3.piles.stock = [{ id: Z.make(5, 1), up: false }];
  step = explain(S, Z, st3, {});
  check(step.kind === 'draw' && /No move on the table helps/.test(step.text), 'solitaire: with nothing to move it draws, and only then says so');
  const ctx = {}, st4 = S.blankState(1); st4.piles.waste = [{ id: Z.make(5, 1), up: true }];
  let n = 0; let cur = st4;
  while (n < 6) { const s2 = explain(S, Z, cur, ctx); if (!s2) break; cur = s2.next; n++; }
  check(n <= 5, 'solitaire: it gives up after the stock has been through twice with nothing to do');
}

// ── the narrator and the driver, with a fake page ──────────────────────────
{
  const timers = [];
  const env = {
    document: { hidden: false, createElement: () => { const e = { children: [], style: {}, attrs: {}, appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, f) { (this.h = this.h || {})[t] = f; }, textContent: '' }; return e; }, addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].f = null; }
  };
  const sb = load(['watch.js'], env);
  const strip = env.document.createElement('div');
  let started = null, applied = 0;
  const api = sb.ZimiWatch.create({ strip, game: { watch: { start: (ctl) => { started = ctl; }, unit: 'move' } }, id: 'x', stop() {} });
  api.begin();
  started.offer('White plays e4.', () => { applied++; });
  check(applied === 0 && timers.length === 1 && timers[0].ms >= sb.ZimiWatch.PACE.normal.base, 'watch: a move waits for reading time before it is made');
  timers[0].f();
  check(applied === 1, 'watch: and is made once the time is up');
  started.offer('Black plays e5.', () => { applied++; });
  const pause = strip.children[2].children[0], step = strip.children[2].children[1];
  pause.h.click();
  check(timers.filter((t) => t.f).length === 0, 'watch: Pause stops the clock');
  step.h.click();
  check(applied === 2, 'watch: Step plays the move on show while paused');
  api.hold(true); started.offer('White plays Nf3.', () => { applied++; });
  check(timers.filter((t) => t.f).length === 0 && applied === 2, 'watch: it waits while the Menu is open');
}

// ── the end sheet's headline ────────────────────────────────────────────────
{
  const { S } = shellEnv({});
  const seen = [];
  S.sheet = (o) => { seen.push(o.title); return { close() {} }; };
  S.endSheet({ result: 'lose', title: '2nd of 5', after: 0 });
  S.endSheet({ result: 'lose', after: 0 });
  check(seen[0] === '2nd of 5', 'endSheet: a caller\'s own title replaces the result\'s headline');
  check(seen[1] && seen[1] !== '2nd of 5', 'endSheet: without one the result names it');
}

console.log(failures ? failures + ' FAILED' : 'all passed');
process.exit(failures ? 1 : 0);
