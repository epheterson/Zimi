/* ZimiGames: Bridge. Contract bridge, Chicago scoring (four deals), you
   (South) and North against West and East. Each deal: an auction, then the
   play. Bidding a contract is a promise to take that many tricks past six
   (1 = seven tricks) with a trump suit or none (NT). The auction goes round
   from the dealer; a bid must beat the one before it (level, then clubs,
   diamonds, hearts, spades, NT); Double and Redouble raise the stakes. Three
   passes in a row after a bid end it. Declarer is the first of the winning
   side to have bid that suit; declarer's partner (dummy) lays their hand
   down after the opening lead and declarer plays both hands. Follow suit if
   you can; the highest trump, else the highest card of the suit led, wins
   the trick. Scores: trick points 20 a club or diamond, 30 a heart or spade,
   NT 40 then 30; 100 or more makes game (300, or 500 vulnerable); a made
   part-score gets 50; slams 500/750 and 1000/1500; overtricks and doubled
   bonuses; undertricks cost 50 (100 vulnerable) each, more if doubled.
   Vulnerability by deal: none, dealer's side, dealer's side, both.

   The computers bid a simple natural system: 5-card majors, 15 to 17 NT,
   Stayman (2 clubs after 1NT asks for a 4-card major), raises and new suits
   as responses, weak twos and preempts.

   State: hands[4] (current), orig[4], dealer, vul [NS, EW], auction
   [{seat, call}] (calls: 'P', 'X', 'XX', '1C'..'7N'), phase ('auction' |
   'play' | 'dealEnd' | 'over'), turn, contract {level, den, declarer, dummy,
   dbl}, trick [{seat, id}], leader, tricks [NS, EW], played, dummyShown,
   dealNo, totals [NS, EW], result. Seats clockwise: 0 you (South), 1 West,
   2 North, 3 East. Pure functions; the page wiring at the bottom only runs
   in a browser. */
