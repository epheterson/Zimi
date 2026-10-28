/* ZimiGames: Watch and learn, Backgammon. One or two sentences for a whole turn, from facts
   found by playing the steps out on the position: hits, points made, checkers brought in from
   the bar, checkers borne off, a back checker running, and what is left exposed (the chance the
   other side hits it is counted over all 36 rolls, by searching their legal plays). Our own
   code, GPL-3.0.

     ZimiExplain.backgammon(E, state, steps, dice) -> { text, facts }

   E is BackgammonEngine (backgammon.js), state the position with the dice rolled, steps the play
   (each { from, to, die } in pip numbers, 25 is the bar and 0 is off), dice the two numbers rolled. */
(function (root) {
  'use strict';
  var NAMES = ['White', 'Black'], ROLLS = 36, BAR = 25, BACK_ZONE = 19;

  var T = function (key, vars) { return root.ZimiText ? root.ZimiText.T(key, vars) : key; };
  // "a and b and c": every item joined by the language's own "and", two at a time.
  function andChain(items) { return items.reduce(function (a, b) { return T('explain.list.and', { a: a, b: b }); }); }
  function spot(r) { return r === BAR ? T('explain.backgammon.spotBar') : r === 0 ? T('explain.backgammon.spotOff') : String(r); }

  // In how many of the 36 rolls can the side to move hit a checker?
  function hitRolls(E, s) {
    var o = E.copy(s), n = 0, a, b;
    function canHit(state) {
      var list = E.legalSteps(state), i;
      for (i = 0; i < list.length; i++) {
        var next = E.applyStep(state, list[i]);
        if (next.hit) return true;
        if (next.dice.length && canHit(next)) return true;
      }
      return false;
    }
    for (a = 1; a <= 6; a++) for (b = 1; b <= 6; b++) {
      o.dice = a === b ? [a, a, a, a] : [a, b]; o.rolled = true;
      if (canHit(o)) n++;
    }
    return n;
  }

  function backgammonExplain(E, s, steps, dice) {
    var p = s.turn, key = NAMES[p], who = T('explain.side.' + key.toLowerCase()), cur = s, hits = 0, made = [], entered = 0, off = 0, ran = null, moves = [];
    steps.forEach(function (st) {
      var landing = st.to ? E.idxOf(p, st.to) : -1;
      var own = landing >= 0 ? E.countAt(cur, p, landing) : 0;
      cur = E.applyStep(cur, st);
      if (cur.hit) hits++;
      if (own === 1 && st.to) made.push(st.to);
      if (st.from === BAR) entered++;
      if (st.to === 0) off++;
      if (st.from >= BACK_ZONE && st.from < BAR && st.to < st.from && !ran) ran = st;
      moves.push(spot(st.from) + '/' + spot(st.to) + (cur.hit ? '*' : ''));
    });
    var after = E.copy(cur); after.turn = 1 - p; after.dice = []; after.rolled = false;
    var blots = [];
    for (var r = 1; r <= 24; r++) if (E.countAt(after, p, E.idxOf(p, r)) === 1) blots.push(r);
    var contact = E.hasContact(after);
    var risk = contact && blots.length ? hitRolls(E, after) : 0;
    var rolled = dice && dice.length ? T('explain.backgammon.rolls', { who: who, dice: andChain(dice.map(String)) }) : T('explain.backgammon.rollsNone', { who: who });
    var facts = { side: key, hits: hits, madePoints: made.length, entered: entered, off: off, blots: blots.length, risk: risk, contact: contact, steps: steps.length };

    if (!steps.length) return { text: T('explain.backgammon.noMove', { who: who }), facts: facts };
    var parts = [];
    if (entered) parts.push(T('explain.backgammon.entered', { n: entered }));
    if (hits) parts.push(T('explain.backgammon.hits', { n: hits }));
    if (made.length) parts.push(T('explain.backgammon.makes', { n: made.length, points: andChain(made.map(String)) }));
    if (off) parts.push(T('explain.backgammon.bearsOff', { n: off }));
    if (ran && !hits && !made.length) parts.push(T('explain.backgammon.runs', { from: ran.from }));
    var text = T('explain.backgammon.turn', { rolled: rolled, moves: moves.join(T('explain.list.sep')) });
    if (parts.length) text += ' ' + T('explain.backgammon.itDoes', { parts: andChain(parts.slice(0, 2)) });
    if (!contact) text += ' ' + T('explain.backgammon.race', { white: E.pips(after, 0), black: E.pips(after, 1) });
    else if (!blots.length) text += ' ' + T('explain.backgammon.noBlot');
    else text += ' ' + T('explain.backgammon.blots', { n: blots.length, risk: risk, total: ROLLS });
    return { text: text, facts: facts };
  }

  root.ZimiExplain = root.ZimiExplain || {};
  root.ZimiExplain.backgammon = backgammonExplain;
  if (typeof module !== 'undefined' && module.exports) module.exports = backgammonExplain;
})(typeof globalThis !== 'undefined' ? globalThis : this);
