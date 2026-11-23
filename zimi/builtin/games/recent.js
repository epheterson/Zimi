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
  // World favorites: the best-known games of the world that ours play best (the shelf's lead after the table). Featured never
  // picks one of these, so the two rows cannot carry the same game on the same day.
  var WORLD = CLASSICS.concat(['sudoku.html', 'minesweeper.html', 'backgammon.html', 'go.html', 'hearts.html', 'mahjong.html', '2048.html', 'fourinarow.html', 'dominoes.html', 'blackjack.html']);

  var api = { dailyOrder: dailyOrder, ALIAS: ALIAS, canon: canon, KEY: KEY, SNAPS_KEY: SNAPS_KEY, snapSrc: snapSrc, CAP: CAP, fnv1a: fnv1a, uniqueByPath: uniqueByPath, dayPick: dayPick, record: record, read: read, localDay: localDay, tilt: tilt, ago: ago, WORLD: WORLD, newestCount: newestCount, featuredPicks: featuredPicks };
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
      tilesAt(path).forEach(function (tile) {
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
  // The shelf's tiles for a page. Kiwix's viewer (kiwix-serve 3.8) rewrites a book's links once the page has loaded, to its own
  // "/viewer#<book>/<path>", before games.json has come back: a tile is found by the path its link ends in, written either way.
  var VIEWER = '/viewer#';
  function tilesAt(path) {
    return Array.prototype.filter.call(doc.querySelectorAll('a.ar-game'), function (a) {
      var h = a.getAttribute('href') || '', at = h.indexOf(VIEWER);
      if (at >= 0) h = h.slice(h.indexOf('/', at + VIEWER.length) + 1);
      return h === path;
    });
  }
  function tileFor(game) {
    var tile = tilesAt(canon(game.path))[0];
    if (!tile) return null;
    var el = tile.cloneNode(true);
    el.removeAttribute('hidden');   // the shelf may have hidden the original (a room, a search); a copy answers for itself
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
    // A box is small, like a Daily tile: the game's short name where it has one ("Шашки", not "Английские шашки").
    name.textContent = named(canon(game.path), 'short', tile.querySelector('.ar-game-text strong').textContent);
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

  // The rooms' own lists (shell.js): a room's best-known games, in order. A game in a list carries where, as data-fav="room:place,..."
  // ("all" is the unfiltered shelf), so one row serves every room and the shelf only picks (shelf.js).
  function roomLists() {
    var rooms = (root.ZimiShell && root.ZimiShell.rooms) || [];
    return rooms.filter(function (r) { return r.favorites; }).map(function (r) { return { id: r.id, list: r.favorites }; });
  }
  function withFavs(lists) {
    var order = [], at = {};
    lists.forEach(function (l) {
      l.list.forEach(function (p, i) {
        if (!at[p]) { at[p] = []; order.push(p); }
        at[p].push(l.id + ':' + i);
      });
    });
    return order.map(function (p) { return { path: p, fav: at[p].join(',') }; });
  }
  // With nothing played in a room the table offers three of its best-known games; in no room, the three classics.
  var IDLE_N = 3;
  function idleGames(byPath) {
    var lists = [{ id: 'all', list: CLASSICS }].concat(roomLists().map(function (l) { return { id: l.id, list: l.list.slice(0, IDLE_N) }; }));
    return withFavs(lists).map(function (g) { return { path: g.path, fav: g.fav, title: named(g.path, 'title', (byPath[g.path] || {}).title) }; });
  }

  // One shelf of boxes: the games played lately (newest on top and nearest), or the ones offered with nothing played.
  function tableNav(games, kind, now) {
    var tbl = doc.createElement('nav');
    tbl.className = 'ar-table';
    tbl.dataset.kind = kind;
    var inner = doc.createElement('div');
    inner.className = 'ar-table-in';
    games.forEach(function (g, i) {
      var b = box(g, i, kind === 'idle' ? T('shelf.table.classic') : ago(now, g.at), kind === 'played');
      if (!b) return;
      if (g.fav) b.dataset.fav = g.fav;
      inner.appendChild(b);
    });
    if (!inner.children.length) return null;
    tbl.appendChild(inner);
    // Laid out once it is on the page, and again whenever its width changes (a turn, a view, a language's names).
    if (root.ResizeObserver) new root.ResizeObserver(function () { fitNames(inner); }).observe(inner);
    return tbl;
  }
  // The table: what was played lately and what is offered, both drawn; the shelf shows the one that fits the room and says which in the heading.
  function table(played, idle, now) {
    var s = doc.createElement('section');
    s.className = 'ar-section ar-continue' + (played.length ? '' : ' ar-table-idle');
    var h = doc.createElement('h2');
    h.textContent = played.length ? T('shelf.table.played') : T('shelf.table.idle');
    s.appendChild(h);
    var navs = [played.length ? tableNav(played, 'played', now) : null, tableNav(idle, 'idle', now)].filter(Boolean);
    if (!navs.length) return null;
    navs.forEach(function (n) { n.setAttribute('aria-label', h.textContent); s.appendChild(n); });
    return s;
  }
  // A name on the table never breaks inside a word ("Checker s" on a 390 px phone, where the boxes overlap): a word wider
  // than its label takes the name's type down half a pixel at a time, to NAME_MIN_PX at the least, and a word still wider
  // than that (a long German or Russian name on a narrow box) ends in an ellipsis on one line instead of breaking.
  var NAME_MIN_PX = 10, NAME_STEP_PX = 0.5;
  function fitNames(scope) {
    Array.prototype.forEach.call(scope.querySelectorAll('.ar-box-label strong'), function (n) {
      n.style.fontSize = '';
      n.classList.remove('ar-name-cut');
      if (!n.clientWidth) return;
      var px = parseFloat(root.getComputedStyle(n).fontSize);
      while (n.scrollWidth > n.clientWidth && px > NAME_MIN_PX) { px -= NAME_STEP_PX; n.style.fontSize = px + 'px'; }
      if (n.scrollWidth > n.clientWidth) n.classList.add('ar-name-cut');
    });
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
    mouseRow(s, nav);
    return s;
  }

  // A row a mouse can scroll (discussion #156: at 1367px each row stopped at the right edge, its scrollbar hidden, and a
  // mouse had no way to the rest). With a pointer that hovers: a chevron at each end, shown only while there is more that
  // way, pages by one visible width; the wheel turns sideways over the row until the row is at its end, then the page
  // scrolls on. Touch keeps its swipe and none of this.
  var FINE = root.matchMedia ? root.matchMedia('(hover: hover) and (pointer: fine)') : null;
  var CHEV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
  function mouseRow(s, nav) {
    if (!FINE || !FINE.matches) return;
    var rtl = function () { return getComputedStyle(nav).direction === 'rtl'; };
    var btn = function (cls, key, dir) {
      var b = doc.createElement('button');
      b.type = 'button'; b.className = 'ar-row-btn ' + cls; b.hidden = true; b.innerHTML = CHEV;
      b.setAttribute('aria-label', T(key));
      b.addEventListener('click', function () { nav.scrollBy({ left: dir * (rtl() ? -1 : 1) * nav.clientWidth * 0.9, behavior: 'smooth' }); });
      s.appendChild(b);
      return b;
    };
    var prev = btn('ar-row-prev', 'shelf.rowPrev', -1), next = btn('ar-row-next', 'shelf.rowNext', 1);
    s.classList.add('ar-row');
    function update() {
      var at = Math.abs(nav.scrollLeft), max = nav.scrollWidth - nav.clientWidth;
      prev.hidden = at <= 1;
      next.hidden = at >= max - 1;
    }
    nav.addEventListener('scroll', update, { passive: true });
    if (root.ResizeObserver) new root.ResizeObserver(update).observe(nav);
    nav.addEventListener('wheel', function (e) {
      if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;   // a trackpad's own sideways swipe, or a zoom
      var before = nav.scrollLeft;
      nav.scrollLeft += (rtl() ? -1 : 1) * e.deltaY * (e.deltaMode === 1 ? 16 : 1);
      if (nav.scrollLeft !== before) e.preventDefault();
    }, { passive: false });
    mouseDrag(nav);
    root.requestAnimationFrame ? root.requestAnimationFrame(update) : update();
  }

  // Pressing and dragging a row with a mouse scrolls it (a finger already does). Past DRAG_PX the press is a drag: the
  // row's snapping steps aside until release and the click that ends the drag is swallowed, so the card under the
  // pointer does not open. A press that stays under DRAG_PX is a plain click.
  var DRAG_PX = 5;
  function mouseDrag(nav) {
    var down = null, dragged = false;
    nav.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      down = { x: e.clientX, left: nav.scrollLeft, id: e.pointerId };
      dragged = false;
    });
    nav.addEventListener('pointermove', function (e) {
      if (!down || e.pointerId !== down.id) return;
      var dx = e.clientX - down.x;
      if (!dragged) {
        if (Math.abs(dx) <= DRAG_PX) return;
        dragged = true;
        nav.style.scrollSnapType = 'none';
        nav.style.userSelect = 'none';
        try { nav.setPointerCapture(e.pointerId); } catch (x) { /* a pointer that is already gone */ }
      }
      nav.scrollLeft = down.left - dx;
    });
    var end = function (e) {
      if (!down || e.pointerId !== down.id) return;
      down = null;
      nav.style.scrollSnapType = '';
      nav.style.userSelect = '';
      if (dragged) root.setTimeout(function () { dragged = false; }, 0);   // after the click this release makes
    };
    nav.addEventListener('pointerup', end);
    nav.addEventListener('pointercancel', end);
    nav.addEventListener('click', function (e) { if (dragged) { e.preventDefault(); e.stopPropagation(); } }, true);
    nav.addEventListener('dragstart', function (e) { e.preventDefault(); });   // a tile's link or art is not a drag to drop
  }

  // The Daily row: today's edition of every game that has one (ZimiShell.DAILY in shell.js), each tile opening it with the
  // server's day in its address, so everyone on this Zimi plays the same one. Those done today carry a tick and move to the end.
  // Over the row, one line: how many are done, and the streak.
  // The two everyone looks for first lead the row; the rest keep the shelf's order.
  // The dailies people know from everywhere lead, in this order; the rest follow, as more to try.
  var DAILY_FIRST = ['fiveletters.html', 'sudoku.html', 'minicrossword.html', 'chesspuzzles.html', 'spellingbee.html', 'minesweeper.html', 'solitaire.html'];
  function dailyOrder(games) {
    var rank = function (g) { var i = DAILY_FIRST.indexOf(g.path); return i < 0 ? DAILY_FIRST.length : i; };
    return games.map(function (g, i) { return [g, i]; }).sort(function (a, b) { return rank(a[0]) - rank(b[0]) || a[1] - b[1]; }).map(function (x) { return x[0]; });
  }
  function isMainDaily(path) { return DAILY_FIRST.indexOf(path) >= 0; }
  // The day's game is a tile like the others in the Daily row (one "today" on the shelf, not two), marked by a small badge
  // over its art. When it has a daily of its own the tile is that daily; otherwise it opens the game as usual.
  function featureTile(g, day, S) {
    var t = tileFor(g);
    if (!t) return null;
    ownIds(t);
    t.classList.add('ar-feature');
    if (S.DAILY[g.path]) t.setAttribute('href', g.path + '?daily=' + day);
    var tag = doc.createElement('small');
    tag.className = 'ar-feature-tag';
    tag.textContent = T('shelf.today');
    t.appendChild(tag);
    return t;
  }
  // The day is the server's, so everyone on this Zimi sees the same day's game (gamelinks.game_of_day, Zimi's own card, too).
  function dailySection(rows) {
    var S = root.ZimiShell;
    if (!S || !S.DAILY || !S.serverDay || !S.stats) return Promise.resolve(null);
    return S.serverDay().then(function (day) {
      var all = S.stats.read(), done = all.days[day] || {}, open = [], finished = [], moreOpen = [], moreDone = [];
      var g = dayPick(rows, day), pick = g ? { path: g.path, title: named(g.path, 'title', g.title), line: g.why ? named(g.path, 'why', g.why) : named(g.path, 'blurb', g.blurb || '') } : null;
      // Game of the day: when it is one of the everyday seven it is that tile, in its place among them; otherwise it leads
      // the rest, just after the seven.
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
      // The seven, then the rest in the same row: a little more room between them says where the everyday ones end.
      var rest = (feature && !pickMain ? [feature] : []).concat(moreOpen, moreDone);
      var tiles = open.concat(finished, rest);
      if (!tiles.length) return null;
      var s = section('ar-daily', T('shelf.daily'), tiles), h = s.querySelector('h2'), streak = S.stats.streak(all, day);
      var line = doc.createElement('span');
      line.className = 'ar-daily-line';
      // How many of the everyday dailies are done (the rest are extra): the shelf calls it again when a room leaves fewer.
      s.dailyLine = function (n, total) { line.textContent = (total ? T('shelf.daily.done', { n: n, total: total }) : '') + (streak > 1 ? (total ? ' \u00b7 ' : '') + T('daily.streak', { n: streak }) : ''); };
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
  // The release that came last: the highest `added` games.json carries, so a ZIM is its own release's "current".
  function newer(a, b) {
    var x = String(a).split('.'), y = String(b).split('.');
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      var d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0);
      if (d) return d > 0;
    }
    return false;
  }
  // World favorites: the best-known games of the world that ours play best, the shelf's lead after the table (Eric: the games
  // that use your library are not the ones to open on). A game the shelf has no tile of is left out.
  function worldSection() {
    var tiles = [];
    // The unfiltered shelf's list, then each room's own (a game in both is one tile): a room shows its list, in its order.
    withFavs([{ id: 'all', list: WORLD }].concat(roomLists())).forEach(function (g) {
      var t = tileFor({ path: g.path });   // the idle table's three classics are here too: a person looking for chess finds it
      if (t) { t.dataset.fav = g.fav; tiles.push(ownIds(t)); }
    });
    if (!tiles.length) return null;
    var s = section('ar-world', T('shelf.world'), tiles);
    if (root.ZimiShell && root.ZimiShell.localizeTiles) root.ZimiShell.localizeTiles(s);
    return s;
  }
  // What the New row's list was: the games the release this shelf shipped in added, one row that changed only when a new
  // release landed. Featured keeps that row's size, so a fresh ZIM shows the same richness; it is the count, nothing more.
  function newestCount(rows) {
    var latest = '';
    (rows || []).forEach(function (r) { if (r && r.added && (!latest || newer(r.added, latest))) latest = r.added; });
    var n = 0;
    uniqueByPath(rows).forEach(function (g) { if (g.added === latest) n++; });
    return n;
  }
  // One small seeded shuffle (util.js mulberry32, the generator the daily deals use): the same day deals the same row everywhere.
  function shuffled(seed, arr) {
    var rng = root.ZimiUtil.mulberry32(seed), out = arr.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }
  // The day's row (".ar-featured"): a deterministic pick of `n` games seeded by the day (the Daily row's day, shell.js) so a
  // day is one row for everyone. Half the picks come from the newest third of games.json, half from the rest, so over time
  // every game is featured. A game the World favorites open on is never here. Exported so the tests hold it to the same numbers.
  function featuredPicks(rows, day) {
    var games = uniqueByPath(rows), world = {};
    WORLD.forEach(function (p) { world[p] = 1; });
    var pool = games.filter(function (g) { return !world[g.path]; });
    var n = Math.min(newestCount(rows), pool.length);
    if (!n) return [];
    var seed = fnv1a(day);
    var third = Math.max(1, Math.floor(pool.length / 3)), newest = pool.slice(pool.length - third), rest = pool.slice(0, pool.length - third);
    var half = Math.ceil(n / 2);
    // Paths, not rows: featuredSection looks each pick's row up by it, so a pick is an address tileFor can load.
    return shuffled(seed, newest).slice(0, half).concat(shuffled(seed ^ 0x9e3779b9, rest).slice(0, n - half)).slice(0, n).map(function (g) { return g.path; });
  }
  // Featured: the day's row, a held pick of the library that changes once a day. Absent when no game says which release added it.
  function featuredSection(rows) {
    var S = root.ZimiShell;
    if (!S || !S.serverDay) return Promise.resolve(null);
    return S.serverDay().then(function (day) {
      var tiles = [], byPath = {};
      uniqueByPath(rows).forEach(function (r) { byPath[r.path] = r; });
      featuredPicks(rows, day).forEach(function (p) {
        var g = byPath[p], t = g && tileFor(g);
        if (t) tiles.push(ownIds(t));
      });
      if (!tiles.length) return null;
      var s = section('ar-featured', T('shelf.featured'), tiles);
      if (root.ZimiShell && root.ZimiShell.localizeTiles) root.ZimiShell.localizeTiles(s);
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

  // games.json, once: [] when it cannot be read (a page opened from a place that cannot fetch).
  function fetchRows() {
    return fetch(new URL('games.json', base).href).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
  }
  // A cold cache or a service worker still starting can fail that one request, and the Featured row and Game of the day are drawn from
  // it: the table and World favorites are drawn at once, and the answer is asked for again (twice, a moment apart) until it comes.
  var ROWS_RETRIES = 2, ROWS_RETRY_MS = 800;
  function rowsWithRetry(tries, got) {
    return fetchRows().then(function (rows) {
      if (rows.length || tries <= 0) return got(rows);
      root.setTimeout(function () { rowsWithRetry(tries - 1, got); }, ROWS_RETRY_MS);
    });
  }

  function shelf() {
    var first = doc.querySelector('.ar-section');
    if (!first) return;
    liveTiles();
    // games.json is the shelf's own data (a file of this ZIM): the day's game and the lines of games that have no tile. Without
    // it the table is still drawn, and Game of the day is left out.
    var drawn = false;
    function drawRows(rows) {
      var byPath = {};
      uniqueByPath(rows).forEach(function (r) { byPath[r.path] = r; });
      var now = Date.now();
      var played = read(root.localStorage).filter(function (e) { return e && e.path; }).slice(0, CAP).map(function (e) {
        return { path: e.path, title: named(e.path, 'title', e.title), at: e.at };
      });
      var t = table(played, idleGames(byPath), now);
      if (t) first.parentNode.insertBefore(t, first);
      // shelf.js lays the sections out per view; it is told when they are in.
      doc.dispatchEvent(new Event('zimi-shelf-today'));
      var world = worldSection();
      if (world) {
        first.parentNode.insertBefore(world, first);
        doc.dispatchEvent(new Event('zimi-shelf-today'));
      }
    }
    // What games.json adds: the Featured row and the Daily row, each once (both wait on the server's day).
    function drawFromRows(rows) {
      featuredSection(rows).then(function (s) {
        if (!s) return;
        first.parentNode.insertBefore(s, first);
        doc.dispatchEvent(new Event('zimi-shelf-today'));
      });
      dailySection(rows).then(function (s) {
        if (!s) return;
        first.parentNode.insertBefore(s, first);
        doc.dispatchEvent(new Event('zimi-shelf-today'));
      });
    }
    rowsWithRetry(ROWS_RETRIES, function (rows) {
      if (!drawn) { drawn = true; drawRows(rows); }
      if (rows.length) drawFromRows(rows);
    });
  }

  // shelf.js reads the page's sections when it runs, and it runs after this file. On a slow phone, or a cold cache, games.json can
  // answer before shelf.js has even arrived: the rows would be put in the page first and shelf.js would take them for sections of
  // games (and stop). So the rows wait for every script of the page to have run; a page that is already past that draws now.
  function afterScripts(fn) {
    var once = false;
    function go() { if (!once) { once = true; fn(); } }
    if (doc.readyState === 'complete') return go();
    doc.addEventListener('DOMContentLoaded', go);
    root.addEventListener('load', go);
  }
  if (doc.querySelector('.ar-shelf')) afterScripts(shelf); else note();
})(typeof window !== 'undefined' ? window : globalThis);
