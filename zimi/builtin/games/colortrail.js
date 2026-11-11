/* ZimiGames: Color Trail, a colour path race for two to four, made for small children: nothing to read. Our own code and our own
   drawn board, GPL-3.0. No network, no modules. Two halves: the rules (pure functions, testable in node), then the page.
   Draw a card and move to the next square of that colour (a double card: the second square of it). Three bridges carry a token
   ahead. The first to the last square wins. Every colour has a shape as well, so colour is never the only clue. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var COLS = 6, ROWS = 9, LAST = COLS * ROWS, COLORS = 6, DOUBLE_ODDS = 0.2;
  // The foot of each bridge and where it comes out. A bridge only ever carries a token forward.
  var BRIDGES = { 8: 19, 22: 35, 40: 50 };

  // The colour of square n (1 to LAST - 1): a repeating run that drifts by one every six squares, so a colour never sits beside itself.
  function colorOf(n) { return n >= 1 && n < LAST ? (n + Math.floor((n - 1) / COLORS)) % COLORS : -1; }

  // Row 0 is the bottom; odd rows run right to left, as on a printed board.
  function cellOf(n) {
    var r = Math.floor((n - 1) / COLS), c = (n - 1) % COLS;
    return { row: r, col: r % 2 === 0 ? c : COLS - 1 - c };
  }

  // A card: { color, count }, count 1 (the next square of the colour) or 2 (the second one).
  function drawCard(rnd) {
    var count = rnd() < DOUBLE_ODDS ? 2 : 1;
    return { color: Math.floor(rnd() * COLORS), count: count };
  }

  // Where a token on `from` lands with a card: { from, landed, to, bridge, won }. The last square is the end of the road for a colour
  // that has no square left.
  function move(from, card) {
    var seen = 0, n = from + 1, landed = LAST;
    for (; n < LAST; n++) {
      if (colorOf(n) === card.color && ++seen === card.count) { landed = n; break; }
    }
    var to = BRIDGES[landed] || landed;
    return { from: from, landed: landed, to: to, bridge: to !== landed, won: to === LAST };
  }

  root.ColorTrailEngine = { COLS: COLS, ROWS: ROWS, LAST: LAST, COLORS: COLORS, BRIDGES: BRIDGES, DOUBLE_ODDS: DOUBLE_ODDS, colorOf: colorOf, cellOf: cellOf, drawCard: drawCard, move: move };

  // ── the page ─────────────────────────────────────────────────────────────
  if (typeof document === 'undefined') return;
  var WK = root.WorldKit, BK = root.BoardKit, E = root.ColorTrailEngine, Play = root.ArcadePlay, $ = function (id) { return document.getElementById(id); };
  var T = function (id, vars) { return root.ZimiText ? root.ZimiText.T(id, vars) : id; };
  var NS = 'http://www.w3.org/2000/svg', CELL = 60, W = COLS * CELL, H = ROWS * CELL, START_STRIP = 48, START_X = 90, START_STEP = 44;
  var HOP_MS = 130, DRAW_MS = 450, COMPUTER_DELAY_MS = 700, NEXT_DELAY_MS = 500, SLIDE_MS = 520;
  // The six colours with a shape each (circle, square, triangle, diamond, star, cross: playkit's symbols), and the ink that reads on it.
  var COLOR_NAMES = ['red', 'blue', 'green', 'yellow', 'purple', 'orange'];
  var PAINT = [{ fill: '#d1473f', ink: '#ffffff' }, { fill: '#3a63c9', ink: '#ffffff' }, { fill: '#3d9a4a', ink: '#ffffff' }, { fill: '#f0c52e', ink: '#3a2f06' }, { fill: '#8a55c9', ink: '#ffffff' }, { fill: '#dc7a1b', ink: '#3a1d03' }];
  var PLAYERS = [
    { id: 'blue', color: '#2f5aa8', dark: '#1d3a74', shape: 'circle' },
    { id: 'red', color: '#c0392b', dark: '#7d261b', shape: 'square' },
    { id: 'green', color: '#2e8b57', dark: '#1d5a38', shape: 'triangle' },
    { id: 'gold', color: '#d49a1a', dark: '#8a6410', shape: 'diamond' }
  ];
  var SPOTS = [[-0.24, -0.1], [0.24, -0.1], [-0.24, 0.3], [0.24, 0.3]];

  var G = WK.create({
    id: 'colortrail',
    options: [{ key: 'players', legend: 'sl.players', def: '2', choices: [['2', '2'], ['3', '3'], ['4', '4']] }],
    checks: [],
    statKey: function () { return 'all'; },
    onNew: newGame
  });
  var SEATS_KEY = 'zimi.games.colortrail.seats', seats;
  function seatsFor(n) { return root.ZimiSeats.create({ id: 'colortrail', seats: n, cpuNames: PLAYERS.map(function (p, i) { return root.ZimiSeats.cpuName(i); }) }); }
  function playerCount() { return +G.settings.players; }
  seats = seatsFor(playerCount());
  var host = $('ct-board'), drawBtn = $('ct-draw'), cardHost = $('ct-card'), roster = $('wk-score'), svg, tokens = [], pos = [], count = 2, turn = 0, busy = false, lastCard = null;
  function isHuman(p) { return seats.person(p); }
  function nameOf(p) { return seats.name(p); }
  function pname(p) { return T('sl.color.' + PLAYERS[p].id); }
  G.vsComputer = function () { return !seats.hotseat(); };
  function mk(tag, attrs, text) { var e = document.createElementNS(NS, tag); Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); }); if (text != null) e.textContent = text; return e; }
  function centre(n) { var c = E.cellOf(n); return { x: c.col * CELL + CELL / 2, y: (ROWS - 1 - c.row) * CELL + CELL / 2 }; }
  // A colour's shape, drawn at (x, y) at a size (the symbol is drawn in a 24 box).
  function shapeAt(color, x, y, size, ink) {
    var g = mk('g', { transform: 'translate(' + (x - size / 2) + ' ' + (y - size / 2) + ') scale(' + (size / 24) + ')', fill: ink, stroke: 'none', 'aria-hidden': 'true' });
    g.innerHTML = Play.SYMBOL_PATHS[color];
    return g;
  }

  // ── drawing the board ──
  function buildBoard() {
    host.textContent = '';
    svg = mk('svg', { viewBox: '0 0 ' + W + ' ' + (H + START_STRIP), role: 'img', 'aria-label': T('ct.board') });
    var sq = mk('g'), n, c, x, y;
    svg.appendChild(mk('rect', { x: 0, y: H, width: W, height: START_STRIP, class: 'ct-strip' }));
    svg.appendChild(sq);
    for (n = 1; n <= E.LAST; n++) {
      c = E.cellOf(n); x = c.col * CELL; y = (ROWS - 1 - c.row) * CELL;
      if (n === E.LAST) {
        sq.appendChild(mk('rect', { x: x + 2, y: y + 2, width: CELL - 4, height: CELL - 4, rx: 10, class: 'ct-end' }));
        sq.appendChild(mk('path', { d: 'M' + (x + 30) + ' ' + (y + 14) + 'l5 11 12 1-9 8 3 12-11-6-11 6 3-12-9-8 12-1z', class: 'ct-star' }));
        continue;
      }
      var paint = PAINT[E.colorOf(n)];
      sq.appendChild(mk('rect', { x: x + 3, y: y + 3, width: CELL - 6, height: CELL - 6, rx: 10, fill: paint.fill, class: 'ct-sq' }));
      sq.appendChild(shapeAt(E.colorOf(n), x + 30, y + 30, 26, paint.ink));
    }
    Object.keys(E.BRIDGES).forEach(function (k) { svg.appendChild(bridgeShape(+k, E.BRIDGES[k])); });
    svg.appendChild(mk('text', { x: 14, y: H + START_STRIP / 2 + 6, class: 'ct-start' }, T('sl.start')));
    svg.appendChild(mk('g', { id: 'ct-tokens' }));
    host.appendChild(svg);
  }
  // A bridge: an arc from beside its foot to beside where it comes out, striped like planks with a dark edge, an arrowhead at the far
  // end. It stops short of both squares so their shapes stay in view.
  var BRIDGE_GAP = 25, BRIDGE_LIFT = 0.3, BRIDGE_ARROW = 11;
  function bridgeShape(from, to) {
    var a = centre(from), b = centre(to), dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    var s = { x: a.x + ux * BRIDGE_GAP, y: a.y + uy * BRIDGE_GAP }, e = { x: b.x - ux * BRIDGE_GAP, y: b.y - uy * BRIDGE_GAP };
    var cx = (s.x + e.x) / 2 + uy * len * BRIDGE_LIFT, cy = (s.y + e.y) / 2 - ux * len * BRIDGE_LIFT;   // bows to the left of the way ahead
    var d = 'M' + s.x.toFixed(1) + ' ' + s.y.toFixed(1) + 'Q' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ' ' + e.x.toFixed(1) + ' ' + e.y.toFixed(1), g = mk('g', { class: 'ct-bridge' });
    var tx = e.x - cx, ty = e.y - cy, tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    var head = [[e.x + tx * BRIDGE_ARROW, e.y + ty * BRIDGE_ARROW], [e.x - ty * BRIDGE_ARROW * 0.8, e.y + tx * BRIDGE_ARROW * 0.8], [e.x + ty * BRIDGE_ARROW * 0.8, e.y - tx * BRIDGE_ARROW * 0.8]];
    g.appendChild(mk('path', { d: d, class: 'ct-bridge-edge' }));
    g.appendChild(mk('path', { d: d, class: 'ct-bridge-top' }));
    g.appendChild(mk('polygon', { points: head.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join(' '), class: 'ct-bridge-end' }));
    return g;
  }
  function tokenShape(p, r) {
    var pl = PLAYERS[p], g = mk('g', { class: 'ct-token' });
    var shape = pl.shape === 'circle' ? mk('circle', { r: r }) : pl.shape === 'square' ? mk('rect', { x: -r * 0.88, y: -r * 0.88, width: r * 1.76, height: r * 1.76, rx: r * 0.25 }) :
      pl.shape === 'triangle' ? mk('polygon', { points: '0,' + (-r * 1.05) + ' ' + (r * 1.0) + ',' + (r * 0.8) + ' ' + (-r * 1.0) + ',' + (r * 0.8), 'stroke-linejoin': 'round' }) : mk('polygon', { points: '0,' + (-r * 1.1) + ' ' + (r * 1.0) + ',0 0,' + (r * 1.1) + ' ' + (-r * 1.0) + ',0', 'stroke-linejoin': 'round' });
    shape.setAttribute('fill', pl.color); shape.setAttribute('stroke', '#ffffff'); shape.setAttribute('stroke-width', 3);
    g.appendChild(shape);
    g.appendChild(mk('text', { y: r * 0.36, 'text-anchor': 'middle', 'font-size': r * 1.05, 'font-weight': 800, fill: '#fff' }, String(p + 1)));
    return g;
  }
  function tokenXY(p, n) {
    if (n === 0) return { x: START_X + p * START_STEP, y: H + START_STRIP / 2 };
    var c = centre(n), sharing = [], i;
    for (i = 0; i < count; i++) if (pos[i] === n) sharing.push(i);
    var k = sharing.indexOf(p), s = sharing.length > 1 ? SPOTS[k] : [0, 0];
    return { x: c.x + s[0] * CELL, y: c.y + s[1] * CELL };
  }
  function drawTokens() {
    var layer = svg.querySelector('#ct-tokens'), i;
    layer.textContent = '';
    tokens = [];
    for (i = 0; i < count; i++) {
      var shared = pos[i] && pos.filter(function (q) { return q === pos[i]; }).length > 1;
      var t = tokenShape(i, shared ? 11 : 15), xy = tokenXY(i, pos[i]);
      t.setAttribute('transform', 'translate(' + xy.x + ' ' + xy.y + ')'); layer.appendChild(t); tokens.push(t);
    }
  }
  function setToken(p, n) { var xy = tokenXY(p, n); tokens[p].setAttribute('transform', 'translate(' + xy.x + ' ' + xy.y + ')'); }

  // ── the card ──
  // A card is its colour with its shape, once or twice; the back of the deck is the games' own mark on a dark ground.
  function cardMarkup(card) {
    var s = mk('svg', { viewBox: '0 0 64 84', class: 'ct-face', 'aria-hidden': 'true' });
    if (!card) {
      s.appendChild(mk('rect', { x: 3, y: 3, width: 58, height: 78, rx: 9, class: 'ct-back' }));
      s.appendChild(mk('rect', { x: 10, y: 10, width: 44, height: 64, rx: 6, class: 'ct-back-in' }));
      s.appendChild(mk('text', { x: 32, y: 54, 'text-anchor': 'middle', class: 'ct-back-q' }, '?'));
      return s;
    }
    var paint = PAINT[card.color];
    s.appendChild(mk('rect', { x: 3, y: 3, width: 58, height: 78, rx: 9, fill: paint.fill, class: 'ct-card-edge' }));
    if (card.count === 2) { s.appendChild(shapeAt(card.color, 32, 26, 32, paint.ink)); s.appendChild(shapeAt(card.color, 32, 58, 32, paint.ink)); }
    else s.appendChild(shapeAt(card.color, 32, 42, 40, paint.ink));
    return s;
  }
  function showCard(card, flipping) {
    cardHost.textContent = '';
    var s = cardMarkup(card);
    if (flipping) s.classList.add('ct-flip');
    cardHost.appendChild(s);
    lastCard = card;
  }

  // ── the roster ──
  var scoreFn;
  function paintRoster() {
    var names = [], vals = [], i;
    for (i = 0; i < count; i++) { names.push(nameOf(i)); vals.push(pos[i] ? pos[i] : ''); }
    scoreFn(names, vals, G.over ? -1 : turn);
  }
  function buildRoster() {
    var defs = [];
    for (var i = 0; i < count; i++) defs.push({ color: PLAYERS[i].color });
    scoreFn = WK.scoreBar(roster, defs);
  }

  // ── turns ──
  function say(text, spin) { G.say(text, spin); }
  var rest = { pos: [], turn: 0 };   // what a save keeps while a draw is still animating: the last settled position, so the card is simply drawn again
  function mark() { rest = { pos: pos.slice(), turn: turn }; }
  function nextTurn() { turn = (turn + 1) % count; startTurn(); }
  function startTurn() {
    mark(); busy = false; paintRoster();
    drawBtn.disabled = !isHuman(turn) || G.over;
    drawBtn.setAttribute('aria-label', seats.hotseat() && isHuman(turn) ? T('ct.drawFor', { name: nameOf(turn) }) : T('ct.drawCard'));
    if (G.over) return;
    if (isHuman(turn)) say(T(seats.isYou(turn) ? 'ct.youDraw' : 'ct.toDraw', { name: nameOf(turn) }));
    else { busy = true; say(T('ct.drawing', { name: nameOf(turn) }), true); var token = G.begin(); setTimeout(function () { if (G.done(token)) doDraw(); }, COMPUTER_DELAY_MS); }
  }
  function doDraw() {
    var p = turn, token;
    busy = true; drawBtn.disabled = true;
    token = G.begin();
    var card = E.drawCard(Math.random);
    showCard(card, !BK.reducedMotion());
    setTimeout(function () {
      if (!G.done(token)) return;
      var r = E.move(pos[p], card), text = T(card.count === 2 ? 'ct.drewTwo' : 'ct.drewOne', { name: nameOf(p), color: T('ct.color.' + COLOR_NAMES[card.color]) });
      say(text);
      hop(p, r.from, r.landed, function () {
        if (r.bridge) {
          say(text + ' ' + T('ct.bridge'));
          slide(p, r.landed, r.to, function () { pos[p] = r.to; setToken(p, r.to); drawTokens(); finishTurn(r); });
        } else { pos[p] = r.to; drawTokens(); finishTurn(r); }
      });
    }, BK.reducedMotion() ? 0 : DRAW_MS);
  }
  function finishTurn(r) {
    paintRoster();
    if (r.won) { win(turn); return; }
    setTimeout(function () { nextTurn(); }, NEXT_DELAY_MS);
  }
  // Walk a token a square at a time (the road, not a leap), or jump straight there under reduced motion.
  function hop(p, from, to, done) {
    if (BK.reducedMotion() || from === to) { pos[p] = to; setToken(p, to); done(); return; }
    var n = from;
    (function stepOn() {
      n++; pos[p] = n; setToken(p, n);
      if (n >= to) done(); else setTimeout(stepOn, HOP_MS);
    })();
  }
  function slide(p, from, to, done) {
    if (BK.reducedMotion()) { done(); return; }
    var a = centre(from), b = centre(to), t0 = performance.now(), el = tokens[p];
    (function frame(now) {
      var t = Math.min(1, (now - t0) / SLIDE_MS), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      el.setAttribute('transform', 'translate(' + (a.x + (b.x - a.x) * e) + ' ' + (a.y + (b.y - a.y) * e) + ')');
      if (t < 1) requestAnimationFrame(frame); else done();
    })(t0);
  }
  function win(p) {
    mark();
    var who = nameOf(p), msg = T(seats.isYou(p) ? 'ct.youWin' : 'ct.reaches', { name: who });
    var outcome = seats.hotseat() ? null : seats.person(p) ? 'w' : 'l';
    G.finish(msg, outcome, who);
    drawBtn.disabled = true; paintRoster();
  }

  function newGame() {
    count = playerCount(); seats = seatsFor(count); turn = 0; pos = []; busy = false; lastCard = null;
    for (var i = 0; i < count; i++) pos.push(0);
    buildBoard(); buildRoster(); drawTokens(); showCard(null, false);
    startTurn();
  }
  // The seat rows (who is a person and who is the computer) follow the Players count inside the New game pane.
  (function seatRows() {
    var base = root.ZimiShell.gameInfo.menu;
    root.ZimiShell.game({
      table: '#ct-board',
      inProgress: function () { return !G.over && pos.some(Boolean); },
      menu: function () {
        var out = base ? base() : { options: [] }, first = out.options[0], holder = document.createElement('div');
        function build() {
          var pressed = first && first.querySelector('.gs-seg [aria-pressed="true"]'), n = +(pressed && pressed.textContent) || playerCount();
          holder.textContent = '';
          holder.appendChild(seatsFor(n).block(null, { labels: PLAYERS.slice(0, n).map(function (p, i) { return pname(i); }), note: T('sl.pass') }));
        }
        build();
        if (first) first.addEventListener('click', function () { setTimeout(build, 0); });
        out.options.push(holder);
        return out;
      }
    });
  })();
  drawBtn.addEventListener('click', function () { if (!busy && isHuman(turn) && !G.over) doDraw(); else if (!G.over) root.ZimiShell.shake(drawBtn); });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('.ar-sheet,input') || document.querySelector('.ar-sheet:not([hidden])')) return;
    var k = e.key.toLowerCase();
    if ((k === 'd' || (k === ' ' && e.target === document.body)) && !drawBtn.disabled && !busy) { e.preventDefault(); drawBtn.click(); }
  });

  G.showStats = function () {
    var s = BK.load('colortrail.stats', {}).all || { w: 0, l: 0 };
    $('wk-stats').textContent = G.vsComputer() && s.w + s.l > 0 ? T('sl.record', { won: s.w, lost: s.l }) : '';
  };
  G.newGame();
  // Leaving keeps the race: where everyone stands, whose turn it is, how many play and the last card; a finished race comes back to its end sheet.
  function kept() {
    if (!rest.pos.some(Boolean) && rest.turn === 0) return null;
    return { pos: rest.pos, turn: rest.turn, count: count, over: !!G.over, card: lastCard };
  }
  function takeUp(d) {
    if (!d || !Array.isArray(d.pos) || d.count < 2 || d.count > 4 || d.pos.length !== d.count || d.pos.some(function (n) { return !(n >= 0 && n <= E.LAST); }) || !(d.turn >= 0 && d.turn < d.count)) return false;
    G.cancel(); G.over = false; busy = false;
    G.settings.players = String(d.count); count = d.count; seats = seatsFor(count); pos = d.pos.slice(); turn = d.turn;
    buildBoard(); buildRoster(); drawTokens();
    showCard(d.card && d.card.color >= 0 && d.card.color < E.COLORS && (d.card.count === 1 || d.card.count === 2) ? d.card : null, false);
    if (!d.over) { startTurn(); return true; }
    G.over = true; paintRoster(); drawBtn.disabled = true;
    var p = Math.max(0, pos.indexOf(E.LAST)), who = nameOf(p), solo = !seats.hotseat();
    say(T(seats.isYou(p) ? 'ct.youWin' : 'ct.reaches', { name: who }));
    root.ZimiShell.endSheet({ result: solo ? (seats.person(p) ? 'win' : 'lose') : 'win', name: solo ? undefined : who, after: 0 });
    return true;
  }
  root.ZimiShell.persist({ save: kept, load: takeUp });
  root.__colortrail = { get pos() { return pos; }, get turn() { return turn; }, get count() { return count; }, get busy() { return busy; }, setPositions: function (a) { pos = a.slice(); drawTokens(); paintRoster(); mark(); } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
