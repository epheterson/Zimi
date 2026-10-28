/* ZimiGames: FreeCell's hint solver. Our own code, GPL-3.0. A weighted best-first search over single-card moves,
   with the safe foundation moves played for free after each move, a heuristic of how much is left and how deeply the
   cards that are needed soon are buried, and duplicate positions folded (the order of the columns does not matter).
   It works on FreeCell's own state (freecell.js: piles c0..c7, fr0..fr3, fd0..fd3) and answers with moves in the same
   terms ({from, idx, to}), each legal by freecell.js's rules. Pure functions: node runs it for the tests. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards;
  var COLS = 8, CELLS = 4, MAX_NODES = 60000, W_H = 2;

  function rank(id) { return id % 13 + 1; }
  function suit(id) { return Math.floor(id / 13) % 4; }
  function red(id) { var s = suit(id); return s === 1 || s === 2; }
  // `lower` may sit on `upper`: opposite colours, one rank down (as ZimiCards.stacksOn)
  function stacks(upper, lower) { return red(upper) !== red(lower) && rank(lower) === rank(upper) - 1; }

  // The solver's own compact state: columns (arrays of ids), cells (a list of ids), found (a height per suit).
  function fromPiles(state) {
    var P = state.piles, cols = [], cells = [], found = [0, 0, 0, 0], i;
    for (i = 0; i < COLS; i++) cols.push(P['c' + i].slice());
    for (i = 0; i < CELLS; i++) if (P['fr' + i].length) cells.push(P['fr' + i][0]);
    for (i = 0; i < 4; i++) { var f = P['fd' + i]; if (f.length) found[suit(f[0])] = f.length; }
    return { cols: cols, cells: cells, found: found, ck: cols.map(colKey) };
  }
  // A column as a string (kept beside it and updated when it changes, so a position's key is cheap to build).
  function colKey(c) { var t = ''; for (var i = 0; i < c.length; i++) t += String.fromCharCode(c[i] + 40); return t; }
  function key(s) {
    return s.ck.slice().sort().join('|') + '#' + s.cells.slice().sort(function (a, b) { return a - b; }).join(',') + '#' + s.found.join(',');
  }
  function total(s) { return s.found[0] + s.found[1] + s.found[2] + s.found[3]; }

  // A card may go up for free when nothing left in play could still want it as a place to land (as freecell.js isSafe).
  function safe(s, id) {
    var r = rank(id);
    if (r <= 2) return true;
    var opp = red(id) ? [0, 3] : [1, 2];
    return s.found[opp[0]] >= r - 1 && s.found[opp[1]] >= r - 1;
  }

  // The heuristic: cards still to send up, broken runs in the columns, and cards needed soon that have others on top.
  function estimate(s) {
    var h = (52 - total(s)) * 4 + s.cells.length * 0.5, c, i;
    for (c = 0; c < COLS; c++) {
      var col = s.cols[c];
      for (i = 0; i < col.length; i++) {
        if (i > 0 && !stacks(col[i - 1], col[i])) h += 1;
        if (rank(col[i]) - s.found[suit(col[i])] <= 3) h += (col.length - 1 - i) * 1.5;
      }
    }
    return h;
  }

  // One move as {kind, from, to}: kinds are 'cf' (column to foundation), 'ef' (cell to foundation), 'cc', 'ec' (to a column), 'ce' (column to a cell).
  function apply(s, m) {
    var cols = s.cols.slice(), cells = s.cells.slice(), found = s.found.slice(), ck = s.ck.slice(), card;
    if (m.k === 'cf' || m.k === 'cc' || m.k === 'ce') { cols[m.from] = cols[m.from].slice(0, -1); ck[m.from] = s.ck[m.from].slice(0, -1); card = s.cols[m.from][s.cols[m.from].length - 1]; }
    else { card = cells[m.from]; cells.splice(m.from, 1); }
    if (m.k === 'cf' || m.k === 'ef') found[suit(card)]++;
    else if (m.k === 'cc' || m.k === 'ec') { cols[m.to] = cols[m.to].concat([card]); ck[m.to] = s.ck[m.to] + String.fromCharCode(card + 40); }
    else cells.push(card);
    return { cols: cols, cells: cells, found: found, ck: ck };
  }
  function moves(s) {
    var out = [], c, d, i, card, emptySeen = false;
    // to the foundation first
    for (c = 0; c < COLS; c++) { var col = s.cols[c]; if (col.length) { card = col[col.length - 1]; if (rank(card) === s.found[suit(card)] + 1) out.push({ k: 'cf', from: c, card: card }); } }
    for (i = 0; i < s.cells.length; i++) if (rank(s.cells[i]) === s.found[suit(s.cells[i])] + 1) out.push({ k: 'ef', from: i, card: s.cells[i] });
    // onto columns
    var emptyCol = -1;
    for (d = 0; d < COLS; d++) if (!s.cols[d].length && emptyCol < 0) emptyCol = d;
    for (c = 0; c < COLS; c++) {
      var src = s.cols[c];
      if (!src.length) continue;
      card = src[src.length - 1];
      for (d = 0; d < COLS; d++) {
        if (d === c || !s.cols[d].length) continue;
        if (stacks(s.cols[d][s.cols[d].length - 1], card)) out.push({ k: 'cc', from: c, to: d, card: card });
      }
      if (emptyCol >= 0 && src.length > 1) out.push({ k: 'cc', from: c, to: emptyCol, card: card });
      if (s.cells.length < CELLS) out.push({ k: 'ce', from: c, card: card });
    }
    for (i = 0; i < s.cells.length; i++) {
      card = s.cells[i];
      for (d = 0; d < COLS; d++) if (s.cols[d].length && stacks(s.cols[d][s.cols[d].length - 1], card)) out.push({ k: 'ec', from: i, to: d, card: card });
      if (emptyCol >= 0) out.push({ k: 'ec', from: i, to: emptyCol, card: card });
    }
    return out;
  }
  // Play every safe foundation move; returns the new state and the moves played.
  function settle(s) {
    var played = [], again = true;
    while (again) {
      again = false;
      for (var c = 0; c < COLS; c++) {
        var col = s.cols[c];
        if (!col.length) continue;
        var card = col[col.length - 1];
        if (rank(card) === s.found[suit(card)] + 1 && safe(s, card)) { var m = { k: 'cf', from: c, card: card }; s = apply(s, m); played.push(m); again = true; }
      }
      for (var i = 0; i < s.cells.length; i++) {
        var cc = s.cells[i];
        if (rank(cc) === s.found[suit(cc)] + 1 && safe(s, cc)) { var m2 = { k: 'ef', from: i, card: cc }; s = apply(s, m2); played.push(m2); again = true; break; }
      }
    }
    return { s: s, played: played };
  }

  // A binary min-heap on .p.
  function Heap() { this.a = []; }
  Heap.prototype.push = function (x) {
    var a = this.a, i = a.length; a.push(x);
    while (i > 0) { var p = (i - 1) >> 1; if (a[p].p <= a[i].p) break; var t = a[p]; a[p] = a[i]; a[i] = t; i = p; }
  };
  Heap.prototype.pop = function () {
    var a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      var i = 0, n = a.length;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m = i;
        if (l < n && a[l].p < a[m].p) m = l;
        if (r < n && a[r].p < a[m].p) m = r;
        if (m === i) break;
        var t = a[m]; a[m] = a[i]; a[i] = t; i = m;
      }
    }
    return top;
  };

  // Search for a winning line from `state`. Returns { moves: [{from, idx, to}], nodes } in freecell.js terms, or
  // { moves: null, nodes } when none was found within the node limit.
  function solve(state, opts) {
    var cap = (opts && opts.maxNodes) || MAX_NODES, deadline = opts && opts.maxMs ? Date.now() + opts.maxMs : 0;
    var start = settle(fromPiles(state)), heap = new Heap(), seen = {}, nodes = 0, best = null;
    heap.push({ s: start.s, g: 0, p: estimate(start.s), prev: null, steps: start.played });
    seen[key(start.s)] = 1;
    while (heap.a.length && nodes < cap) {
      var n = heap.pop();
      nodes++;
      if (deadline && (nodes & 255) === 0 && Date.now() > deadline) break;
      if (total(n.s) === 52) { best = n; break; }
      var ms = moves(n.s);
      for (var i = 0; i < ms.length; i++) {
        var step = apply(n.s, ms[i]), st = settle(step), k = key(st.s);
        if (seen[k]) continue;
        seen[k] = 1;
        var g = n.g + 1 + st.played.length;
        heap.push({ s: st.s, g: g, p: estimate(st.s) * W_H + g, prev: n, steps: [ms[i]].concat(st.played) });
      }
    }
    if (!best) return { moves: null, nodes: nodes };
    var chain = [];
    for (var b = best; b; b = b.prev) chain.unshift(b.steps);
    return { moves: toPileMoves(state, [].concat.apply([], chain)), nodes: nodes };
  }

  // Replays the solver's moves on the real state, naming the piles (and the foundation pile a card goes to).
  function toPileMoves(state, steps) {
    var P = JSON.parse(JSON.stringify(state.piles)), out = [];
    function foundationFor(card) {
      for (var i = 0; i < 4; i++) if (P['fd' + i].length && suit(P['fd' + i][0]) === suit(card)) return 'fd' + i;
      for (var j = 0; j < 4; j++) if (!P['fd' + j].length) return 'fd' + j;
      return null;
    }
    function emptyCell() { for (var i = 0; i < 4; i++) if (!P['fr' + i].length) return 'fr' + i; return null; }
    function cellOf(card) { for (var i = 0; i < 4; i++) if (P['fr' + i][0] === card) return 'fr' + i; return null; }
    // columns are matched by their position in the solver's state, which is the real column index
    steps.forEach(function (m) {
      var from, to, idx = 0;
      if (m.k === 'cf' || m.k === 'cc' || m.k === 'ce') { from = 'c' + m.from; idx = P[from].length - 1; } else { from = cellOf(m.card); }
      if (m.k === 'cf' || m.k === 'ef') to = foundationFor(m.card);
      else if (m.k === 'cc' || m.k === 'ec') to = 'c' + m.to;
      else to = emptyCell();
      out.push({ from: from, idx: idx, to: to });
      P[to].push(P[from].splice(idx, 1)[0]);
    });
    return out;
  }

  root.ZimiFreeCellSolver = { solve: solve, MAX_NODES: MAX_NODES };
})(typeof globalThis !== 'undefined' ? globalThis : window);
