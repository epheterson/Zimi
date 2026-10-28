/* ZimiGames: Flags. "Which country's flag is this?" The player's Wikipedia has a list of the national flags of sovereign
   states ("List of national flags of sovereign states": a picture and a name per row). A round takes some of them that
   load, and four names to choose from. With no such page, or no pictures in the ZIM, it draws the flags in flags-data.js
   as SVG: nothing is fetched. The rules are pure functions (no DOM, so node can test them), then the page (RoundKit).
   Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  var Lib = root.GamesLib;

  // ── the rules ────────────────────────────────────────────────────────────
  var QUESTIONS = 8, CHOICES = 4, TRIES = 20, CONCURRENCY = 4, PAGE_BYTES = 900000, MAX_FLAGS = 220;
  var PAGE = 'List_of_national_flags_of_sovereign_states';
  var FIELD_W = 90, FIELD_H = 60, STAR_INNER = 0.382, STAR_GRID = 5.6, STAR_R = 1.5;

  // The flags in a page's rows: a row that names a country (a header cell) and starts with its picture. [{name, src}]
  function readFlags(rows) {
    var seen = {}, out = [];
    rows.forEach(function (cells) {
      var head = cells.filter(function (c) { return c.head && c.text; })[0], pic = cells[0];
      if (!head || !pic || !pic.img || out.length >= MAX_FLAGS) return;
      var name = (head.link || head.text).replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim(), key = Lib.fold(name);
      if (!name || seen[key]) return;
      seen[key] = true; out.push({ name: name, src: pic.img, href: head.href || '' });
    });
    return out;
  }

  // Four names for a flag: the right one and three others of the list.
  function question(flag, pool, rng) {
    var others = [], seen = [Lib.fold(flag.name)];
    Lib.shuffle(pool, rng).forEach(function (f) { var k = Lib.fold(f.name); if (others.length < CHOICES - 1 && seen.indexOf(k) < 0) { seen.push(k); others.push(f.name); } });
    if (others.length < CHOICES - 1) return null;
    var q = { kind: 'flag', picture: flag.url || flag.picture, answer: flag.name, choices: Lib.shuffle([flag.name].concat(others), rng) };
    if (flag.path && flag.zim) { q.path = flag.path; q.zim = flag.zim; }   // the country's article, for the learn-more link
    return q;
  }

  // A round from the list: `check(url)` says whether a picture loads; flags whose picture does not are left out.
  function libraryRound(flags, check, count, rng) {
    var pick = Lib.shuffle(flags, rng).slice(0, TRIES), out = [], at = 0;
    function lane() {
      if (at >= pick.length || out.length >= count) return Promise.resolve();
      var f = pick[at++];
      return check(f.url).then(function (ok) {
        var q = ok && out.length < count ? question(f, flags, rng) : null;
        if (q) out.push(q);
      }).then(lane);
    }
    var lanes = [];
    for (var i = 0; i < CONCURRENCY; i++) lanes.push(lane());
    return Promise.all(lanes).then(function () { return out; });
  }

  // A flag's shapes as one SVG string (a data address goes in an <img>, so nothing in the page is drawn by hand).
  function star(c, cx, cy, r) {
    var pts = [];
    for (var i = 0; i < 10; i++) {
      var a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * STAR_INNER : r;
      pts.push((cx + rr * Math.cos(a)).toFixed(2) + ',' + (cy + rr * Math.sin(a)).toFixed(2));
    }
    return '<polygon fill="' + c + '" points="' + pts.join(' ') + '"/>';
  }
  function bands(dir, cols) {
    var items = cols.map(function (c) { return Array.isArray(c) ? c : [c, 1]; }), total = items.reduce(function (s, c) { return s + c[1]; }, 0), at = 0, out = '';
    items.forEach(function (c) {
      var span = (dir === 'h' ? FIELD_H : FIELD_W) * c[1] / total;
      out += dir === 'h' ? '<rect fill="' + c[0] + '" x="0" y="' + at.toFixed(2) + '" width="' + FIELD_W + '" height="' + (span + 0.2).toFixed(2) + '"/>'
        : '<rect fill="' + c[0] + '" y="0" x="' + at.toFixed(2) + '" height="' + FIELD_H + '" width="' + (span + 0.2).toFixed(2) + '"/>';
      at += span;
    });
    return out;
  }
  function shapeSVG(op) {
    var k = op[0];
    if (k === 'h' || k === 'v') return bands(k, op.slice(1));
    if (k === 'rect') return '<rect fill="' + op[1] + '" x="' + op[2] + '" y="' + op[3] + '" width="' + op[4] + '" height="' + op[5] + '"/>';
    if (k === 'disc') return '<circle fill="' + op[1] + '" cx="' + op[2] + '" cy="' + op[3] + '" r="' + op[4] + '"/>';
    if (k === 'ring') return '<circle fill="none" stroke="' + op[1] + '" stroke-width="' + op[5] + '" cx="' + op[2] + '" cy="' + op[3] + '" r="' + op[4] + '"/>';
    if (k === 'star') return star(op[1], op[2], op[3], op[4]);
    if (k === 'poly') return '<polygon fill="' + op[1] + '" points="' + op[2] + '"/>';
    if (k === 'line') return '<polygon fill="none" stroke="' + op[1] + '" stroke-width="' + op[2] + '" points="' + op[3] + '"/>';
    if (k === 'cross') return '<rect fill="' + op[1] + '" x="' + (op[2] - op[4] / 2) + '" y="0" width="' + op[4] + '" height="' + FIELD_H + '"/><rect fill="' + op[1] + '" x="0" y="' + (op[3] - op[4] / 2) + '" width="' + FIELD_W + '" height="' + op[4] + '"/>';
    if (k === 'stars') {
      var s = '';
      for (var r = 0; r < op[5]; r++) for (var c = 0; c < op[4]; c++) s += star(op[1], op[2] + c * STAR_GRID, op[3] + r * STAR_GRID, STAR_R);
      return s;
    }
    return '';
  }
  function svgOf(shapes) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + FIELD_W + ' ' + FIELD_H + '" width="' + FIELD_W * 4 + '" height="' + FIELD_H * 4 + '">' + shapes.map(shapeSVG).join('') + '</svg>';
  }
  function dataUrl(svg) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); }

  // The built-in flags as the same questions.
  function miniRound(data, count, rng) {
    var flags = data.map(function (d) { return { name: d[0], picture: dataUrl(svgOf(d[1])) }; });
    return Lib.sample(flags, count, rng).map(function (f) { return question(f, flags, rng); }).filter(Boolean);
  }

  root.FlagsEngine = { readFlags: readFlags, question: question, libraryRound: libraryRound, svgOf: svgOf, dataUrl: dataUrl, miniRound: miniRound, QUESTIONS: QUESTIONS };
  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var zimName = '';
  function loads(url) {
    return new Promise(function (ok) {
      var img = new Image(), timer = setTimeout(function () { ok(false); }, 8000);
      img.onload = function () { clearTimeout(timer); ok(img.naturalWidth > 0); };
      img.onerror = function () { clearTimeout(timer); ok(false); };
      img.src = url;
    });
  }
  root.RoundKit.run({
    id: 'flags', what: 'flags',
    kinds: { flag: 'flags.kind.flag' },
    text: { choosing: 'flags.choosing', alt: 'flags.pictureAlt' },
    label: function (c) { return Lib.countryName(c); },
    init: function (list) {
      var a = Lib.pickZim(list, 'wikipedia', Lib.uiLang());
      zimName = a && Lib.primaryLang(a.zim.language) === 'en' ? a.zim.name : '';   // the list is English Wikipedia's page
    },
    build: function () {
      if (!zimName) return Promise.resolve(null);
      return Lib.pageHead(zimName, [PAGE], PAGE_BYTES).then(function (got) {
        if (!got) return null;
        var flags = readFlags(Lib.rows(got.html)).map(function (f) {
          var path = Lib.resolvePath(zimName, got.path, f.src, Lib.pathRoot());
          return path ? { name: f.name, url: Lib.articleUrl(zimName, path), path: Lib.resolvePath(zimName, got.path, f.href, Lib.pathRoot()), zim: zimName } : null;
        }).filter(Boolean);
        if (flags.length < CHOICES) return null;
        return libraryRound(flags, loads, QUESTIONS, Math.random).then(function (round) { return round.length >= QUESTIONS / 2 ? { round: round, zim: zimName } : null; });
      });
    },
    builtIn: function () { return miniRound(root.FLAGS_MINI, QUESTIONS, Math.random); }
  });
})(this);
