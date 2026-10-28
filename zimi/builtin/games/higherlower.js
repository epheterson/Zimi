/* ZimiGames: Higher or Lower. Two places or things, one question: which has more people, a bigger area, a greater height,
   a longer course? The numbers come from the player's Wikipedia, from the lists it already holds ("List of countries and
   dependencies by population", by area, "List of highest mountains on Earth", "List of longest rivers"), read from the
   start of each page: nothing is looked up one thing at a time. Where those pages are missing (another language, no
   Wikipedia) it asks the built-in numbers in higherlower-data.js. The rules are pure functions (no DOM, so node can test
   them), then the page (RoundKit). Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  var Lib = root.GamesLib;

  // ── the rules ────────────────────────────────────────────────────────────
  var QUESTIONS = 8, MIN_ROWS = 10, MIN_RATIO = 1.15, PAGE_BYTES = 450000, WELL_KNOWN = 80;   // the biggest of each list: the ones a player has heard of
  // Each list: the page, the header of the column that names the thing and of the one that counts it, the words for what is asked.
  var LISTS = {
    population: { page: 'List_of_countries_and_dependencies_by_population', name: /^(location|country|dependency|country \/ dependency|name)/i, value: /^population/i },
    area: { page: 'List_of_countries_and_dependencies_by_area', name: /^(country|location|dependency|country \/ dependency)/i, value: /^total/i },
    height: { page: 'List_of_highest_mountains_on_Earth', name: /^mountain/i, value: /^height/i },
    length: { page: 'List_of_longest_rivers', name: /^river/i, value: /^length \(?km/i }
  };
  var NOT_A_THING = /^(world|earth|total|global|antarctica|–|—|-)$/i;

  // A row's name as a question shows it: no notes, and a river's first name ("Nile–White Nile–Kagera" is the Nile).
  function cleanName(text, split) {
    var n = String(text || '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
    return split ? n.split(/[–—]/)[0].trim() : n;
  }

  // The things of one list in a page's rows: the rows below the header that names both columns, up to the next header.
  function readList(rows, kind) {
    var def = LISTS[kind], out = [], nameAt = -1, valueAt = -1, started = false;
    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i], heads = cells.filter(function (c) { return c.head; });
      if (heads.length >= 2) {
        var n = -1, v = -1;
        cells.forEach(function (c, k) { if (c.head && n < 0 && def.name.test(c.text)) n = k; if (c.head && v < 0 && def.value.test(c.text)) v = k; });
        if (started) break;
        if (n >= 0 && v >= 0) { nameAt = n; valueAt = v; started = true; }
        continue;
      }
      if (!started) continue;
      var cell = cells[nameAt] || {}, name = cleanName(cell.link || cell.text, kind === 'length'), value = Lib.number((cells[valueAt] || {}).text);
      if (name && !NOT_A_THING.test(name) && isFinite(value) && value > 0) out.push({ name: name, value: value, href: cell.href || '' });
    }
    var seen = {};
    return out.filter(function (t) { var k = Lib.fold(t.name); return !seen[k] && (seen[k] = true); });
  }

  // A question: which of two is greater. Two things that are nearly equal make no fair question.
  function question(kind, a, b, rng) {
    if (!a || !b || a.name === b.name || Math.max(a.value, b.value) / Math.min(a.value, b.value) < MIN_RATIO) return null;
    var big = a.value > b.value ? a : b;
    var q = { kind: kind, answer: big.name, choices: Lib.shuffle([a.name, b.name], rng), facts: [[a.name, a.value], [b.name, b.value]] };
    if (big.path && big.zim) { q.path = big.path; q.zim = big.zim; }   // the answer's article, for the learn-more link
    return q;
  }

  // A round: the lists (kind -> things) taken in turn, a pair at a time, no thing twice.
  function makeRound(lists, count, rng) {
    var top = {}, out = [], used = {}, guard = 0;
    Object.keys(lists).forEach(function (k) { top[k] = lists[k].slice().sort(function (a, b) { return b.value - a.value; }).slice(0, WELL_KNOWN); });
    var kinds = Object.keys(top).filter(function (k) { return top[k].length >= 2; });
    kinds = Lib.shuffle(kinds, rng);
    while (out.length < count && kinds.length && guard++ < count * 40) {
      var kind = kinds[out.length % kinds.length], pool = top[kind].filter(function (t) { return !used[kind + t.name]; });
      if (pool.length < 2) { kinds.splice(kinds.indexOf(kind), 1); continue; }
      var two = Lib.sample(pool, 2, rng), q = question(kind, two[0], two[1], rng);
      if (q) { out.push(q); used[kind + two[0].name] = used[kind + two[1].name] = true; }
    }
    return out;
  }

  // The built-in numbers as the same lists.
  function miniLists(root_) {
    var c = root_.HIGHLOW_COUNTRIES || [];
    return {
      population: c.map(function (r) { return { name: r[0], value: r[1] * 1e6 }; }),
      area: c.map(function (r) { return { name: r[0], value: r[2] * 1e3 }; }),
      height: (root_.HIGHLOW_MOUNTAINS || []).map(function (r) { return { name: r[0], value: r[1] }; }),
      length: (root_.HIGHLOW_RIVERS || []).map(function (r) { return { name: r[0], value: r[1] }; })
    };
  }

  root.HighLowEngine = { readList: readList, question: question, makeRound: makeRound, miniLists: miniLists, cleanName: cleanName, LISTS: LISTS, QUESTIONS: QUESTIONS };
  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, T = Play.T, zimName = '';
  var COMPACT_FROM = 1e6;   // a million and up as 17M; heights and lengths in full
  var nf = function (n) { try { return new Intl.NumberFormat(Lib.uiLang(), n >= COMPACT_FROM ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 0 }).format(n); } catch (e) { return String(Math.round(n)); } };
  // Countries are named in the player's language; mountains and rivers keep their names.
  function countryOf(q, name) { return q.kind === 'population' || q.kind === 'area' ? Lib.countryName(name) : name; }
  // "France: 68M people · Spain: 48M people" under the answer, in the figures' own units.
  function detailOf(q) {
    return q.facts.map(function (f) { return T('highlow.fact', { name: Lib.iso(countryOf(q, f[0])), value: T('highlow.value.' + q.kind, { n: nf(f[1]) }) }); }).join(' · ');
  }
  // A thing with the path of its article in the ZIM, when its row linked to one.
  function withPage(t, fromPath) {
    var path = Lib.resolvePath(zimName, fromPath, t.href, Lib.pathRoot());
    if (path) { t.path = path; t.zim = zimName; }
    return t;
  }
  function withDetails(round) { round.forEach(function (q) { q.detail = detailOf(q); }); return round; }

  root.RoundKit.run({
    id: 'highlow', what: 'facts',
    kinds: { population: 'highlow.kind.population', area: 'highlow.kind.area', height: 'highlow.kind.height', length: 'highlow.kind.length' },
    text: { choosing: 'highlow.choosing', alt: 'round.pictureAlt' },
    label: function (c, q) { return countryOf(q, c); },
    english: function (q) { return q.kind === 'height' || q.kind === 'length' ? 'lang.enNames' : ''; },
    init: function (list) {
      var a = Lib.pickZim(list, 'wikipedia', Lib.uiLang());
      zimName = a && Lib.primaryLang(a.zim.language) === 'en' ? a.zim.name : '';   // the lists are English Wikipedia's pages
    },
    build: function () {
      if (!zimName) return Promise.resolve(null);
      var kinds = Object.keys(LISTS);
      return Promise.all(kinds.map(function (k) {
        return Lib.pageHead(zimName, [LISTS[k].page], PAGE_BYTES).then(function (got) { return got ? readList(Lib.rows(got.html), k).map(function (t) { return withPage(t, got.path); }) : []; }, function () { return []; });
      })).then(function (all) {
        var lists = {};
        kinds.forEach(function (k, i) { if (all[i].length >= MIN_ROWS) lists[k] = all[i]; });
        var round = makeRound(lists, QUESTIONS, Math.random);
        return round.length >= QUESTIONS / 2 ? { round: withDetails(round), zim: zimName } : null;
      });
    },
    builtIn: function () { return withDetails(makeRound(miniLists(root), QUESTIONS, Math.random)); }
  });
})(this);
