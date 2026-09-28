// Zimipedia's article reader. Eric, 2026-09-25: "It not useful it doesn't
// own the pages or help dive in and learn better ... Have a refined article
// reader."
//
// A wiki's article opened from Zimipedia (and any wiki's article read in
// Reader View) is laid out as an encyclopedia on top of Reader View, in the
// same document, from what the page already holds: the reading settings
// Bookshelf uses (the shell's _readingSettings*), the lead image, a contents
// list that follows you (a rail beside the text on a wide screen, a sheet
// from the bar on a phone), the infobox beside the text or folded, a bar
// that steps aside while you read (with Zimi's header, _chromeScroll), and
// citations as a card in place. What needs the server (the languages, the
// other wikis on the topic) is asked once the article is on screen, in
// place of the language lookup every article already made.
//
// Loaded by the shell (app.js _wikiReaderLoad) in the background, never on
// the way to an article: it runs in the shell's scope, on the frame's
// document, as the book reader does.

var _WIKI_PREFS_DEFAULT = { size: 19, lh: 2, margin: 1 };
var _WIKI_RAIL_MIN = 900;       // px wide: the contents in a rail, the facts floated beside the text
var _WIKI_SIDE_MIN = 1200;      // px wide: the facts in the margin beside the text
var _WIKI_BAR_FOOT_MAX = 699;   // px wide: up to here the bar sits at the foot, under the thumb
var _WIKI_BARS_HIDE = 24;       // px scrolled down (or up) before the bar leaves (or comes back)
var _WIKI_PLACE_MS = 2000;      // ms between writes of the place while reading
var _WIKI_PLACE_START = 0.08;   // share of the article read before it counts as started
var _WIKI_PLACE_DONE = 0.9;     // share read from which it counts as finished
var _WIKI_HEAD_SLACK = 40;
var _WIKI_CARD_SCROLL = 80;     // px scrolled away from a card before it is put away      // px below the bar a heading may sit and still be the one you are in
var _WIKI_SVG_TOC = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".6" fill="currentColor"/><circle cx="4.5" cy="12" r=".6" fill="currentColor"/><circle cx="4.5" cy="18" r=".6" fill="currentColor"/></svg>';

