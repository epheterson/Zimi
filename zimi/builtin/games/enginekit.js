/* ZimiGames: what the engine-backed board games share. Our own code, GPL-3.0. No network, no modules.
   ZimiSearch is one self-contained function (so a Web Worker can be built from its source): a
   negamax alpha-beta searcher with iterative deepening, a time limit and a little noise at the
   root for the gentler levels. A game hands it an adapter:
     moves(pos) -> the legal moves (any values)      make(pos, m), unmake(pos)
     evaluate(pos) -> score for the side to move     order(pos, m) -> number, higher is tried first (optional)
     terminal(pos, ply) -> a score or null (draws, decided games) (optional)
     extend(pos) -> true to search one ply deeper (a forced capture, a check) (optional)
     noMoves(pos, ply) -> the score when there is no legal move (optional, default a loss)
   EngineKit.client runs a game's engine in a Worker from a Blob and falls back to the main thread. */
function ZimiSearch() {
  'use strict';
  var MATE = 30000, INF = 32000, MAX_PLY = 64, CHECK_TIME_EVERY = 255;
  function Timeout() { this.name = 'Timeout'; }

  function search(a, pos, opts) {
    var maxDepth = opts.depth || 4, deadline = Date.now() + (opts.ms || 1000), noise = opts.noise || 0, rnd = opts.rng || Math.random;
    var nodes = 0, killers = [];
    function order(list, ply, first) {
      if (!a.order) return list;
      var sc = list.map(function (m, i) { return { m: m, s: (m === first ? 1e9 : a.order(pos, m)) + (killers[ply] === m ? 5e4 : 0), i: i }; });
      sc.sort(function (x, y) { return y.s - x.s || x.i - y.i; });
      return sc.map(function (x) { return x.m; });
    }
    function negamax(depth, alpha, beta, ply) {
      if ((++nodes & CHECK_TIME_EVERY) === 0 && Date.now() > deadline) throw new Timeout();
      var t = a.terminal ? a.terminal(pos, ply) : null;
      if (t !== null && t !== undefined) return t;
      var list = a.moves(pos);
      if (!list.length) return a.noMoves ? a.noMoves(pos, ply) : -MATE + ply;
      if (a.extend && ply < MAX_PLY && depth <= 1 && a.extend(pos)) depth++;
      if (depth <= 0) return a.evaluate(pos);
      list = order(list, ply);
      var best = -INF;
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        a.make(pos, m);
        var s;
        try { s = -negamax(depth - 1, -beta, -alpha, ply + 1); } finally { a.unmake(pos); }
        if (s > best) best = s;
        if (s > alpha) alpha = s;
        if (alpha >= beta) { killers[ply] = m; break; }
      }
      return best;
    }
    var roots = a.moves(pos);
    if (!roots.length) return { move: null, score: 0, depth: 0 };
    if (roots.length === 1) return { move: roots[0], score: 0, depth: 0 };
    var best = roots[0], bestScore = 0, reached = 0;
    for (var depth = 1; depth <= maxDepth; depth++) {
      var iterBest = null, iterScore = -INF, alpha = -INF, noisy = -INF;
      roots = order(roots, 0, best);
      try {
        for (var i = 0; i < roots.length; i++) {
          a.make(pos, roots[i]);
          var s;
          // With noise every root move gets a full window, so every score is exact and can be jittered fairly.
          try { s = -negamax(depth - 1, -INF, noise ? INF : -alpha, 1); } finally { a.unmake(pos); }
          if (s > iterScore) { iterScore = s; if (!noise) iterBest = roots[i]; }
          if (noise) { var j = s + (rnd() - 0.5) * 2 * noise; if (j > noisy) { noisy = j; iterBest = roots[i]; } }
          if (s > alpha) alpha = s;
        }
        best = iterBest; bestScore = iterScore; reached = depth;
      } catch (e) {
        if (!(e instanceof Timeout)) throw e;
        break;
      }
      if (Math.abs(bestScore) > MATE - MAX_PLY) break;
    }
    return { move: best, score: bestScore, depth: reached, nodes: nodes };
  }
  // The searcher of the chess family (Chess, Shogi, Xiangqi): pseudo-legal moves filtered by whether the mover's king is left
  // attacked, a check searched one ply deeper, a quiescence search over captures, killers and a history table for the order.
  // A move is a small integer (below cfg.space). The adapter, on top of make/unmake/evaluate/key/inCheck/moves:
  //   pseudo(pos, capturesOnly) -> moves          exposed(pos, us) -> true when `us` left its king attacked
  //   rank(pos, m) -> the order score of a capture or promotion, 0 for a quiet move     quiet(pos, m) -> true for a move that earns killers
  //   histIdx(m, us) -> a slot in the history table     noMoves(pos, ply) -> the score with no legal move
  //   kingTaken(pos, m) -> true when a capture takes the king (optional)     draw(pos) -> true for a drawn node (optional)
  //   cfg: { space, checkEvery, qPlies, killers: [first, second], history: table size, repeat: times seen that is a draw,
  //          standAtLimit: the quiescence returns the stand-pat when its plies run out (else alpha), drawAtLeaf: draw() holds at
  //          the horizon too, checkLimit: the ply from which a check stops deepening }
  // opts: { depth, ms, noise, seen, rng }. `pos` is left mid-search when the clock runs out, so give it a copy.
  function tactical(a, pos, opts) {
    var cfg = a.cfg, space = cfg.space, HASH = 1000000;
    var maxDepth = opts.depth || 4, noise = opts.noise || 0, rnd = opts.rng || Math.random, seen = opts.seen || {};
    var nodes = 0, deadline = Date.now() + (opts.ms || 1000), killers = new Int32Array(MAX_PLY * 2 + 4), history = new Int32Array(cfg.history);
    function tick() { if ((++nodes & cfg.checkEvery) === 0 && Date.now() > deadline) throw new Timeout(); }
    function order(list, ply, hash) {
      var keys = new Array(list.length), us = pos.turn, i;
      for (i = 0; i < list.length; i++) {
        var m = list[i], sc = m === hash ? HASH : a.rank(pos, m);
        if (!sc) sc = m === killers[ply * 2] ? cfg.killers[0] : m === killers[ply * 2 + 1] ? cfg.killers[1] : history[a.histIdx(m, us)] | 0;
        keys[i] = sc * space + m;
      }
      keys.sort(function (x, y) { return y - x; });
      for (i = 0; i < list.length; i++) list[i] = keys[i] % space;
    }
    function quiesce(alpha, beta, plies) {
      tick();
      var stand = a.evaluate(pos);
      if (stand >= beta || (plies <= 0 && cfg.standAtLimit)) return stand;
      if (stand > alpha) alpha = stand;
      if (plies <= 0) return alpha;
      var list = a.pseudo(pos, true), us = pos.turn;
      order(list, 0, 0);
      for (var i = 0; i < list.length; i++) {
        if (a.kingTaken && a.kingTaken(pos, list[i])) return MATE;
        a.make(pos, list[i]);
        if (a.exposed(pos, us)) { a.unmake(pos); continue; }
        var s = -quiesce(-beta, -alpha, plies - 1);
        a.unmake(pos);
        if (s >= beta) return s;
        if (s > alpha) alpha = s;
      }
      return alpha;
    }
    function negamax(depth, alpha, beta, ply) {
      tick();
      if (a.draw && cfg.drawAtLeaf && a.draw(pos)) return 0;
      var us = pos.turn;
      if (a.inCheck(pos, us) && ply < cfg.checkLimit) depth++;
      if (depth <= 0) return quiesce(alpha, beta, cfg.qPlies);
      if (a.draw && !cfg.drawAtLeaf && a.draw(pos)) return 0;
      var list = a.pseudo(pos, false), best = -INF, legal = 0;
      order(list, ply, 0);
      for (var i = 0; i < list.length; i++) {
        var m = list[i], quiet = a.quiet(pos, m);
        a.make(pos, m);
        if (a.exposed(pos, us)) { a.unmake(pos); continue; }
        legal++;
        var s = -negamax(depth - 1, -beta, -alpha, ply + 1);
        a.unmake(pos);
        if (s > best) best = s;
        if (s > alpha) alpha = s;
        if (alpha >= beta) {
          if (quiet) {
            if (killers[ply * 2] !== m) { killers[ply * 2 + 1] = killers[ply * 2]; killers[ply * 2] = m; }
            history[a.histIdx(m, us)] += depth * depth;
          }
          break;
        }
      }
      return legal ? best : a.noMoves(pos, ply);
    }
    var roots = a.moves(pos);
    if (!roots.length) return { move: 0, score: 0, depth: 0 };
    if (roots.length === 1) return { move: roots[0], score: 0, depth: 0 };
    var best = roots[0], bestScore = 0, reached = 0, scores = null;
    for (var depth = 1; depth <= maxDepth; depth++) {
      order(roots, 0, best);
      var cur = {}, iterBest = 0, iterScore = -INF, alpha = -INF;
      try {
        for (var i = 0; i < roots.length; i++) {
          var m = roots[i], s;
          a.make(pos, m);
          if (seen[a.key(pos)] >= cfg.repeat) s = 0;
          else s = -negamax(depth - 1, -INF, noise ? INF : -alpha, 1);
          a.unmake(pos);
          cur[m] = s;
          if (s > iterScore) { iterScore = s; iterBest = m; }
          if (s > alpha) alpha = s;
        }
        best = iterBest; bestScore = iterScore; reached = depth; scores = cur;
      } catch (e) {
        if (!(e instanceof Timeout)) throw e;
        if (iterBest && depth > 1) { best = iterBest; bestScore = iterScore; }   // the previous best was searched first, so this is no worse
        break;
      }
      if (Math.abs(bestScore) > MATE - MAX_PLY) break;
    }
    if (noise && scores) {
      var top = -INF;
      roots.forEach(function (mv) {
        if (scores[mv] === undefined) return;
        var n = scores[mv] + (rnd() - 0.5) * 2 * noise;
        if (n > top) { top = n; best = mv; bestScore = scores[mv]; }
      });
    }
    return { move: best, score: bestScore, depth: reached, nodes: nodes };
  }
  return { search: search, tactical: tactical, MATE: MATE };
}
if (typeof globalThis !== 'undefined') globalThis.ZimiSearch = ZimiSearch;

