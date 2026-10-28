/* ZimiGames: Snakes and Ladders, for two to four. Our own code and our own drawn board, GPL-3.0. No network, no modules.
   Two halves: the rules (pure functions, testable in node), then the page (runs only when there is a document).
   The board is the classic ten by ten with the squares numbered along each row in turn from the bottom left; a die roll
   moves a token; a ladder carries it up and a snake down; the last square needs an exact roll. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var SIZE = 10, LAST = SIZE * SIZE;
  // Foot to top of every ladder, and head to tail of every snake.
  var LADDERS = { 1: 38, 4: 14, 9: 31, 21: 42, 28: 84, 36: 44, 51: 67, 71: 91, 80: 100 };
  var SNAKES = { 16: 6, 47: 26, 49: 11, 56: 53, 62: 19, 64: 60, 87: 24, 93: 73, 95: 75, 98: 78 };

  // Row 0 is the bottom; odd rows run right to left.
  function cellOf(n) {
    var r = Math.floor((n - 1) / SIZE), c = (n - 1) % SIZE;
    return { row: r, col: r % 2 === 0 ? c : SIZE - 1 - c };
  }
  function jumpOf(n) { return LADDERS[n] || SNAKES[n] || 0; }

  // One turn of one token: { from, roll, landed, to, jump: 'ladder' | 'snake' | null, moved, won, again }.
  function step(from, roll, rules) {
    var target = from + roll, out = { from: from, roll: roll, landed: from, to: from, jump: null, moved: false, won: false, again: !!(rules && rules.again && roll === 6) };
    if (target > LAST) return out;                       // too many to finish: the token stays
    out.moved = true; out.landed = target; out.to = target;
    var j = jumpOf(target);
    if (j) { out.to = j; out.jump = j > target ? 'ladder' : 'snake'; }
    out.won = out.to === LAST;
    if (out.won) out.again = false;
    return out;
  }

  root.SnakesLaddersEngine = { SIZE: SIZE, LAST: LAST, LADDERS: LADDERS, SNAKES: SNAKES, cellOf: cellOf, jumpOf: jumpOf, step: step };

  // ── the page ─────────────────────────────────────────────────────────────
  if (typeof document === 'undefined') return;
  var WK = root.WorldKit, BK = root.BoardKit, E = root.SnakesLaddersEngine, $ = function (id) { return document.getElementById(id); };
  var T = function (id, vars) { return root.ZimiText ? root.ZimiText.T(id, vars) : id; };
  var NS = 'http://www.w3.org/2000/svg', CELL = 60, VIEW = SIZE * CELL, START_STRIP = 48, START_X = 90, START_STEP = 44;
  var HOP_MS = 150, SLIDE_MS = 520, ROLL_FLICKER_MS = 80, ROLL_MS = 600, COMPUTER_DELAY_MS = 650, NEXT_DELAY_MS = 450;
  var PLAYERS = [
    { id: 'blue', name: 'Blue', color: '#2f5aa8', dark: '#1d3a74', shape: 'circle' },
    { id: 'red', name: 'Red', color: '#c0392b', dark: '#7d261b', shape: 'square' },
    { id: 'green', name: 'Green', color: '#2e8b57', dark: '#1d5a38', shape: 'triangle' },
    { id: 'gold', name: 'Gold', color: '#d49a1a', dark: '#8a6410', shape: 'diamond' }
  ];
  var SNAKE_COLORS = ['#2e8b57', '#7a4fa3', '#c47a1c', '#1f8a99', '#b5402f'];
  var PIP_LAYOUT = { 1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]], 4: [[-1, -1], [1, -1], [-1, 1], [1, 1]], 5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], 6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]] };

  var G = WK.create({
    id: 'snakesandladders',
    options: [
      { key: 'players', legend: 'sl.players', def: '2', choices: [['2', '2'], ['3', '3'], ['4', '4']] }
    ],
    checks: [{ key: 'again', label: 'sl.again', def: false }],
    statKey: function () { return 'all'; },
    onNew: newGame
  });
  // Each seat is a Computer or a Person (handoff.js). A game saved before seats existed with "People on this device"
  // keeps every seat a person, once.
  function pname(p) { return T('sl.color.' + p.id); }
  var SEATS_KEY = 'zimi.games.snakesandladders.seats', seats;
  function seatsFor(n) { return root.ZimiSeats.create({ id: 'snakesandladders', seats: n, cpuNames: PLAYERS.map(function (p, i) { return root.ZimiSeats.cpuName(i); }) }); }
  (function migrate() {
    var had = false;
    try { had = root.localStorage.getItem(SEATS_KEY) !== null; } catch (e) { had = true; }
    if (had || G.settings.mode !== 'two') return;
    var s = seatsFor(4);
    for (var i = 0; i < 4; i++) s.setKind(i, 'person');
  })();
  seats = seatsFor(playerCount());   // the stats line is drawn before the first game
  var host = $('sl-board'), dieHost = $('sl-die'), rollBtn = $('sl-roll'), roster = $('wk-score'), svg, tokens = [], pos = [], count = 2, turn = 0, busy = false, lastNote = '';

  function playerCount() { return +G.settings.players; }
  function isHuman(p) { return seats.person(p); }
  function nameOf(p) { return seats.name(p); }
  G.vsComputer = function () { return !seats.hotseat(); };
  function mk(tag, attrs, text) { var e = document.createElementNS(NS, tag); Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); }); if (text != null) e.textContent = text; return e; }
  function centre(n) { var c = E.cellOf(n); return { x: c.col * CELL + CELL / 2, y: (SIZE - 1 - c.row) * CELL + CELL / 2 }; }

  // ── drawing the board ──
  function ladderShape(from, to) {
    var a = centre(from), b = centre(to), dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len, nx = -uy * 7, ny = ux * 7;
    var d = 'M' + (a.x + nx) + ' ' + (a.y + ny) + 'L' + (b.x + nx) + ' ' + (b.y + ny) + 'M' + (a.x - nx) + ' ' + (a.y - ny) + 'L' + (b.x - nx) + ' ' + (b.y - ny);
    for (var t = 14; t < len - 8; t += 17) d += 'M' + (a.x + ux * t + nx) + ' ' + (a.y + uy * t + ny) + 'L' + (a.x + ux * t - nx) + ' ' + (a.y + uy * t - ny);
    return mk('path', { d: d, class: 'sl-ladder' });
  }
  // A ribbon that swings from side to side along the way from the head to the tail, thick at the head, thin at the tail.
  function snakeShape(head, tail, idx) {
    var a = centre(head), b = centre(tail), dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
    var waves = Math.max(1.5, Math.round(len / 90)), amp = Math.min(20, 8 + len / 30), steps = 44, left = [], right = [], mid = [], t, i;
    for (i = 0; i <= steps; i++) {
      t = i / steps;
      var off = Math.sin(t * Math.PI * 2 * waves) * amp * Math.sin(Math.min(1, t * 6 + 0.15) * Math.PI / 2), w = 11 - 8 * t;
      var px = a.x + dx * t + nx * off, py = a.y + dy * t + ny * off;
      mid.push([px, py, w]);
    }
    for (i = 0; i <= steps; i++) {
      var p = mid[i], q = mid[Math.min(steps, i + 1)], r = mid[Math.max(0, i - 1)], tx = q[0] - r[0], ty = q[1] - r[1], tl = Math.hypot(tx, ty) || 1, ox = -ty / tl, oy = tx / tl;
      left.push((p[0] + ox * p[2]).toFixed(1) + ' ' + (p[1] + oy * p[2]).toFixed(1)); right.push((p[0] - ox * p[2]).toFixed(1) + ' ' + (p[1] - oy * p[2]).toFixed(1));
    }
    var g = mk('g', { class: 'sl-snake' }), color = SNAKE_COLORS[idx % SNAKE_COLORS.length];
    g.appendChild(mk('polygon', { points: left.join(' ') + ' ' + right.reverse().join(' '), fill: color, stroke: 'rgba(0,0,0,0.35)', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
    var bands = '';
    for (i = 5; i < steps - 2; i += 5) { var m = mid[i], m2 = mid[i + 1], tl2 = Math.hypot(m2[0] - m[0], m2[1] - m[1]) || 1, bx = -(m2[1] - m[1]) / tl2 * m[2] * 0.8, by = (m2[0] - m[0]) / tl2 * m[2] * 0.8; bands += 'M' + (m[0] + bx) + ' ' + (m[1] + by) + 'L' + (m[0] - bx) + ' ' + (m[1] - by); }
    g.appendChild(mk('path', { d: bands, stroke: 'rgba(255,255,255,0.5)', 'stroke-width': 2.4, fill: 'none', 'stroke-linecap': 'round' }));
    // the head: a rounded triangle pointing away from the body, two eyes
    var h0 = mid[0], h1 = mid[1], hl = Math.hypot(h1[0] - h0[0], h1[1] - h0[1]) || 1, hx = -(h1[0] - h0[0]) / hl, hy = -(h1[1] - h0[1]) / hl, hnx = -hy, hny = hx;
    var tip = [h0[0] + hx * 16, h0[1] + hy * 16], bl = [h0[0] + hnx * 12 - hx * 3, h0[1] + hny * 12 - hy * 3], br = [h0[0] - hnx * 12 - hx * 3, h0[1] - hny * 12 - hy * 3];
    g.appendChild(mk('polygon', { points: tip.join(',') + ' ' + bl.join(',') + ' ' + br.join(','), fill: color, stroke: 'rgba(0,0,0,0.4)', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
    [1, -1].forEach(function (s) { g.appendChild(mk('circle', { cx: h0[0] + hx * 5 + hnx * 5.5 * s, cy: h0[1] + hy * 5 + hny * 5.5 * s, r: 2.4, fill: '#fff6dc', stroke: '#1b1b1b', 'stroke-width': 1 })); });
    return g;
  }
  function tokenShape(p, r) {
    var pl = PLAYERS[p], g = mk('g', { class: 'sl-token' });
    var shape = pl.shape === 'circle' ? mk('circle', { r: r }) : pl.shape === 'square' ? mk('rect', { x: -r * 0.88, y: -r * 0.88, width: r * 1.76, height: r * 1.76, rx: r * 0.25 }) :
      pl.shape === 'triangle' ? mk('polygon', { points: '0,' + (-r * 1.05) + ' ' + (r * 1.0) + ',' + (r * 0.8) + ' ' + (-r * 1.0) + ',' + (r * 0.8), 'stroke-linejoin': 'round' }) : mk('polygon', { points: '0,' + (-r * 1.1) + ' ' + (r * 1.0) + ',0 0,' + (r * 1.1) + ' ' + (-r * 1.0) + ',0', 'stroke-linejoin': 'round' });
    shape.setAttribute('fill', pl.color); shape.setAttribute('stroke', pl.dark); shape.setAttribute('stroke-width', 3);
    g.appendChild(shape);
    g.appendChild(mk('text', { y: r * 0.36, 'text-anchor': 'middle', 'font-size': r * 1.05, 'font-weight': 800, fill: '#fff' }, String(p + 1)));
    return g;
  }
  function buildBoard() {
    host.textContent = '';
    svg = mk('svg', { viewBox: '0 0 ' + VIEW + ' ' + (VIEW + START_STRIP), role: 'img', 'aria-label': T('sl.board') });
    var n, c, g = mk('g'); svg.appendChild(mk('rect', { x: 0, y: VIEW, width: VIEW, height: START_STRIP, class: 'sl-strip' })); svg.appendChild(mk('text', { x: 14, y: VIEW + START_STRIP / 2 + 5, class: 'sl-start' }, T('sl.start'))); svg.appendChild(g);
    for (n = 1; n <= E.LAST; n++) {
      c = E.cellOf(n);
      var x = c.col * CELL, y = (SIZE - 1 - c.row) * CELL;
      g.appendChild(mk('rect', { x: x, y: y, width: CELL, height: CELL, class: 'sl-sq' + ((c.row + c.col) % 2 ? ' alt' : '') + (n === 1 ? ' start' : n === E.LAST ? ' end' : '') }));
    }
    var pathG = mk('g'); svg.appendChild(pathG);
    Object.keys(E.LADDERS).forEach(function (k) { pathG.appendChild(ladderShape(+k, E.LADDERS[k])); });
    Object.keys(E.SNAKES).forEach(function (k, i) { pathG.appendChild(snakeShape(+k, E.SNAKES[k], i)); });
    var nums = mk('g'); svg.appendChild(nums);
    for (n = 1; n <= E.LAST; n++) { c = E.cellOf(n); nums.appendChild(mk('text', { x: c.col * CELL + 4, y: (SIZE - 1 - c.row) * CELL + 12, class: 'sl-n' }, String(n))); }
    var f = centre(E.LAST); svg.appendChild(mk('path', { d: 'M' + f.x + ' ' + (f.y - 16) + 'l5 11 12 1-9 8 3 12-11-6-11 6 3-12-9-8 12-1z', class: 'sl-star' }));
    svg.appendChild(mk('g', { id: 'sl-tokens' }));
    host.appendChild(svg);
  }

  // Where a token stands inside its square (up to four share one).
  var SPOTS = [[-0.24, -0.1], [0.24, -0.1], [-0.24, 0.3], [0.24, 0.3]];
  function tokenXY(p, n) {
    if (n === 0) return { x: START_X + p * START_STEP, y: VIEW + START_STRIP / 2 };
    var c = centre(n), sharing = [], i;
    for (i = 0; i < count; i++) if (pos[i] === n) sharing.push(i);
    var k = sharing.indexOf(p), s = sharing.length > 1 ? SPOTS[k] : [0, 0.05];
    return { x: c.x + s[0] * CELL, y: c.y + s[1] * CELL };
  }
  function drawTokens() {
    var layer = svg.querySelector('#sl-tokens'), i;
    layer.textContent = '';
    tokens = [];
    for (i = 0; i < count; i++) {
      var t = tokenShape(i, pos[i] && count > 1 && pos.filter(function (q) { return q === pos[i]; }).length > 1 ? 11 : 15), xy = tokenXY(i, pos[i]);
      t.setAttribute('transform', 'translate(' + xy.x + ' ' + xy.y + ')'); layer.appendChild(t); tokens.push(t);
    }
  }
  function setToken(p, n) { var xy = tokenXY(p, n); tokens[p].setAttribute('transform', 'translate(' + xy.x + ' ' + xy.y + ')'); }

  // ── the die ──
  function dieMarkup(face, rolling) {
    var pips = (PIP_LAYOUT[face] || []).map(function (p) { return '<circle cx="' + (32 + p[0] * 16) + '" cy="' + (32 + p[1] * 16) + '" r="5.5"/>'; }).join('');
    return '<svg class="sl-die' + (rolling ? ' tumble' : '') + '" viewBox="0 0 64 64" aria-hidden="true"><rect x="4" y="4" width="56" height="56" rx="12"/>' + pips + '</svg>';
  }
  function showDie(face, rolling) { dieHost.innerHTML = face ? dieMarkup(face, rolling) : dieMarkup(0, false); }
  function rollDie(done) {
    var face = 1 + Math.floor(Math.random() * 6);
    if (BK.reducedMotion()) { showDie(face, false); done(face); return; }
    var timer = setInterval(function () { showDie(1 + Math.floor(Math.random() * 6), true); }, ROLL_FLICKER_MS);
    setTimeout(function () { clearInterval(timer); showDie(face, false); done(face); }, ROLL_MS);
  }

  // ── the roster ──
  var scoreFn;
  function paintRoster() {
    var names = [], vals = [], i;
    for (i = 0; i < count; i++) { names.push(nameOf(i)); vals.push(pos[i] ? pos[i] : T('sl.startWord')); }
    scoreFn(names, vals, G.over ? -1 : turn);
  }
  function buildRoster() {
    var defs = [];
    for (var i = 0; i < count; i++) defs.push({ color: PLAYERS[i].color });
    scoreFn = WK.scoreBar(roster, defs);
  }

  // ── turns ──
  function say(text, spin) { lastNote = text; G.say(text, spin); }
  function nextTurn() {
    turn = (turn + 1) % count;
    startTurn();
  }
  // What a save keeps while a roll is still animating: the last settled position, so the roll is simply rolled again.
  var rest = { pos: [], turn: 0 };
  function mark() { rest = { pos: pos.slice(), turn: turn }; }
  function startTurn() {
    mark(); busy = false; paintRoster();
    rollBtn.disabled = !isHuman(turn) || G.over;
    rollBtn.setAttribute('aria-label', seats.hotseat() && isHuman(turn) ? T('sl.rollFor', { name: nameOf(turn) }) : T('sl.rollDie'));
    if (G.over) return;
    if (isHuman(turn)) say(T(seats.isYou(turn) ? 'sl.youRoll' : 'sl.toRoll', { name: nameOf(turn) }));
    else { busy = true; say(T('sl.rolling', { name: nameOf(turn) }), true); var token = G.begin(); setTimeout(function () { if (G.done(token)) doRoll(); }, COMPUTER_DELAY_MS); }
  }
  function doRoll() {
    var p = turn;
    busy = true; rollBtn.disabled = true;
    var token = G.begin();
    rollDie(function (face) {
      if (!G.done(token)) return;
      var r = E.step(pos[p], face, { again: G.settings.again });
      var who = nameOf(p), text = T('sl.rolled', { name: who, n: face });
      if (!r.moved) { say(text + ' ' + T('sl.tooMany', { n: pos[p] })); setTimeout(function () { finishTurn(r); }, NEXT_DELAY_MS * 2); return; }
      hop(p, r.from, r.landed, function () {
        if (r.jump) {
          text += ' ' + T(r.jump === 'ladder' ? 'sl.ladder' : 'sl.snake', { from: r.landed, to: r.to });
          say(text);
          slide(p, r.landed, r.to, function () { pos[p] = r.to; setToken(p, r.to); drawTokens(); finishTurn(r, text); });
        } else { pos[p] = r.to; drawTokens(); finishTurn(r, text + ' ' + T('sl.on', { n: r.to })); }
      });
    });
  }
  function finishTurn(r, text) {
    paintRoster();
    if (r.won) { win(turn); return; }
    if (text) say(text + (r.again ? ' ' + T('sl.again.roll') : ''));
    setTimeout(function () { if (r.again) startTurn(); else nextTurn(); }, NEXT_DELAY_MS);
  }
  // Walk a token a square at a time, or jump straight there under reduced motion.
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
    var who = nameOf(p), msg = T(seats.isYou(p) ? 'sl.youWin' : 'sl.reaches', { name: who });
    var outcome = seats.hotseat() ? null : seats.person(p) ? 'w' : 'l';
    G.finish(msg, outcome, who);
    rollBtn.disabled = true; paintRoster();
  }

  function newGame() {
    count = playerCount(); seats = seatsFor(count); turn = 0; pos = []; busy = false;
    for (var i = 0; i < count; i++) pos.push(0);
    buildBoard(); buildRoster(); drawTokens(); showDie(0, false);
    startTurn();
  }
  // The seat rows (who is a person and who is the computer) follow the Players count inside the New game pane.
  (function seatRows() {
    var base = root.ZimiShell.gameInfo.menu;
    root.ZimiShell.game({
      inProgress: function () { return !G.over && pos.some(Boolean); },
      menu: function () {
        var out = base ? base() : { options: [] }, first = out.options[0], holder = document.createElement('div');
        function build() {
          var pressed = first && first.querySelector('.gs-seg [aria-pressed="true"]'), n = +(pressed && pressed.textContent) || playerCount();
          holder.textContent = '';
          holder.appendChild(seatsFor(n).block(null, { labels: PLAYERS.slice(0, n).map(pname), note: T('sl.pass') }));
        }
        build();
        if (first) first.addEventListener('click', function () { setTimeout(build, 0); });
        out.options.push(holder);
        return out;
      }
    });
  })();
  rollBtn.addEventListener('click', function () { if (!busy && isHuman(turn) && !G.over) doRoll(); else if (!G.over) { root.ZimiShell.shake(rollBtn); } });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('.ar-sheet,input') || document.querySelector('.ar-sheet:not([hidden])')) return;
    var k = e.key.toLowerCase();
    if ((k === 'r' || (k === ' ' && e.target === document.body)) && !rollBtn.disabled && !busy) { e.preventDefault(); rollBtn.click(); }
  });

  // The records line says how games against the computers went, and stays empty until the first one.
  G.showStats = function () {
    var s = BK.load('snakesandladders.stats', {}).all || { w: 0, l: 0 };
    $('wk-stats').textContent = G.vsComputer() && s.w + s.l > 0 ? T('sl.record', { won: s.w, lost: s.l }) : '';
  };
  G.newGame();
  // Leaving keeps the race: where everyone stands, whose turn it is and how many play; a finished race comes back to its end sheet.
  function kept() {
    if (!rest.pos.some(Boolean) && rest.turn === 0) return null;
    return { pos: rest.pos, turn: rest.turn, count: count, over: !!G.over };
  }
  function takeUp(d) {
    if (!d || !Array.isArray(d.pos) || d.count < 2 || d.count > 4 || d.pos.length !== d.count || d.pos.some(function (n) { return !(n >= 0 && n <= E.LAST); }) || !(d.turn >= 0 && d.turn < d.count)) return false;
    G.cancel(); G.over = false; busy = false;
    G.settings.players = String(d.count); count = d.count; seats = seatsFor(count); pos = d.pos.slice(); turn = d.turn;
    buildBoard(); buildRoster(); drawTokens(); showDie(0, false);
    if (!d.over) { startTurn(); return true; }
    G.over = true; paintRoster(); rollBtn.disabled = true;
    var p = Math.max(0, pos.indexOf(E.LAST)), who = nameOf(p), solo = !seats.hotseat();
    say(T(seats.isYou(p) ? 'sl.youWin' : 'sl.reaches', { name: who }));
    root.ZimiShell.endSheet({ result: solo ? (seats.person(p) ? 'win' : 'lose') : 'win', name: solo ? undefined : who, after: 0 });
    return true;
  }
  root.ZimiShell.persist({ save: kept, load: takeUp });
  root.__slState = function () { return JSON.stringify([rest.pos, rest.turn]); };
  if (new URLSearchParams(location.search).has('debug')) root.__sl = { engine: E, positions: function () { return pos; }, turn: function () { return turn; }, setPositions: function (a) { pos = a.slice(); drawTokens(); paintRoster(); } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
