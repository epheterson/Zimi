/* ZimiGames' shelf: two views of the same tiles, Lobby and Index, and seven orders.

   The page is plain HTML and lists every game as a link without this file.
   Here the tiles already in the page (the sections of index.html) are read, not
   listed, so a game added to the shelf shows in both views, in the section chips
   and in search with no change here. Lobby is a feed of art tiles; Index is
   search first, one section at a time as thumbnail rows. The choice is kept in
   localStorage ("zimi.games.view"). recent.js draws the game table and Game of the
   day; this file only says where they sit.

   The order control (kept in "zimi.games.sort") regroups the same tiles by what
   games.json says of each game: when it began, where, how many play, how long it
   takes. It is an enhancement: the page lists every game with or without it. */
(function (root) {
  'use strict';
  var T = function (key, vars) { return root.ZimiText ? root.ZimiText.T(key, vars) : key; };

  var VIEW_KEY = 'zimi.games.view';
  var SORT_KEY = 'zimi.games.sort';
  var RECENT_KEY = 'zimi.games.recent';
  var VIEWS = ['lobby', 'index'];

  // ── Orders (pure, no DOM; tests/test_games_meta.cjs) ─────────────────────
  // Each game's facts live in games.json (origin, region, players, length, kind): the
  // shelf only reads them. A tile with no row there (a game with no page of its own, or
  // one added after this file) uses FALLBACK, and one with neither sorts last.
  var SORTS = ['sections', 'az', 'oldest', 'region', 'players', 'quick', 'recent'];
  // The names of the orders, and what the chips are headed in each: strings by id (shelf.sort.*, shelf.head.*).
  var SORT_LABEL = {}, SORT_HEAD = {};
  SORTS.forEach(function (k) {
    Object.defineProperty(SORT_LABEL, k, { enumerable: true, get: function () { return T('shelf.sort.' + k); } });
    Object.defineProperty(SORT_HEAD, k, { enumerable: true, get: function () { return T('shelf.head.' + k); } });
  });
  var REGIONS = ['East Asia', 'South Asia', 'Southeast Asia', 'Middle East', 'Africa', 'Europe', 'Americas', 'Oceania', 'Worldwide/Modern'];
  var FALLBACK = {
    'puzzles.html': { origin: { year: 2004, era: '2004' }, region: 'Worldwide/Modern', players: '1', length: '10 min', kind: 'puzzle', computer: false },
    'stacker.html': { origin: { year: null, era: '1980s' }, region: 'Americas', players: '1', length: '5 min', kind: 'arcade', computer: false },
    'whereintheworld.html': { origin: { year: null, era: null }, region: 'Worldwide/Modern', players: '1', length: '5 min', kind: 'library', computer: false }
  };
  // The eras of the timeline, oldest first; a game of no known age comes last.
  var ERAS = [
    { id: 'ancient', to: 500 },
    { id: 'medieval', to: 1700 },
    { id: 'parlour', to: 1900 },
    { id: 'modern', to: 1970 },
    { id: 'video', to: Infinity }
  ];
  var LENGTHS = [
    { id: 'l5', to: 5 }, { id: 'l10', to: 10 }, { id: 'l15', to: 15 }, { id: 'l30', to: 30 }, { id: 'l30p', to: Infinity }
  ];
  var eraLabel = function (e) { return T('shelf.era.' + e.id); }, eraNote = function (e) { return T('shelf.era.' + e.id + '.note'); };
  var lengthLabel = function (l) { return T('shelf.length.' + l.id); };

  // "c. 500 BC" is -500, "1890s" is 1890, "c. AD 1150" is 1150; nothing readable is null.
  function eraYear(era) {
    var m = /(\d+)\s*(BC)?/.exec(era || '');
    return m ? (m[2] ? -1 : 1) * Number(m[1]) : null;
  }
  // The year a game sorts by: its year, else the one its era names.
  function ageOf(m) {
    if (!m || !m.origin) return null;
    return m.origin.year != null ? m.origin.year : eraYear(m.origin.era);
  }
  function yearText(y) { return y < 0 ? T('shelf.year.bc', { y: -y }) : String(y); }
  // What a chip says of a game's age.
  function ageText(m) {
    if (!m || !m.origin) return '';
    return m.origin.era || (m.origin.year != null ? yearText(m.origin.year) : '');
  }
  function maxPlayers(m) {
    var all = /\d+/g, last = 0, n;
    while ((n = all.exec(m && m.players || ''))) last = Number(n[0]);
    return last;
  }
  function playersText(m) {
    var p = m && m.players;
    return p ? T('shelf.players.line', { p: p, n: maxPlayers(m) }) : '';
  }
  // Minutes from "15 min" ("30 min+" sorts just after "30 min"); 0 when unknown.
  function lengthText(m) { var n = minutesOf(m); return n ? T('shelf.minutes' + (/\+/.test(m.length || '') ? '.plus' : ''), { n: Math.floor(n) }) : (m && m.length) || ''; }
  function minutesOf(m) {
    var n = /(\d+)\s*min(\+?)/.exec(m && m.length || '');
    return n ? Number(n[1]) + (n[2] ? 0.5 : 0) : 0;
  }
  function eraOf(m) {
    var y = ageOf(m);
    if (y == null) return null;
    for (var i = 0; i < ERAS.length; i++) if (y < ERAS[i].to) return ERAS[i];
    return null;
  }

  function byTitle(a, b) { return a.title.localeCompare(b.title, root.ZimiText && root.ZimiText.lang); }
  // Oldest first, games of no known age last, then by name.
  function byAge(meta) {
    return function (a, b) {
      var x = ageOf(meta(a.path)), y = ageOf(meta(b.path));
      if (x == null || y == null) return x == y ? byTitle(a, b) : (x == null ? 1 : -1);
      return x - y || byTitle(a, b);
    };
  }

  // items [{path, title}] -> [{id, label, note, region, items}] in display order, empty groups
  // left out. meta(path) gives a game's row (or null); recent is the paths played, newest first.
  // null for an order that is not a grouping (sections).
  function groupsFor(sort, items, meta, recent) {
    var out = [], by = {};
    function add(id, label, note, region) {
      if (!by[id]) { by[id] = { id: 'g-' + sort + '-' + id, label: label, note: note || '', items: [] }; if (region) by[id].region = region; out.push(by[id]); }
      return by[id];
    }
    var sorted = items.slice();
    if (sort === 'az') {
      add('all', T('shelf.head.az')).items = sorted.sort(byTitle);
    } else if (sort === 'oldest') {
      ERAS.forEach(function (e) { add(e.id, eraLabel(e), eraNote(e)); });
      add('unknown', T('shelf.era.unknown'), T('shelf.era.unknown.note'));
      sorted.sort(byAge(meta)).forEach(function (it) { var e = eraOf(meta(it.path)); by[e ? e.id : 'unknown'].items.push(it); });
    } else if (sort === 'region') {
      REGIONS.forEach(function (r) { add(r, T('shelf.region.' + r), '', r); });
      sorted.sort(byAge(meta)).forEach(function (it) { var m = meta(it.path); by[m && by[m.region] ? m.region : 'Worldwide/Modern'].items.push(it); });
    } else if (sort === 'players') {
      add('solo', T('shelf.players.solo'), T('shelf.players.solo.note'));
      add('two', T('shelf.players.two'), T('shelf.players.two.note'));
      add('many', T('shelf.players.many'), T('shelf.players.many.note'));
      sorted.sort(byTitle).forEach(function (it) { var n = maxPlayers(meta(it.path)); by[n <= 1 ? 'solo' : n === 2 ? 'two' : 'many'].items.push(it); });
    } else if (sort === 'quick') {
      LENGTHS.forEach(function (l) { add(l.id, lengthLabel(l)); });
      sorted.sort(byTitle).forEach(function (it) {
        var n = minutesOf(meta(it.path));
        for (var i = 0; i < LENGTHS.length; i++) if (n <= LENGTHS[i].to) { by[LENGTHS[i].id].items.push(it); break; }
      });
    } else if (sort === 'recent') {
      var order = {};
      (recent || []).forEach(function (p, i) { if (!(p in order)) order[p] = i; });
      var seen = sorted.filter(function (it) { return it.path in order; }).sort(function (a, b) { return order[a.path] - order[b.path]; });
      add('played', T('shelf.recent.played'), T('shelf.recent.played.note')).items = seen;
      add('rest', seen.length ? T('shelf.recent.rest') : T('shelf.recent.none')).items = sorted.filter(function (it) { return !(it.path in order); }).sort(byTitle);
    } else return null;
    return out.filter(function (g) { return g.items.length; });
  }

  var api = { SORTS: SORTS, SORT_LABEL: SORT_LABEL, REGIONS: REGIONS, ERAS: ERAS, FALLBACK: FALLBACK, eraYear: eraYear, ageOf: ageOf, ageText: ageText, playersText: playersText, maxPlayers: maxPlayers, minutesOf: minutesOf, eraOf: eraOf, groupsFor: groupsFor };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  var doc = root.document;
  var shelf = doc && doc.querySelector('.ar-shelf');
  if (!shelf) return;
  var script = doc.currentScript;
  var base = script && script.src ? new URL('.', script.src) : null;

  var LIST_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><line x1="5" y1="3.5" x2="14" y2="3.5"/><line x1="5" y1="8" x2="14" y2="8"/><line x1="5" y1="12.5" x2="14" y2="12.5"/><circle cx="2" cy="3.5" r="1"/><circle cx="2" cy="8" r="1"/><circle cx="2" cy="12.5" r="1"/></svg>';
  var GRID_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="2" width="4.5" height="4.5" rx="1"/><rect x="9.5" y="2" width="4.5" height="4.5" rx="1"/><rect x="2" y="9.5" width="4.5" height="4.5" rx="1"/><rect x="9.5" y="9.5" width="4.5" height="4.5" rx="1"/></svg>';
  var SEARCH_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><line x1="10.5" y1="10.5" x2="14" y2="14"/></svg>';
  // Zimi's Home sort mark (static/app.js _LIB_SORT_SVG).
  var CHEVRON_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
  var SORT_ICON = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/></svg>';
  var VIEW_LABEL = { lobby: 'shelf.view.lobby', index: 'shelf.view.index' };
  var SVG_NS = 'http://www.w3.org/2000/svg';
  // Where each region sits on world-land.js's 800 x 400 grid: [x, y, radius] spots.
  var REGION_SPOTS = {
    'East Asia': [[655, 122, 46]], 'South Asia': [[573, 151, 34]], 'Southeast Asia': [[640, 182, 34]],
    'Middle East': [[500, 138, 34]], 'Africa': [[446, 205, 56]], 'Europe': [[438, 88, 40]],
    'Americas': [[180, 108, 60], [268, 236, 56]], 'Oceania': [[715, 255, 46]]
  };

  function el(tag, cls, html) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function stored(key, allowed, fallback) {
    try {
      var v = root.localStorage.getItem(key);
      if (allowed.indexOf(v) >= 0) return v;
    } catch (e) { /* blocked storage: the default */ }
    return fallback;
  }
  function store(key, v) {
    try { root.localStorage.setItem(key, v); } catch (e) { /* nothing to remember it in */ }
  }
  // The pages played lately, newest first (recent.js keeps the list).
  function readRecent() {
    try {
      var v = JSON.parse(root.localStorage.getItem(RECENT_KEY));
      return Array.isArray(v) ? v.filter(function (e) { return e && e.path; }).map(function (e) { return e.path; }) : [];
    } catch (e) { return []; }
  }

  // The shelf's own words are written in the page in English. When the player's language has them, they are swapped in
  // before anything below reads them (text.js reads the language's file while the page is parsed).
  (function localizeShelf() {
    var Z = root.ZimiText, intro = shelf.querySelector(':scope > header > p');
    if (!Z) return;
    var swap = function (node, key, attr) {
      if (!node || !Z.has(key)) return;
      if (attr) node.setAttribute(attr, T(key)); else node.textContent = T(key);
    };
    swap(intro, 'shelf.intro');
    swap(doc.querySelector('#ar-credits > summary'), 'shelf.credits');
    doc.documentElement.style.setProperty('--play-label', JSON.stringify(T('shelf.play')));
    Array.prototype.forEach.call(shelf.querySelectorAll('.sh-list > .ar-section'), function (s) {
      var h = s.querySelector('h2'), key = 'shelf.section.' + (h.id || '').replace(/^ar-/, '');
      swap(h, key);
      swap(s.querySelector('nav.ar-games'), key, 'aria-label');
    });
    Array.prototype.forEach.call(shelf.querySelectorAll('.ar-family'), function (f) {
      var slug = (f.getAttribute('data-name') || '').toLowerCase().replace(/[^a-z]/g, '');
      swap(f, 'shelf.family.' + slug + '.name', 'data-name');
      swap(f, 'shelf.family.' + slug + '.line', 'data-line');
    });
    if (root.ZimiShell && root.ZimiShell.localizeTiles) root.ZimiShell.localizeTiles(shelf);
  })();

  // The sections, read from the page: id, label and the tiles each holds.
  var list = shelf.querySelector('.sh-list');
  var sections = Array.prototype.map.call(list.querySelectorAll(':scope > .ar-section'), function (s) {
    var h = s.querySelector('h2');
    var tiles = Array.prototype.slice.call(s.querySelectorAll('a.ar-game'));
    h.appendChild(el('span', 'sh-count', String(tiles.length)));
    var grid = s.querySelector('.ar-games');
    return { id: h.id, label: h.firstChild.textContent, node: s, grid: grid, tiles: tiles, entries: Array.prototype.slice.call(grid.children) };
  });
  var total = sections.reduce(function (n, s) { return n + s.tiles.length; }, 0);
  var tilePath = new Map(), tileTitle = new Map();
  sections.forEach(function (s) {
    s.tiles.forEach(function (t) {
      tilePath.set(t, t.getAttribute('href'));
      tileTitle.set(t, t.querySelector('strong').textContent);
    });
  });
  // A tile's words, lowercased, for search: its name and its line (and, once known, where and when).
  var words = new Map();
  sections.forEach(function (s) { s.tiles.forEach(function (t) { words.set(t, t.textContent.toLowerCase()); }); });

  // ── Families: Chess and its cousins, the Solitaires, Draughts ────────────
  // The page wraps each family's tiles in <div class="ar-family" data-name data-line>. Here the wrapper
  // gets a card (the family's name, how many, a mosaic of its games) and the tiles move into a panel the card
  // opens. A tile is still a tile: search, the orders and the game table all go on seeing every variant.
  var families = Array.prototype.map.call(shelf.querySelectorAll('.ar-family'), function (node) { return makeFamily(node); });
  function makeFamily(node) {
    var tiles = Array.prototype.slice.call(node.querySelectorAll('a.ar-game'));
    var card = el('button', 'ar-game sh-fam-card');
    card.type = 'button';
    card.setAttribute('aria-expanded', 'false');
    var art = el('span', 'ar-game-art sh-fam-art');
    tiles.slice(0, 4).forEach(function (t) {
      var img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = 'thumbs/' + t.getAttribute('href').replace(/\.html$/, '.svg');
      art.appendChild(img);
    });
    var text = el('span', 'ar-game-text');
    text.appendChild(el('strong')).textContent = node.getAttribute('data-name');
    text.appendChild(el('span')).textContent = T('shelf.family.line', { n: tiles.length, line: node.getAttribute('data-line') });
    var tag = el('span', 'sh-fam-tag');
    tag.appendChild(el('b')).textContent = String(tiles.length);
    tag.insertAdjacentHTML('beforeend', CHEVRON_ICON);
    card.appendChild(art);
    card.appendChild(text);
    card.appendChild(tag);
    var panel = el('div', 'ar-games sh-fam-panel');
    tiles.forEach(function (t) { panel.appendChild(t); });
    node.classList.add('sh-fam');
    node.appendChild(card);
    node.appendChild(panel);
    var fam = { node: node, tiles: tiles, panel: panel, card: card, user: null };
    card.addEventListener('click', function () { fam.user = !node.classList.contains('sh-open'); syncFamilies(); });
    return fam;
  }
  // A section on its own shows every game it holds, so its number is what is on the screen: its families are open
  // (a family card chosen by hand stays as the player left it until the section changes).
  function syncFamilies() {
    var isolated = state.q.trim() === '' && state.sec !== 'all' && state.sec !== 'recent';
    families.forEach(function (f) {
      var open = f.user === null ? isolated : f.user;
      f.node.classList.toggle('sh-open', open);
      f.card.setAttribute('aria-expanded', String(open));
    });
  }

  var state = { view: stored(VIEW_KEY, VIEWS, 'lobby'), sort: stored(SORT_KEY, SORTS, 'sections'), sec: 'all', q: '' };
  var rows = null; // games.json by page, once read
  var groups = sections; // what is on the shelf now: the sections, or the groups of an order
  var made = []; // group nodes this file made for an order
  var tableCount = 0;
  var landState = '';

  function meta(path) { return (rows && rows[path]) || FALLBACK[path] || null; }
  root.ZimiShelf = { meta: meta };   // a tile's own row, for its long-press menu (tilemenu.js)
  function sortedNow() { return rows && state.sort !== 'sections' ? state.sort : 'sections'; }
  function defaultSection() { return state.view === 'index' && sortedNow() === 'sections' && sections.length ? sections[0].id : 'all'; }
  state.sec = defaultSection();
  if (state.sort !== 'sections') shelf.classList.add('sh-wait');

  // ── Header: search, the order, and the view toggle ───────────────────────
  var header = shelf.querySelector('header');
  var tools = el('div', 'sh-tools');
  var search = el('label', 'sh-search', SEARCH_ICON);
  var input = el('input');
  input.type = 'search';
  input.setAttribute('aria-label', T('shelf.search'));
  input.autocomplete = 'off';
  input.spellcheck = false;
  search.appendChild(input);
  // Zimi's Home control: the order it is in beside a sort mark, the native select lying over it.
  var sortWrap = el('label', 'sh-sort-wrap', SORT_ICON);
  sortWrap.title = T('shelf.sortGames');
  sortWrap.hidden = true;
  var sortNow = el('span', 'sh-sort-now', SORT_LABEL[state.sort]);
  var sortSel = el('select', 'sh-sort');
  sortSel.setAttribute('aria-label', T('shelf.sortGames'));
  SORTS.forEach(function (k) {
    var o = el('option', '', SORT_LABEL[k]);
    o.value = k;
    sortSel.appendChild(o);
  });
  sortSel.value = state.sort;
  sortSel.addEventListener('change', function () { setSort(sortSel.value); });
  sortWrap.appendChild(sortNow);
  sortWrap.appendChild(sortSel);
  var toggle = el('span', 'ar-view-toggle');
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', T('shelf.view'));
  var viewBtns = {};
  [['index', LIST_ICON], ['lobby', GRID_ICON]].forEach(function (v) {
    var b = el('button', 'ar-view-btn', v[1]);
    b.type = 'button';
    b.title = T(VIEW_LABEL[v[0]]);
    b.setAttribute('aria-label', T(VIEW_LABEL[v[0]]));
    b.addEventListener('click', function () { setView(v[0]); });
    viewBtns[v[0]] = b;
    toggle.appendChild(b);
  });
  tools.appendChild(search);
  tools.appendChild(sortWrap);
  tools.appendChild(toggle);
  header.appendChild(tools);

  // ── Body: the rail (section chips), the top (the game table, Game of the day), the list ──
  var body = el('div', 'sh-body');
  var rail = el('div', 'sh-rail');
  var nav = el('nav', 'sh-nav');
  nav.setAttribute('aria-label', T('shelf.head.sections'));
  rail.appendChild(nav);
  var main = el('div', 'sh-main');
  var top = el('div', 'sh-top');
  var empty = el('p', 'sh-empty', T('shelf.noMatch'));
  empty.hidden = true;
  list.parentNode.insertBefore(body, list);
  main.appendChild(top);
  main.appendChild(list);
  main.appendChild(empty);
  body.appendChild(rail);
  body.appendChild(main);

  // The chips (tabs in Index on a phone, a rail on a desktop): All, Recent, then one per group.
  var chips = {};
  var recentChip;
  function chip(id, label, count, cls) {
    var b = el('button', 'sh-chip' + (cls ? ' ' + cls : ''));
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.appendChild(doc.createTextNode(label));
    var n = el('span', 'sh-chip-n', String(count));
    b.appendChild(n);
    b.addEventListener('click', function () { state.sec = id; state.q = ''; input.value = ''; apply(); });
    chips[id] = { btn: b, n: n };
    nav.appendChild(b);
    return b;
  }
  function buildChips() {
    nav.textContent = '';
    chips = {};
    chip('all', T('shelf.chip.all'), total);
    recentChip = chip('recent', T('shelf.chip.recent'), tableCount, 'sh-chip-recent');
    recentChip.hidden = !tableCount;
    // One group is no choice: A to Z has no chips at all.
    nav.setAttribute('aria-label', SORT_HEAD[sortedNow()] || T('shelf.head.sections'));
    nav.hidden = groups.length < 2;
    if (nav.hidden) return;
    nav.appendChild(el('span', 'sh-rail-head', SORT_HEAD[sortedNow()]));
    groups.forEach(function (g) { chip(g.id, g.label, g.tiles.length); });
  }

  // ── Tiles: what and when, in small chips ─────────────────────────────────
  // Index shows them on every row; the other orders show them in Lobby too, since the order is the point.
  function metaLine(path) {
    var m = meta(path);
    if (!m) return null;
    var line = el('small', 'sh-meta');
    [[ageText(m), 'sh-m-age'], [T('shelf.region.' + m.region), 'sh-m-region'], [playersText(m), 'sh-m-players'], [state.sort === 'quick' ? lengthText(m) : '', 'sh-m-length']].forEach(function (c) {
      if (!c[0]) return;
      var e = el('em', c[1]);
      e.textContent = c[0];
      line.appendChild(e);
    });
    return line.children.length ? line : null;
  }
  function decorate(tile, path) {
    var text = tile.querySelector('.ar-game-text');
    if (!text) return;
    var old = text.querySelector('.sh-meta');
    if (old) old.remove();
    var line = metaLine(path);
    if (line) text.appendChild(line);
  }
  function decorateAll() {
    sections.forEach(function (s) { s.tiles.forEach(function (t) { decorate(t, tilePath.get(t)); }); });
    decorateToday();
  }
  // Game of the day is a copy of a tile (a Tatham puzzle borrows the puzzles tile's), made after the page is up.
  function decorateToday() {
    var t = today(), a = t && t.querySelector('a.ar-game');
    if (a) decorate(a, a.getAttribute('href'));
  }

  // ── Layout: the sections as written, or the groups of an order ───────────
  function groupNode(def, tiles) {
    var s = el('section', 'ar-section sh-group');
    s.setAttribute('aria-labelledby', def.id);
    var h = el('h2');
    h.id = def.id;
    if (def.region && landState === 'ready') h.appendChild(regionMap(def.region));
    var name = el('span', 'sh-gt');
    name.textContent = def.label;
    h.appendChild(name);
    if (def.note) {
      var note = el('span', 'sh-note');
      note.textContent = def.note;
      h.appendChild(note);
    }
    h.appendChild(el('span', 'sh-count', String(tiles.length)));
    var grid = el('nav', 'ar-games');
    grid.setAttribute('aria-label', def.label);
    tiles.forEach(function (t) { grid.appendChild(t); });
    s.appendChild(h);
    s.appendChild(grid);
    return { id: def.id, label: def.label, node: s, grid: grid, tiles: tiles };
  }

  // The world in one grey outline (world-land.js, loaded the first time By region is chosen), a region glowing on it.
  function regionMap(region) {
    var svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'sh-map');
    svg.setAttribute('viewBox', '0 0 800 400');
    svg.setAttribute('aria-hidden', 'true');
    var land = doc.createElementNS(SVG_NS, 'path');
    land.setAttribute('d', root.WORLD_LAND_D);
    land.setAttribute('class', 'sh-land');
    svg.appendChild(land);
    (REGION_SPOTS[region] || [[400, 200, 400]]).forEach(function (s) {
      var c = doc.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', s[0]); c.setAttribute('cy', s[1]); c.setAttribute('r', s[2]);
      c.setAttribute('class', 'sh-spot');
      svg.appendChild(c);
    });
    if (!REGION_SPOTS[region]) svg.setAttribute('class', 'sh-map sh-map-all');
    return svg;
  }
  function withLand(done) {
    if (landState || !base) { done(); return; }
    landState = 'loading';
    var s = el('script');
    s.src = new URL('world-land.js', base).href;
    s.onload = function () { landState = root.WORLD_LAND_D ? 'ready' : 'none'; done(); };
    s.onerror = function () { landState = 'none'; done(); };
    doc.head.appendChild(s);
  }

  function layout() {
    families.forEach(function (f) { f.tiles.forEach(function (t) { f.panel.appendChild(t); }); });
    sections.forEach(function (s) { s.entries.forEach(function (e) { s.grid.appendChild(e); }); });
    made.forEach(function (g) { g.node.remove(); });
    made = [];
    var order = sortedNow();
    var defs = order === 'sections' ? null : groupsFor(order, sections.reduce(function (all, s) {
      return all.concat(s.tiles.map(function (t) { return { path: tilePath.get(t), title: tileTitle.get(t), el: t }; }));
    }, []), meta, readRecent());
    if (defs) {
      groups = defs.map(function (d) {
        var g = groupNode(d, d.items.map(function (it) { return it.el; }));
        list.appendChild(g.node);
        made.push(g);
        return g;
      });
    } else groups = sections;
    // An order lays every game out on its own; the families keep to the page's own sections.
    families.forEach(function (f) { f.node.hidden = !!defs; });
    shelf.dataset.sort = order;
    if (state.sec !== 'all' && state.sec !== 'recent' && !groups.some(function (g) { return g.id === state.sec; })) state.sec = defaultSection();
    sortSel.value = state.sort;
    sortNow.textContent = SORT_LABEL[state.sort];
    decorateAll();
    buildChips();
    apply();
  }

  // ── Layout and filtering ─────────────────────────────────────────────────
  function today() { return doc.querySelector('.ar-today'); }

  // Continue and Game of the day come from recent.js, after the page is up.
  function place() {
    var c = doc.querySelector('.ar-continue'), t = today();
    if (c && c.parentNode !== top) top.appendChild(c);
    if (t) {
      // The day's art fills its box, cropped, whatever shape the box is.
      var art = t.querySelector('svg.ar-game-art');
      if (art) art.setAttribute('preserveAspectRatio', 'xMidYMid slice');
      if (state.view === 'index') rail.appendChild(t); else top.appendChild(t);
    }
    tableCount = c && !c.classList.contains('ar-table-idle') ? c.querySelectorAll('.ar-box').length : 0;
    if (recentChip) {
      recentChip.hidden = !tableCount;
      chips.recent.n.textContent = String(tableCount);
    }
    if (!tableCount && state.sec === 'recent') state.sec = defaultSection();
  }

  var lastSec = null;
  function apply() {
    if (state.sec !== lastSec) { lastSec = state.sec; families.forEach(function (f) { f.user = null; }); }
    syncFamilies();
    var q = state.q.trim().toLowerCase();
    var searching = q !== '';
    shelf.dataset.view = state.view;
    shelf.dataset.sec = searching ? 'search' : state.sec;
    shelf.classList.add('sh-on');
    // A phone's lobby header has room for one word beside the mark and the toggle.
    input.placeholder = state.view === 'lobby' && root.matchMedia('(max-width: 699px)').matches ? T('shelf.searchShort') : T('shelf.searchN', { n: total });
    VIEWS.forEach(function (v) { viewBtns[v].setAttribute('aria-pressed', String(v === state.view)); });
    Object.keys(chips).forEach(function (id) { chips[id].btn.setAttribute('aria-pressed', String(!searching && id === state.sec)); });
    var shown = 0;
    sections.concat(made).forEach(function (s) {
      if (groups.indexOf(s) < 0) { s.node.hidden = true; return; }
      var n = 0;
      s.tiles.forEach(function (t) {
        var hit = !searching || words.get(t).indexOf(q) >= 0;
        t.hidden = !hit;
        if (hit) n++;
      });
      var inSec = searching || state.sec === 'all' || state.sec === s.id;
      s.node.hidden = !inSec || n === 0;
      s.node.querySelector('.sh-count').textContent = String(n);
      if (inSec) shown += n;
    });
    var c = doc.querySelector('.ar-continue'), t = today();
    // The feed shows the table and the day's game on All only; Index keeps a resume row on every tab.
    var feedAll = state.sec === 'all';
    if (c) c.hidden = searching || (state.view === 'lobby' && !feedAll);
    if (t) t.hidden = searching || (state.view === 'lobby' && !feedAll);
    if (state.sec === 'recent' && !searching) { sections.concat(made).forEach(function (s) { s.node.hidden = true; }); shown = 1; }
    empty.hidden = shown > 0;
    top.hidden = !!(c && t ? c.hidden && t.hidden : (c ? c.hidden : t ? t.hidden : true));
  }

  function setView(v) {
    if (v === state.view) return;
    state.view = v;
    state.sec = defaultSection();
    store(VIEW_KEY, v);
    place();
    apply();
  }

  function setSort(k) {
    if (SORTS.indexOf(k) < 0 || !rows) return;
    state.sort = k;
    store(SORT_KEY, k);
    state.sec = defaultSection();
    if (k === 'region') withLand(layout); else layout();
  }

  input.addEventListener('input', function () { state.q = input.value; apply(); });
  doc.addEventListener('keydown', function (e) {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && doc.activeElement !== input && !/^(INPUT|TEXTAREA|SELECT)$/.test(doc.activeElement && doc.activeElement.tagName)) {
      e.preventDefault();
      input.focus();
    }
  });
  doc.addEventListener('zimi-shelf-today', function () { place(); decorateToday(); apply(); });

  buildChips();
  place();
  apply();

  // games.json is the shelf's own data (a file of this ZIM). Until it is read, or if it cannot be
  // (a page opened from a place that cannot fetch), the shelf is just its sections.
  function ready(list) {
    rows = {};
    (list || []).forEach(function (r) { if (r && r.path && !rows[r.path] && r.origin) rows[r.path] = r; });
    words.forEach(function (w, t) {
      var m = meta(tilePath.get(t));
      if (m) words.set(t, w + ' ' + [m.region, ageText(m), m.kind, playersText(m), m.computer ? 'computer' : ''].join(' ').toLowerCase());
    });
    sortWrap.hidden = false;
    shelf.classList.remove('sh-wait');
    if (state.sort === 'region') withLand(layout); else layout();
  }
  if (base) {
    root.fetch(new URL('games.json', base).href).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; }).then(function (data) {
      if (data && data.length) ready(data); else { state.sort = 'sections'; shelf.classList.remove('sh-wait'); }
    });
  } else shelf.classList.remove('sh-wait');
})(typeof window !== 'undefined' ? window : globalThis);
