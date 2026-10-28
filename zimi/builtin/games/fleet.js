/* ZimiGames: Fleet. Our own code, GPL-3.0. No network, no fonts, no modules.
   The rules (pure functions, no DOM, so node can test them) and the page (only when there is a document). */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var SIZE = 10;
  var FLEET = [['Carrier', 5], ['Cruiser', 4], ['Frigate', 3], ['Sloop', 3], ['Skiff', 2]];
  var UNKNOWN = 0, MISS = 1, HIT = 2, SUNK = 3;
  var HIT_WEIGHT = 40; // a ship that could cover a standing hit is worth this many empty-water ones

  var mulberry = root.ZimiUtil.mulberry32;

  function emptyGrid() { var g = []; for (var y = 0; y < SIZE; y++) { g.push([]); for (var x = 0; x < SIZE; x++) g[y].push(UNKNOWN); } return g; }
  function createBoard() { return { ships: [], shots: emptyGrid() }; }

  function cellsFor(len, x, y, horiz) {
    var c = [];
    for (var i = 0; i < len; i++) c.push(horiz ? [x + i, y] : [x, y + i]);
    return c;
  }
  function inBounds(x, y) { return x >= 0 && y >= 0 && x < SIZE && y < SIZE; }
  function shipAt(board, x, y) {
    for (var i = 0; i < board.ships.length; i++) {
      var s = board.ships[i];
      for (var k = 0; k < s.cells.length; k++) if (s.cells[k][0] === x && s.cells[k][1] === y) return s;
    }
    return null;
  }
  function canPlace(board, cells) {
    return cells.every(function (c) { return inBounds(c[0], c[1]) && !shipAt(board, c[0], c[1]); });
  }
  function addShip(board, name, len, x, y, horiz) {
    var cells = cellsFor(len, x, y, horiz);
    if (!canPlace(board, cells)) return null;
    var s = { name: name, len: len, cells: cells, hits: 0 };
    board.ships.push(s);
    return s;
  }
  function randomFleet(rng) {
    var b = createBoard();
    FLEET.forEach(function (f) {
      for (var tries = 0; tries < 1000; tries++) {
        var horiz = rng() < 0.5, x = Math.floor(rng() * (horiz ? SIZE - f[1] + 1 : SIZE)), y = Math.floor(rng() * (horiz ? SIZE : SIZE - f[1] + 1));
        if (addShip(b, f[0], f[1], x, y, horiz)) return;
      }
    });
    return b;
  }

  // Fire at a square. null when it was already fired on, else {result, ship, win}.
  function fire(board, x, y) {
    if (!inBounds(x, y) || board.shots[y][x] !== UNKNOWN) return null;
    var s = shipAt(board, x, y);
    if (!s) { board.shots[y][x] = MISS; return { result: 'miss', ship: null, win: false }; }
    board.shots[y][x] = HIT; s.hits++;
    if (s.hits < s.len) return { result: 'hit', ship: s, win: false };
    s.cells.forEach(function (c) { board.shots[c[1]][c[0]] = SUNK; });
    return { result: 'sunk', ship: s, win: board.ships.every(function (q) { return q.hits === q.len; }) };
  }
  function remainingLens(board) { return board.ships.filter(function (s) { return s.hits < s.len; }).map(function (s) { return s.len; }); }

  // The computer's shot, from what it can see: the shots grid and the lengths still afloat. Every way a ship
  // could still lie is counted; squares that fit more of them are better, and ways that cover a standing
  // hit count far more, so it finishes a ship it has found before it hunts anew.
  function aiShot(shots, lens, rng) {
    var w = emptyGrid(), x, y, i, k;
    for (i = 0; i < lens.length; i++) {
      var len = lens[i];
      for (var dir = 0; dir < 2; dir++) {
        for (y = 0; y < SIZE; y++) for (x = 0; x < SIZE; x++) {
          var cells = cellsFor(len, x, y, dir === 0), ok = true, hits = 0;
          for (k = 0; k < len; k++) {
            var c = cells[k];
            if (!inBounds(c[0], c[1])) { ok = false; break; }
            var v = shots[c[1]][c[0]];
            if (v === MISS || v === SUNK) { ok = false; break; }
            if (v === HIT) hits++;
          }
          if (!ok) continue;
          var add = hits ? HIT_WEIGHT * hits : 1;
          for (k = 0; k < len; k++) if (shots[cells[k][1]][cells[k][0]] === UNKNOWN) w[cells[k][1]][cells[k][0]] += add;
        }
      }
    }
    var best = -1, picks = [];
    for (y = 0; y < SIZE; y++) for (x = 0; x < SIZE; x++) {
      if (shots[y][x] !== UNKNOWN) continue;
      if (w[y][x] > best) { best = w[y][x]; picks = [[x, y]]; } else if (w[y][x] === best) picks.push([x, y]);
    }
    return picks.length ? picks[Math.floor(rng() * picks.length)] : null;
  }

  function label(x, y) { return String.fromCharCode(65 + x) + (y + 1); }

  var Engine = { SIZE: SIZE, FLEET: FLEET, UNKNOWN: UNKNOWN, MISS: MISS, HIT: HIT, SUNK: SUNK, createBoard: createBoard, cellsFor: cellsFor, canPlace: canPlace, addShip: addShip, shipAt: shipAt, randomFleet: randomFleet, fire: fire, remainingLens: remainingLens, aiShot: aiShot, label: label, mulberry: mulberry };
  root.FleetEngine = Engine;

  if (typeof document === 'undefined' || !root.BoardUI) return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, UI = root.BoardUI, T = UI.t, $ = Play.$;
  var STATS_KEY = 'zimi.games.fleet.stats', CPU_DELAY_MS = 700, SUNK_DELAY_MS = 1200;   // a sinking is given time to be read before the computer fires
  Play.applyTheme();

  var els = { msg: $('fl-msg'), tools: $('fl-tools'), tray: $('fl-tray'), enemy: $('fl-enemy'), enemyWrap: $('fl-enemy-wrap'), mine: $('fl-mine'), eships: $('fl-enemy-ships'), nu: $('fl-new') };
  var line = UI.status(els.msg);
  var stats = Play.load(STATS_KEY, { played: 0, won: 0, bestShots: 0 });
  var boards = [], lastShot = [null, null], seats, actor = 0, placeIdx = 0, shotsBy = [0, 0];
  var phase = 'place', mine, theirs, sel = 0, horiz = true, timer = null, rng, shotsFired = 0, lastMine = null, lastTheirs = null;
  var lastText = '';
  function say(text) { lastText = text; line.say(text); }
  function shipName(name) { return T('fleet.ship.' + name.toLowerCase()); }
  function shipLabel(f) { return T('fleet.shipLen', { name: shipName(f[0]), n: f[1] }); }

  // Seats: Player 1 and Player 2 are each the Computer or a Person. Two people place and fire in turn,
  // each behind a handoff, so neither sees the other's fleet.
  function setActor(i) {
    actor = i; mine = boards[i]; theirs = boards[1 - i]; lastMine = lastShot[i]; lastTheirs = lastShot[1 - i];
    $('fl-mine-h').textContent = seats.hotseat() ? T('fleet.fleetOf', { name: seats.name(i) }) : T('fleet.yourFleet');
    shotsFired = shotsBy[i];
  }
  function setMine(b) { boards[actor] = mine = b; }
  function otherPerson() { return seats.hotseat(); }

  function buildGrid(el, handler) {
    el.textContent = '';
    var cells = [];
    for (var y = 0; y < SIZE; y++) for (var x = 0; x < SIZE; x++) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'fl-c'; b.dataset.x = x; b.dataset.y = y;
      b.setAttribute('role', 'gridcell');
      (function (cx, cy) { b.addEventListener('click', function () { handler(cx, cy); }); })(x, y);
      el.appendChild(b); cells.push(b);
    }
    el.addEventListener('keydown', function (e) {
      var t = e.target; if (!t || !t.dataset || t.dataset.x === undefined) return;
      var dx = { ArrowLeft: -1, ArrowRight: 1 }[e.key] || 0, dy = { ArrowUp: -1, ArrowDown: 1 }[e.key] || 0;
      if (!dx && !dy) return;
      e.preventDefault();
      var nx = Math.max(0, Math.min(SIZE - 1, +t.dataset.x + dx)), ny = Math.max(0, Math.min(SIZE - 1, +t.dataset.y + dy));
      cells[ny * SIZE + nx].focus();
    });
    return cells;
  }
  var mineCells, enemyCells;

  function stateOf(board, x, y, reveal) {
    var v = board.shots[y][x], s = shipAt(board, x, y);
    var cls = '', name = label(x, y);
    if (v === SUNK) { cls = 'fl-hit fl-sunk'; name = T('fleet.cell.sunk', { cell: name }); }
    else if (v === HIT) { cls = 'fl-hit'; name = T('fleet.cell.hit', { cell: name }); }
    else if (v === MISS) { cls = 'fl-miss'; name = T('fleet.cell.miss', { cell: name }); }
    else if (reveal && s) { cls = 'fl-ship'; name = T('fleet.cell.ship', { cell: name }); }
    return { cls: cls, name: name, s: s };
  }
  function paintMine() {
    mineCells.forEach(function (b) {
      var x = +b.dataset.x, y = +b.dataset.y, st = stateOf(mine, x, y, true);
      b.className = 'fl-c ' + st.cls + (st.s ? ' fl-ship' : '') + (lastTheirs && lastTheirs[0] === x && lastTheirs[1] === y ? ' fl-last' : '');
      b.setAttribute('aria-label', st.name);
      b.disabled = phase !== 'place';
    });
  }
  function paintEnemy() {
    enemyCells.forEach(function (b) {
      var x = +b.dataset.x, y = +b.dataset.y, st = stateOf(theirs, x, y, phase === 'over');
      b.className = 'fl-c ' + st.cls + (lastMine && lastMine[0] === x && lastMine[1] === y ? ' fl-last' : '');
      b.setAttribute('aria-label', st.name);
      b.disabled = phase !== 'battle' || theirs.shots[y][x] !== UNKNOWN;
    });
    els.enemy.classList.toggle('fl-aim', phase === 'battle');
    els.eships.textContent = '';
    theirs.ships.forEach(function (s, i) {
      var e = document.createElement(s.hits === s.len ? 's' : 'span'); e.textContent = shipLabel([s.name, s.len]); els.eships.appendChild(e);
      if (i < theirs.ships.length - 1) els.eships.appendChild(document.createTextNode(' · '));
    });
  }
  function button(parent, text, fn, opts) {
    opts = opts || {};
    var b = document.createElement('button'); b.type = 'button'; b.className = 'ar-btn' + (opts.cls ? ' ' + opts.cls : ''); b.textContent = text; b.disabled = !!opts.disabled;
    if (opts.aria) b.setAttribute('aria-label', opts.aria);
    b.addEventListener('click', fn); parent.appendChild(b); return b;
  }
  // The ships to place sit in a tray of their own; the action row holds the moves (Rotate, Shuffle, Start battle).
  function paintTools() {
    els.tools.textContent = ''; els.tray.textContent = '';
    if (phase === 'pass') {
      var nx = 1 - actor;
      button(els.tools, T('fleet.pass', { name: seats.name(nx) }), function () { handTo(nx, 'battle'); }).setAttribute('aria-pressed', 'true');
      return;
    }
    if (phase !== 'place') return;
    FLEET.forEach(function (f, i) {
      var placed = mine.ships.some(function (s) { return s.name === f[0]; });
      var b = button(els.tray, shipLabel(f), function () { if (!placed) { sel = i; paintTools(); } },
        { cls: placed ? 'fl-done' : '', aria: T(placed ? 'fleet.shipPlaced' : 'fleet.shipSquares', { name: shipName(f[0]), n: f[1] }) });
      b.setAttribute('aria-pressed', String(sel === i && !placed));
    });
    button(els.tools, T(horiz ? 'fleet.rotate.across' : 'fleet.rotate.down'), function () { horiz = !horiz; paintTools(); });
    button(els.tools, T('fleet.shuffle'), function () { setMine(randomFleet(rng)); sel = FLEET.length; say(T('fleet.allPlaced')); paintAll(); });
    var all = mine.ships.length === FLEET.length;
    var more = seats.hotseat() && placeIdx < seats.people().length - 1;
    var go = button(els.tools, more ? T('fleet.pass', { name: seats.name(seats.people()[placeIdx + 1]) }) : T('fleet.startBattle'), startBattle, { disabled: !all });
    go.setAttribute('aria-pressed', String(all));
  }
  function paintAll() { paintMine(); paintEnemy(); paintTools(); els.enemyWrap.hidden = phase === 'place'; els.mine.classList.toggle('fl-small', phase !== 'place'); }

  function nextUnplaced() {
    for (var i = 0; i < FLEET.length; i++) if (!mine.ships.some(function (s) { return s.name === FLEET[i][0]; })) return i;
    return FLEET.length;
  }
  function placeLine() { return T('fleet.place', { name: shipName(FLEET[sel][0]), n: FLEET[sel][1] }); }
  function onMine(x, y) {
    if (phase !== 'place') return;
    var existing = shipAt(mine, x, y);
    if (existing) { mine.ships.splice(mine.ships.indexOf(existing), 1); sel = FLEET.findIndex(function (f) { return f[0] === existing.name; }); say(placeLine()); paintAll(); return; }
    if (sel >= FLEET.length) return;
    var f = FLEET[sel], px = horiz ? Math.min(x, SIZE - f[1]) : x, py = horiz ? y : Math.min(y, SIZE - f[1]);
    if (!addShip(mine, f[0], f[1], px, py, horiz)) { UI.refuse(line, mineCells[y * SIZE + x], T('fleet.noFit')); return; }
    sel = nextUnplaced(); say(sel >= FLEET.length ? T('fleet.allPlaced') : placeLine());
    paintAll();
  }

  // Pass the device: the cover first, then the next person's screen.
  function handTo(i, nextPhase) {
    phase = nextPhase;
    seats.cover(i, function () { setActor(i); turnMessage(); paintAll(); }, T('fleet.cover'));
    setActor(i); paintAll();
  }
  function turnMessage() {
    if (phase === 'place') say(seats.hotseat() ? UI.noted(placeLine(), T('fleet.placesFirst', { name: seats.name(actor) })) : placeLine());
    else {
      var fire = seats.hotseat() ? T('fleet.fireName', { name: seats.name(actor) }) : T('fleet.fireYou');
      say(seats.hotseat() && lastTheirs ? UI.noted(T('fleet.lastShot', { cell: label(lastTheirs[0], lastTheirs[1]) }), fire) : fire);
    }
  }
  function startBattle() {
    if (seats.hotseat() && placeIdx < seats.people().length - 1) { placeIdx++; sel = 0; horiz = true; handTo(seats.people()[placeIdx], 'place'); return; }
    phase = 'battle'; shotsBy = [0, 0]; lastShot = [null, null];
    if (seats.hotseat()) { handTo(seats.people()[0], 'battle'); return; }
    setActor(seats.people()[0]); turnMessage();
    paintAll();
    enemyCells[0].focus({ preventScroll: true });
  }
  // The result of a shot: yours ("A1: hit.") or the computer's ("The computer fired at B2: hit.").
  function shotText(r, cpu, cell) {
    return T('fleet.' + (cpu ? 'cpu.' : 'shot.') + (r.result === 'miss' || r.result === 'hit' ? r.result : 'sank'), { cell: cell, ship: r.ship ? shipName(r.ship.name) : '' });
  }
  function onEnemy(x, y) {
    if (phase !== 'battle') return;
    var r = fire(theirs, x, y); if (!r) return;
    shotsBy[actor]++; shotsFired = shotsBy[actor]; lastMine = lastShot[actor] = [x, y];
    phase = 'busy';
    say(shotText(r, false, label(x, y)));
    if (r.win) { phase = 'over'; paintAll(); return finish(true); }
    if (otherPerson()) { phase = 'pass'; paintAll(); return; }
    paintAll();
    timer = Play.later(cpuTurn, r.result === 'sunk' ? SUNK_DELAY_MS : CPU_DELAY_MS);
  }
  function cpuTurn() {
    var pick = aiShot(mine.shots, remainingLens(mine), rng);
    var r = fire(mine, pick[0], pick[1]);
    lastTheirs = lastShot[1 - actor] = pick;
    var shot = shotText(r, true, label(pick[0], pick[1]));
    say(lastText ? UI.noted(lastText, shot) : shot);
    if (r.win) { phase = 'over'; paintAll(); return finish(false); }
    phase = 'battle'; paintAll();
  }
  var lastEnd = null;   // how the game ended, kept so a finished game comes back to its end sheet
  function finish(won) {
    var text;
    if (seats.hotseat()) {
      text = T('fleet.fleetSunk', { name: seats.name(actor), n: shotsFired });
      say(T('fleet.wins', { name: seats.name(actor) }));
      lastEnd = { result: 'win', name: seats.name(actor), text: text };
      UI.end(lastEnd);
      return;
    }
    stats.played++;
    if (won) { stats.won++; text = T('fleet.youSank', { n: shotsFired }); if (!stats.bestShots || shotsFired < stats.bestShots) { stats.bestShots = shotsFired; text += ' ' + T('fleet.fewest'); } }
    else text = T('fleet.youSunk');
    Play.save(STATS_KEY, stats);
    say(T(won ? 'shell.end.win' : 'shell.end.lose'));
    lastEnd = { result: won ? 'win' : 'lose', text: text };
    UI.end(lastEnd);
  }

  function begin() {
    if (timer) timer.cancel();
    rng = Engine.mulberry(Play.randomSeed());
    seats = root.ZimiSeats.create({ id: 'fleet', seats: 2, onChange: function () { paintAll(); } });
    boards = [createBoard(), createBoard()];
    seats.kinds().forEach(function (k, i) { if (k === 'cpu') boards[i] = randomFleet(rng); });
    phase = 'place'; sel = 0; horiz = true; placeIdx = 0; shotsBy = [0, 0]; lastShot = [null, null];
    setActor(seats.people()[0]); turnMessage();
    paintAll();
    seats.begin(function () { paintAll(); });
  }
  els.nu.addEventListener('click', begin);
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.key === 'r' || e.key === 'R') && phase === 'place') { horiz = !horiz; paintTools(); }
  });

  rng = Engine.mulberry(Play.randomSeed());
  seats = root.ZimiSeats.create({ id: 'fleet', seats: 2 });
  boards = [createBoard(), createBoard()]; actor = 0; mine = boards[0]; theirs = boards[1];
  mineCells = buildGrid(els.mine, onMine); enemyCells = buildGrid(els.enemy, onEnemy);
  // The players (Computer or Person for each side) live in Menu > New game; a change shows from the next game.
  if (root.ZimiShell) root.ZimiShell.game({
    menu: function () { return { options: [seats.block(null, { labels: [T('fleet.player1'), T('fleet.player2')] })] }; },
    stats: function () { return stats.played ? [T('fleet.record', { won: stats.won, n: stats.played })].concat(stats.bestShots ? [T('fleet.best', { n: stats.bestShots })] : []) : []; },
    inProgress: function () { return phase === 'battle' || phase === 'pass' || phase === 'busy'; }
  });
  begin();
  // Leaving and coming back: both fleets and every shot, whose turn it is, and the end. Two people come back behind the cover.
  UI.persist({
    save: function () {
      var placed = boards.some(function (b) { return b.ships.length; });
      return phase === 'place' && !placed ? null : { boards: boards, phase: phase, actor: actor, placeIdx: placeIdx, shotsBy: shotsBy, lastShot: lastShot, sel: sel, horiz: horiz, end: phase === 'over' ? lastEnd : null };
    },
    load: function (d) {
      if (timer) timer.cancel();
      boards = d.boards; phase = d.phase; placeIdx = d.placeIdx; shotsBy = d.shotsBy; lastShot = d.lastShot; sel = d.sel; horiz = d.horiz; lastEnd = d.end;
      setActor(d.actor); paintAll();
      if (phase === 'over') { say(T('shell.end.' + (d.end.result === 'win' ? 'win' : 'lose'))); UI.end(d.end); }
    },
    resume: function () {
      if (phase === 'over') return;
      if (phase === 'busy') { lastText = ''; timer = Play.later(cpuTurn, CPU_DELAY_MS); return; }   // the computer's shot was on its way
      if (seats.hotseat() && phase !== 'pass') { handTo(actor, phase); return; }
      turnMessage();
    }
  });
  root.__fleet = { get mine() { return mine; }, get theirs() { return theirs; }, get phase() { return phase; } };
})(this);
