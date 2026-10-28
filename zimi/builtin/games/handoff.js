/* ZimiGames: people sharing one device. Each seat of a game is the Computer or a Person; with
   two or more people a full-screen "Pass to <name>" screen hides the hand until the next person
   taps "I'm <name>, show my cards". Computer seats play in between without a handoff. Names are
   editable and remembered (zimi.games.players), seat kinds per game (zimi.games.<id>.seats).
   Our own code, GPL-3.0. No network, no modules; the rules half is pure and tested in node.

   A page asks:  var seats = ZimiSeats.create({ id: 'hearts', seats: 4 });
     seats.person(s)         is this seat a person at the screen?
     seats.view()            the seat whose hand is face up now (it sits at the bottom)
     seats.rel(s)            where seat s sits on screen, 0 bottom, then clockwise
     seats.name(s)           "You" (one person), the person's name, or the computer's name (Zimi when it is the one computer at a two-seat table)
     seats.needsCover(s)     true when seat s is a person other than the one looking
     seats.cover(s, done)    show the handoff, then call done
     seats.begin(done, first) a fresh deal: nobody has seen it yet
     seats.block(onChange)   the Players rows for the New game sheet */
(function (root) {
  'use strict';
  var PREFIX = 'zimi.games.', NAMES_KEY = PREFIX + 'players', MAX_NAME = 14;
  var COMPASS = { 2: ['south', 'north'], 3: ['south', 'west', 'east'], 4: ['south', 'west', 'north', 'east'] };
  // Every visible string goes through ZimiText (text.js, which shell.js loads); the pure naming rules fall back to English where there is none.
  var T = function (key, vars) { return root.ZimiText ? root.ZimiText.T(key, vars) : key; };
  var POINTS = { south: 'South', west: 'West', north: 'North', east: 'East' };
  var pointName = function (p) { return root.ZimiText ? T(p === 'south' ? 'bridge.seat.south' : 'cards.seat.' + p) : POINTS[p]; };

  // ── storage (guarded: private mode and blocked data must not stop a game) ──
  function read(key, fallback) {
    try { var v = JSON.parse(root.localStorage.getItem(key)); return v && typeof v === 'object' ? v : fallback; } catch (e) { return fallback; }
  }
  function write(key, value) {
    try { root.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* play on without it */ }
  }

  // ── pure rules ──
  function defaultName(i) { return root.ZimiText ? T('seats.player', { n: i + 1 }) : 'Player ' + (i + 1); }
  function cleanName(text, i) {
    var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    return t || defaultName(i);
  }
  // A seat list of n kinds: only 'person' or 'cpu', and at least one person (seat 0 by default).
  function cleanKinds(kinds, n) {
    var out = [], i;
    for (i = 0; i < n; i++) out.push(kinds && kinds[i] === 'cpu' ? 'cpu' : kinds && kinds[i] === 'person' ? 'person' : i === 0 ? 'person' : 'cpu');
    if (out.indexOf('person') < 0) out[0] = 'person';
    return out;
  }
  function peopleOf(kinds) { return kinds.map(function (k, i) { return k === 'person' ? i : -1; }).filter(function (i) { return i >= 0; }); }
  // Where seat s sits when seat `view` is at the bottom of an n-seat table: 0 bottom, then clockwise.
  function relOf(seat, view, n) { return (seat - view + n) % n; }
  // Should the handoff come up before `seat` plays? Only for a second person, never for a
  // computer, never for the person already looking.
  function needsCover(kinds, viewer, seat) {
    return peopleOf(kinds).length >= 2 && kinds[seat] === 'person' && viewer !== seat;
  }
  // A proper name, the same in every language. The one computer across a two-seat table is Zimi; with two or more computers
  // the seats keep their names (the compass points, or a game's own list), and a partner is never Zimi.
  var ZIMI = (root.ZimiText && root.ZimiText.ZIMI) || 'Zimi';
  function compassName(n, rel) { return n === 2 && rel === 1 ? ZIMI : pointName((COMPASS[n] || COMPASS[4])[rel]); }
  function loadNames(count) {
    var saved = read(NAMES_KEY, []), out = [], i;
    for (i = 0; i < count; i++) out.push(cleanName(Array.isArray(saved) ? saved[i] : '', i));
    return out;
  }

  // ── styles (injected, so a page needs only the script) ──
  // The handoff screen is the only thing styled here, in the shared tokens; the Players rows are the shared
  // row, segmented control and field (games.css), so they look like every other option in the Menu.
  var CSS = '.zs-cover{position:fixed;inset:0;z-index:90;display:grid;place-items:center;padding:24px;background:var(--ground);color:var(--ink);text-align:center;font-family:var(--font)}' +
    '.zs-cover-card{width:min(420px,100%);display:grid;gap:14px;justify-items:center}' +
    '.zs-cover img{width:44px;height:44px}' +
    '.zs-cover small{font-size:var(--fs-small);color:var(--ink2)}' +
    '.zs-cover h2{margin:0;font-size:var(--fs-display);line-height:1.15;overflow-wrap:anywhere}' +
    '.zs-cover p{margin:0;color:var(--ink2);font-size:var(--fs-body)}';
  function ensureStyle() {
    var d = root.document;
    if (!d || d.getElementById('zs-style')) return;
    var s = d.createElement('style'); s.id = 'zs-style'; s.textContent = CSS; (d.head || d.documentElement).appendChild(s);
  }

  function el(tag, cls, text) {
    var e = root.document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // cfg: { id, seats, cpuNames (by seat, optional), seatLabels (optional), onChange() }
  function create(cfg) {
    var n = cfg.seats, kinds = cleanKinds((read(PREFIX + cfg.id + '.seats', {}) || {}).kinds, n), names = loadNames(Math.max(n, 4));
    var S = { n: n, viewer: -1, covering: false };

    S.kinds = function () { return kinds.slice(); };
    S.person = function (seat) { return kinds[seat] === 'person'; };
    S.people = function () { return peopleOf(kinds); };
    S.hotseat = function () { return peopleOf(kinds).length >= 2; };
    // The seat whose hand is face up: the one person alone, or whoever last took the screen.
    S.view = function () { return S.hotseat() && S.viewer >= 0 ? S.viewer : peopleOf(kinds)[0]; };
    S.rel = function (seat) { return relOf(seat, S.view(), n); };
    S.compass = function (seat) { return compassName(n, S.rel(seat)); };
    S.name = function (seat) {
      if (kinds[seat] === 'cpu') return n === 2 ? ZIMI : cfg.cpuNames ? cfg.cpuNames[seat] : S.compass(seat);
      return S.hotseat() ? names[seat] : T('cards.you');
    };
    // "You" is spoken to the viewer only; a sentence about someone else uses their name.
    S.isYou = function (seat) { return !S.hotseat() && kinds[seat] === 'person'; };
    S.needsCover = function (seat) { return needsCover(kinds, S.viewer, seat); };
    S.setKind = function (seat, kind) { kinds = cleanKinds(kinds.map(function (k, i) { return i === seat ? kind : k; }), n); write(PREFIX + cfg.id + '.seats', { kinds: kinds }); };
    S.setName = function (seat, text) { names[seat] = cleanName(text, seat); write(NAMES_KEY, names); };

    // The handoff. It cannot be dismissed with Escape or a click outside: only the button shows the cards.
    S.cover = function (seat, done, note) {
      if (S.covering) return;
      if (!root.document) { S.viewer = seat; if (done) done(); return; }
      ensureStyle();
      S.covering = true;
      var who = names[seat], host = el('div', 'zs-cover'), card = el('div', 'zs-cover-card');
      host.setAttribute('role', 'dialog'); host.setAttribute('aria-modal', 'true'); host.setAttribute('aria-label', T('seats.passTo', { name: who }));
      var logo = el('img'); logo.src = 'mark.svg'; logo.alt = '';
      var go = el('button', 'ar-btn gs-primary', T('seats.show', { name: who })); go.type = 'button'; go.setAttribute('aria-pressed', 'true');
      card.appendChild(logo); card.appendChild(el('small', null, T('seats.passToSmall'))); card.appendChild(el('h2', null, who));
      card.appendChild(el('p', null, note || T('seats.passNote')));
      card.appendChild(go); host.appendChild(card);
      host.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); } else if (e.key === 'Tab') { e.preventDefault(); go.focus(); }
      });
      var prev = root.document.activeElement;
      go.addEventListener('click', function () {
        host.remove(); S.covering = false; S.viewer = seat;
        if (prev && prev.blur) try { prev.blur(); } catch (e) { /* gone */ }
        if (cfg.onChange) cfg.onChange();
        if (done) done();
      });
      root.document.body.appendChild(host); go.focus();
    };
    // Cover for `seat` when it needs one, then run `done`; otherwise just run `done`.
    S.ensure = function (seat, done, note) {
      if (S.needsCover(seat)) S.cover(seat, done, note); else if (done) done();
    };
    // A fresh deal or game: nobody has seen it. With several people the first person-to-move's
    // screen comes up first (or the first person if a computer opens); with one person, no handoff.
    S.begin = function (done, first) {
      S.covering = false;
      var old = root.document && root.document.querySelector && root.document.querySelector('.zs-cover');
      if (old) old.remove();
      if (!S.hotseat()) { S.viewer = peopleOf(kinds)[0]; if (cfg.onChange) cfg.onChange(); if (done) done(); return; }
      S.viewer = -1;
      if (cfg.onChange) cfg.onChange();
      S.cover(first != null && kinds[first] === 'person' ? first : peopleOf(kinds)[0], done);
    };

    // The Players rows of the New game sheet. Changes are saved at once and take effect
    // from the next game. A name box shows for each person once there are two.
    // opts: { labels (row names), note, cpuLabel (what a seat that is not a person is called) }
    S.block = function (onChange, opts) {
      ensureStyle();
      opts = opts || {};
      var box = el('div', 'zs-seats gs-seats'), rows = [];
      box.appendChild(el('h3', 'gs-subhead', T('seats.players')));
      function refresh() {
        var multi = S.hotseat();
        rows.forEach(function (r, i) {
          var isP = kinds[i] === 'person';
          Array.prototype.forEach.call(r.seg.children, function (b) { b.setAttribute('aria-pressed', String((b.dataset.kind === 'person') === isP)); });
          r.input.hidden = !(isP && multi);
        });
        note.hidden = !multi;
      }
      for (var i = 0; i < n; i++) (function (i) {
        var row = el('div', 'gs-row gs-seat-row'), seg = el('div', 'gs-seg'), input = el('input', 'gs-seat-name');
        seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', T('seats.is', { seat: opts.labels ? opts.labels[i] : T('seats.seatN', { n: i + 1 }) }));
        [['cpu', opts.cpuLabel || (n === 2 ? ZIMI : T('cards.computer'))], ['person', T('seats.person')]].forEach(function (k) {
          var b = el('button', 'ar-btn', k[1]); b.type = 'button'; b.dataset.kind = k[0];
          b.addEventListener('click', function () { S.setKind(i, k[0]); refresh(); if (onChange) onChange(); });
          seg.appendChild(b);
        });
        input.type = 'text'; input.maxLength = MAX_NAME; input.value = names[i]; input.setAttribute('aria-label', T('seats.nameFor', { n: i + 1 }));
        input.addEventListener('change', function () { S.setName(i, input.value); input.value = names[i]; });
        row.appendChild(el('label', null, opts.labels ? opts.labels[i] : T('seats.seatN', { n: i + 1 })));
        row.appendChild(seg); row.appendChild(input); box.appendChild(row); rows.push({ seg: seg, input: input });
      })(i);
      var note = el('p', 'gs-note', T('seats.note') + ' ' + (opts.note || ''));
      box.appendChild(note);
      refresh();
      return box;
    };
    return S;
  }

  // One shared list of names for the computers a game seats (T('seats.cpu.1') ...), so no game invents its own.
  var CPU_NAME_COUNT = 6;
  function cpuName(i) { return T('seats.cpu.' + (i % CPU_NAME_COUNT + 1)); }
  root.ZimiSeats = { ZIMI: ZIMI, cpuName: cpuName, create: create, cleanKinds: cleanKinds, cleanName: cleanName, defaultName: defaultName, peopleOf: peopleOf, relOf: relOf, needsCover: needsCover, compassName: compassName, loadNames: loadNames, NAMES_KEY: NAMES_KEY };
})(typeof globalThis !== 'undefined' ? globalThis : window);
