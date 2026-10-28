/* ZimiGames: Mahjong for four, the page. The rules, the scoring and the computers are in mahjong4-engine.js; the tile
   faces are the ones Mahjong solitaire uses (mahjong-tiles.js). Each of the four seats is a computer or a person
   (handoff.js): with two or more people the screen hides each hand behind a "Pass to" cover. Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !root.Mahjong4Engine || !root.MahjongTiles || !root.BoardUI) return;
  var WK = root.WorldKit, BK = root.BoardKit, UI = root.BoardUI, T = UI.t, E = root.Mahjong4Engine, MT = root.MahjongTiles, $ = function (id) { return document.getElementById(id); };
  var SEATS = E.SEATS, ROTATIONS = 4, COMPUTER_DELAY_MS = 600, CLAIM_DELAY_MS = 800, HINT_LEVEL = 'hard';

  var G = WK.create({
    id: 'mahjong4',
    options: [
      { key: 'level', legend: 'mahjong4.computers', def: 'medium', choices: [['easy', 'board.level.easy'], ['medium', 'board.level.medium'], ['hard', 'board.level.hard']] },
      { key: 'min', legend: 'mahjong4.min', def: '3', choices: [['3', 'mahjong4.min3'], ['1', 'mahjong4.min1']] }
    ],
    // The people at the table (Computer or Person for each seat) join the New game pane after the options.
    extraOptions: function () { return [seats.block(null, { note: T('mahjong4.seat1Deals') })]; },
    statKey: function (s) { return s.level + s.min; },
    onNew: newGame, onHint: hint
  });
  var seats = newSeats();
  var score = WK.scoreBar($('wk-score'), [{}, {}, {}, {}].map(function () { return { color: 'var(--m4-cloth)' }; }));
  var els = { info: $('m4-info'), opps: $('m4-opps'), pool: $('m4-pool'), claim: $('m4-claim'), melds: $('m4-melds'), hand: $('m4-hand') };
  var STATUS_MAX = 44;   // the most a 390 px status line holds in one line
  var game, t, epoch = 0, picked = -1, tip = -1, shown = [], event = '';   // event: what just happened, said while the computers answer a discard

  // ── small helpers ──
  function newSeats() { return root.ZimiSeats.create({ id: 'mahjong4', seats: SEATS, onChange: function () { if (t) render(); } }); }
  function me() { return seats.view(); }   // the seat whose hand is face up
  function level() { return G.settings.level; }
  function seatName(p) { return T('mahjong.wind.' + E.seatOf(t, p)); }
  function seatInitial(p) { return T('mahjong4.initial.' + E.seatOf(t, p)); }
  // Names go into markup built as strings: a person's typed name must not become markup.
  function esc(x) { return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function list(names) { return root.Intl && Intl.ListFormat ? new Intl.ListFormat(undefined, { type: 'conjunction' }).format(names) : names.join(', '); }
  function nameOf(p) { return seats.person(p) ? seats.name(p) : seatName(p); }
  function labelOf(p) { return seats.person(p) ? T('mahjong4.label', { name: seats.name(p), wind: seatName(p) }) : T('mahjong4.label.computer', { wind: seatName(p) }); }
  // A sentence about a player: its "you" form when the player is the person at the screen (verbs agree).
  function about(key, p, vars) { return T(key + (seats.isYou(p) ? '.you' : ''), Object.assign({ name: nameOf(p) }, vars)); }
  function ownerOf(p) { return T(seats.isYou(p) ? 'mahjong4.owner.you' : 'mahjong4.owner', { name: nameOf(p) }); }
  function meldName(type) { return T('mahjong4.meld.' + type); }
  function tileHtml(k, cls, extra) { return '<span class="m4-t' + (cls ? ' ' + cls : '') + '"' + (extra || '') + ' title="' + esc(MT.faceName(k)) + '">' + MT.faceMarkup(k) + '</span>'; }
  function backHtml(cls) { return '<span class="m4-t back ' + (cls || 'xs') + '" aria-hidden="true"></span>'; }
  function meldTiles(m) {
    if (m.type === 'chow') return [m.k, m.k + 1, m.k + 2];
    return m.type === 'pung' ? [m.k, m.k, m.k] : [m.k, m.k, m.k, m.k];
  }
  function meldHtml(m, cls) {
    var hidden = m.type === 'kong' && !m.open;   // a concealed kong shows its two middle tiles face down
    return '<span class="m4-meld" title="' + esc(T('mahjong4.meldTitle', { type: meldName(m.type), tile: MT.faceName(m.k) })) + '">' + meldTiles(m).map(function (k, i) { return hidden && (i === 0 || i === 3) ? backHtml(cls) : tileHtml(k, cls); }).join('') + '</span>';
  }
  function later(fn, ms) { var my = epoch; setTimeout(function () { if (my === epoch) fn(); }, ms); }
  function say(text, busy) { G.say(text, busy); }
  function human() { return t.phase === 'discard' && t.turn === me() && seats.person(t.turn) && !seats.covering && !t.result; }

  // ── drawing the table ──
  function render() {
    var p, i;
    els.info.textContent = T(game.repeats ? 'mahjong4.info.again' : 'mahjong4.info', { n: Math.min(ROTATIONS, game.rotations + 1), of: ROTATIONS, left: E.liveLeft(t) });
    var names = [], vals = [];
    for (p = 0; p < SEATS; p++) { names.push(nameOf(p) + ' (' + seatInitial(p) + ')'); vals.push(game.points[p]); }
    score(names, vals, t.result ? -1 : t.turn);
    // the three computers: tiles face down, melds face up
    var opp = '';
    for (var r = 1; r < SEATS; r++) {
      p = (me() + r) % SEATS;
      var backs = ''; for (i = 0; i < t.hands[p].length; i++) backs += backHtml('xs');
      opp += '<div class="m4-opp' + (t.turn === p && !t.result ? ' turn' : '') + '"><span class="nm">' + esc(labelOf(p)) + (p === t.dealer ? ' · ' + esc(T('mahjong4.dealer')) : '') + '</span><span class="row" aria-label="' + esc(T('mahjong4.inHand', { n: t.hands[p].length })) + '">' + backs + '</span><span class="melds">' + t.melds[p].map(function (m) { return meldHtml(m, 'xs'); }).join('') + '</span></div>';
    }
    els.opps.innerHTML = opp;
    // the discards, a row for each player, the newest claim target marked
    var pool = '';
    for (p = 0; p < SEATS; p++) {
      var d = t.discards[p], tiles = d.map(function (k, j) { var isLast = t.phase === 'claim' && t.lastDiscard && t.lastDiscard.from === p && j === d.length - 1; return tileHtml(k, 'sm' + (isLast ? ' last' : '')); }).join('');
      pool += '<div class="line"><span class="who">' + esc(seatInitial(p)) + (p === me() ? '*' : '') + '</span><span class="tiles">' + tiles + '</span></div>';
    }
    els.pool.innerHTML = pool;
    els.melds.innerHTML = t.melds[me()].map(function (m) { return meldHtml(m, 'sm'); }).join('');
    renderHand();
    G.setHint(human() && !G.over);
  }
  function handOrder() {
    var list = t.hands[me()].slice(), drawn = -1;
    if (t.lastDrawn !== null && t.turn === me() && t.phase === 'discard') { var at = list.lastIndexOf(t.lastDrawn); if (at >= 0) { list.splice(at, 1); drawn = t.lastDrawn; } }
    shown = list.concat(drawn >= 0 ? [drawn] : []);
    return { list: list, drawn: drawn };
  }
  function renderHand() {
    var o = handOrder(), can = human(), h = '', i;
    for (i = 0; i < shown.length; i++) {
      var isDrawn = o.drawn >= 0 && i === shown.length - 1, k = shown[i];
      h += '<button type="button" class="m4-t' + (isDrawn ? ' drawn' : '') + (i === picked ? ' pick' : '') + (i === tip ? ' tip' : '') + '" data-i="' + i + '" tabindex="' + (i === (picked >= 0 ? picked : 0) ? 0 : -1) + '" aria-label="' + esc(MT.faceName(k) + (isDrawn ? ', ' + T('mahjong4.justDrawn') : '') + (i === picked ? ', ' + T('mahjong4.pickedAria') : '')) + '"' + (can ? '' : ' disabled') + '>' + MT.faceMarkup(k) + '</button>';
    }
    els.hand.innerHTML = h;
  }
  els.hand.addEventListener('click', function (e) {
    var b = e.target.closest('.m4-t');
    if (!b || !human() || prompting()) return;
    var i = +b.dataset.i;
    if (picked === i) { discardTile(shown[i]); return; }
    picked = i; tip = -1; renderHand(); focusTile(i);
    say(T('mahjong4.picked', { tile: MT.faceName(shown[i]) }));
  });
  function focusTile(i) { var b = els.hand.querySelector('[data-i="' + i + '"]'); if (b) b.focus(); }
  els.hand.addEventListener('keydown', function (e) {
    var b = e.target.closest('.m4-t');
    if (!b) return;
    var i = +b.dataset.i, n = shown.length, to = -1;
    if (e.key === 'ArrowLeft') to = Math.max(0, i - 1); else if (e.key === 'ArrowRight') to = Math.min(n - 1, i + 1);
    else if (e.key === 'Home') to = 0; else if (e.key === 'End') to = n - 1;
    if (to < 0) return;
    e.preventDefault();
    [].forEach.call(els.hand.children, function (c) { c.tabIndex = -1; });
    els.hand.children[to].tabIndex = 0; els.hand.children[to].focus();
  });

  // ── the claim bar ──
  var pending = null;   // what the bar is waiting for: { kind: 'self' | 'claim', ... }
  function prompting() { return !!pending && pending.kind === 'claim'; }
  function addBtn(label, cls, fn, tiles) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'ar-btn' + (cls ? ' ' + cls : '');
    b.innerHTML = (tiles || []).map(function (k) { return tileHtml(k, 'xs'); }).join('') + '<span>' + label + '</span>';
    b.addEventListener('click', fn); els.claim.appendChild(b);
  }
  function hideClaims() { els.claim.hidden = true; els.claim.textContent = ''; pending = null; }
  function showSelfOptions(o) {
    els.claim.textContent = ''; var any = false;
    var who = me();
    if (o.win) { any = true; addBtn(T('mahjong4.win.self', { faan: o.win.faan }), 'win', function () { hideClaims(); E.declareWin(t, who, false); endHand(); }); }
    o.concealedKongs.concat(o.addKongs).forEach(function (k) { any = true; addBtn(T('mahjong4.kongTile', { tile: MT.faceName(k) }), '', function () { hideClaims(); doKong(who, k); }, [k]); });
    els.claim.hidden = !any; pending = any ? { kind: 'self' } : null;
  }
  function showClaims(c, tile) {
    els.claim.textContent = ''; pending = { kind: 'claim' };
    if (c.win) addBtn(T('mahjong4.win', { faan: c.win.faan }), 'win', function () { choose({ type: 'win' }); }, [tile]);
    if (c.kong) addBtn(T('mahjong4.kong'), '', function () { choose({ type: 'kong' }); }, [tile, tile, tile, tile]);
    if (c.pung) addBtn(T('mahjong4.pung'), '', function () { choose({ type: 'pung' }); }, [tile, tile, tile]);
    c.chows.forEach(function (s) { addBtn(T('mahjong4.chow'), '', function () { choose({ type: 'chow', start: s }); }, [s, s + 1, s + 2]); });
    addBtn(T('mahjong4.pass'), '', function () { choose(null); });
    els.claim.hidden = false;
    var first = els.claim.querySelector('button'); if (first) first.focus({ preventScroll: true });
  }

  // ── turns ──
  function startHand() {
    epoch++; picked = -1; tip = -1; hideClaims();
    t = E.newHand({ dealer: game.dealer, min: +G.settings.min });
    render();
    event = about('mahjong4.deals', game.dealer);
    beginTurn();
  }
  // The table as it stood when this turn began (a claim in the air is not kept), for leaving and coming back.
  var snap = null, restoredEnded = false;
  function beginTurn() {
    if (t.result) { endHand(); return; }
    snap = UI.pack({ t: t, game: game, event: event, ended: false });
    picked = -1; tip = -1; render();
    var p = t.turn, my = epoch;
    if (seats.person(p)) {
      // With several people the next person takes the screen first, then sees their own tiles and options.
      seats.ensure(p, function () {
        if (my !== epoch) return;
        render();
        showSelfOptions(E.selfOptions(t, p));
        say(els.claim.hidden ? T(seats.isYou(p) ? 'mahjong4.yourTurn' : 'mahjong4.turn', { name: nameOf(p) }) : about('mahjong4.canDeclare', p));
      });
    } else { say(T('mahjong4.thinking', { name: seatName(p) }), true); later(function () { computerAct(p); }, COMPUTER_DELAY_MS); }
  }
  function computerAct(p) {
    var self = E.aiSelf(t, p, level());
    if (self && self.type === 'win') { E.declareWin(t, p, false); endHand(); return; }
    if (self && self.type === 'kong') { doKong(p, self.k); return; }
    var tile = E.aiDiscard(t, p, level());
    discardTile(tile, p);
  }
  function doKong(p, k) {
    E.declareKong(t, p, k);
    event = about('mahjong4.declares', p, { tile: MT.faceName(k) });
    if (t.result) { endHand(); return; }
    beginTurn();
  }
  function discardTile(tile, p) {
    p = p === undefined ? me() : p;
    if (!E.discard(t, p, tile)) return;
    picked = -1; tip = -1; hideClaims();
    event = about('mahjong4.discards', p, { tile: MT.faceName(tile) });
    render();
    // the computers' answers are known at once; each person with an option is asked in turn after the discarder
    var picks = {}, asking = [], q, d;
    for (d = 1; d < SEATS; d++) {
      q = (p + d) % SEATS;
      if (seats.person(q)) { var o = t.claims[q]; if (o.win || o.pung || o.kong || o.chows.length) asking.push(q); }
      else { var c = E.aiClaim(t, q, level()); if (c) picks[q] = c; }
    }
    pending = null;
    askClaims(asking, picks, tile);
  }
  function askClaims(asking, picks, tile) {
    if (!asking.length) {
      say(event, true);
      later(function () { settle(picks); }, CLAIM_DELAY_MS);
      return;
    }
    var q = asking[0], my = epoch;
    seats.ensure(q, function () {
      if (my !== epoch) return;
      render();
      say(about('mahjong4.mayClaim', q));
      showClaims(t.claims[q], tile);
      pending.picks = picks; pending.asking = asking; pending.tile = tile;
    }, T('mahjong4.coverClaim'));
  }
  function choose(pick) {
    var wait = pending, q = wait.asking[0];
    hideClaims();
    if (pick) wait.picks[q] = pick;
    askClaims(wait.asking.slice(1), wait.picks, wait.tile);
  }
  function settle(picks) {
    var tile = t.lastDiscard.tile, res = E.resolve(t, picks);
    if (res === 'win' || res === 'draw') { endHand(); return; }
    if (res === 'next') { event = ''; beginTurn(); return; }
    var claimant = t.turn;   // the one who took the tile now has the turn
    event = about('mahjong4.takes', claimant, { tile: MT.faceName(tile), meld: meldName(res) });
    beginTurn();
  }

  // ── the end of a hand ──
  function endHand() {
    hideClaims(); render();
    var r = t.result, body = '', title, i;
    if (r.type === 'win') {
      for (i = 0; i < SEATS; i++) game.points[i] += r.points[i];
      var w = r.winner, selfDrawn = r.from === null;
      title = seats.isYou(w) ? T('mahjong4.youWinHand') : T('mahjong4.winsHand', { name: nameOf(w) });
      var tilesRow = t.hands[w].slice(); if (!selfDrawn) tilesRow.push(r.tile);
      E.sortTiles(tilesRow);
      body += '<div class="m4-result"><p>' + esc(selfDrawn ? about('mahjong4.drew', w) : about('mahjong4.winsOn', w, { owner: ownerOf(r.from), tile: MT.faceName(r.tile) })) + '</p>';
      body += '<div class="tiles">' + t.melds[w].map(function (m) { return meldHtml(m, 'sm'); }).join('') + tilesRow.map(function (k) { return tileHtml(k, 'sm'); }).join('') + '</div>';
      body += '<h3>' + esc(T(r.limit ? 'mahjong4.scoreLimit' : 'mahjong4.score', { faan: r.faan, points: E.pointsFor(r.faan) })) + '</h3><table>' + r.items.map(function (it) { return '<tr><td>' + esc(it.key ? T('mahjong4.hand.' + it.key) : it.name) + '</td><td class="n">' + it.faan + '</td></tr>'; }).join('') + '</table>';
      body += '<h3>' + esc(T('mahjong4.points')) + '</h3><table><tr><th></th><th class="n">' + esc(T('mahjong4.change')) + '</th><th class="n">' + esc(T('mahjong4.total')) + '</th></tr>' + [0, 1, 2, 3].map(function (p) { return '<tr><td>' + esc(labelOf(p)) + '</td><td class="n">' + (r.points[p] > 0 ? '+' : '') + r.points[p] + '</td><td class="n">' + game.points[p] + '</td></tr>'; }).join('') + '</table></div>';
      game.repeats = w === t.dealer ? game.repeats + 1 : 0;
      if (w !== t.dealer) { game.dealer = (game.dealer + 1) % SEATS; game.rotations++; }
    } else {
      title = T('mahjong4.draw');
      body = '<div class="m4-result"><p>' + esc(T('mahjong4.wallOut')) + '</p></div>';
      game.repeats++;
    }
    say(title);
    var last = game.rotations >= ROTATIONS, box = UI.h('div');
    box.innerHTML = body;
    score(game.points.map(function (_, p) { return nameOf(p) + ' (' + seatInitial(p) + ')'; }), game.points, -1);
    game.last = last;
    snap = UI.pack({ t: t, game: game, event: '', ended: true });
    root.ZimiShell.sheet({ title: title, body: [box], actions: [{ label: T('shell.close') }, { label: T(last ? 'mahjong4.finalResult' : 'mahjong4.nextHand'), primary: true, onclick: function () { if (game.last) gameOver(); else startHand(); } }] });
  }
  function gameOver() {
    var order = [0, 1, 2, 3].sort(function (a, b) { return game.points[b] - game.points[a]; }), hot = seats.hotseat(), place = order.indexOf(seats.people()[0]) + 1;
    var finalLine = T('mahjong4.final', { list: order.map(function (p) { return nameOf(p) + ' ' + game.points[p]; }).join(', ') });
    var verdict = hot ? T('mahjong4.comesFirst', { name: nameOf(order[0]) }) : T('mahjong4.place.' + place);
    G.finish(T('janggi.noted', { note: finalLine, line: verdict }), hot ? null : place === 1 ? 'w' : 'l', hot ? nameOf(order[0]) : undefined);
  }

  // ── hint, rules, new game ──
  function hint() {
    if (!human()) return;
    var who = me(), k = E.aiDiscard(t, who, HINT_LEVEL), i = shown.lastIndexOf(k), c = E.countsOf(t.hands[who]);
    tip = i >= 0 ? i : -1; picked = -1; renderHand();
    c[k]--;
    var w = E.waits(c, t.melds[who].length), text = T('mahjong4.hint', { tile: MT.faceName(k) });
    // The status line is one short line: the waits join the hint only when they fit.
    var waits = w.length ? T('mahjong4.hintWait', { tiles: list(w.map(MT.faceName)) }) : '';
    if (waits && (text + ' ' + waits).length <= STATUS_MAX) text = T('janggi.noted', { note: text, line: waits });
    say(text);
  }
  // The scoring table: its names and notes are keyed by the row's place in the engine's table.
  function rulesNode() {
    var box = UI.h('div', { class: 'm4-rules' }), h = '<p>' + esc(T('mahjong4.rules.intro')) + '</p><table>';
    E.TABLE.forEach(function (r, i) { h += '<tr><td>' + esc(T('mahjong4.rule.' + i + '.name')) + '<div class="how">' + esc(T('mahjong4.rule.' + i + '.how')) + '</div></td><td class="n">' + r[1] + '</td></tr>'; });
    h += '</table><h3>' + esc(T('mahjong4.points')) + '</h3><table>';
    [1, 2, 3, 4, 5, 6, 7, 8].forEach(function (f) { h += '<tr><td>' + esc(T(f === 8 ? 'mahjong4.faanLimit' : 'mahjong4.faan', { n: f })) + '</td><td class="n">' + E.POINTS[f] + '</td></tr>'; });
    h += '</table><p class="how">' + esc(T('mahjong4.rules.pay')) + '</p>';
    box.innerHTML = h;
    return box;
  }
  $('m4-rules').addEventListener('click', function () { root.ZimiShell.sheet({ title: T('mahjong4.scoring'), body: [rulesNode()], actions: [{ label: T('shell.close'), primary: true }] }); });

  function newGame() {
    epoch++; t = null; snap = null;
    seats = newSeats();
    game = { dealer: 0, rotations: 0, repeats: 0, points: [0, 0, 0, 0], last: false };
    var my = epoch;
    seats.begin(function () { if (my === epoch) startHand(); }, game.dealer);
  }
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('.ar-sheet,input')) return;
    if (e.key === 'Escape' && picked >= 0) { picked = -1; renderHand(); }
  });

  if (root.ZimiShell) root.ZimiShell.game({ hints: true, inProgress: function () { return !G.over && !!t && (game.rotations > 0 || t.discards.some(function (d) { return d.length > 1; })); } });
  G.newGame();
  G.persist({
    save: function () { return snap && (snap.ended || snap.game.rotations || snap.game.repeats || snap.t.discards.some(function (d) { return d.length; })) ? snap : null; },
    load: function (d) { epoch++; hideClaims(); picked = -1; tip = -1; t = d.t; game = d.game; event = d.event || ''; restoredEnded = !!d.ended; snap = UI.pack(d); render(); },
    resume: function () {
      if (restoredEnded) { restoredEnded = false; if (game.last) gameOver(); else startHand(); }
      else beginTurn();
    }
  });

  if (new URLSearchParams(location.search).has('debug')) {
    root.__m4 = { engine: E, table: function () { return t; }, game: function () { return game; }, discard: discardTile, begin: beginTurn, shown: function () { return shown; } };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
