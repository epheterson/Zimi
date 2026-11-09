/* ZimiGames: Snap, you against Zimi, with two decks. Each of you has a face-down stack of 52. In turn you each turn the top card
   of your stack onto your own pile. When the tops of the two piles are the same rank, the first to tap Snap takes both piles.
   A snap with no match costs you two of the cards you have won. When both stacks are used up, the most cards won wins.

   Zimi reacts like a person: on every level a different spread of reaction times (never quicker than a third of a second), and it
   sometimes misses a match altogether.

   State: stacks[2], piles[2] (the face-up cards, top last), won[2] (cards each has taken), turn (who turns next), phase
   ('play' | 'over'), note (the latest snap or false snap), moves, flips. Seat 0 is you, seat 1 is Zimi. Pure functions; the
   page wiring only runs in a browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, T = root.ZimiTable, TX = root.ZimiCards.T;

  var DECKS = 2, CARDS = 52 * DECKS, PENALTY = 2, LEVEL_KEY = 'snap.level', DEFAULT_LEVEL = 'medium';
  // How long a card shows before the next is turned, and how fast Zimi is: a reaction between `from` and `to` ms, missing the match
  // `miss` of the time.
  var LEVELS = {
    easy: { flip: 1700, from: 800, to: 1250, miss: 0.25 },
    medium: { flip: 1300, from: 520, to: 880, miss: 0.12 },
    hard: { flip: 1000, from: 360, to: 600, miss: 0.04 }
  };
  var rankOf = function (id) { return Z.rank(id); };
  var top = function (pile) { return pile[pile.length - 1]; };

  // ── Rules ───────────────────────────────────────────────────────────────
  // `order` is the shuffled double deck (ids 0 to 103; past 51 are copies of the same faces).
  function deal(order, first) {
    return { stacks: [order.slice(0, CARDS / 2), order.slice(CARDS / 2, CARDS)], piles: [[], []], won: [0, 0], turn: first || 0, phase: 'play', note: null, moves: 0, flips: 0 };
  }
  var isMatch = function (st) { return st.piles[0].length > 0 && st.piles[1].length > 0 && rankOf(top(st.piles[0])) === rankOf(top(st.piles[1])); };
  var cardsLeft = function (st) { return st.stacks[0].length + st.stacks[1].length; };
  // The next card is turned by whoever's turn it is who still has cards; the game ends when both stacks are empty.
  function flip(st) {
    if (st.phase !== 'play' || cardsLeft(st) === 0) return st;
    var s = Z.clone(st), seat = s.stacks[s.turn].length ? s.turn : 1 - s.turn;
    s.piles[seat].push(s.stacks[seat].pop());
    s.turn = 1 - seat; s.flips++; s.moves++; s.note = null;
    if (cardsLeft(s) === 0 && !isMatch(s)) s.phase = 'over';
    return s;
  }
  // The last card has had its moment: whatever is still on the piles stays there.
  function close(st) { var s = Z.clone(st); s.phase = 'over'; return s; }
  // A snap: a match takes both piles; no match loses two of your won cards (never below none).
  function snap(st, seat) {
    if (st.phase !== 'play') return st;
    var s = Z.clone(st);
    if (isMatch(s)) {
      var n = s.piles[0].length + s.piles[1].length;
      s.won[seat] += n; s.piles = [[], []]; s.note = { kind: 'snap', seat: seat, n: n };
    } else {
      var lost = Math.min(PENALTY, s.won[seat]);
      s.won[seat] -= lost; s.note = { kind: 'false', seat: seat, n: lost };
    }
    s.moves++;
    if (cardsLeft(s) === 0) s.phase = 'over';
    return s;
  }
  var winner = function (st) { return st.won[0] === st.won[1] ? -1 : st.won[0] > st.won[1] ? 0 : 1; };

  // ── The computer player ─────────────────────────────────────────────────
  // How long Zimi takes to snap a match on this level, or null when it does not see this one.
  function reaction(level, rng) {
    var L = LEVELS[level] || LEVELS[DEFAULT_LEVEL];
    rng = rng || Math.random;
    if (rng() < L.miss) return null;
    return Math.round(L.from + rng() * (L.to - L.from));
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  var SHOW_STACK = 2, BADGE_RISE = 28;
  var who = function (seat) { return seat ? root.ZimiText.ZIMI : TX('cards.you'); };
  function geo(m) { return T.geometry(m, 1); }
  // Zimi's stack at the top, yours at the bottom, the two piles side by side between them.
  function spots(g) {
    var y = Math.round(g.cy - g.ch / 2);
    return { stack: [{ x: Math.round(g.cx - g.cw / 2), y: g.southY }, { x: Math.round(g.cx - g.cw / 2), y: g.northY }], pile: [{ x: Math.round(g.cx + g.cw * 0.08), y: y }, { x: Math.round(g.cx - g.cw * 1.08), y: y }] };
  }
  function place(st, m) {
    var g = geo(m), p = spots(g), slots = [], cards = [];
    [0, 1].forEach(function (seat) {
      var stack = st.stacks[seat], pile = st.piles[seat];
      slots.push({ id: 'stack' + seat, x: p.stack[seat].x, y: p.stack[seat].y, w: g.cw, h: g.ch, quiet: true, label: TX('snap.stack', { who: who(seat), cards: Z.plural(stack.length, 'card') }) });
      slots.push({ id: 'pile' + seat, x: p.pile[seat].x, y: p.pile[seat].y, w: g.cw, h: g.ch, label: pile.length ? TX('snap.pile', { who: who(seat), card: Z.cardName(top(pile)) }) : TX('snap.pile.empty', { who: who(seat) }) });
      stack.forEach(function (id, k) { cards.push({ id: id, pile: 'stack' + seat, idx: k, x: p.stack[seat].x, y: p.stack[seat].y, up: false, hidden: k < stack.length - SHOW_STACK }); });
      pile.forEach(function (id, k) { cards.push({ id: id, pile: 'pile' + seat, idx: k, x: p.pile[seat].x, y: p.pile[seat].y, up: true, hidden: k < pile.length - 1, glow: isMatch(st) }); });
    });
    return { height: m.H, slots: slots, cards: cards };
  }

  var api = {
    CARDS: CARDS, PENALTY: PENALTY, LEVELS: LEVELS, deal: deal, isMatch: isMatch, cardsLeft: cardsLeft, flip: flip, close: close, snap: snap, winner: winner, reaction: reaction, geo: geo, spots: spots, place: place
  };
  root.ZimiSnap = api;

  // ── The page ────────────────────────────────────────────────────────────
  var BUTTON_GAP = 22, BUTTON_MAX = 76, BUTTON_MIN = 52, SIDE_GAP = 24, NOTE_MS = 1200, OVER_MS = 900, RESUME_MS = 2200;
  function boot() {
    var d = root.document, t, board, session, view = { flash: '' }, level = DEFAULT_LEVEL, timer = 0, held = false, resumed = false;
    var button = Z.h('button', { class: 'sn-snap', type: 'button', text: TX('snap.button') });
    var badges = [Z.h('div', { class: 'sn-count' }), Z.h('div', { class: 'sn-count' })];
    Z.pageEls().table.appendChild(button); badges.forEach(function (b) { Z.pageEls().table.appendChild(b); });
    var clear = function () { if (timer) { root.clearTimeout(timer); timer = 0; } };
    var later = function (fn, ms) { clear(); timer = root.setTimeout(function () { timer = 0; fn(); }, ms); };
    function readLevel() { var v = Z.store.get(LEVEL_KEY, DEFAULT_LEVEL); return LEVELS[v] ? v : DEFAULT_LEVEL; }

    function paintEdges(st) {
      var m = board.metrics();
      if (!m) return;
      var g = geo(m), p = spots(g), y = g.cy + g.ch / 2 + BUTTON_GAP, room = g.statusY - y - 12;
      button.style.left = SIDE_GAP + 'px'; button.style.right = SIDE_GAP + 'px'; button.style.top = Math.round(y) + 'px';
      button.style.height = Math.round(Math.max(BUTTON_MIN, Math.min(BUTTON_MAX, room))) + 'px';
      button.disabled = st.phase !== 'play';
      button.classList.toggle('sn-hot', isMatch(st));
      [0, 1].forEach(function (seat) {
        badges[seat].style.left = Math.round(p.stack[seat].x + g.cw / 2) + 'px';
        badges[seat].style.top = Math.round(seat ? p.stack[seat].y + g.ch + 4 : p.stack[seat].y - BADGE_RISE) + 'px';
        badges[seat].textContent = String(st.stacks[seat].length);
      });
    }
    function said(st) {
      var n = st.note;
      if (!n) return isMatch(st) ? TX('snap.match') : TX('snap.watch');
      var you = n.seat === 0;
      return n.kind === 'snap' ? TX(you ? 'snap.won.you' : 'snap.won', { cards: Z.plural(n.n, 'card') }) : TX(you ? 'snap.false.you' : 'snap.false', { cards: Z.plural(n.n, 'card') });
    }
    function hud(st) {
      paintEdges(st);
      var out = { chips: [{ name: TX('cards.you'), text: String(st.won[0]) }, { name: root.ZimiText.ZIMI, text: String(st.won[1]) }], text: '' };
      if (st.phase === 'over') { out.text = TX('shell.end.over'); out.label = TX('shell.menu.new'); out.action = newGame; return out; }
      out.text = said(st);
      return out;
    }

    function arm() {
      var st = session.state;
      clear();
      if (held || d.hidden || st.phase === 'over') return;
      later(flipNow, st.flips === 0 && st.moves === 0 ? OVER_MS : resumed ? RESUME_MS : LEVELS[level].flip);
      resumed = false;
    }
    function flipNow() {
      var st = session.state;
      if (st.phase !== 'play') return;
      session.began();
      if (cardsLeft(st) === 0) { session.follow(close(st)); finish(); return; }
      var next = flip(st);
      session.follow(next);
      if (next.phase === 'over') { finish(); return; }
      if (isMatch(next)) {
        var wait = reaction(level), at = next.moves;
        if (wait !== null) session.later(function () { var now = session.state; if (now.moves === at && isMatch(now) && !held) take(1); }, wait);
      }
      arm();
    }
    // A snap by `seat`: kept in the state, shown a moment, and the next card comes after it.
    function take(seat) {
      var st = session.state;
      if (st.phase === 'over') return;
      session.began();
      var next = snap(st, seat);
      session.follow(next);
      if (next.phase === 'over') { finish(); return; }
      later(flipNow, NOTE_MS);
    }
    function finish() {
      clear();
      var st = session.state, w = winner(st);
      later(function () {
        var line = TX('snap.final', { you: st.won[0], zimi: st.won[1] });
        if (w === 0) session.win(st.won[0]); else session.lose(w < 0 ? 'draw' : '', [line], st.won[0]);
      }, OVER_MS);
    }
    function pressed() {
      var st = session.state;
      if (st.phase !== 'play' || (held)) return;
      take(0);
      if (!isMatch(st)) t.flash(TX('snap.noMatch'));
    }
    button.addEventListener('pointerdown', function (e) { e.preventDefault(); pressed(); });
    button.addEventListener('keydown', function (e) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); pressed(); } });
    d.addEventListener('keydown', function (e) { if (e.key === ' ' && !d.querySelector('.ar-sheet') && !(e.target && e.target.tagName === 'BUTTON')) { e.preventDefault(); pressed(); } });
    d.addEventListener('visibilitychange', function () { if (d.hidden) clear(); else arm(); });
    if (root.ZimiShell && root.ZimiShell.onHold) root.ZimiShell.onHold(function (on) { held = on; if (on) clear(); else arm(); });

    function newGame() {
      level = readLevel(); clear(); view.flash = '';
      resumed = true;
      session.reset(deal(T.shuffleOf(Array.apply(null, Array(CARDS)).map(function (x, i) { return i; }), Math.random), Math.round(Math.random())));
      arm();
    }
    t = T.create({
      id: 'snap', name: 'Snap', view: view, geo: geo, place: place, hud: hud, newGame: newGame,
      tap: function (pile) { if (pile === 'pile0' || pile === 'pile1') { pressed(); return true; } return false; },
      slotTap: function (pile) { if (/^pile/.test(pile)) pressed(); },
      canPick: function () { return false; },
      stat: function (sec, st) { return Z.fmtTime(sec) + ' · ' + st.won[0]; },
      cascadeOrder: function (st) { return st.piles[0].concat(st.piles[1]).map(function (id) { return { id: id }; }); },
      winLines: function (sec, st) { return [TX('snap.final', { you: st.won[0], zimi: st.won[1] })]; },
      menuExtra: function () {
        return [T.choiceRow(TX('board.level'), LEVEL_KEY, [{ value: 'easy', label: TX('board.level.easy') }, { value: 'medium', label: TX('board.level.medium') }, { value: 'hard', label: TX('board.level.hard') }], DEFAULT_LEVEL, function (v) { level = v; arm(); })];
      },
      rules: TX('snap.rules')
    });
    board = t.board; session = t.session;
    api.session = session; api.board = board;
    newGame();
  }

  if (root.document && root.document.getElementById('zc-table')) boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
