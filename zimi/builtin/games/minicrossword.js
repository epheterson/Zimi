/* ZimiGames: Mini Crossword. A five by five grid with four blocks, three words across and three down, every letter in a
   word. The grid is built here from everyday five-letter words (minicrossword-data.js, each with a clue of its own); with an
   English Wiktionary in the player's library (Zimi or kiwix-serve) each clue is that word's first definition there, with
   the word taken out of it, and the built-in clue only where the Wiktionary has none. Daily (the same grid for everyone that
   day) and practice. The rules are pure functions (no DOM, so node can test them), then the page. Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  var Lib = root.GamesLib;

  // ── the rules ────────────────────────────────────────────────────────────
  var SIZE = 5, LEN = 5, TRIES = 600, CLUE_MAX = 80, CLUE_MIN = 8;
  var BLOCKS = [[1, 1], [1, 3], [3, 1], [3, 3]];
  // The six words in the order a grid holds them: across 1, 4 and 5 (rows 0, 2, 4), down 1, 2 and 3 (columns 0, 2, 4).
  var ENTRIES = [
    { num: 1, dir: 'a', r: 0, c: 0 }, { num: 4, dir: 'a', r: 2, c: 0 }, { num: 5, dir: 'a', r: 4, c: 0 },
    { num: 1, dir: 'd', r: 0, c: 0 }, { num: 2, dir: 'd', r: 0, c: 2 }, { num: 3, dir: 'd', r: 0, c: 4 }
  ];
  var NUMBERED = { 0: 1, 2: 2, 4: 3, 10: 4, 20: 5 };   // the cells that carry a number
  function isBlock(i) { return BLOCKS.some(function (b) { return b[0] * SIZE + b[1] === i; }); }
  // The cells (indexes into the 25) of entry e, in order.
  function cellsOf(e) {
    var out = [];
    for (var k = 0; k < LEN; k++) out.push(e.dir === 'a' ? e.r * SIZE + e.c + k : (e.r + k) * SIZE + e.c);
    return out;
  }
  // The solution as 25 letters ('' for a block).
  function solution(words) {
    var cells = [];
    for (var i = 0; i < SIZE * SIZE; i++) cells.push('');
    ENTRIES.forEach(function (e, n) { cellsOf(e).forEach(function (i, k) { cells[i] = words[n].charAt(k); }); });
    return cells;
  }
  // A grid from a pool of words: three across, then the three down that must cross them, no word twice. null if none fit.
  function generate(pool, rng) {
    var idx = {}, starts = {};
    pool.forEach(function (w) { var k = w.charAt(0) + w.charAt(2) + w.charAt(4); (idx[k] = idx[k] || []).push(w); starts[k.slice(0, 2)] = true; });
    for (var t = 0; t < TRIES; t++) {
      var a0 = pool[Math.floor(rng() * pool.length)], a2 = pool[Math.floor(rng() * pool.length)];
      if (a0 === a2 || ![0, 2, 4].every(function (c) { return starts[a0.charAt(c) + a2.charAt(c)]; })) continue;
      var order = Lib.shuffle(pool, rng);
      for (var i = 0; i < order.length; i++) {
        var a4 = order[i];
        if (a4 === a0 || a4 === a2) continue;
        var across = [a0, a2, a4], down = [];
        var ok = [0, 2, 4].every(function (c) {
          var opts = (idx[a0.charAt(c) + a2.charAt(c) + a4.charAt(c)] || []).filter(function (d) { return across.indexOf(d) < 0 && down.indexOf(d) < 0; });
          if (!opts.length) return false;
          down.push(opts[Math.floor(rng() * opts.length)]);
          return true;
        });
        if (ok && new Set(across.concat(down)).size === 6) return across.concat(down);
      }
    }
    return null;
  }

  // A clue from a dictionary's definition of `word`: no leading label, never the word itself, cut to a line. '' when it
  // is not a meaning ("plural of table") or too little is left to be a clue.
  var NOT_A_MEANING = /^(?:plural|past|present|third[- ]person|simple past|alternative|obsolete|archaic|misspelling|nonstandard|eye dialect|initialism|abbreviation|comparative|superlative|gerund|inflection|form of|variant)\b/i;
  function clueFrom(def, word) {
    var t = String(def || '').replace(/\s+/g, ' ').replace(/^\s*(?:\([^)]*\)\s*)+/, '').replace(/^[:;,.\s]+/, '').trim();
    if (!t || NOT_A_MEANING.test(t)) return '';
    t = t.replace(new RegExp('(?<![\\p{L}])' + word + '\\p{L}*', 'giu'), '_____');
    if (t.length > CLUE_MAX) t = t.slice(0, CLUE_MAX).replace(/[\s,;:(]+\S*$/, '') + '…';
    t = t.replace(/[.;:,\s]+$/, '');
    if (t.replace(/_____/g, '').trim().length < CLUE_MIN) return '';
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  // The built-in pool: every word with a clue.
  function builtInPool(clues) { return Object.keys(clues || {}); }

  // How many entries are filled in full, and whether the whole grid is right.
  function solved(cells, sol) { return sol.every(function (l, i) { return !l || cells[i] === l; }); }
  function wrongCells(cells, sol) { var out = []; cells.forEach(function (l, i) { if (l && sol[i] && l !== sol[i]) out.push(i); }); return out; }

  root.MiniCrosswordEngine = { generate: generate, solution: solution, cellsOf: cellsOf, clueFrom: clueFrom, builtInPool: builtInPool, solved: solved, wrongCells: wrongCells, isBlock: isBlock, ENTRIES: ENTRIES, SIZE: SIZE };
  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  Play.applyTheme();
  var STATS_KEY = 'zimi.games.minicrossword.stats', ROWS = ['qwertyuiop', 'asdfghjkl', '#zxcvbnm'], FIVE_API = '/dictionary/five', DEFINE_MS = 12000;
  var els = { clue: $('cw-clue'), grid: $('cw-grid'), msg: $('cw-msg'), hint: $('cw-hint'), check: $('cw-check'), keys: $('cw-keys'), across: $('cw-across'), down: $('cw-down'), newBtn: $('cw-new') };
  var status = Play.status(els.msg);
  var g = null, sol = null, cellEls = [], dict = '', pendingMode = null, done = false, building = false, wrongs = [];
  var today = Lib.dayKey(new Date());

  function entryOf(idx, dir) {
    for (var n = 0; n < ENTRIES.length; n++) if (ENTRIES[n].dir === dir && cellsOf(ENTRIES[n]).indexOf(idx) >= 0) return n;
    return -1;
  }
  // The entry the selection is in: the chosen direction's, else the other (a cell is in one or two).
  function currentEntry() { var n = entryOf(g.sel, g.dir); return n >= 0 ? n : entryOf(g.sel, g.dir === 'a' ? 'd' : 'a'); }
  function dirName(e) { return T(e.dir === 'a' ? 'minicw.across' : 'minicw.down'); }

  // ── where the clues come from ──
  function defineWord(word) {
    var work = Lib.modeNow() === 'kiwix'
      ? Lib.pageHead(dict, [word], 60000, DEFINE_MS).then(function (got) { return got ? Lib.firstDefinition(got.html) : ''; })
      : Lib.json(FIVE_API + '?zim=' + encodeURIComponent(dict) + '&define=' + encodeURIComponent(word), DEFINE_MS).then(function (r) { return r && r.blurb ? r.blurb : ''; });
    return work.then(function (d) { return clueFrom(d, word); }, function () { return ''; });
  }
  function cluesFor(words) {
    var own = root.MINICW_CLUES;
    if (!dict) return Promise.resolve({ clues: words.map(function (w) { return own[w]; }), lib: words.map(function () { return false; }) });
    return Promise.all(words.map(defineWord)).then(function (defs) {
      return { clues: defs.map(function (d, i) { return d || own[words[i]]; }), lib: defs.map(function (d) { return !!d; }) };
    });
  }

  // ── drawing ──
  function build() {
    els.grid.innerHTML = ''; cellEls = [];
    for (var i = 0; i < SIZE * SIZE; i++) {
      var b;
      if (isBlock(i)) { b = document.createElement('div'); b.className = 'cw-block'; b.setAttribute('aria-hidden', 'true'); }
      else {
        b = document.createElement('button'); b.type = 'button'; b.className = 'cw-cell'; b.dataset.i = i; b.setAttribute('role', 'gridcell');
        if (NUMBERED[i]) { var n = document.createElement('span'); n.className = 'cw-n'; n.textContent = NUMBERED[i]; n.setAttribute('aria-hidden', 'true'); b.appendChild(n); }
        b.appendChild(document.createTextNode(''));
      }
      els.grid.appendChild(b); cellEls.push(b);
    }
    els.keys.innerHTML = '';
    ROWS.forEach(function (r) {
      var row = document.createElement('div'); row.className = 'cw-krow';
      r.split('').forEach(function (k) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'cw-key' + (k === '#' ? ' wide' : '');
        if (k === '#') { b.dataset.k = '<'; b.textContent = '⌫'; b.setAttribute('aria-label', T('minicw.delete')); } else { b.dataset.k = k; b.textContent = k; }
        row.appendChild(b);
      });
      els.keys.appendChild(row);
    });
  }
  function clueButtons() {
    els.across.innerHTML = ''; els.down.innerHTML = '';
    ENTRIES.forEach(function (e, n) {
      var li = document.createElement('li'), b = document.createElement('button'), num = document.createElement('b');
      b.type = 'button'; b.dataset.n = n; num.textContent = e.num;
      b.appendChild(num); b.appendChild(document.createTextNode(g.clues[n]));
      if (cellsOf(e).every(function (i) { return g.cells[i]; })) b.className = 'done';
      li.appendChild(b); (e.dir === 'a' ? els.across : els.down).appendChild(li);
    });
  }
  function paint() {
    Lib.englishNote(T, 'lang.enClues', true);
    var n = currentEntry(), here = n >= 0 ? cellsOf(ENTRIES[n]) : [];
    cellEls.forEach(function (b, i) {
      if (isBlock(i)) return;
      b.lastChild.nodeValue = g.cells[i] || '';
      b.classList.toggle('sel', i === g.sel); b.classList.toggle('in-word', i !== g.sel && here.indexOf(i) >= 0);
      b.classList.toggle('wrong', wrongs.indexOf(i) >= 0); b.classList.toggle('hinted', !!g.hinted[i]);
      var r = Math.floor(i / SIZE), c = i % SIZE;
      b.setAttribute('aria-label', T('minicw.cellAria', { row: r + 1, col: c + 1, letter: g.cells[i] ? g.cells[i].toUpperCase() : T('minicw.empty') }));
    });
    if (n >= 0) {
      var e = ENTRIES[n]; els.clue.innerHTML = '';
      var b = document.createElement('b'); b.textContent = T('minicw.ref', { n: e.num, dir: dirName(e) });
      els.clue.appendChild(b); els.clue.appendChild(document.createTextNode(g.clues[n]));
    }
    clueButtons();
  }

  // ── playing ──
  function select(i, toggle) {
    if (done) return;
    if (i === g.sel && toggle && entryOf(i, 'a') >= 0 && entryOf(i, 'd') >= 0) g.dir = g.dir === 'a' ? 'd' : 'a';
    else { g.sel = i; if (entryOf(i, g.dir) < 0) g.dir = g.dir === 'a' ? 'd' : 'a'; }
    paint();
  }
  function step(by) {
    var n = currentEntry(), cells = cellsOf(ENTRIES[n]), at = cells.indexOf(g.sel) + by;
    if (at >= 0 && at < cells.length) g.sel = cells[at];
  }
  function put(letter) {
    if (done || building) return;
    g.cells[g.sel] = letter; wrongs = wrongs.filter(function (i) { return i !== g.sel; }); g.hinted[g.sel] = false;
    step(1); paint(); if (solved(g.cells, sol)) win();
  }
  function erase() {
    if (done || building) return;
    if (!g.cells[g.sel]) step(-1);
    g.cells[g.sel] = ''; wrongs = wrongs.filter(function (i) { return i !== g.sel; }); g.hinted[g.sel] = false;
    paint();
  }
  function hint() {
    if (done || building) return;
    var n = currentEntry(), cells = cellsOf(ENTRIES[n]), at = g.sel;
    if (g.cells[at] === sol[at]) { var open = cells.filter(function (i) { return g.cells[i] !== sol[i]; }); if (!open.length) { status.reason(T('minicw.nothingToHint')); return; } at = open[0]; g.sel = at; }
    g.cells[at] = sol[at]; g.hinted[at] = true; g.hints++; wrongs = wrongs.filter(function (i) { return i !== at; });
    paint(); if (solved(g.cells, sol)) win();
  }
  function check() {
    if (done || building) return;
    wrongs = wrongCells(g.cells, sol); paint();
    status.reason(wrongs.length ? T('minicw.wrong', { n: wrongs.length }) : T('minicw.allRight'), 3000);
  }
  function win() {
    done = true;
    var stats = Play.load(STATS_KEY, { solved: 0, clean: 0 });
    stats.solved++; if (!g.hints) stats.clean++; Play.save(STATS_KEY, stats);
    status.say(T('minicw.solved'));
    ZimiShell.endSheet({ result: 'win', stats: [[T('minicw.hintsUsed'), Play.num(g.hints)]] });
  }

  function start(mode) {
    if (building) return; building = true; done = false; wrongs = [];
    status.say(T('minicw.choosing')); els.clue.textContent = '';
    var rng = mode === 'daily' ? Lib.rng(Lib.hash('minicw|' + today)) : Math.random;
    var words = generate(builtInPool(root.MINICW_CLUES), rng);
    if (!words) { building = false; status.say(''); return; }
    cluesFor(words).then(function (got) {
      building = false; sol = solution(words);
      g = { mode: mode, date: mode === 'daily' ? today : '', words: words, clues: got.clues, lib: got.lib, cells: sol.map(function () { return ''; }), hinted: [], hints: 0, sel: 0, dir: 'a', dict: dict };
      build(); paint(); status.say('');
    });
  }

  els.grid.addEventListener('click', function (e) { var b = e.target.closest('.cw-cell'); if (b) select(+b.dataset.i, true); });
  els.keys.addEventListener('click', function (e) { var b = e.target.closest('.cw-key'); if (!b) return; if (b.dataset.k === '<') erase(); else put(b.dataset.k); });
  els.across.addEventListener('click', clueTap); els.down.addEventListener('click', clueTap);
  function clueTap(e) {
    var b = e.target.closest('button'); if (!b || done) return;
    var ent = ENTRIES[+b.dataset.n]; g.dir = ent.dir; g.sel = cellsOf(ent)[0]; paint();
    els.grid.scrollIntoView({ block: 'nearest' });
  }
  els.hint.addEventListener('click', hint);
  els.check.addEventListener('click', check);
  els.newBtn.addEventListener('click', function () {
    var m = pendingMode || (g && g.mode === 'daily' && done ? 'practice' : g ? g.mode : 'daily');
    pendingMode = null; start(m);
  });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || !g || document.querySelector('.ar-sheet:not([hidden])')) return;
    if (e.target.closest && e.target.closest('button') && (e.key === 'Enter' || e.key === ' ')) return;
    var k = e.key, at = g.sel;
    if (/^[a-zA-Z]$/.test(k)) put(k.toLowerCase());
    else if (k === 'Backspace') { e.preventDefault(); erase(); }
    else if (k === ' ' || k === 'Enter') { e.preventDefault(); select(at, true); }
    else if (/^Arrow/.test(k)) {
      e.preventDefault();
      var dr = k === 'ArrowDown' ? 1 : k === 'ArrowUp' ? -1 : 0, dc = k === 'ArrowRight' ? 1 : k === 'ArrowLeft' ? -1 : 0, r = Math.floor(at / SIZE), c = at % SIZE;
      for (var s = 1; s < SIZE; s++) {
        var nr = r + dr * s, nc = c + dc * s;
        if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) break;
        if (!isBlock(nr * SIZE + nc)) { g.dir = dr ? 'd' : 'a'; select(nr * SIZE + nc, false); break; }
      }
    }
  });
  ZimiShell.game({
    about: function () { return Lib.note(T, 'words', g && g.dict ? g.dict : ''); },
    inProgress: function () { return !!g && !done && g.cells.some(Boolean); },
    menu: function () {
      return { options: [Play.optionRow(T('minicw.puzzle'), [['daily', T('play.daily')], ['practice', T('play.practice')]], pendingMode || (g ? g.mode : 'daily'), function (v) { pendingMode = v; })] };
    },
    stats: function () {
      var s = Play.load(STATS_KEY, { solved: 0, clean: 0 });
      return s.solved ? [[T('minicw.solvedCount'), Play.num(s.solved)], [T('minicw.cleanCount'), Play.num(s.clean)]] : [];
    }
  });

  Lib.library().then(function (list) {
    var w = (list || []).filter(function (z) { return z.project === 'wiktionary' && Lib.primaryLang(z.language) === 'en'; })[0];
    dict = w ? w.name : '';
    var kept = ZimiShell.saved();
    if (kept && kept.g && kept.g.words && (kept.g.mode !== 'daily' || kept.g.date === today)) {
      g = kept.g; g.hinted = g.hinted || []; sol = solution(g.words); build(); paint();
      if (solved(g.cells, sol)) win();
    } else { if (kept) ZimiShell.forget(); start('daily'); }
  });
  ZimiShell.persist({ save: function () { return g && g.cells.some(Boolean) ? { g: g } : null; } });
  root.__cw = { get g() { return g; }, get dict() { return dict; }, get sol() { return sol; } };
})(this);
