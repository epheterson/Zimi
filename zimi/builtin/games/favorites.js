/* ZimiGames: the games kept as favorites, on the shelf. Our own code, GPL-3.0. No network, no modules.

   Inside Zimi the header's heart keeps a game in Zimi's Saved (hearts and lists), so this row is
   Saved's items of this ZIM, read from the page that holds us (same origin: window.parent.Saved).
   Anywhere else there is no Saved and no row. It is drawn after shelf.js has laid out the top of
   the shelf, and it hides with it when a search or a section chip takes the shelf over. */
(function (root) {
  'use strict';
  var doc = root.document;
  var ZIM = 'zimi_games';
  var T = function (key) { return root.ZimiText ? root.ZimiText.T(key) : 'Favorites'; };
  var NOT_GAMES = { 'index.html': 1, 'about.html': 1, 'puzzles.html': 1 };

  // Kept pages of Tatham's Mines, Solo and Guess are Minesweeper, Sudoku and Code Breaker (recent.js says which).
  function canon(path) { return root.ZimiRecent ? root.ZimiRecent.canon(path) : path; }

  // Zimi's Saved store, the one the header's heart keeps a game in; null outside Zimi.
  function saved() {
    try {
      var s = root.parent !== root && root.parent.Saved;
      return s && root.parent.document.getElementById('reader-frame') ? s : null;
    } catch (e) { return null; }
  }

  // Saved's items of this ZIM that are games, the latest kept first; [] outside Zimi.
  function favorites() {
    var s = saved();
    if (!s) return [];
    var seen = {};
    return s.all().filter(function (it) { return it.zim === ZIM && it.path && !NOT_GAMES[it.path]; }).map(function (it) {
      return canon(it.path) === it.path ? it : Object.assign({}, it, { path: canon(it.path), title: '' });   // a kept alias is the shelf's game
    }).filter(function (it) { return seen[it.path] ? false : (seen[it.path] = 1); });
  }

  // The tile's own art is a file of this ZIM (thumbs/<game>.svg).
  function artFor(path) {
    return 'thumbs/' + path.replace(/\.html$/, '.svg');   // a Tatham puzzle's is thumbs/puzzles/<name>.svg
  }

  function tile(item) {
    var a = doc.createElement('a');
    a.className = 'ar-game';
    a.setAttribute('href', item.path);
    var img = doc.createElement('img');
    img.className = 'ar-game-art';
    img.alt = '';
    img.src = artFor(item.path);
    img.addEventListener('error', function () { img.remove(); });
    var text = doc.createElement('span');
    text.className = 'ar-game-text';
    var name = doc.createElement('strong');
    name.textContent = item.title || item.path.replace(/\.html$/, '');
    text.appendChild(name);
    a.appendChild(img);
    a.appendChild(text);
    return a;
  }

  // Lobby: a row to swipe along (a heart is a bookmark, and a long list must not push the shelf down), the tiles as wide as
  // the shelf's own. Index: the shelf's own rows, which every other section lays out; the row's flex-basis there squeezed
  // the row layout's art and arrow until the title read "S".
  var STYLE = '[data-view="lobby"] .ar-favorites .ar-games { display: flex; gap: 10px; overflow-x: auto; scroll-snap-type: x proximity; padding-bottom: 4px; }' +
    '[data-view="lobby"] .ar-favorites .ar-game { flex: 0 0 132px; min-width: 132px; scroll-snap-align: start; }' +
    '[data-view="lobby"] .ar-favorites .ar-game-text { padding: 8px 10px 10px; }';

  function draw() {
    var top = doc.querySelector('.sh-top'), items = favorites();
    var old = doc.getElementById('sh-favorites');
    if (old) old.remove();
    if (!top || !items.length) return;
    var s = doc.createElement('section');
    if (!doc.getElementById('sh-favorites-css')) {
      var css = doc.createElement('style');
      css.id = 'sh-favorites-css';
      css.textContent = STYLE;
      doc.head.appendChild(css);
    }
    s.id = 'sh-favorites';
    s.className = 'ar-section ar-favorites';
    var h = doc.createElement('h2');
    h.textContent = T('shelf.favorites');
    var nav = doc.createElement('nav');
    nav.className = 'ar-games';
    nav.setAttribute('aria-label', T('shelf.favorites'));
    items.forEach(function (it) { nav.appendChild(tile(it)); });
    s.appendChild(h);
    s.appendChild(nav);
    // Before Game of the day, after the table.
    top.insertBefore(s, doc.querySelector('.sh-top .ar-today'));
  }

  // What a tile's long-press menu asks (tilemenu.js): is this game kept, and keep it or let it go, with the row following.
  root.ZimiFavorites = {
    available: function () { return !!saved(); },
    has: function (path) { var s = saved(); return !!s && favorites().some(function (it) { return it.path === path; }); },
    toggle: function (path, title) {
      var s = saved(), ref = { kind: 'article', zim: ZIM, path: path, title: title };
      if (!s) return false;
      if (s.has(ref)) s.unsave(ref); else s.save(ref);
      draw();
      return true;
    }
  };

  doc.addEventListener('zimi-shelf-today', draw);
  if (root.ZimiText && root.ZimiText.onChange) root.ZimiText.onChange(function () { if (doc.getElementById('sh-favorites')) draw(); });   // a language that arrived late
  // The page comes back from a game (the back button restores it): hearts may have changed.
  root.addEventListener('pageshow', function (e) { if (e.persisted) draw(); });
})(typeof window !== 'undefined' ? window : globalThis);
