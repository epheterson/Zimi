/* ZimiGames: the table the world's card games share (Spades, Euchre, Gin
   Rummy, Cribbage, Crazy Eights, Durak, Scopa). You sit south; the computer
   players sit west, north and east. This file lays out hands and fans, keeps
   the score chips, the status line and the choice buttons over the felt, and
   wires a board and a session around a game's rules. A game supplies pure
   rules plus `place`, `hud` and a few handlers; nothing here knows Spades
   from Durak. trickGame carries what the trick-taking games share (Spades, Euchre,
   Belote, Skat, Bridge, Hearts). Pure helpers (geometry, sorting) are tested in node. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards;
  var T = Z.T;

  // Your hand at 390 px: one fanned row (no strip of a card narrower than 22 px; only a hand that cannot fit wraps into two
  // rows), a tapped card lifts 14 px
  // (a card you can play stands 6 px proud when others cannot be played). An opponent's face-down hand of more than
  // five cards is one back and a count chip.
  var COUNT_AT = 0.86, STATUS_MAX = 44, MIN_STRIP_PX = 22, LIFT_PX = 14, PLAYABLE_LIFT_PX = 6, COLLAPSE_FROM = 6;
  // Games that play a card on its second tap: the first tap lifts it (amber outline), the second plays it.
  var LIFT_THEN_PLAY = { spades: 1, euchre: 1, belote: 1, crazyeights: 1, durak: 1 };
  var TRICK_CENTER_SHARE = 0.4, HAND_BOTTOM_PX = 12, SCORE_BAR_H = 26, STATUS_H = 46, SUIT_GAP_SHARE = 0.18, HAND_STEP_SHARE = 0.78;
  var SIDE_STEP_MIN = 0.07, SIDE_STEP_MAX = 0.2, TOP_STEP_SHARE = 0.3, SIDE_OFFSET_CARDS = 3.4, TRICK_DX = 0.72, TRICK_DY = 0.62;
  var MIN_STEP_SHARE = 0.42, ROW_STEP_SHARE = 0.5, FLASH_MS = 1800, PANEL_GAP = 8;
  // The slot a card is dropped on to play it: this many cards wide and tall either side of the table's middle.
  var FELT_X = 1.6, FELT_Y = 1.1;
  // Where each seat sits on the table, by the number of players: 0 south, 1 west, 2 north, 3 east.
  var SEAT_POS = { 2: [0, 2], 3: [0, 1, 3], 4: [0, 1, 2, 3] };
  var SUIT_ORDER = [0, 1, 3, 2]; // clubs, diamonds, spades, hearts: alternating colours in a hand
  var SUIT_GLYPH = ['♣', '♦', '♥', '♠']; // by ZimiCards suit: clubs, diamonds, hearts, spades

  // The count chips of the face-down hands collapsed in the layout just made (fan() adds, create() reads).
  var counts = [];
  function takeCounts() { var out = counts; counts = []; return out; }

  // ── Pure helpers ────────────────────────────────────────────────────────
  var next = function (seat, n) { return (seat + 1) % n; };
  // Sorted for the hand: suits alternate colour, `high(id)` orders within a suit.
  function sortHand(ids, high) {
    return ids.slice().sort(function (a, b) { return SUIT_ORDER.indexOf(Z.suit(a)) - SUIT_ORDER.indexOf(Z.suit(b)) || high(a) - high(b) || a - b; });
  }
  var rankHigh = function (id) { return Z.rank(id) === 1 ? 14 : Z.rank(id); };
  var short = function (id) { return Z.RANK_LABELS[Z.rank(id) - 1] + SUIT_GLYPH[Z.suit(id)]; };
  var shortList = function (ids) { return ids.map(short).join(' '); };
  // The deck as a shuffled list of the ids in `ids`.
  function shuffleOf(ids, rng) {
    var a = ids.slice(), i, j, t;
    for (i = a.length - 1; i > 0; i--) { j = Math.floor(rng() * (i + 1)); t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function countBy(list, f) { return list.reduce(function (n, x) { return n + (f(x) ? 1 : 0); }, 0); }
  function maxBy(list, f) { return list.reduce(function (b, c) { return b === null || f(c) > f(b) ? c : b; }, null); }
  function minBy(list, f) { return maxBy(list, function (c) { return -f(c); }); }

  // Where everything sits on a table of this size. `rows` is how many rows
  // your hand takes (a long hand wraps).
  function geometry(m, rows) {
    var cw = m.cw, ch = m.ch, cx = m.W / 2, g = { cw: cw, ch: ch, cx: cx, rows: rows || 1 };
    g.raise = LIFT_PX;
    g.rowStep = Math.round(ch * ROW_STEP_SHARE);
    g.northY = m.pad + SCORE_BAR_H;
    g.southY = m.H - ch - Math.max(m.pad, HAND_BOTTOM_PX);        // your bottom row sits on the bottom (the page already stops above the home-indicator inset)
    g.yTop = g.northY + ch + 8;
    g.yBot = g.southY - (g.rows - 1) * g.rowStep - g.raise - 6;    // the rows above it push the status line up
    g.statusY = g.yBot - STATUS_H;
    // The trick sits high on the felt (40% down the table), clear of the north hand and the status line: eyes stay between the opponents and your hand.
    g.cy = Math.min((g.yTop + g.statusY) / 2, Math.max(m.H * TRICK_CENTER_SHARE, g.northY + ch * (1 + TRICK_DY + 0.5) + 4));
    g.westX = Math.max(m.pad, Math.round(cx - SIDE_OFFSET_CARDS * cw));
    g.eastX = Math.min(m.W - m.pad - cw, Math.round(cx + (SIDE_OFFSET_CARDS - 1) * cw));
    g.topStep = cw * TOP_STEP_SHARE;
    g.pad = m.pad; g.W = m.W; g.H = m.H;
    return g;
  }
  // How many rows a hand of n cards takes on this table.
  function handRows(width, pad, cw, n) {
    var perRow = Math.max(1, Math.floor((width - 2 * pad - cw) / MIN_STRIP_PX) + 1);
    return Math.max(1, Math.ceil(n / perRow));
  }
  function rowsFor(m, n) { return handRows(m.W, m.pad, m.cw, n); }
  function sideStep(g, n) { return Math.max(g.ch * SIDE_STEP_MIN, Math.min(g.ch * SIDE_STEP_MAX, (g.statusY - g.yTop - g.ch) / Math.max(1, n - 1))); }
  // A card's corner in the middle for each position's play, and where a position's cards sit.
  function trickSpot(g, pos) {
    var x = g.cx - g.cw / 2, y = g.cy - g.ch / 2;
    return [{ x: x, y: y + g.ch * TRICK_DY }, { x: x - g.cw * TRICK_DX, y: y }, { x: x, y: y - g.ch * TRICK_DY }, { x: x + g.cw * TRICK_DX, y: y }][pos];
  }
  function seatSpot(g, pos) {
    return [{ x: g.cx - g.cw / 2, y: g.southY }, { x: g.westX, y: g.yTop }, { x: g.cx - g.cw / 2, y: g.northY }, { x: g.eastX, y: g.yTop }][pos];
  }
  function posOf(seat, players) { return SEAT_POS[players][seat]; }
  // Where a seat sits for the person looking (a ZimiSeats object): the viewer is south.
  function posFor(seats, seat, players) { return SEAT_POS[players][seats.rel(seat)]; }

  // Your hand: `ids` left to right (wrapping into rows when it would be too
  // tight). `gapAfter(prevId, id)` adds a little space (between suits).
  // `info(id, k)` -> { label, up, dim, mark, glow, y }. Returns cards and
  // slots, each card its own pile 'h<id>' so a tap or a drag names it.
  function handCards(g, ids, info, gapAfter, prefix) {
    var n = ids.length, gap = g.cw * (g.gapShare || SUIT_GAP_SHARE), avail = g.W - 2 * g.pad - g.cw, out = { cards: [], slots: [], rows: 1 };
    var rows = handRows(g.W, g.pad, g.cw, n), r;
    out.rows = rows;
    // With some cards unplayable (the game dims them), the ones you can play stand a little proud.
    var anyDim = ids.some(function (id) { var f = info(id) || {}; return !!f.dim; });
    prefix = prefix || 'h';
    for (r = 0; r < rows; r++) {
      var part = ids.slice(Math.ceil(n * r / rows), Math.ceil(n * (r + 1) / rows)), gaps = 0, i;
      if (gapAfter) for (i = 1; i < part.length; i++) if (gapAfter(part[i - 1], part[i])) gaps++;
      var step = part.length > 1 ? Math.min(g.cw * HAND_STEP_SHARE, (avail - gaps * gap) / (part.length - 1)) : 0;
      var x = (g.W - (g.cw + (part.length - 1) * step + gaps * gap)) / 2, base = g.southY - (rows - 1 - r) * g.rowStep;
      part.forEach(function (id, k) {
        if (k > 0 && gapAfter && gapAfter(part[k - 1], id)) x += gap;
        var f = info(id) || {}, y = base - (f.raise ? g.raise : (anyDim && !f.dim && f.up !== false ? PLAYABLE_LIFT_PX : 0)), px = Math.round(x);
        out.cards.push({ id: id, pile: prefix + id, idx: 0, x: px, y: y, up: f.up !== false, mark: f.mark, glow: f.glow, dim: f.dim });
        out.slots.push({ id: prefix + id, x: px, y: y, w: g.cw, h: g.ch, label: f.label || Z.cardName(id) });
        x += step;
      });
    }
    return out;
  }
  // Face-down (or face-up when `up`) fan of a seat's hand at a table position.
  function fan(g, pos, ids, up) {
    var cards = [], n = ids.length, p = 'p' + pos;
    if (!up && n >= COLLAPSE_FROM) {
      // One back and a count: every card sits in the same place (so a played card still flies from the hand).
      var ax = pos === 2 ? Math.round(g.cx - g.cw / 2) : pos === 1 ? g.westX : g.eastX, ay = pos === 2 ? g.northY : g.yTop;
      ids.forEach(function (id, k) { cards.push({ id: id, pile: p, idx: k, x: ax, y: ay, up: false }); });
      counts.push({ x: ax + g.cw / 2, y: ay + g.ch * COUNT_AT, n: n });   // low on the back: the Z stays clear
      return cards;
    }
    if (pos === 2) {
      var nx = g.cx - (g.cw + (n - 1) * g.topStep) / 2, ts = Math.min(g.topStep, n > 1 ? (g.W - 2 * g.pad - g.cw) / (n - 1) : 0);
      nx = g.cx - (g.cw + (n - 1) * ts) / 2;
      ids.forEach(function (id, k) { cards.push({ id: id, pile: p, idx: k, x: Math.round(nx + k * ts), y: g.northY, up: !!up }); });
    } else {
      var sx = pos === 1 ? g.westX : g.eastX, st = sideStep(g, n);
      ids.forEach(function (id, k) { cards.push({ id: id, pile: p, idx: k, x: sx, y: g.yTop + k * st, up: !!up }); });
    }
    return cards;
  }

  // The score row: a chip for each player (a dot, the name, a number; D marks the dealer). A chip whose figure changed since the last
  // paint gives a short bump, so a score or a trick count is felt as it moves (`memo` carries the last figures between paints), and the
  // chip of a computer whose turn it is pulses: it is thinking.
  function paintChips(row, chips, memo, seats) {
    row.textContent = '';
    var cpu = [], i;
    if (seats) for (i = 0; i < seats.n; i++) if (!seats.person(i)) cpu.push(seats.name(i));
    (chips || []).forEach(function (c) {
      var thinking = c.turn && cpu.indexOf(c.name) >= 0;
      var moved = memo[c.name] !== undefined && memo[c.name] !== (c.text || '');
      memo[c.name] = c.text || '';
      row.appendChild(Z.h('span', { class: 'ct-chip' + (c.turn ? ' ct-turn' : '') + (thinking ? ' ct-think' : '') + (moved ? ' ct-bump' : ''), 'aria-current': c.turn ? 'true' : 'false' },
        [Z.h('b', { text: c.name }), Z.h('span', { text: c.text || '' }), c.dealer ? Z.h('i', { class: 'ct-dealer', title: T('cards.dealer'), text: T('cards.dealer.mark') }) : null]));
    });
  }

  // ── The table's own text and buttons ────────────────────────────────────
  // cfg: { id, name, rules, lowScore, players (seats; for geometry only),
  //   geo(m, st) -> geometry, place(st, m, view), canPick(st, pile), move(pile, idx, to),
  //   tap(pile, idx), slotTap(pile), hud(st, view) -> {chips, text, label, action, choices, sub},
  //   stat(sec, st), cascadeOrder(st), winLines(sec, st), newGame(), menuExtra() -> nodes,
  //   cols, heightShare, face }
  // chips: [{ name, text, turn }]; choices: [{ label, onclick, disabled, primary, pressed }].
  function create(cfg) {
    var d = root.document, el = Z.pageEls(), board, session, view = cfg.view || {};
    view.flash = view.flash || '';
    Z.ensureSprite();
    var scoreRow = Z.h('div', { class: 'ct-scores', 'aria-live': 'off' });
    var statusText = Z.h('span', { class: 'ct-status-text' });
    var statusBtn = Z.h('button', { class: 'ar-btn', type: 'button' });
    var status = Z.h('div', { class: 'ct-status', role: 'status' }, [statusText, statusBtn]);
    var panel = Z.h('div', { class: 'ct-panel', role: 'group', 'aria-label': T('cards.choices') });
    el.table.appendChild(scoreRow); el.table.appendChild(status); el.table.appendChild(panel);
    var liftedPile = null, liftPlay = cfg.liftPlay !== undefined ? cfg.liftPlay : !!LIFT_THEN_PLAY[cfg.id];
    var lifts = function (st) { return typeof liftPlay === 'function' ? !!liftPlay(st) : !!liftPlay; };
    var statusAction = null, last = '', choicesNow = [], chipMemo = {};
    statusBtn.addEventListener('click', function () { if (statusAction) statusAction(); });

    function paint() {
      var st = session && session.state, m = board && board.metrics();
      if (!st || !m) return;
      var g = cfg.geo ? cfg.geo(m, st) : geometry(m), hd = cfg.hud(st, view) || {};
      // Whatever the game's own layout says, the status line never sits on the hand.
      var statusY = Z.statusTop(g.statusY, board.handTop(), STATUS_H);
      var sig = JSON.stringify([hd.chips, hd.text, hd.label, !!hd.action, hd.choices && hd.choices.map(function (c) { return [c.label, !!c.disabled, !!c.pressed]; }), hd.lines, hd.fact, hd.trump, view.flash, liftedPile, statusY, m.W]);
      statusAction = hd.action || null; choicesNow = hd.choices || [];
      if (sig === last) return;
      last = sig;
      paintChips(scoreRow, hd.chips, chipMemo, cfg.seats);
      // Trump is a suit chip: the suit's glyph (red for the red suits), then the word.
      if (hd.trump !== undefined && hd.trump !== null) {
        var red = Z.isRed(Z.make(1, hd.trump));
        scoreRow.appendChild(Z.h('span', { class: 'ct-chip ct-trump' }, [Z.h('b', { class: red ? 'ct-red' : '', text: SUIT_GLYPH[hd.trump] }), Z.h('span', { text: T('cards.trump') })]));
      }
      scoreRow.style.top = m.pad + 'px';
      status.style.top = Math.round(statusY) + 'px'; status.style.height = STATUS_H + 'px';
      panel.style.bottom = Math.round(m.H - statusY + PANEL_GAP) + 'px';
      // The status line: one sentence. The game's one fact ("Hand 2", "To 121") leads it when both fit.
      // A flash (a reason, a call) is a sentence of its own: nothing leads it. A lifted card says what the next tap does.
      var line = view.flash || (liftedPile && hd.text && !hd.choices ? T('cards.tapAgain') : hd.text) || '';
      statusText.textContent = !view.flash && hd.fact && line && (hd.fact + ' \u00b7 ' + line).length <= STATUS_MAX ? hd.fact + ' \u00b7 ' + line : (line || hd.fact || '');
      statusBtn.textContent = hd.label || ''; statusBtn.hidden = !hd.label; statusBtn.disabled = !hd.action; statusBtn.setAttribute('aria-pressed', hd.action ? 'true' : 'false');   // the next thing to do is the filled amber button
      panel.textContent = ''; panel.hidden = !(hd.choices && hd.choices.length);
      (hd.choices || []).forEach(function (c, i) {
        var b = Z.h('button', { class: 'ar-btn ct-choice' + (c.cls ? ' ' + c.cls : ''), type: 'button', text: c.label });
        if (c.pressed !== undefined) b.setAttribute('aria-pressed', String(!!c.pressed));
        if (c.primary) { b.setAttribute('aria-pressed', 'true'); b.classList.add('ct-primary'); }
        if (c.aria) b.setAttribute('aria-label', c.aria);
        b.disabled = !!c.disabled;
        b.addEventListener('click', function () { if (choicesNow[i] && choicesNow[i].onclick) choicesNow[i].onclick(); });
        panel.appendChild(b);
      });
      if (hd.lines && hd.lines.length) {
        var box = Z.h('div', { class: 'ct-lines' }, hd.lines.map(function (t) { return Z.h('p', { class: t.cls || '', text: t.text }, []); }));
        panel.hidden = false; panel.insertBefore(box, panel.firstChild);
      }
      el.sub.textContent = '';   // the bar has no second line: the fact is in the status line
    }
    function flash(text) { view.flash = text; board.say(text); paint(); session.later(function () { view.flash = ''; paint(); }, FLASH_MS); }
    // Put a reason away: what was wrong is over once the next thing is done.
    function unflash() { if (view.flash) { view.flash = ''; paint(); } }

    board = Z.createBoard({
      table: el.table, cols: cfg.cols || 7, heightShare: cfg.heightShare || 0.11, enterTaps: true, face: cfg.face,
      place: function (st, m) {
        takeCounts();
        var p = cfg.place(st, m, view);
        p.counts = takeCounts();
        if (liftedPile) {
          // The card the first tap lifted: 14 px up, with the selection ring.
          var found = false;
          p.cards.forEach(function (c) { if (c.pile === liftedPile) { found = true; c.y -= LIFT_PX; c.mark = true; } });
          if (!found) liftedPile = null;
        }
        return p;
      },
      canPick: function (st, pile) { return cfg.canPick ? cfg.canPick(st, pile) : false; },
      move: function (pile, idx, to) { return cfg.move ? cfg.move(pile, idx, to) : false; },
      tap: function (pile, idx) {
        // Lift, then play: the first tap on a card you can play lifts it, the second plays it.
        if (session && /^h\d+$/.test(pile) && lifts(session.state) && cfg.canPick && cfg.canPick(session.state, pile)) {
          if (liftedPile !== pile) { liftedPile = pile; board.refresh(); return true; }
          liftedPile = null;
        }
        return cfg.tap ? cfg.tap(pile, idx) : false;
      },
      slotTap: function (pile) { if (cfg.slotTap) cfg.slotTap(pile); },
      // The status line sits above the hand as it was just laid out.
      afterRender: function () { if (board) paint(); }
    });
    session = Z.createSession({
      id: cfg.id, lowScore: cfg.lowScore, board: board, newGame: cfg.newGame, els: el,
      undoOff: cfg.seats ? function () { return cfg.seats.hotseat(); } : null,
      statText: function (sec, st) { paint(); return cfg.stat(sec, st); },
      cascadeOrder: cfg.cascadeOrder || function () { return []; },
      winLines: cfg.winLines,
      openMenu: function () {
        Z.sheet({
          title: root.ZimiText && root.ZimiText.has('game.' + cfg.id + '.title') ? T('game.' + cfg.id + '.title') : cfg.name,   // the game's name in the player's language
          body: [Z.h('p', { class: 'zc-note', text: cfg.rules })].concat(cfg.menuExtra ? cfg.menuExtra() : [], cfg.seats ? [cfg.seats.block(null, cfg.seatsBlock)] : [], [Z.backsRow(), Z.h('p', { class: 'zc-stats', text: session.stats.line() })]),
          actions: [{ label: T('shell.menu.new'), onclick: cfg.newGame }, { label: T('shell.close'), primary: true }]
        });
      }
    });
    d.addEventListener('visibilitychange', function () { if (!d.hidden) paint(); });
    return { board: board, session: session, view: view, flash: flash, unflash: unflash, paint: function () { last = ''; paint(); }, el: el };
  }

  // A sheet of plain lines (a hand's result).
  function lineSheet(title, lines, actions) {
    return Z.sheet({ title: title, body: lines.map(function (t) { return Z.h('p', { class: 'zc-note', text: t }); }), actions: actions });
  }
  // A hand's summary: the headline says who won and by how much, the detail lines say how, and a small table keeps the
  // score (rows are { name, delta, total, note, lead }; delta and note may be absent). The sheet's title is the hand.
  var LRM = '\u200e';   // keeps a signed number's sign in front of its digits in a right-to-left sheet
  // One row of a breakdown table: a label, then a figure for each side. `cells` is [label, ...figures]; a zero figure is quiet.
  function tableRow(r) {
    var cells = r.cells.map(function (c, i) { return Z.h('span', { class: i && !r.head && c === 0 ? 'zc-zero' : '', text: i && !r.head && typeof c === 'number' ? LRM + (c > 0 && !r.total ? '+' : '') + c : (c === null ? '' : String(c)) }); });
    return Z.h('div', { class: 'zc-sum-row' + (r.head ? ' zc-sum-head' : '') + (r.total ? ' zc-sum-strong' : ''), role: 'row' }, cells);
  }
  function summarySheet(o) {
    var rows = (o.rows || []).map(function (r) {
      return Z.h('div', { class: 'zc-sum-row' + (r.lead ? ' zc-lead' : '') }, [
        Z.h('span', { class: 'zc-sum-name' }, [Z.h('b', { text: r.name }), r.note ? Z.h('small', { text: r.note }) : null]),
        Z.h('span', { class: 'zc-sum-delta', text: r.delta == null ? '' : LRM + (r.delta > 0 ? '+' : '') + r.delta }),
        Z.h('span', { class: 'zc-sum-total', text: LRM + r.total })]);
    });
    var head = Z.h('div', { class: 'zc-sum-row zc-sum-head' }, [Z.h('span'), Z.h('span', { text: T('cards.sum.hand') }), Z.h('span', { text: T('cards.sum.total') })]);
    if (o.table) { rows = o.table.rows.map(tableRow); head = tableRow({ cells: o.table.cols, head: true }); }
    var body = [Z.h('p', { class: 'zc-sum-head-line', text: o.headline })].concat((o.detail || []).map(function (t) { return Z.h('p', { class: 'zc-note', text: t }); }), [Z.h('div', { class: 'zc-sum' + (o.table ? ' zc-grid' : ''), role: 'table' }, [head].concat(rows))]);
    return Z.sheet({ title: o.title, body: body, actions: o.actions });
  }
  // Chips as table furniture: an amount drawn as stacks of tokens, a column for each denomination it takes
  // (greedy, largest first). A tall column shows its top few: the stack is a picture of the pile, the figure
  // is in the status line.
  var CHIP_DENOMS = [500, 100, 50, 25, 10, 5, 1], CHIP_COLUMNS_MAX = 4, CHIP_STACK_MAX = 7, CHIP_STEP_PX = 4, CHIP_PX = 30;
  function chipStack(amount) {
    var left = Math.max(0, Math.round(amount)), cols = [], node = Z.h('div', { class: 'ct-stack', role: 'img', 'aria-label': T('cards.chips', { n: left }) });
    CHIP_DENOMS.forEach(function (d) { var n = Math.floor(left / d); if (n) { cols.push([d, n]); left -= n * d; } });
    cols.slice(0, CHIP_COLUMNS_MAX).forEach(function (c) {
      var n = Math.min(c[1], CHIP_STACK_MAX), col = Z.h('div', { class: 'ct-col', style: 'height:' + (CHIP_PX + (n - 1) * CHIP_STEP_PX) + 'px' }), i;
      for (i = 0; i < n; i++) col.appendChild(Z.h('i', { class: 'ct-token ct-d' + c[0], style: 'bottom:' + i * CHIP_STEP_PX + 'px' }));
      node.appendChild(col);
    });
    return node;
  }
  // Which saved choice (key in zimi.games.*) a segmented menu row holds.
  function choiceRow(label, key, options, fallback, onPick) {
    var value = Z.store.get(key, fallback);
    if (!options.some(function (o) { return o.value === value; })) value = fallback;
    return Z.h('div', { class: 'zc-row' }, [Z.h('label', { text: label }), Z.segmented(options, value, function (v) { Z.store.set(key, v); onPick(v); })]);
  }

  // ── Trick games ─────────────────────────────────────────────────────────
  // The felt a trick is played on: the quiet slot a card is dropped on, and the cards of the trick at their seats' places (or, when
  // `sweep` names the winner, all heading for that seat). `pos(seat)` is where a seat sits for the person looking.
  function feltSlots(g) {
    return [
      { id: 'deck', x: g.cx - g.cw / 2, y: g.cy - g.ch / 2, w: g.cw, h: g.ch, quiet: true, label: T('cards.slot.table') },
      { id: 'trick', x: g.cx - FELT_X * g.cw, y: g.cy - FELT_Y * g.ch, w: 2 * FELT_X * g.cw, h: 2 * FELT_Y * g.ch, quiet: true, label: T('cards.slot.trick') }
    ];
  }
  // `win` is the seat taking a trick that is complete: its card glows while the trick waits to be taken (view.win).
  function trickCards(g, trick, sweep, pos, win) {
    return trick.map(function (t, k) {
      var spot = sweep !== null && sweep !== undefined ? seatSpot(g, pos(sweep)) : trickSpot(g, pos(t.seat));
      return { id: t.id, pile: 'trick', idx: k, x: Math.round(spot.x), y: Math.round(spot.y), up: true, glow: win !== undefined && win !== null && t.seat === win };
    });
  }
  // Who is looking, and whether their hand is face up (view.viewer / view.hideHand, set by trickGame.syncView).
  function looking(view) { return { V: (view && view.viewer) || 0, up: !(view && view.hideHand) }; }

  // What Spades, Euchre, Belote, Skat, Bridge and Hearts share once the cards are out: the computer's turn on a beat, your play and
  // tap, the trick's sweep to its winner and what follows it, a hand's ending and the next, and the words of a turn. A game keeps its
  // rules (what is legal, who wins, bidding, scoring) and hands them in.
  //   o: { id, n (seats), view, seatOpts, ms: { ai, hold, sweep },
  //     size(st) cards in a full trick (n), winner(st) the seat taking it, resolve(st) the state after it, drive() the game's turn order,
  //     legal(st, seat, id), why(st, id) what to say to an illegal card, play(st, seat, id) the state after it, aiPlay(st, seat) a card,
  //     control(st) the seat whose person plays the card to come, actor(st) the seat acting now, shown(st, viewer) a hand seen whatever
  //     the turn (Bridge's dummy), yours(st) after a person is asked to play, before(st, seat, id, human) and after(human) around a card
  //     played, pretap(st, id) a tap that is not a play (undefined: it is), clear() what a new hand forgets, handEnd the phase a hand
  //     ends in, nextHand(st, order), handOver() and gameOver() after the last trick, deal() }
  function trickGame(o) {
    var n = o.n, view = o.view, ms = o.ms, t = null, board = null, session = null, paint = null, flash = null, unflash = null, tg = { view: view };
    var size = o.size || function () { return n; }, control = o.control || function (st) { return st.turn; }, actor = o.actor || control;
    var team = function (seat) { return seat % 2; };
    var seats = tg.seats = root.ZimiSeats.create(Object.assign({ id: o.id, seats: n, onChange: function () { if (paint) paint(); if (board) board.refresh(); } }, o.seatOpts));
    var idOf = tg.idOf = function (pile) { return parseInt(pile.slice(1), 10); };
    function repaint() { board.refresh(); paint(); }
    tg.repaint = repaint;
    // The board, session, painter and flasher of the table made for the game (a create() result, or the same four by hand).
    tg.attach = function (parts) { board = parts.board; session = parts.session; paint = parts.paint; flash = parts.flash; unflash = parts.unflash; };

    // The rules in o decide who may see which hand, who is up, what a tap means.
    tg.syncView = function (st) {
      var V = seats.view();
      view.viewer = V; view.hideHand = seats.hotseat() && actor(st) !== V && !(o.shown && o.shown(st, V));
      view.win = st.phase === 'play' && st.trick.length === size(st) ? o.winner(st) : null;
    };
    // A fresh deal: nobody has seen it, so a table of people starts at a handoff.
    tg.deal = o.deal || function () { seats.begin(function () { repaint(); o.drive(); }, actor(session.state)); };

    // The play phase of the turn order: the full trick waits, then sweeps; else a person is asked, or the computer answers on a beat.
    tg.turn = function (st) {
      if (st.phase !== 'play') return;
      if (st.trick.length === size(st)) { session.later(sweep, ms.hold); return; }
      var ctl = control(st);
      if (seats.person(ctl)) { seats.ensure(ctl, repaint); if (o.yours) o.yours(st); } else session.later(aiTurn, ms.ai);
    };
    function aiTurn() {
      var st = session.state, seat = st.turn;
      if (st.phase !== 'play' || seats.person(control(st)) || st.trick.length === size(st)) return;
      var id = o.aiPlay(st, seat);
      if (o.before) o.before(st, seat, id, false);
      session.follow(o.play(st, seat, id));
      o.drive();
    }
    // The full trick flies to its winner, then is taken; a hand or game that ends with it says so.
    function sweep() {
      var st0 = session.state;
      if (st0.trick.length !== size(st0)) return;
      view.sweep = o.winner(st0);
      board.refresh();
      session.later(function () {
        view.sweep = null;
        session.follow(o.resolve(session.state));
        var st = session.state;
        if (st.phase === o.handEnd && o.handOver) o.handOver(); else if (st.phase === 'over' && o.gameOver) o.gameOver(); else o.drive();
      }, ms.sweep);
    }
    tg.sweepTrick = sweep;
    // The person looking plays a card (from `seat`'s hand: Bridge plays dummy's too).
    tg.play = function (id, seat) {
      var st = session.state, from = seat === undefined ? seats.view() : seat;
      if (!o.legal(st, from, id)) return false;
      if (unflash) unflash();
      if (o.before) o.before(st, from, id, true);
      session.commit(o.play(st, from, id));
      if (o.after) o.after(true);
      o.drive();
      return true;
    };
    // A tap on a card of the hand: a play once it is your turn and the card is legal; what is wrong with it otherwise.
    tg.tap = function (pile) {
      var st = session.state, id = idOf(pile);
      if (pile.charAt(0) !== 'h' || isNaN(id)) return false;
      if (o.pretap) { var done = o.pretap(st, id); if (done !== undefined) return done; }
      if (st.phase !== 'play') return false;
      var full = st.trick.length === size(st);
      if (st.turn !== seats.view() || full) { flash(full ? T('cards.wait.trick') : T('cards.wait.turn')); return false; }
      if (!o.legal(st, st.turn, id)) { flash(o.why(st, id)); return false; }
      return tg.play(id);
    };
    tg.startNextHand = function () {
      var st = session.state;
      if (st.phase !== o.handEnd) return;
      session.history = [];
      if (o.clear) o.clear();
      session.follow(o.nextHand(st, Z.shuffled(Math.random)));
      tg.deal();
    };
    // A new game: the table forgets the last one's animation and talk.
    tg.restart = function (state) {
      view.sweep = null; view.flash = '';
      if (o.clear) o.clear();
      session.reset(state);
      tg.deal();
    };

    // Words and figures of a table.
    tg.order = function () { var V = seats.view(); return Array.apply(null, Array(n)).map(function (x, i) { return (V + i) % n; }); };
    tg.mine = function (seat) { return seats.person(seat) && seat === seats.view(); };
    tg.turnText = function (seat) { return !seats.person(seat) ? T('cards.thinking', { name: seats.name(seat) }) : seats.isYou(seat) ? T('cards.turn.you') : T('cards.turn.name', { name: seats.name(seat) }); };
    tg.trickText = function (winner) { return seats.isYou(winner) ? T('cards.trick.you') : T('cards.trick.name', { name: seats.name(winner) }); };
    // Partnerships: seats 0 and 2 against 1 and 3.
    tg.viewTeam = function () { return team(seats.view()); };
    tg.teamLabel = function (k) { return k === tg.viewTeam() ? T('cards.team.us') : T('cards.team.them'); };
    tg.teamNames = function (k) { return T('cards.pair', { a: seats.name(k), b: seats.name(k + 2) }); };
    tg.teamStat = function (sec, scores) { var vt = tg.viewTeam(); return Z.fmtTime(sec) + ' · ' + scores[vt] + '-' + scores[1 - vt]; };
    // A hand's result as a sheet with the button that deals the next one.
    tg.handSheet = function (lines, title, label) {
      lineSheet(title || T('cards.fact.hand', { n: session.state.handNo + 1 }), lines, [{ label: label || T('cards.nextHand'), primary: true, onclick: tg.startNextHand }]);
    };
    // The game is decided for team `w`: the last hand's lines and the result, to the stats and the end sheet.
    tg.teamGameOver = function (w, scores, lines) {
      var vt = tg.viewTeam(), hot = seats.hotseat();
      lines = lines.concat([T(hot ? 'cards.result.hot' : w === vt ? 'cards.result.you' : 'cards.result.them', { team: hot ? tg.teamNames(w) : '', a: scores[w], b: scores[1 - w] })]);
      if (hot) session.lose({ name: tg.teamNames(w), team: true }, lines);
      else if (w === vt) session.win(scores[vt]); else session.lose('', lines, scores[vt]);
    };

    // The table for a game: cfg is create()'s, and what a trick game always says is filled in.
    tg.create = function (cfg) {
      var place = cfg.place;
      t = create(Object.assign({
        id: o.id, seats: seats, view: view, tap: tg.tap, liftPlay: function (st) { return st.phase === 'play'; },
        canPick: function (st, pile) { return st.phase === 'play' && pile.charAt(0) === 'h' && o.legal(st, seats.view(), idOf(pile)); },
        move: function (pile, idx, to) { return (to === 'trick' || to === 'deck') && pile.charAt(0) === 'h' ? tg.play(idOf(pile)) : false; },
        stat: function (sec, st) { return tg.teamStat(sec, st.scores); }
      }, cfg, { place: function (st, m, v) { tg.syncView(st); return place(st, m, v); } }));
      tg.attach(t);
      return t;
    };
    return tg;
  }

  root.ZimiTable = {
    paintChips: paintChips, SEAT_POS: SEAT_POS, SUIT_GLYPH: SUIT_GLYPH, STATUS_H: STATUS_H, STATUS_MAX: STATUS_MAX, SCORE_BAR_H: SCORE_BAR_H,
    next: next, sortHand: sortHand, rankHigh: rankHigh, short: short, shortList: shortList, shuffleOf: shuffleOf,
    countBy: countBy, maxBy: maxBy, minBy: minBy,
    geometry: geometry, rowsFor: rowsFor, sideStep: sideStep, trickSpot: trickSpot, seatSpot: seatSpot, posOf: posOf, posFor: posFor, handCards: handCards, fan: fan, takeCounts: takeCounts, handRows: handRows,
    feltSlots: feltSlots, trickCards: trickCards, looking: looking, trickGame: trickGame,
    create: create, lineSheet: lineSheet, summarySheet: summarySheet, choiceRow: choiceRow, chipStack: chipStack
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
