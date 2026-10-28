/* ZimiGames: Dominoes (double six, Draw and Block). Our own code, GPL-3.0. The first half is the
   rules and the computer players (no DOM, tested under node); the second half is the page.
   A tile is [low, high] pips; the chain is a list of tiles turned to run left to right. */
(function (root) {
  'use strict';

  var MAX_PIP = 6, TILE_COUNT = 28;
  var HAND_SIZE = { draw: { 2: 7, 3: 5, 4: 5 }, block: { 2: 7, 3: 7, 4: 7 } };
  var LEVELS = { easy: { noise: 1000, smart: false }, medium: { noise: 3, smart: false }, hard: { noise: 0.5, smart: true } };

  function allTiles() {
    var out = [];
    for (var a = 0; a <= MAX_PIP; a++) for (var b = a; b <= MAX_PIP; b++) out.push([a, b]);
    return out;
  }
  function pips(tile) { return tile[0] + tile[1]; }
  function isDouble(tile) { return tile[0] === tile[1]; }
  function handPips(hand) { return hand.reduce(function (n, t) { return n + pips(t); }, 0); }
  function same(a, b) { return a[0] === b[0] && a[1] === b[1]; }
  function shuffle(list, rng) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor((rng || Math.random)() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // ── a round ──
  // state: { mode, hands, boneyard, chain, ends: [left, right] | null, turn, passes, lacks: [{pip: true}], last }
  function deal(mode, players, rng) {
    var tiles = shuffle(allTiles(), rng), size = HAND_SIZE[mode][players], hands = [];
    for (var p = 0; p < players; p++) hands.push(tiles.splice(0, size));
    var lacks = [];
    for (p = 0; p < players; p++) lacks.push({});
    return { mode: mode, hands: hands, boneyard: tiles, chain: [], ends: null, turn: 0, passes: 0, lacks: lacks, last: null };
  }
  // The best tile to lead with: the highest double, else the heaviest tile.
  function bestLead(hand) {
    var best = -1, bestKey = -1;
    hand.forEach(function (t, i) { var k = (isDouble(t) ? 100 : 0) + pips(t) * 2 + t[1]; if (k > bestKey) { bestKey = k; best = i; } });
    return best;
  }
  // Who leads the first round: the holder of the highest double, else of the heaviest tile.
  function firstPlayer(st) {
    var who = 0, bestKey = -1;
    st.hands.forEach(function (h, p) {
      if (!h.length) return;
      var k = (isDouble(h[bestLead(h)]) ? 100 : 0) + pips(h[bestLead(h)]) * 2 + h[bestLead(h)][1];
      if (k > bestKey) { bestKey = k; who = p; }
    });
    return who;
  }
  // The plays open to a player: { tile: index in hand, end: 'L' | 'R' | 'C' (the first tile) }.
  function legalPlays(st, p) {
    var out = [];
    st.hands[p].forEach(function (t, i) {
      if (!st.chain.length) { out.push({ tile: i, end: 'C' }); return; }
      if (t[0] === st.ends[0] || t[1] === st.ends[0]) out.push({ tile: i, end: 'L' });
      if (t[0] === st.ends[1] || t[1] === st.ends[1]) out.push({ tile: i, end: 'R' });
    });
    return out;
  }
  function play(st, p, play_) {
    var t = st.hands[p].splice(play_.tile, 1)[0], placed;
    if (play_.end === 'C') { placed = { a: t[0], b: t[1] }; st.chain = [placed]; st.ends = [t[0], t[1]]; }
    else if (play_.end === 'L') { placed = t[1] === st.ends[0] ? { a: t[0], b: t[1] } : { a: t[1], b: t[0] }; st.chain.unshift(placed); st.ends[0] = placed.a; }
    else { placed = t[0] === st.ends[1] ? { a: t[0], b: t[1] } : { a: t[1], b: t[0] }; st.chain.push(placed); st.ends[1] = placed.b; }
    st.passes = 0; st.last = { player: p, tile: placed, end: play_.end };
    return placed;
  }
  function draw(st, p) {
    if (st.mode !== 'draw' || !st.boneyard.length) return null;
    var t = st.boneyard.pop();
    st.hands[p].push(t);
    return t;
  }
  function pass(st, p) {
    st.passes++;
    if (st.ends) { st.lacks[p][st.ends[0]] = true; st.lacks[p][st.ends[1]] = true; }
  }
  function canDraw(st) { return st.mode === 'draw' && st.boneyard.length > 0; }
  function isBlocked(st) { return st.passes >= st.hands.length; }

  // How a finished round scores: { winner, points } or { winner: -1, points: 0 } for a tied block.
  function scoreRound(st) {
    var n = st.hands.length, p, totals = st.hands.map(handPips);
    for (p = 0; p < n; p++) if (!st.hands[p].length) return { winner: p, points: totals.reduce(function (a, b) { return a + b; }, 0), how: 'out' };
    var low = Math.min.apply(null, totals), lows = totals.filter(function (x) { return x === low; }).length;
    if (lows > 1) return { winner: -1, points: 0, how: 'tie' };
    var w = totals.indexOf(low);
    return { winner: w, points: totals.reduce(function (a, b) { return a + b; }, 0) - 2 * low, how: 'blocked' };
  }

  // ── the computer ──
  function countIn(hand, pip, skip) { var n = 0; hand.forEach(function (t, i) { if (i !== skip && (t[0] === pip || t[1] === pip)) n++; }); return n; }
  function scorePlay(st, p, pl, smart) {
    var t = st.hands[p][pl.tile], s = pips(t) + (isDouble(t) ? 4 : 0);
    if (!smart) return s;
    // after the play, which numbers are left open, and do I hold more of them than a rival can answer?
    var open = st.ends ? st.ends.slice() : [t[0], t[1]];
    if (pl.end === 'L') open[0] = t[0] === st.ends[0] ? t[1] : t[0];
    else if (pl.end === 'R') open[1] = t[0] === st.ends[1] ? t[1] : t[0];
    open.forEach(function (e) {
      s += countIn(st.hands[p], e, pl.tile) * 2.2;
      var lacking = 0;
      st.lacks.forEach(function (l, q) { if (q !== p && l[e]) lacking++; });
      s += lacking * 3;
    });
    if (open[0] === open[1]) s -= 1;
    return s;
  }
  function choosePlay(st, p, level, rng) {
    var plays = legalPlays(st, p);
    if (!plays.length) return null;
    var cfg = LEVELS[level] || LEVELS.medium, best = null, bs = -Infinity;
    rng = rng || Math.random;
    if (!st.chain.length) return { tile: bestLead(st.hands[p]), end: 'C' };
    plays.forEach(function (pl) { var s = scorePlay(st, p, pl, cfg.smart) + rng() * cfg.noise; if (s > bs) { bs = s; best = pl; } });
    return best;
  }

  var Engine = {
    MAX_PIP: MAX_PIP, TILE_COUNT: TILE_COUNT, HAND_SIZE: HAND_SIZE, LEVELS: LEVELS,
    allTiles: allTiles, pips: pips, isDouble: isDouble, handPips: handPips, same: same, shuffle: shuffle, deal: deal, bestLead: bestLead, firstPlayer: firstPlayer,
    legalPlays: legalPlays, play: play, draw: draw, pass: pass, canDraw: canDraw, isBlocked: isBlocked, scoreRound: scoreRound, choosePlay: choosePlay
  };
  root.DominoEngine = Engine;

  if (typeof document === 'undefined' || !root.BoardUI) return;

  // ═══════════ the page ═══════════
  var BK = root.BoardKit, UI = root.BoardUI, T = UI.t, $ = function (id) { return document.getElementById(id); };
  var SETTINGS_KEY = 'dominoes.settings', STATS_KEY = 'dominoes.stats';
  var COMPUTER_MS = 900, DRAW_MS = 520, PASS_MS = 1000, LEAD_MS = 700, NEXT_MS = 350;
  var PIP_SLOTS = { 0: [], 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  var TILE_MIN_ROW = 5, TILE_MAX_ROW = 9, TILE_TARGET_LENGTH = 52;   // tiles to a row: about 7 on a phone, never more than 9

  var settings = BK.load(SETTINGS_KEY, {});
  if (settings.mode !== 'block') settings.mode = 'draw';
  if ([1, 2, 3].indexOf(settings.opponents) < 0) settings.opponents = 1;
  if (!LEVELS[settings.level]) settings.level = 'medium';
  if ([50, 100, 150].indexOf(settings.target) < 0) settings.target = 100;
  var stats = BK.load(STATS_KEY, {});

  var st, scores, round = 0, timer = 0, selected = -1, lastWinner = -1, matchOver = false, busy = false, ghosts = null;
  var chainEl = $('dm-chain'), handEl = $('dm-hand');
  var reduced = BK.reducedMotion();

  function players() { return settings.opponents + 1; }
  // Seats: each is the Computer or a Person; with two or more people, hands hide behind a handoff.
  var seats = root.ZimiSeats.create({ id: 'dominoes', seats: players(), onChange: function () { if (st) render(); } });
  function seatsFor() { seats = root.ZimiSeats.create({ id: 'dominoes', seats: players(), onChange: function () { if (st) render(); } }); }
  function you(p) { return seats.isYou(p); }
  function nameOf(p) {
    if (seats.person(p)) return seats.name(p);
    var k = 0, all = 0; for (var q = 0; q < players(); q++) if (!seats.person(q)) { all++; if (q < p) k++; }
    return all === 1 ? T('board.zimi') : T('dominoes.computer', { n: k + 1 });   // a lone computer is Zimi
  }
  // A sentence about a player: its "you" form when the player is the person at the screen (verbs agree).
  function about(key, p, vars) { return T(key + (you(p) ? '.you' : ''), Object.assign({ name: nameOf(p) }, vars)); }
  var line = UI.status($('dm-status'));
  function humanSeat(p) { return seats.person(p); }

  function tileEl(a, b, cls) {
    var t = document.createElement('div');
    t.className = 'dm-tile ' + (cls || '');
    [a, b].forEach(function (v) {
      var h = document.createElement('div');
      h.className = 'dm-half';
      for (var i = 0; i < 9; i++) { var c = document.createElement('i'); if (PIP_SLOTS[v].indexOf(i) >= 0) c.className = 'on'; h.appendChild(c); }
      t.appendChild(h);
    });
    t.setAttribute('aria-label', T('dominoes.tile', { a: a, b: b }));
    return t;
  }

  // ── drawing ──
  function paintChain() {
    chainEl.textContent = '';
    var width = chainEl.clientWidth || 340, per = Math.min(TILE_MAX_ROW, Math.max(TILE_MIN_ROW, Math.round(width / TILE_TARGET_LENGTH))), length = Math.floor(width / per) - 2;
    chainEl.style.setProperty('--s', (length / 2) + 'px');
    var seq = st.chain.map(function (c, i) { return { c: c, i: i }; });
    if (ghosts) {
      if (ghosts.indexOf('L') >= 0) seq.unshift({ ghost: 'L' });
      if (ghosts.indexOf('R') >= 0) seq.push({ ghost: 'R' });
    }
    if (!seq.length) { var e = document.createElement('p'); e.className = 'dm-empty'; e.textContent = T('dominoes.none'); chainEl.appendChild(e); return; }
    for (var r = 0; r * per < seq.length; r++) {
      var row = document.createElement('div');
      row.className = 'dm-row' + (r % 2 ? ' rev' : '');
      seq.slice(r * per, (r + 1) * per).forEach(function (item) {
        var node;
        if (item.ghost) {
          node = document.createElement('button');
          node.type = 'button'; node.className = 'dm-tile ghost'; node.textContent = T('dominoes.here');
          node.setAttribute('aria-label', T(item.ghost === 'L' ? 'dominoes.playLeft' : 'dominoes.playRight'));
          node.addEventListener('click', function () { humanPlay(selected, item.ghost); });
        } else {
          var c = item.c, last = st.last && st.last.tile === c;
          node = tileEl(c.a, c.b, (c.a === c.b ? 'double' : '') + (last ? ' last' : '') + (item.i === 0 ? ' endL' : '') + (item.i === st.chain.length - 1 ? ' endR' : ''));
        }
        row.appendChild(node);
      });
      chainEl.appendChild(row);
    }
    var lastEl = chainEl.querySelector('.last');
    if (lastEl && lastEl.scrollIntoView) lastEl.scrollIntoView({ block: 'nearest' });
  }

  function paintHand() {
    handEl.textContent = '';
    var V = seats.view(), shown = !seats.hotseat() || (seats.viewer >= 0 && st.turn === V), mine = st.hands[V], plays = humanTurn() && shown ? legalPlays(st, V) : [], playable = {};
    plays.forEach(function (pl) { playable[pl.tile] = (playable[pl.tile] || []).concat(pl.end); });
    mine.forEach(function (t, i) {
      var b = document.createElement('button');
      b.type = 'button';
      var ok = !!playable[i];
      b.className = 'dm-card' + (ok ? ' can' : '') + (i === selected ? ' sel' : '');
      // A tile that cannot be played stays tappable, so it can shake and say why (aria-disabled); a hidden hand is plain disabled.
      if (!ok) b.setAttribute('aria-disabled', 'true');
      b.disabled = !shown;
      if (!shown) { b.className = 'dm-card'; b.disabled = true; b.setAttribute('aria-label', T('dominoes.hidden')); b.appendChild(tileEl(0, 0, 'vert dm-hidden')); handEl.appendChild(b); return; }
      b.setAttribute('aria-label', T(ok ? (st.chain.length ? 'dominoes.tileCan' : 'dominoes.tileLead') : 'dominoes.tileNo', { a: t[0], b: t[1] }));
      b.appendChild(tileEl(t[0], t[1], 'vert' + (isDouble(t) ? ' double' : '')));
      b.addEventListener('click', function () { onHandTile(i, playable[i]); });
      handEl.appendChild(b);
    });
    $('dm-hand-count').textContent = mine.length && shown ? T('dominoes.handCount', { n: mine.length, dots: handPips(mine) }) : '';
  }

  // The one chips row: every player, their points, and for the others the tiles they hold. The player to move has the amber ring.
  function paintScores() {
    var box = $('dm-scores'), V = seats.view();
    box.textContent = '';
    scores.forEach(function (sc, p) {
      var d = document.createElement('span');
      d.className = 'wk-who' + (p === st.turn && !matchOver ? ' turn' : '');
      d.appendChild(document.createTextNode(nameOf(p) + ' '));
      var b = document.createElement('b'); b.textContent = sc; d.appendChild(b);
      if (p !== V) {
        var n = document.createElement('span');
        n.className = 'dm-tl'; n.textContent = st.hands[p].length; n.title = T('dominoes.tiles', { n: st.hands[p].length });
        n.setAttribute('aria-label', n.title);
        d.appendChild(n);
      }
      box.appendChild(d);
    });
    // one quiet line under the hand: the round, the target, the open ends, the boneyard
    var bits = [T('dominoes.meta', { round: round, target: settings.target })];
    if (st.ends) bits.push(T('dominoes.ends', { a: st.ends[0], b: st.ends[1] }));
    bits.push(settings.mode === 'draw' ? T('dominoes.boneyard', { n: st.boneyard.length }) : T('dominoes.blockGame'));
    $('dm-target').textContent = bits.join(' · ');
  }
  function say(text, busy) { line.turn(text, !!busy); }
  function render() { paintScores(); paintChain(); paintHand(); }
  function humanTurn() { return humanSeat(st.turn) && !busy && !matchOver; }

  // ── a round ──
  function startRound() {
    clearTimeout(timer);
    round++; selected = -1; ghosts = null; busy = true;
    st = deal(settings.mode, players());
    st.turn = lastWinner >= 0 ? lastWinner : firstPlayer(st);
    render();
    say(about('dominoes.leads', st.turn), false);
    timer = setTimeout(function () { // the leader's first tile is played for them
      var pl = { tile: bestLead(st.hands[st.turn]), end: 'C' };
      busy = false;
      doPlay(st.turn, pl);
    }, LEAD_MS);
  }

  function doPlay(p, pl) {
    var t = st.hands[p][pl.tile];
    play(st, p, pl);
    selected = -1; ghosts = null;
    render();
    say(T('dominoes.played', { name: nameOf(p), a: t[0], b: t[1] }));
    if (!st.hands[p].length) { endRound(); return; }
    nextPlayer();
  }
  function nextPlayer() {
    st.turn = (st.turn + 1) % players();
    timer = setTimeout(takeTurn, NEXT_MS);
    paintScores();
  }
  // The table as it stood when this turn began (a move in the air is not kept), for leaving and coming back.
  var snap = null, lastEnd = null, restoredPhase = '';
  function keep(phase) { snap = UI.pack({ phase: phase, cfg: { mode: settings.mode, opponents: settings.opponents, level: settings.level, target: settings.target }, st: st, scores: scores, round: round, lastWinner: lastWinner, end: phase === 'over' ? lastEnd : null }); }
  function takeTurn() {
    clearTimeout(timer);
    keep('turn');
    var p = st.turn, plays = legalPlays(st, p);
    render();
    if (plays.length) {
      if (humanSeat(p)) { seats.ensure(p, function () { render(); say(you(p) ? T('dominoes.yourTurn') : T('dominoes.turn', { name: nameOf(p) })); }, T('dominoes.cover')); return; }
      say(T('dominoes.thinking', { name: nameOf(p) }), true);
      busy = true;
      timer = setTimeout(function () { busy = false; doPlay(p, choosePlay(st, p, settings.level)); }, COMPUTER_MS);
      return;
    }
    if (canDraw(st)) {
      say(about('dominoes.draws', p), !you(p));
      busy = true;
      timer = setTimeout(function () { draw(st, p); busy = false; render(); takeTurn(); }, DRAW_MS);
      return;
    }
    pass(st, p);
    say(about('dominoes.passes', p));
    if (isBlocked(st)) { timer = setTimeout(endRound, PASS_MS); return; }
    busy = true;
    timer = setTimeout(function () { busy = false; nextPlayer(); }, PASS_MS);
  }

  function endRound() {
    clearTimeout(timer); busy = true;
    var r = scoreRound(st);
    if (r.winner >= 0) { scores[r.winner] += r.points; lastWinner = r.winner; }
    var lines = [];
    if (r.winner < 0) lines.push(T('dominoes.blockedTie'));
    else if (r.how === 'out') lines.push(about('dominoes.wentOut', r.winner, { n: r.points }));
    else lines.push(about('dominoes.blocked', r.winner, { n: r.points }));
    st.hands.forEach(function (h, p) { if (p !== r.winner || r.how !== 'out') lines.push(T(you(p) ? 'dominoes.held.you' : 'dominoes.held', { name: nameOf(p), n: handPips(h) })); });
    var top = Math.max.apply(null, scores);
    matchOver = top >= settings.target;
    render();
    var tally = scores.map(function (sc, p) { return nameOf(p) + ' ' + sc; }).join('   ');
    if (matchOver) {
      var champ = scores.indexOf(top), mine = seats.person(champ);
      if (!seats.hotseat()) {
        var key = settings.mode + '.' + settings.opponents + '.' + settings.level, rec = stats[key] = stats[key] || { w: 0, l: 0 };
        if (mine) rec.w++; else rec.l++;
        BK.save(STATS_KEY, stats);
      }
      var title = you(champ) ? T('dominoes.youWinMatch') : T('dominoes.winsMatch', { name: nameOf(champ) });
      say(title); showStats();
      lastEnd = { result: seats.hotseat() ? 'win' : mine ? 'win' : 'lose', name: seats.hotseat() ? nameOf(champ) : undefined, text: lines.concat([tally]).join(' ') };
      keep('over');
      UI.end(lastEnd);
      return;
    }
    var heading = r.winner >= 0 && you(r.winner) ? T('dominoes.youWinRound') : r.winner < 0 ? T('dominoes.drawnRound') : T('dominoes.winsRound', { name: nameOf(r.winner) });
    say(heading); showStats();
    keep('between');
    var body = lines.map(function (l) { return UI.h('p', { text: l }); });
    body.push(UI.h('p', { class: 'dm-tally', text: tally }));
    root.ZimiShell.sheet({ title: heading, body: body, actions: [{ label: T('shell.close') }, { label: T('dominoes.nextRound'), primary: true, onclick: startRound }] });
  }
  // Records stay hidden until the first match is played.
  function showStats() {
    var s = stats[settings.mode + '.' + settings.opponents + '.' + settings.level];
    $('dm-stats').textContent = seats.hotseat() || !s || !(s.w + s.l) ? '' : T('dominoes.record', { mode: T('dominoes.mode.' + settings.mode), n: settings.opponents, level: T('board.level.' + settings.level), won: s.w, lost: s.l });
  }

  // ── input ──
  function onHandTile(i, ends) {
    if (!humanTurn()) return;
    if (!ends) { UI.refuse(line, handEl.children[i], T('dominoes.noMatch')); return; }
    if (ends.length === 1 || (ends.length === 2 && st.ends[0] === st.ends[1])) { humanPlay(i, ends[0]); return; }
    if (selected === i) { selected = -1; ghosts = null; } else { selected = i; ghosts = ends; say(T('dominoes.whichEnd')); }
    render();
  }
  function humanPlay(i, end) {
    if (!humanTurn() || i < 0) return;
    doPlay(st.turn, { tile: i, end: end });
  }

  function newMatch() {
    clearTimeout(timer);
    seatsFor();
    scores = []; for (var p = 0; p < players(); p++) scores.push(0);
    round = 0; lastWinner = -1; matchOver = false; busy = false;
    showStats();
    startRound();
    // A table of people starts behind a handoff; the round already deals underneath.
    seats.begin(function () { render(); if (!busy && !matchOver && st.turn >= 0) takeTurn(); });
  }

  // ── Menu > New game: the game, the players, who plays each seat, the level, the target. Nothing applies until New game is pressed. ──
  var draft = null, seatsBox = null;
  function paintSeatsBlock() {
    seatsBox.textContent = '';
    seatsBox.appendChild(root.ZimiSeats.create({ id: 'dominoes', seats: draft.opponents + 1 }).block());
  }
  function menuOptions() {
    draft = { mode: settings.mode, opponents: settings.opponents, level: settings.level, target: settings.target };
    seatsBox = UI.h('div', { class: 'gs-seats' });
    var mode = UI.row(T('dominoes.game'), [['draw', T('dominoes.mode.draw')], ['block', T('dominoes.mode.block')]], draft.mode, function (v) { draft.mode = v; });
    var opp = UI.row(T('dominoes.numPlayers'), [[1, '2'], [2, '3'], [3, '4']], draft.opponents, function (v) { draft.opponents = +v; paintSeatsBlock(); });
    var level = UI.row(T('ludo.level'), [['easy', T('board.level.easy')], ['medium', T('board.level.medium')], ['hard', T('board.level.hard')]], draft.level, function (v) { draft.level = v; });
    var target = UI.row(T('dominoes.playTo'), [[50, '50'], [100, '100'], [150, '150']], draft.target, function (v) { draft.target = +v; });
    paintSeatsBlock();
    return UI.options([mode, opp, seatsBox, level, target]);
  }
  $('dm-new').addEventListener('click', function () {
    if (draft) { settings.mode = draft.mode; settings.opponents = draft.opponents; settings.level = draft.level; settings.target = draft.target; draft = null; BK.save(SETTINGS_KEY, settings); }
    newMatch();
  });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('.ar-sheet,input')) return;
    if (e.key.toLowerCase() === 'n') { if (root.ZimiShell) root.ZimiShell.openMenu(); }
    else if (e.key === 'Escape' && selected >= 0) { selected = -1; ghosts = null; render(); }
  });
  var resizeTimer = 0;
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(function () { if (st) paintChain(); }, 120); });

  if (root.ZimiShell) root.ZimiShell.game({
    menu: menuOptions,
    stats: function () { var l = $('dm-stats').textContent; return l ? [l] : []; },
    inProgress: function () { return !matchOver && round > 0 && (round > 1 || (st && st.chain.length > 1)); }
  });
  newMatch();
  UI.persist({
    save: function () { return snap && (snap.phase !== 'turn' || snap.round > 1 || snap.st.chain.length > 1 || snap.scores.some(Boolean)) ? snap : null; },
    load: function (d) {
      clearTimeout(timer);
      settings.mode = d.cfg.mode; settings.opponents = d.cfg.opponents; settings.level = d.cfg.level; settings.target = d.cfg.target;
      seatsFor(); st = d.st; scores = d.scores; round = d.round; lastWinner = d.lastWinner; matchOver = d.phase === 'over'; lastEnd = d.end;
      busy = false; selected = -1; ghosts = null; snap = UI.pack(d); restoredPhase = d.phase;
      render();
    },
    resume: function () {
      if (restoredPhase === 'over') { say(lastEnd.text); showStats(); UI.end(lastEnd); }
      else if (restoredPhase === 'between') startRound();
      else takeTurn();
    }
  });

  if (new URLSearchParams(location.search).has('debug')) {
    root.__dm = { engine: Engine, state: function () { return st; }, scores: function () { return scores; }, settings: settings, busy: function () { return busy; }, humanTurn: humanTurn, matchOver: function () { return matchOver; } };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
