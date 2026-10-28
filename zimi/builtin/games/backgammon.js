/* ZimiGames: Backgammon, with an optional doubling cube. Our own code, GPL-3.0.
   The rules and the computer (pure functions, testable in node), then the page.
   Players: 0 is white and 1 is black. A point's index runs 0..23; white moves from 23 down to
   0 and bears off past 0, black the other way. Steps use "pip" numbers, the distance a checker
   still has to travel: 1 is the last point, 24 the farthest, 25 is the bar and 0 is off. */
(function (root) {
  'use strict';

  // ── the rules ────────────────────────────────────────────────────────────
  var CHECKERS = 15, HOME = 6, BAR = 25;
  var LEVELS = { easy: { noise: 14, ply: 0 }, medium: { noise: 0, ply: 0 }, hard: { noise: 0, ply: 2 } };
  // out of 36 rolls, how many hit a checker this many pips away (direct and combined shots)
  var SHOTS = [0, 11, 12, 14, 15, 15, 17, 6, 6, 5, 3, 2, 3];

  function sign(p) { return p === 0 ? 1 : -1; }
  function idxOf(p, r) { return p === 0 ? r - 1 : 24 - r; }
  function relOf(p, idx) { return p === 0 ? idx + 1 : 24 - idx; }
  function countAt(s, p, idx) { var v = s.pts[idx] * sign(p); return v > 0 ? v : 0; }

  function startPosition() {
    var pts = new Int8Array(24);
    pts[23] = 2; pts[12] = 5; pts[7] = 3; pts[5] = 5;       // white
    pts[0] = -2; pts[11] = -5; pts[16] = -3; pts[18] = -5;  // black, the mirror image
    return { pts: pts, bar: [0, 0], off: [0, 0], turn: 0, dice: [], rolled: false, cube: { value: 1, owner: -1 } };
  }
  function copy(s) {
    return { pts: s.pts.slice(0), bar: s.bar.slice(0), off: s.off.slice(0), turn: s.turn, dice: s.dice.slice(0), rolled: s.rolled, cube: { value: s.cube.value, owner: s.cube.owner } };
  }
  function pips(s, p) {
    var t = s.bar[p] * BAR;
    for (var i = 0; i < 24; i++) t += countAt(s, p, i) * relOf(p, i);
    return t;
  }
  function allHome(s, p) {
    if (s.bar[p]) return false;
    for (var r = HOME + 1; r <= 24; r++) if (countAt(s, p, idxOf(p, r))) return false;
    return true;
  }

  // Every single-die step p could make with die d, before the "must use both dice" rule.
  function stepsFor(s, p, d) {
    var out = [], r, to;
    if (s.bar[p] > 0) {
      to = BAR - d;
      if (countAt(s, 1 - p, idxOf(p, to)) <= 1) out.push({ from: BAR, to: to, die: d });
      return out;
    }
    var home = allHome(s, p), highest = 0;
    for (r = 1; r <= 24; r++) if (countAt(s, p, idxOf(p, r))) highest = r;
    for (r = 1; r <= 24; r++) {
      if (!countAt(s, p, idxOf(p, r))) continue;
      to = r - d;
      if (to >= 1) { if (countAt(s, 1 - p, idxOf(p, to)) <= 1) out.push({ from: r, to: to, die: d }); }
      else if (home && (to === 0 || r === highest)) out.push({ from: r, to: 0, die: d });
    }
    return out;
  }
  function distinct(a) { var o = []; a.forEach(function (x) { if (o.indexOf(x) < 0) o.push(x); }); return o; }
  function without(dice, d) { var i = dice.indexOf(d), o = dice.slice(0); o.splice(i, 1); return o; }
  function key(s) { return s.turn + ':' + Array.prototype.join.call(s.pts, ',') + '|' + s.bar + '|' + s.off + '|' + s.dice.slice(0).sort().join(''); }

  // Make a step: the checker leaves, a lone opposing checker on the landing point goes to the bar.
  function applyStep(s, st) {
    var t = copy(s), p = s.turn;
    t.dice = without(s.dice, st.die);
    if (st.from === BAR) t.bar[p]--; else t.pts[idxOf(p, st.from)] -= sign(p);
    t.hit = false;
    if (st.to === 0) t.off[p]++;
    else {
      var i = idxOf(p, st.to);
      if (countAt(s, 1 - p, i) === 1) { t.pts[i] = 0; t.bar[1 - p]++; t.hit = true; }
      t.pts[i] += sign(p);
    }
    return t;
  }

  // The most dice p can use from here (the rules insist on playing as many as possible).
  var memo = null;
  function maxUse(s) {
    if (!s.dice.length) return 0;
    var k = key(s), hit = memo.get(k);
    if (hit !== undefined) return hit;
    var best = 0, ds = distinct(s.dice), i, j;
    for (i = 0; i < ds.length && best < s.dice.length; i++) {
      var steps = stepsFor(s, s.turn, ds[i]);
      for (j = 0; j < steps.length && best < s.dice.length; j++) {
        var v = 1 + maxUse(applyStep(s, steps[j]));
        if (v > best) best = v;
      }
    }
    memo.set(k, best);
    return best;
  }
  // The steps the side to move may make now: part of a play that uses as many dice as possible,
  // and when only one die can be played, the larger if both could be.
  function legalSteps(s) {
    memo = memo && memo.size < 20000 ? memo : new Map();
    var p = s.turn, ds = distinct(s.dice), all = [], best = 0, i, j;
    for (i = 0; i < ds.length; i++) stepsFor(s, p, ds[i]).forEach(function (st) { all.push(st); });
    if (!all.length) return [];
    var vals = all.map(function (st) { var v = 1 + maxUse(applyStep(s, st)); if (v > best) best = v; return v; });
    var out = all.filter(function (st, k) { return vals[k] === best; });
    if (best === 1 && ds.length === 2) {
      var big = Math.max(ds[0], ds[1]), bigSteps = out.filter(function (st) { return st.die === big; });
      if (bigSteps.length) out = bigSteps;
    }
    return out;
  }
  function endTurn(s) { var t = copy(s); t.turn = 1 - s.turn; t.dice = []; t.rolled = false; return t; }
  function winner(s) { return s.off[0] >= CHECKERS ? 0 : s.off[1] >= CHECKERS ? 1 : -1; }
  // Points won: the cube, times 2 for a gammon (loser has taken nothing off), 3 for a backgammon.
  function outcome(s, w) {
    var l = 1 - w, mult = 1;
    if (!s.off[l]) {
      mult = 2;
      var inHome = s.bar[l] > 0;
      for (var r = 19; r <= 24 && !inHome; r++) if (countAt(s, l, idxOf(l, r))) inHome = true;
      if (inHome) mult = 3;
    }
    return { mult: mult, points: s.cube.value * mult, kind: mult === 3 ? 'backgammon' : mult === 2 ? 'gammon' : 'single' };
  }

  // Every complete play for the side to move with its dice: [{ steps, state }], one per final position.
  function turnOptions(s) {
    var layer = [{ state: s, path: [] }], done = new Map();
    while (layer.length) {
      var next = new Map();
      for (var i = 0; i < layer.length; i++) {
        var node = layer[i], steps = legalSteps(node.state);
        if (!steps.length) { var fk = key(node.state); if (!done.has(fk)) done.set(fk, node); continue; }
        for (var j = 0; j < steps.length; j++) {
          var ns = applyStep(node.state, steps[j]), nk = key(ns);
          if (!next.has(nk)) next.set(nk, { state: ns, path: node.path.concat([steps[j]]) });
        }
      }
      layer = Array.from(next.values());
    }
    return Array.from(done.values()).map(function (n) { return { steps: n.path, state: n.state }; });
  }

  // ── the computer ─────────────────────────────────────────────────────────
  function hasContact(s) {
    var lowBlack = s.bar[1] ? -1 : 99, highWhite = s.bar[0] ? 24 : -1, i;
    for (i = 0; i < 24; i++) { if (s.pts[i] < 0 && i < lowBlack) lowBlack = i; if (s.pts[i] > 0) highWhite = i; }
    return lowBlack < highWhite;
  }
  // How likely the other side hits a blot of p's at point r (a pip number), 0..1.
  function hitChance(s, p, r) {
    var q = 1 - p, idx = idxOf(p, r), best = 0, sum = 0, seen = {}, d, i;
    function add(dist) { if (dist >= 1 && dist <= 12 && !seen[dist]) { seen[dist] = 1; var v = SHOTS[dist] / 36; sum += v; if (v > best) best = v; } }
    if (s.bar[q]) add(q === 1 ? idx + 1 : 24 - idx);
    for (i = 0; i < 24; i++) {
      if (!countAt(s, q, i)) continue;
      d = q === 1 ? idx - i : i - idx;
      if (d >= 1) add(d);
    }
    return Math.min(0.95, best + 0.25 * (sum - best));
  }
  // In a pure race, checkers piled on the low points and gaps in the home board waste pips.
  function raceWaste(s, p) {
    var w = 0;
    for (var r = 1; r <= HOME; r++) {
      var c = countAt(s, p, idxOf(p, r));
      if (c > 2) w += (c - 2) * (1 + (HOME - r) * 0.45);
      else if (c === 0 && r >= 2) w += 0.4;
    }
    return w;
  }
  // How good the position is for p, with the other side about to roll.
  function evaluate(s, p) {
    var q = 1 - p, v = pips(s, q) - pips(s, p), r;
    if (!hasContact(s)) return v * 2 + (s.off[p] - s.off[q]) * 1.5 - raceWaste(s, p) + raceWaste(s, q);
    var run = 0, bestRun = 0;
    for (r = 1; r <= 24; r++) {
      var c = countAt(s, p, idxOf(p, r));
      if (c === 1) v -= 0.9 * hitChance(s, p, r) * (BAR - r + 8 + (r <= HOME ? 6 : 0));
      else if (c >= 2) {
        v += r <= HOME ? 3.4 : r <= 12 ? 2.4 : r >= 19 ? 2.6 : 1.4;
        if (c > 4) v -= (c - 4) * 1.6;
      }
      if (c >= 2 && r <= 18) { run++; if (run > bestRun) bestRun = run; } else run = 0;
      if (countAt(s, q, idxOf(p, r)) === 1 && r >= 7) v += 1.2;
    }
    if (bestRun >= 3) v += (bestRun - 2) * 4.5;
    v -= 18 * s.bar[p]; v += 16 * s.bar[q];
    v += s.off[p] * 1.2;
    return v;
  }
  // Roll weights: 21 distinct rolls, doubles once and the others twice (out of 36).
  var ROLLS = (function () { var o = []; for (var a = 1; a <= 6; a++) for (var b = a; b <= 6; b++) o.push({ dice: a === b ? [a, a, a, a] : [b, a], w: a === b ? 1 : 2 }); return o; })();

  // What the best reply is worth to p after a play: average over the other side's rolls.
  function replyValue(s, p) {
    var q = 1 - p, total = 0;
    ROLLS.forEach(function (rl) {
      var t = copy(s); t.turn = q; t.dice = rl.dice.slice(0); t.rolled = true;
      var bestV = -Infinity, opts = rl.dice.length === 4 ? greedyPlay(t, q) : turnOptions(t);
      if (!opts.length) bestV = evaluate(s, q);
      else opts.forEach(function (o) { var e = evaluate(o.state, q); if (e > bestV) bestV = e; });
      total += -bestV * rl.w;
    });
    return total / 36;
  }
  // For a double the computer takes the best step one at a time (the full tree is too large to search).
  function greedyPlay(s, p) {
    var cur = s;
    for (var guard = 0; guard < 4; guard++) {
      var steps = legalSteps(cur);
      if (!steps.length) break;
      var best = null, bestV = -Infinity;
      for (var i = 0; i < steps.length; i++) { var ns = applyStep(cur, steps[i]), e = evaluate(ns, p); if (e > bestV) { bestV = e; best = ns; } }
      cur = best;
    }
    return [{ steps: [], state: cur }];
  }

  // The computer's play at a level: a list of steps (empty when it cannot move).
  function chooseTurn(s, level, rng) {
    var cfg = LEVELS[level] || LEVELS.medium, rand = rng || Math.random, p = s.turn, opts = turnOptions(s);
    if (!opts.length) return [];
    opts.forEach(function (o) { o.v = evaluate(o.state, p) + (cfg.noise ? (rand() - 0.5) * cfg.noise * 2 : 0); });
    opts.sort(function (a, b) { return b.v - a.v; });
    if (cfg.ply && opts.length > 1 && hasContact(s)) {
      var top = opts.slice(0, 6);
      top.forEach(function (o) { o.v2 = 0.4 * o.v + 0.6 * replyValue(o.state, p); });
      top.sort(function (a, b) { return b.v2 - a.v2; });
      return top[0].steps;
    }
    return opts[0].steps;
  }
  // The side's chance of winning, roughly, from the race and the position (for cube decisions).
  function winChance(s, p) {
    var me = pips(s, p), you = pips(s, 1 - p), lead = (you - me) / Math.max(40, me);
    var w = 0.5 + lead * (hasContact(s) ? 1.1 : 1.6);
    w += (evaluate(s, p) - (you - me)) * 0.004;
    return Math.max(0.03, Math.min(0.97, w));
  }

  root.BackgammonEngine = { LEVELS: LEVELS, BAR: BAR, newGame: startPosition, copy: copy, pips: pips, stepsFor: stepsFor, legalSteps: legalSteps, applyStep: applyStep, endTurn: endTurn, winner: winner, outcome: outcome, turnOptions: turnOptions, chooseTurn: chooseTurn, evaluate: evaluate, winChance: winChance, idxOf: idxOf, relOf: relOf, countAt: countAt, allHome: allHome, key: key, hasContact: hasContact };

  // ── the page ─────────────────────────────────────────────────────────────
  if (typeof document === 'undefined' || !root.BoardUI) return;
  var WK = root.WorldKit, BK = root.BoardKit, UI = root.BoardUI, T = UI.t;
  // The board is laid out along two axes: u runs along the points (twelve a side, the bar between the sixth and seventh) and v across
  // the board (one side's points, the middle, the other's). A wide screen draws u left to right, v top to bottom. A phone held upright
  // turns it on its side: u runs down the screen, so the points are tall and easy to tap, the bar is a strip across, and the middle
  // channel holds the dice, the cube and the borne-off checkers.
  var CR = 14.5, PW, GAP, HALF, MID, TM, TRAY = 40, TRL = 80, U0, U, V, portrait = false;
  var COLORS = ['var(--disc-w)', 'var(--disc-b)'];
  function sideName(p) { return UI.side(p === 0 ? 'white' : 'black'); }
  // Who a sentence is about: you or the computer against the machine, else the side's name.
  function whoName(p) { return G.vsComputer() && !G.watching ? (isHuman(p) ? T('board.you') : T('board.zimi')) : sideName(p); }
  var host = document.getElementById('wk-board'), btns = {}, gLayer;
  var rollBtn = document.getElementById('bk-roll'), doubleBtn = document.getElementById('bk-double'), takeBtn = document.getElementById('bk-take'), dropBtn = document.getElementById('bk-drop');
  var s, turnStart = null, sel = -1, lastFrom = [], lastTo = [], hintStep = null, rolling = false, offer = false, session = [0, 0], flipped = false, dieShown = [];
  var score = WK.scoreBar(document.getElementById('wk-score'), [{ color: COLORS[0] }, { color: COLORS[1] }]);
  var G = WK.create({
    id: 'backgammon',
    options: WK.standardOptions({ first: 'board.white', second: 'board.black' }),
    checks: [{ key: 'cube', label: 'backgammon.cube', def: false }, { key: 'auto', label: 'backgammon.auto', def: true }],
    statKey: function (st) { return st.level + (st.cube ? 'c' : ''); },
    onNew: newGame, onUndo: undo, onHint: hint
  });
  // which colour does the person play: 0 white, 1 black. In two-player mode, whoever is to move.
  function mine() { return G.vsComputer() ? (G.settings.side === 'second' ? 1 : 0) : s.turn; }
  function isHuman(p) { return G.human(p); }

  // ── the picture ──
  // The side whose home is at the bottom right: white, unless the person plays black.
  function wantPortrait() { return !!(root.matchMedia && root.matchMedia('(max-width: 640px) and (max-aspect-ratio: 19/20)').matches); }
  function setLayout() {
    portrait = wantPortrait();
    if (portrait) { PW = 45; GAP = 40; HALF = 164; MID = 44; TM = 4; CR = 16; U0 = TM; U = 2 * TM + 12 * PW + GAP; V = 2 * HALF + MID + 2 * TM; }
    else { PW = 34; GAP = 32; HALF = 150; MID = 46; TM = 8; CR = 14.5; U0 = G.settings.cube ? 40 : 10; U = U0 + 12 * PW + GAP + TRAY + 2 * TM + 4; V = 2 * HALF + MID + 2 * TM; }
  }
  // A place in the board's own axes on the screen, and a rectangle of them (u, v is its corner).
  function xy(u, v) { return portrait ? [v, u] : [u, v]; }
  function rectUV(u, v, du, dv, cls, extra) {
    var a = xy(u, v), b = xy(u + du, v + dv);
    return '<rect x="' + Math.min(a[0], b[0]) + '" y="' + Math.min(a[1], b[1]) + '" width="' + Math.abs(b[0] - a[0]) + '" height="' + Math.abs(b[1] - a[1]) + '" class="' + cls + '"' + (extra || '') + '/>';
  }
  function boxUV(u, v, du, dv) { var c = xy(u + du / 2, v + dv / 2); return { x: c[0], y: c[1], w: portrait ? dv : du, h: portrait ? du : dv }; }
  function bottomPlayer() { return flipped ? 1 : 0; }
  function colU(col) { return U0 + (col < 6 ? col * PW : 6 * PW + GAP + (col - 6) * PW); }
  // Where point idx sits: top or bottom row (the left or right side upright), column 0..11 along u. The board is seen from the
  // side of the person playing: their home is always the bottom right, or the bottom of the right-hand side upright.
  function slot(idx) {
    var top = idx >= 12, col = top ? idx - 12 : 11 - idx;
    return { top: flipped ? !top : top, col: col };
  }
  function pointV(top) { return top ? TM : V - TM - HALF; }
  function barU() { return U0 + 6 * PW; }
  // Where the person to move bears off: the end of the board in a wide view, an end of the middle channel upright.
  function trayBox(mine) {
    if (portrait) return { u: mine ? U - TM - TRL : TM, v: (V - MID) / 2, du: TRL, dv: MID };
    return { u: U - TM - TRAY, v: mine ? V - TM - HALF : TM, du: TRAY, dv: HALF };
  }
  function buildBoard() {
    var tri = '', num = '', i;
    setLayout();
    host.classList.toggle('bk-portrait', portrait);
    var W = portrait ? V : U, H = portrait ? U : V;
    for (i = 0; i < 24; i++) {
      var sl = slot(i), u = colU(sl.col), dark = (sl.col + (sl.top ? 1 : 0)) % 2 === 0, v0 = sl.top ? TM : V - TM, v1 = sl.top ? TM + HALF - 8 : V - TM - HALF + 8;
      var tipV = sl.top ? TM + HALF - 20 : V - TM - HALF + 20, tc = xy(u + PW / 2, tipV);
      num += '<text x="' + tc[0] + '" y="' + (tc[1] + 4) + '" text-anchor="middle" class="bk-pn">' + (i + 1) + '</text>';
      tri += '<polygon points="' + [xy(u, v0), xy(u + PW, v0), xy(u + PW / 2, v1)].join(' ') + '" class="bk-tri ' + (dark ? 'a' : 'b') + '"/>';
    }
    host.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">' + WK.STONE_DEFS + '<rect width="' + W + '" height="' + H + '" rx="12" class="bk-frame"/>' +
      rectUV(U0, TM, 12 * PW + GAP, V - 2 * TM, 'bk-felt') + tri + num + rectUV(barU(), TM, GAP, V - 2 * TM, 'bk-bar') + '<g id="bk-marks"></g><g id="bk-checkers"></g><g id="bk-extra"></g></svg>';
    host.style.setProperty('--ratio', (W / H).toFixed(3));
    gLayer = { marks: host.querySelector('#bk-marks'), checkers: host.querySelector('#bk-checkers'), extra: host.querySelector('#bk-extra') };
    var pts = [], ids = [];
    for (i = 0; i < 24; i++) { var s2 = slot(i); pts.push(boxUV(colU(s2.col), pointV(s2.top), PW, HALF)); ids.push('p' + i); }
    pts.push(boxUV(barU(), TM + 3, GAP, V - 2 * TM - 6)); ids.push('bar');
    pts.push(boxUV.apply(null, boxArgs(trayBox(true)))); ids.push('off');
    var raw = WK.overlay(host, W, H, pts, function (k) { onSpot(ids[k]); }, 'bk-pt');
    btns = {}; raw.forEach(function (b, k) { btns[ids[k]] = b; });
  }
  function boxArgs(b) { return [b.u, b.v, b.du, b.dv]; }
  function checkerSvg(x, y, p, extra) {
    return '<circle cx="' + x + '" cy="' + (y + 1.5) + '" r="' + CR + '" class="bk-shadow"/><circle cx="' + x + '" cy="' + y + '" r="' + CR + '" fill="url(#wk-stone-' + (p === 0 ? 'w' : 'b') + ')" class="bk-ck' + (extra || '') + '"/>' +
      '<circle cx="' + x + '" cy="' + y + '" r="' + (CR - 5) + '" class="bk-ring ' + (p === 0 ? 'on-w' : 'on-b') + '"/>';
  }
  function checkerUV(u, v, p, extra) { var c = xy(u, v); return checkerSvg(c[0], c[1], p, extra); }
  function stackSvg(u, baseV, dir, n, p, selected) {
    var step = n <= 5 ? CR * 2 : (HALF - 14 - CR * 2) / (n - 1), out = '';
    for (var k = 0; k < n; k++) out += checkerUV(u, baseV + dir * (CR + k * step), p, selected && k === n - 1 ? ' sel' : '');
    if (n > 5) { var c = xy(u, baseV + dir * (CR + (n - 1) * step)); out += '<text x="' + c[0] + '" y="' + (c[1] + 4.5) + '" text-anchor="middle" class="bk-n ' + (p === 0 ? 'on-w' : 'on-b') + '">' + n + '</text>'; }
    return out;
  }
  function dieSvg(x, y, v, used, size) {
    var r = size / 2, pips = { 1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]], 4: [[-1, -1], [1, -1], [-1, 1], [1, 1]], 5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], 6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]] }[v];
    var out = '<g class="bk-die' + (used ? ' used' : '') + '"><rect x="' + (x - r) + '" y="' + (y - r) + '" width="' + size + '" height="' + size + '" rx="6" class="bk-die-face"/>';
    pips.forEach(function (q) { out += '<circle cx="' + (x + q[0] * size * 0.25) + '" cy="' + (y + q[1] * size * 0.25) + '" r="' + (size * 0.075) + '" class="bk-pip"/>'; });
    return out + '</g>';
  }

  function paint() {
    var ck = '', mk = '', ex = '', i, p, W = portrait ? V : U, H = portrait ? U : V;
    for (i = 0; i < 24; i++) {
      var v = s.pts[i]; if (!v) continue;
      p = v > 0 ? 0 : 1; var n = Math.abs(v), sl = slot(i);
      ck += stackSvg(colU(sl.col) + PW / 2, sl.top ? TM : V - TM, sl.top ? 1 : -1, n, p, sel === relOf(s.turn, i) && p === s.turn && sel > 0 && sel < BAR);
    }
    // the bar: hit checkers wait in the middle, each side's toward its own end
    var bu = barU() + GAP / 2, barGap = portrait ? 30 : 34, barStep = portrait ? 26 : 20;
    for (p = 0; p < 2; p++) {
      var topSide = p !== bottomPlayer();
      for (var k = 0; k < s.bar[p]; k++) ck += checkerUV(bu, V / 2 + (topSide ? -1 : 1) * (barGap + k * barStep), p, sel === BAR && p === s.turn && k === s.bar[p] - 1 ? ' sel' : '');
    }
    // the trays: checkers borne off lie flat, the person's at the bottom right (upright: an end of the middle channel)
    for (p = 0; p < 2; p++) {
      var mineTray = p === bottomPlayer(), tb = trayBox(mineTray);
      for (var o = 0; o < s.off[p]; o++) {
        if (portrait) ex += rectUV(mineTray ? tb.u + tb.du - 10 - o * 4.6 : tb.u + 4 + o * 4.6, V / 2 - 14, 6, 28, 'bk-off ' + (p === 0 ? 'w' : 'b'), ' rx="2"');
        else ex += rectUV(tb.u + 6, mineTray ? V - TM - 10 - o * 8 : TM + 3 + o * 8, TRAY - 12, 6, 'bk-off ' + (p === 0 ? 'w' : 'b'), ' rx="2"');
      }
      ex += portrait ? rectUV(tb.u, tb.v, tb.du, tb.dv, 'bk-tray', ' rx="6"') : '';
    }
    if (!portrait) ex += rectUV(U - TM - TRAY, TM, TRAY, V - 2 * TM, 'bk-tray', ' rx="6"');
    // dice live in the middle strip: to the right of the bar, or below it upright
    var shown = dieShown.length ? dieShown : [];
    shown.forEach(function (d, k) {
      var c = portrait ? xy(barU() + GAP + 24 + k * 36, V / 2) : xy(U0 + 6 * PW + GAP + 3 * PW + (k - (shown.length - 1) / 2) * 36, V / 2);
      ex += dieSvg(c[0], c[1], d.v, d.used, portrait ? 32 : 30);
    });
    // the cube
    if (G.settings.cube) {
      var cu = portrait ? (s.cube.owner < 0 ? barU() - 30 : s.cube.owner === bottomPlayer() ? U - TM - TRL - 22 : TM + TRL + 22) : U0 / 2,
        cv = portrait ? V / 2 : s.cube.owner < 0 ? V / 2 : s.cube.owner === bottomPlayer() ? V - TM - 26 : TM + 26, cc = xy(cu, cv);
      ex += '<g class="bk-cube"><rect x="' + (cc[0] - 14) + '" y="' + (cc[1] - 14) + '" width="28" height="28" rx="5"/><text x="' + cc[0] + '" y="' + (cc[1] + 6) + '" text-anchor="middle">' + (s.cube.value === 1 ? 64 : s.cube.value) + '</text></g>';
    }
    // marks: the last play, the selection and where it may go, the hint
    lastFrom.concat(lastTo).forEach(function (i2) { mk += pointMark(i2, 'bk-last'); });
    var steps = humanTurnLive() ? legalSteps(s) : [];
    if (sel >= 0) steps.filter(function (st) { return st.from === sel; }).forEach(function (st) { mk += st.to === 0 ? '' : pointMark(idxOf(s.turn, st.to), 'bk-target'); });
    if (hintStep) mk += (hintStep.from < BAR ? pointMark(idxOf(s.turn, hintStep.from), 'bk-hint') : '') + (hintStep.to ? pointMark(idxOf(s.turn, hintStep.to), 'bk-hint') : '');
    // the tray lights up when the selected checker can be borne off; its button sits at the mover's end
    var ob = trayBox(s.turn === bottomPlayer()), obx = boxUV(ob.u, ob.v, ob.du, ob.dv);
    if (sel > 0 && steps.some(function (st) { return st.from === sel && st.to === 0; })) mk += rectUV(ob.u, ob.v, ob.du, ob.dv, 'bk-target', ' rx="6"');
    btns.off.style.left = ((obx.x - obx.w / 2) / W * 100) + '%'; btns.off.style.top = ((obx.y - obx.h / 2) / H * 100) + '%';
    btns.off.style.width = (obx.w / W * 100) + '%'; btns.off.style.height = (obx.h / H * 100) + '%';
    gLayer.checkers.innerHTML = ck; gLayer.marks.innerHTML = mk; gLayer.extra.innerHTML = ex;
    // buttons
    var froms = {}, tos = {};
    steps.forEach(function (st) { froms[st.from] = 1; if (sel >= 0 && st.from === sel) tos[st.to] = 1; });
    Object.keys(btns).forEach(function (id) {
      var ok = false, label = '';
      if (id === 'bar') { ok = !!froms[BAR]; label = T('backgammon.bar', { white: s.bar[0], black: s.bar[1] }); }
      else if (id === 'off') { ok = !!tos[0]; label = T('backgammon.off'); }
      else {
        var idx = +id.slice(1), r = relOf(s.turn, idx);
        ok = !!froms[r] || !!tos[r]; var c = s.pts[idx];
        label = c ? T(c > 0 ? 'backgammon.point.white' : 'backgammon.point.black', { point: idx + 1, n: Math.abs(c) }) : T('backgammon.point.empty', { point: idx + 1 });
      }
      btns[id].setAttribute('aria-disabled', ok ? 'false' : 'true'); btns[id].setAttribute('aria-label', label);
    });
    score(G.names(sideName(0), sideName(1)), [T('backgammon.pts', { n: session[0] }), T('backgammon.pts', { n: session[1] })], G.over ? -1 : s.turn);
    var canRoll = humanTurnIdle(), canDouble = G.settings.cube && canRoll && (s.cube.owner < 0 || s.cube.owner === s.turn) && s.cube.value < 64;
    rollBtn.hidden = !canRoll; doubleBtn.hidden = !canDouble; takeBtn.hidden = dropBtn.hidden = !offer;
    G.setUndo(turnStart && s.rolled && countSteps() > 0 && !G.thinking && !rolling); G.setHint(humanTurnLive());
  }
  function countSteps() { return turnStart ? turnStart.dice.length - s.dice.length : 0; }
  function pointMark(idx, cls) {
    var sl = slot(idx);
    return rectUV(colU(sl.col), pointV(sl.top), PW, HALF, cls);
  }
  function humanTurnLive() { return !G.over && !G.thinking && !rolling && !offer && s.rolled && isHuman(s.turn) && s.dice.length > 0; }
  function humanTurnIdle() { return !G.over && !G.thinking && !rolling && !offer && !s.rolled && isHuman(s.turn); }

  // ── the game ──
  function say(t, busy) { G.say(t, busy); }
  function turnText() {
    var p = s.turn;
    if (G.watching || !G.vsComputer()) return T(s.rolled ? 'board.toMove' : 'backgammon.toRoll', { name: sideName(p) });
    if (!isHuman(p)) return T('backgammon.computerPlaying');
    return T(s.rolled ? 'backgammon.tapChecker' : 'backgammon.rollDice');
  }
  // The roll in words: "5 and 1", or "double 3s" when the same number came up twice.
  function diceWords(list) {
    var a = list[0], b = list[1];
    return a === b ? T('backgammon.doubleRoll', { n: a }) : a + ' ' + T('backgammon.and') + ' ' + b;
  }
  function setDice(list, usedList) {
    dieShown = list.map(function (v, k) { return { v: v, used: !!(usedList && usedList[k]) }; });
  }
  function syncDice() {
    // show the rolled dice, greying the ones already played
    var left = s.dice.slice(0);
    dieShown = rolledDice.map(function (v) { var i = left.indexOf(v); if (i >= 0) { left.splice(i, 1); return { v: v, used: false }; } return { v: v, used: true }; });
  }
  var rolledDice = [];

  function rnd6() { return 1 + ((Math.random() * 6) | 0); }
  var playing = false;   // a die was thrown: a fresh game is not kept
  function doRoll(forced) {
    playing = true;    var a = rnd6(), b = rnd6();
    if (forced) { while (a === b) b = rnd6(); }
    rolledDice = a === b ? [a, a, a, a] : [Math.max(a, b), Math.min(a, b)];
    s.dice = rolledDice.slice(0); s.rolled = true; syncDice();
    if (isHuman(s.turn) || !G.vsComputer()) { lastFrom = []; lastTo = []; }
  }
  var rollGen = 0;   // a restored game must not hear from the roll the page started before it
  function animateRoll(done) {
    var mine = rollGen;
    if (BK.reducedMotion()) { done(); return; }
    rolling = true; var t = 0;
    (function spin() {
      if (mine !== rollGen) return;
      if (t++ >= 6) { rolling = false; done(); return; }
      setDice([rnd6(), rnd6()]); paint(); setTimeout(spin, 70);
    })();
  }

  function newGame() {
    playing = false;
    flipped = G.vsComputer() && G.settings.side === 'second';
    buildBoard();
    s = startPosition(); turnStart = null; sel = -1; lastFrom = []; lastTo = []; hintStep = null; offer = false; dieShown = []; rolledDice = []; rolling = false;
    s.cube = { value: 1, owner: -1 };
    // the opening roll decides who starts and is played by that side
    s.turn = Math.random() < 0.5 ? 0 : 1;
    var open = true;
    paint(); say(T(G.vsComputer() && !G.watching ? (isHuman(s.turn) ? 'backgammon.open.you' : 'backgammon.open.computer') : 'backgammon.open.side', { name: sideName(s.turn) }), false);
    animateRoll(function () { doRoll(true); turnStart = copyState(s); afterRoll(open); });
  }
  function copyState(x) { return copy(x); }

  // After dice are on the table: the computer plays, or the person is waiting to move (forced moves play themselves).
  function afterRoll(opening) {
    var steps = legalSteps(s);
    if (!steps.length) {
      var dice = diceWords(rolledDice);
      paint(); say(T(dice ? 'backgammon.noMoveDice' : 'backgammon.noMove', { name: whoName(s.turn), dice: dice }), false);
      G.later(passTurn, 1300); return;
    }
    if (!isHuman(s.turn)) { paint(); say(T(G.watching ? 'backgammon.rolled' : 'backgammon.computerRolled', { name: sideName(s.turn), dice: diceWords(rolledDice) }), !G.watching); computerPlay(); return; }
    paint(); say(turnText());
    if (G.settings.auto && steps.length === 1) G.later(function () { doStep(steps[0]); }, 450);
  }
  function passTurn() {
    s = endTurn(s); turnStart = null; sel = -1; rolledDice = []; dieShown = [];
    beginTurn();
  }
  // The next side is to roll (the cube may be offered first).
  function beginTurn() {
    paint();
    if (isHuman(s.turn)) {
      say(turnText());
      return;
    }
    say(G.watching ? T('backgammon.toRoll', { name: sideName(s.turn) }) : T('backgammon.computerRolling'), !G.watching);
    // the computer may double before it rolls
    if (G.settings.cube && (s.cube.owner < 0 || s.cube.owner === s.turn) && s.cube.value < 64 && G.settings.level !== 'easy' && winChance(s, s.turn) > 0.72 && hasContact(s)) {
      G.later(function () { offerDouble(s.turn); }, 600); return;
    }
    G.later(rollForComputer, 700);
  }
  function rollForComputer() {
    animateRoll(function () { doRoll(false); turnStart = copyState(s); afterRoll(false); });
  }
  rollBtn.addEventListener('click', function () {
    if (!humanTurnIdle()) return;
    hintStep = null;
    animateRoll(function () { doRoll(false); turnStart = copyState(s); afterRoll(false); });
  });

  // ── a person's steps ──
  function onSpot(id) {
    if (!humanTurnLive()) return;
    var steps = legalSteps(s), r = id === 'bar' ? BAR : id === 'off' ? 0 : relOf(s.turn, +id.slice(1));
    if (sel >= 0) {
      var cand = steps.filter(function (st) { return st.from === sel && st.to === r; });
      if (cand.length) {
        cand.sort(function (a, b) { return a.die - b.die; }); // the smallest die that does it
        doStep(cand[0]); return;
      }
    }
    if (r !== 0 && steps.some(function (st) { return st.from === r; })) {
      sel = sel === r ? -1 : r; hintStep = null; paint();
      say(sel > 0 ? T('backgammon.tapLit') : turnText());
      // a lone destination from this checker: nothing to choose, but a tap is still the move
      return;
    }
    sel = -1; paint(); G.refuse(btns[id], T('backgammon.cantMove'));
  }
  function doStep(st) {
    var p = s.turn;
    if (st.from < BAR) lastFrom.push(idxOf(p, st.from));
    if (st.to) lastTo.push(idxOf(p, st.to));
    s = applyStep(s, st); sel = -1; hintStep = null;
    syncDice();
    var msg = s.hit ? T(isHuman(p) || !G.vsComputer() ? 'backgammon.hit' : 'backgammon.hitYou') : '';
    var w = winner(s);
    if (w >= 0) { paint(); finishGame(w); return; }
    var steps = s.dice.length ? legalSteps(s) : [];
    if (!steps.length) { paint(); say(s.dice.length ? (msg ? UI.noted(msg, T('backgammon.noMore')) : T('backgammon.noMore')) : msg); G.later(endMyTurn, s.dice.length ? 900 : 500); return; }
    paint(); say(msg ? UI.noted(msg, turnText()) : turnText());
    if (G.settings.auto && steps.length === 1) G.later(function () { doStep(steps[0]); }, 450);
  }
  function endMyTurn() {
    passTurn();
  }

  function undo() {
    if (!turnStart || !s.rolled || G.thinking) return;
    G.cancel();
    s = copyState(turnStart); sel = -1; hintStep = null; lastFrom = []; lastTo = [];
    syncDice(); paint(); say(turnText());
  }

  // ── the computer's play, a step at a time so it can be followed ──
  function computerPlay() {
    var steps = chooseTurn(s, G.settings.level), ctl = G.watching;
    if (!ctl) { playSteps(steps); return; }
    // Watch and learn: say what the turn does, then play it when the driver says.
    var why = root.ZimiExplain.backgammon(root.BackgammonEngine, s, steps, rolledDice);
    ctl.offer(why.text, function () { if (G.watching === ctl && !G.over) playSteps(steps); });
  }
  function playSteps(steps) {
    var token = G.begin();
    lastFrom = []; lastTo = []; var hits = 0, k = 0;
    function next() {
      if (token !== G.thinking) return;
      if (k >= steps.length) {
        G.done(token);
        var w = winner(s);
        if (w >= 0) { finishGame(w); return; }
        G.later(function () { var note = T(hits ? 'backgammon.playedHit' : 'backgammon.played', { dice: diceWords(rolledDice) }); passTurn(); if (isHuman(s.turn) && !G.watching) say(note); }, 450);
        return;
      }
      var st = steps[k++], who = s.turn;
      if (st.from < BAR) lastFrom.push(idxOf(who, st.from));
      if (st.to) lastTo.push(idxOf(who, st.to));
      s = applyStep(s, st); if (s.hit) hits++;
      syncDice(); paint();
      // Say what this step did, so the play can be followed one checker at a time.
      var said = T(st.from === BAR ? 'backgammon.c.enter' : st.to ? 'backgammon.c.move' : 'backgammon.c.off', { from: idxOf(who, st.from) + 1, to: st.to ? idxOf(who, st.to) + 1 : 0 });
      say(s.hit ? UI.noted(said, T('backgammon.hit')) : said, true);
      setTimeout(next, BK.reducedMotion() ? 120 : 800);
    }
    setTimeout(next, BK.reducedMotion() ? 0 : 600);   // the roll is read before the first checker moves
  }

  // ── the cube ──
  doubleBtn.addEventListener('click', function () { if (humanTurnIdle()) offerDouble(s.turn); });
  function offerDouble(p) {
    offer = { by: p }; paint();
    if (G.vsComputer() && isHuman(p)) {
      say(T('backgammon.youDouble', { n: s.cube.value * 2 }), true);
      G.later(function () {
        var take = winChance(s, 1 - p) >= (G.settings.level === 'hard' ? 0.27 : 0.2);
        answerDouble(take);
      }, 900);
    } else if (G.vsComputer()) say(T('backgammon.computerDoubles', { n: s.cube.value * 2 }));
    else say(T('backgammon.doubles', { name: sideName(p), n: s.cube.value * 2, other: sideName(1 - p) }));
  }
  function answerDouble(take) {
    var p = offer.by; offer = false;
    if (take) {
      s.cube = { value: s.cube.value * 2, owner: 1 - p };
      paint(); say(T('backgammon.taken', { n: s.cube.value }));
      if (isHuman(p)) { say(T('backgammon.takenRoll', { n: s.cube.value })); paint(); }
      else G.later(rollForComputer, 700);
    } else {
      var pts = s.cube.value; session[p] += pts; paint();
      var msg = T(G.vsComputer() ? (isHuman(p) ? 'backgammon.dropComputer' : 'backgammon.dropYou') : 'backgammon.drop', { n: pts });
      G.finish(msg, G.vsComputer() ? (isHuman(p) ? 'w' : 'l') : null, sideName(p));
    }
  }
  takeBtn.addEventListener('click', function () { if (offer) answerDouble(true); });
  dropBtn.addEventListener('click', function () { if (offer) answerDouble(false); });

  function finishGame(w) {
    var o = outcome(s, w); session[w] += o.points; paint();
    G.finish(T(o.kind === 'single' ? 'backgammon.win.single' : 'backgammon.win.' + o.kind, { n: o.points }), G.vsComputer() ? (isHuman(w) ? 'w' : 'l') : null, sideName(w));
  }

  function hint() {
    var steps = chooseTurn(s, 'hard');
    if (!steps.length) return;
    // the first step of the best play that is legal now
    var legal = legalSteps(s), pick = steps.filter(function (st) { return legal.some(function (l) { return l.from === st.from && l.to === st.to; }); })[0] || steps[0];
    hintStep = pick; sel = -1; paint(); say(T(pick.from === BAR ? (pick.to ? 'backgammon.hint.barTo' : 'backgammon.hint.barOff') : (pick.to ? 'backgammon.hint.pointTo' : 'backgammon.hint.pointOff'), { from: idxOf(s.turn, pick.from) + 1, to: pick.to ? idxOf(s.turn, pick.to) + 1 : 0 }));
  }

  G.registerWatch({
    script: 'explain-backgammon.js', unit: 'turn', level: 'medium', override: { cube: false },
    intro: 'backgammon.watch.intro',
    whoseTurn: function () { return s.turn; },
    busy: function () { return rolling || !!G.thinking; },
    resume: function () { paint(); say(turnText()); }
  });
  if (root.ZimiShell) root.ZimiShell.game({ hints: true, inProgress: function () { return !G.over && !!turnStart; } });

  // Turning the phone, or resizing the window, redraws the board in the layout that fits.
  root.addEventListener('resize', function () { if (s && wantPortrait() !== portrait) { buildBoard(); paint(); } });

  G.newGame();
  G.persist({
    save: function () { return playing ? { s: s, turnStart: turnStart, rolledDice: rolledDice, session: session, flipped: flipped, offer: offer } : null; },
    load: function (d) {
      rollGen++; flipped = !!d.flipped; buildBoard();
      s = d.s; turnStart = d.turnStart; rolledDice = d.rolledDice || []; session = d.session; offer = d.offer || false;
      sel = -1; hintStep = null; lastFrom = []; lastTo = []; rolling = false; dieShown = []; playing = true;
      if (rolledDice.length) syncDice();
      paint();
    },
    resume: function () {
      if (offer) { var by = offer.by; offer = false; offerDouble(by); }
      else if (s.rolled) afterRoll(false);
      else beginTurn();
    }
  });
  if (new URLSearchParams(location.search).has('debug')) root.__bk = { state: function () { return s; }, engine: root.BackgammonEngine, session: function () { return session; } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
