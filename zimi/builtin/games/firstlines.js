/* ZimiGames: First Lines. "Which book opens like this?" The player's Gutenberg ZIM lists its books by popularity
   (full_by_popularity.js: [title, author, formats, id, shelf]); each round takes some of the most read, reads the start of
   each book's page, and finds where the story begins (after the licence and the contents, at its first chapter) and its first
   sentence. The other choices are other well-known titles from the same listing. Elsewhere it asks the built-in lines in
   firstlines-data.js. The rules are pure functions (no DOM, so node can test them), then the page (RoundKit). Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  var Lib = root.GamesLib;

  // ── the rules ────────────────────────────────────────────────────────────
  var QUESTIONS = 6, CHOICES = 4, POPULAR = 300, TRIES = 14, CONCURRENCY = 3;
  var LISTING_BYTES = 70000, BOOK_BYTES = 160000, BOOK_MS = 20000, MIN_LINE = 15, LINE_CAP = 240, SHORT_SENTENCE = 15, ENOUGH_SENTENCE = 30, PAGE_PATH_MAX = 230;
  var LISTING_PATH = 'full_by_popularity.js';
  // The heading that opens a story: "CHAPTER I.", "Book the First", "Letter 1", or only "I." or "1".
  var STORY_HEAD = /^(?:(?:chapter|book|part|volume|stave|letter|section|canto|act|scene)\b|(?:[ivxlcdm]+|\d+)(?:\.|$))/i;
  var ABBREV = /(?:\b(?:Mr|Mrs|Ms|Dr|St|Mt|vs|No|Co|Jr|Sr)|\b[A-Z])$/;
  var SKIP_WORDS = /^(the|and|of|a|an|in|to|for|with|on|at|by|from|or)$/i;

  function plain(h) {
    return String(h).replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#8217;|&rsquo;/g, '’').replace(/&#8212;|&mdash;/g, '—').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // The first sentence of some prose (or two, when it is only a few words: "Call me Ishmael." stands alone, a shorter
  // one takes the next), without breaking after "Mr." or an initial.
  function firstSentence(text) {
    var out = '', re = /[^.!?]*[.!?]+["”’']*(?:\s+|$)/g, s;
    while ((s = re.exec(text))) {
      var piece = s[0].trim();
      out = out ? out + ' ' + piece : piece;
      if (ABBREV.test(piece.replace(/[.!?]+["”’']*$/, '')) && re.lastIndex < text.length) continue;
      if (out.length >= SHORT_SENTENCE && !/[,;:—]$/.test(piece) || out.length >= ENOUGH_SENTENCE) break;
    }
    out = (out || text).trim();
    if (out.length > LINE_CAP) out = out.slice(0, LINE_CAP).replace(/[\s,;:—]+\S*$/, '') + '…';
    return out;
  }
  // A drop capital sets the first word in capitals ("IT is a truth"): it reads as the word it is.
  function unshout(line) {
    return line.replace(/^([A-Z]{2,})(?=\s)/, function (w) { return w.charAt(0) + w.slice(1).toLowerCase(); });
  }

  // The first line of a book's page: where the story begins, never the licence or the contents. '' when it cannot tell.
  function firstLine(html) {
    var src = String(html || ''), start = /\*\*\* START OF[\s\S]*?\*\*\*/i.exec(src);
    if (start) src = src.slice(start.index + start[0].length);
    src = src.replace(/<(script|style|table|sup|nav)[\s\S]*?<\/\1>/gi, '');
    var heads = /<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, h, from = -1;
    while ((h = heads.exec(src))) {
      var t = plain(h[2]);
      if (t.length < 80 && STORY_HEAD.test(t)) { from = heads.lastIndex; break; }
    }
    if (from < 0) return '';
    var paras = /<p[^>]*>([\s\S]*?)<\/p>/gi, p;
    paras.lastIndex = from;
    while ((p = paras.exec(src))) {
      var text = plain(p[1]);
      if (text.length < 50 || text === text.toUpperCase() || /^[[(\d]/.test(text)) continue;
      return unshout(firstSentence(text));
    }
    return '';
  }

  // Gutenberg writes an author "Austen, Jane, 1775-1817"; a player reads "Jane Austen".
  function authorName(text) {
    var parts = String(text || '').split(/\s*,\s*/).filter(function (p) { return p && !/^[\d\s?-]+$/.test(p) && !/^\d/.test(p); });
    return parts.length >= 2 ? parts[1] + ' ' + parts[0] : (parts[0] || '');
  }

  // The listing's rows, most read first, whole or cut off anywhere: [{title, author, id, html, path}]. Tolerant by design.
  function parseListing(text) {
    var out = [], re = /\[\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"?(\d*)"?\s*,\s*"?(\d+)"?\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]/g, m;
    var unq = function (s) { try { return JSON.parse('"' + s + '"'); } catch (e) { return s; } };
    while ((m = re.exec(String(text || '')))) {
      var title = unq(m[1]).trim(), flags = m[3] || '1';
      if (!title) continue;
      out.push({ title: title, author: authorName(unq(m[2])), id: +m[4], html: flags.charAt(0) !== '0',
        path: title.replace(/\//g, '-').slice(0, PAGE_PATH_MAX) + '.' + m[4] });
    }
    return out;
  }

  // A title as a choice: "Alice's Adventures in Wonderland; Or, ..." is "Alice's Adventures in Wonderland".
  function shortTitle(t) { return String(t).split(/\s*[;:]\s+|\s+or,\s/i)[0].replace(/\s+/g, ' ').trim(); }

  // The line with its book's name taken out, so the title is not in the question.
  function mask(line, title) {
    var words = shortTitle(title).split(/[\s,.:;()“”"]+/).map(function (w) { return w.replace(/[’']s$/, ''); }).filter(function (w) { return w.length >= 4 && !SKIP_WORDS.test(w); });
    var out = line;
    words.sort(function (a, b) { return b.length - a.length; }).forEach(function (w) {
      out = out.replace(new RegExp('(?<![\\p{L}\\p{N}])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[’\']s)?(?![\\p{L}\\p{N}])', 'giu'), '_____');
    });
    return out;
  }

  // A question from a book and its line, with other titles as the choices; null when too few are different.
  function question(book, line, pool, rng) {
    var title = shortTitle(book.title), others = [], seen = [Lib.fold(title)];
    Lib.shuffle(pool, rng).forEach(function (b) {
      var t = shortTitle(b.title), f = Lib.fold(t);
      if (others.length < CHOICES - 1 && seen.indexOf(f) < 0) { seen.push(f); others.push(t); }
    });
    if (others.length < CHOICES - 1 || line.length < MIN_LINE) return null;
    return { kind: 'line', quote: mask(line, book.title), answer: title, choices: Lib.shuffle([title].concat(others), rng), detail: book.author || '', path: book.path, zim: book.zim };
  }

  // A round from a book ZIM: `get(path)` gives the start of a page. Resolves to [question] (fewer than a round if the
  // books gave too little), so the page can fall back to its built-in lines.
  function libraryRound(books, get, count, rng) {
    var pool = books.slice(0, POPULAR), pick = Lib.shuffle(pool.filter(function (b) { return b.html; }), rng).slice(0, TRIES), out = [], at = 0;
    function lane() {
      if (at >= pick.length || out.length >= count) return Promise.resolve();
      var book = pick[at++];
      return get(book.path).then(function (html) {
        var line = firstLine(html), q = line && out.length < count ? question(book, line, pool, rng) : null;
        if (q) out.push(q);
      }, function () { /* a page that did not load is skipped */ }).then(lane);
    }
    var lanes = [];
    for (var i = 0; i < CONCURRENCY; i++) lanes.push(lane());
    return Promise.all(lanes).then(function () { return out; });
  }

  // The built-in lines as questions.
  function miniRound(data, count, rng) {
    var books = data.map(function (d) { return { title: d[0], author: d[1], line: d[2] }; });
    return Lib.sample(books, count, rng).map(function (b) { return question(b, b.line, books, rng); }).filter(Boolean);
  }

  root.FirstLinesEngine = { firstLine: firstLine, firstSentence: firstSentence, parseListing: parseListing, authorName: authorName, mask: mask, shortTitle: shortTitle, question: question, libraryRound: libraryRound, miniRound: miniRound, QUESTIONS: QUESTIONS };
  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var zimName = '';
  root.RoundKit.run({
    id: 'firstlines', what: 'lines',
    kinds: { line: 'firstlines.kind.line' },
    english: 'lang.enLines',
    text: { choosing: 'firstlines.choosing', alt: 'round.pictureAlt' },
    init: function (list) {
      var z = Lib.pickByName(list, 'gutenberg', Lib.uiLang());
      zimName = z ? z.name : '';
    },
    build: function () {
      if (!zimName) return Promise.resolve(null);
      return Lib.head(Lib.articleUrl(zimName, LISTING_PATH), LISTING_BYTES).then(function (text) {
        var books = parseListing(text).map(function (b) { b.zim = zimName; return b; });
        if (books.length < CHOICES) return null;
        return libraryRound(books, function (path) { return Lib.head(Lib.articleUrl(zimName, path), BOOK_BYTES, BOOK_MS); }, QUESTIONS, Math.random)
          .then(function (round) { return round.length >= QUESTIONS / 2 ? { round: round, zim: zimName } : null; });
      });
    },
    builtIn: function () { return miniRound(root.FIRSTLINES_MINI, QUESTIONS, Math.random); }
  });
})(this);