(function (root) {
  'use strict';
  var Z = root.ZimiCards, T = root.ZimiTable, TX = root.ZimiCards.T;

  var AUCTION_STACK = 3, SEATS = 4, HAND = 13, NAMES = [TX('bridge.seat.south'), TX('cards.seat.west'), TX('cards.seat.north'), TX('cards.seat.east')], DEALS = 4;
  var DEN_LABEL = ['♣', '♦', '♥', '♠', TX('bridge.nt')], DEN_CHAR = 'CDHSN', DEN_NAME = [TX('cards.suit.clubs'), TX('cards.suit.diamonds'), TX('cards.suit.hearts'), TX('cards.suit.spades'), TX('bridge.noTrump')];
  var NT = 4, MAX_LEVEL = 7, GAME_POINTS = 100, DEALERS = [2, 3, 0, 1];
  var BONUS = { game: [300, 500], part: 50, small: [500, 750], grand: [1000, 1500], insult: [0, 50, 100] };
  var high = T.rankHigh, team = function (seat) { return seat % 2; }, partnerOf = function (seat) { return (seat + 2) % SEATS; };

  // ── Calls ───────────────────────────────────────────────────────────────
  function parseCall(c) {
    if (c === 'P') return { type: 'pass' };
    if (c === 'X') return { type: 'double' };
    if (c === 'XX') return { type: 'redouble' };
    return { type: 'bid', level: +c.charAt(0), den: DEN_CHAR.indexOf(c.charAt(1)) };
  }
  var bidRank = function (level, den) { return (level - 1) * 5 + den; };
  var bidCall = function (level, den) { return level + DEN_CHAR.charAt(den); };
  function callText(c) { var p = parseCall(c); return p.type === 'pass' ? TX('bridge.pass') : p.type === 'double' ? TX('bridge.double') : p.type === 'redouble' ? TX('bridge.redouble') : p.level + DEN_LABEL[p.den]; }
  function callWords(c) { var p = parseCall(c); return p.type === 'bid' ? p.level + ' ' + DEN_NAME[p.den] : callText(c).toLocaleLowerCase(); }

  // What the auction so far amounts to: the last bid, whether it is doubled, every bid.
  function analyze(st) {
    var out = { bids: [], last: null, dbl: 0, passes: 0 };
    st.auction.forEach(function (e) {
      var p = parseCall(e.call);
      if (p.type === 'bid') { var b = { seat: e.seat, level: p.level, den: p.den, call: e.call }; out.bids.push(b); out.last = b; out.dbl = 0; out.passes = 0; }
      else if (p.type === 'double') { out.dbl = 1; out.passes = 0; }
      else if (p.type === 'redouble') { out.dbl = 2; out.passes = 0; }
      else out.passes++;
    });
    return out;
  }
  function legalCalls(st, seat) {
    if (st.phase !== 'auction' || st.turn !== seat) return [];
    var a = analyze(st), out = ['P'], level, den;
    for (level = 1; level <= MAX_LEVEL; level++) for (den = 0; den <= NT; den++) if (!a.last || bidRank(level, den) > bidRank(a.last.level, a.last.den)) out.push(bidCall(level, den));
    if (a.last && a.dbl === 0 && team(a.last.seat) !== team(seat)) out.push('X');
    if (a.last && a.dbl === 1 && team(a.last.seat) === team(seat)) out.push('XX');
    return out;
  }

  // ── The deal ────────────────────────────────────────────────────────────
  function sortHand(ids) { return T.sortHand(ids, high); }
  function dealFor(order, dealNo, totals) {
    var hands = [], s, dealer = DEALERS[dealNo];
    for (s = 0; s < SEATS; s++) hands.push(sortHand(order.slice(s * HAND, (s + 1) * HAND)));
    var vul = [[false, false], [false, true], [true, false], [true, true]][dealNo];
    // Dealer's side vulnerable on deals 2 and 3: the table above is by side (NS, EW), deal 2's dealer is East, deal 3's is South.
    return {
      hands: hands, orig: hands.map(function (h) { return h.slice(); }), dealer: dealer, vul: vul, auction: [], phase: 'auction', turn: dealer,
      contract: null, trick: [], leader: -1, tricks: [0, 0], played: [], dummyShown: false, dealNo: dealNo, totals: totals.slice(), result: null, moves: 0
    };
  }
  function freshGame(order) { return dealFor(order, 0, [0, 0]); }
  function nextDeal(st, order) { return dealFor(order, st.dealNo + 1, st.totals); }

  function applyCall(st, seat, call) {
    if (legalCalls(st, seat).indexOf(call) < 0) return st;
    var s = Z.clone(st);
    s.auction.push({ seat: seat, call: call }); s.moves++;
    var a = analyze(s), n = s.auction.length;
    if (!a.last && n === SEATS && a.passes === SEATS) return passedOut(s);
    if (a.last && a.passes === 3) return startPlay(s, a);
    s.turn = (seat + 1) % SEATS;
    return s;
  }
  function startPlay(s, a) {
    var last = a.last, declarer = a.bids.filter(function (b) { return b.den === last.den && team(b.seat) === team(last.seat); })[0].seat;
    s.contract = { level: last.level, den: last.den, declarer: declarer, dummy: partnerOf(declarer), dbl: a.dbl };
    s.phase = 'play'; s.leader = s.turn = (declarer + 1) % SEATS;
    return s;
  }
  function passedOut(s) {
    s.result = { passedOut: true, points: [0, 0], lines: [TX('bridge.passedOut')] };
    s.phase = s.dealNo >= DEALS - 1 ? 'over' : 'dealEnd';
    return s;
  }

  // ── The play ────────────────────────────────────────────────────────────
  var trumpOf = function (st) { return st.contract.den === NT ? -1 : st.contract.den; };
  // Whose hand a seat's cards are played by: dummy's are played by declarer.
  function controller(st, seat) { return st.contract && seat === st.contract.dummy ? st.contract.declarer : seat; }
  function legalPlays(st, seat) {
    var hand = st.hands[seat];
    if (!st.trick.length) return hand.slice();
    var lead = Z.suit(st.trick[0].id), follow = hand.filter(function (c) { return Z.suit(c) === lead; });
    return follow.length ? follow : hand.slice();
  }
  function isLegal(st, seat, id) { return st.phase === 'play' && st.trick.length < SEATS && st.turn === seat && legalPlays(st, seat).indexOf(id) >= 0; }
  function playCard(st, seat, id) {
    if (!isLegal(st, seat, id)) return st;
    var s = Z.clone(st);
    s.hands[seat].splice(s.hands[seat].indexOf(id), 1);
    s.trick.push({ seat: seat, id: id }); s.moves++;
    s.dummyShown = true; // dummy goes down after the opening lead
    if (s.trick.length < SEATS) s.turn = (seat + 1) % SEATS;
    return s;
  }
  function beats(a, b, trump) {
    var sa = Z.suit(a), sb = Z.suit(b);
    if (sa === sb) return high(a) > high(b);
    return trump >= 0 && sa === trump;
  }
  function trickWinner(trick, trump) {
    var best = trick[0];
    trick.forEach(function (t) { if (beats(t.id, best.id, trump)) best = t; });
    return best.seat;
  }
  function resolveTrick(st) {
    var s = Z.clone(st), w = trickWinner(s.trick, trumpOf(s));
    s.tricks[team(w)]++;
    s.played = s.played.concat(s.trick.map(function (t) { return t.id; }));
    s.trick = []; s.leader = s.turn = w;
    if (s.played.length === SEATS * HAND) endDeal(s);
    return s;
  }

  // ── Scoring ─────────────────────────────────────────────────────────────
  // Points to the declaring side (negative: it went down) for taking `taken` tricks.
  function scoreContract(c, taken, vulnerable) {
    var v = vulnerable ? 1 : 0, need = 6 + c.level, diff = taken - need, mult = c.dbl === 0 ? 1 : c.dbl === 1 ? 2 : 4, lines = [], pts = 0;
    if (diff >= 0) {
      var per = c.den < 2 ? 20 : 30, first = c.den === NT ? 40 : per, trick = (first + per * (c.level - 1)) * mult;
      lines.push(TX('bridge.line.tricks', { n: trick })); pts += trick;
      if (trick >= GAME_POINTS) { pts += BONUS.game[v]; lines.push(TX('bridge.line.game', { n: BONUS.game[v] })); } else { pts += BONUS.part; lines.push(TX('bridge.line.part', { n: BONUS.part })); }
      if (c.level === 6) { pts += BONUS.small[v]; lines.push(TX('bridge.line.small', { n: BONUS.small[v] })); }
      if (c.level === 7) { pts += BONUS.grand[v]; lines.push(TX('bridge.line.grand', { n: BONUS.grand[v] })); }
      if (c.dbl) { pts += BONUS.insult[c.dbl]; lines.push(TX('bridge.line.double', { n: BONUS.insult[c.dbl] })); }
      if (diff > 0) {
        var each = c.dbl === 0 ? per : (c.dbl === 1 ? 1 : 2) * (v ? 200 : 100), over = each * diff;
        pts += over; lines.push(TX('bridge.line.over', { tricks: Z.plural(diff, 'overtrick'), n: over }));
      }
      return { made: true, points: pts, lines: lines };
    }
    var down = -diff, penalty;
    if (c.dbl === 0) penalty = down * (v ? 100 : 50);
    else {
      var k, sum = 0;
      for (k = 1; k <= down; k++) sum += v ? (k === 1 ? 200 : 300) : (k === 1 ? 100 : k <= 3 ? 200 : 300);
      penalty = sum * (c.dbl === 2 ? 2 : 1);
    }
    lines.push(TX('bridge.line.down', { down: down, n: penalty }));
    return { made: false, points: -penalty, lines: lines };
  }
  function endDeal(s) {
    var c = s.contract, decSide = team(c.declarer), taken = s.tricks[decSide];
    var r = scoreContract(c, taken, s.vul[decSide]), pts = [0, 0];
    if (r.made) pts[decSide] = r.points; else pts[1 - decSide] = -r.points;
    s.totals = [s.totals[0] + pts[0], s.totals[1] + pts[1]];
    s.result = { passedOut: false, points: pts, made: r.made, taken: taken, need: 6 + c.level, lines: r.lines, declSide: decSide };
    s.phase = s.dealNo >= DEALS - 1 ? 'over' : 'dealEnd';
  }
  var winnerSide = function (totals) { return totals[0] === totals[1] ? -1 : totals[0] > totals[1] ? 0 : 1; };

  // ── Hand description ────────────────────────────────────────────────────
  var HCP = { 14: 4, 13: 3, 12: 2, 11: 1 };
  function hcp(hand) { return hand.reduce(function (n, c) { return n + (HCP[high(c)] || 0); }, 0); }
  function lengths(hand) { var l = [0, 0, 0, 0]; hand.forEach(function (c) { l[Z.suit(c)]++; }); return l; }
  function balanced(len) { var s = len.slice().sort(function (a, b) { return b - a; }); return s[3] >= 2 && s[0] <= 5 && (s[0] < 5 || s[1] <= 3) && (s[2] >= 3 || (s[0] === 4 && s[1] === 4)); }
  // Points for long suits (one a card past four), for opening and rebidding.
  function lengthPoints(len) { return len.reduce(function (n, l) { return n + Math.max(0, l - 4); }, 0); }
  // Points for shortness once a trump fit is known.
  function dummyPoints(len, den) { return len.reduce(function (n, l, d) { return d === den ? n : n + (l === 0 ? 3 : l === 1 ? 2 : l === 2 ? 1 : 0); }, 0); }
  function suitCards(hand, suit) { return hand.filter(function (c) { return Z.suit(c) === suit; }); }
  var honorsIn = function (hand, suit, from) { return suitCards(hand, suit).filter(function (c) { return high(c) >= from; }).length; };
  function hasStopper(hand, suit) {
    var cs = suitCards(hand, suit), top = cs.map(high).sort(function (a, b) { return b - a; });
    return top[0] === 14 || (top[0] === 13 && cs.length >= 2) || (top[0] === 12 && cs.length >= 3) || (top[0] === 11 && cs.length >= 4);
  }

  // ── What the computer players infer from a partner's calls ──────────────
  // { lo, hi, len[4] }: points and the suit lengths a seat has shown.
  function inferred(st, who) {
    var b = { lo: 0, hi: 40, len: [0, 0, 0, 0] }, partner = partnerOf(who), own = [], i;
    function limit(lo, hi) { b.lo = Math.max(b.lo, lo); b.hi = Math.min(b.hi, hi); if (b.hi < b.lo) b.hi = b.lo + 2; }
    function suit(den, n) { if (den < NT) b.len[den] = Math.max(b.len[den], n); }
    for (i = 0; i < st.auction.length; i++) {
      var e = st.auction[i];
      if (e.seat !== who) continue;
      var c = parseCall(e.call), before = st.auction.slice(0, i), prior = analyze({ auction: before }).bids;
      if (c.type !== 'bid') {
        if (c.type === 'pass' && !prior.length) limit(0, 11);
        else if (c.type === 'pass' && prior.length && prior.every(function (x) { return team(x.seat) === team(who); })) limit(0, 5);
        continue;
      }
      var partnerBids = prior.filter(function (x) { return x.seat === partner; }), oppBids = prior.filter(function (x) { return team(x.seat) !== team(who); });
      var p = partnerBids[0], myOpen = own[0], opener = analyze(st).bids[0].seat === who;
      if (!prior.length) { // an opening
        if (c.den === NT) { limit(c.level === 1 ? 15 : 20, c.level === 1 ? 17 : 40); }
        else if (c.level === 1) { limit(12, 21); suit(c.den, c.den >= 2 ? 5 : 4); }
        else if (c.level === 2) { limit(5, 10); suit(c.den, 6); }
        else { limit(5, 10); suit(c.den, c.level + 4); }
      } else if (!own.length && !partnerBids.length) { // an overcall
        if (c.den === NT) limit(15, 18); else if (c.level === 1) { limit(8, 16); suit(c.den, 5); } else if (c.level === 2) { limit(10, 16); suit(c.den, 5); } else { limit(5, 10); suit(c.den, c.level + 3); }
      } else if (!own.length && p) { // a response
        var opened = analyze(st).bids[0].seat === partner;
        if (opened && p.den === NT) {
          if (c.den === 0 && c.level === 2) limit(8, 40);
          else if (c.den === NT) {
            if (p.level === 2) { if (c.level === 3) limit(4, 10); else limit(c.level === 6 ? 11 : 17, c.level === 6 ? 16 : 40); }
            else if (c.level === 2) limit(8, 9); else if (c.level === 3) limit(10, 15); else limit(c.level === 6 ? 16 : 19, c.level === 6 ? 18 : 40);
          }
          else if (c.level === 2) { limit(0, 7); suit(c.den, 5); } else if (c.level === 3) { limit(10, 40); suit(c.den, 5); } else { limit(10, 14); suit(c.den, 6); }
        } else if (c.den === p.den) {
          suit(c.den, 3); limit(c.level === 2 ? 6 : c.level === 3 ? 10 : 13, c.level === 2 ? 9 : c.level === 3 ? 12 : 40);
        } else if (c.den === NT) limit(c.level === 1 ? 6 : 13, c.level === 1 ? 9 : 15);
        else { suit(c.den, c.level === 1 ? 4 : 5); limit(c.level === 1 ? 6 : 10, 40); }
      } else { // a rebid or a later call
        var mine = own.filter(function (x) { return x.den === c.den; }).length, pbid = partnerBids.filter(function (x) { return x.den === c.den; }).length;
        if (myOpen && myOpen.den === NT && c.den < NT && c.level === 2) { if (c.den === 1) { /* no major */ } else suit(c.den, 4); }
        else if (c.den === NT) {
          if (opener) limit(c.level === 1 ? 12 : c.level === 2 ? 15 : 17, c.level === 1 ? 14 : c.level === 2 ? 19 : 40);
          else limit(c.level === 1 ? 6 : c.level === 2 ? 11 : 13, c.level === 1 ? 10 : c.level === 2 ? 12 : 15);
        }
        else if (mine) { suit(c.den, 6); limit(c.level <= 2 ? 12 : 15, c.level <= 2 ? 15 : 40); }
        else if (pbid) { suit(c.den, 4); limit(c.level <= 2 ? 6 : c.level === 3 ? 10 : c.level === 4 ? 12 : 13, c.level <= 2 ? 12 : c.level === 3 ? 14 : 17); }
        else { suit(c.den, 4); limit(12, 40); }
      }
      if (c.level >= 4 && c.level <= 5 && c.den < NT) b.hi = Math.min(b.hi, Math.max(b.lo, 17));
      own.push(c);
    }
    return b;
  }
  var midPoints = function (b) { return b.hi >= 40 ? b.lo + 2 : (b.lo + b.hi) / 2; };

  // ── The computer players: bidding ───────────────────────────────────────
  var GAME_LEVEL = [5, 5, 4, 4, 3], MINOR_GAME_PTS = 30, GAME_PTS = 25, INVITE_PTS = 22, PART_PTS = 19, SLAM_PTS = 34, GRAND_PTS = 38;
  function openSuitCall(hand, len) {
    if (len[3] >= 5 || len[2] >= 5) return len[3] >= len[2] ? '1S' : '1H';
    if (len[1] > len[0]) return '1D';
    if (len[0] > len[1]) return '1C';
    return len[1] >= 4 ? '1D' : '1C';
  }
  function openingCall(hand) {
    var H = hcp(hand), len = lengths(hand), bal = balanced(len), lp = H + lengthPoints(len), d;
    if (bal && H >= 20) return '2N';
    if (bal && H >= 15 && H <= 17) return '1N';
    // Preempts: a long suit and little else.
    if (H <= 10) {
      for (d = 3; d >= 1; d--) {
        var top = honorsIn(hand, d, 12);
        if (len[d] >= 8 && d >= 2) return '4' + DEN_CHAR[d];
        if (len[d] === 7 && top >= 1) return '3' + DEN_CHAR[d];
        if (len[d] === 6 && top >= 2 && H >= 5) return '2' + DEN_CHAR[d];
      }
    }
    var twoLongest = len.slice().sort(function (a, b) { return b - a; });
    if (H >= 13 || (H >= 12 && lp >= 12) || (H >= 11 && H + twoLongest[0] + twoLongest[1] >= 20)) return openSuitCall(hand, len);
    return 'P';
  }
  function cheapest(a, den) { for (var l = 1; l <= MAX_LEVEL; l++) if (!a.last || bidRank(l, den) > bidRank(a.last.level, a.last.den)) return l; return MAX_LEVEL + 1; }
  // The best fit the two hands have (suit, or NT), and how high they should go.
  function partnership(H, len, bal, b) {
    var best = -1, bestTl = 0, d, pts = H + midPoints(b);
    for (d = 3; d >= 0; d--) {
      var tl = len[d] + b.len[d];
      if (tl >= 8 && (best < 0 || (d >= 2 && best < 2) || (d >= 2 === best >= 2 && tl > bestTl))) { best = d; bestTl = tl; }
    }
    var den = best >= 0 ? best : NT, level;
    if (best >= 0) pts += dummyPoints(len, best); else pts += lengthPoints(len) * 0.5;
    if (den === NT) level = pts >= GRAND_PTS ? 7 : pts >= SLAM_PTS ? 6 : pts >= GAME_PTS ? 3 : pts >= INVITE_PTS ? 2 : pts >= PART_PTS + 1 ? 1 : 0;
    else if (den >= 2) level = pts >= GRAND_PTS ? 7 : pts >= SLAM_PTS ? 6 : pts >= GAME_PTS ? 4 : pts >= INVITE_PTS ? 3 : pts >= PART_PTS ? 2 : 0;
    else if (pts >= GAME_PTS && (bal || pts < MINOR_GAME_PTS) && b.len[den] < 6) { den = NT; level = 3; } else level = pts >= GRAND_PTS ? 7 : pts >= SLAM_PTS ? 6 : pts >= MINOR_GAME_PTS ? 5 : pts >= INVITE_PTS + 1 ? 3 : pts >= PART_PTS ? 2 : 0;
    return { den: den, level: level, pts: pts };
  }
  function towards(a, tgt, jumpToGame) {
    if (!tgt.level) return 'P';
    var rank = bidRank(tgt.level, tgt.den);
    if (a.last && bidRank(a.last.level, a.last.den) >= rank) return 'P';
    if (tgt.level >= GAME_LEVEL[tgt.den] || jumpToGame) return bidCall(tgt.level, tgt.den);
    var l = cheapest(a, tgt.den);
    return l <= tgt.level ? bidCall(l, tgt.den) : 'P';
  }
  function respondNT(H, len, p) {
    if (p.level === 2) return H <= 3 ? 'P' : H >= 18 ? '7N' : H >= 14 ? '6N' : '3N';
    var major4 = len[2] >= 4 || len[3] >= 4;
    if (H <= 7) { for (var d = 3; d >= 1; d--) if (len[d] >= 5 && d >= 1) return '2' + DEN_CHAR[d]; return 'P'; }
    if (H >= 24) return '7N';
    if (H >= 18) return '6N';
    if (H >= 10 && (len[2] >= 6 || len[3] >= 6)) return '4' + (len[3] >= len[2] ? 'S' : 'H');
    if (major4) return '2C';
    return H >= 10 ? '3N' : '2N';
  }
  function respondSuit(hand, H, len, bal, p, a) {
    var lp = H, sup = len[p.den], major = p.den >= 2, d;
    if (H < 6) return 'P';
    var fit = major ? sup >= 3 : sup >= 5;
    if (major && sup >= 3 && H >= 13) return '4' + DEN_CHAR[p.den];
    // A new major at the one level is shown before a minor fit.
    var newMajor = [2, 3].filter(function (x) { return x !== p.den && len[x] >= 4 && bidRank(1, x) > bidRank(p.level, p.den); });
    if (fit && !(newMajor.length && H >= 13)) {
      if (H <= 9) return '2' + DEN_CHAR[p.den];
      if (H <= 12) return '3' + DEN_CHAR[p.den];
      return (major ? '4' : '3') + (major ? DEN_CHAR[p.den] : 'N');
    }
    // Longest suit, up the line, at the cheapest level.
    var suits = [];
    for (d = 3; d >= 0; d--) if (d !== p.den && len[d] >= 4) suits.push(d);
    suits.sort(function (x, y) { return len[y] - len[x] || y - x; });
    var oneLevel = suits.filter(function (x) { return bidRank(1, x) > bidRank(p.level, p.den) && cheapest(a, x) === 1; });
    if (oneLevel.length) {
      var top = oneLevel[0];
      if (len[2] === 4 && len[3] === 4 && oneLevel.indexOf(2) >= 0 && oneLevel.indexOf(3) >= 0) top = 2;
      return '1' + DEN_CHAR[top];
    }
    if (H >= 10 && suits.length) { var s5 = suits.filter(function (x) { return len[x] >= 5; }); if (s5.length) return cheapest(a, s5[0]) <= 2 ? '2' + DEN_CHAR[s5[0]] : 'P'; }
    if (bal) return H <= 9 ? '1N' : H <= 12 ? '2N' : '3N';
    if (H >= 10 && suits.length) return cheapest(a, suits[0]) <= 2 ? bidCall(cheapest(a, suits[0]), suits[0]) : 'P';
    return H <= 9 ? '1N' : '2N';
  }
  function overcallCall(hand, a) {
    var H = hcp(hand), len = lengths(hand), bal = balanced(len), opp = a.last, d, best = -1;
    if (bal && H >= 15 && H <= 18 && opp.den < NT && hasStopper(hand, opp.den) && opp.level === 1) return '1N';
    for (d = 3; d >= 0; d--) {
      if (d === opp.den) continue;
      var good = honorsIn(hand, d, 12) >= 2 || len[d] >= 6;
      if (len[d] >= 5 && good && (best < 0 || len[d] > len[best])) best = d;
    }
    if (best >= 0) {
      var l = cheapest(a, best);
      if (H <= 9 && len[best] >= 6 && opp.level === 1 && cheapest(a, best) <= 2 && bidRank(2, best) > bidRank(opp.level, opp.den)) return '2' + DEN_CHAR[best];
      if (len[best] >= 7 && H <= 10 && opp.level <= 2) return '3' + DEN_CHAR[best];
      if (H >= 8 && ((l === 1) || (l === 2 && H >= 11))) return bidCall(l, best);
    }
    return 'P';
  }

  function aiBid(st, seat) {
    var legal = legalCalls(st, seat), hand = st.hands[seat], H = hcp(hand), len = lengths(hand), bal = balanced(len);
    var a = analyze(st), partner = partnerOf(seat), side = team(seat);
    var mine = a.bids.filter(function (b) { return team(b.seat) === side; }), theirs = a.bids.filter(function (b) { return team(b.seat) !== side; });
    var myOwn = a.bids.filter(function (b) { return b.seat === seat; }), pBids = a.bids.filter(function (b) { return b.seat === partner; });
    var call = 'P', b = inferred(st, partner), oppLast = a.last && team(a.last.seat) !== side;
    var pick = function (c) { return legal.indexOf(c) >= 0 ? c : null; };
    // A penalty double: they have bid too high for what is left.
    if (oppLast && a.dbl === 0 && a.last.level >= 3 && legal.indexOf('X') >= 0) {
      var tl = len[a.last.den] || 0, pts = H + midPoints(b);
      if (a.last.den < NT && tl >= 4 && pts >= 24 && H >= 8 && mine.length) return 'X';
      if (a.last.den === NT && a.last.level >= 3 && H >= 17 && !mine.length) return 'X';
    }
    if (!a.bids.length) call = openingCall(hand);
    else if (!mine.length) call = overcallCall(hand, a);
    else if (!myOwn.length) { // partner has bid, I have not
      var p = pBids[0];
      if (p === a.bids[0]) call = p.den === NT ? respondNT(H, len, p) : respondSuit(hand, H, len, bal, p, a);
      else call = towards(a, partnership(H, len, bal, b), false);
      if (call !== 'P' && !pick(call)) { var pc = parseCall(call); call = pc.type === 'bid' && cheapest(a, pc.den) <= pc.level + 1 && pc.den < NT && H >= 10 ? bidCall(cheapest(a, pc.den), pc.den) : 'P'; }
    } else call = continueBid(st, seat, hand, H, len, bal, a, b, myOwn, pBids);
    return pick(call) || 'P';
  }
  // Rebids and later calls: answer Stayman, then follow what the two hands add up to.
  function continueBid(st, seat, hand, H, len, bal, a, b, myOwn, pBids) {
    var first = myOwn[0], last = pBids[pBids.length - 1], d;
    if (!last) return towards(a, partnership(H, len, bal, b), false);
    if (first === a.bids[0] && first.den === NT && myOwn.length === 1 && last.den === 0 && last.level === 2 && pBids.length === 1) {
      if (len[2] >= 4) return '2H';
      if (len[3] >= 4) return '2S';
      return '2D';
    }
    var tgt = partnership(H, len, bal, b);
    // Opener's first rebid when no fit has been found: own suit, a second suit, or notrump.
    if (myOwn.length === 1 && first === a.bids[0] && first.den < NT && last.den !== first.den && !(len[last.den] >= 4 && last.den >= 2)) {
      if (tgt.level >= GAME_LEVEL[tgt.den] && tgt.den !== NT) return towards(a, tgt, false);
      if (len[first.den] >= 6) return H >= 16 ? bidCall(Math.min(3, cheapest(a, first.den) + 1), first.den) : bidCall(cheapest(a, first.den), first.den);
      var second = -1;
      for (d = 3; d >= 0; d--) if (d !== first.den && d !== last.den && len[d] >= 4 && (second < 0 || len[d] > len[second])) second = d;
      if (bal && H >= 18) return H >= 20 ? '3N' : bidCall(cheapest(a, NT) < 2 ? 2 : cheapest(a, NT), NT);
      if (second >= 0 && cheapest(a, second) <= 2 && H >= 12) return bidCall(cheapest(a, second), second);
      if (bal && H <= 14 && cheapest(a, NT) === 1) return '1N';
      if (tgt.level && tgt.den === NT) return towards(a, tgt, false);
      return 'P';
    }
    return towards(a, tgt, false);
  }

  // ── The computer players: play ──────────────────────────────────────────
  function unseen(st, viewer, suit) {
    var known = st.played.concat(st.trick.map(function (t) { return t.id; })).concat(st.hands[viewer]);
    if (st.dummyShown) known = known.concat(st.hands[st.contract.dummy]);
    if (st.dummyShown && viewer === st.contract.dummy) known = known.concat(st.hands[st.contract.declarer]);
    var out = [], r;
    for (r = 2; r <= 14; r++) { var id = Z.make(r === 14 ? 1 : r, suit); if (known.indexOf(id) < 0) out.push(id); }
    return out;
  }
  var viewerOf = function (st, seat) { return st.contract && seat === st.contract.dummy ? st.contract.declarer : seat; };
  function isTop(st, viewer, card) {
    return unseen(st, viewer, Z.suit(card)).every(function (c) { return high(c) < high(card); });
  }
  var lowest = function (cards) { return T.minBy(cards, high); };
  var highest = function (cards) { return T.maxBy(cards, high); };
  function sequenceLead(cards) { // the top of two or more touching honors (or a 10-9-8 type run)
    var s = cards.slice().sort(function (x, y) { return high(y) - high(x); }), i;
    for (i = 0; i + 1 < s.length; i++) if (high(s[i]) >= 10 && high(s[i]) - high(s[i + 1]) === 1) return s[i];
    return null;
  }
  function openingLead(st, seat) {
    var hand = st.hands[seat], trump = trumpOf(st), len = lengths(hand), best = null, bestScore = -99, d;
    var partnerSuits = st.auction.filter(function (e) { var p = parseCall(e.call); return e.seat === partnerOf(seat) && p.type === 'bid' && p.den < NT; }).map(function (e) { return parseCall(e.call).den; });
    var theirSuits = st.auction.filter(function (e) { var p = parseCall(e.call); return team(e.seat) !== team(seat) && p.type === 'bid' && p.den < NT; }).map(function (e) { return parseCall(e.call).den; });
    for (d = 0; d < 4; d++) {
      var cs = suitCards(hand, d);
      if (!cs.length) continue;
      var score = cs.length + honorsIn(hand, d, 12) * 0.6 + (sequenceLead(cs) ? 2 : 0);
      if (partnerSuits.indexOf(d) >= 0) score += 3;
      if (theirSuits.indexOf(d) >= 0 && d !== trump) score -= 3;
      if (d === trump) score -= 4;
      if (cs.length === 1 && trump >= 0 && d !== trump) score += 1.5;
      if (high(cs[0]) === 14 && cs.length === 1) score -= 1;
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return leadFromSuit(st, seat, best);
  }
  function leadFromSuit(st, seat, d) {
    var cs = suitCards(st.hands[seat], d).sort(function (x, y) { return high(y) - high(x); }), seq = sequenceLead(cs);
    if (seq) return seq;
    if (high(cs[0]) === 14 && cs.length >= 2 && high(cs[1]) === 13) return cs[0];
    if (cs.length >= 4) return cs[3];
    if (cs.length === 3) return cs[2];
    return cs.length === 2 ? cs[1] : cs[0];
  }
  function defenderPick(st, seat, legal) {
    var hand = st.hands[seat], trick = st.trick, trump = trumpOf(st), viewer = seat, partner = partnerOf(seat), c;
    if (!trick.length) {
      if (st.played.length === 0) return openingLead(st, seat);
      // Later leads: a top card, else a suit the opponents have not stopped, preferring the longest.
      var tops = legal.filter(function (x) { return isTop(st, viewer, x) && Z.suit(x) !== trump; });
      if (tops.length) return highest(tops);
      var best = null, bs = -99, d;
      for (d = 0; d < 4; d++) { var cs = suitCards(hand, d); if (!cs.length) continue; var sc = cs.length + (d === trump ? -3 : 0) + honorsIn(hand, d, 12) * 0.2; if (sc > bs) { bs = sc; best = d; } }
      return leadFromSuit(st, seat, best);
    }
    var lead = Z.suit(trick[0].id), win = trick[0];
    trick.forEach(function (t) { if (beats(t.id, win.id, trump)) win = t; });
    var follow = legal.filter(function (x) { return Z.suit(x) === lead; }), last = trick.length === SEATS - 1, partnerWins = win.seat === partner;
    if (follow.length) {
      var winners = follow.filter(function (x) { return beats(x, win.id, trump); });
      if (partnerWins && (last || isTop(st, viewer, win.id))) return lowest(follow);
      if (partnerWins) return lowest(follow);
      if (!winners.length) return lowest(follow);
      if (last) return lowest(winners);
      if (trick.length === 1) { // second hand: low, unless a top card wins it
        var sure = winners.filter(function (x) { return isTop(st, viewer, x); });
        return sure.length && high(win.id) >= 11 ? lowest(sure) : lowest(follow);
      }
      return highest(winners);
    }
    // Void in the suit led.
    if (trump >= 0 && !partnerWins) {
      var trumps = legal.filter(function (x) { return Z.suit(x) === trump; }), over = trumps.filter(function (x) { return beats(x, win.id, trump); });
      if (over.length) return lowest(over);
    }
    return discard(st, seat, legal, trump);
  }
  function discard(st, seat, legal, trump) {
    var hand = st.hands[seat], best = null, bs = -99;
    legal.forEach(function (c) {
      var d = Z.suit(c), cs = suitCards(hand, d), sc = -high(c) + (d === trump ? -40 : 0) + cs.length * 1.2 - (high(c) >= 13 ? 5 : 0);
      if (cs.length <= 2 && high(cs.slice().sort(function (x, y) { return high(y) - high(x); })[0]) >= 12) sc -= 6;
      if (sc > bs) { bs = sc; best = c; }
    });
    return best;
  }
  function declarerPick(st, seat, legal) {
    var trick = st.trick, trump = trumpOf(st), viewer = st.contract.declarer, other = partnerOf(seat), hand = st.hands[seat];
    if (!trick.length) {
      if (trump >= 0) {
        var out = unseen(st, viewer, trump).length, mineTrumps = legal.filter(function (x) { return Z.suit(x) === trump; });
        if (out > 0 && mineTrumps.length) {
          var otherTrumps = suitCards(st.hands[other], trump);
          var topNow = highest(mineTrumps);
          if (isTop(st, viewer, topNow) || !otherTrumps.length || high(topNow) >= 13) return topNow;
          return lowest(mineTrumps);
        }
      }
      var tops = legal.filter(function (x) { return isTop(st, viewer, x) && Z.suit(x) !== trump; });
      if (tops.length) {
        var bySuit = tops.map(function (x) { return { c: x, n: suitCards(hand, Z.suit(x)).length + suitCards(st.hands[other], Z.suit(x)).length }; }).sort(function (x, y) { return y.n - x.n; });
        return bySuit[0].c;
      }
      // Establish a long suit: lead low from the leading hand toward the other hand's honors.
      var best = null, bs = -99, d;
      for (d = 0; d < 4; d++) {
        var mine = suitCards(hand, d), theirs = suitCards(st.hands[other], d);
        if (!mine.length || d === trump) continue;
        var sc = mine.length + theirs.length + honorsIn(st.hands[other], d, 13) * 1.5 + honorsIn(hand, d, 13) * 0.5;
        if (sc > bs) { bs = sc; best = d; }
      }
      if (best === null) return lowest(legal);
      return lowest(suitCards(hand, best));
    }
    var lead = Z.suit(trick[0].id), win = trick[0];
    trick.forEach(function (t) { if (beats(t.id, win.id, trump)) win = t; });
    var follow = legal.filter(function (x) { return Z.suit(x) === lead; }), last = trick.length === SEATS - 1, ours = team(win.seat) === team(seat);
    if (follow.length) {
      var winners = follow.filter(function (x) { return beats(x, win.id, trump); });
      if (ours && (last || isTop(st, viewer, win.id))) return lowest(follow);
      if (!winners.length) return lowest(follow);
      if (last) return lowest(winners);
      var sure = winners.filter(function (x) { return isTop(st, viewer, x); });
      if (sure.length) return lowest(sure);
      return ours || trick.length === 1 ? lowest(follow) : highest(winners);
    }
    if (trump >= 0 && !ours) {
      var trumps = legal.filter(function (x) { return Z.suit(x) === trump; }), over = trumps.filter(function (x) { return beats(x, win.id, trump); });
      if (over.length) return lowest(over);
    }
    return discard(st, seat, legal, trump);
  }
  function aiPick(st, seat) {
    var legal = legalPlays(st, seat);
    if (legal.length === 1) return legal[0];
    var declSide = team(st.contract.declarer) === team(seat);
    return declSide ? declarerPick(st, seat, legal) : defenderPick(st, seat, legal);
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  function geo(m) { return T.geometry(m, T.rowsFor(m, HAND)); }
  var cardLabel = function (id) { return Z.cardName(id); };
  // The person looking sits at the bottom (view.viewer); the other seats follow clockwise. Their hand is
  // face down while it is not their turn to act, except dummy, which everyone sees once it is down.
  var relOf = function (seat, V) { return (seat - V + SEATS) % SEATS; };
  function place(st, m, view) {
    var g = geo(m), slots = T.feltSlots(g), cards = [], c = st.contract, sweep = view && st.trick.length === SEATS ? view.sweep : null;
    var L = T.looking(view), V = L.V, up = L.up;
    var actor = st.phase === 'play' && st.trick.length < SEATS ? controller(st, st.turn) : -1;
    // Your hand (face up, playable when you are the one to play it).
    var mineTurn = up && actor === V && st.turn === V;
    var hand = T.handCards(g, st.hands[V], function (id) { return { up: up, dim: mineTurn && !isLegal(st, V, id), label: up ? cardLabel(id) : TX('cards.hidden') }; }, function (a, b) { return Z.suit(a) !== Z.suit(b); });
    slots = slots.concat(hand.slots); cards = cards.concat(hand.cards);
    var dummy = c && st.dummyShown ? c.dummy : -1;
    [1, 2, 3].forEach(function (r) {
      var seat = (V + r) % SEATS;
      if (seat === dummy) {
        var top = Object.assign({}, g, { southY: g.northY + 8 + (T.rowsFor(m, st.hands[seat].length) - 1) * g.rowStep });   // the hand's top row starts under the scores
        var dm = T.handCards(top, st.hands[seat], function (id) { return { dim: actor === V && st.turn === seat && !isLegal(st, seat, id), label: TX('bridge.aria.dummy', { card: cardLabel(id) }) }; }, function (a, b) { return Z.suit(a) !== Z.suit(b); }, 'd');
        slots = slots.concat(dm.slots); cards = cards.concat(dm.cards);
      } else if (!(r === 2 && dummy >= 0 && dummy !== V)) cards = cards.concat(T.fan(g, r, st.phase === 'auction' ? st.hands[seat].slice(0, AUCTION_STACK) : st.hands[seat], false));
    });
    return { height: m.H, slots: slots, cards: cards.concat(T.trickCards(g, st.trick, sweep, function (seat) { return relOf(seat, V); }, view && view.win)) };
  }

  var api = {
    NAMES: NAMES, DEN_LABEL: DEN_LABEL, DEN_NAME: DEN_NAME, DEALS: DEALS,
    parseCall: parseCall, callText: callText, callWords: callWords, bidRank: bidRank, analyze: analyze, legalCalls: legalCalls,
    newGame: freshGame, nextDeal: nextDeal, applyCall: applyCall, legalPlays: legalPlays, isLegal: isLegal, playCard: playCard,
    trickWinner: trickWinner, resolveTrick: resolveTrick, scoreContract: scoreContract, controller: controller, winnerSide: winnerSide,
    hcp: hcp, lengths: lengths, balanced: balanced, openingCall: openingCall, aiBid: aiBid, aiPick: aiPick, inferred: inferred, trumpOf: trumpOf,
    geo: geo, place: place
  };
  root.ZimiBridge = api;
  if (!(root.document && root.document.getElementById('zc-table'))) return;

  // ── The page ────────────────────────────────────────────────────────────
  var AI_MS = 650, HOLD_MS = 950, SWEEP_MS = 380, BOX_GAP = 8;
  // The bidding box is six rows (five denominations and the Pass row) and is made to leave the auction above it in view: its
  // buttons shrink from a full touch target to BID_H_MIN to make room, and an auction that is still too long for what is left
  // shows its latest calls (never less than AUCTION_H_MIN tall).
  var BID_H_MAX = 44, BID_H_MIN = 32, BID_ROWS = 6, BOX_CHROME = 42, AUCTION_H_MIN = 72;
  function boxHeight(rowH) { return rowH * BID_ROWS + BOX_CHROME; }
  var suitSpan = function (den) { return Z.h('span', { class: den === 1 || den === 2 ? 'br-red' : '', text: DEN_LABEL[den] }); };
  function callNode(call, cls) {
    var p = parseCall(call);
    if (p.type === 'bid') return Z.h('span', { class: cls || '' }, [Z.h('span', { text: String(p.level) }), suitSpan(p.den)]);
    return Z.h('span', { class: cls || '', text: p.type === 'pass' ? TX('bridge.pass') : p.type === 'double' ? TX('bridge.dbl') : TX('bridge.rdbl') });
  }
  function boot() {
    var d = root.document, t, board, session, view = { sweep: null, flash: '' }, tg, seats, idOf;
    var table = d.getElementById('zc-table');
    var hot = function () { return seats.hotseat(); };
    // A seat's name: the compass point for a lone person's table, the person's own name when people share it.
    var cn = function (seat) { return hot() ? seats.name(seat) : NAMES[seat]; };
    var you = function (seat) { return seats.isYou(seat); };
    var side = function (k) { return hot() ? TX('bridge.pair', { a: cn(k), b: cn(k + 2) }) : TX(k ? 'bridge.eastWest' : 'bridge.northSouth'); };
    var vulText = function (v) { return v[0] && v[1] ? TX('bridge.vul.both') : v[0] ? side(0) : v[1] ? side(1) : TX('bridge.vul.none'); };
    function repaint() { if (board) board.refresh(); if (t) t.paint(); }
    // Who acts now: the bidder, or the one who plays the card to come (declarer plays dummy's).
    function actorOf(st) { return st.phase === 'auction' ? st.turn : st.phase === 'play' && st.trick.length < SEATS ? controller(st, st.turn) : -1; }
    var auctionEl = Z.h('div', { class: 'br-auction', 'aria-label': TX('bridge.auction') }), boxEl = Z.h('div', { class: 'br-box', role: 'group', 'aria-label': TX('bridge.box') });
    table.appendChild(auctionEl); table.appendChild(boxEl);

    function contractText(st) {
      var c = st.contract;
      if (!c) return '';
      return TX('bridge.contract' + (c.dbl === 1 ? '.doubled' : c.dbl === 2 ? '.redoubled' : ''), { bid: c.level + DEN_LABEL[c.den], name: cn(c.declarer) });
    }
    var auctionSig = '', boxSig = '';
    function paintAuction(st, m) {
      var g = geo(m), V = seats.view(), sig = JSON.stringify([st.auction, st.phase, st.turn, st.dealNo, g.W, g.northY, g.cw, V, [0, 1, 2, 3].map(cn)]);
      if (sig === auctionSig) return;
      auctionSig = sig;
      auctionEl.textContent = '';
      if (st.phase === 'play' && st.contract) { auctionEl.hidden = true; return; }
      if (st.phase !== 'auction' && !st.auction.length) { auctionEl.hidden = true; return; }
      auctionEl.hidden = false;
      var width = Math.min(236, g.W - 2 * (g.cw * 1.4) - 8);
      width = Math.max(width, 200);
      auctionEl.style.width = width + 'px';
      auctionEl.style.left = Math.round(g.cx - width / 2) + 'px'; auctionEl.style.top = Math.round(g.northY + g.ch + 14) + 'px';
      var order = [1, 2, 3, 0], grid = Z.h('div', { class: 'br-grid' });
      order.forEach(function (seat) { grid.appendChild(Z.h('b', { class: 'br-head' + (seat === V ? ' br-you' : ''), text: seat === V && you(seat) ? TX('cards.you') : cn(seat) })); });
      var cells = [], pad = order.indexOf(st.dealer), k;
      for (k = 0; k < pad; k++) cells.push(null);
      st.auction.forEach(function (e) { cells.push(e); });
      cells.forEach(function (e, i) { grid.appendChild(e ? Z.h('span', { class: 'br-call' + (i === cells.length - 1 ? ' br-latest' : '') }, [callNode(e.call)]) : Z.h('span', { class: 'br-call' })); });
      if (st.phase === 'auction') grid.appendChild(Z.h('span', { class: 'br-call br-next', text: st.turn === V ? '?' : '…' }));
      auctionEl.appendChild(Z.h('p', { class: 'br-cap', text: TX('bridge.cap', { n: st.dealNo + 1, of: DEALS, dealer: cn(st.dealer), vul: vulText(st.vul) }) }));
      auctionEl.appendChild(grid);
    }
    function paintBox(st, m) {
      var g = geo(m), V = seats.view(), mine = st.phase === 'auction' && st.turn === V, legal = mine ? legalCalls(st, V) : [];
      var shown = !auctionEl.hidden, natural = shown ? auctionEl.scrollHeight : 0;
      var sig = JSON.stringify([mine, V, legal, Math.round(g.statusY), g.W, natural, shown ? auctionEl.style.top : 0]);
      if (sig === boxSig) return;
      boxSig = sig;
      boxEl.textContent = '';
      boxEl.hidden = !mine;
      auctionEl.style.maxHeight = '';
      if (!mine) return;
      // What is left between the auction's top and the box's bottom edge (both in the table's own coordinates).
      var room = g.statusY - BOX_GAP - (shown ? parseFloat(auctionEl.style.top) + BOX_GAP : 0), rowH = BID_H_MAX;
      while (rowH > BID_H_MIN && boxHeight(rowH) + natural > room) rowH -= 2;
      if (shown && boxHeight(rowH) + natural > room) {
        auctionEl.style.maxHeight = Math.max(room - boxHeight(rowH), AUCTION_H_MIN) + 'px';
        auctionEl.scrollTop = auctionEl.scrollHeight;
      }
      boxEl.style.setProperty('--br-bid-h', rowH + 'px');
      var grid = Z.h('div', { class: 'br-levels' }), level, den;
      for (den = 0; den <= NT; den++) for (level = 1; level <= MAX_LEVEL; level++) {
        var call = bidCall(level, den), b = Z.h('button', { class: 'ar-btn br-bid', type: 'button', 'aria-label': TX('bridge.bidAria', { level: level, den: DEN_NAME[den] }) }, [callNode(call)]);
        b.disabled = legal.indexOf(call) < 0;
        b.addEventListener('click', (function (cl) { return function () { bidMine(cl); }; })(call));
        grid.appendChild(b);
      }
      var row = Z.h('div', { class: 'br-row' });
      [['P', TX('bridge.pass')], ['X', TX('bridge.double')], ['XX', TX('bridge.redouble')]].forEach(function (x) {
        var b = Z.h('button', { class: 'ar-btn br-bid br-wide', type: 'button', text: x[1] });
        b.disabled = legal.indexOf(x[0]) < 0;
        b.addEventListener('click', function () { bidMine(x[0]); });
        row.appendChild(b);
      });
      boxEl.appendChild(grid); boxEl.appendChild(row);
      boxEl.style.bottom = Math.round(m.H - g.statusY + BOX_GAP) + 'px';
    }
    function hud(st) {
      var m = board.metrics(), c = st.contract;
      paintAuction(st, m); paintBox(st, m);
      var V = seats.view(), us = team(V), actor = actorOf(st);
      var chips = hot() ? [{ name: TX('bridge.ns'), text: String(st.totals[0]) }, { name: TX('bridge.ew'), text: String(st.totals[1]) }] : [{ name: TX('cards.team.us'), text: String(st.totals[us]) }, { name: TX('cards.team.them'), text: String(st.totals[1 - us]) }];
      var out = { chips: chips, trump: c && c.den < NT ? c.den : undefined, fact: c && st.phase === 'play' ? contractText(st) : TX('skat.fact', { n: st.dealNo + 1, of: DEALS }), text: '' };
      if (st.phase === 'auction') out.text = st.turn === V ? TX(you(V) ? 'bridge.yourCall' : 'bridge.nameCall', { name: cn(V) }) : TX(seats.person(st.turn) ? 'ce.next' : 'bridge.bidding', { name: cn(st.turn) });
      else if (st.phase === 'dealEnd') { out.text = TX('skat.dealOver'); out.label = TX('skat.nextDeal'); out.action = tg.startNextHand; }
      else if (st.phase === 'over') { out.text = TX('bridge.matchOver'); out.label = TX('shell.menu.new'); out.action = newGame; }
      else {
        chips.push({ name: TX('truco.tricks'), text: hot() ? TX('bridge.ns') + ' ' + st.tricks[0] + ' \u00b7 ' + TX('bridge.ew') + ' ' + st.tricks[1] : st.tricks[us] + '-' + st.tricks[1 - us] });
        if (st.trick.length === SEATS) { var w = trickWinner(st.trick, trumpOf(st)); out.text = you(w) ? TX('cards.trick.you') : TX('cards.trick.name', { name: cn(w) }); }
        else if (actor === V) out.text = st.turn === V ? TX(you(V) ? 'cards.turn.you' : 'cards.turn.name', { name: cn(V) }) : TX('bridge.playDummy', { name: cn(st.turn) });
        else if (seats.person(actor)) out.text = TX('ce.next', { name: cn(actor) });
        else if (c.dummy === V) out.text = TX(hot() ? 'bridge.playsHand.name' : 'bridge.playsHand', { declarer: cn(c.declarer), name: cn(V), next: cn(st.turn) });
        else out.text = TX('cards.thinking', { name: cn(st.turn) });
      }
      return out;
    }
    function drive() {
      var st = session.state;
      if (st.phase === 'auction') { if (seats.person(st.turn)) seats.ensure(st.turn, tg.repaint); else session.later(aiBidTurn, AI_MS); return; }
      if (st.phase === 'dealEnd' || st.phase === 'over') { finishDeal(); return; }
      tg.turn(st);
    }
    function afterCall() {
      var st = session.state;
      if (st.phase === 'dealEnd' || st.phase === 'over') { drive(); return; }
      if (st.phase === 'play') flashContract();
      drive();
    }
    function flashContract() { var st = session.state; t.flash(TX('bridge.flash', { contract: contractText(st) })); }
    function aiBidTurn() {
      var st = session.state;
      if (st.phase !== 'auction' || seats.person(st.turn)) return;
      session.follow(applyCall(st, st.turn, aiBid(st, st.turn)));
      afterCall();
    }
    function bidMine(call) {
      var st = session.state;
      if (st.phase !== 'auction' || st.turn !== seats.view()) return;
      session.commit(applyCall(st, st.turn, call));
      afterCall();
    }
    function resultLines(st) {
      var r = st.result, c = st.contract, lines = [];
      if (r.passedOut) return r.lines;
      lines.push(TX(r.made ? 'bridge.made' : 'bridge.wentDown', { contract: contractText(st), down: r.need - r.taken, taken: r.taken, need: r.need }));
      r.lines.forEach(function (x) { lines.push(x); });
      lines.push(TX('bridge.thisDeal', { ns: (r.points[0] >= 0 ? '+' : '') + r.points[0], ew: (r.points[1] >= 0 ? '+' : '') + r.points[1] }));
      lines.push(TX('bridge.totals', { ns: st.totals[0], ew: st.totals[1] }));
      return lines;
    }
    // The deal's summary: who made or went down, the scoring, and each side's deal and running score.
    function dealSummary(st) {
      var r = st.result, c = st.contract, top = Math.max(st.totals[0], st.totals[1]);
      return {
        headline: r.passedOut ? TX('bridge.passedOut') : TX(r.made ? 'bridge.sum.made' : 'bridge.sum.down', { side: side(r.declSide), contract: c.level + DEN_LABEL[c.den] + ['', ' X', ' XX'][c.dbl || 0], down: r.need - r.taken }),
        detail: r.passedOut ? [] : [TX('bridge.sum.tricks', { taken: r.taken, need: r.need })].concat(r.lines),
        rows: [0, 1].map(function (k) { return { name: side(k), delta: r.points[k], total: st.totals[k], lead: st.totals[k] === top }; })
      };
    }
    var shown = -1;
    function finishDeal() {
      var st = session.state;
      if (shown === st.dealNo + (st.phase === 'over' ? 100 : 0)) return;
      shown = st.dealNo + (st.phase === 'over' ? 100 : 0);
      if (st.phase === 'dealEnd') T.summarySheet(Object.assign({ title: TX('skat.fact', { n: st.dealNo + 1, of: DEALS }), actions: [{ label: TX('skat.nextDeal'), primary: true, onclick: tg.startNextHand }] }, dealSummary(st)));
      else {
        var V = seats.view(), us = team(V), w = winnerSide(st.totals), mine = !hot() && w === us;
        var lines = resultLines(st).concat([w < 0 ? TX('bridge.tied') : TX('bridge.winMatch', { who: mine ? TX('bridge.youAnd', { name: cn(partnerOf(V)) }) : side(w), a: st.totals[w], b: st.totals[1 - w] })]);
        if (mine) session.win(st.totals[us]); else session.lose(w < 0 ? 'draw' : hot() ? { name: side(w), team: true } : '', lines, hot() ? undefined : st.totals[us]);
      }
    }
    function tap(pile) {
      var st = session.state, id = idOf(pile), kind = pile.charAt(0);
      if ((kind !== 'h' && kind !== 'd') || isNaN(id) || st.phase !== 'play') return false;
      var V = seats.view(), seat = kind === 'h' ? V : st.contract.dummy;
      if (view.hideHand) return false;
      if (st.trick.length === SEATS) { t.flash(TX('cards.wait.trick')); return false; }
      if (controller(st, st.turn) !== V) { t.flash(TX('cards.wait.turn')); return false; }
      if (st.turn !== seat) { t.flash(TX(st.turn === V ? 'bridge.ownHand' : 'bridge.fromDummy')); return false; }
      if (!isLegal(st, seat, id)) { t.flash(TX('cards.follow', { suit: TX('cards.suit.' + ['clubs', 'diamonds', 'hearts', 'spades'][Z.suit(st.trick[0].id)]) })); return false; }
      return tg.play(id, seat);
    }
    function newGame() { tg.restart(freshGame(Z.shuffled(Math.random))); }

    tg = T.trickGame({
      id: 'bridge', n: SEATS, view: view, ms: { ai: AI_MS, hold: HOLD_MS, sweep: SWEEP_MS }, drive: drive, handEnd: 'dealEnd',
      seatOpts: { cpuNames: NAMES, onChange: function () { repaint(); } },
      actor: actorOf, control: function (st) { return controller(st, st.turn); }, shown: function (st, V) { return st.dummyShown && st.contract && st.contract.dummy === V; },
      winner: function (st) { return trickWinner(st.trick, trumpOf(st)); }, resolve: resolveTrick, nextHand: nextDeal, clear: function () { shown = -1; },
      legal: isLegal, play: playCard, aiPlay: aiPick
    });
    seats = tg.seats; idOf = tg.idOf;
    function auctionLines(st) {
      var rows = [], k;
      for (k = 0; k < st.auction.length; k++) rows.push((st.auction[k].seat === seats.view() && you(seats.view()) ? TX('cards.you') : cn(st.auction[k].seat)) + ' ' + callText(st.auction[k].call));
      return rows.join(', ');
    }
    t = tg.create({
      name: 'Bridge', geo: geo, place: place, hud: hud, newGame: newGame, tap: tap,
      canPick: function (st, pile) { return st.phase === 'play' && (pile.charAt(0) === 'h' || pile.charAt(0) === 'd'); },
      move: function (pile, idx, to) { return (to === 'trick' || to === 'deck') && (pile.charAt(0) === 'h' || pile.charAt(0) === 'd') ? tap(pile) : false; },
      stat: function (sec, st) { var us = team(seats.view()); return Z.fmtTime(sec) + ' · ' + st.totals[us] + '-' + st.totals[1 - us]; },
      cascadeOrder: function (st) { var V = seats.view(); return st.orig[V].concat(st.orig[partnerOf(V)]).map(function (id) { return { id: id }; }); },
      winLines: function (sec, st) { var us = team(seats.view()); return [TX('bridge.winAfter', { name: cn(partnerOf(seats.view())), a: st.totals[us], b: st.totals[1 - us], n: DEALS })]; },
      menuExtra: function () {
        var st = session.state, rows = [];
        if (st && st.auction.length) rows.push(Z.h('p', { class: 'zc-note', text: TX('bridge.auctionNote', { list: auctionLines(st) }) }));
        return rows;
      },
      rules: TX('bridge.rules')
    });
    board = t.board; session = t.session;
    api.session = session; api.board = board;
    if (root.ResizeObserver) new root.ResizeObserver(function () { t.paint(); }).observe(table);
    newGame();
  }
  boot();
})(typeof globalThis !== 'undefined' ? globalThis : window);
