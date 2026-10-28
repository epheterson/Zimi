/* ZimiGames: Timeline. Five events, in the order they happened: tap them earliest first, then check. The events come from
   the player's Wikipedia date pages ("September 25": its Events list, a year and a line each): inside Zimi from the events
   Zimi already keeps for three days (/wiki/today, parts=otd), inside kiwix-serve by reading a date page's list here. Elsewhere it asks
   the built-in events in timeline-data.js. A game is three rounds of five; a point for each event put where it belongs.
   The rules are pure functions (no DOM, so node can test them), then the page. Our own code, GPL-3.0. */
(function (root) {
  'use strict';
  var Lib = root.GamesLib;

  // ── the rules ────────────────────────────────────────────────────────────
  var ROUNDS = 3, MIN_ROUNDS = 2, SIZE = 5, MIN_GAP = 5, ATTEMPTS = 40, TEXT_MIN = 20, TEXT_MAX = 200, PAGE_BYTES = 700000;
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  // "1066", "44 BC", "AD 79", "1066 CE" as a number (negative before the common era), or NaN.
  function yearOf(text) {
    var m = /^\s*(?:AD\s*)?(\d{1,4})\s*(BCE?|B\.C\.|AD|CE)?\s*$/i.exec(String(text || ''));
    if (!m) return NaN;
    return /^b/i.test(m[2] || '') ? -Number(m[1]) : Number(m[1]);
  }

  function plain(h) {
    return String(h).replace(/<(sup|style|script)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#8217;|&rsquo;/g, '’').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // The Events list of an English date page: [{year, text}] for each line that starts with a year and a dash. Births and
  // deaths (their own sections) are left out. Whole or cut off anywhere: the lines before the cut are kept.
  function parseEvents(html) {
    var src = String(html || ''), at = /<h2[^>]*id="Events"[^>]*>/i.exec(src), out = [];
    if (!at) return out;
    src = src.slice(at.index + at[0].length);
    var next = /<h2[\s>]/i.exec(src);
    if (next) src = src.slice(0, next.index);
    var re = /<li[^>]*>([\s\S]*?)<\/li>/gi, m;
    while ((m = re.exec(src))) {
      var line = plain(m[1].replace(/<ul[\s\S]*$/i, '')), p = /^(\d{1,4}(?:\s*(?:BC|BCE|AD))?)\s*[–—-]\s*(.+)$/.exec(line);
      if (p && isFinite(yearOf(p[1]))) out.push({ year: yearOf(p[1]), text: p[2].trim() });
    }
    return out;
  }

  // Events fit to ask about: a year, a line of a sensible length that does not give its own year away.
  function usable(events) {
    var seen = {};
    return events.filter(function (e) {
      if (!isFinite(e.year) || !e.text || e.text.length < TEXT_MIN || e.text.length > TEXT_MAX) return false;
      if (new RegExp('(?<!\\d)' + Math.abs(e.year) + '(?!\\d)').test(e.text)) return false;
      var k = Lib.fold(e.text);
      return !seen[k] && (seen[k] = true);
    });
  }

  // `rounds` sets of `size` events, no two within MIN_GAP years of each other in a set, no event twice. Fewer if the events
  // run out of room.
  function makeSets(events, rounds, size, rng) {
    var pool = usable(events), sets = [];
    for (var r = 0; r < rounds; r++) {
      var made = null;
      for (var tries = 0; tries < ATTEMPTS && !made; tries++) {
        var pick = [];
        Lib.shuffle(pool, rng).forEach(function (e) {
          if (pick.length < size && pick.every(function (p) { return Math.abs(p.year - e.year) >= MIN_GAP; })) pick.push(e);
        });
        if (pick.length === size) made = pick;
      }
      if (!made) break;
      sets.push(made);
      pool = pool.filter(function (e) { return made.indexOf(e) < 0; });
    }
    return sets;
  }

  // How many events the player put where they belong. `order` lists the set's indexes in the player's order, earliest first.
  function scoreOrder(set, order) {
    var truth = set.map(function (e, i) { return i; }).sort(function (a, b) { return set[a].year - set[b].year; });
    return order.reduce(function (n, idx, pos) { return n + (truth[pos] === idx ? 1 : 0); }, 0);
  }
  function truthOrder(set) { return set.map(function (e, i) { return i; }).sort(function (a, b) { return set[a].year - set[b].year; }); }

  // Any day of the year as a date page's title: "September_25" (never February 29 on a day that has none).
  function dayTitle(rng) {
    var m = Math.floor(rng() * 12), d = 1 + Math.floor(rng() * DAYS_IN[m]);
    return MONTHS[m] + '_' + d;
  }

  function miniEvents(data) { return data.map(function (d) { return { year: d[0], text: d[1] }; }); }

  root.TimelineEngine = { yearOf: yearOf, parseEvents: parseEvents, usable: usable, makeSets: makeSets, scoreOrder: scoreOrder, truthOrder: truthOrder, dayTitle: dayTitle, miniEvents: miniEvents, ROUNDS: ROUNDS, SIZE: SIZE };
  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  Play.applyTheme();
  var BEST_KEY = 'zimi.games.timeline.best';
  var els = { n: $('tl-n'), how: $('tl-how'), list: $('tl-list'), msg: $('tl-msg'), score: $('tl-score'), clear: $('tl-clear'), check: $('tl-check'), next: $('tl-next'), newBtn: $('tl-new') };
  var status = Play.status(els.msg);
  var zim = '', sets = [], at = 0, order = [], checked = false, score = 0, building = false, done = false;

  var el = root.ZimiUtil.el;
  // Digits in the player's script, never grouped: 1969, not 1,969.
  function digits(y) { try { return new Intl.NumberFormat(Lib.uiLang(), { useGrouping: false }).format(y); } catch (e) { return String(y); } }
  function yearText(y) { return y < 0 ? T('timeline.yearBc', { n: digits(-y) }) : y < 1000 ? T('timeline.yearAd', { n: digits(y) }) : digits(y); }
  function ready() { return !checked && order.length === SIZE; }

  function paintScore() {
    els.n.textContent = sets.length ? T('timeline.round', { n: at + 1, total: sets.length }) : '';
    els.score.textContent = T('round.score', { n: score });
  }
  function paintButtons() {
    els.clear.hidden = checked; els.check.hidden = checked; els.next.hidden = !checked;
    els.clear.setAttribute('aria-disabled', String(!order.length));
    els.check.setAttribute('aria-disabled', String(!ready()));
  }
  // The set on screen: in the order dealt while the player places them, in true order once checked.
  function paintList() {
    var set = sets[at], truth = truthOrder(set), shown = checked ? truth : set.map(function (e, i) { return i; });
    els.list.innerHTML = '';
    shown.forEach(function (idx) {
      var e = set[idx], pos = order.indexOf(idx), li = el('li'), b = el('button', 'tl-item'); b.type = 'button'; b.dataset.i = idx;
      var badge = el('span', 'tl-pos', pos >= 0 ? Play.num(pos + 1) : ''), text = el('span', 'tl-text', e.text); text.dir = 'auto';
      b.appendChild(badge); b.appendChild(text);
      if (pos >= 0) b.classList.add('placed');
      if (checked) {
        b.disabled = true; b.classList.remove('placed');
        var right = truth[pos] === idx;
        b.classList.add(right ? 'right' : 'wrong');
        b.appendChild(el('span', 'tl-year', yearText(e.year)));
        badge.textContent = (right ? '✓' : '✗');
        b.setAttribute('aria-label', T(right ? 'timeline.rightAria' : 'timeline.wrongAria', { text: e.text, year: yearText(e.year) }));
      } else if (pos >= 0) b.setAttribute('aria-label', T('timeline.placedAria', { text: e.text, n: pos + 1 }));
      li.appendChild(b); els.list.appendChild(li);
    });
  }
  function show() {
    els.how.textContent = T(checked ? 'timeline.howDone' : 'timeline.how');
    paintList(); paintButtons(); paintScore();
    status.say(checked ? T('timeline.got', { n: scoreOrder(sets[at], order), total: SIZE }) : '');
    els.next.textContent = T(at + 1 >= sets.length ? 'round.seeScore' : 'round.next');
    Lib.englishNote(T, 'lang.enEvents', !zim);
  }

  function tap(idx) {
    if (checked || done) return;
    var p = order.indexOf(idx);
    if (p >= 0) order.splice(p, 1); else order.push(idx);
    paintList(); paintButtons();
    if (ready()) els.check.focus();
  }
  function check() {
    if (!ready()) { status.reason(T('timeline.placeAll')); return; }
    checked = true; var got = scoreOrder(sets[at], order); score += got;
    show(); if (got) Lib.bump(els.score);
    els.next.focus();
  }
  function advance() {
    if (!checked) return;
    if (at + 1 >= sets.length) return finish();
    at++; order = []; checked = false; show();
  }
  function finish() {
    var best = Play.load(BEST_KEY, {}), key = zim || 'built-in', mine = best[key] || 0, total = sets.length * SIZE;
    if (score > mine) { best[key] = score; Play.save(BEST_KEY, best); }
    var line = T('round.verdict.' + Lib.verdict(score, total));
    status.say(line); done = true;
    ZimiShell.endSheet({ result: 'over', text: line, stats: [[T('play.score'), T('round.of', { n: score, total: total })], [T('play.best'), Play.num(Math.max(score, mine))]] });
  }

  // ── where the events come from ──
  // Zimi keeps eight events a day, so a game takes the three days a server accepts (yesterday, today, tomorrow): every
  // answer is one Zimi already holds for the front page's On this day, and a round never has two events of one day's page.
  function fromZimi(name) {
    var days = [-1, 0, 1].map(function (k) { var d = new Date(); d.setDate(d.getDate() + k); return Lib.dayKey(d); });
    return Promise.all(days.map(function (day) {
      return Lib.json('/wiki/today?day=' + day + '&zim=' + encodeURIComponent(name) + '&parts=otd', 20000).then(function (r) {
        return ((r && r.otd && r.otd[name]) || []).map(function (e) { return { year: yearOf(e.event_year), text: String(e.event_text || '').trim() }; });
      }, function () { return []; });
    })).then(function (lists) { return [].concat.apply([], lists); });
  }
  function fromKiwix(name) {
    return Lib.pageHead(name, [dayTitle(Math.random)], PAGE_BYTES, 20000).then(function (got) { return got ? parseEvents(got.html) : []; });
  }
  function buildSets() {
    var work = !zim ? Promise.resolve([]) : (Lib.modeNow() === 'kiwix' ? fromKiwix(zim) : fromZimi(zim));
    return work.catch(function () { return []; }).then(function (events) {
      var got = makeSets(events, ROUNDS, SIZE, Math.random);
      if (got.length >= MIN_ROUNDS) return got;
      zim = '';
      return makeSets(miniEvents(root.TIMELINE_MINI), ROUNDS, SIZE, Math.random);
    });
  }

  function newGame() {
    if (building) return; building = true; at = 0; order = []; checked = false; score = 0; done = false; sets = [];
    els.how.textContent = T('timeline.choosing'); els.list.innerHTML = ''; els.n.textContent = ''; status.say('');
    els.how.classList.add('gl-loading'); els.clear.hidden = els.check.hidden = els.next.hidden = true;
    buildSets().then(function (got) { building = false; els.how.classList.remove('gl-loading'); sets = got; show(); });
  }

  els.list.addEventListener('click', function (e) { var b = e.target.closest('.tl-item'); if (b) tap(+b.dataset.i); });
  els.clear.addEventListener('click', function () { if (!order.length || checked) return; order = []; paintList(); paintButtons(); });
  els.check.addEventListener('click', check);
  els.next.addEventListener('click', advance);
  els.newBtn.addEventListener('click', newGame);
  ZimiShell.game({
    about: function () { return Lib.note(T, 'events', zim); },
    inProgress: function () { return !done && !building && sets.length > 0 && (at > 0 || order.length > 0 || checked); },
    stats: function () {
      var best = Play.load(BEST_KEY, {}), keys = Object.keys(best);
      return keys.length ? [[T('play.best'), Play.num(Math.max.apply(null, keys.map(function (k) { return best[k]; })))]] : [];
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.ar-sheet:not([hidden])')) return;
    if ((e.key === 'Enter') && checked && document.activeElement === els.next) return;   // the button handles its own press
    if (/^[1-5]$/.test(e.key) && !checked && sets[at]) { var items = els.list.querySelectorAll('.tl-item'); if (items[+e.key - 1]) tap(+items[+e.key - 1].dataset.i); }
  });

  Lib.library().then(function (list) {
    var a = Lib.pickZim(list, 'wikipedia', Lib.uiLang());
    // Zimi reads every language's date pages; kiwix-serve's is read here, in English only
    var english = a && Lib.primaryLang(a.zim.language) === 'en';
    zim = a && (english || Lib.modeNow() === 'zimi') ? a.zim.name : '';
    var kept = ZimiShell.saved();
    if (kept && kept.sets && kept.sets.length) {
      sets = kept.sets; at = kept.at; order = kept.order || []; checked = !!kept.checked; score = kept.score || 0; zim = kept.zim || '';
      show(); if (kept.done) finish();
    } else { if (kept) ZimiShell.forget(); newGame(); }
  });
  ZimiShell.persist({
    save: function () { return sets.length && (at > 0 || order.length || checked) ? { zim: zim, sets: sets, at: at, order: order, checked: checked, score: score, done: done } : null; }
  });
  root.__timeline = { get sets() { return sets; }, get zim() { return zim; }, get order() { return order; }, get checked() { return checked; }, get score() { return score; }, get at() { return at; } };
})(this);
