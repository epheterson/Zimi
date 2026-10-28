/* ZimiGames: the engine of four-player Mahjong, Hong Kong old style, simplified. Our own code, GPL-3.0. No network, no modules.
   The tiles are the 34 kinds of mahjong-tiles.js (0-8 circles, 9-17 bamboo, 18-26 characters, 27-30 winds, 31-33 dragons),
   four of each, 136 in all, no flowers. A hand is four sets (chow, pung or kong) and a pair; a win needs the faan (the
   doubling points) to reach the minimum, three by default. The scoring table and the payments are below.
   The Table (a hand in play) is plain data with functions over it, so the page and the tests drive it the same way, and
   the computers' choices live here too. */
(function (root) {
  'use strict';

  var KINDS = 34, COPIES = 4, HAND = 13, DEAD_WALL = 14, SEATS = 4, LIMIT_FAAN = 8;
  var DRAGON_FIRST = 31, WIND_FIRST = 27;
  var TERMINALS_AND_HONOURS = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];
  // faan -> points one side pays (the discarder pays double on a win by discard; everyone pays on a self-drawn win)
  var POINTS = { 1: 1, 2: 2, 3: 8, 4: 16, 5: 24, 6: 32, 7: 48, 8: 64 };
  var WINDS = ['East', 'South', 'West', 'North'], DRAGONS = ['Red dragon', 'Green dragon', 'White dragon'], SUITS = ['circles', 'bamboo', 'characters'];
  var HAND_NAMES = {
    selfDrawn: 'Self-drawn', concealed: 'Concealed hand', common: 'Common hand', allPungs: 'All pungs', mixed: 'Mixed one suit', pure: 'Pure one suit', dragon: 'Dragon pung',
    seat: 'Seat wind pung', round: 'Prevailing wind pung', smallDragons: 'Small three dragons', bigDragons: 'Big three dragons', smallWinds: 'Small four winds', bigWinds: 'Big four winds',
    allHonours: 'All honours', orphans: 'Thirteen orphans', last: 'Last tile from the wall', replacement: 'Win on the replacement tile'
  };
  // For the scoring table on the page: [name, faan, how].
  var TABLE = [
    ['Common hand', 1, 'four chows and a pair that scores nothing'], ['Self-drawn', 1, 'you drew the winning tile'], ['Concealed hand', 1, 'no melds taken from a discard'],
    ['Dragon pung', 1, 'each pung or kong of dragons'], ['Seat wind pung', 1, 'a pung of your own wind'], ['Prevailing wind pung', 1, 'a pung of East, the wind of the round'],
    ['Last tile / replacement tile', 1, 'a win on the last tile or on the tile after a kong'], ['All pungs', 3, 'four pungs or kongs and a pair'], ['Mixed one suit', 3, 'one suit and honours'],
    ['Small three dragons', 5, 'two dragon pungs and a dragon pair'], ['Small four winds', 6, 'three wind pungs and a wind pair'], ['Pure one suit', 6, 'one suit and no honours'],
    ['Big three dragons', 8, 'limit: three dragon pungs'], ['Big four winds', 8, 'limit: four wind pungs'], ['All honours', 8, 'limit: only winds and dragons'], ['Thirteen orphans', 8, 'limit: one of each terminal and honour, and a pair']
  ];

  function isHonour(k) { return k >= WIND_FIRST; }
  function suitOf(k) { return k < 27 ? (k / 9) | 0 : -1; }
  function numOf(k) { return k % 9; }
  function tileName(k) {
    if (k < 27) return (numOf(k) + 1) + ' of ' + SUITS[suitOf(k)];
    return k < DRAGON_FIRST ? WINDS[k - WIND_FIRST] + ' wind' : DRAGONS[k - DRAGON_FIRST];
  }
  function countsOf(list) { var c = new Int8Array(KINDS); for (var i = 0; i < list.length; i++) c[list[i]]++; return c; }
  function sortTiles(list) { return list.sort(function (a, b) { return a - b; }); }
  function pointsFor(faan) { return POINTS[Math.max(1, Math.min(LIMIT_FAAN, faan))] || 0; }

  // ── recognising a hand ──
  function collect(counts, need, sets, out, pair) {
    var i = 0;
    while (i < KINDS && counts[i] === 0) i++;
    if (i === KINDS) { if (need === 0) out.push({ pair: pair, sets: sets.slice() }); return; }
    if (need === 0) return;
    if (counts[i] >= 3) { counts[i] -= 3; sets.push({ t: 'p', k: i }); collect(counts, need - 1, sets, out, pair); sets.pop(); counts[i] += 3; }
    if (i < 27 && numOf(i) <= 6 && counts[i + 1] > 0 && counts[i + 2] > 0) {
      counts[i]--; counts[i + 1]--; counts[i + 2]--; sets.push({ t: 'c', k: i }); collect(counts, need - 1, sets, out, pair); sets.pop(); counts[i]++; counts[i + 1]++; counts[i + 2]++;
    }
  }
  // Every way the concealed tiles make `sets` sets and a pair.
  function decompositions(counts, sets) {
    var total = 0, out = [], k;
    for (k = 0; k < KINDS; k++) total += counts[k];
    if (total !== 3 * sets + 2) return out;
    for (k = 0; k < KINDS; k++) if (counts[k] >= 2) { counts[k] -= 2; collect(counts, sets, [], out, k); counts[k] += 2; }
    return out;
  }
  function isOrphans(counts, meldCount) {
    if (meldCount) return false;
    var total = 0, k, pair = false;
    for (k = 0; k < KINDS; k++) total += counts[k];
    if (total !== 14) return false;
    for (var i = 0; i < TERMINALS_AND_HONOURS.length; i++) { var c = counts[TERMINALS_AND_HONOURS[i]]; if (c === 0) return false; if (c === 2) pair = true; else if (c > 2) return false; }
    return pair;
  }
  function canWin(counts, meldCount) { return isOrphans(counts, meldCount) || decompositions(counts, 4 - meldCount).length > 0; }
  // The kinds that would complete a hand of thirteen (less three for each meld) tiles.
  function waits(counts, meldCount) {
    var out = [];
    for (var k = 0; k < KINDS; k++) {
      if (counts[k] >= COPIES) continue;
      counts[k]++;
      if (canWin(counts, meldCount)) out.push(k);
      counts[k]--;
    }
    return out;
  }

  // ── scoring ──
  // ctx: { counts (the concealed tiles with the winning tile in), melds: [{ type: 'chow' | 'pung' | 'kong', k, open }],
  //        selfDrawn, seat (0 East .. 3 North), round (the prevailing wind, 0), last, replacement }
  // -> { faan, items: [{ name, faan }], limit } or null when the tiles are not a win.
  function scoreHand(ctx) {
    var melds = ctx.melds || [], best = null;
    if (isOrphans(ctx.counts, melds.length)) return { faan: LIMIT_FAAN, items: [{ key: 'orphans', name: HAND_NAMES.orphans, faan: LIMIT_FAAN }], limit: true };
    var decs = decompositions(ctx.counts, 4 - melds.length);
    for (var i = 0; i < decs.length; i++) {
      var r = scoreDecomposition(decs[i], melds, ctx);
      if (!best || r.faan > best.faan || (r.faan === best.faan && r.items.length > best.items.length)) best = r;
    }
    return best;
  }
  function scoreDecomposition(dec, melds, ctx) {
    var sets = dec.sets.map(function (s) { return { t: s.t, k: s.k, open: false }; }).concat(melds.map(function (m) { return { t: m.type === 'chow' ? 'c' : 'p', k: m.k, open: !!m.open }; }));
    var items = [], limit = null, i;
    function add(key, faan) { items.push({ key: key, name: HAND_NAMES[key], faan: faan }); }
    var pungs = sets.filter(function (s) { return s.t === 'p'; }), chows = sets.filter(function (s) { return s.t === 'c'; });
    var dragonPungs = pungs.filter(function (s) { return s.k >= DRAGON_FIRST; }), windPungs = pungs.filter(function (s) { return isHonour(s.k) && s.k < DRAGON_FIRST; });
    var kinds = [dec.pair]; sets.forEach(function (s) { kinds.push(s.k); if (s.t === 'c') kinds.push(s.k + 1, s.k + 2); });
    var suits = {}, honours = false;
    kinds.forEach(function (k) { if (isHonour(k)) honours = true; else suits[suitOf(k)] = true; });
    var suitCount = Object.keys(suits).length;
    // the limit hands
    if (dragonPungs.length === 3) limit = 'bigDragons';
    else if (windPungs.length === 4) limit = 'bigWinds';
    else if (!suitCount && honours && !chows.length) limit = 'allHonours';
    if (limit) { items.push({ key: limit, name: HAND_NAMES[limit], faan: LIMIT_FAAN }); return { faan: LIMIT_FAAN, items: items, limit: true }; }
    var smallDragons = dragonPungs.length === 2 && dec.pair >= DRAGON_FIRST, smallWinds = windPungs.length === 3 && isHonour(dec.pair) && dec.pair < DRAGON_FIRST;
    if (smallDragons) add('smallDragons', 5);
    else dragonPungs.forEach(function () { add('dragon', 1); });
    if (smallWinds) add('smallWinds', 6);
    else {
      windPungs.forEach(function (s) {
        if (s.k === WIND_FIRST + ctx.seat) add('seat', 1);
        if (s.k === WIND_FIRST + (ctx.round || 0)) add('round', 1);
      });
    }
    if (suitCount === 1 && !honours) add('pure', 6);
    else if (suitCount === 1 && honours) add('mixed', 3);
    if (pungs.length === 4) add('allPungs', 3);
    var pairScores = dec.pair >= DRAGON_FIRST || dec.pair === WIND_FIRST + ctx.seat || dec.pair === WIND_FIRST + (ctx.round || 0);
    if (chows.length === 4 && !pairScores) add('common', 1);
    if (ctx.selfDrawn) add('selfDrawn', 1);
    if (!sets.some(function (s) { return s.open; })) add('concealed', 1);
    if (ctx.last) add('last', 1);
    if (ctx.replacement) add('replacement', 1);
    var total = 0;
    for (i = 0; i < items.length; i++) total += items[i].faan;
    return { faan: Math.min(LIMIT_FAAN, total), items: items, limit: total >= LIMIT_FAAN };
  }

  // ── claims on a discard ──
  function chowOptions(counts, tile) {
    var out = [];
    if (tile >= 27) return out;
    var n = numOf(tile);
    for (var s = Math.max(0, n - 2); s <= Math.min(6, n); s++) {
      var a = tile - n + s;   // the start of the run, in the same suit
      var ok = true;
      for (var j = 0; j < 3; j++) { if (a + j !== tile && !counts[a + j]) ok = false; }
      if (ok) out.push(a);
    }
    return out;
  }

  // ── the table: a hand in play ──
  function shuffle(a, rnd) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function newWall(rnd) {
    var wall = [];
    for (var k = 0; k < KINDS; k++) for (var c = 0; c < COPIES; c++) wall.push(k);
    return shuffle(wall, rnd);
  }
  // A hand: opts { rnd, dealer, min }. The dealer (East) has drawn the fourteenth tile and is to discard.
  function newHand(opts) {
    var rnd = opts.rnd || Math.random, wall = newWall(rnd), hands = [[], [], [], []], p, i;
    for (i = 0; i < HAND; i++) for (p = 0; p < SEATS; p++) hands[p].push(wall.pop());
    var dead = wall.splice(wall.length - DEAD_WALL, DEAD_WALL);
    var t = { rnd: rnd, dealer: opts.dealer || 0, min: opts.min || 3, round: 0, wall: wall, dead: dead, hands: hands, melds: [[], [], [], []], discards: [[], [], [], []], turn: opts.dealer || 0, phase: 'discard',
      lastDiscard: null, lastDrawn: null, replacement: false, result: null, claims: null, draws: 0 };
    hands.forEach(sortTiles);
    t.hands[t.dealer].push(wall.pop()); t.lastDrawn = t.hands[t.dealer][t.hands[t.dealer].length - 1]; sortTiles(t.hands[t.dealer]);
    return t;
  }
  function seatOf(t, p) { return (p - t.dealer + SEATS) % SEATS; }   // 0 East .. 3 North: the dealer is East
  function liveLeft(t) { return t.wall.length; }
  function tilesInPlay(t) {
    var n = t.wall.length + t.dead.length, p;
    for (p = 0; p < SEATS; p++) { n += t.hands[p].length + t.discards[p].length; t.melds[p].forEach(function (m) { n += m.type === 'chow' ? 3 : m.type === 'pung' ? 3 : 4; }); }
    if (t.lastDiscard && t.claims) n += 0;
    return n;
  }
  function meldList(t, p) { return t.melds[p]; }
  function scoreFor(t, p, counts, selfDrawn) {
    var s = scoreHand({ counts: counts, melds: t.melds[p], selfDrawn: selfDrawn, seat: seatOf(t, p), round: t.round, last: selfDrawn && t.wall.length === 0, replacement: selfDrawn && t.replacement });
    return s && s.faan >= t.min ? s : null;
  }

  // What the player to discard (just drawn, or just claimed) may do besides discarding.
  function selfOptions(t, p) {
    var counts = countsOf(t.hands[p]), out = { win: null, concealedKongs: [], addKongs: [] }, k;
    if (t.lastDrawn !== null && t.turn === p) out.win = scoreFor(t, p, counts, true);
    for (k = 0; k < KINDS; k++) if (counts[k] === 4) out.concealedKongs.push(k);
    t.melds[p].forEach(function (m) { if (m.type === 'pung' && counts[m.k] >= 1) out.addKongs.push(m.k); });
    return out;
  }
  function drawFrom(t, p, fromDead) {
    var tile = fromDead ? t.dead.pop() : t.wall.shift();
    t.hands[p].push(tile); sortTiles(t.hands[p]); t.lastDrawn = tile; t.replacement = !!fromDead; t.turn = p; t.phase = 'discard'; t.draws++;
    return tile;
  }
  // The next player's turn begins with a draw; an empty wall ends the hand in a draw.
  function drawFor(t, p) {
    if (!t.wall.length) { t.result = { type: 'draw' }; t.phase = 'over'; return null; }
    return drawFrom(t, p, false);
  }
  function declareWin(t, p, fromDiscard) {
    var counts = countsOf(t.hands[p]);
    if (fromDiscard) counts[t.lastDiscard.tile]++;
    var s = scoreFor(t, p, counts, !fromDiscard);
    if (!s) return null;
    t.result = { type: 'win', winner: p, from: fromDiscard ? t.lastDiscard.from : null, faan: s.faan, items: s.items, limit: s.limit, tile: fromDiscard ? t.lastDiscard.tile : t.lastDrawn, points: paymentsFor(t, p, fromDiscard ? t.lastDiscard.from : null, s.faan) };
    if (fromDiscard) { t.discards[t.lastDiscard.from].pop(); }
    t.phase = 'over';
    return t.result;
  }
  // Points changes per player: a self-drawn win is paid by all three, a win on a discard by the discarder at double.
  function paymentsFor(t, winner, from, faan) {
    var base = pointsFor(faan), delta = [0, 0, 0, 0], p;
    if (from === null) { for (p = 0; p < SEATS; p++) if (p !== winner) { delta[p] -= base; delta[winner] += base; } }
    else { delta[from] -= base * 2; delta[winner] += base * 2; }
    return delta;
  }
  function declareKong(t, p, k) {
    var h = t.hands[p], m = t.melds[p].filter(function (x) { return x.type === 'pung' && x.k === k; })[0], n = 0, i;
    if (m) { var at = h.indexOf(k); if (at < 0) return false; h.splice(at, 1); m.type = 'kong'; }
    else { for (i = h.length - 1; i >= 0; i--) if (h[i] === k) { h.splice(i, 1); n++; } if (n !== 4) return false; t.melds[p].push({ type: 'kong', k: k, open: false }); }
    if (!t.dead.length) { t.result = { type: 'draw' }; t.phase = 'over'; return true; }
    drawFrom(t, p, true);
    return true;
  }
  function discard(t, p, tile) {
    var at = t.hands[p].indexOf(tile);
    if (at < 0 || t.turn !== p || t.phase !== 'discard') return false;
    t.hands[p].splice(at, 1);
    t.discards[p].push(tile); t.lastDiscard = { tile: tile, from: p }; t.lastDrawn = null; t.replacement = false; t.phase = 'claim';
    t.claims = {};
    for (var q = 0; q < SEATS; q++) if (q !== p) t.claims[q] = claimsFor(t, q);
    return true;
  }
  function claimsFor(t, q) {
    var tile = t.lastDiscard.tile, from = t.lastDiscard.from, counts = countsOf(t.hands[q]), out = { win: null, pung: false, kong: false, chows: [] };
    var c2 = countsOf(t.hands[q]); c2[tile]++;
    out.win = scoreFor(t, q, c2, false);
    out.pung = counts[tile] >= 2; out.kong = counts[tile] >= 3;
    if (q === (from + 1) % SEATS) out.chows = chowOptions(counts, tile);
    return out;
  }
  // Settle the claims on the last discard. picks: { player: { type: 'win'|'pung'|'kong'|'chow', start } }.
  // Priority: win, then pung or kong, then chow; ties go to the player nearest after the discarder.
  function resolve(t, picks) {
    var from = t.lastDiscard.from, tile = t.lastDiscard.tile, order = [1, 2, 3].map(function (d) { return (from + d) % SEATS; }), rank = { win: 3, kong: 2, pung: 2, chow: 1 }, best = null, i;
    for (i = 0; i < order.length; i++) {
      var pk = picks[order[i]];
      if (!pk) continue;
      if (!best || rank[pk.type] > rank[best.pick.type]) best = { p: order[i], pick: pk };
    }
    t.claims = null;
    if (!best) { t.lastDiscardResolved = true; return drawFor(t, (from + 1) % SEATS) === null ? 'draw' : 'next'; }
    var p = best.p, h = t.hands[p], pick = best.pick, n, idx;
    if (pick.type === 'win') { declareWin(t, p, true); return 'win'; }
    function take(k, count) { for (var c = 0; c < count; c++) { idx = h.indexOf(k); h.splice(idx, 1); } }
    t.discards[from].pop();
    if (pick.type === 'pung') { take(tile, 2); t.melds[p].push({ type: 'pung', k: tile, open: true, from: from }); t.turn = p; t.phase = 'discard'; t.lastDrawn = null; return 'pung'; }
    if (pick.type === 'kong') {
      take(tile, 3); t.melds[p].push({ type: 'kong', k: tile, open: true, from: from }); t.turn = p;
      if (!t.dead.length) { t.result = { type: 'draw' }; t.phase = 'over'; return 'draw'; }
      drawFrom(t, p, true); return 'kong';
    }
    for (n = 0; n < 3; n++) if (pick.start + n !== tile) take(pick.start + n, 1);
    t.melds[p].push({ type: 'chow', k: pick.start, open: true, from: from }); t.turn = p; t.phase = 'discard'; t.lastDrawn = null;
    return 'chow';
  }

  // ── the computers ──
  var LEVELS = { easy: { noise: 2.6, chow: 0.25, pung: 0.55, kong: false, waits: false }, medium: { noise: 0.7, chow: 0.6, pung: 0.85, kong: true, waits: false }, hard: { noise: 0.1, chow: 0.9, pung: 1, kong: true, waits: true } };
  function targetSuit(counts) {
    var by = [0, 0, 0], k;
    for (k = 0; k < 27; k++) by[suitOf(k)] += counts[k];
    var s = by[0] >= by[1] && by[0] >= by[2] ? 0 : by[1] >= by[2] ? 1 : 2;
    return by[s] >= 4 ? s : -1;
  }
  function usefulness(counts, k, t, p, suit) {
    var n = counts[k], v = 0, seat = seatOf(t, p);
    if (n >= 3) v += 5; else if (n === 2) v += 2.6;
    if (k < 27) {
      var m = numOf(k);
      if (m > 0 && counts[k - 1]) v += 1.1; if (m > 1 && counts[k - 2]) v += 0.6;
      if (m < 8 && counts[k + 1]) v += 1.1; if (m < 7 && counts[k + 2]) v += 0.6;
      if (suit >= 0) v += suitOf(k) === suit ? 1.6 : -2.2;
      if (m === 0 || m === 8) v -= 0.3;
    } else {
      if (n < 2) v -= 0.8;
      if (k >= DRAGON_FIRST || k === WIND_FIRST + seat || k === WIND_FIRST + t.round) v += 1;
    }
    return v;
  }
  // Which tile to throw: the least useful, with a little noise on the gentler levels. Hard looks for the throw with the most winning tiles left.
  function aiDiscard(t, p, level) {
    var cfg = LEVELS[level] || LEVELS.medium, h = t.hands[p], counts = countsOf(h), suit = targetSuit(counts), best = h[0], bestScore = Infinity, seen = {}, i;
    var melds = t.melds[p].length;
    for (i = 0; i < h.length; i++) {
      var k = h[i];
      if (seen[k]) continue; seen[k] = true;
      var sc = usefulness(counts, k, t, p, suit) + (t.rnd() - 0.5) * 2 * cfg.noise;
      if (cfg.waits) {
        counts[k]--;
        var w = waits(counts, melds);
        counts[k]++;
        if (w.length) {
          var live = 0; w.forEach(function (x) { live += COPIES - counts[x] - visibleOutside(t, p, x); });
          sc += 6 + Math.max(0, live) * 1.2;
        }
      }
      if (sc < bestScore) { bestScore = sc; best = k; }
    }
    return best;
  }
  function visibleOutside(t, p, k) { var n = 0, q; for (q = 0; q < SEATS; q++) { t.discards[q].forEach(function (x) { if (x === k) n++; }); } return n; }
  // After drawing: win if it scores, or declare a kong now and then. Returns null (just discard) or { type: 'win' } or { type: 'kong', k }.
  function aiSelf(t, p, level) {
    var cfg = LEVELS[level] || LEVELS.medium, o = selfOptions(t, p);
    if (o.win) return { type: 'win' };
    if (cfg.kong) {
      if (o.addKongs.length) return { type: 'kong', k: o.addKongs[0] };
      if (o.concealedKongs.length && t.wall.length > 12) return { type: 'kong', k: o.concealedKongs[0] };
    }
    return null;
  }
  // A claim on the last discard, or null.
  function aiClaim(t, p, level) {
    var cfg = LEVELS[level] || LEVELS.medium, c = t.claims[p], tile = t.lastDiscard.tile, counts = countsOf(t.hands[p]), suit = targetSuit(counts), seat = seatOf(t, p);
    if (c.win) return { type: 'win' };
    var wanted = tile >= DRAGON_FIRST || tile === WIND_FIRST + seat || tile === WIND_FIRST + t.round;
    var inSuit = tile < 27 && suit >= 0 && suitOf(tile) === suit, honour = isHonour(tile);
    if (c.kong && cfg.kong && wanted && t.dead.length > 1) return { type: 'kong' };
    if (c.pung && (wanted || ((inSuit || honour) && counts[tile] >= 2)) && t.rnd() < cfg.pung) return { type: 'pung' };
    if (c.chows.length && inSuit && t.rnd() < cfg.chow) {
      var tight = c.chows.filter(function (s) { return s !== tile && s !== tile - 1 && s !== tile - 2 ? true : true; });
      return { type: 'chow', start: tight[Math.floor(t.rnd() * tight.length)] };
    }
    return null;
  }

  root.Mahjong4Engine = {
    KINDS: KINDS, SEATS: SEATS, LIMIT_FAAN: LIMIT_FAAN, POINTS: POINTS, TABLE: TABLE, WINDS: WINDS, LEVELS: LEVELS,
    isHonour: isHonour, suitOf: suitOf, tileName: tileName, countsOf: countsOf, sortTiles: sortTiles, pointsFor: pointsFor,
    decompositions: decompositions, canWin: canWin, waits: waits, isOrphans: isOrphans, scoreHand: scoreHand, chowOptions: chowOptions,
    newWall: newWall, newHand: newHand, seatOf: seatOf, tilesInPlay: tilesInPlay, selfOptions: selfOptions, drawFor: drawFor, declareWin: declareWin, declareKong: declareKong, discard: discard, claimsFor: claimsFor, resolve: resolve,
    aiDiscard: aiDiscard, aiSelf: aiSelf, aiClaim: aiClaim, paymentsFor: paymentsFor, liveLeft: liveLeft, meldList: meldList
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
