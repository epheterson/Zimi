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
  // Share of the width at either side where a tap turns the page: a quarter,
  // leaving the middle half to show or hide the bars (Eric, 2026-10-05: "do we
  // have the side taps tuned right so tapping center easily brings controls?").
  // A PDF's page fills a phone's width; the book reader's 0.3 left the bars
  // 40% of it.
  var TAP_EDGE = 0.25;
  var PINCH_TAP_MS = 400;      // ms after a pinch in which a tap is the pinch's own
  var THUMB_PX = 200;          // px wide a page is drawn for the pages sheet (two device pixels a column)
  var LOAD_WAIT_MS = 50, LOAD_WAIT_TRIES = 200;
  var DARK_KEY = 'zimi_pdf_dark';          // '1' / '0': chosen here; absent: follow the articles
  var POS_KEY = 'zimi_pdf_pos:';           // + the file: the page, outside the shell
  var SPREAD_KEY = 'zimi_pdf_spread';      // '1' / '2' pages side by side, chosen; absent: by the shape
  var VIEW_KEY = 'zimi_pdf_view';          // 'pages' (a page at a time, swiped) / 'scroll'; absent: by the width
  var ROT_KEY = 'zimi_pdf_rot:';           // + the file: its pages turned, 0 / 90 / 180 / 270
  var REACH_MS = 4000;         // ms a page brought in for a highlight has to draw its text
  var SPREAD_MIN_PX = 1000;    // px of window wide enough for two pages side by side
  var RESIZE_MS = 150;
  var SHOW_AT = 1 / 3;         // a highlight opened from Saved lands a third of the way down
  var TOKENS = ['--bg', '--surface', '--surface2', '--border', '--text', '--text2', '--amber', '--amber-glow', '--on-amber'];
  var FIT_WIDTH = 'page-width', FIT_PAGE = 'page-fit';
  var SCROLL_VERTICAL = 0, SCROLL_PAGE = 3;  // pdf.js ScrollMode
  var SWIPE_PX = 50;           // px a finger travels sideways to turn the page
  var SWIPE_SLANT = 1.5;       // sideways at least this many times more than up or down
  var FIND_NOT_FOUND = 1;      // pdf.js FindState.NOT_FOUND
  var SPREAD_ODD = 1, SPREAD_EVEN = 2;     // pdf.js SpreadMode: pages side by side from the first, or after it

  var html = document.documentElement;
  // The shell around the viewer (same origin), when there is one.
  var shell = null;
  try { if (window.parent !== window && window.parent.Saved) shell = window.parent; } catch (e) { shell = null; }

  // ── words: the shell's, in its language; English on its own ──
  var EN = {
    go_back: 'Go back', more_actions: 'More actions', find_in_page: 'Find in page', find_none: 'No matches',
    find_prev: 'Previous match', find_next: 'Next match', pdf_prev_page: 'Previous page', pdf_next_page: 'Next page', close: 'Close', n_of_total: '{n} of {total}',
    books_contents: 'Contents', books_mode_pages: 'Pages', download: 'Download', save: 'Save', saved: 'Saved',
    pdf_print: 'Print', pdf_fit_width: 'Fit width', pdf_fit_page: 'Fit page', pdf_zoom_in: 'Zoom in',
    pdf_first_page: 'First page', pdf_last_page: 'Last page', pdf_page_by_page: 'Page by page', pdf_scroll: 'Scroll',
    pdf_zoom_out: 'Zoom out', pdf_dark_pages: 'Dark pages', pdf_single_page: 'Single page', pdf_two_pages: 'Two pages', pdf_rotate: 'Rotate',
    pdf_about: 'About this PDF', pdf_keywords: 'Keywords', pdf_created: 'Created', pdf_modified: 'Modified',
    pdf_application: 'Application', pdf_producer: 'PDF producer', pdf_version: 'PDF version', pdf_page_size: 'Page size',
    pdf_library: 'Library', books_author: 'Author', books_subject: 'Subject', zi_size: 'Size', zi_file: 'File', pdf_page: 'Page', pdf_failed: 'This PDF could not be opened.'
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
  // The shell's language (its <html lang>), for numbers and dates.
  var lang;
  try { lang = shell && shell.document.documentElement.lang || undefined; } catch (e) { lang = undefined; }
  var fmt = null;
  try { fmt = new Intl.NumberFormat(lang); } catch (e) { fmt = null; }
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
  // The screen's safe-area insets: a framed page is told none (env() is 0
  // in a frame), so the shell's, measured where it can see them; outside a
  // shell the stylesheet's env() stands.
  var INSETS = { t: '--zp-sat', r: '--zp-sar', b: '--zp-sab', l: '--zp-sal' };
  function syncInsets() {
    var i = null;
    try { i = shell && shell._safeInsets(); } catch (e) { i = null; }
    if (!i) return;
    for (var k in INSETS) html.style.setProperty(INSETS[k], (i[k] || 0) + 'px');
    if (!foot.hidden) measureFoot();
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
    next: svg('<path d="M9 5l7 7-7 7"/>'),
    find: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>'),
    more: svg('<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>'),
    toc: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".6" fill="currentColor"/><circle cx="4.5" cy="12" r=".6" fill="currentColor"/><circle cx="4.5" cy="18" r=".6" fill="currentColor"/>'),
    width: svg('<path d="M4 5v14M20 5v14"/><path d="M8 12h8M10.5 9.5L8 12l2.5 2.5M13.5 9.5L16 12l-2.5 2.5"/>'),
    page: svg('<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><rect x="8.5" y="7" width="7" height="10" rx="1"/>'),
    zin: svg('<path d="M12 5v14M5 12h14"/>'),
    zout: svg('<path d="M5 12h14"/>'),
    up: svg('<path d="M6 15l6-6 6 6"/>'),
    first: svg('<path d="M6 5v14M18 5l-7 7 7 7"/>'),
    last: svg('<path d="M18 5v14M6 5l7 7-7 7"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    scroll: svg('<rect x="6" y="2" width="12" height="8" rx="1"/><rect x="6" y="14" width="12" height="8" rx="1"/>'),
    down: svg('<path d="M6 9l6 6 6-6"/>'),
    mark: svg('<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>'),
    moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
    dl: svg('<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>'),
    print: svg('<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r=".6" fill="currentColor"/>'),
    rotate: svg('<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>'),
    one: svg('<rect x="7" y="4" width="10" height="16" rx="1.5"/>'),
    two: svg('<rect x="2.5" y="5" width="8.5" height="14" rx="1.5"/><rect x="13" y="5" width="8.5" height="14" rx="1.5"/>')
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
      (zim ? '<img class="zp-zimicon zp-hide-finding" alt="" width="22" height="22" src="/w/' + encodeURIComponent(zim) + '/-/icon">' : '') +
      '<div class="zp-title"><b></b><span></span></div>' +
      '<div class="zp-find" role="search">' +
        iconBtn('zp-find-close', I.close, t('close')) +
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
        iconBtn('zp-first zp-flip', I.first, t('pdf_first_page'), ' aria-keyshortcuts="Home"') +
        iconBtn('zp-prev zp-flip', I.back, t('pdf_prev_page'), ' aria-keyshortcuts="ArrowLeft PageUp"') +
        '<div class="zp-pagebox"><button type="button" class="zp-page" aria-label="' + esc(t('pdf_page')) + '"></button></div>' +
        iconBtn('zp-next zp-flip', I.next, t('pdf_next_page'), ' aria-keyshortcuts="ArrowRight PageDown"') +
        iconBtn('zp-last zp-flip', I.last, t('pdf_last_page'), ' aria-keyshortcuts="End"') +
        iconBtn('zp-zoom zp-in', I.zin, t('pdf_zoom_in')) +
        iconBtn('zp-fit', I.page, t('pdf_page_by_page')) +
      '</div>' +
    '</div>' +
    '<div class="zp-scrim"></div>' +
    '<div class="zp-sheet" role="dialog" aria-label="' + esc(t('books_contents')) + '"></div>' +
    '<div class="zp-menu" role="menu"></div>';
  document.body.appendChild(ui);
  // A library without an icon of its own: no broken picture by its name.
  var zimIcon = ui.querySelector('.zp-zimicon');
  if (zimIcon) zimIcon.addEventListener('error', function () { zimIcon.remove(); });
  var $ = function (s) { return ui.querySelector(s); };
  var head = $('.zp-head'), foot = $('.zp-foot'), scrub = $('.zp-scrub'), pageBtn = $('.zp-page');
  var prevBtn = $('.zp-prev'), nextBtn = $('.zp-next'), firstBtn = $('.zp-first'), lastBtn = $('.zp-last');
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
  syncInsets();
  if (shell) {
    // A turn of the phone moves the notch, and the shell's viewport-fit
    // taking effect arrives as its resize too.
    try {
      shell.addEventListener('resize', syncInsets);
      window.addEventListener('pagehide', function () { shell.removeEventListener('resize', syncInsets); });
    } catch (e) {}
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
      turnAsKept();
      applySpread();
      applyView();
      resume();
      pagePicker();
      paint();
      highlightsOn();
    });
    // A page's text drawn (opened, scrolled to, zoomed, turned): its
    // highlights painted on it, once a frame however many pages drew.
    bus.on('textlayerrendered', function (e) {
      if (e && e.error) return;
      drawn[e.pageNumber] = true;
      reached.forEach(function (w) { if (w.p === e.pageNumber) w.done(); });
      if (!hlFrame) hlFrame = requestAnimationFrame(function () { hlFrame = 0; if (hl) hl.refresh(); });
    });
    bus.on('spreadmodechanged', function () { paint(); menuAgain(); });
    // Turned (here, or by pdf.js's R key): kept for this document, and a
    // page now wider than tall may want one at a time.
    bus.on('rotationchanging', function (e) {
      store(ROT_KEY + file, String(e.pagesRotation || 0));
      applySpread();
    });
    bus.on('pagechanging', function (e) {
      page = e.pageNumber; paint(); saveSoon();
      // A page at a time has nothing to scroll: a page turned by hand is the
      // reading that puts the bars away.
      if (pageByPage() && Date.now() - handAt < HAND_MS) showBars(false);
    });
    bus.on('scalechanging', function (e) { preset = e.presetValue || ''; });
    bus.on('updatefindmatchescount', function (e) { paintCount(e.matchesCount, -1); });
    bus.on('updatefindcontrolstate', function (e) { paintCount(e.matchesCount, e.state); });
    bus.on('metadataloaded', function () {
      var own = '';
      // The document's own title (pdf.js's _title is "title - file name").
      try { own = (app._docTitle || app._title || '').trim(); } catch (e) {}
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
    container.addEventListener('touchstart', swipeStart, { passive: true });
    container.addEventListener('touchend', swipeEnd, { passive: true });
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
    prevBtn.disabled = firstBtn.disabled = !stepTo(-1);
    nextBtn.disabled = lastBtn.disabled = !stepTo(1);
    if (pagePick && pagePick.value !== String(page)) pagePick.value = String(page);
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
    // pdf.js learns where the view is only on its next frame (update(), on
    // scroll); until then a re-scale (a resize, its own initial view) puts
    // back the page it last saw. Told now, so a jump (a highlight opened from
    // Saved) wins over the remembered place instead of racing it.
    try { app.pdfViewer.update(); } catch (e) {}
    if (barsShown()) requestAnimationFrame(function () { container.scrollTop = Math.max(0, container.scrollTop - head.offsetHeight + 4); });
  }
  // A step back or on: the page before or after, or in two pages side by
  // side the spread before or after. 0 at either end.
  function rowStart(p) {
    var m = app && app.pdfViewer ? app.pdfViewer.spreadMode : 0;
    if (m === SPREAD_ODD) return p - (p - 1) % 2;
    if (m === SPREAD_EVEN) return p < 2 ? 1 : p - p % 2;
    return p;
  }
  function stepTo(d) {
    if (!pages) return 0;
    var s = rowStart(page);
    if (d < 0) return s > 1 ? rowStart(s - 1) : 0;
    for (var p = page + 1; p <= pages; p++) if (rowStart(p) !== s) return p;
    return 0;
  }
  function step(d) { var n = stepTo(d); if (n) goPage(n); }
  prevBtn.addEventListener('click', function () { step(-1); });
  firstBtn.addEventListener('click', function () { goPage(1); });
  lastBtn.addEventListener('click', function () { goPage(pages); });
  nextBtn.addEventListener('click', function () { step(1); });
  // ── two pages side by side: on a wide window when the pages are taller
  // than wide (a book, a paper), unless one or two was chosen in the menu.
  // One choice for every document: the way this reader likes to read.
  function wide() { return !!container && container.clientWidth >= SPREAD_MIN_PX; }
  function portrait() {
    var pv = null;
    try { pv = app.pdfViewer.getPageView(0); } catch (e) { pv = null; }
    var vp = pv && pv.viewport;
    return !vp || vp.height > vp.width;
  }
  function spreadWanted() {
    if (!wide() || pages < 2) return false;
    var v = store(SPREAD_KEY);
    return v === '1' || v === '2' ? v === '2' : portrait();
  }
  function applySpread() {
    if (!app || !pages) return;
    var m = spreadWanted() ? SPREAD_ODD : 0;
    if (app.pdfViewer.spreadMode !== m) app.pdfViewer.spreadMode = m;
  }
  function setSpread(two) { store(SPREAD_KEY, two ? '2' : '1'); applySpread(); }
  // ── turned: a sideways scan, a quarter turn at a time, kept per document ──
  function rotation() { return app && app.pdfViewer ? app.pdfViewer.pagesRotation || 0 : 0; }
  function turnAsKept() {
    var r = parseInt(store(ROT_KEY + file) || '0', 10);
    if (r && r % 90 === 0) app.pdfViewer.pagesRotation = ((r % 360) + 360) % 360;
  }
  function turn() { if (app && pages) app.pdfViewer.pagesRotation = (rotation() + 90) % 360; }
  var resizeTimer = null;
  window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(applySpread, RESIZE_MS); });
  var scrubbing = false;
  scrub.addEventListener('input', function () {
    scrubbing = true;
    pageBtn.innerHTML = esc(t('n_of_total', { n: '\u0000', total: num(pages) })).replace('\u0000', '<b>' + num(Number(scrub.value)) + '</b>');
  });
  scrub.addEventListener('change', function () { scrubbing = false; goPage(Number(scrub.value)); });
  // The page, typed: a tap on "4 of 12" asks for a number.
  // The page by number: a short document's pages as a list (the phone's own
  // picker), a long one's typed, the bar lifted over the keyboard.
  var PICK_MAX = 60;           // pages at most offered as a list
  var pagePick = null;
  function pagePicker() {
    if (pagePick) { pagePick.remove(); pagePick = null; }
    if (pages < 2 || pages > PICK_MAX) return;
    var h = '';
    for (var p = 1; p <= pages; p++) h += '<option value="' + p + '">' + esc(t('n_of_total', { n: num(p), total: num(pages) })) + '</option>';
    pagePick = document.createElement('select');
    pagePick.className = 'zp-page-pick';
    pagePick.setAttribute('aria-label', t('pdf_page'));
    pagePick.innerHTML = h;
    pagePick.value = String(page);
    pagePick.addEventListener('change', function () { goPage(Number(pagePick.value)); });
    pageBtn.parentNode.appendChild(pagePick);
    pageBtn.tabIndex = -1;
  }
  // How far the keyboard covers this frame's bottom edge. On an iPhone the
  // keyboard shrinks the SHELL's visual viewport, not the frame's: the
  // frame's own stayed full height, the lift came out 0 and the typed page
  // sat under the keys. Both are measured; the larger cover wins.
  function keyboardCover() {
    var own = window.visualViewport, cover = 0;
    if (own) cover = innerHeight - own.height - own.offsetTop;
    try {
      var top = shell && shell.visualViewport, el = window.frameElement;
      if (top && el) {
        var bottom = el.getBoundingClientRect().top + innerHeight;
        cover = Math.max(cover, bottom - (top.offsetTop + top.height));
      }
    } catch (e) {}
    return Math.max(0, Math.round(cover));
  }
  function viewports() {
    var out = [];
    if (window.visualViewport) out.push(window.visualViewport);
    try { if (shell && shell.visualViewport) out.push(shell.visualViewport); } catch (e) {}
    return out;
  }
  function liftOverKeyboard(on) {
    var lift = on ? keyboardCover() : 0;
    foot.style.transform = lift ? 'translateY(' + (-lift) + 'px)' : '';
  }
  pageBtn.addEventListener('click', function () {
    if (!pages || pagePick) return;
    var box = pageBtn.parentNode, inp = document.createElement('input');
    inp.className = 'zp-page-input';
    inp.type = 'text'; inp.inputMode = 'numeric'; inp.enterKeyHint = 'go';
    inp.value = String(page);
    inp.setAttribute('aria-label', t('pdf_page'));
    pageBtn.hidden = true;
    box.appendChild(inp);
    inp.focus(); inp.select();
    var lift = function () { liftOverKeyboard(true); };
    var vps = viewports();
    vps.forEach(function (vp) { vp.addEventListener('resize', lift); vp.addEventListener('scroll', lift); });
    lift();
    var done = function (go) {
      if (!inp.parentNode) return;
      vps.forEach(function (vp) { vp.removeEventListener('resize', lift); vp.removeEventListener('scroll', lift); });
      liftOverKeyboard(false);
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

  // ── how it reads: a page at a time, swiped, or one long scroll; pinch,
  // and on a wide screen − / + ──
  // Eric, 2026-10-02: "the page should fit and I'd like to be able to swipe".
  // On a phone a page's width and its whole are the same size, so a fit alone
  // changed nothing; a page at a time is the difference you can see.
  var fitBtn = $('.zp-fit');
  function pageByPage() {
    var v = store(VIEW_KEY);
    return v === 'pages' || v === 'scroll' ? v === 'pages' : !wide();
  }
  function applyView() {
    if (!app || !pages) return;
    var one = pageByPage();
    var m = one ? SCROLL_PAGE : SCROLL_VERTICAL;
    if (app.pdfViewer.scrollMode !== m) app.pdfViewer.scrollMode = m;
    html.classList.toggle('zp-pages', one);
    app.pdfViewer.currentScaleValue = one ? FIT_PAGE : FIT_WIDTH;
    paintFit();
  }
  function paintFit() {
    // The button says what a press will do.
    var one = pageByPage();
    fitBtn.innerHTML = one ? I.scroll : I.page;
    var label = t(one ? 'pdf_scroll' : 'pdf_page_by_page');
    fitBtn.setAttribute('aria-label', label); fitBtn.title = label;
  }
  paintFit();
  fitBtn.addEventListener('click', function () {
    store(VIEW_KEY, pageByPage() ? 'scroll' : 'pages');
    applyView();
  });
  // A page at a time turns with a sideways swipe, unless the page is zoomed
  // in past its fit (the finger is then moving around the page).
  var swipeX = 0, swipeY = 0, swipeOn = false;
  function zoomedIn() {
    try {
      var v = app.pdfViewer, pv = v.getPageView(v.currentPageNumber - 1);
      return pv.width > container.clientWidth + 1;
    } catch (e) { return false; }
  }
  function swipeStart(e) {
    swipeOn = e.touches.length === 1 && pageByPage() && !zoomedIn();
    if (swipeOn) { swipeX = e.touches[0].clientX; swipeY = e.touches[0].clientY; }
  }
  function swipeEnd(e) {
    if (!swipeOn || !e.changedTouches.length) return;
    swipeOn = false;
    var dx = e.changedTouches[0].clientX - swipeX, dy = e.changedTouches[0].clientY - swipeY;
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < SWIPE_SLANT * Math.abs(dy)) return;
    pinchAt = Date.now();   // the swipe's own touch is not a tap on the page
    // Toward the start of the line is on: left in English, right in Hebrew.
    byHand();
    step((dx < 0) === (uiDir() !== 'rtl') ? 1 : -1);
  }
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
    // A highlight opened from Saved goes to its own page: the kept place is
    // not put back first for pdf.js to return to.
    try { if (r && shell.Highlights.awaits(r)) return; } catch (e) {}
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
    if (e.defaultPrevented) return;   // a tap on a highlight: its bar, not the reader's
    if (Date.now() - pinchAt < PINCH_TAP_MS) return;
    if (e.target.closest && e.target.closest('a,button,input,select,textarea,.annotationLayer section')) return;
    var sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && String(sel).trim()) return;
    // A page at a time turns on a tap at either side, as a book's pages do in
    // the reader: the side you tap is the way it goes, mirrored right to left.
    if (pageByPage() && !zoomedIn() && container) {
      var box = container.getBoundingClientRect();
      var rel = box.width ? (e.clientX - box.left) / box.width : 0.5;
      var on = uiDir() !== 'rtl' ? 1 : -1;
      if (rel < TAP_EDGE) { byHand(); step(-on); return; }
      if (rel > 1 - TAP_EDGE) { byHand(); step(on); return; }
    }
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
    // One page or two: only where two fit.
    if (wide() && pages > 1) {
      var two = !!(app && app.pdfViewer.spreadMode);
      h += '<div role="group" class="zp-choice">' +
        '<button type="button" role="menuitemradio" data-zp="one" aria-checked="' + !two + '">' + I.one + '<span class="zp-grow">' + esc(t('pdf_single_page')) + '</span></button>' +
        '<button type="button" role="menuitemradio" data-zp="two" aria-checked="' + two + '">' + I.two + '<span class="zp-grow">' + esc(t('pdf_two_pages')) + '</span></button></div>';
    }
    // Width or the whole page: only where the two differ (on a phone a
    // page's width is its whole).
    var fp = preset === FIT_PAGE, fw = preset === FIT_WIDTH;
    if (wide()) h += '<div role="group" class="zp-choice">' +
      '<button type="button" role="menuitemradio" data-zp="fitw" aria-checked="' + fw + '">' + I.width + '<span class="zp-grow">' + esc(t('pdf_fit_width')) + '</span></button>' +
      '<button type="button" role="menuitemradio" data-zp="fitp" aria-checked="' + fp + '">' + I.page + '<span class="zp-grow">' + esc(t('pdf_fit_page')) + '</span></button></div>';
    h += '<button type="button" role="menuitem" data-zp="rotate">' + I.rotate + '<span class="zp-grow">' + esc(t('pdf_rotate')) + '</span></button>';
    h += '<button type="button" role="menuitemcheckbox" data-zp="dark" aria-checked="' + darkWanted() + '">' + I.moon + '<span class="zp-grow">' + esc(t('pdf_dark_pages')) + '</span><span class="zp-switch" aria-hidden="true"></span></button>' +
      '<hr>' +
      '<button type="button" role="menuitem" data-zp="download">' + I.dl + '<span class="zp-grow">' + esc(t('download')) + '</span></button>' +
      '<button type="button" role="menuitem" data-zp="print">' + I.print + '<span class="zp-grow">' + esc(t('pdf_print')) + '</span></button>' +
      '<hr>' +
      '<button type="button" role="menuitem" data-zp="about" aria-haspopup="dialog">' + I.info + '<span class="zp-grow">' + esc(t('pdf_about')) + '</span></button>';
    menu.innerHTML = h;
  }
  $('.zp-more').addEventListener('click', function (e) {
    if (openPanel === menu) { closePanel(true); return; }
    renderMenu();
    if (appleTouch()) readyFile();
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
    if (what === 'one' || what === 'two') {
      b.focus({ preventScroll: true });
      setSpread(what === 'two');
      menuAgain();
      return;   // a choice: the menu stays, showing it
    }
    if (what === 'rotate') { turn(); return; }   // the menu stays: a half turn is two presses
    if (what === 'fitw' || what === 'fitp') {
      b.focus({ preventScroll: true });
      if (app) app.pdfViewer.currentScaleValue = what === 'fitp' ? FIT_PAGE : FIT_WIDTH;
      menuAgain();
      return;   // a choice: the menu stays, showing it
    }
    closePanel(true);
    if (what === 'save') {
      try { shell.toggleBookmark(); if (shell._updateLibraryBtnIcon) shell._updateLibraryBtnIcon(); } catch (err) {}
    } else if (what === 'download' && app) app.downloadOrSave();
    else if (what === 'print') printRaw();
    else if (what === 'about') openAbout($('.zp-more'));
  });
  // ── print: the file itself, not pdf.js's drawing of it ──
  // pdf.js prints by drawing every page to an image first ("Preparing
  // document for printing"): slow, soft, and pointless when the file is a
  // PDF already. A computer's browser prints the raw file from a hidden
  // frame. An iPhone or iPad cannot print a frame's PDF: there the file goes
  // to the share sheet (Print is on it), or opens on its own, where the
  // system's viewer has Share and Print.
  var rawUrl = file ? file + (file.indexOf('?') < 0 ? '?' : '&') + 'raw=1' : '';
  var printFrame = null;
  function appleTouch() {
    return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function printRaw() {
    if (!rawUrl) { if (app) app.triggerPrinting(); return; }
    if (appleTouch()) { shareOrOpen(); return; }
    if (printFrame) printFrame.remove();
    printFrame = document.createElement('iframe');
    printFrame.className = 'zp-print-frame';
    printFrame.setAttribute('aria-hidden', 'true');
    printFrame.tabIndex = -1;
    printFrame.onload = function () {
      try { printFrame.contentWindow.focus(); printFrame.contentWindow.print(); }
      catch (e) { window.open(rawUrl, '_blank', 'noopener'); }
    };
    printFrame.src = rawUrl;
    document.body.appendChild(printFrame);
  }
  // The share sheet wants a file inside the tap, so the bytes pdf.js holds are
  // asked for as the menu opens and are ready by the time Print is pressed.
  var pdfFile = null;
  function readyFile() {
    if (pdfFile || !app || !app.pdfDocument || !window.File) return;
    app.pdfDocument.getData().then(function (bytes) {
      pdfFile = new File([bytes], (fileName || 'document') + '.pdf', { type: 'application/pdf' });
    }, function () {});
  }
  function shareOrOpen() {
    var data = pdfFile && { files: [pdfFile], title: fileName };
    if (data && navigator.canShare && navigator.canShare(data)) {
      navigator.share(data).catch(function (e) { if (!e || e.name !== 'AbortError') window.open(rawUrl, '_blank'); });
      return;
    }
    window.open(rawUrl, '_blank');
  }

  // The menu, open while what it shows changes (one page or two, after a
  // turn): drawn again, the focus where it was.
  function menuAgain() {
    if (openPanel !== menu) return;
    var at = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-zp');
    renderMenu();
    var b = at && menu.querySelector('[data-zp="' + at + '"]');
    if (b) b.focus({ preventScroll: true });
  }
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
    aboutOpen = false;
    sheet.setAttribute('aria-label', t('books_contents'));
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
    if (aboutOpen) return null;
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
    if (openPanel === sheet && !aboutOpen) { closePanel(true); return; }
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
  // ── highlights: Zimi's, as in an article or a book, not pdf.js's own
  // editors. Select text on a page and the shell's bar offers Highlight,
  // Note, Copy (and Define); kept in Saved with this document, synced as the
  // rest are, listed in the Saved panel. Each is found again on its own page
  // (pg) by what it says, in the text pdf.js draws over the page: so it
  // holds through zoom, a turn and two pages side by side, and is painted
  // as each page's text is drawn (pdf.js draws pages as they come near). ──
  var hl = null, hlFrame = 0, drawn = {}, reached = [];
  function textOfPage(n) {
    var el = n ? document.querySelector('#viewer .page[data-page-number="' + n + '"] .textLayer') : null;
    return el && drawn[n] && el.firstChild ? el : null;
  }
  function pageOfNode(n) {
    var el = n && (n.nodeType === 1 ? n : n.parentNode);
    var p = el && el.closest ? el.closest('.page[data-page-number]') : null;
    return p ? Number(p.getAttribute('data-page-number')) : 0;
  }
  function highlightsOn() {
    var r = ref();
    if (hl || !r || !shell || !shell.Highlights) return;
    hl = shell.Highlights.attach(document, r, {
      root: document.getElementById('viewer'),
      // A passage: the page it starts on. A highlight: its page, if drawn.
      scope: function (x) {
        if (x && x.startContainer) {
          var el = x.startContainer.nodeType === 1 ? x.startContainer : x.startContainer.parentNode;
          return el && el.closest ? el.closest('.textLayer') : null;
        }
        return x && x.pg ? textOfPage(x.pg) : document.getElementById('viewer');
      },
      fields: function (range) { var p = pageOfNode(range.startContainer); return p ? { pg: p } : null; },
      reach: reach,
      show: function (range) {
        var b = range.getBoundingClientRect();
        container.scrollTop += b.top - container.clientHeight * SHOW_AT;
        // Told at once, as goPage does: a re-scale before pdf.js's next frame
        // (a resize, its own initial view) would put back the page it last saw.
        try { app.pdfViewer.update(); } catch (e) {}
        showBars(false);
      }
    });
  }
  // A highlight on a page far from here: go to its page and wait for its text.
  function reach(h) {
    return new Promise(function (resolve) {
      if (!h.pg || h.pg > pages) { resolve(); return; }
      goPage(h.pg);
      if (textOfPage(h.pg)) { resolve(); return; }
      var w = { p: h.pg, done: null }, timer = setTimeout(function () { w.done(); }, REACH_MS);
      w.done = function () { clearTimeout(timer); reached = reached.filter(function (x) { return x !== w; }); resolve(); };
      reached.push(w);
    });
  }

  // ── about this PDF: what the file says of itself (its Info and XMP),
  // what it is (pages, size, version), and where it lives in Zimi. A field
  // the file leaves empty is left out, as About this ZIM leaves its own. ──
  var aboutOpen = false;
  // Paper sizes by name, in points (portrait); a size within 2pt is that size.
  var PAPER = [['A3', 842, 1191], ['A4', 595, 842], ['A5', 420, 595], ['Letter', 612, 792, 1], ['Legal', 612, 1008, 1], ['Tabloid', 792, 1224, 1]];
  var PT_MM = 25.4 / 72, PT_IN = 1 / 72, PAPER_SLACK = 2;
  function pageSize(view) {
    var w = Math.abs(view[2] - view[0]), h = Math.abs(view[3] - view[1]);
    var lo = Math.min(w, h), hi = Math.max(w, h), named = null;
    PAPER.forEach(function (p) { if (Math.abs(p[1] - lo) <= PAPER_SLACK && Math.abs(p[2] - hi) <= PAPER_SLACK) named = p; });
    var r = function (x, d) { return fmtN(Math.round(x * d) / d); };
    var dims = named && named[3] ? r(w * PT_IN, 10) + ' × ' + r(h * PT_IN, 10) + ' in' : r(w * PT_MM, 1) + ' × ' + r(h * PT_MM, 1) + ' mm';
    return named ? dims + ' (' + named[0] + ')' : dims;
  }
  function fmtN(n) { try { return new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(n); } catch (e) { return String(n); } }
  function pdfDate(s) {
    var d = null;
    try { d = s && window.pdfjsLib && pdfjsLib.PDFDateString.toDateObject(s); } catch (e) { d = null; }
    if (!d || isNaN(d)) return '';
    try { return d.toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return d.toLocaleString(); }
  }
  function bytes(n) {
    if (!n) return '';
    try { if (shell && shell._fmtBytes) return shell._fmtBytes(n); } catch (e) {}
    var u = ['B', 'KB', 'MB', 'GB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return fmtN(n) + ' ' + u[i];
  }
  function xmp(md, k) {
    var v = null;
    try { v = md && md.metadata ? md.metadata.get(k) : null; } catch (e) { v = null; }
    return Array.isArray(v) ? v.join(', ') : (v || '');
  }
  function aboutRow(k, v) { v = String(v == null ? '' : v).trim(); return v ? '<div class="zp-row-kv"><span class="zp-k">' + esc(t(k)) + '</span><span class="zp-v">' + esc(v) + '</span></div>' : ''; }
  // Its name and author are put in as text once this is drawn.
  function aboutHtml(md, first, dl) {
    var info = md && md.info || {};
    var author = info.Author || xmp(md, 'dc:creator');
    var lib = '';
    try { var z = shell && shell._zimInfo(zim); lib = z && z.title || zim; } catch (e) { lib = zim; }
    return '<div class="zp-about">' +
      '<div class="zp-about-id"><b></b>' + (author ? '<span></span>' : '') + '</div>' +
      '<div class="zp-rows">' +
        aboutRow('books_subject', info.Subject || xmp(md, 'dc:description')) +
        aboutRow('pdf_keywords', info.Keywords || xmp(md, 'pdf:keywords')) +
        aboutRow('books_mode_pages', pages ? num(pages) : '') +
        aboutRow('pdf_page_size', first ? pageSize(first.view) : '') +
        aboutRow('zi_size', bytes(md && md.contentLength || dl && dl.length)) +
        aboutRow('pdf_created', pdfDate(info.CreationDate)) +
        aboutRow('pdf_modified', pdfDate(info.ModDate)) +
        aboutRow('pdf_application', info.Creator || xmp(md, 'xmp:creatortool')) +
        aboutRow('pdf_producer', info.Producer || xmp(md, 'pdf:producer')) +
        aboutRow('pdf_version', info.PDFFormatVersion) +
      '</div>' +
      (zim ? '<hr><div class="zp-rows">' + aboutRow('pdf_library', lib) + aboutRow('zi_file', path) + '</div>' : '') +
    '</div>';
  }
  function openAbout(from) {
    if (!app || !app.pdfDocument) return;
    var doc = app.pdfDocument, soft = function (p) { return p.then(null, function () { return null; }); };
    Promise.all([soft(doc.getMetadata()), soft(doc.getPage(1)), soft(doc.getDownloadInfo())]).then(function (r) {
      var md = r[0], info = md && md.info || {};
      aboutOpen = true;
      sheet.setAttribute('aria-label', t('pdf_about'));
      sheet.innerHTML = '<div class="zp-sheet-head"><b>' + esc(t('pdf_about')) + '</b>' +
        '<button type="button" class="zp-x" aria-label="' + esc(t('close')) + '">×</button></div>' + aboutHtml(md, r[1], r[2]);
      sheet.querySelector('.zp-about-id b').textContent = info.Title || xmp(md, 'dc:title') || head.querySelector('.zp-title b').textContent;
      var au = sheet.querySelector('.zp-about-id span');
      if (au) au.textContent = info.Author || xmp(md, 'dc:creator');
      openAs(sheet, from);
      sheet.scrollTop = 0;
      sheet.querySelector('.zp-x').focus({ preventScroll: true });
    });
  }

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
      // As the page is shown: turned with the rest.
      var rot = (pg.rotate + rotation()) % 360;
      var v1 = pg.getViewport({ scale: 1, rotation: rot });
      var vp = pg.getViewport({ scale: THUMB_PX / v1.width, rotation: rot });
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
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault(); e.stopImmediatePropagation(); printRaw(); return;
    }
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopImmediatePropagation(); openFind(); return; }
    // A page back or on: the arrows (mirrored in a right-to-left Zimi;
    // a page zoomed past the window's width keeps them for scrolling across)
    // and Page Up / Page Down, which pdf.js would only scroll by a screen.
    var turn = 0;
    if (!typing && !openPanel && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (e.key === 'PageUp') turn = -1;
      else if (e.key === 'PageDown') turn = 1;
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(container && container.scrollWidth > container.clientWidth + 1)) {
        turn = (e.key === 'ArrowRight' ? 1 : -1) * (dir === 'rtl' ? -1 : 1);
      }
    }
    if (turn) { e.preventDefault(); e.stopImmediatePropagation(); step(turn); return; }
    if (e.key === 'Escape') {
      if (openPanel) { e.preventDefault(); e.stopImmediatePropagation(); closePanel(true); }
      else if (html.classList.contains('zp-finding')) { e.preventDefault(); e.stopImmediatePropagation(); closeFind(); }
    }
  }, true);

  // For the shell and the tests: where the reader is.
  window.zimiPdf = {
    page: function () { return page; }, pages: function () { return pages; },
    goPage: goPage, barsShown: barsShown, showBars: showBars, setSpread: setSpread,
    rotation: rotation, turn: turn
  };
})();
