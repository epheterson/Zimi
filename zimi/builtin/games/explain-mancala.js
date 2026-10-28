/* ZimiGames: Watch and learn, Mancala (Oware and Kalah). One sentence per move from what the
   rules say sowing does: where the last seed lands, what is captured, an extra turn, a forced
   feed, and the best capture the other side would have next, before and after the move (each
   worked out by sowing it). Our own code, GPL-3.0.

     ZimiExplain.mancala(R, state, pit) -> { text, facts }

   R is the rule set (MancalaEngine.Oware or .Kalah), state the position, pit the pit sown. */
(function (root) {
  'use strict';
  var SIDE = ['South', 'North'];

  var T = function (key, vars) { return root.ZimiText ? root.ZimiText.T(key, vars) : key; };
  var seeds = function (n) { return T('explain.mancala.seeds', { n: n }); };
  var sideName = function (i) { return T('explain.side.' + SIDE[i].toLowerCase()); };

  // The most seeds the side to move could capture right now.
  function bestCapture(R, s) {
    var best = 0;
    R.moves(s).forEach(function (m) {
      var r = R.sow(s, m), took = r.captured.reduce(function (a, c) { return a + c.n; }, 0);
      if (took > best) best = took;
    });
    return best;
  }
  // The other side's best capture if it were its turn on this position.
  function threatOn(R, s, side) {
    var t = { pits: s.pits, score: s.score, turn: 1 - side, quiet: s.quiet, done: false };
    return bestCapture(R, t);
  }

  function mancalaExplain(R, s, p) {
    var me = s.turn, key = SIDE[me], who = sideName(me), them = sideName(1 - me);
    var perSide = R.stores ? 7 : 6, num = p - me * perSide + 1, n = s.pits[p];
    var res = R.sow(s, p), took = res.captured.reduce(function (a, c) { return a + c.n; }, 0);
    var feeding = R.seedsOn(s, 1 - me) === 0;
    var before = threatOn(R, s, me), after = res.state.done ? 0 : bestCapture(R, res.state);
    // after the move it is the other side's turn (unless an extra turn): their best capture is `after`
    var theirNext = res.extra ? threatOn(R, res.state, me) : after;
    var lastPit = res.path.length ? res.path[res.path.length - 1] : p;
    var facts = { side: key, pit: num, seeds: n, captured: took, extra: res.extra, grandSlam: res.grandSlam, feeding: feeding, threatBefore: before, threatAfter: theirNext, done: res.state.done };

    var end = T(res.state.done && !took ? 'explain.mancala.endDone' : 'explain.mancala.end');
    var v = { who: who, them: them, pit: num, seeds: seeds(n), end: end };
    var text;
    if (took) text = T('explain.mancala.captures', { who: who, them: them, pit: num, seeds: seeds(n), took: seeds(took) });
    else if (res.extra) text = T('explain.mancala.again', v);
    else if (res.grandSlam) text = T('explain.mancala.grandSlam', v);
    else if (feeding) text = T('explain.mancala.feeding', v);
    else if (before > 0 && theirNext < before) { v.before = seeds(before); v.after = theirNext ? seeds(theirNext) : ''; text = T(theirNext ? 'explain.mancala.cuts' : 'explain.mancala.cutsAll', v); }
    else if (before > 0 && theirNext >= before) { v.next = seeds(theirNext); text = T('explain.mancala.still', v); }
    else if (theirNext === 0) text = T('explain.mancala.safe', v);
    else { v.next = seeds(theirNext); text = T('explain.mancala.then', v); }
    return { text: text, facts: facts };
  }

  root.ZimiExplain = root.ZimiExplain || {};
  root.ZimiExplain.mancala = mancalaExplain;
  if (typeof module !== 'undefined' && module.exports) module.exports = mancalaExplain;
})(typeof globalThis !== 'undefined' ? globalThis : this);