var _WIKI_SVG_LANG = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h9M8.5 3v2M6 5c.6 3 2.6 5.6 5.5 7M11 5c-.7 3.4-3.1 6.4-6.5 8"/><path d="M12.5 21l4-10 4 10M14 17.5h5"/></svg>';
var _WIKI_SVG_SIDE = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>';
var _WIKI_SPLIT_MIN = 1100;     // px wide: two languages side by side
var _WIKI_MAP_ZOOM = 12;        // a map opened on an article's coordinates: a town and around it
var _WIKI_SVG_MAP = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>';
// Where the next article lands, when it is this one in another language or
// level: the section you were in ({k: its place among the article's
// sections, n: how many, text: its heading}). Read once, by that article.
var _wikiLand = null;
var _WIKI_UI_FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
var _WIKI_CSS = [
  // ── the page: the reader's own type, and room for the bar ──
  'html.zw .zimi-reader{font-size:var(--zw-size);line-height:var(--zw-lh);',
    'padding:calc(var(--zw-top) + 14px) calc(var(--zw-m) + var(--zb-sar)) calc(var(--zw-bottom) + 72px) calc(var(--zw-m) + var(--zb-sal))}',
  'html.zw .zimi-reader-body{max-width:var(--zw-measure);position:relative}',
  'html.zw .zimi-reader h1.zimi-reader-title{border:0;margin:.15em 0 .2em;padding:0;font-size:2.05em;line-height:1.15}',
  'html.zw .zimi-reader h2{margin-top:1.5em}',
  // A formula is a picture of black type: in the dark, it is turned light.
  'body.rv-theme-dark.zimi-reader-active img[class*="mwe-math"]{filter:invert(.88)}',
  '.zw-sub{margin:0 0 1.1em;color:var(--rv-muted);font:15px/1.4 ' + _WIKI_UI_FONT + '}',
  'html.zw .zimi-reader :target{scroll-margin-top:calc(var(--zw-top) + 12px)}',
  // A section anchor lands below the bar, not under it.
  'html.zw .zimi-reader h2,html.zw .zimi-reader h3{scroll-margin-top:calc(var(--zw-top) + 12px)}',
  // ── the lead image: on a phone, over the title ──
  '.zw-hero{display:none}',
  '@media (max-width:' + (_WIKI_RAIL_MIN - 1) + 'px){.zw-hero{display:block;margin:-14px calc(-1 * var(--zw-m)) 18px;background:var(--rv-code)}',
    '.zw-hero img{display:block;width:100%!important;max-height:48vh;object-fit:cover;border-radius:0!important;margin:0!important}}',
  // ── the facts (the infobox): folded on a phone, beside the text on a wide screen ──
  '.zw-facts{margin:.4em 0 1.4em;border:1px solid var(--rv-border);border-radius:12px;overflow:hidden!important;font:14px/1.45 ' + _WIKI_UI_FONT + '}',
  '.zw-facts > summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;padding:11px 14px;font-weight:600;color:var(--rv-head);-webkit-tap-highlight-color:transparent}',
  '.zw-facts > summary::-webkit-details-marker{display:none}',
  '.zw-facts > summary::after{content:"";margin-inline-start:auto;width:8px;height:8px;border:solid var(--rv-muted);border-width:0 2px 2px 0;transform:rotate(45deg);transition:transform .2s}',
  '.zw-facts[open] > summary::after{transform:rotate(-135deg)}',
  '.zw-facts[open] > summary{border-bottom:1px solid var(--rv-border)}',
  '.zw-facts .zimi-table-wrap{margin:0!important}',
  // The wiki's own stylesheet floats an infobox and lets it grow past its
  // box; here it is the box.
  '.zw-facts table{float:none!important;width:100%!important;max-width:100%!important;margin:0!important;border:0!important;font-size:1em!important;background:none!important;color:var(--rv-fg)!important}',
  '.zw-facts table *{white-space:normal!important;overflow-wrap:anywhere}',
  '.zw-facts table th,.zw-facts table td{border:0!important;border-top:1px solid var(--rv-border)!important;padding:6px 12px!important;background:none!important;color:inherit!important;text-align:start!important;vertical-align:top}',
  '.zw-facts table tr:first-child > *{border-top:0!important}',
  '.zw-facts table th{color:var(--rv-muted)!important;font-weight:600;overflow-wrap:normal;-webkit-hyphens:auto;hyphens:auto}',
  '.zw-facts table th[colspan],.zw-facts .infobox-above,.zw-facts .infobox-header,.zw-facts caption{text-align:center!important;color:var(--rv-head)!important;font-weight:700}',
  '.zw-facts caption,.zw-facts .infobox-above{font-size:1.12em;padding:10px 12px!important;background:none!important;border:0!important}',
  '.zw-facts .infobox-header,.zw-facts th[colspan]{background:var(--rv-code)!important}',
  '.zw-facts td[colspan],.zw-facts .infobox-image{text-align:center!important}',
  '.zw-facts img{margin:4px auto!important;border-radius:6px;display:inline-block!important}',
  '.zw-facts .infobox-caption{color:var(--rv-muted);font-size:.9em}',
  // A build without pictures (nopic, mini) draws each one as an empty box
  // with its words in it: the reader leaves the box out, the caption stays.
  'html.zw img[src^="data:image/svg"][src*="alt-text-clip"]{display:none!important}',
  '.zw-facts ul,.zw-facts ol{margin:0 0 0 1.1em!important;padding:0}',
  '.zw-facts .plainlist ul,.zw-facts .hlist ul{list-style:none;margin:0!important}',
  '@media (min-width:' + _WIKI_RAIL_MIN + 'px){.zw-facts > summary{display:none}}',
  '@media (min-width:' + _WIKI_RAIL_MIN + 'px) and (max-width:' + (_WIKI_SIDE_MIN - 1) + 'px){.zw-facts{float:inline-end;width:min(19em,46%);margin:.3em 0 1em 1.4em;margin-inline:1.4em 0}}',
  '@media (min-width:' + _WIKI_SIDE_MIN + 'px){html.zw .zimi-reader{padding-inline-end:340px}',
    '.zw-facts{position:absolute;inset-inline-start:calc(100% + 40px);width:300px;margin:0!important}}',
  // ── the contents: a rail beside the text on a wide screen ──
  '.zw-rail{display:none}',
  '@media (min-width:' + _WIKI_RAIL_MIN + 'px){html.zw .zimi-reader{padding-inline-start:calc(260px + var(--zb-sal))}',
    '.zw-rail{display:block;position:fixed;top:calc(var(--zw-top) + 18px);bottom:16px;inset-inline-start:calc(16px + var(--zb-sal));width:220px;overflow:auto;',
    'overscroll-behavior:contain;font:13.5px/1.35 ' + _WIKI_UI_FONT + ';color:var(--rv-muted);scrollbar-width:thin;transition:top .25s ease}',
    'html.zb-away .zw-rail{top:18px}',
    '.zw-cbtn{display:none!important}}',
  '.zw-rail b{display:block;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;margin:0 0 6px;padding:0 10px}',
  '.zw-rail .zb-toc-list button{text-align:start;width:100%;border:0;background:none;color:inherit;font:inherit;cursor:pointer;border-radius:8px;unicode-bidi:plaintext}',
  '.zw-rail .zb-toc-list button{padding:5px 10px}',
  '.zw-rail .zb-toc-list .zb-sub button{padding-inline-start:22px;font-size:.95em}',
  '@media (hover:hover){.zw-rail .zb-toc-list button:hover{color:var(--rv-fg);background:var(--rv-code)}}',
  '.zw-rail .zb-toc-list [aria-current="true"] button{background:var(--rv-code);color:var(--rv-link);font-weight:600}',
  // ── the bar: at the top, at the foot on a phone ──
  '.zw-bar{justify-content:flex-end;gap:2px}',
  '.zb-bar .zw-cbtn{flex:1 1 auto;min-width:0;justify-content:flex-start;gap:8px;padding:0 10px;font-weight:600}',
  '.zw-cbtn span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;unicode-bidi:plaintext}',
  '@media (max-width:' + _WIKI_BAR_FOOT_MAX + 'px){.zw-bar.zb-head{top:auto;bottom:0;height:calc(' + _READING_BAR_H + 'px + var(--zb-sab));',
    'padding:0 calc(6px + var(--zb-sar)) var(--zb-sab) calc(6px + var(--zb-sal));border-bottom:0;border-top:1px solid var(--rv-border)}',
    'html.zb-away .zw-bar.zb-head{transform:translateY(100%)}}',
  // ── a card in place: a citation ──
  '.zw-card{position:fixed;z-index:2147482300;box-sizing:border-box;max-width:min(440px,calc(100vw - 24px));max-height:min(46vh,380px);overflow:auto;',
    'background:var(--rv-bg);color:var(--rv-fg);border:1px solid var(--rv-border);border-radius:14px;box-shadow:0 10px 36px rgba(0,0,0,.28);',
    'padding:12px 16px 14px;font:14px/1.5 ' + _WIKI_UI_FONT + ';overscroll-behavior:contain;unicode-bidi:plaintext}',
  '.zw-card[hidden]{display:none}',
  '.zw-card .zw-card-k{display:block;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--rv-muted);margin:0 0 4px}',
  '.zw-card a{color:var(--rv-link)}',
  '@media (max-width:' + _WIKI_BAR_FOOT_MAX + 'px){.zw-card{left:10px!important;right:10px;top:auto!important;bottom:calc(10px + var(--zb-sab));max-width:none}}',
  // ── a mini build says what it is ──
  '.zw-note{margin:1.4em 0;padding:12px 14px;border-radius:12px;background:var(--rv-code);color:var(--rv-muted);font:14px/1.5 ' + _WIKI_UI_FONT + '}',
  '.zw-note a{font-weight:600}',
  // ── one topic, every wiki: a strip of what else the library holds on it ──
  '.zw-strip{margin:1.2em 0 1.6em;font:14px/1.3 ' + _WIKI_UI_FONT + '}',
  '.zw-strip > b{display:block;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--rv-muted);margin:0 0 8px}',
  '.zw-strip ul{list-style:none;margin:0!important;padding:0;display:flex;flex-wrap:wrap;gap:8px}',
  '.zw-strip li{margin:0!important}',
  '.zw-strip a{display:flex;align-items:center;gap:9px;padding:8px 12px 8px 9px;border:1px solid var(--rv-border);border-radius:12px;color:var(--rv-fg)!important;text-decoration:none!important;max-width:15em}',
  '@media (hover:hover){.zw-strip a:hover{border-color:var(--rv-link)}}',
  '.zw-strip img,.zw-strip svg{width:22px;height:22px;flex:none;margin:0!important;border-radius:5px}',
  '.zw-strip span{display:flex;flex-direction:column;min-width:0}',
  '.zw-strip i{font-style:normal;font-weight:600;font-size:12px;color:var(--rv-muted)}',
  '.zw-strip em{font-style:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;unicode-bidi:plaintext}',
  '@media (max-width:' + _WIKI_BAR_FOOT_MAX + 'px){.zw-strip ul{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;margin:0 calc(-1 * var(--zw-m))!important;padding:0 var(--zw-m)}.zw-strip ul::-webkit-scrollbar{display:none}.zw-strip a{max-width:12em}}',
  // ── languages: a sheet of the ones that have this article ──
  '.zb-bar .zw-lbtn{gap:3px;font:600 13px/1 ' + _WIKI_UI_FONT + ';padding:0 8px}',
  '.zw-lang-list{list-style:none;margin:0;padding:0}',
  '.zw-lang-list li{display:flex;align-items:center;gap:6px;border-top:1px solid var(--rv-border)}',
  '.zw-lang-list li:first-child{border-top:0}',
  '.zw-lang-list .zw-go{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;text-align:start;padding:11px 10px;border-radius:10px}',
  '.zw-lang-list .zw-go b{font-weight:600;unicode-bidi:plaintext}',
  '.zw-lang-list .zw-go span{font-size:12.5px;color:var(--rv-muted)}',
  '.zw-lang-list .zw-side{display:none;flex:none;width:40px;height:40px;border-radius:10px;align-items:center;justify-content:center;color:var(--rv-muted)}',
  '@media (min-width:' + _WIKI_SPLIT_MIN + 'px){.zw-lang-list .zw-side{display:inline-flex}}',
  // ── two languages side by side: the other in a pane of its own ──
  '.zw-pane{display:none}',
  '@media (min-width:' + _WIKI_SPLIT_MIN + 'px){',
    // On the side the article ends (right of a left-to-right one), whichever
    // way the other one reads.
    'html.zw-split .zw-pane{display:block;position:fixed;top:0;bottom:0;right:0;width:46vw;min-height:0;overflow-y:auto!important;overscroll-behavior:contain;',
      'box-sizing:border-box;padding:calc(var(--zw-top) + 14px) 32px 72px;border-left:1px solid var(--rv-border);font-size:var(--zw-size);line-height:var(--zw-lh);z-index:1}',
    'html.zw-split .zimi-reader:not(.zw-pane){padding-left:32px;padding-right:calc(46vw + 32px)}',
    'html.zw-split.zw-rtl .zw-pane{right:auto;left:0;border-left:0;border-right:1px solid var(--rv-border)}',
    'html.zw-split.zw-rtl .zimi-reader:not(.zw-pane){padding-right:32px;padding-left:calc(46vw + 32px)}',
    'html.zw-split .zw-rail{display:none}',
    'html.zw-split .zb-bar .zw-cbtn{display:flex!important}',
    'html.zw-split .zw-facts{position:static;float:inline-end;width:min(17em,46%);margin:.3em 0 1em;margin-inline:1.2em 0}',
    'html.zw-split .zw-facts > summary{display:flex}}',
  '.zw-pane-head{display:flex;align-items:center;gap:8px;margin:0 0 6px;font:600 12.5px/1.3 ' + _WIKI_UI_FONT + ';color:var(--rv-muted);text-transform:uppercase;letter-spacing:.05em}',
  '.zw-pane-head span{flex:1}',
  '.zw-pane-head button{border:0;background:none;color:inherit;font-size:20px;line-height:1;width:32px;height:32px;border-radius:16px;cursor:pointer}',
  '@media print{.zw-rail,.zw-card,.zw-hero,.zw-pane{display:none!important}.zw-facts > summary{display:none}}'
].join('');

