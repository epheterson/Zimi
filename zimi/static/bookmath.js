// Math in a book of pages: the formulas zimi/bookpages.py marked
// (<span class="zb-tex">\(..\)</span>), drawn by the MathJax the book's own
// ZIM ships (<meta name="zimi-math" content="/w/<zim>/mathjax/es5/tex-svg.js">).
//
// Eric, 2026-09-30: LibreTexts textbooks showed raw TeX in the e-reader.
//
// The book's page runs no script (its CSP), so MathJax runs in a frame of its
// own beside the shell, one per ZIM, and hands each formula over as an SVG
// drawn in currentColor (the reader's ink, in every theme). Loaded by the
// shell only for a page that names a MathJax: a book with no formulas costs
// nothing. Formulas are drawn as they come near the screen (a textbook has
// tens of thousands), a chapter at a time when reading by pages.
//
// The TeX stays in the page, hidden, beside its drawing: a place in the book
// is a count of its characters (the e-reader, highlights), and it holds
// whether a formula has been drawn yet or not.
(function () {
  'use strict';
  var MARK = 'zb-tex', SRC = 'zb-tex-src', DONE = 'zb-tex-on';
  var STYLE_ID = 'zb-math-style';
  var LOAD_TIMEOUT_MS = 20000;     // MathJax from the ZIM, parsed: a few hundred ms
  var SLICE_MS = 24;               // work between yields, so a page still scrolls
  var NEAR = '150% 0px';           // how far off screen a formula is drawn ahead
  // An expression that only defines macros (LibreTexts' block of \newcommand
  // at each page's head): read once, first, wherever it is in the book.
  var DEFINES = /^\s*\\(?:newcommand|renewcommand|def|let|DeclareMathOperator|require)\b/;
  var engines = {};                // MathJax src -> Promise of its MathJax

  function engine(src) {
    if (engines[src]) return engines[src];
    engines[src] = new Promise(function (resolve, reject) {
      var f = document.createElement('iframe');
      f.setAttribute('aria-hidden', 'true');
      f.tabIndex = -1;
      f.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
      var timer = setTimeout(function () { fail('timed out'); }, LOAD_TIMEOUT_MS);
      function fail(why) { clearTimeout(timer); delete engines[src]; f.remove(); reject(new Error('MathJax: ' + why)); }
      // As the ZIM's own reader sets it up (mindtouch2zim's zimui), less what
      // a page it does not own would show: its menu, its typesetting of the
      // frame, the second copy of each formula it keeps for screen readers
      // (the drawing is labelled with its TeX instead).
      var config = {
        startup: { typeset: false },
        options: { enableMenu: false, enableAssistiveMml: false },
        svg: { fontCache: 'local' },
        tex: { macros: { PageIndex: ['{#1}', 1] } }
      };
      f.srcdoc = '<!DOCTYPE html><meta charset="utf-8"><script>window.MathJax=' + JSON.stringify(config) +
        '<\/script><script src="' + src.replace(/"/g, '&quot;') + '"><\/script>';
      f.onload = function () {
        var MJ = f.contentWindow && f.contentWindow.MathJax;
        if (!MJ || !MJ.startup || !MJ.startup.promise) return fail('not loaded');
        MJ.startup.promise.then(function () {
          clearTimeout(timer);
          if (typeof MJ.tex2svgPromise !== 'function') return fail('no TeX to SVG');
          resolve(MJ);
        }, function (e) { fail(String(e)); });
      };
      document.body.appendChild(f);
    });
    return engines[src];
  }

  // "\(x\)" -> {tex: "x", display: false}
  function parse(s) {
    s = s.replace(/\u00a0/g, ' ');
    var open = s.slice(0, 2);
    return { tex: s.slice(2, -2), display: open !== '\\(' };
  }

  function draw(MJ, doc, span, cache) {
    if (span.classList.contains(DONE) || !span.isConnected) return Promise.resolve();
    var raw = span.textContent, f = parse(raw);
    var got = cache && cache[raw];
    var made = got ? Promise.resolve(got) : MJ.tex2svgPromise(f.tex, { display: f.display });
    return made.then(function (node) {
      if (cache) cache[raw] = node;
      if (span.classList.contains(DONE)) return;
      // A formula MathJax cannot read stays as written.
      if (node.querySelector('[data-mml-node="merror"]')) return;
      var src = doc.createElement('span');
      src.className = SRC;
      while (span.firstChild) src.appendChild(span.firstChild);
      span.appendChild(src);
      // Nothing to see (a macro defined): the TeX alone, hidden.
      if (node.querySelector('use,path,rect,text,image')) {
        var out = doc.importNode(node, true);
        out.setAttribute('role', 'math');
        out.setAttribute('aria-label', f.tex.trim());
        span.appendChild(out);
      }
      span.classList.add(DONE);
      if (f.display) span.classList.add('zb-tex-d');
    }, function () {});
  }

  function css(MJ, doc) {
    if (doc.getElementById(STYLE_ID)) return;
    var st = doc.createElement('style');
    st.id = STYLE_ID;
    var sheet = '';
    try { sheet = MJ.svgStylesheet().textContent || ''; } catch (e) {}
    st.textContent = sheet +
      '.' + SRC + '{display:none!important}' +
      // A formula is type: the reader's ink, never a picture's box.
      '.zimi-reader .' + MARK + ' svg{max-width:none!important;height:auto;border-radius:0;margin:0;display:inline;fill:currentColor}' +
      // One too wide for a phone scrolls in its line, not the page.
      '.zimi-reader .' + MARK + '.zb-tex-d{display:block;overflow-x:auto!important;overflow-y:hidden!important;max-width:100%;-webkit-overflow-scrolling:touch}' +
      '.zimi-reader .' + MARK + '.zb-tex-d mjx-container{margin:.6em 0!important}';
    (doc.head || doc.documentElement).appendChild(st);
  }

  // Draw the formulas of doc as they come near the screen. reflow(), when
  // given, is told once a run of them has been drawn (a page laid out in
  // columns counts its pages again).
  function attach(doc, src, reflow) {
    if (!doc || doc.__zbMath) return;
    doc.__zbMath = true;
    var win = doc.defaultView;
    var all = Array.prototype.slice.call(doc.querySelectorAll('.' + MARK));
    if (!all.length || !win) return;
    engine(src).then(function (MJ) {
      if (!doc.defaultView) return;
      css(MJ, doc);
      var defs = [], rest = [];
      all.forEach(function (s) { (DEFINES.test(parse(s.textContent).tex) ? defs : rest).push(s); });
      // The macros first, each once, in book order.
      var seen = {}, chain = Promise.resolve();
      defs.forEach(function (s) {
        var cache = seen;
        chain = chain.then(function () { return draw(MJ, doc, s, cache); });
      });
      return chain.then(function () { watch(MJ, doc, win, rest, reflow); });
    }).catch(function (e) { console.warn('Book math:', e && e.message ? e.message : e); });
  }

  function watch(MJ, doc, win, spans, reflow) {
    var queue = [], queued = new Set(), busy = false;
    var paged = function () { return doc.documentElement.classList.contains('zb-paged'); };
    function want(s) { if (!queued.has(s) && !s.classList.contains(DONE)) { queued.add(s); queue.push(s); } }
    // One at a time, yielding every SLICE_MS; the page told once the queue
    // is empty.
    function run() {
      if (busy) return;
      busy = true;
      var drew = 0, t0 = Date.now();
      (function next() {
        if (!queue.length || !doc.defaultView) {
          busy = false;
          if (drew && reflow && doc.defaultView) { try { reflow(); } catch (e) {} }
          return;
        }
        if (Date.now() - t0 > SLICE_MS) { setTimeout(function () { t0 = Date.now(); next(); }, 0); return; }
        var s = queue.shift();
        draw(MJ, doc, s).then(function () {
          if (s.classList.contains(DONE)) { drew++; io.unobserve(s); }
          next();
        });
      })();
    }
    var io = null;
    var seen = function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        // Pages: the whole chapter on screen, so its pages are counted once.
        var sec = paged() && e.target.closest('.zb-sec');
        if (sec) Array.prototype.forEach.call(sec.querySelectorAll('.' + MARK + ':not(.' + DONE + ')'), want);
        else want(e.target);
      });
      if (queue.length) run();
    };
    try { io = new win.IntersectionObserver(seen, { root: doc, rootMargin: NEAR }); }
    catch (e) { io = new win.IntersectionObserver(seen, { rootMargin: NEAR }); }
    spans.forEach(function (s) { io.observe(s); });
  }

  window.ZimiBookMath = { attach: attach };
})();
