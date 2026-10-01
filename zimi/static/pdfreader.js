// Zimi's PDF reader: its own chrome over pdf.js, which keeps drawing the
// pages. Inlined at the foot of pdfjs/web/viewer.html by the server
// (http._inline_apps_assets), before pdf.js's own module runs.
//
// Eric, 2026-10-01: "PDF toolbar at least on mobile is ugly af. Can we own
// it and redesign intuitively?"
//
// One job: read this document. The top bar is the document: back, its name
// (and the library it is from), find, and the rest under ⋯ (save, dark
// pages, download, print). The bottom bar is where you are in it: contents
// and pages, a slider of its pages, the page you are on, and how it fits.
// Both step aside as you read down and come back on a tap or a scroll up,
// as the book reader's do. pdf.js is driven through its event bus and its
// viewer's API, never patched: its toolbar and sidebar are put away (CSS),
// its find, zoom, pinch, keys, links, print and download do the work.
//
// Where you are is kept as a position in Saved (Bookshelf's Continue
// reading, and the account's when signed in): {p: the page, f: the share
// read}. The document opens there again, unless its address names a page.
(function () {
  'use strict';
  var BARS_HIDE = 24;          // px scrolled down (or up) before the bars leave (or come back)
  var SAVE_MS = 800;           // ms of rest on a page before it is kept
  var PINCH_TAP_MS = 400;      // ms after a pinch in which a tap is the pinch's own
  var THUMB_PX = 200;          // px wide a page is drawn for the pages sheet (two device pixels a column)
  var LOAD_WAIT_MS = 50, LOAD_WAIT_TRIES = 200;
  var DARK_KEY = 'zimi_pdf_dark';          // '1' / '0': chosen here; absent: follow the articles
  var POS_KEY = 'zimi_pdf_pos:';           // + the file: the page, outside the shell
  var TOKENS = ['--bg', '--surface', '--surface2', '--border', '--text', '--text2', '--amber', '--amber-glow', '--on-amber'];
  var FIT_WIDTH = 'page-width', FIT_PAGE = 'page-fit';
  var FIND_NOT_FOUND = 1;      // pdf.js FindState.NOT_FOUND

  var html = document.documentElement;
  // The shell around the viewer (same origin), when there is one.
  var shell = null;
  try { if (window.parent !== window && window.parent.Saved) shell = window.parent; } catch (e) { shell = null; }

  // ── words: the shell's, in its language; English on its own ──
  var EN = {
    go_back: 'Go back', more_actions: 'More actions', find_in_page: 'Find in page', find_none: 'No matches',
    find_prev: 'Previous match', find_next: 'Next match', close: 'Close', n_of_total: '{n} of {total}',
    books_contents: 'Contents', books_mode_pages: 'Pages', download: 'Download', save: 'Save', saved: 'Saved',
    pdf_print: 'Print', pdf_fit_width: 'Fit width', pdf_fit_page: 'Fit page', pdf_zoom_in: 'Zoom in',
    pdf_zoom_out: 'Zoom out', pdf_dark_pages: 'Dark pages', pdf_page: 'Page', pdf_failed: 'This PDF could not be opened.'
  };
  function t(k, vars) {
    var s = '';
    try { if (shell && shell.t) s = shell.t(k, vars); } catch (e) { s = ''; }
    if (s && s !== k) return s;
    s = EN[k] || k;
    for (var v in vars || {}) s = s.split('{' + v + '}').join(String(vars[v]));
    return s;
  }
  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {} return null; }
  var fmt = null;
  try { fmt = new Intl.NumberFormat(shell && shell._currentLang || undefined); } catch (e) { fmt = null; }
  function num(n) { return fmt ? fmt.format(n) : String(n); }

  // ── the document: its ZIM and path, from the address ──
  var file = new URLSearchParams(location.search).get('file') || '';
  var loc = /^\/w\/([^\/?#]+)\/([^?#]+)/.exec(file);
  var zim = '', path = '';
  try { if (loc) { zim = decodeURIComponent(loc[1]); path = decodeURIComponent(loc[2]); } } catch (e) {}
  var fileName = (path || file).split('/').pop().replace(/\.pdf$/i, '');

  // ── Zimi's colours and direction, the shell's own (and kept in step) ──
  function shellTheme() {
    try { return shell.document.documentElement.getAttribute('data-theme') || ''; } catch (e) { return ''; }
  }
  function syncTheme() {
    if (!shell) return;
    var cs = shell.getComputedStyle(shell.document.documentElement);
    TOKENS.forEach(function (k) { var v = cs.getPropertyValue(k).trim(); if (v) html.style.setProperty(k, v); });
    var theme = shellTheme();
    if (theme) { html.setAttribute('data-zp-theme', theme); html.style.colorScheme = theme; }
    paintDark();
  }
  function uiDir() {
    try { if (shell) return shell.document.documentElement.getAttribute('dir') === 'rtl' ? 'rtl' : 'ltr'; } catch (e) {}
    return html.dir === 'rtl' ? 'rtl' : 'ltr';
  }

  // ── dark pages: chosen here, or as the articles are (Simulate dark mode) ──
  function darkWanted() {
    var v = store(DARK_KEY);
    if (v === '1' || v === '0') return v === '1';
    try { if (shell) return !!(shell._articlesAreDark() && shell._darkenArticlesOn()); } catch (e) {}
    try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; }
  }
  function paintDark() {
    var on = darkWanted();
    html.classList.toggle('zp-dark', on);
    var b = document.querySelector('[data-zp="dark"]');
    if (b) b.setAttribute('aria-checked', String(on));
  }

  // ── icons: Zimi's line, 24 grid, 2px stroke ──
  function svg(d, extra) { return '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' + (extra || '') + '>' + d + '</svg>'; }
  var I = {
    back: svg('<path d="M15 5l-7 7 7 7"/>'),
    find: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>'),
    more: svg('<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>'),
    toc: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".6" fill="currentColor"/><circle cx="4.5" cy="12" r=".6" fill="currentColor"/><circle cx="4.5" cy="18" r=".6" fill="currentColor"/>'),
    width: svg('<path d="M4 5v14M20 5v14"/><path d="M8 12h8M10.5 9.5L8 12l2.5 2.5M13.5 9.5L16 12l-2.5 2.5"/>'),
    page: svg('<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><rect x="8.5" y="7" width="7" height="10" rx="1"/>'),
    zin: svg('<path d="M12 5v14M5 12h14"/>'),
    zout: svg('<path d="M5 12h14"/>'),
    up: svg('<path d="M6 15l6-6 6 6"/>'),
    down: svg('<path d="M6 9l6 6 6-6"/>'),
    mark: svg('<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>'),
    moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
    dl: svg('<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>'),
    print: svg('<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>')
  };
  function iconBtn(cls, icon, label, extra) {
    return '<button type="button" class="zp-icon ' + cls + '" aria-label="' + esc(label) + '" title="' + esc(label) + '"' + (extra || '') + '>' + icon + '</button>';
  }

  // ── the bars, the sheet, the menu ──
  var dir = uiDir();
  var ui = document.createElement('div');
  ui.className = 'zp-ui';
  ui.setAttribute('dir', dir);
  ui.innerHTML =
    '<div class="zp-bar zp-head" role="toolbar">' +
      iconBtn('zp-back zp-flip zp-hide-finding', I.back, t('go_back')) +
      '<div class="zp-title"><b></b><span></span></div>' +
      '<div class="zp-find" role="search">' +
        iconBtn('zp-find-close zp-flip', I.back, t('close')) +
        '<input type="text" enterkeyhint="search" autocomplete="off" spellcheck="false" aria-label="' + esc(t('find_in_page')) + '" placeholder="' + esc(t('find_in_page')) + '">' +
        '<span class="zp-count" aria-live="polite"></span>' +
        iconBtn('zp-find-prev', I.up, t('find_prev')) + iconBtn('zp-find-next', I.down, t('find_next')) +
      '</div>' +
      iconBtn('zp-find-btn zp-hide-finding', I.find, t('find_in_page'), ' aria-keyshortcuts="Control+F"') +
      iconBtn('zp-more zp-hide-finding', I.more, t('more_actions'), ' aria-haspopup="menu" aria-expanded="false"') +
    '</div>' +
    '<div class="zp-bar zp-foot" hidden>' +
      '<input type="range" class="zp-scrub" min="1" max="1" step="1" value="1" aria-label="' + esc(t('pdf_page')) + '">' +
      '<div class="zp-row">' +
        iconBtn('zp-toc-btn', I.toc, t('books_contents'), ' aria-haspopup="dialog"') +
        iconBtn('zp-zoom zp-out', I.zout, t('pdf_zoom_out')) +
        '<div class="zp-pagebox"><button type="button" class="zp-page" aria-label="' + esc(t('pdf_page')) + '"></button></div>' +
        iconBtn('zp-zoom zp-in', I.zin, t('pdf_zoom_in')) +
        iconBtn('zp-fit', I.page, t('pdf_fit_page')) +
      '</div>' +
    '</div>' +
    '<div class="zp-scrim"></div>' +
    '<div class="zp-sheet" role="dialog" aria-label="' + esc(t('books_contents')) + '"></div>' +
    '<div class="zp-menu" role="menu"></div>';
  document.body.appendChild(ui);
  var $ = function (s) { return ui.querySelector(s); };
  var head = $('.zp-head'), foot = $('.zp-foot'), scrub = $('.zp-scrub'), pageBtn = $('.zp-page');
  var sheet = $('.zp-sheet'), menu = $('.zp-menu'), findInput = $('.zp-find input'), count = $('.zp-count');

  // The name: the shell's (a catalog's title for it), else the file's, until
  // the PDF says its own; and the library it is from.
  function shellTitle() {
    try { return (shell.document.title || '').replace(/\s+—\s+Zimi$/, '').trim(); } catch (e) { return ''; }
  }
  function setTitle(main) {
    // A document's name, not its file's: no ".pdf".
    head.querySelector('.zp-title b').textContent = (main || fileName).replace(/\.pdf$/i, '');
    var lib = '';
    try { var z = shell && shell._zimInfo(zim); lib = z && z.title || ''; } catch (e) {}
    head.querySelector('.zp-title span').textContent = lib;
  }
  var st = shellTitle();
  setTitle(st && st !== 'Zimi' ? st : fileName);
  syncTheme();
  if (shell) {
    try { new shell.MutationObserver(syncTheme).observe(shell.document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); } catch (e) {}
  }

  // ── pdf.js: its options before it starts, its bus once it has ──
  var app = null, bus = null, container = null;
  var page = 1, pages = 0, preset = '';
  function onViewerLoaded(e) {
    if (!e.detail || e.detail.source !== window) return;
    try { if (shell) shell.document.removeEventListener('webviewerloaded', onViewerLoaded); } catch (err) {}
    var O = window.PDFViewerApplicationOptions;
    if (O) {
      O.set('disablePreferences', true);   // these, not ones pdf.js kept from before
      O.set('viewOnLoad', 1);             // Zimi resumes the place, not pdf.js's own history
      O.set('sidebarViewOnLoad', 0);       // its sidebar never opens; the pages sheet is ours
      O.set('disableHistory', true);       // its hash steps would be the shell's Back
      O.set('annotationEditorMode', -1);   // reading, not marking up
      var th = shellTheme();
      if (th) O.set('viewerCssTheme', th === 'dark' ? 2 : 1);
    }
    app = window.PDFViewerApplication;
    if (app) app.initializedPromise.then(wire);
  }
  document.addEventListener('webviewerloaded', onViewerLoaded);
  try { if (shell) shell.document.addEventListener('webviewerloaded', onViewerLoaded); } catch (e) {}
  window.addEventListener('pagehide', function () { try { if (shell) shell.document.removeEventListener('webviewerloaded', onViewerLoaded); } catch (e) {} });

  function wire() {
    bus = app.eventBus;
    container = document.getElementById('viewerContainer');
    bus.on('pagesinit', function () {
      pages = app.pagesCount;
      foot.hidden = false;
      foot.classList.toggle('zp-one', pages < 2);
      scrub.max = String(Math.max(1, pages));
      measureFoot();
      resume();
      paint();
    });
    bus.on('pagechanging', function (e) { page = e.pageNumber; paint(); saveSoon(); });
    bus.on('scalechanging', function (e) { preset = e.presetValue || ''; paintFit(); });
    bus.on('updatefindmatchescount', function (e) { paintCount(e.matchesCount, -1); });
    bus.on('updatefindcontrolstate', function (e) { paintCount(e.matchesCount, e.state); });
    bus.on('metadataloaded', function () {
      var own = '';
      try { own = (app._title || '').trim(); } catch (e) {}
      // The shell's name for it (a catalog's) wins over the file's own.
      var s = shellTitle();
      if (!s || s === 'Zimi' || s === fileName) setTitle(own || fileName);
    });
    watchLoad(0);
    container.addEventListener('scroll', onScroll, { passive: true });
    ['wheel', 'touchmove', 'pointerdown'].forEach(function (ev) { container.addEventListener(ev, byHand, { passive: true }); });
    window.addEventListener('keydown', byHand, true);
    // pdf.js opens a document with its first page's top at the top of the
    // view, under the head: the room above it is there to be seen.
    var opened = false;
    bus.on('updateviewarea', function () {
      if (opened || !pages) return;
      opened = true;
      if (page === 1 && container.scrollTop <= head.offsetHeight + 8) container.scrollTop = 0;
    });
    container.addEventListener('click', onTap);
    container.addEventListener('touchstart', function (e) { if (e.touches.length > 1) pinchAt = Date.now(); }, { passive: true });
    container.addEventListener('touchmove', function (e) { if (e.touches.length > 1) pinchAt = Date.now(); }, { passive: true });
  }
  // A document that will not open says so, in Zimi's voice.
  function watchLoad(n) {
    var task = app.pdfLoadingTask;
    if (!task) { if (n < LOAD_WAIT_TRIES) setTimeout(function () { watchLoad(n + 1); }, LOAD_WAIT_MS); return; }
    task.promise.catch(function () {
      var m = document.createElement('div');
      m.className = 'zp-msg';
      m.textContent = t('pdf_failed');
      ui.appendChild(m);
      showBars(true);
    });
  }

  // ── where you are ──
  function paint() {
    pageBtn.innerHTML = esc(t('n_of_total', { n: '\u0000', total: num(pages) })).replace('\u0000', '<b>' + num(page) + '</b>');
    if (!scrubbing) scrub.value = String(page);
    scrub.setAttribute('aria-valuetext', t('n_of_total', { n: num(page), total: num(pages) }));
    if (openPanel === sheet) markSheetPage();
  }
  // The foot's height, for the room below the last page.
  function measureFoot() { html.style.setProperty('--zp-foot', foot.getBoundingClientRect().height + 'px'); }
  window.addEventListener('resize', function () { if (!foot.hidden) measureFoot(); });
  // Going to a page with the bars up: its top just under the head, not behind it.
  function goPage(n) {
    n = Math.max(1, Math.min(pages, n | 0));
    if (!app || !pages) return;
    app.page = n;
    if (barsShown()) requestAnimationFrame(function () { container.scrollTop = Math.max(0, container.scrollTop - head.offsetHeight + 4); });
  }
  var scrubbing = false;
  scrub.addEventListener('input', function () {
    scrubbing = true;
    pageBtn.innerHTML = esc(t('n_of_total', { n: '\u0000', total: num(pages) })).replace('\u0000', '<b>' + num(Number(scrub.value)) + '</b>');
  });
  scrub.addEventListener('change', function () { scrubbing = false; goPage(Number(scrub.value)); });
  // The page, typed: a tap on "4 of 12" asks for a number.
  pageBtn.addEventListener('click', function () {
    if (!pages) return;
    var box = pageBtn.parentNode, inp = document.createElement('input');
    inp.className = 'zp-page-input';
    inp.type = 'text'; inp.inputMode = 'numeric'; inp.enterKeyHint = 'go';
    inp.value = String(page);
    inp.setAttribute('aria-label', t('pdf_page'));
    pageBtn.hidden = true;
    box.appendChild(inp);
    inp.focus(); inp.select();
    var done = function (go) {
      if (!inp.parentNode) return;
      var n = parseInt(inp.value.replace(/[^\d]/g, ''), 10);
      inp.remove(); pageBtn.hidden = false;
      if (go && n) goPage(n);
    };
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); done(true); pageBtn.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); pageBtn.focus(); }
    });
    inp.addEventListener('blur', function () { done(true); });
  });

  // ── how it fits: width or the whole page, pinch, and on a wide screen − / + ──
  var fitBtn = $('.zp-fit');
  function paintFit() {
    // The button says what a press will do.
    var toPage = preset !== FIT_PAGE;
    fitBtn.innerHTML = toPage ? I.page : I.width;
    var label = t(toPage ? 'pdf_fit_page' : 'pdf_fit_width');
    fitBtn.setAttribute('aria-label', label); fitBtn.title = label;
  }
  fitBtn.addEventListener('click', function () {
    if (!app) return;
    app.pdfViewer.currentScaleValue = preset === FIT_PAGE ? FIT_WIDTH : FIT_PAGE;
  });
  $('.zp-in').addEventListener('click', function () { if (app) app.pdfViewer.increaseScale(); });
  $('.zp-out').addEventListener('click', function () { if (app) app.pdfViewer.decreaseScale(); });

  // ── keeping the place ──
  var savedRef = null, known = 0, saveTimer = null;
  function ref() {
    if (savedRef) return savedRef;
    try { if (shell && zim) savedRef = shell._savedRefOnScreen(); } catch (e) { savedRef = null; }
    // The shell is on another page already: this document's own record.
    if (savedRef && (savedRef.zim !== zim || savedRef.path !== path)) savedRef = null;
    return savedRef;
  }
  function resume() {
    if (/(^|[#&])page=/.test(location.hash)) return;  // the address names a page
    var p = 0, r = ref();
    try {
      if (r) { var pos = shell.Saved.position(r); p = pos && pos.where && pos.where.p || 0; }
      else p = parseInt(store(POS_KEY + file) || '0', 10);
    } catch (e) { p = 0; }
    known = p || 1;
    if (p > 1 && p <= pages) { page = p; app.page = p; }
  }
  function save() {
    saveTimer = null;
    if (!pages || page === known) return;
    known = page;
    var r = ref();
    var where = { p: page, f: pages > 1 ? Math.round((page - 1) / (pages - 1) * 1000) / 1000 : 1 };
    try { if (r) shell.Saved.setPosition(r, where); else store(POS_KEY + file, String(page)); } catch (e) {}
  }
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, SAVE_MS); }
  window.addEventListener('pagehide', function () { if (saveTimer) { clearTimeout(saveTimer); save(); } });

  // ── the bars come and go ──
  // Only a scroll you make moves the bars: pdf.js's own (opening, a jump
  // to a page, a match found) leaves them as they are.
  var lastY = 0, pinchAt = 0, handAt = 0, HAND_MS = 1000;
  function byHand() { handAt = Date.now(); }
  function barsShown() { return !html.classList.contains('zp-away'); }
  function showBars(on) {
    if (!on && (html.classList.contains('zp-finding') || openPanel)) return;
    html.classList.toggle('zp-away', !on);
  }
  function onScroll() {
    var y = container.scrollTop;
    if (Date.now() - handAt > HAND_MS) { lastY = y; return; }
    var end = container.scrollHeight - container.clientHeight - 2;
    if (y < BARS_HIDE || y >= end) { showBars(true); lastY = y; return; }
    if (y - lastY > BARS_HIDE) { showBars(false); lastY = y; }
    else if (lastY - y > BARS_HIDE) { showBars(true); lastY = y; }
  }
  function onTap(e) {
    if (Date.now() - pinchAt < PINCH_TAP_MS) return;
    if (e.target.closest && e.target.closest('a,button,input,select,textarea,.annotationLayer section')) return;
    var sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && String(sel).trim()) return;
    showBars(!barsShown());
  }

  // ── back ──
  $('.zp-back').addEventListener('click', function () {
    try { if (shell && typeof shell.goBack === 'function') { shell.goBack(); return; } } catch (e) {}
    history.back();
  });

  // ── find: pdf.js's, asked through its bus ──
  var findTimer = null, lastMatch = 0;
  function find(type, previous) {
    if (!bus) return;
    var q = findInput.value;
    if (!q) { count.textContent = ''; count.classList.remove('zp-none'); }
    bus.dispatch('find', { source: window, type: type, query: q, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: !!previous, matchDiacritics: false });
  }
  function paintCount(mc, state) {
    if (!findInput.value) { count.textContent = ''; return; }
    var none = state === FIND_NOT_FOUND;
    count.classList.toggle('zp-none', !!none);
    if (none) count.textContent = t('find_none');
    else if (mc && mc.total) count.textContent = t('n_of_total', { n: num(mc.current), total: num(mc.total) });
    // A new match chosen (the first, or a step): brought clear of the head.
    if (!none && mc && mc.total && (mc.current !== lastMatch || state !== -1)) { lastMatch = mc.current; clearOfHead(); }
  }
  // pdf.js puts a match 50px from the top, which is under the head: a little
  // lower, where it can be read.
  // The mark is drawn when the page's text is, a moment after the jump: it
  // is looked for each frame for a while.
  var MARK_WAIT_FRAMES = 90, markWait = 0;
  function clearOfHead() {
    var mine = ++markWait, frames = 0;
    var look = function () {
      if (mine !== markWait || !container) return;
      var m = document.querySelector('.textLayer .highlight.selected');
      if (!m) { if (++frames < MARK_WAIT_FRAMES) requestAnimationFrame(look); return; }
      var under = head.getBoundingClientRect().bottom + 24 - m.getBoundingClientRect().top;
      if (under > 0) container.scrollTop -= under;
    };
    requestAnimationFrame(look);
  }
  function openFind() {
    closePanel();
    html.classList.add('zp-finding');
    showBars(true);
    findInput.focus();
    findInput.select();
    if (findInput.value) find('again');
  }
  function closeFind() {
    if (!html.classList.contains('zp-finding')) return;
    html.classList.remove('zp-finding');
    if (bus) bus.dispatch('findbarclose', { source: window });
    $('.zp-find-btn').focus();
  }
  $('.zp-find-btn').addEventListener('click', openFind);
  $('.zp-find-close').addEventListener('click', closeFind);
  $('.zp-find-next').addEventListener('click', function () { find('again', false); });
  $('.zp-find-prev').addEventListener('click', function () { find('again', true); });
  findInput.addEventListener('input', function () { clearTimeout(findTimer); findTimer = setTimeout(function () { find(''); }, 150); });
  findInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(findTimer); find(findTimer && !count.textContent ? '' : 'again', e.shiftKey); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
  });

  // ── the sheet (contents, pages) and the menu ──
  var openPanel = null, opener = null;
  function openAs(panel, from) {
    closePanel();
    openPanel = panel; opener = from || null;
    panel.classList.add('zp-open');
    html.classList.add(panel === menu ? 'zp-menu-open' : 'zp-sheet-open');
    if (panel === menu) $('.zp-more').setAttribute('aria-expanded', 'true');
    showBars(true);
  }
  function closePanel(refocus) {
    if (!openPanel) return;
    openPanel.classList.remove('zp-open');
    html.classList.remove('zp-menu-open', 'zp-sheet-open');
    $('.zp-more').setAttribute('aria-expanded', 'false');
    var back = opener;
    openPanel = null; opener = null;
    stopThumbs();
    if (refocus && back) back.focus();
  }
  $('.zp-scrim').addEventListener('click', function () { closePanel(true); });

  // The menu: the document kept, its pages dark, a copy, on paper.
  function savedNow() { try { var r = ref(); return !!(r && shell.Saved.has(r)); } catch (e) { return false; } }
  function renderMenu() {
    var h = '';
    if (ref()) {
      var on = savedNow();
      h += '<button type="button" role="menuitem" data-zp="save" aria-pressed="' + on + '">' + I.mark + '<span class="zp-grow">' + esc(t(on ? 'saved' : 'save')) + '</span></button>';
    }
    h += '<button type="button" role="menuitemcheckbox" data-zp="dark" aria-checked="' + darkWanted() + '">' + I.moon + '<span class="zp-grow">' + esc(t('pdf_dark_pages')) + '</span><span class="zp-switch" aria-hidden="true"></span></button>' +
      '<hr>' +
      '<button type="button" role="menuitem" data-zp="download">' + I.dl + '<span class="zp-grow">' + esc(t('download')) + '</span></button>' +
      '<button type="button" role="menuitem" data-zp="print">' + I.print + '<span class="zp-grow">' + esc(t('pdf_print')) + '</span></button>';
    menu.innerHTML = h;
  }
  $('.zp-more').addEventListener('click', function (e) {
    if (openPanel === menu) { closePanel(true); return; }
    renderMenu();
    openAs(menu, e.currentTarget);
    var first = menu.querySelector('button');
    if (first) first.focus({ preventScroll: true });
  });
  menu.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-zp]');
    if (!b) return;
    var what = b.getAttribute('data-zp');
    if (what === 'dark') {
      store(DARK_KEY, darkWanted() ? '0' : '1');
      paintDark();
      return;   // a switch: the menu stays, showing it
    }
    closePanel(true);
    if (what === 'save') {
      try { shell.toggleBookmark(); if (shell._updateLibraryBtnIcon) shell._updateLibraryBtnIcon(); } catch (err) {}
    } else if (what === 'download' && app) app.downloadOrSave();
    else if (what === 'print' && app) app.triggerPrinting();
  });
  menu.addEventListener('keydown', function (e) {
    var items = Array.prototype.slice.call(menu.querySelectorAll('button'));
    var i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
  });

  // Contents (the PDF's outline, when it has one) and its pages.
  var outline = null, view = 'toc';
  function tocHtml(items) {
    return '<ul class="zp-toc">' + items.map(function (it, i) {
      return '<li data-i="' + i + '"><button type="button">' + esc(it.title || '') + '</button>' + (it.items && it.items.length ? tocHtml(it.items) : '') + '</li>';
    }).join('') + '</ul>';
  }
  function renderSheet() {
    var hasToc = outline && outline.length;
    if (!hasToc) view = 'pages';
    var head = '<div class="zp-sheet-head">' + (hasToc
      ? '<div class="zp-seg" role="tablist">' +
          '<button type="button" role="tab" data-v="toc" aria-selected="' + (view === 'toc') + '">' + esc(t('books_contents')) + '</button>' +
          '<button type="button" role="tab" data-v="pages" aria-selected="' + (view === 'pages') + '">' + esc(t('books_mode_pages')) + '</button></div>'
      : '<b>' + esc(t('books_mode_pages')) + '</b>') +
      '<button type="button" class="zp-x" aria-label="' + esc(t('close')) + '">×</button></div>';
    var body = view === 'toc' ? tocHtml(outline) : '<div class="zp-thumbs">' + Array.apply(null, Array(pages)).map(function (_, i) {
      return '<button type="button" class="zp-thumb" data-p="' + (i + 1) + '"><span class="zp-sheetpage"></span>' + num(i + 1) + '</button>';
    }).join('') + '</div>';
    sheet.innerHTML = head + body;
    markSheetPage();
    if (view === 'pages') startThumbs();
  }
  // The page or the chapter you are on, marked in the sheet: the last
  // chapter that starts at or before the page.
  function markSheetPage() {
    var on = sheet.querySelector('[aria-current="true"]');
    if (on) on.removeAttribute('aria-current');
    if (view === 'toc') {
      var k = -1;
      (outline || []).forEach(function (it, i) { if (it._p && it._p <= page) k = i; });
      var li = k >= 0 ? sheet.querySelector('.zp-toc > li[data-i="' + k + '"]') : null;
      if (li) li.setAttribute('aria-current', 'true');
      return li ? li.querySelector('button') : null;
    }
    var b = sheet.querySelector('.zp-thumb[data-p="' + page + '"]');
    if (b) b.setAttribute('aria-current', 'true');
    return b;
  }
  // Each chapter's first page, from its destination.
  function outlinePages(items) {
    var doc = app.pdfDocument;
    return Promise.all(items.map(function (it) {
      if (!it.dest) return null;
      return (typeof it.dest === 'string' ? doc.getDestination(it.dest) : Promise.resolve(it.dest)).then(function (d) {
        var ref = d && d[0];
        if (typeof ref === 'number') return ref + 1;
        return ref ? doc.getPageIndex(ref).then(function (i) { return i + 1; }) : null;
      }).then(function (p) { it._p = p; }, function () {});
    }));
  }
  function outlineItem(li) {
    var path = [], n = li;
    while (n && n !== sheet) { if (n.tagName === 'LI') path.unshift(Number(n.getAttribute('data-i'))); n = n.parentNode; }
    var items = outline, it = null;
    path.forEach(function (i) { it = items[i]; items = it && it.items || []; });
    return it;
  }
  function openSheet(from) {
    var go = function () {
      renderSheet();
      openAs(sheet, from);
      var focus = markSheetPage() || sheet.querySelector('.zp-toc button');
      if (focus) { focus.scrollIntoView({ block: 'center' }); focus.focus({ preventScroll: true }); }
    };
    if (outline !== null || !app || !app.pdfDocument) { go(); return; }
    app.pdfDocument.getOutline().then(function (o) {
      outline = o || [];
      return outlinePages(outline);
    }).then(go, function () { outline = outline || []; go(); });
  }
  $('.zp-toc-btn').addEventListener('click', function (e) {
    if (openPanel === sheet) { closePanel(true); return; }
    openSheet(e.currentTarget);
  });
  sheet.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.classList.contains('zp-x')) { closePanel(true); return; }
    if (b.hasAttribute('data-v')) { view = b.getAttribute('data-v'); renderSheet(); return; }
    if (b.hasAttribute('data-p')) { closePanel(); goPage(Number(b.getAttribute('data-p'))); showBars(false); return; }
    var li = b.closest('li[data-i]'), it = li && outlineItem(li);
    // An entry that points at the web, not into the document, goes nowhere.
    if (it && it.dest && app) { closePanel(); app.pdfLinkService.goToDestination(it.dest); showBars(false); }
  });
  // A page drawn small once it is in view in the sheet, never before.
  var thumbObs = null;
  function startThumbs() {
    if (!app || !app.pdfDocument || !('IntersectionObserver' in window)) return;
    thumbObs = new IntersectionObserver(function (ents) {
      ents.forEach(function (en) {
        if (!en.isIntersecting) return;
        thumbObs.unobserve(en.target);
        drawThumb(en.target, Number(en.target.getAttribute('data-p')));
      });
    }, { root: sheet, rootMargin: '200px' });
    sheet.querySelectorAll('.zp-thumb').forEach(function (b) { thumbObs.observe(b); });
  }
  function stopThumbs() { if (thumbObs) { thumbObs.disconnect(); thumbObs = null; } }
  function drawThumb(btn, n) {
    app.pdfDocument.getPage(n).then(function (pg) {
      var v1 = pg.getViewport({ scale: 1 });
      var vp = pg.getViewport({ scale: THUMB_PX / v1.width });
      var c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      var box = btn.querySelector('.zp-sheetpage');
      box.style.setProperty('--zp-ratio', String(v1.width / v1.height));
      box.appendChild(c);
      pg.render({ canvasContext: c.getContext('2d'), viewport: vp });
    }, function () {});
  }

  // ── keys: find with Ctrl/Cmd+F or /, Escape closes what is open ──
  window.addEventListener('keydown', function (e) {
    var typing = e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault(); e.stopImmediatePropagation(); openFind(); return;
    }
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopImmediatePropagation(); openFind(); return; }
    if (e.key === 'Escape') {
      if (openPanel) { e.preventDefault(); e.stopImmediatePropagation(); closePanel(true); }
      else if (html.classList.contains('zp-finding')) { e.preventDefault(); e.stopImmediatePropagation(); closeFind(); }
    }
  }, true);

  // For the shell and the tests: where the reader is.
  window.zimiPdf = {
    page: function () { return page; }, pages: function () { return pages; },
    goPage: goPage, barsShown: barsShown, showBars: showBars
  };
})();