// How articles are read in this browser: the size, spacing and margins of
// the reading settings (theme and font are Reader View's, shared).
function _wikiPrefs() { return _readingPrefs(SK.WIKI_PREFS, _WIKI_PREFS_DEFAULT); }

// The facts of an article: its infobox (the first, the page's own), not a
// sister-project box, which MediaWiki also marks infobox.
function _wikiInfobox(article) {
  var boxes = article.querySelectorAll('table.infobox');
  for (var i = 0; i < boxes.length; i++) if (!boxes[i].closest('.sisterproject,.navbox,.zw-facts')) return boxes[i];
  return null;
}
// The lead image: the infobox's first picture of any size (not a flag or
// an icon beside a fact).
var _WIKI_LEAD_IMG_MIN = 120;  // px wide as the page asks for it
function _wikiLeadImage(box) {
  if (!box) return null;
  var imgs = box.querySelectorAll('img:not([src^="data:"])');
  for (var i = 0; i < imgs.length; i++) {
    var w = Number(imgs[i].getAttribute('width')) || imgs[i].naturalWidth || 0;
    if (w >= _WIKI_LEAD_IMG_MIN || (!w && i === 0)) return imgs[i];
  }
  return null;
}
// The article's headings, each with an id to link to.
function _wikiHeadings(article) {
  var n = 0;
  return Array.prototype.filter.call(article.querySelectorAll('h2,h3'), function(h) {
    if (h.closest('.zw-facts,table,figure,.navbox,.zw-next') || !(h.textContent || '').trim()) return false;
    if (!h.id) h.id = 'zw-h-' + (n++);
    return true;
  });
}
// The heading you are in: the last one above the reading line.
function _wikiCurrent(heads, line) {
  var k = -1;
  for (var i = 0; i < heads.length; i++) {
    if (heads[i].getBoundingClientRect().top <= line) k = i; else break;
  }
  return k;
}
// Where an article in another language (or level) lands: the section with
// the same heading where the words agree (Simple and full English share
// them), else the section at the same place in the article. null: the top.
function _wikiLandOn(heads, land) {
  if (!land || land.k < 0) return null;
  var h2 = heads.filter(function(h) { return h.tagName === 'H2'; });
  if (!h2.length) return null;
  var norm = function(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); };
  for (var i = 0; i < h2.length; i++) if (land.text && norm(_wikiText(h2[i])) === norm(land.text)) return h2[i];
  return h2[Math.min(h2.length - 1, Math.round(land.k / Math.max(1, land.n - 1) * (h2.length - 1)))];
}
function _wikiText(el) { return (el && el.textContent || '').replace(/\s+/g, ' ').trim(); }
// A mini build: Kiwix's _mini_ in the file name.
function _wikiIsMini(zim) { var z = _zimInfo(zim); return !!(z && /_mini(?:_|\.zim$)/i.test(z.file || '')); }
// Where you are, as a place Zimipedia's Continue reading can take you back
// to: the heading's id and the share read.
function _wikiPlaceRef(zim, path, title, meta) {
  return { kind: 'article', app: 'wiki', zim: zim, path: path, title: title, meta: meta };
}

