/* ZimiGames: the menu on a game's tile, opened by a long press or a right click. Our own code, GPL-3.0. No network, no modules.

   Every tile of the shelf (the families, the sections, search results, Favorites, the game table, Game of the day) answers
   the same way: Add to favorites, Open in new tab, How to play, About, and Reset progress when the game has a saved game.
   The press, the haptic, the swallowed click and the dismissals are Zimi's own card menu (static/app.js, "Long-press =
   right-click on touch"); the words and sheets are the shell's (shell.js), so the menu reads like the rest of the shelf.

   Favorites live in Zimi's Saved store, the one the header's heart keeps a game in (favorites.js); outside Zimi there is no
   store, so there is no such item. Open in new tab uses Zimi's own address for an article inside Zimi, the page's own
   address anywhere else. Reset progress clears the saved game and the stats of that game on this device and nothing else. */
(function (root) {
  'use strict';
  var T = function (key, vars) { return root.ZimiText ? root.ZimiText.T(key, vars) : key; };

  var ZIM = 'zimi_games';
  var PREFIX = 'zimi.games.';
  var SNAPS_KEY = PREFIX + 'snaps';
  var HOLD_MS = 500;        // a press this long opens the menu (Zimi's card menu)
  var SLOP_PX = 10;         // a finger that moves further is a scroll
  var HAPTIC_MS = 10;
  var GUARD_MS = 350;       // the finger that opened the menu lifts over its backdrop: it must not close it
  var EDGE_PX = 8;
  var TILE = 'a.ar-game[href], a.ar-box[href]';

  // ── What belongs to a game (pure; tests/test_games_tilemenu.cjs) ─────────
  function pathOf(href) { return String(href || '').replace(/[?#].*$/, '').replace(/^\.\//, ''); }
  function idOf(path) { return pathOf(path).replace(/^.*\//, '').replace(/\.html?$/, ''); }
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  // The keys that are a game's progress: the shell's saved game, the game's own state, its stats. Not its settings or seats.
  function progressRe(id) {
    var e = escapeRe(id);
    return new RegExp('^' + escapeRe(PREFIX) + '(?:save\\.' + e + '|stats\\.' + e + '|' + e + '\\.(?:stats|state))$');
  }
  function resetKeys(id, keys) { var re = progressRe(id); return keys.filter(function (k) { return re.test(k); }); }
  // A game has a save when the shell's saved game or the game's own state is there.
  function hasSave(id, keys) {
    var re = new RegExp('^' + escapeRe(PREFIX) + '(?:save\\.' + escapeRe(id) + '|' + escapeRe(id) + '\\.state)$');
    return keys.some(function (k) { return re.test(k); });
  }

  var api = { pathOf: pathOf, idOf: idOf, resetKeys: resetKeys, hasSave: hasSave };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  var doc = root.document;
  if (!doc || !doc.querySelector('.ar-shelf')) return;
  var Shell = function () { return root.ZimiShell; };

  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function storageKeys() {
    var out = [];
    try { for (var i = 0; i < root.localStorage.length; i++) out.push(root.localStorage.key(i)); } catch (e) { /* blocked storage: no saves */ }
    return out;
  }

  // ── The tile's facts ────────────────────────────────────────────────────
  function nameOf(tile) {
    var n = tile.querySelector('strong');   // the name alone: a table box's label also carries "Last played: ..."
    return (n ? n.textContent : tile.textContent).trim();
  }
  // "Last played 11 minutes ago", for a box of the game table (the label's small line reads "Last played: " then the time); '' elsewhere.
  function lastPlayedOf(tile) {
    var small = tile.querySelector('.ar-box-label small'), when = small && small.querySelector('span');
    return when ? small.firstChild.textContent.trim().replace(/[:\uff1a]$/, '') + ' ' + when.textContent : '';
  }
  function rowOf(path) {
    var row = root.ZimiShelf && root.ZimiShelf.meta(path);
    return row && row.path ? row : { path: path, title: '' };
  }

  // ── The actions ─────────────────────────────────────────────────────────
  function openInNewTab(tile, path) {
    var fav = root.ZimiFavorites && root.ZimiFavorites.available(), parent = root.parent;
    // Inside Zimi the page is an article of the games ZIM: the address a reader link would get.
    var url = fav && typeof parent._articleDeepLinkPath === 'function' ? parent._articleDeepLinkPath(ZIM, path) : tile.href;
    root.open(url, '_blank', 'noopener');
  }

  function sheetOf(title, nodes) {
    Shell().sheet({ title: title, body: nodes, actions: [{ label: T('shell.close'), primary: true }] });
  }
  function howToPlay(name, id) {
    var list = Shell().helpList(id);
    if (list) sheetOf(name, [list]);
  }
  function about(name, path, id) {
    var row = rowOf(path), body = el('div', 'gs-about'), sh = Shell();
    sh.aboutInto(body, row, '');
    var history = sh.historyFor(id);
    if (history) body.appendChild(el('p', 'gs-text gs-history', history));
    if (row.qid) {
      var p = el('p', 'gs-text'), a = el('a', '', T('tile.menu.article'));
      a.href = 'about.html?qid=' + encodeURIComponent(row.qid);
      p.appendChild(a);
      body.appendChild(p);
    }
    sheetOf(name, [body]);
  }
  function resetProgress(name, path, id, played) {
    var warning = T('tile.menu.resetText');
    Shell().sheet({
      title: T('tile.menu.resetTitle', { game: name }), text: played || warning, body: played ? [el('p', 'gs-text', warning)] : [],
      actions: [{ label: T('shell.cancel') }, { label: T('tile.menu.resetConfirm'), primary: true, onclick: function () {
        resetKeys(id, storageKeys()).forEach(function (k) { try { root.localStorage.removeItem(k); } catch (e) { /* blocked */ } });
        // The picture of the table the game table keeps is part of the saved game.
        try {
          var snaps = JSON.parse(root.localStorage.getItem(SNAPS_KEY));
          if (snaps && snaps[path]) { delete snaps[path]; root.localStorage.setItem(SNAPS_KEY, JSON.stringify(snaps)); }
        } catch (e) { /* none kept */ }
      } }]
    });
  }

  function actionsFor(tile) {
    var path = pathOf(tile.getAttribute('href')), id = idOf(path), name = nameOf(tile), fav = root.ZimiFavorites, out = [];
    if (fav && fav.available()) {
      var kept = fav.has(path);
      out.push({ id: 'favorite', label: T(kept ? 'tile.menu.unfavorite' : 'tile.menu.favorite'), run: function () { fav.toggle(path, name); } });
    }
    out.push({ id: 'newtab', label: T('tile.menu.newTab'), run: function () { openInNewTab(tile, path); } });
    if (Shell().helpList(id)) out.push({ id: 'how', label: T('shell.menu.how'), run: function () { howToPlay(name, id); } });
    out.push({ id: 'about', label: T('shell.menu.about'), run: function () { about(name, path, id); } });
    if (hasSave(id, storageKeys())) out.push({ id: 'reset', label: T('tile.menu.reset'), danger: true, run: function () { resetProgress(name, path, id, lastPlayedOf(tile)); } });
    return out;
  }

  // ── The menu: a popup at the pointer, a sheet from the bottom for a finger ──
  var open = null; // { tile, back, menu, byKey, openedAt }

  function close(restoreFocus) {
    if (!open) return;
    var o = open;
    open = null;
    o.back.remove();
    doc.removeEventListener('keydown', onMenuKey, true);
    root.removeEventListener('scroll', onScroll, true);
    root.removeEventListener('blur', onBlur);
    if (restoreFocus && o.byKey) try { o.tile.focus({ preventScroll: true }); } catch (e) { /* gone */ }
  }
  function onScroll(e) { if (open && !open.menu.contains(e.target)) close(false); }
  function onBlur() { close(false); }
  function items() { return open ? Array.prototype.slice.call(open.menu.querySelectorAll('[role="menuitem"]')) : []; }
  function onMenuKey(e) {
    if (!open) return;
    var list = items(), i = list.indexOf(doc.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') { close(true); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus(); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); list[e.key === 'Home' ? 0 : list.length - 1].focus(); }
  }

  // x, y: the pointer (or the tile's corner for the keyboard); how: 'touch', 'mouse' or 'key'.
  function openMenu(tile, x, y, how) {
    close(false);
    var acts = actionsFor(tile), sheet = how === 'touch', rtl = doc.documentElement.dir === 'rtl';
    var back = el('div', 'gs-tm-back' + (sheet ? ' gs-tm-sheetback' : '')), menu = el('div', 'gs-tm' + (sheet ? ' gs-tm-sheet' : ''));
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', T('tile.menu.label', { game: nameOf(tile) }));
    if (sheet) {
      var head = el('div', 'gs-tm-head'), art = tile.querySelector('img.ar-game-art');
      if (art && art.src) { var im = el('img'); im.alt = ''; im.src = art.src; head.appendChild(im); }
      head.appendChild(el('b', '', nameOf(tile)));
      menu.appendChild(head);
    }
    acts.forEach(function (a) {
      var b = el('button', 'gs-tm-item' + (a.danger ? ' gs-tm-danger' : ''), a.label);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', function (e) { e.stopPropagation(); close(false); a.run(); });
      menu.appendChild(b);
    });
    back.appendChild(menu);
    doc.body.appendChild(back);
    open = { tile: tile, back: back, menu: menu, byKey: how === 'key', openedAt: Date.now() };
    if (!sheet) {
      var w = menu.offsetWidth, h = menu.offsetHeight, vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight;
      var left = rtl ? x - w : x, top = y + h + EDGE_PX > vh ? y - h : y;
      menu.style.left = Math.max(EDGE_PX, Math.min(left, vw - w - EDGE_PX)) + 'px';
      menu.style.top = Math.max(EDGE_PX, Math.min(top, vh - h - EDGE_PX)) + 'px';
    }
    back.addEventListener('pointerdown', function (e) {
      if (e.target !== back || Date.now() - open.openedAt < GUARD_MS) return;
      e.preventDefault();
      close(false);
    });
    back.addEventListener('contextmenu', function (e) { e.preventDefault(); if (e.target === back) close(false); });
    doc.addEventListener('keydown', onMenuKey, true);
    root.addEventListener('scroll', onScroll, true);
    root.addEventListener('blur', onBlur);
    // A key opens it on the first item; a pointer leaves nothing lit.
    var first = menu.querySelector('[role="menuitem"]');
    if (first && how === 'key') first.focus(); else { menu.tabIndex = -1; menu.focus({ preventScroll: true }); }
  }

  // ── Right click, and the keyboard's menu key ────────────────────────────
  doc.addEventListener('contextmenu', function (e) {
    var tile = e.target.closest && e.target.closest(TILE);
    if (!tile) return;
    e.preventDefault();
    if (root.getSelection) root.getSelection().removeAllRanges();
    // Android raises this itself at the end of a long press: our own timer has opened the menu already.
    if (open && open.tile === tile && Date.now() - open.openedAt < 1000) return;
    openMenu(tile, e.clientX + 2, e.clientY + 2, e.pointerType === 'touch' ? 'touch' : 'mouse');
  });
  doc.addEventListener('keydown', function (e) {
    if (open || !(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return;
    var tile = doc.activeElement && doc.activeElement.closest && doc.activeElement.closest(TILE);
    if (!tile) return;
    e.preventDefault();
    var r = tile.getBoundingClientRect(), rtl = doc.documentElement.dir === 'rtl';
    openMenu(tile, rtl ? r.right - EDGE_PX : r.left + EDGE_PX, r.top + r.height / 2, 'key');
  });

  // ── Long press: arm, fire, cancel, swallow the click ────────────────────
  var timer = 0, pressed = null, startX = 0, startY = 0, fired = false;
  function disarm() {
    root.clearTimeout(timer);
    timer = 0;
    doc.documentElement.classList.remove('gs-lp-armed');
  }
  doc.addEventListener('selectstart', function (e) { if (timer || fired) e.preventDefault(); });
  doc.addEventListener('touchstart', function (e) {
    fired = false;   // a gesture never inherits the last press's latch
    if (e.touches.length !== 1) { disarm(); return; }
    var tile = e.target.closest && e.target.closest(TILE);
    if (!tile) return;
    var t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    doc.documentElement.classList.add('gs-lp-armed');
    root.clearTimeout(timer);
    timer = root.setTimeout(function () {
      timer = 0; fired = true; pressed = tile;
      if (root.navigator.vibrate) { try { root.navigator.vibrate(HAPTIC_MS); } catch (err) { /* no haptic here */ } }
      if (root.getSelection) root.getSelection().removeAllRanges();
      openMenu(tile, startX + 2, startY + 2, 'touch');
    }, HOLD_MS);
  }, { passive: true });
  doc.addEventListener('touchmove', function (e) {
    if (!timer) return;
    var t = e.touches[0];
    if (t && (Math.abs(t.clientX - startX) > SLOP_PX || Math.abs(t.clientY - startY) > SLOP_PX)) disarm();
  }, { passive: true });
  doc.addEventListener('touchend', function (e) { disarm(); if (fired) e.preventDefault(); });
  doc.addEventListener('touchcancel', disarm, { passive: true });
  // The one click a press leaves behind must not open the game (iOS drops it at touchend; Android needs this).
  doc.addEventListener('click', function (e) {
    if (fired && pressed && pressed.contains(e.target)) { e.preventDefault(); e.stopPropagation(); fired = false; }
  }, true);
})(typeof window !== 'undefined' ? window : globalThis);
