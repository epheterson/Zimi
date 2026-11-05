/* ZimiGames: what was played lately, and the game of the day.

   Every game page includes this file (scripts/games_recent.py writes the tag).
   On a game it notes the page in localStorage ("zimi.games.recent"); on the
   shelf it draws two sections from the shelf's own tiles: the game table (the last
   six games lying on it, newest on top) and Game of the day. Nothing here leaves the device.

   The day's game is a function of the date and games.json alone, so it is the
   same for everyone on that day, and the same one Zimi's Discover shows:
   zimi/gamelinks.py game_of_day() is this algorithm in Python (a test holds
   the two together). */
(function (root) {
  'use strict';
  var T = function (key, vars) { return root.ZimiText ? root.ZimiText.T(key, vars) : key; };

  // Shown inside Zimi's reader (its iframe is #reader-frame): the shell's own
  // back arrow and crumb lead back, so games.css hides the page's.
  try {
    if (root.parent !== root && root.parent.document.getElementById('reader-frame')) root.document.documentElement.classList.add('in-zimi');
  } catch (e) { /* another origin: not Zimi */ }

  var KEY = 'zimi.games.recent';
  var SNAPS_KEY = 'zimi.games.snaps';
  var CAP = 6;
  var SKIP_PAGES = { 'index.html': 1, 'about.html': 1, 'puzzles.html': 1 };
  // Three of Tatham's puzzles are games the shelf already has (Mines is Minesweeper, Solo is Sudoku, Guess is Code Breaker). Their pages
  // are modes of those games, so a played, kept or recent page of theirs is the shelf's game (no second tile, and the old path still lands).
  var ALIAS = { 'puzzles/mines.html': 'minesweeper.html', 'puzzles/solo.html': 'sudoku.html', 'puzzles/guess.html': 'codebreaker.html' };
  function canon(path) { return ALIAS[path] || path; }

  // The shell's hash (ZimiShell.hash): the day's pick, the same everywhere.
  function fnv1a(text) { return root.ZimiShell.hash(text); }

  // One row per game page, in games.json order (a game with two Q-IDs has two rows).
  function uniqueByPath(rows) {
    var seen = {}, out = [];
    (rows || []).forEach(function (r) {
      if (r && r.path && !seen[r.path]) { seen[r.path] = 1; out.push(r); }
    });
    return out;
  }

  // The game of a day ("YYYY-MM-DD"): the hash of the day over the games.
  function dayPick(rows, day) {
    var games = uniqueByPath(rows);
    return games.length ? games[fnv1a(day) % games.length] : null;
  }

  // The list after playing `entry` {path, title}: it goes first, an older
  // copy of it goes away, and the list is cut to `cap`.
  function record(list, entry, at, cap) {
    var path = canon(entry.path);
    var rest = (list || []).filter(function (e) { return e && e.path && canon(e.path) !== path; });
    return [{ path: path, title: path === entry.path ? entry.title : '', at: at }].concat(rest).slice(0, cap || CAP);
  }

  function read(storage) {
    try {
      var v = JSON.parse(storage.getItem(KEY));
      if (!Array.isArray(v)) return [];
      var seen = {};
      return v.filter(function (e) { if (!e || !e.path) return true; e.path = canon(e.path); return seen[e.path] ? false : (seen[e.path] = 1); });
    } catch (e) { return []; }
  }

  function localDay(d) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // How a box lies on the table: a small angle and a nudge up or down, both a
  // function of the page, so the same box lies the same way on every visit.
  var TILT_MAX = 5, TILT_MIN = 1.2, NUDGE = 5;
  function tilt(path) {
    var h = fnv1a(path);
    var rot = ((h % 1000) / 999 * 2 - 1) * TILT_MAX;
    if (Math.abs(rot) < TILT_MIN) rot = rot < 0 ? -TILT_MIN : TILT_MIN;
    return { rot: Math.round(rot * 10) / 10, dy: ((h >>> 10) % (2 * NUDGE + 1)) - NUDGE };
  }

  // "just now", "5 minutes ago", "yesterday", "2 weeks ago": Intl's own words for the language.
  function ago(now, at) { return root.ZimiText ? root.ZimiText.ago(Math.max(0, now - at)) : ''; }

  // With nothing played yet the table offers these, in this order.
  var CLASSICS = ['chess.html', 'solitaire.html', 'checkers.html'];

  var api = { dailyOrder: dailyOrder, ALIAS: ALIAS, canon: canon, KEY: KEY, SNAPS_KEY: SNAPS_KEY, snapSrc: snapSrc, CAP: CAP, fnv1a: fnv1a, uniqueByPath: uniqueByPath, dayPick: dayPick, record: record, read: read, localDay: localDay, tilt: tilt, ago: ago };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.ZimiRecent = api;

  var doc = root.document;
  if (!doc) return;
  var script = doc.currentScript;
  var base = script && script.src ? new URL('.', script.src) : null;

  // The page's path from the games' folder: "chess.html", "puzzles/fifteen.html".
  function pagePath() {
    if (!base) return '';
    var p = decodeURIComponent(root.location.pathname);
    var b = decodeURIComponent(base.pathname);
    return p.indexOf(b) === 0 ? p.slice(b.length) : '';
  }

  // "Mancala - ZimiGames" and "Fifteen, from Simon Tatham's ..." are both just the name.
  function pageTitle() {
    return (doc.title || '').replace(/ - ZimiGames$/, '').replace(/, from .*$/, '').trim();
  }

  function note() {
    var path = pagePath();
    if (!path || SKIP_PAGES[path]) return;
    try {
      root.localStorage.setItem(KEY, JSON.stringify(record(read(root.localStorage), { path: path, title: pageTitle() }, Date.now(), CAP)));
    } catch (e) { /* private window, blocked storage: nothing to remember */ }
  }

  // Live tiles: a game left in progress keeps a picture of its table (shell.js writes it); the shelf's tile for that
  // game shows the picture in place of its art. A picture is a data URL or an svg string, so nothing is fetched.
  function snapSrc(snap) {
    if (snap && typeof snap.img === 'string' && /^data:image\/(png|jpeg);base64,/.test(snap.img)) return snap.img;
    if (snap && typeof snap.svg === 'string' && /^\s*<svg[\s>]/.test(snap.svg)) return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(snap.svg);
    return '';
  }
  function liveTiles() {
    var snaps;
    try { snaps = JSON.parse(root.localStorage.getItem(SNAPS_KEY)); } catch (e) { return; }
    if (!snaps || typeof snaps !== 'object') return;
    Object.keys(snaps).forEach(function (path) {
      var src = snapSrc(snaps[path]);
      if (!src) return;
      Array.prototype.forEach.call(doc.querySelectorAll('a.ar-game[href="' + path + '"]'), function (tile) {
        var art = tile.querySelector('.ar-game-art');
        if (!art || art.tagName.toLowerCase() === 'img') return;
        var img = doc.createElement('img');
        img.className = 'ar-game-art ar-game-live';
        img.alt = '';
        img.decoding = 'async';
        img.src = src;
        art.parentNode.replaceChild(img, art);
      });
    });
  }

  // A game's words in the player's language (game.<page>.title, .why, .blurb in the string table), else what was stored.
  function named(path, part, fallback) {
    var Z = root.ZimiText, m = /^(puzzles\/)?([^/]+)\.html$/.exec(path || '');
    var key = m ? 'game.' + (m[1] ? 'puzzles.' : '') + m[2] + '.' + part : '';
    return Z && key && Z.has(key) ? Z.T(key) : fallback;
  }

  // A tile for a game: the shelf's own, copied, so the art matches. A game the
  // shelf has no tile of borrows nothing: there is no tile to show.
  function tileFor(game) {
    var tile = doc.querySelector('a.ar-game[href="' + canon(game.path) + '"]');
    if (!tile) return null;
    var el = tile.cloneNode(true);
    var text = el.querySelector('.ar-game-text');
    var line = text && text.querySelector('span');
    if (line && game.line) line.textContent = game.line;
    return el;
  }

  // A tile's art with its ids made its own: the original tile may be hidden
  // (a filtered section), and a hidden svg's gradients do not paint a clone.
  var boxes = 0;
  function ownIds(node) {
    var n = ++boxes;
    Array.prototype.forEach.call(node.querySelectorAll('[id]'), function (e) {
      var old = e.id, fresh = old + '-b' + n;
      e.id = fresh;
      Array.prototype.forEach.call(node.querySelectorAll('*'), function (x) {
        Array.prototype.forEach.call(x.attributes, function (a) {
          if (a.value.indexOf('#' + old + ')') >= 0) a.value = a.value.split('#' + old + ')').join('#' + fresh + ')');
        });
      });
    });
    return node;
  }

  // A game box lying on the table: the lid is the tile's art, the label its name and a small tag.
  function box(game, i, tag, played) {
    var tile = tileFor(game);
    if (!tile) return null;
    var art = tile.querySelector('.ar-game-art');
    if (!art) return null;
    var t = tilt(game.path);
    var a = doc.createElement('a');
    a.className = 'ar-box ar-settle';
    a.setAttribute('href', tile.getAttribute('href'));
    a.setAttribute('style', '--rot:' + t.rot + 'deg;--dy:' + t.dy + 'px;--z:' + (CAP - i) + ';--i:' + i + ';--s:' + (i ? 0.95 : 1));
    var lid = doc.createElement('span');
    lid.className = 'ar-box-lid';
    lid.appendChild(ownIds(art));
    var label = doc.createElement('span');
    label.className = 'ar-box-label';
    var name = doc.createElement('strong');
    name.textContent = tile.querySelector('.ar-game-text strong').textContent;
    var small = doc.createElement('small');
    small.textContent = tag;
    if (played) small.dataset.ago = '1';
    label.appendChild(name);
    label.appendChild(small);
    a.appendChild(lid);
    a.appendChild(label);
    a.addEventListener('animationend', function () { a.classList.remove('ar-settle'); });
    return a;
  }

  // The table: the games played lately, newest on top and nearest. Idle, a few classics.
  function table(games, idle, now) {
    var s = doc.createElement('section');
    s.className = 'ar-section ar-continue' + (idle ? ' ar-table-idle' : '');
    var h = doc.createElement('h2');
    h.textContent = idle ? T('shelf.table.idle') : T('shelf.table.played');
    var tbl = doc.createElement('nav');
    tbl.className = 'ar-table';
    tbl.setAttribute('aria-label', h.textContent);
    var inner = doc.createElement('div');
    inner.className = 'ar-table-in';
    games.forEach(function (g, i) {
      var b = box(g, i, idle ? T('shelf.table.classic') : ago(now, g.at), !idle);
      if (b) inner.appendChild(b);
    });
    tbl.appendChild(inner);
    s.appendChild(h);
    s.appendChild(tbl);
    return inner.children.length ? s : null;
  }

  function section(cls, label, tiles) {
    var s = doc.createElement('section');
    s.className = 'ar-section ' + cls;
    var h = doc.createElement('h2');
    h.textContent = label;
    var nav = doc.createElement('nav');
    nav.className = 'ar-games';
    nav.setAttribute('aria-label', label);
    tiles.forEach(function (t) { nav.appendChild(t); });
    s.appendChild(h);
    s.appendChild(nav);
    return s;
  }

  // The Daily row: today's edition of every game that has one (ZimiShell.DAILY in shell.js), each tile opening it with the
  // server's day in its address, so everyone on this Zimi plays the same one. Those done today carry a tick and move to the end.
  // Over the row, one line: how many are done, and the streak.
  // The two everyone looks for first lead the row; the rest keep the shelf's order.
  // The dailies people know from everywhere lead, in this order; the rest follow apart, as more to try.
  var DAILY_FIRST = ['fiveletters.html', 'sudoku.html', 'minicrossword.html', 'chesspuzzles.html', 'spellingbee.html', 'minesweeper.html', 'solitaire.html'];
  function dailyOrder(games) {
    var rank = function (g) { var i = DAILY_FIRST.indexOf(g.path); return i < 0 ? DAILY_FIRST.length : i; };
    return games.map(function (g, i) { return [g, i]; }).sort(function (a, b) { return rank(a[0]) - rank(b[0]) || a[1] - b[1]; }).map(function (x) { return x[0]; });
  }
  function isMainDaily(path) { return DAILY_FIRST.indexOf(path) >= 0; }
  // The day's game leads the Daily row as its first, larger tile: one "today" on the shelf, not two. When it has a daily of its
  // own the tile is that daily; otherwise it opens the game as usual.
  function featureTile(g, day, S) {
    var t = tileFor(g);
    if (!t) return null;
    ownIds(t);
    t.classList.add('ar-feature');
    if (S.DAILY[g.path]) t.setAttribute('href', g.path + '?daily=' + day);
    var text = t.querySelector('.ar-game-text');
    if (text) {
      var tag = doc.createElement('small');
      tag.className = 'ar-feature-tag';
      tag.textContent = T('shelf.today');
      text.insertBefore(tag, text.firstChild);
    }
    // The day's art fills its box, cropped, whatever shape the box is.
    var art = t.querySelector('svg.ar-game-art');
    if (art) art.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    return t;
  }
  // The day is the server's, so everyone on this Zimi sees the same day's game (gamelinks.game_of_day, Zimi's own card, too).
  function dailySection(rows) {
    var S = root.ZimiShell;
    if (!S || !S.DAILY || !S.serverDay || !S.stats) return Promise.resolve(null);
    return S.serverDay().then(function (day) {
      var all = S.stats.read(), done = all.days[day] || {}, open = [], finished = [], moreOpen = [], moreDone = [];
      var g = dayPick(rows, day), pick = g ? { path: g.path, title: named(g.path, 'title', g.title), line: g.why ? named(g.path, 'why', g.why) : named(g.path, 'blurb', g.blurb || '') } : null;
      // Game of the day: when it is one of the everyday seven it is that tile, wider, in its place among them; otherwise it
      // leads the second group, just after "More dailies".
      var pickMain = !!(pick && S.DAILY[pick.path] && isMainDaily(pick.path));
      var feature = pick ? featureTile(pick, day, S) : null;
      dailyOrder(uniqueByPath(rows).filter(function (r) { return S.DAILY[r.path] && !(pick && r.path === pick.path); }).concat(pickMain ? [pick] : [])).forEach(function (g) {
        var t = pickMain && g === pick ? feature : tileFor(g);
        if (!t) return;
        if (t !== feature) { ownIds(t); t.setAttribute('href', g.path + '?daily=' + day); }
        var main = isMainDaily(g.path);
        t.classList.add(main ? 'ar-daily-main' : 'ar-daily-more');
        if (done[g.path]) { markDone(t); (main ? finished : moreDone).push(t); } else (main ? open : moreOpen).push(t);
      });
      if (feature && !pickMain && S.DAILY[pick.path] && done[pick.path]) markDone(feature);
      var rest = (feature && !pickMain ? [feature] : []).concat(moreOpen, moreDone), divider = null;
      if (rest.length) {
        divider = doc.createElement('span');
        divider.className = 'ar-daily-sep';
        divider.textContent = T('shelf.daily.more');
      }
      var tiles = open.concat(finished, divider ? [divider] : [], rest);
      if (!tiles.length) return null;
      var s = section('ar-daily', T('shelf.daily'), tiles), h = s.querySelector('h2'), streak = S.stats.streak(all, day);
      var line = doc.createElement('span');
      line.className = 'ar-daily-line';
      // How many of the everyday dailies are done (the rest are extra): the shelf calls it again when a room leaves fewer.
      s.dailyLine = function (n, total) { line.textContent = T('shelf.daily.done', { n: n, total: total }) + (streak > 1 ? ' \u00b7 ' + T('daily.streak', { n: streak }) : ''); };
      s.dailyLine(s.querySelectorAll('a.ar-daily-main.ar-done').length, s.querySelectorAll('a.ar-daily-main').length);
      var stats = doc.createElement('button');
      stats.type = 'button';
      stats.className = 'ar-daily-stats';
      stats.textContent = T('stats.title');
      stats.addEventListener('click', function () { S.statsSheet(); });
      h.appendChild(line);
      h.appendChild(stats);
      if (S.localizeTiles) S.localizeTiles(s);
      return s;
    });
  }
  function markDone(t) {
    t.classList.add('ar-done');
    var tick = doc.createElement('span');
    tick.className = 'ar-done-mark';
    tick.setAttribute('role', 'img');
    tick.setAttribute('aria-label', T('daily.doneToday'));
    tick.textContent = '\u2713';
    t.appendChild(tick);
  }

  function shelf() {
    var first = doc.querySelector('.ar-section');
    if (!first) return;
    liveTiles();
    // games.json is the shelf's own data (a file of this ZIM): the day's game
    // and the lines of games that have no tile. Without it (a page opened from
    // a place that cannot fetch) the table is still drawn, and Game of the day is left out.
    fetch(new URL('games.json', base).href).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; }).then(function (rows) {
      var byPath = {};
      uniqueByPath(rows).forEach(function (r) { byPath[r.path] = r; });
      var now = Date.now();
      var played = read(root.localStorage).filter(function (e) { return e && e.path; }).slice(0, CAP).map(function (e) {
        return { path: e.path, title: named(e.path, 'title', e.title), at: e.at };
      });
      var idle = !played.length;
      var t = table(idle ? CLASSICS.map(function (p) { return { path: p, title: named(p, 'title', (byPath[p] || {}).title) }; }) : played, idle, now);
      if (t) first.parentNode.insertBefore(t, first);
      // shelf.js lays the sections out per view; it is told when they are in.
      doc.dispatchEvent(new Event('zimi-shelf-today'));
      return dailySection(rows);
    }).then(function (s) {
      if (!s) return;
      first.parentNode.insertBefore(s, first);
      doc.dispatchEvent(new Event('zimi-shelf-today'));
    });
  }

  if (doc.querySelector('.ar-shelf')) shelf(); else note();
})(typeof window !== 'undefined' ? window : globalThis);
