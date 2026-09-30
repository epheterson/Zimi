// Highlights (1.12): one engine for every reader. An article, Reader View, a
// book in pages or scrolling, an EPUB's chapters and Zimipedia's article all
// use it through the shell's Highlights (app.js), which loads this file only
// when a page has highlights, when text is selected in it, or when one is to
// be shown: an article with none opens without it. docs/features/saving.md
// has the API.
//
// A highlight is found again by what it says, not by where it was: the
// passage, a little of the text on either side (the W3C Web Annotation
// model's text quote selector) and where it started as a share of the page's
// text. Text is compared without whitespace and in lower case, the context
// decides between repeats of the same words, and the share between repeats
// with the same context. So a highlight comes back after the text is laid out
// again, in another font, on another page of a book and in a newer build of
// the ZIM with the passage still in it. One that is not found is reported and
// kept, never dropped.
//
// The page is only read and painted, never rewritten: the CSS Custom
// Highlight API paints over the text (a page whose own scripts still run, an
// alive capture, is left alone), and where a browser lacks it the passages
// are wrapped in <mark>s. The bar, the note card and every control belong to
// the shell's document; the page gets one stylesheet. A book page or an EPUB
// forbids scripts of its own, and none are put in it: everything runs here.
var ZimiHighlightsEngine = (function () {
  // The colours and the longest quote are the store's (Saved.HL_COLORS, the
  // first the default; Saved.HL_QUOTE_MAX, a longer passage keeping its first
  // and last half). Each colour's tint, for the Custom Highlight API and for
  // <mark>s alike:
  var TINT = { yellow: 'rgba(255,204,0,.42)', green: 'rgba(52,199,89,.34)', blue: 'rgba(64,156,255,.32)', pink: 'rgba(255,64,129,.30)' };
  var ON_TINT = 'rgba(255,149,0,.62)';                          // the passage just opened
  var NOTE_LINE = 'underline dotted 2px;text-underline-offset:3px';  // one with a note
  var CONTEXT = 32;            // characters of context kept on each side
  var POS_WEIGHT = 24;         // the share of the page, against up to 2 x CONTEXT of context
  var OCC_MAX = 500;           // repeats of one passage weighed at most
  var END_SLACK = 0.25;        // a long passage may have grown or shrunk this much
  var END_SLACK_MIN = 16;
  var SETTLE_MS = 220, SETTLE_TOUCH_MS = 350;  // a selection settles before the bar shows
  var FLASH_MS = 1600;         // a highlight opened from the panel stands out this long
  var SHOW_AT = 1 / 3;         // ...a third of the way down the screen
  var STYLE_ID = 'zimi-hl-style';
  var MARK_ATTR = 'data-zimi-hl';
  // Never part of the text: what does not show, and the book reader's own bars.
  var SKIP = 'script,style,noscript,template,textarea,select,.zb-bar,.zb-sheet,.zb-mini,.zb-scrim,#zimi-top';
  // Where a space belongs between two runs of text in a quote read aloud.
  var BLOCK = 'p,div,li,dd,dt,h1,h2,h3,h4,h5,h6,td,th,caption,blockquote,pre,section,article,figure,figcaption,header,footer,aside,nav,table,tr,ul,ol,dl';
  // Taps that belong to the page, not to a highlight under them.
  var TAPPABLE = 'a[href],button,input,textarea,select,label,summary,video,audio,.zb-bar,.zb-sheet,.zb-scrim';
  // Invisible or spacing: not compared (a soft hyphen, the zero-width marks).
  var IGNORABLE = /[\s\u00ad\u200b-\u200f\u2060\ufeff]/;
  var IGNORABLE_G = /[\s\u00ad\u200b-\u200f\u2060\ufeff]+/g;
  // The page's one stylesheet: each colour's tint, as a registered highlight
  // and as a <mark>, then a note's underline and the passage just opened.
  function hlCss() {
    var css = ['mark[' + MARK_ATTR + ']{color:inherit;background:none;padding:0;border-radius:2px}'];
    Saved.HL_COLORS.forEach(function (c) {
      css.push('::highlight(zimi-hl-' + c + '){background-color:' + TINT[c] + '}', 'mark[data-c=' + c + ']{background:' + TINT[c] + '}');
    });
    return css.concat(['::highlight(zimi-hl-note){text-decoration:' + NOTE_LINE + '}', 'mark.zimi-hl-note{text-decoration:' + NOTE_LINE + '}',
      '::highlight(zimi-hl-on){background-color:' + ON_TINT + '}', 'mark.zimi-hl-on{background:' + ON_TINT + '}']).join('');
  }

  // ── the page's text, as compared ──────────────────────────────────────────
  // Lower case without changing a string's length (a character whose lower
  // case is longer stays as it is), so a place in one is a place in the other.
  function fold(s) {
    var l = s.toLowerCase();
    if (l.length === s.length) return l;
    var out = '';
    for (var i = 0; i < s.length; i++) { var c = s.charAt(i), x = c.toLowerCase(); out += x.length === 1 ? x : c; }
    return out;
  }
  function canon(s) { return fold(String(s == null ? '' : s)).replace(IGNORABLE_G, ''); }
  // Offset in v of its k-th compared character (v.length past the last).
  function keptAt(v, k) {
    for (var j = 0, seen = 0; j < v.length; j++) {
      if (IGNORABLE.test(v.charAt(j))) continue;
      if (seen === k) return j;
      seen++;
    }
    return v.length;
  }

  // Every text node under root that shows, and the page's text as compared:
  // {doc, nodes, starts (where each node's text begins in it), text}.
  function textIndex(root) {
    var doc = root.ownerDocument || root, nodes = [], starts = [], parts = [], len = 0;
    var w = doc.createTreeWalker(root, 5 /* SHOW_ELEMENT | SHOW_TEXT */, { acceptNode: function (n) {
      if (n.nodeType === 3) return 1;                       // FILTER_ACCEPT
      return n.matches && n.matches(SKIP) ? 2 : 3;          // REJECT the subtree : SKIP the element
    } });
    var n;
    while ((n = w.nextNode())) {
      if (n.nodeType !== 3) continue;
      var c = canon(n.nodeValue);
      if (!c) continue;
      nodes.push(n); starts.push(len); parts.push(c); len += c.length;
    }
    return { doc: doc, root: root, nodes: nodes, starts: starts, text: parts.join(''), at: null };
  }
  // The node holding compared character i.
  function nodeAt(ix, i) {
    var lo = 0, hi = ix.nodes.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (ix.starts[mid] <= i) lo = mid; else hi = mid - 1; }
    return lo;
  }
  // The DOM point before compared character i, or (after) just past character i - 1.
  function point(ix, i, after) {
    var ch = Math.max(0, Math.min(ix.text.length - 1, after ? i - 1 : i));
    var k = nodeAt(ix, ch), node = ix.nodes[k], off = keptAt(node.nodeValue, ch - ix.starts[k]);
    if (after) off += /[\ud800-\udbff]/.test(node.nodeValue.charAt(off)) ? 2 : 1;
    return { node: node, off: off };
  }
  // Where a DOM point falls in the compared text.
  function indexOf(ix, node, off) {
    if (!ix.at) { ix.at = new Map(); ix.nodes.forEach(function (n, k) { ix.at.set(n, k); }); }
    if (node.nodeType === 3 && ix.at.has(node)) {
      var k = ix.at.get(node);
      return ix.starts[k] + canon(node.nodeValue.slice(0, off)).length;
    }
    // Between runs of text (or in one not counted): the next counted one.
    var r = ix.doc.createRange();
    try { r.setStart(node, off); } catch (e) { return -1; }
    var lo = 0, hi = ix.nodes.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (r.comparePoint(ix.nodes[mid], 0) < 0) lo = mid + 1; else hi = mid; }
    return lo < ix.nodes.length ? ix.starts[lo] : ix.text.length;
  }
  function rangeFor(ix, start, end) {
    var a = point(ix, start, false), b = point(ix, end, true), r = ix.doc.createRange();
    r.setStart(a.node, a.off); r.setEnd(b.node, b.off);
    return r;
  }
  // The passage from s to e as it reads: a space where the text runs from
  // one block (or line) to the next, whitespace as one space.
  function shownText(ix, s, e) {
    if (e <= s) return '';
    var k0 = nodeAt(ix, s), k1 = nodeAt(ix, e - 1), out = '', lastBlock = null;
    for (var k = k0; k <= k1; k++) {
      var n = ix.nodes[k], v = n.nodeValue;
      var a = k === k0 ? keptAt(v, s - ix.starts[k]) : 0;
      var b = k === k1 ? keptAt(v, e - 1 - ix.starts[k]) + 1 : v.length;
      var block = n.parentNode && n.parentNode.closest ? n.parentNode.closest(BLOCK) : null;
      if (k > k0 && (block !== lastBlock || (n.previousSibling && n.previousSibling.nodeName === 'BR'))) out += ' ';
      lastBlock = block;
      out += v.slice(a, b);
    }
    return out.replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
  }

  // ── a passage, described and found again ──────────────────────────────────
  // {exact, [end, n], prefix, suffix, pos} for a Range, or null.
  function describe(ix, range) {
    var s = indexOf(ix, range.startContainer, range.startOffset), e = indexOf(ix, range.endContainer, range.endOffset);
    if (s < 0 || e <= s) return null;
    return describeAt(ix, s, e);
  }
  function describeAt(ix, s, e) {
    var shown = shownText(ix, s, e);
    if (!shown) return null;
    var sel = { prefix: ix.text.slice(Math.max(0, s - CONTEXT), s), suffix: ix.text.slice(e, e + CONTEXT),
      pos: Math.round(s / Math.max(1, ix.text.length) * 1e5) / 1e5 };
    var most = Saved.HL_QUOTE_MAX, half = most / 2;
    if (shown.length <= most) sel.exact = shown;
    else { sel.exact = shown.slice(0, half).trim(); sel.end = shown.slice(-half).trim(); sel.n = e - s; }
    return sel;
  }
  // How many characters of context agree, outward from the passage.
  function agree(T, at, ctx, dir) {
    var k = 0;
    if (dir < 0) while (k < ctx.length && at - 1 - k >= 0 && T.charAt(at - 1 - k) === ctx.charAt(ctx.length - 1 - k)) k++;
    else while (k < ctx.length && at + k < T.length && T.charAt(at + k) === ctx.charAt(k)) k++;
    return k;
  }
  // A long passage's end: its last words where its length says, give or take.
  function longEnd(T, at, tail, n) {
    var want = at + n, slack = Math.max(END_SLACK_MIN, Math.round(n * END_SLACK)), best = -1;
    for (var j = T.indexOf(tail, Math.max(at, want - tail.length - slack)); j >= 0 && j + tail.length <= want + slack; j = T.indexOf(tail, j + 1)) {
      var e = j + tail.length;
      if (best < 0 || Math.abs(e - want) < Math.abs(best - want)) best = e;
    }
    return best;
  }
  // Where a described passage is in the text T (compared form): {start, end}
  // of the best match, or null when it is not there.
  function locateIn(T, sel) {
    var q = canon(sel && sel.exact);
    if (!q) return null;
    var tail = sel.end ? canon(sel.end) : '', n = Number(sel.n) || 0;
    var pre = canon(sel.prefix), suf = canon(sel.suffix), pos = typeof sel.pos === 'number' ? sel.pos : -1;
    var best = null;
    for (var at = T.indexOf(q), seen = 0; at >= 0 && seen < OCC_MAX; at = T.indexOf(q, at + 1), seen++) {
      var end = tail && n ? longEnd(T, at, tail, n) : at + q.length;
      if (end < 0) continue;
      var score = agree(T, at, pre, -1) + agree(T, end, suf, 1);
      if (pos >= 0) score -= POS_WEIGHT * Math.abs(at / Math.max(1, T.length) - pos);
      if (!best || score > best.score) best = { start: at, end: end, score: score };
    }
    return best;
  }

  // ── painting ──────────────────────────────────────────────────────────────
  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    var st = doc.createElement('style');
    st.id = STYLE_ID;
    st.textContent = hlCss();
    (doc.head || doc.documentElement).appendChild(st);
  }
  // The Custom Highlight API: one registered highlight per colour, one for
  // the underline of a note, one for the passage just opened.
  function apiPainter(doc) {
    var NAMES = Saved.HL_COLORS.concat(['note', 'on']);
    var win = doc.defaultView;
    return {
      marks: false,
      set: function (items, on) {
        var by = {};
        items.forEach(function (it) {
          (by[it.color] = by[it.color] || []).push(it.range);
          if (it.note) (by.note = by.note || []).push(it.range);
          if (it.id === on) (by.on = by.on || []).push(it.range);
        });
        NAMES.forEach(function (k) {
          var name = 'zimi-hl-' + k;
          if (!by[k]) { win.CSS.highlights.delete(name); return; }
          var hl = new win.Highlight();
          by[k].forEach(function (r) { hl.add(r); });
          if (k === 'on') hl.priority = 1;
          win.CSS.highlights.set(name, hl);
        });
      },
      clear: function () { NAMES.forEach(function (k) { win.CSS.highlights.delete('zimi-hl-' + k); }); }
    };
  }
  // Without it: each run of highlighted text in a <mark>. Every piece is
  // found before anything moves; a run under two highlights takes the later.
  function markPainter(doc) {
    var clear = function () {
      Array.prototype.slice.call(doc.querySelectorAll('mark[' + MARK_ATTR + ']')).forEach(function (m) {
        var p = m.parentNode;
        if (!p) return;
        while (m.firstChild) p.insertBefore(m.firstChild, m);
        p.removeChild(m);
        p.normalize();
      });
    };
    return {
      marks: true,
      clear: clear,
      set: function (items, on) {
        clear();
        var byNode = new Map();
        items.forEach(function (it) {
          textIn(it.range).forEach(function (p) {
            if (!byNode.has(p.node)) byNode.set(p.node, []);
            byNode.get(p.node).push({ a: p.a, b: p.b, it: it });
          });
        });
        byNode.forEach(function (list, node) {
          var cuts = [0, node.nodeValue.length];
          list.forEach(function (p) { cuts.push(p.a, p.b); });
          cuts = cuts.filter(function (c, i) { return cuts.indexOf(c) === i; }).sort(function (x, y) { return x - y; });
          var cur = node;
          for (var i = 1; i < cuts.length; i++) {
            var a = cuts[i - 1], b = cuts[i], next = i < cuts.length - 1 ? cur.splitText(b - a) : null;
            var cover = list.filter(function (p) { return p.a <= a && p.b >= b; }).pop();
            if (cover) {
              var m = doc.createElement('mark');
              m.setAttribute(MARK_ATTR, cover.it.id);
              m.setAttribute('data-c', cover.it.color);
              if (cover.it.note) m.classList.add('zimi-hl-note');
              if (cover.it.id === on) m.classList.add('zimi-hl-on');
              cur.parentNode.insertBefore(m, cur);
              m.appendChild(cur);
            }
            cur = next;
          }
        });
      }
    };
  }
  // The text nodes a range covers, with the part of each.
  function textIn(range) {
    var root = range.commonAncestorContainer, out = [];
    var add = function (t) {
      if (t.parentNode && t.parentNode.closest && t.parentNode.closest(SKIP)) return;
      var a = t === range.startContainer ? range.startOffset : 0, b = t === range.endContainer ? range.endOffset : t.nodeValue.length;
      if (b > a) out.push({ node: t, a: a, b: b });
    };
    if (root.nodeType === 3) { add(root); return out; }
    var w = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */), t;
    while ((t = w.nextNode())) if (range.intersectsNode(t)) add(t);
    return out;
  }
  function painterFor(doc) {
    var win = doc.defaultView;
    var api = !engine._forceMarks && win && win.CSS && win.CSS.highlights && typeof win.Highlight === 'function';
    return api ? apiPainter(doc) : markPainter(doc);
  }

  // ── the shell's bar and note card ─────────────────────────────────────────
  var ui = { bar: null, note: null, h: null, mode: '', range: null, id: '', text: '' };
  var SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  var ICON = {
    note: '<svg ' + SVG + '><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    copy: '<svg ' + SVG + '><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    remove: '<svg ' + SVG + '><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>'
  };
  function isTouch() { return typeof _defineIsTouch === 'function' && _defineIsTouch(); }
  function lastColor() {
    var c = ''; try { c = localStorage.getItem(SK.HL_COLOR) || ''; } catch (e) {}
    return Saved.HL_COLORS.indexOf(c) >= 0 ? c : Saved.HL_COLORS[0];
  }
  function button(action, icon, label) {
    return '<button type="button" data-a="' + action + '">' + icon + '<span>' + esc(label) + '</span></button>';
  }
  function noteButton(has) {
    var label = t(has ? 'hl_note_edit' : 'hl_note');
    return '<button type="button" class="hl-note-btn" data-a="note" aria-label="' + escAttr(label) + '" title="' + escAttr(label) + '">' + ICON.note + '<span>' + esc(t('hl_note')) + '</span></button>';
  }
  // A phone too narrow for the edit bar with Note's word (Russian, Arabic at
  // 360px): Note keeps its pencil, like Copy and Remove beside it.
  function fitBar(h, range) {
    var nb = ui.bar.querySelector('.hl-note-btn');
    ui.bar.classList.remove('hl-tight');
    if (nb && nb.scrollWidth > nb.clientWidth + 1) { ui.bar.classList.add('hl-tight'); placeBar(h, range); }
  }
  function iconButton(action, icon, label) {
    return '<button type="button" class="hl-icon" data-a="' + action + '" aria-label="' + escAttr(label) + '" title="' + escAttr(label) + '">' + icon + '</button>';
  }
  function barEl() {
    if (ui.bar) return ui.bar;
    var el = document.createElement('div');
    el.id = 'hl-bar';
    el.className = 'hl-bar';
    el.setAttribute('role', 'toolbar');
    // A press on the bar must not take the selection away from the page.
    el.addEventListener('mousedown', function (e) { e.preventDefault(); });
    el.addEventListener('click', onBarClick);
    document.body.appendChild(el);
    // A press anywhere else in the shell (a finger or a mouse) puts it away.
    document.addEventListener('pointerdown', function (e) {
      if (ui.bar.classList.contains('open') && !ui.bar.contains(e.target)) hideBar();
    }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ui.bar.classList.contains('open')) hideBar(); });
    ui.bar = el;
    return el;
  }
  function hideBar() {
    if (!ui.bar) return;
    ui.bar.classList.remove('open');
    ui.h = null; ui.mode = ''; ui.range = null; ui.id = ''; ui.text = '';
  }
  // Where the passage is, in the shell: the page's frame, then its place in it.
  function placeBar(h, range) {
    var frame = h.frame();
    if (!frame || !range) return false;
    var rect = _defineRangeRect(frame, range);
    var box = frame.getBoundingClientRect();
    if (!rect || rect.top > box.bottom || rect.y < box.top) { ui.bar.classList.remove('open'); return false; }
    ui.bar.classList.add('open');
    _popoverPlace(ui.bar, rect);
    return true;
  }
  function showBar(h, mode, range, id, text) {
    var el = barEl();
    ui.h = h; ui.mode = mode; ui.range = range; ui.id = id || ''; ui.text = text || '';
    el.setAttribute('dir', document.documentElement.getAttribute('dir') || 'ltr');
    el.setAttribute('aria-label', t(mode === 'new' ? 'hl_highlight' : 'saved_highlights'));
    if (mode === 'new') {
      var word = ui.text.trim();
      var define = typeof _defineCanDefine === 'function' && _defineCanDefine(word, h.doc);
      el.innerHTML = button('add', _HL_SVG, t('hl_highlight')) + button('note', ICON.note, t('hl_note')) +
        button('copy', ICON.copy, t('copy')) + (define ? button('define', _DEFINE_BOOK_ICON, t('define')) : '');
    } else {
      var hl = Saved.getHighlight(id);
      if (!hl) { hideBar(); return; }
      el.innerHTML = '<span class="hl-swatches" role="group" aria-label="' + escAttr(t('hl_color')) + '">' + Saved.HL_COLORS.map(function (c) {
        return '<button type="button" class="hl-swatch" data-a="color" data-c="' + c + '" aria-pressed="' + (hl.color === c) + '" aria-label="' +
          escAttr(t('hl_' + c)) + '" title="' + escAttr(t('hl_' + c)) + '"><span class="hl-c-' + c + '"></span></button>';
      }).join('') + '</span><span class="hl-sep" aria-hidden="true"></span>' +
        // "Note" either way (a note is shown by the underline): "Edit note"
        // ran out of its button in German and Russian. Said in full to a
        // screen reader and on hover.
        noteButton(hl.note) + iconButton('copy', ICON.copy, t('copy')) +
        iconButton('remove', ICON.remove, t('hl_remove'));
    }
    if (placeBar(h, range)) fitBar(h, range);
  }
  function onBarClick(e) {
    var b = e.target.closest('button[data-a]');
    var h = ui.h;
    if (!b || !h || h.dead) return;
    var a = b.getAttribute('data-a');
    if (ui.mode === 'new') {
      if (a === 'copy') { _copyText(ui.text); hideBar(); return; }
      if (a === 'define') {
        var rect = _defineRangeRect(h.frame(), ui.range);
        var word = ui.text.trim(), doc = h.doc;
        hideBar();
        _defineWordAt(word, doc, rect);
        return;
      }
      var id = h.create(ui.range, lastColor());
      if (!id) { hideBar(); return; }
      if (a === 'note') { openNote(h, id); return; }
      showBar(h, 'edit', h.rangeOf(id), id);
      return;
    }
    var hid = ui.id;
    if (a === 'color') {
      var c = b.getAttribute('data-c');
      try { localStorage.setItem(SK.HL_COLOR, c); } catch (err) {}
      Saved.highlight({ id: hid, color: c });
      h.refresh(true);
      showBar(h, 'edit', h.rangeOf(hid), hid);
    } else if (a === 'note') {
      openNote(h, hid);
    } else if (a === 'copy') {
      _copyText(h.textOf(hid));
      hideBar();
    } else if (a === 'remove') {
      _savedRemoveHighlight(hid, function () { h.refresh(true); });
      h.refresh(true);
      hideBar();
    }
  }
  function noteEl() {
    if (ui.note) return ui.note;
    var el = document.createElement('div');
    el.id = 'hl-note';
    el.className = 'hl-note';
    el.setAttribute('role', 'dialog');
    document.body.appendChild(el);
    ui.note = el;
    return el;
  }
  function closeNote() { if (ui.note) { ui.note.classList.remove('open'); ui.note.innerHTML = ''; } }
  function openNote(h, id) {
    var hl = Saved.getHighlight(id);
    hideBar();
    if (!hl) return;
    var el = noteEl();
    el.setAttribute('dir', document.documentElement.getAttribute('dir') || 'ltr');
    el.setAttribute('aria-label', t('hl_note'));
    el.innerHTML = '<blockquote class="hl-note-quote hl-b-' + hl.color + '" dir="auto"></blockquote>' +
      '<textarea class="hl-note-text" dir="auto" rows="4" maxlength="2000" aria-label="' + escAttr(t('hl_note')) + '" placeholder="' + escAttr(t('hl_note_add')) + '"></textarea>' +
      '<div class="hl-note-actions"><button type="button" class="pill" data-a="cancel">' + esc(t('cancel')) + '</button>' +
      '<button type="button" class="pill active" data-a="save">' + esc(t('save')) + '</button></div>';
    el.querySelector('blockquote').textContent = _hlQuote(hl);
    var ta = el.querySelector('textarea');
    ta.value = hl.note || '';
    var done = function (keep) {
      if (keep) { Saved.highlight({ id: id, note: ta.value }); h.refresh(true); }
      closeNote();
    };
    el.onclick = function (e) {
      var b = e.target.closest('button[data-a]');
      if (b) done(b.getAttribute('data-a') === 'save');
    };
    // The shell's own keys (B, /, arrows) are not for a note being written.
    ta.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); done(true); }
    });
    el.classList.add('open');
    try { ta.focus({ preventScroll: true }); } catch (e) { ta.focus(); }
  }
  // ── one page's highlights ─────────────────────────────────────────────────
  // host is the shell's handle for the page (app.js's Highlights): its ref
  // and opts are read from it, so a later attach can change them.
  function Page(host) {
    var self = this;
    this.host = host;
    this.doc = host.doc;
    this.win = this.doc.defaultView;
    this.dead = false;
    this.found = {};       // id -> {range} (a live Range; with marks, found again from them)
    this.lost = [];
    this.sig = '';
    this.told = false;
    this.on = '';
    this.ix = null;
    this.painter = painterFor(this.doc);
    ensureStyle(this.doc);
    var settle = null, pressed = false;
    var consider = function () { settle = null; if (!pressed) self.offer(); };
    this.listeners = [
      ['selectionchange', function () { clearTimeout(settle); settle = setTimeout(consider, isTouch() ? SETTLE_TOUCH_MS : SETTLE_MS); }],
      ['mousedown', function (e) { if (e.button === 0) pressed = true; }],
      ['mouseup', function () { pressed = false; clearTimeout(settle); settle = setTimeout(consider, 10); }],
      ['scroll', function () { if (ui.h === self) self.follow(); }, true],
      ['keydown', function (e) { if (e.key === 'Escape' && ui.h === self) hideBar(); }]
    ];
    this.listeners.forEach(function (l) { self.doc.addEventListener(l[0], l[1], l[2] ? { capture: true, passive: true } : false); });
    // Taps on a highlight: on the element that holds the text, since iOS
    // sends a tap on plain text to an element's listener, never the document's.
    this.onTap = function (e) { self.tap(e); };
    this.tapOn = null;
    this.onHide = function () { if (ui.h === self) hideBar(); };
    this.win.addEventListener('pagehide', this.onHide);
    this.refresh();
  }
  Page.prototype.ref = function () { return this.host.ref; };
  Page.prototype.opts = function () { return this.host.opts || {}; };
  Page.prototype.frame = function () { try { return this.win.frameElement; } catch (e) { return null; } };
  Page.prototype.root = function () {
    var r = this.opts().root;
    return r && r.isConnected ? r : this.doc.body;
  };
  Page.prototype.index = function () {
    if (!this.ix || this.ix.root !== this.root()) this.ix = textIndex(this.root());
    return this.ix;
  };
  // The page's highlights as kept, each found in the text and painted.
  Page.prototype.refresh = function (quiet) {
    if (this.dead || !this.root()) return;
    if (this.tapOn !== this.root()) {
      if (this.tapOn) this.tapOn.removeEventListener('click', this.onTap, true);
      this.tapOn = this.root();
      this.tapOn.addEventListener('click', this.onTap, true);
    }
    var list = Saved.highlights(this.ref());
    this.painter.clear();
    this.ix = null;
    var ix = this.index(), found = {}, lost = [], items = [];
    list.forEach(function (h) {
      var at = ix.nodes.length ? locateIn(ix.text, h) : null;
      if (!at) { lost.push(h.id); return; }
      var r = rangeFor(ix, at.start, at.end);
      found[h.id] = { range: r, start: at.start, end: at.end };
      items.push({ id: h.id, range: r, color: h.color, note: !!h.note });
    });
    this.items = items;
    this.painter.set(items, this.on);
    // Marks split the text they wrap: its index is taken again when needed.
    if (this.painter.marks) this.ix = null;
    this.found = found;
    this.lost = lost;
    this.sig = sigOf(list);
    noteMissing(list, lost);
    if (!quiet && !this.told && lost.length) { this.told = true; _showToast(tPlural('hl_missing', lost.length)); }
  };
  // What is kept changed (here, in the panel, on another device): painted
  // again only if this page's highlights did.
  Page.prototype.changed = function () {
    if (this.dead) return;
    if (sigOf(Saved.highlights(this.ref())) !== this.sig) this.refresh(true);
    if (ui.h === this && ui.mode === 'edit' && !Saved.getHighlight(ui.id)) hideBar();
  };
  Page.prototype.rangeOf = function (id) {
    if (this.painter.marks) {
      var ms = this.doc.querySelectorAll('mark[' + MARK_ATTR + '="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      if (!ms.length) return null;
      var r = this.doc.createRange();
      r.setStartBefore(ms[0]); r.setEndAfter(ms[ms.length - 1]);
      return r;
    }
    return this.found[id] ? this.found[id].range : null;
  };
  // A highlight's passage as it reads now (the page's, not the kept quote,
  // which for a long passage is its start and end).
  Page.prototype.textOf = function (id) {
    var f = this.found[id];
    if (f && !this.painter.marks) return shownText(this.index(), f.start, f.end);
    var r = this.rangeOf(id), hl = Saved.getHighlight(id);
    return r ? r.toString().replace(/\s+/g, ' ').trim() : hl ? _hlQuote(hl) : '';
  };
  Page.prototype.create = function (range, color) {
    // The text as it is now: the page may have changed since it was painted.
    var ref = this.ref(), sel = describe(textIndex(this.root()), range);
    if (!sel) return '';
    // A highlighted page is a saved page.
    if (!Saved.has(ref)) Saved.save(ref);
    var h = { zim: ref.zim, path: ref.path, kind: ref.kind || 'article', title: ref.title || '', color: color };
    if (ref.app) h.app = ref.app;
    for (var k in sel) h[k] = sel[k];
    var id = Saved.highlight(h);
    try { this.win.getSelection().removeAllRanges(); } catch (e) {}
    this.refresh(true);
    return id;
  };
  // The selection, if it is text of this page: the bar for it.
  Page.prototype.offer = function () {
    if (this.dead || (ui.note && ui.note.classList.contains('open'))) return;
    var sel = this.win.getSelection && this.win.getSelection();
    var text = sel && !sel.isCollapsed && sel.rangeCount ? String(sel) : '';
    var r = text.trim() ? sel.getRangeAt(0) : null;
    var inside = r && this.root().contains(r.commonAncestorContainer);
    var n = r && (r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentNode);
    if (!inside || (n && n.closest && n.closest(SKIP))) {
      if (ui.h === this && ui.mode === 'new') hideBar();
      return;
    }
    showBar(this, 'new', r.cloneRange(), '', text);
  };
  // A tap on a highlight: its bar (colours, note, copy, remove).
  Page.prototype.tap = function (e) {
    if (e.defaultPrevented || e.button) return;
    var sel = this.win.getSelection && this.win.getSelection();
    if (sel && !sel.isCollapsed && String(sel).trim()) return;
    if (e.target.closest && e.target.closest(TAPPABLE)) return;
    var id = this.hit(e);
    if (!id) { if (ui.h === this && ui.mode === 'edit') hideBar(); return; }
    e.preventDefault();
    showBar(this, 'edit', this.rangeOf(id), id);
  };
  Page.prototype.hit = function (e) {
    if (this.painter.marks) {
      var m = e.target.closest && e.target.closest('mark[' + MARK_ATTR + ']');
      return m ? m.getAttribute(MARK_ATTR) : '';
    }
    var x = e.clientX, y = e.clientY;
    for (var id in this.found) {
      var rs = this.found[id].range.getClientRects();
      for (var i = 0; i < rs.length; i++) if (x >= rs[i].left - 1 && x <= rs[i].right + 1 && y >= rs[i].top - 1 && y <= rs[i].bottom + 1) return id;
    }
    return '';
  };
  Page.prototype.follow = function () {
    if (!ui.bar || !ui.bar.classList.contains('open')) return;
    var self = this;
    if (this._following) return;
    this._following = true;
    this.win.requestAnimationFrame(function () { self._following = false; if (ui.h === self && ui.range) placeBar(self, ui.range); });
  };
  // Bring a highlight into view: the page's own way (a book turns to its
  // page), else scrolled a third of the way down; it stands out a moment.
  Page.prototype.goTo = function (id) {
    if (this.dead) return false;
    if (!this.found[id] && !this.painter.marks) this.refresh(true);
    var r = this.rangeOf(id);
    if (!r) { if (Saved.getHighlight(id)) _showToast(t('hl_not_found')); return false; }
    var show = this.opts().show || this.doc.__zbShowRange;
    if (typeof show === 'function') show(r);
    else scrollToRange(this.win, r);
    this.flash(id);
    return true;
  };
  Page.prototype.flash = function (id) {
    var self = this;
    this.mark(id);
    clearTimeout(this._flash);
    this._flash = setTimeout(function () { if (self.on === id) self.mark(''); }, FLASH_MS);
  };
  // The passage just opened stands out (or none does): painted again as it is.
  Page.prototype.mark = function (id) {
    this.on = id;
    if (!this.painter.marks) { this.painter.set(this.items || [], id); return; }
    Array.prototype.forEach.call(this.doc.querySelectorAll('mark[' + MARK_ATTR + ']'), function (m) {
      m.classList.toggle('zimi-hl-on', m.getAttribute(MARK_ATTR) === id);
    });
  };
  Page.prototype.missing = function () { return this.lost.slice(); };
  Page.prototype.detach = function () {
    if (this.dead) return;
    var self = this;
    this.dead = true;
    clearTimeout(this._flash);
    this.listeners.forEach(function (l) { try { self.doc.removeEventListener(l[0], l[1], !!l[2]); } catch (e) {} });
    if (this.tapOn) try { this.tapOn.removeEventListener('click', this.onTap, true); } catch (e) {}
    try { this.win.removeEventListener('pagehide', this.onHide); } catch (e) {}
    try { this.painter.clear(); } catch (e) {}
    if (ui.h === this) hideBar();
  };
  function scrollToRange(win, r) {
    var rect = r.getBoundingClientRect(), before = win.scrollY || 0;
    win.scrollTo(0, Math.max(0, before + rect.top - win.innerHeight * SHOW_AT));
    // A page that scrolls inside an element rather than the window.
    if ((win.scrollY || 0) === before && (rect.top < 0 || rect.bottom > win.innerHeight)) {
      var n = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentNode;
      try { n.scrollIntoView({ block: 'center' }); } catch (e) {}
    }
  }
  function sigOf(list) { return list.map(function (h) { return h.id + ':' + h.ts; }).join(','); }
  // This browser's memory of what a page did not have (per device, never
  // synced: another device may hold another build), for the panel to say so.
  function noteMissing(list, lost) {
    var m = _hlMissingSet(), changed = false;
    list.forEach(function (h) {
      var miss = lost.indexOf(h.id) >= 0;
      if (miss && !m[h.id]) { m[h.id] = 1; changed = true; }
      else if (!miss && m[h.id]) { delete m[h.id]; changed = true; }
    });
    if (changed) _setStorageJSON(SK.HL_MISSING, m);
  }

  var engine = {
    attach: function (host) { return new Page(host); },
    // The pure parts, for the tests.
    _canon: canon, _locateIn: locateIn, _textIndex: textIndex, _describe: describe, _describeAt: describeAt,
    _rangeFor: rangeFor, _shownText: shownText, _markPainter: markPainter, _forceMarks: false
  };
  return engine;
})();
