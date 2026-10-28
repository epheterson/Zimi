/* ZimiGames: what the games that draw on the player's own library share. Our own code, GPL-3.0.
   Three places a game can find itself, told apart by mode():
     'zimi'    inside Zimi: same-origin with its API (/list, /random, /w/, /dictionary/ ...).
     'kiwix'   inside kiwix-serve (Kiwix's apps read through their own protocols, so they are 'builtin'): same-origin with every ZIM it serves,
               with /catalog/v2/entries, /random?content= and /content/<book>/<path>.
     'builtin' anywhere else (a folder, a viewer with no server): each game plays from the small set it ships.
   library(), random(), article(), hasPage(), pageHead() and articleUrl() answer in the first two the same way, so a game is written
   once; builtin gives an empty library and the game falls back, never a dead page. Both probes fail fast, and nothing
   here runs until a game calls it. The pure parts (seeded chance, folding, choosing a ZIM, resolving a link, reading
   kiwix-serve's catalog and a page's lead, a table) work in node for the tests. */
(function (root) {
  'use strict';
  var Lib = {};
  var PROBE_MS = 1500, JSON_MS = 10000;

  // ── pure helpers ─────────────────────────────────────────────────────────
  // FNV-1a over the string's UTF-16 units: the same seed from the same text, everywhere.
  Lib.hash = function (s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  };
  // mulberry32: a small seeded generator, so a daily race or word is one thing for everyone on a server.
  Lib.rng = function (seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  Lib.shuffle = function (arr, rng) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor((rng || Math.random)() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  };
  Lib.sample = function (arr, n, rng) { return Lib.shuffle(arr, rng).slice(0, n); };

  // Letters without their accents or case: "École" and "ecole" are one word to a keyboard.
  Lib.fold = function (s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); };
  Lib.primaryLang = function (tag) { return String(tag || '').toLowerCase().split(/[-_]/)[0]; };

  // The server's day key: YYYYMMDD on the player's calendar (the server accepts yesterday to tomorrow).
  Lib.dayKey = root.ZimiUtil.dayKey;

  // Which of the library's ZIMs to play from: the project's ZIMs (kind "wiki"), the player's language first,
  // then English, then the biggest. {zim, exact} or null when the library has none of that project.
  Lib.pickZim = function (list, project, lang) {
    var mine = (list || []).filter(function (z) { return z.kind === 'wiki' && z.project === project; });
    if (!mine.length) return null;
    var size = function (z) { return z.article_count || z.entries || 0; };
    var best = function (zs) { return zs.slice().sort(function (a, b) { return size(b) - size(a); })[0]; };
    var want = Lib.primaryLang(lang);
    var exact = mine.filter(function (z) { return Lib.primaryLang(z.language) === want; });
    if (exact.length) return { zim: best(exact), exact: true };
    var en = mine.filter(function (z) { return Lib.primaryLang(z.language) === 'en'; });
    return { zim: best(en.length ? en : mine), exact: false };
  };

  // An article link, as a path inside the same ZIM, or null when it leads anywhere else (another site,
  // another ZIM, a namespace page such as File: or Category:, the page itself, a bare anchor).
  var BASE = 'http://zimi.invalid';
  Lib.resolvePath = function (zim, fromPath, href, rootPath) {
    if (!href || href.charAt(0) === '#') return null;
    var root = rootPath || '/w/', u;
    try { u = new URL(href, BASE + root + encodeURIComponent(zim) + '/' + fromPath.split('/').map(encodeURIComponent).join('/')); } catch (e) { return null; }
    if (u.origin !== BASE) return null;
    var prefix = root + encodeURIComponent(zim) + '/';
    if (u.pathname.indexOf(prefix) !== 0) return null;
    var path;
    try { path = decodeURIComponent(u.pathname.slice(prefix.length)); } catch (e) { return null; }
    if (!path || path.indexOf(':') >= 0 || path === fromPath) return null;
    return path;
  };

  Lib.titleOfPath = function (path) { return path.replace(/_/g, ' '); };

  // ── asking Zimi ──────────────────────────────────────────────────────────
  Lib.json = function (url, ms) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, ms || JSON_MS) : null;
    return fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }, function (e) { if (timer) clearTimeout(timer); throw e; });
  };
  Lib.text = function (url, ms) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, ms || JSON_MS) : null;
    return fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }, function (e) { if (timer) clearTimeout(timer); throw e; });
  };

  // The first `bytes` of a file, as text: a Range request, and if the server sends it all, reading stops at the limit.
  // For a listing sorted by popularity or a long book, where the start is all a game wants.
  Lib.head = function (url, bytes, ms) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, ms || JSON_MS) : null;
    var opts = { headers: { Range: 'bytes=0-' + (bytes - 1) } };
    if (ctl) opts.signal = ctl.signal;
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (!r.body || !r.body.getReader || typeof TextDecoder === 'undefined') return r.text().then(function (t) { return t.slice(0, bytes); });
      var rd = r.body.getReader(), dec = new TextDecoder(), out = '';
      return (function pump() {
        return rd.read().then(function (x) {
          if (x.done) return out;
          out += dec.decode(x.value, { stream: true });
          if (out.length >= bytes) { rd.cancel(); return out.slice(0, bytes); }
          return pump();
        });
      })();
    }).then(function (t) { if (timer) clearTimeout(timer); return t; }, function (e) { if (timer) clearTimeout(timer); throw e; });
  };

  // Is this page being served by Zimi? One request to /health, which only Zimi answers with {status: "ok"}.
  // From a folder (file:) there is nothing to ask. Asked once per page.
  var zimiAnswer = null;
  Lib.isZimi = function () {
    if (!zimiAnswer) {
      zimiAnswer = typeof location === 'undefined' || !/^https?:$/.test(location.protocol)
        ? Promise.resolve(false)
        : Lib.json('/health', PROBE_MS).then(function (j) { return !!(j && j.status === 'ok'); }, function () { return false; });
    }
    return zimiAnswer;
  };

  // The library, once: the cached ZIM list Zimi already keeps.
  var listAnswer = null;
  Lib.zims = function () {
    if (!listAnswer) listAnswer = Lib.json('/list').then(function (l) { return Array.isArray(l) ? l : []; }, function () { return []; });
    return listAnswer;
  };

  // ── kiwix-serve ──────────────────────────────────────────────────────────
  // Where kiwix-serve is mounted: a server run with --urlRootLocation serves everything below a prefix, and the page
  // is at <prefix>/content/<book>/<path>.
  Lib.kiwixPrefix = function (pathname) {
    var i = String(pathname || '').indexOf('/content/');
    return i > 0 ? pathname.slice(0, i) : '';
  };
  var ISO3 = { eng: 'en', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', spa: 'es', ita: 'it', por: 'pt', rus: 'ru', jpn: 'ja', zho: 'zh', chi: 'zh',
    ara: 'ar', hin: 'hi', nld: 'nl', dut: 'nl', pol: 'pl', tur: 'tr', swe: 'sv', ukr: 'uk', ces: 'cs', cze: 'cs', kor: 'ko', heb: 'he', ind: 'id', vie: 'vi', fas: 'fa', per: 'fa' };
  var PROJECTS = /^(wikipedia|wiktionary|wikivoyage|wikiquote|wikibooks|wikisource|wikinews|wikiversity|wikispecies|gutenberg)(?:_|$)/;
  // The attribute-free text of the first <tag>...</tag> in an entry, entities undone.
  function xmlText(entry, tag) {
    var m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>').exec(entry);
    return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim() : '';
  }
  // kiwix-serve's catalog (OPDS, /catalog/v2/entries) as the list Zimi's /list gives: the fields the games read.
  Lib.parseCatalog = function (xml) {
    var out = [], re = /<entry>([\s\S]*?)<\/entry>/g, m;
    while ((m = re.exec(String(xml || '')))) {
      var e = m[1], name = xmlText(e, 'name');
      if (!name) continue;
      var tok = (PROJECTS.exec(name) || [])[1] || '', lang = xmlText(e, 'language').split(',')[0].trim();
      var code = (/^[a-z]+_([a-z]{2,3})(?:_|$)/.exec(name) || [])[1];
      var wiki = tok && tok !== 'gutenberg';
      out.push({ name: name, title: xmlText(e, 'title') || name, language: ISO3[lang] || (lang.length === 2 ? lang : code) || lang,
        kind: wiki ? 'wiki' : 'zim', project: tok, article_count: +xmlText(e, 'articleCount') || 0, main_path: '' });
    }
    return out;
  };

  // Which of the two servers, if either, this page is served by: Zimi answers /health; kiwix-serve answers its catalog.
  var modeAnswer = null, modeNow = 'builtin', pathRoot = '/w/';
  Lib.mode = function () {
    if (!modeAnswer) {
      modeAnswer = Lib.isZimi().then(function (yes) {
        if (yes) { modeNow = 'zimi'; pathRoot = '/w/'; return modeNow; }
        if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) return 'builtin';
        var prefix = Lib.kiwixPrefix(location.pathname);
        return Lib.text(prefix + '/catalog/v2/entries?count=1', PROBE_MS).then(function (x) {
          if (!/<feed[\s>]/.test(x)) return 'builtin';
          modeNow = 'kiwix'; pathRoot = prefix + '/content/'; kiwixPrefix = prefix;
          return modeNow;
        }, function () { return 'builtin'; });
      });
    }
    return modeAnswer;
  };
  var kiwixPrefix = '';
  // The mode, once mode() has answered (builtin until then).
  Lib.modeNow = function () { return modeNow; };

  // The player's library in whichever server there is: [] when there is none.
  var libAnswer = null, titles = {};
  Lib.library = function () {
    if (!libAnswer) libAnswer = Lib.mode().then(function (m) {
      if (m === 'zimi') return Lib.zims();
      if (m !== 'kiwix') return [];
      return Lib.text(kiwixPrefix + '/catalog/v2/entries?count=500').then(Lib.parseCatalog, function () { return []; });
    }).then(function (list) { list.forEach(function (z) { titles[z.name] = z.title || z.name; }); return list; });
    return libAnswer;
  };

  // A book whose name starts with `prefix` (Project Gutenberg's ZIMs are not wikis): the player's language, else the biggest.
  Lib.pickByName = function (list, prefix, lang) {
    var mine = (list || []).filter(function (z) { return z.name && z.name.indexOf(prefix) === 0; });
    if (!mine.length) return null;
    var size = function (z) { return z.article_count || z.entries || 0; };
    var want = Lib.primaryLang(lang), exact = mine.filter(function (z) { return Lib.primaryLang(ISO3[z.language] || z.language) === want; });
    return (exact.length ? exact : mine).slice().sort(function (a, b) { return size(b) - size(a); })[0];
  };

  // A page's address for a reader: the same path in either server, escaped one segment at a time.
  Lib.articleUrl = function (zim, path) {
    return pathRoot + encodeURIComponent(zim) + '/' + String(path || '').split('/').map(encodeURIComponent).join('/');
  };
  Lib.pathRoot = function () { return pathRoot; };
  Lib.article = function (zim, path, ms) { return Lib.text(Lib.articleUrl(zim, path), ms); };
  // Does the ZIM hold a page at this path? A GET of its first bytes, not a HEAD: Zimi answers a HEAD for a missing page with 200.
  Lib.hasPage = function (zim, path) {
    return Lib.head(Lib.articleUrl(zim, path), 64).then(function () { return true; }, function () { return false; });
  };


  // The start of the first of these pages the ZIM has, as {path, html} (null when it has none). Each title is tried as
  // mwoffliner writes a path now ("Title") and as it did ("A/Title"). Titles use underscores, as a path does.
  Lib.pageHead = function (zim, titles, bytes, ms) {
    var paths = [];
    titles.forEach(function (t) { paths.push(t, 'A/' + t); });
    return (function next(i) {
      if (i >= paths.length) return Promise.resolve(null);
      return Lib.head(Lib.articleUrl(zim, paths[i]), bytes, ms).then(function (html) { return { path: paths[i], html: html }; }, function () { return next(i + 1); });
    })(0);
  };

  // A page's lead: its title, its first real paragraph's first sentences, and its first picture (an address).
  var STRIP = /<(script|style|table|sup|figure)[\s\S]*?<\/\1>/gi;
  function plain(html) {
    return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim();
  }
  Lib.leadOf = function (html, baseUrl) {
    var src = String(html || ''), t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(src), h = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(src);
    var title = plain(h ? h[1] : t ? t[1] : '');
    var body = src.replace(STRIP, ''), blurb = '', re = /<p[^>]*>([\s\S]*?)<\/p>/gi, m;
    while ((m = re.exec(body))) {
      var p = plain(m[1]);
      if (p.length >= 40 && !/^coordinates/i.test(p)) { blurb = p; break; }
    }
    if (blurb.length > 320) blurb = blurb.slice(0, 320).replace(/\s\S*$/, '') + '...';
    var img = /<img[^>]+src="([^"]+)"/i.exec(src), thumb = '';
    if (img && !/\.svg(?:\.png)?$/i.test(img[1].split('?')[0]) && baseUrl) { try { thumb = new URL(img[1], baseUrl).pathname; } catch (e) { thumb = ''; } }
    return { title: title, blurb: blurb, thumbnail: thumb };
  };

  // A random article of a ZIM, the same shape from either server: {title, blurb, thumbnail, path, zim, part_of_speech}.
  // Options: thumb (a picture is wanted), requireThumb, day (a pick seeded by the day, Zimi only: kiwix-serve cannot seed).
  Lib.random = function (zim, o) {
    o = o || {};
    if (modeNow !== 'kiwix') {
      var url = '/random?zim=' + encodeURIComponent(zim) + (o.thumb ? '&thumb=1' : '') + (o.requireThumb ? '&require_thumb=1' : '') + (o.day ? '&day=' + o.day + '&seed=' + o.day : '');
      return Lib.json(url).then(function (r) { return r && r.path ? Object.assign({ zim: zim }, r) : Promise.reject(new Error('no article')); });
    }
    var ctl = typeof AbortController === 'function' ? new AbortController() : null, timer = ctl ? setTimeout(function () { ctl.abort(); }, JSON_MS) : null;
    return fetch(kiwixPrefix + '/random?content=' + encodeURIComponent(zim), ctl ? { signal: ctl.signal } : {}).then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var from = new URL(r.url).pathname, root = pathRoot + encodeURIComponent(zim) + '/';
      var path = from.indexOf(root) === 0 ? decodeURIComponent(from.slice(root.length)) : '';
      return r.text().then(function (html) {
        var lead = Lib.leadOf(html, r.url);
        if (!path || !lead.title) throw new Error('no article');
        if (o.requireThumb && !lead.thumbnail) throw new Error('no picture');
        return { title: lead.title, blurb: lead.blurb, thumbnail: lead.thumbnail, path: path, zim: zim };
      });
    }, function (e) { if (timer) clearTimeout(timer); throw e; });
  };

  // Pages whose title matches what the player typed, [{title, path}]: Zimi's search, or kiwix-serve's title suggestions.
  Lib.search = function (zim, term, n) {
    n = n || 8;
    if (modeNow === 'kiwix') {
      return Lib.json(kiwixPrefix + '/suggest?content=' + encodeURIComponent(zim) + '&term=' + encodeURIComponent(term) + '&count=' + n).then(function (rows) {
        return (Array.isArray(rows) ? rows : []).map(function (r) { return { title: String(r.value || r.label || '').replace(/<[^>]*>/g, ''), path: r.path || '' }; }).filter(function (r) { return r.title && r.path; });
      }, function () { return []; });
    }
    return Lib.json('/search?q=' + encodeURIComponent(term) + '&zim=' + encodeURIComponent(zim) + '&limit=' + n).then(function (r) {
      return ((r && r.results) || []).map(function (x) { return { title: x.title, path: x.path }; });
    }, function () { return []; });
  };

  // The first definition on a Wiktionary page: the first numbered line, without the examples nested under it. '' if none.
  Lib.firstDefinition = function (html) {
    var m = /<ol[^>]*>\s*<li[^>]*>([\s\S]*?)(?:<ul|<ol|<dl|<\/li>)/i.exec(String(html || ''));
    return m ? plain(m[1]) : '';
  };

  // ── tables ───────────────────────────────────────────────────────────────
  // The rows of a page's tables as arrays of cells {text, img (the first picture's src), href and link (the first link's address and text), head (a <th>)},
  // whole rows only (a page cut off by Lib.head loses its last), with no DOM, so node can test it. A tag's attributes may
  // hold a ">" inside quotes (Parsoid's data-mw), so tags are matched quote by quote.
  var ATTRS = '((?:[^>"\']|"[^"]*"|\'[^\']*\')*)';
  var ROW_RE = new RegExp('<tr' + ATTRS + '>([\\s\\S]*?)</tr>', 'gi'), CELL_RE = new RegExp('<t([dh])' + ATTRS + '>([\\s\\S]*?)</t\\1>', 'gi');
  Lib.rows = function (html) {
    var out = [], r;
    ROW_RE.lastIndex = 0;
    while ((r = ROW_RE.exec(String(html || '')))) {
      var cells = [], c;
      CELL_RE.lastIndex = 0;
      while ((c = CELL_RE.exec(r[2]))) {
        var inner = c[3].replace(/<(sup|style)[\s\S]*?<\/\1>/gi, '').replace(/<span[^>]*display:\s*none[^>]*>[\s\S]*?<\/span>/gi, '');
        var img = /<img[^>]+src="([^"]+)"/i.exec(inner), a = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(inner);
        cells.push({ text: plain(inner), img: img ? img[1] : '', href: a ? a[1] : '', link: a ? plain(a[2]) : '', head: c[1].toLowerCase() === 'h' });
      }
      if (cells.length) out.push(cells);
    }
    return out;
  };
  // A number as a table writes it: "1,412,600,000", "9.6 million", "8,848.86 m (29,031.7 ft)", "1.4 × 10^6"; NaN when none.
  Lib.number = function (text) {
    var s = String(text || '').replace(/\[[^\]]*\]/g, '').replace(/\u2212/g, '-'), m = /-?\d[\d,\u202f\u00a0 ]*(?:\.\d+)?/.exec(s);
    if (!m) return NaN;
    var n = parseFloat(m[0].replace(/[,\u202f\u00a0 ]/g, ''));
    var rest = s.slice(m.index + m[0].length).trim().toLowerCase();
    if (/^(billion|bn)/.test(rest)) n *= 1e9; else if (/^million/.test(rest)) n *= 1e6; else if (/^thousand/.test(rest)) n *= 1e3;
    return n;
  };

  // ── leading out of a game ───────────────────────────────────────────────
  // Inside Zimi the game is the reader's frame (same origin), so it can ask Zimi to open something the way Zimi opens it:
  // {zimi: 'open', zim, path} is Zimi's own article open (a path may end in a #fragment: a map's #map=zoom/lat/lon), and
  // {zimi: 'game-app', app: 'dictionary', w} opens a word in the Dictionary (the one hook in app.js for this). Everywhere
  // else a link is a plain link, or is not drawn. A leading-out link is never part of play: it sits on a round's or an end sheet.
  Lib.hosted = function () { return !!(root.ZimiShell && root.ZimiShell.hosted); };
  Lib.tell = function (msg) {
    if (!Lib.hosted()) return false;
    try { root.parent.postMessage(msg, root.location.origin); return true; } catch (e) { return false; }
  };
  // An anchor that goes to `href` as a link and, inside Zimi, says `msg` to Zimi instead (a modified click keeps the link).
  Lib.leadOut = function (a, msg, href) {
    a.href = href;
    a.onclick = function (e) {
      if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (Lib.tell(msg)) e.preventDefault();
    };
    return a;
  };
  // A page of a ZIM, read in Zimi's reader (Back returns to the game) or by the plain address. The link follows the library: a game
  // reads the library once at load, so a ZIM deleted while the page is open would leave a link to nothing. Every article link is
  // remembered, checked against a fresh list when it is made (if the last look is old), and again whenever the server says the
  // library changed or the page is shown again. A link whose ZIM is gone is hidden; if the ZIM returns it is shown again.
  Lib.articleLink = function (a, zim, path) {
    Lib.leadOut(a, { zimi: 'open', zim: zim, path: path }, Lib.articleUrl(zim, path));
    a.dataset.lzim = zim;
    if (a.dataset.gone) { a.hidden = false; delete a.dataset.gone; }
    if (linked.indexOf(a) < 0) linked.push(a);
    try {   // no fetch to ask with (a page with nothing around it): the link stays as it is
      Lib.mode().then(function (m) {
        if (m === 'builtin') return;
        hearLibrary();
        if (Date.now() - checkedAt > FRESH_MS) Lib.recheck();
      });
    } catch (e) { /* nothing to check against */ }
    return a;
  };
  var linked = [], checkedAt = Date.now(), stream = null, FRESH_MS = 3000;
  function showLinks(list) {
    linked = linked.filter(function (a) { return a.isConnected !== false && a.dataset.lzim; });
    linked.forEach(function (a) {
      var has = list.some(function (z) { return z.name === a.dataset.lzim; });
      if (!has) { a.hidden = true; a.dataset.gone = '1'; }
      else if (a.dataset.gone) { a.hidden = false; delete a.dataset.gone; }
    });
  }
  // The library as it is now, asked again (nothing cached), the links updated to it. A failed ask changes nothing.
  Lib.recheck = function () {
    return Lib.mode().then(function (m) {
      if (m === 'zimi') return Lib.json('/list').then(function (l) { return Array.isArray(l) ? l : null; });
      if (m !== 'kiwix') return null;
      return Lib.text(kiwixPrefix + '/catalog/v2/entries?count=500').then(function (x) { return /<feed[\s>]/.test(x) ? Lib.parseCatalog(x) : null; });
    }).then(function (list) {
      if (!list) return null;
      checkedAt = Date.now(); libAnswer = Promise.resolve(list);
      if (modeNow === 'zimi') listAnswer = libAnswer;
      list.forEach(function (z) { titles[z.name] = z.title || z.name; });
      showLinks(list);
      return list;
    }, function () { return null; });
  };
  // Inside Zimi: its own change stream (GET /events), whose "library" topic says a ZIM was added, removed or replaced, and the
  // page being shown again (a ZIM may have gone while it was behind another view). One stream a page, opened when the first link is made.
  var pageWired = false;
  function hearLibrary() {
    if (stream || modeNow !== 'zimi' || typeof EventSource !== 'function') return;
    try { stream = new EventSource('/events'); } catch (x) { return; }
    stream.addEventListener('change', function (e) {
      var c = null;
      try { c = JSON.parse(e.data); } catch (x) { /* a malformed announcement says nothing */ }
      if (c && c.topic === 'library') Lib.recheck();
    });
    if (pageWired) return;   // the page's two listeners are added once; a stream opened again after a pagehide adds none
    pageWired = true;
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', function () { if (!document.hidden) Lib.recheck(); });
    if (root.addEventListener) root.addEventListener('pagehide', function () { if (stream) { stream.close(); stream = null; } });
  }
  // A word in the Dictionary app: only inside Zimi, and only when the app is on (one probe a page, asked when first wanted).
  var dictAnswer = null;
  Lib.dictionaryOn = function () {
    if (!dictAnswer) dictAnswer = Lib.hosted() ? Lib.json('/dictionary/suggest?q=a', PROBE_MS).then(function () { return true; }, function () { return false; }) : Promise.resolve(false);
    return dictAnswer;
  };
  Lib.wordLink = function (a, word) {
    delete a.dataset.lzim;   // the Dictionary does not depend on a ZIM of the library
    if (a.dataset.gone) { a.hidden = false; delete a.dataset.gone; }
    return Lib.leadOut(a, { zimi: 'game-app', app: 'dictionary', w: word }, '/?dictionary=' + encodeURIComponent(word));
  };
  // The one learn-more link for a word of a Wiktionary: the Dictionary inside Zimi when the app is there, else the word's own page.
  // `a` is shown at once with the page and turns into the Dictionary's when the probe answers, if it is still this word's link.
  Lib.wordLearn = function (a, T, o) {
    a.dataset.word = o.word; a.hidden = false;
    a.textContent = T(o.readKey, { word: o.word }); Lib.articleLink(a, o.zim, o.path);
    Lib.dictionaryOn().then(function (on) {
      if (!on || a.dataset.word !== o.word) return;
      Lib.wordLink(a, o.word); a.textContent = T('learn.dictionary', { word: o.word });
    });
    return a;
  };
  // The StreetZim map that holds a point: `prefer` (a map the point came from) or the first of the library's searchable maps
  // whose box has it. {zim, path} for Lib.articleLink, the path ending where the map should look; null when no map has it.
  var MAP_LINK_ZOOM = 14, MAP_PAGE = 'index.html';   // a StreetZim map's page, which reads #map=zoom/lat/lon
  Lib.mapFor = function (list, lat, lon, prefer) {
    var maps = (list || []).filter(function (z) { return z.kind === 'map' && z.map_search; });
    var z = prefer ? maps.filter(function (m) { return m.name === prefer; })[0] : maps.filter(function (m) {
      var b = m.map_bounds;
      return b && b.length === 4 && lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
    })[0];
    return z ? { zim: z.name, path: MAP_PAGE + '#map=' + MAP_LINK_ZOOM + '/' + lat + '/' + lon } : null;
  };

  // What a library game says about where it is playing from, for Menu > About: one plain sentence.
  // `what` is the id of the game's word for its content (lib.what.questions, lib.what.flags ...).
  // `zim` is the name of the ZIM the game is playing from, or '' when it plays its own set.
  Lib.note = function (T, what, zim) {
    if (!zim || modeNow === 'builtin') return T('lib.note.builtin', { what: T('lib.what.' + what) });
    return T(modeNow === 'kiwix' ? 'lib.note.kiwix' : 'lib.note.zimi', { source: titles[zim] || zim });
  };

  // How a round or a game went, as the id of the sentence the page says (round.verdict.<id>).
  Lib.verdict = function (score, total) {
    var r = total ? score / total : 0;
    return r === 1 ? 'flawless' : r >= 0.75 ? 'veryGood' : r >= 0.5 ? 'good' : 'keepGoing';
  };

  // The player's language: ?lang= (the page's own request), what the page's strings are in (ZimiText), Zimi's own setting (same origin, so readable),
  // then the browser's.
  Lib.uiLang = function () {
    var q = '';
    try { q = new URLSearchParams(location.search).get('lang') || ''; } catch (e) { /* no location in node */ }
    if (q) return Lib.primaryLang(q);   // the page's own ?lang= is a request; the strings' language only fills in when there is none
    if (root.ZimiText && root.ZimiText.lang) return Lib.primaryLang(root.ZimiText.lang);   // what the page's strings are in
    try {
      var v = localStorage.getItem('zimi_ui_lang');
      if (v) { try { v = JSON.parse(v); } catch (e) { /* a bare code */ } if (typeof v === 'string' && v) return Lib.primaryLang(v); }
    } catch (e) { /* blocked storage */ }
    return Lib.primaryLang(typeof navigator !== 'undefined' ? navigator.language : 'en') || 'en';
  };

  // A name in the page's language through Intl, or the given fallback: type is 'region' (a country code) or 'language'.
  Lib.displayName = function (type, code, fallback) {
    try {
      var n = new Intl.DisplayNames([Lib.uiLang()], { type: type }).of(code);
      return n && n !== code ? n : fallback;
    } catch (e) { return fallback; }
  };

  // A country's name in the page's language: its English name (a Wikipedia list's, or a game's own) found among Intl's, then
  // shown by Intl in the page's language. A name Intl does not know stays as it was written.
  var regionIndex = null;
  Lib.countryName = function (name) {
    if (Lib.uiLang() === 'en') return name;
    if (!regionIndex) {
      regionIndex = {};
      try {
        var en = new Intl.DisplayNames(['en'], { type: 'region' }), A = 65;
        for (var i = 0; i < 26; i++) for (var j = 0; j < 26; j++) {
          var code = String.fromCharCode(A + i, A + j), n = en.of(code);
          if (n && n !== code) regionIndex[Lib.fold(n).replace(/[^a-z]/g, '')] = code;
        }
      } catch (e) { /* no Intl.DisplayNames: names stay as written */ }
    }
    var code = regionIndex[Lib.fold(name).replace(/^the /, '').replace(/[^a-z]/g, '')];
    return code ? Lib.displayName('region', code, name) : name;
  };

  // A small lift on a number that just went up (the CSS stands still for reduced motion).
  Lib.bump = function (el, cls) { cls = cls || 'gl-bump'; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };
  // A name or phrase of one script inside a sentence of another keeps its own order and punctuation: isolated, as Unicode says.
  Lib.iso = function (s) { return '\u2068' + s + '\u2069'; };
  // One quiet line at the foot of a page saying its content is English, in the player's language; nothing in an English
  // page or when `show` is false (a library's own pages are in the library's language). key is a lang.en* string id.
  Lib.englishNote = function (T, key, show) {
    var el = document.getElementById('gl-lang'), main = document.querySelector('main');
    if (!show || Lib.uiLang() === 'en' || !main) { if (el) el.hidden = true; return; }
    if (!el) { el = document.createElement('p'); el.id = 'gl-lang'; el.className = 'gl-note'; main.appendChild(el); }
    el.textContent = T(key); el.hidden = false;
  };

  // The line under a game that says what its content came from.
  Lib.sourceLine = function (el, text) { if (el) el.textContent = text; };

  root.GamesLib = Lib;
})(this);
