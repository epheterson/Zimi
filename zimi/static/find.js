// Find in page: the open article's words, found as they are typed.
//
// Loaded the first time someone asks to find (Cmd/Ctrl+F while reading, or
// Find in page in the reader's ⋯ menu), never before: nothing here is on the
// way to a page. app.js owns when it opens and closes; this file owns the
// bar and the finding.
//
// The bar sits in Zimi's own page, over the reader; the article is the
// reader frame's document, whatever is in it: the page as the ZIM wrote it,
// Reader View's shell, Zimipedia's reader. Every match is painted with the
// CSS Custom Highlight API (no element is added to the article, so Reader
// View, highlights and a page's own scripts see the page they made), the
// one being looked at in a stronger tint. A browser without the API selects
// the one being looked at instead.
//
// Matching is by letters: case, accents and Hebrew or Arabic vowel marks do
// not count ("cafe" finds "Café", "שלום" finds "שָׁלוֹם"), and any run of
// spaces or line breaks is one space. Text in a closed <details> is found and
// its section opened when its match is the one looked at, as a browser's own
// find does.

(function () {
  'use strict';

  var MAX_MATCHES = 1000;       // a browser's own find stops counting about here
  var TYPE_DELAY_MS = 120;      // a pause in typing before the page is searched
  var ALL = 'zimi-find', ON = 'zimi-find-on';
  var SKIP = 'script,style,noscript,template,head,title,svg,math';
  var MARK = /\p{M}/u, SPACE = /\s/;

  var bar = null, input = null, count = null;
  var doc = null, matches = [], at = -1, timer = null, lastQuery = '';
  var strings = null;

  // ── the text of a page, folded for matching ───────────────────────────
  var foldCache = new Map();
  function foldChar(ch) {
    var f = foldCache.get(ch);
    if (f !== undefined) return f;
    if (MARK.test(ch)) f = '';
    else if (SPACE.test(ch)) f = ' ';
    else {
      f = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
      if (f.length !== 1) f = ch.toLowerCase().length === 1 ? ch.toLowerCase() : ch;
    }
    foldCache.set(ch, f);
    return f;
  }
  // The needle, folded the same way, spaces at either end dropped.
  function foldQuery(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var f = foldChar(s[i]);
      if (f === ' ' && (!out || out[out.length - 1] === ' ')) continue;
      out += f;
    }
    return out.replace(/ $/, '');
  }

  // Text nodes shown (or inside a closed <details>) and where each starts in
  // the folded text; `map` gives, for each folded character, its node and
  // offset.
  function readPage(d) {
    var body = d.body;
    var nodes = [], offs = [], folded = [];
    if (!body) return { text: '', nodes: nodes, offs: offs };
    var shown = new Map();
    var visible = function (el) {
      if (shown.has(el)) return shown.get(el);
      var ok = !el.closest(SKIP) && (el.getClientRects().length > 0 || !!el.closest('details:not([open])'));
      shown.set(el, ok);
      return ok;
    };
    var w = d.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    var prevSpace = true, n;
    while ((n = w.nextNode())) {
      var s = n.nodeValue;
      if (!s || !n.parentElement || !visible(n.parentElement)) continue;
      for (var i = 0; i < s.length; i++) {
        var f = foldChar(s[i]);
        if (!f) continue;
        if (f === ' ') { if (prevSpace) continue; prevSpace = true; } else prevSpace = false;
        folded.push(f);
        nodes.push(n);
        offs.push(i);
      }
    }
    return { text: folded.join(''), nodes: nodes, offs: offs };
  }

  function find(d, query) {
    var needle = foldQuery(query);
    if (!needle || !d) return [];
    var page = readPage(d), out = [];
    var from = 0, i;
    while (out.length < MAX_MATCHES && (i = page.text.indexOf(needle, from)) >= 0) {
      var r = d.createRange();
      var last = i + needle.length - 1;
      r.setStart(page.nodes[i], page.offs[i]);
      r.setEnd(page.nodes[last], page.offs[last] + 1);
      out.push(r);
      from = i + needle.length;
    }
    return out;
  }

  // ── painting ──────────────────────────────────────────────────────────
  function win() { try { return doc && doc.defaultView; } catch (e) { return null; } }
  function canPaint(w) { return !!(w && w.CSS && w.CSS.highlights && typeof w.Highlight === 'function'); }
  function ensureStyle(d) {
    if (d.getElementById('zimi-find-style')) return;
    var st = d.createElement('style');
    st.id = 'zimi-find-style';
    st.textContent = '::highlight(' + ALL + '){background-color:rgba(245,158,11,.38);color:inherit}' +
      '::highlight(' + ON + '){background-color:#f59e0b;color:#111}';
    (d.head || d.documentElement).appendChild(st);
  }
  function paint() {
    var w = win();
    if (!w) return;
    if (canPaint(w)) {
      ensureStyle(doc);
      var all = new w.Highlight(), on = new w.Highlight();
      matches.forEach(function (r, k) { (k === at ? on : all).add(r); });
      w.CSS.highlights.set(ALL, all);
      w.CSS.highlights.set(ON, on);
    } else if (at >= 0) {
      try { var sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(matches[at]); } catch (e) {}
    }
  }
  function unpaint() {
    var w = win();
    if (!w) return;
    if (canPaint(w)) { w.CSS.highlights.delete(ALL); w.CSS.highlights.delete(ON); }
  }

  // The one looked at, in view: its closed sections opened, then scrolled
  // to the middle of whatever scrolls it (the page, or Reader View's column).
  function reveal(r) {
    var el = r.startContainer.parentElement;
    if (!el) return;
    for (var d = el.closest('details:not([open])'); d; d = d.parentElement && d.parentElement.closest('details:not([open])')) d.open = true;
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { el.scrollIntoView(); }
  }

  function say() {
    if (!count) return;
    var q = input.value.trim();
    count.textContent = !q ? '' : matches.length
      ? strings.count(at + 1, matches.length)
      : strings.none;
    bar.classList.toggle('find-none', !!q && !matches.length);
    bar.querySelectorAll('.find-step').forEach(function (b) { b.disabled = !matches.length; });
  }

  function run() {
    clearTimeout(timer);
    var q = input.value;
    lastQuery = q;
    unpaint();
    matches = find(doc, q);
    // The first match at or after where the reader is looking, not the page's
    // first word: a find started halfway down stays there.
    at = matches.length ? firstInView() : -1;
    paint();
    if (at >= 0) reveal(matches[at]);
    say();
  }
  function firstInView() {
    for (var k = 0; k < matches.length; k++) {
      var rect = matches[k].getBoundingClientRect();
      if (rect.bottom >= 0 && (rect.width || rect.height)) return k;
    }
    return 0;
  }

  function step(dir) {
    if (input.value !== lastQuery) run();
    if (!matches.length) return;
    at = (at + dir + matches.length) % matches.length;
    paint();
    reveal(matches[at]);
    say();
  }

  // ── the bar ───────────────────────────────────────────────────────────
  var ICON = {
    up: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
    down: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    x: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };
  function button(cls, label, icon, onclick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.innerHTML = icon;
    // Pressed without taking the focus from the box, so typing goes on.
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', onclick);
    return b;
  }
  function build(host) {
    bar = document.createElement('div');
    bar.id = 'find-bar';
    bar.className = 'find-bar';
    bar.setAttribute('role', 'search');
    input = document.createElement('input');
    input.type = 'search';
    input.className = 'find-input';
    input.dir = 'auto';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('enterkeyhint', 'search');
    count = document.createElement('span');
    count.className = 'find-count';
    count.setAttribute('aria-live', 'polite');
    bar.appendChild(input);
    bar.appendChild(count);
    bar.appendChild(button('find-step find-prev', '', ICON.up, function () { step(-1); }));
    bar.appendChild(button('find-step find-next', '', ICON.down, function () { step(1); }));
    bar.appendChild(button('find-close', '', ICON.x, function () { close(); }));
    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(run, TYPE_DELAY_MS);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if ((e.metaKey || e.ctrlKey) && (e.key === 'g' || e.key === 'G')) { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      else if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); input.select(); }
    });
    host.appendChild(bar);
  }
  function label() {
    input.placeholder = strings.find;
    input.setAttribute('aria-label', strings.find);
    var set = function (sel, text) { var b = bar.querySelector(sel); b.setAttribute('aria-label', text); b.title = text; };
    set('.find-prev', strings.prev);
    set('.find-next', strings.next);
    set('.find-close', strings.close);
  }

  // opts: host (the element the bar goes in), doc (the article), strings
  // {find, none, prev, next, close, count(n, total)}, onClose().
  var onClose = null;
  function open(opts) {
    strings = opts.strings;
    onClose = opts.onClose || null;
    if (!bar) build(opts.host);
    else if (bar.parentNode !== opts.host) opts.host.appendChild(bar);
    label();
    if (doc !== opts.doc) { unpaint(); doc = opts.doc; matches = []; at = -1; lastQuery = ''; }
    bar.classList.add('open');
    // The words last looked for, chosen, so typing replaces them and Enter
    // finds them again.
    input.focus();
    input.select();
    if (input.value && input.value !== lastQuery) run();
    else { paint(); say(); }
  }
  function close() {
    clearTimeout(timer);
    unpaint();
    matches = []; at = -1; lastQuery = '';
    var was = bar && bar.classList.contains('open');
    if (bar) bar.classList.remove('open');
    doc = null;
    if (was && onClose) onClose();
  }
  function isOpen() { return !!(bar && bar.classList.contains('open')); }

  window.ZimiFind = { open: open, close: close, isOpen: isOpen, step: step, _find: find, _foldQuery: foldQuery };
})();
