/* ZimiGames: Wiki Race. Get from one article to another by following links only.
   Inside Zimi the race is run on the player's own Wikipedia (their language), reading the articles the reader
   already serves; the end is found by walking a few links from the start, so a route always exists. In Kiwix
   or from a folder it is run on a small web of articles shipped in wikirace-data.js. Our own code, GPL-3.0.
   The rules (pure functions, no DOM, so node can test them) and the page (only when there is a document). */
(function (root) {
  'use strict';
  var Lib = root.GamesLib;

  // ── the rules ────────────────────────────────────────────────────────────
  var MIN_LINKS = 6;          // an article with fewer links is a dead end, not a place to race from or to
  var WALK_LINKS = 60;        // the walk chooses among an article's first links (its body, not its far notes)
  var WALK_TRIES = 14;        // pages tried, in all, to take the hops of one walk
  var MIN_HOPS = 3, MAX_HOPS = 4;

  function normTitle(t) { return Lib.fold(String(t || '')).replace(/[_\s]+/g, ' ').trim(); }

  // Has the player reached the target? The same path, or the same title (a redirect lands on its article).
  function isTarget(page, target) {
    return page.path === target.path || normTitle(page.title) === normTitle(target.title);
  }

  // Is a race honest? steps: [{path, via}] with via 'start', 'link' or 'back'. A link step must be one of the
  // links of the page before it; a back step returns to the page before that one.
  function validatePath(steps, linksOf) {
    if (!steps.length || steps[0].via !== 'start') return { ok: false, at: 0 };
    for (var i = 1; i < steps.length; i++) {
      var s = steps[i], prev = steps[i - 1];
      if (s.via === 'back') { if (i < 2 || steps[i - 2].path !== s.path) return { ok: false, at: i }; }
      else if (s.via === 'link') { if ((linksOf(prev.path) || []).indexOf(s.path) < 0) return { ok: false, at: i }; }
      else return { ok: false, at: i };
    }
    return { ok: true, at: -1 };
  }

  // The fewest clicks from one page to another (breadth first). -1 when there is no route.
  function shortest(linksOf, from, to) {
    if (from === to) return 0;
    var dist = {}, queue = [from];
    dist[from] = 0;
    for (var q = 0; q < queue.length; q++) {
      var here = queue[q], next = linksOf(here) || [];
      for (var i = 0; i < next.length; i++) {
        if (dist[next[i]] !== undefined) continue;
        dist[next[i]] = dist[here] + 1;
        if (next[i] === to) return dist[to];
        queue.push(next[i]);
      }
    }
    return -1;
  }

  // From a first page, follow `hops` links chosen by chance among each page's first links, never to a page
  // already on the way and never to a dead end. open(path) answers {path, title, links:[{path, title}]};
  // the pages walked come back, the first included, fewer when the walk gets stuck.
  function walk(open, first, hops, rng) {
    var pages = [first], seen = {}, tries = 0;
    seen[first.path] = true;
    function step() {
      if (pages.length > hops || tries >= WALK_TRIES) return Promise.resolve(pages);
      var cands = pages[pages.length - 1].links.filter(function (l) { return !seen[l.path]; }).slice(0, WALK_LINKS);
      if (!cands.length) return Promise.resolve(pages);
      var pick = cands[Math.floor(rng() * cands.length)];
      seen[pick.path] = true; tries++;
      return open(pick.path).then(function (p) {
        if (p && p.links.length >= MIN_LINKS) pages.push(p);
        return step();
      }, step);
    }
    return step();
  }

  function raceText(title, date, steps, ms) {
    return title + ' ' + date + '\n' + steps.map(function (s) { return s.title; }).join(' > ') + '\n' + (steps.length - 1) + ' clicks, ' + Math.floor(ms / 1000) + ' s';
  }

  var Engine = { isTarget: isTarget, validatePath: validatePath, shortest: shortest, walk: walk, normTitle: normTitle, raceText: raceText, MIN_LINKS: MIN_LINKS, MIN_HOPS: MIN_HOPS, MAX_HOPS: MAX_HOPS };
  root.WikiRaceEngine = Engine;

  if (typeof document === 'undefined') return;

  // ── the page ─────────────────────────────────────────────────────────────
  var Play = root.ArcadePlay, $ = Play.$, T = Play.T;
  Play.applyTheme();
  var DAILY_KEY = 'zimi.games.wikirace.daily', BEST_KEY = 'zimi.games.wikirace.best';
  var CAP_CHARS = 60000, HINT_CHARS = 150, HOT_TIE_MS = 1000;
  // Parts of an article the race leaves out: boxes, notes, pictures, menus.
  var DROP_TAGS = /^(SCRIPT|STYLE|TABLE|FIGURE|IMG|NOSCRIPT|SUP|IFRAME|OBJECT|SVG|MATH|AUDIO|VIDEO|FORM|BUTTON|INPUT|HEAD|LINK|META|NAV|ASIDE|TEMPLATE|H1)$/;
  var DROP_CLASS = /\b(navbox|reflist|mw-references-wrap|hatnote|noprint|mw-editsection|metadata|sistersitebox|shortdescription|infobox|thumb|gallery|toc)\b/;
  var KEEP_TAGS = /^(P|B|I|EM|STRONG|UL|OL|LI|H2|H3|H4|DL|DT|DD|BLOCKQUOTE|SPAN|BR|SMALL|U|SUB|CODE)$/;

  var els = { clicks: $('rc-clicks'), trail: $('rc-trail'), pane: $('rc-pane'), back: $('rc-back'), give: $('rc-give'), share: $('rc-share'), target: $('rc-target'),
    msg: $('rc-msg'), newBtn: $('rc-new') };
  var line = Play.status(els.msg), pendingMode = null;   // the status line; a choice made in the New game pane, taken when it starts
  var provider = null, race = null, busy = false;
  var today = Lib.dayKey(new Date());

  var el = root.ZimiUtil.el;
  function say(node) { els.pane.innerHTML = ''; els.pane.appendChild(node); els.pane.scrollTop = 0; }
  function notice(title, text, button, onClick) {
    var box = el('div', 'rc-card'); box.appendChild(el('h2', null, title));
    if (text) box.appendChild(el('p', null, text));
    if (button) { var b = el('button', 'ar-btn gm-play', button); b.type = 'button'; b.addEventListener('click', onClick); box.appendChild(b); }
    say(box);
  }

  // A link inside an article: a span the page handles (no href, so Zimi's reader does not take it for a page change).
  function makeLink(path, text) {
    var a = el('a', 'rc-link', text); a.setAttribute('role', 'link'); a.tabIndex = 0; a.dataset.path = path; return a;
  }
  function firstSentence(node) {
    var p = node.querySelector('p'), t = (p ? p.textContent : node.textContent).replace(/\s+/g, ' ').trim();
    var cut = t.search(/[.!?](\s|$)/);
    if (cut > 20 && cut < HINT_CHARS) t = t.slice(0, cut + 1);
    return t.length > HINT_CHARS ? t.slice(0, HINT_CHARS).replace(/\s\S*$/, '') + '...' : t;
  }

  // ── Zimi's library: the player's Wikipedia, read the way the reader reads it ──
  function zimiProvider(zimRec) {
    var zim = zimRec.name, cache = {};
    // Rebuild an article from its HTML into plain, safe elements: only the tags above, no attributes but a link's path.
    function clean(src, into, from, state) {
      for (var n = src.firstChild; n; n = n.nextSibling) {
        if (state.chars > CAP_CHARS) return;
        if (n.nodeType === 3) { into.appendChild(document.createTextNode(n.nodeValue)); state.chars += n.nodeValue.length; continue; }
        if (n.nodeType !== 1) continue;
        var tag = n.tagName.toUpperCase();
        if (DROP_TAGS.test(tag) || DROP_CLASS.test(n.getAttribute('class') || '') || /display\s*:\s*none/.test(n.getAttribute('style') || '')) continue;
        if (tag === 'A') {
          var path = Lib.resolvePath(zim, from, n.getAttribute('href'), Lib.pathRoot());
          if (path) {
            var a = makeLink(path, ''); clean(n, a, from, state);
            if (!a.textContent.trim()) continue;
            state.links.push({ path: path, title: (n.getAttribute('title') || a.textContent).trim() });
            into.appendChild(a);
          } else clean(n, into, from, state);
          continue;
        }
        if (KEEP_TAGS.test(tag)) { var e = document.createElement(tag.toLowerCase()); clean(n, e, from, state); into.appendChild(e); }
        else clean(n, into, from, state);
      }
    }
    function open(path) {
      if (cache[path]) return Promise.resolve(cache[path]);
      return Lib.article(zim, path).then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var body = doc.querySelector('#mw-content-text') || doc.body;
        var h1 = doc.querySelector('h1'), title = ((h1 && h1.textContent) || doc.title || Lib.titleOfPath(path)).trim();
        var state = { chars: 0, links: [] }, node = el('div', 'rc-article');
        clean(body, node, path, state);
        var seen = {}, links = state.links.filter(function (l) { return !seen[l.path] && (seen[l.path] = true); });
        return (cache[path] = { path: path, title: title, node: node, links: links });
      });
    }
    // The pair: a start (the day's for the daily, else by chance), and an end that is a few links away.
    function pickStart(daily) {
      // the day's card, else a pick seeded by the day: one start for everyone (kiwix-serve cannot seed, so there it is by chance)
      return Lib.random(zim, { day: daily ? today : '' }).then(function (r) {
        if (!r || !r.path || r.path === zimRec.main_path || r.path.indexOf(':') >= 0) throw new Error('no start');
        return open(r.path);
      });
    }
    // The front page always has links, and the walk can leave from one of them: the same one for the same seed.
    function fromMain(rng) {
      return open(zimRec.main_path || '').then(function (m) {
        return m.links.length ? open(m.links[Math.floor(rng() * Math.min(m.links.length, WALK_LINKS))].path) : Promise.reject(new Error('empty'));
      });
    }
    // The daily race leaves from the day's card, else from the front page (never from chance, or it would not be one race);
    // a race of practice from a few random tries, then the front page.
    function startFrom(daily, rng, tries) {
      return pickStart(daily).then(function (p) {
        if (p.links.length >= MIN_LINKS) return p;
        throw new Error('dead end');
      }).catch(function () {
        return daily || tries >= 4 ? fromMain(rng) : startFrom(daily, rng, tries + 1);
      });
    }
    function pick(daily) {
      var rng = Lib.rng(Lib.hash(zim + '|' + (daily ? today : String(Math.random()))));
      var hops = MIN_HOPS + Math.floor(rng() * (MAX_HOPS - MIN_HOPS + 1));
      return startFrom(daily, rng, 0).then(function (first) {
        return walk(open, first, hops, rng);
      }).then(function (pages) {
        var s = pages[0], e = pages[pages.length - 1];
        if (pages.length < 3 || e.path === s.path) throw new Error('no pair');
        return { start: s, end: e, par: pages.length - 1, parKind: 'route' };
      });
    }
    return { label: zimRec.title || zim, zim: zim, lang: zimRec.language, open: open, pick: pick, built: false };
  }

  // ── the built-in set: for a page with no Zimi behind it ──
  function miniProvider() {
    var articles = {}, pages = {};
    root.WIKIRACE_MINI.forEach(function (a) { articles[a[0]] = a[1]; });
    var LINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
    function linksOf(title) { var out = [], m; LINK.lastIndex = 0; while ((m = LINK.exec(articles[title] || ''))) if (out.indexOf(m[1]) < 0) out.push(m[1]); return out; }
    function open(path) {
      if (!articles[path]) return Promise.reject(new Error('no such page'));
      if (!pages[path]) {
        var node = el('div', 'rc-article'), p = el('p'), text = articles[path], last = 0, m;
        LINK.lastIndex = 0;
        while ((m = LINK.exec(text))) {
          p.appendChild(document.createTextNode(text.slice(last, m.index)));
          p.appendChild(makeLink(m[1], m[2] || m[1]));
          last = LINK.lastIndex;
        }
        p.appendChild(document.createTextNode(text.slice(last)));
        node.appendChild(p);
        pages[path] = { path: path, title: path, node: node, links: linksOf(path).map(function (t) { return { path: t, title: t }; }) };
      }
      return Promise.resolve(pages[path]);
    }
    function pick(daily) {
      var titles = Object.keys(articles).sort(), rng = Lib.rng(Lib.hash('mini|' + (daily ? today : String(Math.random()))));
      for (var i = 0; i < 400; i++) {
        var a = titles[Math.floor(rng() * titles.length)], b = titles[Math.floor(rng() * titles.length)];
        var d = shortest(linksOf, a, b);
        if (d >= 3 && d <= 5) return Promise.all([open(a), open(b)]).then(function (ab) { return { start: ab[0], end: ab[1], par: d, parKind: 'shortest' }; });
      }
      return Promise.reject(new Error('no pair'));
    }
    return { label: T('race.builtIn'), zim: 'mini', open: open, pick: pick, built: true };
  }

  // ── a race ──
  function clicks() { return race.steps.length - 1; }
  function elapsed() { return race.ms + (race.since ? performance.now() - race.since : 0); }
  // The bar's one stat is the clicks so far.
  function paintHud() { els.clicks.textContent = T('race.clicks', { n: race ? clicks() : 0 }); }
  function parLabel(pair) { return T(pair.parKind === 'route' ? 'race.parRoute' : 'race.parShortest', { n: pair.par }); }
  function resume() { if (race && !race.done && !race.since && race.begun) race.since = performance.now(); }
  function pause() { if (race && race.since) { race.ms += performance.now() - race.since; race.since = 0; saveDaily(); } }
  Play.onHidden(pause);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) resume(); });

  function saveDaily() {
    if (!race || race.mode !== 'daily') return;
    Play.save(DAILY_KEY, { date: today, zim: provider.zim, steps: race.steps, ms: Math.round(race.ms), done: race.done, begun: race.begun });
  }

  function paintTrail() {
    els.trail.innerHTML = '';
    race.steps.forEach(function (s, i) {
      if (i) els.trail.appendChild(el('span', 'rc-sep', '›'));
      els.trail.appendChild(el('span', 'rc-chip' + (i === race.steps.length - 1 ? ' here' : ''), s.title));
    });
    els.trail.scrollLeft = els.trail.scrollWidth;
    els.back.disabled = race.done || race.steps.length < 2;
    els.give.disabled = race.done || !race.begun;
  }
  function paintTarget() {
    els.target.innerHTML = '';
    els.target.appendChild(el('span', 'rc-from', race.pair.start.title));
    els.target.appendChild(el('span', 'rc-arrow', '→'));
    els.target.appendChild(el('b', 'rc-to', race.pair.end.title));
    if (race.hint) els.target.title = race.hint;
  }

  function show(page) {
    var box = el('div'), title = el('h2', 'rc-title', page.title); title.dir = 'auto'; box.appendChild(title); box.appendChild(page.node);
    say(box);
    race.page = page;
    paintTrail(); paintHud();
  }

  function beginRace() {
    race.begun = true; race.since = performance.now();
    line.say(race.hot ? T('race.hot.playing', { n: race.hot.turn + 1 }) : T('race.par', { n: race.pair.par }));
    provider.open(race.steps[race.steps.length - 1].path).then(show, function () { notice(T('race.missing'), null, T('race.another'), function () { newRace('practice'); }); });
  }

  function arrive(page) {
    race.done = true; pause(); saveDaily(); paintTrail(); paintHud();
    var ms = Math.round(race.ms), n = clicks();
    if (race.hot) return hotDone({ n: n, ms: ms, gave: false });
    if (race.mode === 'daily') {
      var best = Play.load(BEST_KEY, {});
      if (!best.clicks || n < best.clicks) { best.clicks = n; Play.save(BEST_KEY, best); }
    }
    openResult(ms, n);
  }
  // The route as articles to read, under the end sheet's chips: each page the player passed through, once, in order (not for the
  // built-in set, which has no pages). Inside Zimi each opens in the reader and Back returns to the finished race.
  function routeNodes() {
    if (!race || provider.built) return [];
    var seen = {}, box = el('p', 'rc-review');
    box.appendChild(el('span', 'rc-review-label', T('race.review')));
    race.steps.forEach(function (s) {
      if (seen[s.path]) return;
      seen[s.path] = true;
      var a = Lib.articleLink(el('a', 'rc-review-link'), provider.zim, s.path); a.textContent = s.title; box.appendChild(a);
    });
    return Object.keys(seen).length > 1 ? [box] : [];
  }
  // The end of a race, on the shared end sheet: the clicks and the time; the route stays in the trail above.
  function openResult(ms, n) {
    els.share.hidden = false; paintTrail();
    line.say(T('race.arrived', { target: race.pair.end.title }));
    ZimiShell.endSheet({ result: 'win', text: parLabel(race.pair), stats: [[T('race.clicksLabel'), Play.num(n)], [T('play.time'), Play.fmtClock(ms)]], extra: routeNodes() });
  }

  function go(path) {
    if (busy || !race || race.done || !race.begun) return;
    busy = true;
    provider.open(path).then(function (page) {
      busy = false;
      race.steps.push({ path: page.path, title: page.title, via: 'link' });
      saveDaily();
      if (Engine.isTarget(page, race.pair.end)) { show(page); arrive(page); } else show(page);
    }, function () {
      busy = false;
      ZimiShell.shake(els.pane); line.reason(T('race.notCounted'));
    });
  }
  function goBack() {
    if (busy || !race || race.done || race.steps.length < 2) return;
    var prev = race.steps[race.steps.length - 2];
    busy = true;
    provider.open(prev.path).then(function (page) { busy = false; race.steps.push({ path: prev.path, title: prev.title, via: 'back' }); saveDaily(); show(page); }, function () { busy = false; });
  }
  function giveUp() {
    if (!race || race.done || !race.begun) return;
    race.done = true; race.gave = true; pause(); saveDaily(); paintTrail();
    if (race.hot) return hotDone({ n: clicks(), ms: Math.round(race.ms), gave: true });
    giveUpSheet();
  }
  function giveUpSheet() {
    els.share.hidden = false;
    line.say(T('race.target', { target: race.pair.end.title }));
    ZimiShell.endSheet({ result: 'lose', text: T('race.gaveUp', { target: race.pair.end.title, par: parLabel(race.pair) }), after: 0, stats: [[T('race.clicksLabel'), Play.num(clicks())]], extra: routeNodes() });
  }

  function intro(pair, mode, doneBefore) {
    var box = el('div', 'rc-card');
    box.appendChild(el('h2', null, mode === 'hotseat' ? T('race.hot.turn', { n: race.hot.turn + 1 }) : T(mode === 'daily' ? 'race.today' : 'race.new')));
    var line = el('p', 'rc-pair'); line.appendChild(el('span', null, pair.start.title)); line.appendChild(el('span', 'rc-arrow', '→')); line.appendChild(el('b', null, pair.end.title));
    box.appendChild(line);
    var hint = el('p', 'rc-hint', race.hint); hint.dir = 'auto'; box.appendChild(hint);
    box.appendChild(el('p', null, T(pair.par ? 'race.follow' : 'race.followOnly', { n: pair.par })));
    var b = el('button', 'ar-btn gm-play', T('shell.start')); b.type = 'button'; b.addEventListener('click', beginRace); box.appendChild(b);
    say(box);
    setTimeout(function () { b.focus(); }, 0);
  }

  // ── two on one phone: the same race for each, the fewer clicks win (a tie goes to the quicker) ──
  function hotKey(r) { return r.gave ? Infinity : r.n; }
  // How the two races compare: 0 or 1 for the winner, -1 for a draw.
  function hotWinner(res) {
    var a = hotKey(res[0]), b = hotKey(res[1]);
    if (a === Infinity && b === Infinity) return -1;
    if (a !== b) return a < b ? 0 : 1;
    return Math.abs(res[0].ms - res[1].ms) < HOT_TIE_MS ? -1 : (res[0].ms < res[1].ms ? 0 : 1);
  }
  function hotPlayer(i) { return T('pass.player', { n: i + 1 }); }
  function hotChip(r) { return r.gave ? T('race.hot.gaveUp') : T('race.hot.clicksTime', { n: r.n, time: Play.fmtClock(r.ms) }); }
  function hotDone(r) {
    race.hot.res.push(r); els.share.hidden = true;
    if (race.hot.turn === 0) return hotHandOff();
    hotFinal();
  }
  function hotHandOff() {
    paintTrail();
    var box = el('div', 'rc-card');
    box.appendChild(el('h2', null, T('pass.to', { name: hotPlayer(1) })));
    box.appendChild(el('p', null, T('race.hot.same', { start: race.pair.start.title, end: race.pair.end.title })));
    var b = el('button', 'ar-btn gm-play', T('pass.ready', { name: hotPlayer(1) })); b.type = 'button'; b.addEventListener('click', hotSecond); box.appendChild(b);
    say(box); line.say(T('race.hot.firstDone', { chip: hotChip(race.hot.res[0]) }));
    setTimeout(function () { b.focus(); }, 0);
  }
  function hotSecond() {
    race.hot.turn = 1; race.steps = [{ path: race.pair.start.path, title: race.pair.start.title, via: 'start' }];
    race.ms = 0; race.since = 0; race.begun = false; race.done = false; race.gave = false; race.page = null;
    paintTrail(); paintHud(); intro(race.pair, 'hotseat', null);
  }
  function hotFinal() {
    paintTrail();
    var w = hotWinner(race.hot.res), chips = race.hot.res.map(function (r, i) { return [hotPlayer(i), hotChip(r)]; });
    line.say('');
    ZimiShell.endSheet(w < 0 ? { result: 'draw', stats: chips } : { result: 'win', name: hotPlayer(w), stats: chips });
  }

  function newRace(mode) {
    pause(); race = null; busy = false; paintHud();
    els.trail.innerHTML = ''; els.back.disabled = els.give.disabled = true; els.target.innerHTML = ''; els.share.hidden = true;
    line.say(T(mode === 'daily' ? 'race.daily' : mode === 'hotseat' ? 'race.hot.mode' : 'race.practice'));
    notice(T('race.finding'));
    var saved = mode === 'daily' ? Play.load(DAILY_KEY, null) : null;
    provider.pick(mode === 'daily').then(function (pair) {
      race = { mode: mode, pair: pair, steps: [{ path: pair.start.path, title: pair.start.title, via: 'start' }], ms: 0, since: 0, begun: false, done: false, page: null, hint: firstSentence(pair.end.node) };
      if (mode === 'hotseat') race.hot = { turn: 0, res: [] };
      paintTarget(); paintHud();
      if (saved && saved.date === today && saved.zim === provider.zim && saved.steps && saved.steps[0].path === pair.start.path) {
        race.steps = saved.steps; race.ms = saved.ms || 0; race.begun = saved.begun; race.done = saved.done;
        if (race.done) {
          paintTrail();
          provider.open(race.steps[race.steps.length - 1].path).then(function (p) { show(p); openResult(race.ms, clicks()); });
          return;
        }
        if (race.begun) { race.since = performance.now(); line.say(T('race.par', { n: pair.par })); return provider.open(race.steps[race.steps.length - 1].path).then(show); }
      }
      intro(pair, mode, null);
    }, function () {
      notice(T('race.noRace'), provider.built ? null : T('race.noLinks'), T('race.retry'), function () { newRace(mode); });
    });
  }

  // ── wiring ──
  els.pane.addEventListener('click', function (e) { var a = e.target.closest('.rc-link'); if (a) go(a.dataset.path); });
  els.pane.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.classList.contains('rc-link')) go(e.target.dataset.path); });
  els.back.addEventListener('click', goBack);
  els.give.addEventListener('click', giveUp);
  els.share.addEventListener('click', function () {
    var t = raceText(T('race.shareTitle'), race.mode === 'daily' ? today : T('race.practice'), race.steps, race.ms);
    try { navigator.clipboard.writeText(t).then(function () { line.reason(T('race.copied')); }, function () { line.reason(t); }); } catch (err) { line.reason(T('race.copyFail')); }
  });
  // New game: the race the New game pane chose, else the next (after a finished daily, a practice race).
  els.newBtn.addEventListener('click', function () {
    var m = pendingMode || (race && race.mode === 'daily' && race.done ? 'practice' : (race ? race.mode : 'daily'));
    pendingMode = null; newRace(m);
  });
  ZimiShell.game({
    about: function () { return Lib.note(T, 'articles', provider && !provider.built ? provider.zim : ''); },
    inProgress: function () { return !!race && race.begun && !race.done; },
    menu: function () {
      return { options: [Play.optionRow(T('race.race'), [['daily', T('play.daily')], ['practice', T('play.practice')], ['hotseat', T('race.hot.mode')]], pendingMode || (race ? race.mode : 'daily'), function (v) { pendingMode = v; })] };
    },
    stats: function () { var best = Play.load(BEST_KEY, {}); return best.clicks ? [[T('race.bestClicks'), Play.num(best.clicks)]] : []; }
  });

  // Leaving and coming back keeps the race: both articles, the path, the clicks and the clock. A finished race comes
  // back to its end sheet; a daily race of an earlier day is not kept.
  function snapshot() {
    if (!race || !provider) return null;
    if (!race.begun && !race.done && !(race.hot && race.hot.res.length)) return null;
    return { mode: race.mode, date: today, zim: provider.zim, start: race.pair.start.path, end: race.pair.end.path, startTitle: race.pair.start.title, endTitle: race.pair.end.title, par: race.pair.par, parKind: race.pair.parKind,
      steps: race.steps, ms: Math.round(elapsed()), begun: race.begun, done: race.done, gave: !!race.gave, hot: race.hot || null };
  }
  // The pages come from the library again; when it is gone or has changed, the race is still shown as it stood (the path
  // and both ends from the save), with a note where the page would be, and New game starts another.
  function restore(kept) {
    if (!kept || !kept.steps || !kept.steps.length || (kept.mode === 'daily' && kept.date !== today)) { if (kept) ZimiShell.forget(); return Promise.resolve(false); }
    function build(ab) {
      race = { mode: kept.mode, pair: { start: ab[0], end: ab[1], par: kept.par, parKind: kept.parKind }, steps: kept.steps, ms: kept.ms || 0, since: 0, begun: kept.begun, done: kept.done, gave: kept.gave, hot: kept.hot || undefined, page: null, hint: firstSentence(ab[1].node) };
      paintTarget(); paintHud();
    }
    function finishUp() {
      if (race.hot) {   // two on one phone: between the two races, or in the second, or over
        if (race.done) { if (race.hot.res.length > 1) hotFinal(); else hotHandOff(); }
        else if (!race.begun) intro(race.pair, 'hotseat', null);
        else { race.since = performance.now(); line.say(T('race.hot.playing', { n: race.hot.turn + 1 })); }
        return true;
      }
      if (race.done && race.gave) giveUpSheet();
      else if (race.done) openResult(race.ms, clicks());
      else { race.since = performance.now(); line.say(T('race.par', { n: race.pair.par })); }
      return true;
    }
    var live = kept.zim === provider.zim ? Promise.all([provider.open(kept.start), provider.open(kept.end)]).then(function (ab) {
      build(ab);
      return provider.open(race.steps[race.steps.length - 1].path).then(function (p) { show(p); return finishUp(); });
    }) : Promise.reject(new Error('another library'));
    return live.catch(function () {
      var stub = function (path, title) { return { path: path, title: title || Lib.titleOfPath(path), node: el('div'), links: [] }; };
      build([stub(kept.start, kept.startTitle), stub(kept.end, kept.endTitle)]);
      paintTrail(); notice(T('race.offline'));
      els.back.disabled = true; els.give.disabled = true; race.stub = true;
      return finishUp();
    });
  }
  ZimiShell.persist({ save: snapshot });

  // Which articles to race on: your Wikipedia in your language inside Zimi, else the built-in ones.
  function boot() {
    notice(T('race.looking'));
    Lib.library().then(function (list) {
      var found = Lib.pickZim(list, 'wikipedia', Lib.uiLang());
      provider = found ? zimiProvider(found.zim) : miniProvider();
      Lib.englishNote(T, 'lang.enPages', !found);
      restore(ZimiShell.saved()).then(function (back) { if (!back) newRace('daily'); });
    });
  }
  root.__race = { get race() { return race; }, get provider() { return provider; } };
  boot();
})(this);