// The reader, once per document. A layout that throws is taken back off,
// leaving Reader View to read.
function _wikiLay(frame) {
  var doc = frame.contentDocument;
  if (!doc || doc.__zimiWikiLaid) return false;
  doc.__zimiWikiLaid = true;
  try { return _wikiLayout(frame); } catch (e) { _wikiUndo(doc); console.warn('Zimipedia reader:', e); return false; }
}
function _wikiUndo(doc) {
  try {
    doc.documentElement.classList.remove('zw', 'zw-rtl', 'zw-split', 'zb-away', 'zb-sheet-open');
    Array.prototype.forEach.call(doc.querySelectorAll('#zw-style,.zw-bar,.zw-rail,.zw-card,.zw-sheet,.zw-scrim,.zw-hero,.zw-sub,.zw-note,.zw-pane,.zw-strip'), function(n) { n.remove(); });
    Array.prototype.forEach.call(doc.querySelectorAll('details.zw-facts'), function(d) { while (d.lastChild && d.lastChild.nodeName !== 'SUMMARY') d.parentNode.insertBefore(d.lastChild, d.nextSibling); d.remove(); });
  } catch (e) {}
  doc.__zimiWikiLaid = false;
}

function _wikiLayout(frame) {
  var doc = frame.contentDocument, win = frame.contentWindow;
  var shell = doc.querySelector('.zimi-reader'), article = doc.querySelector('.zimi-reader-body');
  var loc = win.location.pathname.match(/^\/w\/([^\/]+)\/(.+)$/);
  if (!shell || !article || !loc) return false;
  var zim = decodeURIComponent(loc[1]), path = decodeURIComponent(loc[2]);
  var html = doc.documentElement, uiRtl = document.documentElement.getAttribute('dir') === 'rtl';
  var stash = doc[_READER_VIEW_STASH];
  var st = doc.createElement('style');
  st.id = 'zw-style';
  st.textContent = _READING_CSS + _WIKI_CSS;
  doc.head.appendChild(st);
  html.classList.add('zw');
  // The article reads in its own language and direction; the bar and the
  // sheets in the interface's.
  var content = (stash && stash.querySelector('#mw-content-text')) || doc.querySelector('[lang]');
  var lang = (content && content.getAttribute('lang')) || html.getAttribute('lang') || '';
  var rtl = ((content && content.getAttribute('dir')) || html.getAttribute('dir') || '') === 'rtl';
  shell.setAttribute('dir', rtl ? 'rtl' : 'ltr');
  html.classList.toggle('zw-rtl', rtl);
  if (lang) shell.setAttribute('lang', lang);
  var el = function(tag, cls, inner) { var e = doc.createElement(tag); if (cls) e.className = cls; if (inner) e.innerHTML = inner; return e; };
  var ui = function(e) { e.setAttribute('dir', uiRtl ? 'rtl' : 'ltr'); e.setAttribute('lang', _currentLang || 'en'); return e; };
  var titleEl = article.querySelector('h1.zimi-reader-title');
  var title = _wikiText(titleEl) || _readerViewTitle(doc);

  // ── the head: the short description under the title, the lead image over it ──
  var short = stash && stash.querySelector('.shortdescription');
  if (short && _wikiText(short) && titleEl) {
    var sub = el('p', 'zw-sub');
    sub.textContent = _wikiText(short);
    titleEl.parentNode.insertBefore(sub, titleEl.nextSibling);
  }
  var box = _wikiInfobox(article), facts = null, leadImg = _wikiLeadImage(box);
  if (leadImg && titleEl) {
    var hero = el('figure', 'zw-hero');
    var img = leadImg.cloneNode(false);
    img.removeAttribute('width'); img.removeAttribute('height'); img.removeAttribute('style');
    img.setAttribute('alt', leadImg.getAttribute('alt') || '');
    hero.appendChild(img);
    titleEl.parentNode.insertBefore(hero, titleEl);
  }
  if (box) {
    facts = el('details', 'zw-facts');
    var sum = ui(el('summary'));
    sum.textContent = t('wiki_facts');
    facts.appendChild(sum);
    var holder = box.parentNode && box.parentNode.classList.contains('zimi-table-wrap') ? box.parentNode : box;
    holder.parentNode.insertBefore(facts, holder);
    facts.appendChild(holder);
  }
  var mini = _wikiIsMini(zim);
  var note = null;
  if (mini) {
    // A mini carries the introduction and the facts only: it says so, rather
    // than a page that ends early and citations that go nowhere.
    note = ui(el('aside', 'zw-note'));
    note.textContent = t('wiki_mini_note');
    article.appendChild(note);
  }

  // ── the contents ──
  var heads = _wikiHeadings(article);
  var tocHtml = function(k) {
    var h = '<ol class="zb-toc-list"><li' + (k < 0 ? ' aria-current="true"' : '') + '><button type="button" data-k="-1">' + esc(title) + '</button></li>';
    heads.forEach(function(hd, i) {
      h += '<li' + (hd.tagName === 'H3' ? ' class="zb-sub"' : '') + (i === k ? ' aria-current="true"' : '') + '><button type="button" data-k="' + i + '">' + esc(_wikiText(hd)) + '</button></li>';
    });
    return h + '</ol>';
  };
  var rail = null;
  if (heads.length) {
    // The rail stands on the article's side and reads in its direction.
    rail = el('nav', 'zw-rail');
    rail.setAttribute('dir', rtl ? 'rtl' : 'ltr');
    rail.setAttribute('aria-label', t('books_contents'));
    doc.body.appendChild(rail);
  }

  // ── the bar, the sheets ──
  var bar = ui(el('div', 'zb-bar zb-head zw-bar'));
  bar.innerHTML = (heads.length ? '<button type="button" class="zw-cbtn" aria-haspopup="dialog" title="' + tH('books_contents') + '">' + _WIKI_SVG_TOC + '<span></span></button>' : '') +
    // The languages: shown once the lookup says there is somewhere to go.
    '<button type="button" class="zw-lbtn" hidden aria-haspopup="dialog" aria-label="' + tH('wiki_languages') + '" title="' + tH('wiki_languages') + '">' + _WIKI_SVG_LANG + '<span></span></button>' +
    '<button type="button" class="zb-aa" aria-label="' + tH('books_settings') + '" title="' + tH('books_settings') + '" aria-haspopup="dialog">Aa</button>';
  var scrim = el('div', 'zb-scrim zw-scrim');
  var tocSheet = ui(el('div', 'zb-sheet zw-sheet zw-toc-sheet'));
  var setSheet = ui(el('div', 'zb-sheet zw-sheet zw-set-sheet'));
  var langSheet = ui(el('div', 'zb-sheet zw-sheet zw-lang-sheet'));
  [tocSheet, setSheet, langSheet].forEach(function(s) { s.setAttribute('role', 'dialog'); });
  langSheet.setAttribute('aria-label', t('wiki_languages'));
  tocSheet.setAttribute('aria-label', t('books_contents'));
  setSheet.setAttribute('aria-label', t('books_settings'));
  var card = ui(el('div', 'zw-card'));
  card.hidden = true;
  card.setAttribute('role', 'dialog');
  [bar, scrim, tocSheet, setSheet, langSheet, card].forEach(function(n) { doc.body.appendChild(n); });
  var sheets = [tocSheet, setSheet, langSheet];
  var sheetOpen = function() { return html.classList.contains('zb-sheet-open'); };
  var closeSheets = function() { sheets.forEach(function(s) { s.classList.remove('zb-open'); }); html.classList.remove('zb-sheet-open'); };
  var openSheet = function(s) { closeSheets(); hideCard(); s.classList.add('zb-open'); html.classList.add('zb-sheet-open'); showBars(true); };
  scrim.onclick = closeSheets;

  // ── how you read: the settings, laid onto the page ──
  var prefs = _wikiPrefs();
  var insets = _bookInsets();
  var barAtFoot = function() { return win.innerWidth <= _WIKI_BAR_FOOT_MAX; };
  var applyVars = function() {
    var s = html.style;
    s.setProperty('--zw-size', prefs.size + 'px');
    s.setProperty('--zw-lh', String(_READING_LEADINGS[prefs.lh]));
    s.setProperty('--zw-m', _READING_MARGINS[prefs.margin] + 'px');
    s.setProperty('--zw-measure', _READING_MEASURES[prefs.margin] + 'em');
    s.setProperty('--zb-sat', insets.t + 'px'); s.setProperty('--zb-sar', insets.r + 'px');
    s.setProperty('--zb-sab', insets.b + 'px'); s.setProperty('--zb-sal', insets.l + 'px');
    s.setProperty('--zw-top', (barAtFoot() ? insets.t : _READING_BAR_H + insets.t) + 'px');
    s.setProperty('--zw-bottom', (barAtFoot() ? _READING_BAR_H + insets.b : insets.b) + 'px');
  };
  applyVars();
  setSheet.__zbLayouts = null;
  var renderSettings = _readingSettingsBind(setSheet, function() { return prefs; }, function(change) {
    if (change) { for (var k in change) prefs[k] = change[k]; _setStorageJSON(SK.WIKI_PREFS, { size: prefs.size, lh: prefs.lh, margin: prefs.margin }); }
    // The passage you were reading stays where it was.
    var k0 = current, top0 = k0 >= 0 ? heads[k0].getBoundingClientRect().top : 0;
    applyVars();
    if (k0 >= 0) win.scrollBy(0, heads[k0].getBoundingClientRect().top - top0);
  }, closeSheets);
  bar.querySelector('.zb-aa').onclick = function() {
    renderSettings();
    openSheet(setSheet);
    var x = setSheet.querySelector('[aria-pressed="true"]');
    if (x) x.focus({ preventScroll: true });
  };

  // ── the facts: open beside the text on a wide screen, folded on a phone ──
  var wide = win.matchMedia('(min-width: ' + _WIKI_RAIL_MIN + 'px)');
  var foldFacts = function() { if (facts) facts.open = wide.matches; };
  foldFacts();
  if (wide.addEventListener) wide.addEventListener('change', foldFacts);

  // ── where you are ──
  var current = -1;
  // The reading line: where a heading lands when you go to it (under the
  // bar's room, whether the bar is there or not), and a little below.
  var headTop = function() { return (barAtFoot() ? insets.t : _READING_BAR_H + insets.t) + 12; };
  var readingLine = function() { return headTop() + _WIKI_HEAD_SLACK; };
  var barLabel = bar.querySelector('.zw-cbtn span');
  var markCurrent = function() {
    var k = _wikiCurrent(heads, readingLine());
    if (k === current && rail && rail.firstChild) return;
    current = k;
    if (barLabel) barLabel.textContent = k >= 0 ? _wikiText(heads[k]) : t('books_contents');
    if (rail) {
      rail.innerHTML = '<b dir="' + (uiRtl ? 'rtl' : 'ltr') + '">' + tH('books_contents') + '</b>' + tocHtml(k);
      var on = rail.querySelector('[aria-current="true"]');
      if (on && on.scrollIntoView && (on.offsetTop < rail.scrollTop || on.offsetTop > rail.scrollTop + rail.clientHeight - 40)) rail.scrollTop = on.offsetTop - rail.clientHeight / 3;
    }
  };
  var goHead = function(k) {
    if (k < 0) { win.scrollTo(0, 0); return; }
    var h = heads[k];
    if (h) win.scrollTo(0, Math.max(0, (win.scrollY || 0) + h.getBoundingClientRect().top - headTop()));
  };
  var onToc = function(e) {
    var b = e.target.closest && e.target.closest('button[data-k]');
    if (!b) return;
    closeSheets();
    goHead(Number(b.getAttribute('data-k')));
  };
  if (rail) rail.addEventListener('click', onToc);
  tocSheet.addEventListener('click', function(e) {
    if (e.target.closest && e.target.closest('.zb-x')) { closeSheets(); return; }
    onToc(e);
  });
  var cbtn = bar.querySelector('.zw-cbtn');
  if (cbtn) cbtn.onclick = function() {
    tocSheet.innerHTML = '<div class="zb-sheet-head"><b>' + tH('books_contents') + '</b><button type="button" class="zb-x" aria-label="' + tH('close') + '">×</button></div>' + tocHtml(current);
    openSheet(tocSheet);
    var on = tocSheet.querySelector('[aria-current="true"]');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'center' });
    var first = on ? on.querySelector('button') : tocSheet.querySelector('.zb-x');
    if (first) first.focus({ preventScroll: true });
  };

  // ── the place: Continue reading in Zimipedia ──
  var meta = { lang: lang };
  if (leadImg) { try { meta.thumb = new URL(leadImg.getAttribute('src'), win.location.href).pathname; } catch (e) {} }
  var ref = _wikiPlaceRef(zim, path, title, meta);
  var placeAt = 0, placeTimer = null;
  var keepPlace = function() {
    placeAt = Date.now();
    var room = Math.max(1, Math.max(html.scrollHeight, doc.body.scrollHeight) - win.innerHeight);
    var f = Math.min(1, (win.scrollY || 0) / room);
    if (f >= _WIKI_PLACE_DONE) { if (Saved.position(ref)) Saved.clearPosition(ref); return; }
    if (f < _WIKI_PLACE_START || current < 0) return;
    Saved.setPosition(ref, { s: heads[current].id, f: Math.round(f * 100) / 100 });
  };
  var placeSoon = function() {
    clearTimeout(placeTimer);
    if (Date.now() - placeAt > _WIKI_PLACE_MS) keepPlace();
    else placeTimer = setTimeout(keepPlace, _WIKI_PLACE_MS);
  };
  win.addEventListener('pagehide', function() { clearTimeout(placeTimer); keepPlace(); });

  // ── the bar comes and goes, with Zimi's header ──
  var barsShown = function() { return !html.classList.contains('zb-away'); };
  var showBars = function(on) { html.classList.toggle('zb-away', !on); };
  var lastY = win.scrollY || 0, down = 0, up = 0, ticking = false;
  doc.addEventListener('scroll', function() {
    if (ticking) return;
    ticking = true;
    win.requestAnimationFrame(function() {
      ticking = false;
      var y = win.scrollY || 0, dy = y - lastY;
      lastY = y;
      var room = Math.max(html.scrollHeight, doc.body.scrollHeight) - win.innerHeight;
      if (y < 8 || y >= room - 8) { showBars(true); down = up = 0; }
      else if (dy > 0) { down += dy; up = 0; if (down > _WIKI_BARS_HIDE && !sheetOpen()) showBars(false); }
      else if (dy < 0) { up -= dy; down = 0; if (up > _WIKI_BARS_HIDE) showBars(true); }
      try { _chromeScroll(y); } catch (e) {}
      // A card stays through a nudge; reading on puts it away.
      if (!card.hidden && Math.abs(y - card.__zwY) > _WIKI_CARD_SCROLL) hideCard();
      markCurrent();
      placeSoon();
    });
  }, { passive: true, capture: true });
  win.addEventListener('resize', function() { insets = _bookInsets(); applyVars(); markCurrent(); });

  // ── a citation, in place ──
  var hideCard = function() { card.hidden = true; card.__zwFor = null; };
  var placeCard = function(anchor) {
    if (barAtFoot()) return;
    var r = anchor.getBoundingClientRect(), w = card.offsetWidth, h = card.offsetHeight;
    var x = Math.max(12, Math.min(win.innerWidth - w - 12, (uiRtl || rtl ? r.right - w : r.left) - 8));
    var y = r.bottom + 8;
    if (y + h > win.innerHeight - 12) y = Math.max(12, r.top - h - 8);
    card.style.left = x + 'px'; card.style.top = y + 'px';
  };
  // A card: a line saying what it is, then what it holds (a node of the
  // page, moved in whole).
  var showCard = function(anchor, headHtml, body, cls) {
    card.className = 'zw-card' + (cls ? ' ' + cls : '');
    card.innerHTML = headHtml;
    card.appendChild(body);
    card.hidden = false;
    card.__zwFor = anchor;
    card.__zwY = win.scrollY || 0;
    card.scrollTop = 0;
    placeCard(anchor);
  };
  var citation = function(a) {
    var id = decodeURIComponent((a.getAttribute('href') || '').slice(1));
    // A note of the article beside this one is looked up in its own pane.
    var scope = a.closest('.zw-pane') || article;
    var note = id && scope.querySelector('[id="' + _cssEsc(id) + '"]');
    var n = _wikiText(a).replace(/[\[\]]/g, '');
    var head = '<span class="zw-card-k" dir="auto">' + esc(t('wiki_note', { n: n })) + '</span>';
    var body = el('div');
    body.setAttribute('dir', 'auto');
    if (!note) {
      // A citation mark whose note the copy does not carry: a mini, or a
      // selection made without its references.
      ui(body).textContent = t(mini ? 'wiki_note_mini' : 'wiki_note_missing');
      showCard(a, head, body);
      return;
    }
    var copy = (note.querySelector('.mw-reference-text,.reference-text') || note).cloneNode(true);
    Array.prototype.forEach.call(copy.querySelectorAll('.mw-cite-backlink'), function(b) { b.remove(); });
    if (lang) body.setAttribute('lang', lang);
    body.appendChild(copy);
    showCard(a, head, body);
  };
  doc.addEventListener('click', function(e) {
    var a = e.target.closest && e.target.closest('a[href^="#cite_note"],sup.reference a[href^="#"],.mw-ref a[href^="#"]');
    if (a && !a.closest('.zw-card')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (card.__zwFor === a && !card.hidden) hideCard(); else citation(a);
      return;
    }
    if (!card.hidden && !(e.target.closest && e.target.closest('.zw-card'))) hideCard();
  }, true);
  doc.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    if (!card.hidden) { hideCard(); e.preventDefault(); } else if (sheetOpen()) { closeSheets(); e.preventDefault(); }
  });

  // ── languages: the ones that have this article, landing on the same section ──
  var info = null;
  var lbtn = bar.querySelector('.zw-lbtn');
  // The section you are in, as the next article reads it (_wikiLand).
  var hereLand = function() {
    var h2 = heads.filter(function(h) { return h.tagName === 'H2'; });
    var at = current < 0 ? null : heads[current];
    while (at && at.tagName !== 'H2') { var i = heads.indexOf(at); at = i > 0 ? heads[i - 1] : null; }
    return { k: at ? h2.indexOf(at) : -1, n: h2.length, text: at ? _wikiText(at) : '' };
  };
  var goOther = function(z, p) {
    _wikiLand = hereLand();
    closeSheets();
    openArticle(z, p);
  };
  // A language named in itself (עברית, Deutsch), which is how a reader
  // finds their own; the interface's name for it under it.
  var langName = function(l) {
    var own = l.name && l.name !== l.lang ? l.name : '';
    try { own = own || new Intl.DisplayNames([l.lang], { type: 'language' }).of(l.lang); } catch (e) {}
    own = own || l.lang;
    try { return own.charAt(0).toLocaleUpperCase(l.lang) + own.slice(1); } catch (e) { return own; }
  };
  var otherRow = function(cls, go, name, sub, lng) {
    return '<li class="' + cls + '"><button type="button" class="zw-go" data-go="' + escAttr(go) + '"><b' + (lng ? ' lang="' + escAttr(lng) + '"' : '') + '>' + esc(name) + '</b>' +
      (sub ? '<span>' + esc(sub) + '</span>' : '') + '</button>' +
      '<button type="button" class="zw-side" data-side="' + escAttr(go) + '" aria-label="' + tH('wiki_side_by_side') + '" title="' + tH('wiki_side_by_side') + '">' + _WIKI_SVG_SIDE + '</button></li>';
  };
  var renderLangs = function() {
    var h = '<div class="zb-sheet-head"><b>' + tH('wiki_languages') + '</b><button type="button" class="zb-x" aria-label="' + tH('close') + '">×</button></div><ul class="zw-lang-list">';
    if (info.level) h += otherRow('zw-level', info.level.zim + '\n' + info.level.path, t(info.level.simple ? 'wiki_level_simple' : 'wiki_level_full'), t(info.level.simple ? 'wiki_level_simple_hint' : 'wiki_level_full_hint'), '');
    (info.languages || []).forEach(function(l) {
      var name = langName(l), mine = _langDisplayName(l.lang) || '';
      h += otherRow('', l.zim + '\n' + l.path, name, mine.toLowerCase() !== name.toLowerCase() ? mine : '', l.lang);
    });
    langSheet.innerHTML = h + '</ul>';
  };
  langSheet.addEventListener('click', function(e) {
    var b = e.target.closest && e.target.closest('button');
    if (!b) return;
    if (b.classList.contains('zb-x')) { closeSheets(); return; }
    var go = b.getAttribute('data-go'), side = b.getAttribute('data-side');
    var zp = (go || side || '').split('\n');
    if (go) goOther(zp[0], zp[1]);
    else if (side) { closeSheets(); openSide(zp[0], zp[1]); }
  });
  lbtn.onclick = function() {
    if (!info) return;
    renderLangs();
    openSheet(langSheet);
    var first = langSheet.querySelector('.zw-go');
    if (first) first.focus({ preventScroll: true });
  };

  // ── side by side: the article in another language, in a pane of its own ──
  var pane = null;
  var closeSide = function() {
    if (pane) pane.remove();
    pane = null;
    html.classList.remove('zw-split');
  };
  var openSide = function(z, p) {
    var url = _articleUrl(z, p), land = hereLand();
    fetch(url).then(function(r) { return r.ok ? r.text() : ''; }).catch(function() { return ''; }).then(function(text) {
      if (!text || frame.contentDocument !== doc) return;
      var other = new DOMParser().parseFromString(text, 'text/html');
      var main = other.querySelector('#mw-content-text') || other.body;
      var base = location.origin + url;
      var body = doc.importNode(main, true);
      _readerViewClean(body, doc);
      // Its addresses are its own page's, not this one's.
      Array.prototype.forEach.call(body.querySelectorAll('[src],[href]'), function(n) {
        ['src', 'href'].forEach(function(a) {
          var v = n.getAttribute(a);
          if (v && v.charAt(0) !== '#' && !/^[a-z]+:/i.test(v)) { try { n.setAttribute(a, new URL(v, base).pathname); } catch (e) {} }
        });
        n.removeAttribute('srcset');
      });
      var box = _wikiInfobox(body);
      if (box) {
        var f = el('details', 'zw-facts'), sm = ui(el('summary'));
        sm.textContent = t('wiki_facts');
        f.appendChild(sm);
        var hold = box.parentNode && box.parentNode.classList.contains('zimi-table-wrap') ? box.parentNode : box;
        hold.parentNode.insertBefore(f, hold);
        f.appendChild(hold);
      }
      closeSide();
      var olang = main.getAttribute('lang') || other.documentElement.getAttribute('lang') || '';
      var odir = main.getAttribute('dir') || other.documentElement.getAttribute('dir') || 'ltr';
      pane = el('div', 'zimi-reader zw-pane');
      pane.setAttribute('lang', olang);
      pane.setAttribute('dir', odir);
      var head = ui(el('div', 'zw-pane-head'));
      head.innerHTML = '<span></span><button type="button" aria-label="' + tH('close') + '" title="' + tH('close') + '">×</button>';
      head.firstChild.textContent = (_langDisplayName(olang) || olang) + (olang === lang ? ' · ' + _zimTitle(z) : '');
      head.lastChild.onclick = closeSide;
      var art = el('article', 'zimi-reader-body');
      var h1 = el('h1', 'zimi-reader-title');
      h1.textContent = _wikiText(other.querySelector('#firstHeading,h1')) || other.title || '';
      art.appendChild(h1);
      art.appendChild(body);
      pane.appendChild(head);
      pane.appendChild(art);
      doc.body.appendChild(pane);
      html.classList.add('zw-split');
      // The links out of the library are marked as the shell marks the page's.
      try { if (typeof zimiMarkLinks === 'function') zimiMarkLinks(pane); } catch (e) {}
      var to = _wikiLandOn(_wikiHeadings(art), land);
      if (to) pane.scrollTop = to.getBoundingClientRect().top - pane.getBoundingClientRect().top - 12;
      markCurrent();
    });
  };

  // The strip: the other wikis' pages on the topic, and a map where the
  // article has coordinates and a map of there is installed. After the
  // lead; if you have read past it by the time it comes, the page is held
  // where you are.
  var place = null;
  var geo = (article.querySelector('.geo') || {}).textContent || '';
  var gm = /(-?\d+(?:\.\d+)?)\s*[;,]\s*(-?\d+(?:\.\d+)?)/.exec(geo);
  if (gm) {
    var pt = { lat: parseFloat(gm[1]), lng: parseFloat(gm[2]) };
    var maps = (zimsCache || []).filter(function(z) { return z.kind === 'map' && _mapCovers(z, pt) !== false; });
    // A map known to cover the place, then the smallest (the most detailed).
    var area = function(z) { var b = z.map_bounds; return b && b.length === 4 ? Math.abs((b[2] - b[0]) * (b[3] - b[1])) : 1e9; };
    maps.sort(function(a, b) { return (_mapCovers(b, pt) === true) - (_mapCovers(a, pt) === true) || area(a) - area(b); });
    if (maps.length) place = { zim: maps[0].name, path: maps[0].main_path, pos: mapPositionHash(_WIKI_MAP_ZOOM, pt.lat, pt.lng) };
  }
  var renderStrip = function() {
    var items = (info.topic || []).map(function(tp) {
      return '<li><a href="' + escAttr(_articleUrl(tp.zim, tp.path)) + '" data-zim="' + escAttr(tp.zim) + '" data-path="' + escAttr(tp.path) + '">' +
        '<img src="/w/' + encodeURIComponent(tp.zim) + '/-/icon" alt="" loading="lazy"><span><i>' + esc(tp.project.charAt(0).toUpperCase() + tp.project.slice(1)) + '</i>' +
        '<em' + (lang ? ' lang="' + escAttr(lang) + '"' : '') + '>' + esc(tp.title) + '</em></span></a></li>';
    });
    if (place) items.push('<li><a href="#" class="zw-map">' + _WIKI_SVG_MAP + '<span><i>' + tH('wiki_map') + '</i><em>' + esc(_zimTitle(place.zim)) + '</em></span></a></li>');
    if (!items.length) return;
    var strip = ui(el('nav', 'zw-strip'));
    strip.setAttribute('aria-label', t('wiki_in_library'));
    strip.innerHTML = '<b>' + tH('wiki_in_library') + '</b><ul>' + items.join('') + '</ul>';
    var lead = article.querySelector('section[data-mw-section-id="0"]');
    var after = lead || (heads[0] && heads[0].closest('.mw-heading') || heads[0]);
    var y = win.scrollY || 0;
    if (lead) lead.parentNode.insertBefore(strip, lead.nextSibling);
    else if (after) after.parentNode.insertBefore(strip, after);
    else article.appendChild(strip);
    var r = strip.getBoundingClientRect();
    if (r.bottom < 0) win.scrollTo(0, y + r.height + parseFloat(win.getComputedStyle(strip).marginTop) + parseFloat(win.getComputedStyle(strip).marginBottom));
    var mapA = strip.querySelector('.zw-map');
    if (mapA) mapA.onclick = function(e) { e.preventDefault(); openArticle(place.zim, place.path, title, { pos: place.pos }); };
  };
  var renderInfo = function() {
    renderStrip();
    var n = (info.languages || []).length + (info.level ? 1 : 0);
    // A switch that cannot work is not shown: no Q-ID, or nowhere to go.
    lbtn.hidden = !n;
    lbtn.querySelector('span').textContent = n ? String(n) : '';
    if (note && info.full) {
      var a = ui(el('a'));
      a.href = _articleUrl(info.full.zim, info.full.path);
      a.textContent = t('wiki_mini_full');
      note.appendChild(doc.createTextNode(' '));
      note.appendChild(a);
    }
  };
  _wikiInfo(zim, _splitPathFragment(path).base).then(function(d) {
    if (!d || frame.contentDocument !== doc) return;
    info = d;
    renderInfo();
  });

  // ── open where the address says, or on the section you came from ──
  markCurrent();
  var land = _wikiLand;
  _wikiLand = null;
  var hash = (win.location.hash || '').slice(1);
  if (!hash && land) {
    var at = _wikiLandOn(heads, land);
    if (at) goHead(heads.indexOf(at));
  }
  if (hash) {
    try { hash = decodeURIComponent(hash); } catch (e) {}
    var tgt = doc.getElementById(hash);
    if (tgt) {
      var k = heads.indexOf(tgt.closest('h2,h3') || tgt);
      if (k >= 0) goHead(k); else win.scrollTo(0, Math.max(0, (win.scrollY || 0) + tgt.getBoundingClientRect().top - headTop()));
    }
  }
  lastY = win.scrollY || 0;
  markCurrent();
  // Highlights (docs/features/saving.md): the shell's engine marks the
  // article's passages. The layout above moved the facts and added lines of
  // its own, so the engine looks again (attaching, if the shell has not).
  try {
    var hl = doc.__zimiHighlights || (typeof Highlights !== 'undefined' && Highlights &&
      Highlights.attach(doc, { kind: 'article', app: 'wiki', zim: zim, path: path, title: title }, { root: article }));
    if (hl) { hl.refresh(); doc.__zimiHighlights = hl; }
  } catch (e) {}
  frame.__zw = { zim: zim, path: path, title: title, note: note, bar: bar, doc: doc };
  return true;
}
