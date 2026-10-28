/* ZimiGames: Watch and learn, Hearts. One sentence per pass, card played and trick taken, from
   facts checked on the hand: what was led, what the table already holds, what the player could
   legally play, which suits it is out of, who wins and how many points. Our own code, GPL-3.0.

     ZimiExplain.hearts.play(H, Z, state, seat, id)  -> { text, facts }   a card played
     ZimiExplain.hearts.pass(H, Z, hand, picks, dir) -> { text, facts }   three cards passed
     ZimiExplain.hearts.trick(H, Z, trick)           -> { text, facts }   a trick taken
     ZimiExplain.hearts.hand(H, state)               -> { text }          a hand over

   H is ZimiHearts (hearts.js), Z is ZimiCards (cards.js), state the state before the card. */
(function (root) {
  'use strict';
  var SEAT_KEYS = ['bridge.seat.south', 'cards.seat.west', 'cards.seat.north', 'cards.seat.east'], FACT_SEAT = ['South', 'West', 'North', 'East'];
  var HEARTS = 2, SPADES = 3, ACE = 14, FEW_SPADES = 4, TRICK_SIZE = 4;

  var T = function (key, vars) { return root.ZimiText ? root.ZimiText.T(key, vars) : key; };
  var seatName = function (i) { return T(SEAT_KEYS[i]); };
  var points = function (n) { return T('explain.hearts.points', { n: n }); };
  // "a and b and c": two at a time through the language's own "and".
  function andChain(items) { return items.reduce(function (a, b) { return T('explain.list.and', { a: a, b: b }); }); }
  // "a, b and c"
  function list(items) { return items.length < 2 ? items.join('') : T('explain.list.and', { a: items.slice(0, -1).join(T('explain.list.sep')), b: items[items.length - 1] }); }

  function high(Z, id) { return Z.rank(id) === 1 ? ACE : Z.rank(id); }
  function suitWord(Z, suit) { return T('cards.suit.' + Z.SUITS[suit]); }
  function card(Z, id) { return T('explain.hearts.card', { card: Z.cardName(id) }); }
  function playedSoFar(state) { return [].concat.apply([], state.taken).concat(state.trick.map(function (t) { return t.id; })); }
  function count(Z, hand, suit) { return hand.filter(function (c) { return Z.suit(c) === suit; }).length; }

  function play(H, Z, state, seat, id) {
    var hand = state.hands[seat], legal = H.legalPlays(state, seat), trick = state.trick, who = seatName(seat);
    var name = Z.cardName(id), QS = H.QUEEN_SPADES, queenOut = playedSoFar(state).indexOf(QS) < 0 && hand.indexOf(QS) < 0;
    var facts = { seat: FACT_SEAT[seat], card: name, led: !trick.length, legal: legal.length, void: false, ducks: false, forced: false };
    var text, lead, v = { who: who, card: card(Z, id) };
    if (!trick.length) {
      var allHearts = legal.every(function (c) { return Z.suit(c) === HEARTS; });
      var lowest = legal.every(function (c) { return high(Z, c) >= high(Z, id); });
      if (state.tricksPlayed === 0 && id === H.TWO_CLUBS) text = T('explain.hearts.leadTwoClubs', v);
      else if (legal.length === 1) text = T('explain.hearts.leadOnly', v);
      else if (allHearts) text = T('explain.hearts.leadHearts', v);
      else if (!state.broken && hand.some(function (c) { return Z.suit(c) === HEARTS; })) text = T('explain.hearts.leadUnbroken', v);
      else if (lowest) text = T('explain.hearts.leadLow', v);
      else text = T('explain.hearts.lead', v);
      return { text: text, facts: facts };
    }
    lead = Z.suit(trick[0].id);
    var leadSuit = suitWord(Z, lead);
    v.suit = leadSuit;
    var follows = hand.some(function (c) { return Z.suit(c) === lead; });
    if (follows) {
      var inLead = trick.filter(function (t) { return Z.suit(t.id) === lead; });
      var curHigh = Math.max.apply(null, inLead.map(function (t) { return high(Z, t.id); }));
      var mine = high(Z, id), pts = H.trickPoints(trick), last = trick.length === TRICK_SIZE - 1;
      var under = legal.filter(function (c) { return high(Z, c) < curHigh; });
      if (mine < curHigh) {
        facts.ducks = true;
        var best = under.every(function (c) { return high(Z, c) <= mine; });
        v.high = card(Z, curHigh2id(Z, inLead, curHigh));
        text = T(best && under.length > 1 ? 'explain.hearts.duckBest' : 'explain.hearts.duck', v);
      } else if (!under.length) {
        facts.forced = true;
        v.points = points(pts);
        text = T(pts ? 'explain.hearts.forcedPoints' : 'explain.hearts.forced', v);
      } else if (last && pts === 0) {
        text = T('explain.hearts.winsFree', v);
      } else {
        text = T('explain.hearts.over', v);
      }
      return { text: text, facts: facts };
    }
    facts.void = true;
    var inHand = Z.suit(id);
    var heartsHeld = hand.filter(function (c) { return Z.suit(c) === HEARTS; });
    var first = state.tricksPlayed === 0;
    if (id === QS) text = T('explain.hearts.dumpQueen', v);
    else if (inHand === HEARTS && heartsHeld.every(function (c) { return high(Z, c) <= high(Z, id); })) text = T('explain.hearts.shedHeart', v);
    else if (inHand === SPADES && (Z.rank(id) === 1 || Z.rank(id) === 13) && queenOut) text = T('explain.hearts.discardSpade', v);
    else {
      var counts = [0, 1, 2, 3].map(function (s) { return count(Z, hand, s); }).filter(function (n) { return n > 0; });
      var shortest = count(Z, hand, inHand) === Math.min.apply(null, counts);
      text = T(shortest ? (first ? 'explain.hearts.discardShortFirst' : 'explain.hearts.discardShort') : (first ? 'explain.hearts.discardFirst' : 'explain.hearts.discard'), v);
    }
    return { text: text, facts: facts };
  }
  // The highest card of the lead suit on the table, to name ("10 of clubs").
  function curHigh2id(Z, inLead, curHigh) {
    return inLead.filter(function (x) { return high(Z, x.id) === curHigh; })[0].id;
  }

  function pass(H, Z, hand, picks, dir) {
    if (dir === 3) return { text: T('explain.hearts.passNone'), facts: {} };
    var spades = count(Z, hand, SPADES), why = [];
    if (picks.indexOf(H.QUEEN_SPADES) >= 0) why.push(T(spades <= FEW_SPADES ? 'explain.hearts.whyQueenFew' : 'explain.hearts.whyQueen', { n: spades }));
    var honours = picks.filter(function (c) { return Z.suit(c) === SPADES && (Z.rank(c) === 1 || Z.rank(c) === 13); });
    if (honours.length) why.push(T('explain.hearts.whyHonours'));
    var hearts = picks.filter(function (c) { return Z.suit(c) === HEARTS; });
    if (hearts.length) why.push(T('explain.hearts.whyHearts'));
    var v = { who: seatName(0), cards: list(picks.map(function (c) { return card(Z, c); })), dir: T('explain.hearts.dir.' + dir), why: list(why) };
    return { text: T(why.length ? 'explain.hearts.passWhy' : 'explain.hearts.passPlain', v), facts: { picks: picks.length, reasons: why.length } };
  }

  function trick(H, Z, tr) {
    var win = H.trickWinner(tr), w = tr.filter(function (t) { return t.seat === win; })[0], pts = H.trickPoints(tr);
    var hearts = tr.filter(function (t) { return Z.suit(t.id) === HEARTS; }).length, queen = tr.some(function (t) { return t.id === H.QUEEN_SPADES; });
    var parts = [];
    if (queen) parts.push(T('explain.hearts.partQueen'));
    if (hearts) parts.push(T('explain.hearts.partHearts', { n: hearts }));
    var text = T(pts ? 'explain.hearts.trickPoints' : 'explain.hearts.trickNone', { who: seatName(win), card: card(Z, w.id), points: points(pts), parts: list(parts) });
    return { text: text, facts: { winner: FACT_SEAT[win], points: pts } };
  }

  function hand(H, state) {
    var low = Math.min.apply(null, state.scores);
    var text = state.moon >= 0 ? T('explain.hearts.moon', { who: seatName(state.moon) })
      : T('explain.hearts.handOver', { scores: state.handPoints.map(function (p, i) { return T('explain.hearts.score', { who: seatName(i), n: p }); }).join(T('explain.list.sep')) });
    var lowest = andChain(state.scores.map(function (s, i) { return s === low ? seatName(i) : null; }).filter(Boolean));
    return { text: text + ' ' + T('explain.hearts.lowest', { who: lowest, n: low }), facts: {} };
  }

  root.ZimiExplain = root.ZimiExplain || {};
  root.ZimiExplain.hearts = { play: play, pass: pass, trick: trick, hand: hand };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ZimiExplain.hearts;
})(typeof globalThis !== 'undefined' ? globalThis : this);