(function (root) {
  'use strict';
  var DEFAULT_FALLBACK_MS = 300, FALLBACK_DEPTH = 3, WORKER_GRACE_MS = 5000;
  // factory: a function (S, ...args) -> engine, where engine.handle(request) answers a request.
  // client(factory, fallbackMs, opts).ask(request, cb): cb(answer), or cb(null) if the engine failed. opts: { args: the
  // factory's other arguments (plain data), depth: the deepest the main thread searches when there is no Worker }.
  // The Worker's source is built from ZimiSearch and the factory, so there is no second file to fetch (it works from a ZIM
  // and from Kiwix).
  function client(factory, fallbackMs, opts) {
    var worker = null, failed = false, seq = 0, waiting = {}, engine = null, args = (opts && opts.args) || [], fallbackDepth = (opts && opts.depth) || FALLBACK_DEPTH;
    function here() { if (!engine) engine = factory.apply(null, [root.ZimiSearch()].concat(args)); return engine; }
    function start() {
      if (worker || failed) return;
      try {
        var src = 'var S=(' + root.ZimiSearch.toString() + ')();var E=(' + factory.toString() + ')(S' + args.map(function (a) { return ',' + JSON.stringify(a); }).join('') + ');' +
          'onmessage=function(e){var d=e.data,r;try{r=E.handle(d.req);}catch(x){r={error:String(x)};}postMessage({id:d.id,result:r});};';
        worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        worker.onmessage = function (e) { var cb = waiting[e.data.id]; delete waiting[e.data.id]; if (cb) cb(e.data.result); };
        worker.onerror = function (e) {
          if (e && e.preventDefault) e.preventDefault();
          failed = true; worker = null;
          var all = waiting; waiting = {};
          Object.keys(all).forEach(function (k) { all[k](null); });
        };
      } catch (e) { failed = true; worker = null; }
    }
    function main(req, cb) {
      var cap = fallbackMs || DEFAULT_FALLBACK_MS;
      var r = Object.assign({}, req, { ms: Math.min(req.ms || cap, cap), depth: Math.min(req.depth || fallbackDepth, fallbackDepth) });
      setTimeout(function () { var out = null; try { out = here().handle(r); } catch (e) { out = null; } cb(out); }, 30);
    }
    // budget (ms, optional): how long the answer should take; a worker that stays silent WORKER_GRACE_MS past it is given up on.
    function ask(req, cb, budget) {
      start();
      if (!worker) { main(req, cb); return; }
      var id = ++seq, dog = budget ? setTimeout(function () { if (waiting[id]) { delete waiting[id]; client.drop(); main(req, cb); } }, budget + WORKER_GRACE_MS) : 0;
      waiting[id] = function (r) { clearTimeout(dog); if (r === null || (r && r.error)) main(req, cb); else cb(r); };
      worker.postMessage({ id: id, req: req });
    }
    var client = { ask: ask, usingWorker: function () { return !!worker; }, local: here, drop: function () { failed = true; if (worker) worker.terminate(); worker = null; } };
    return client;
  }
  root.EngineKit = { client: client };
})(typeof globalThis !== 'undefined' ? globalThis : this);
