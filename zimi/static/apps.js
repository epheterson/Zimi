// The apps' shared script: the few helpers every app page needs (ZimiTube,
// ZimiExchange, Reddot), inlined into each page by the server beside
// apps.css (see http._inline_apps_assets), so a page is still one document
// and a fix here reaches every app.
function esc(x) { return String(x == null ? '' : x).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
// A ZIM entry's address in Zimi.
function zpath(zim, p) { return '/w/' + encodeURIComponent(zim) + '/' + String(p).split('/').map(encodeURIComponent).join('/'); }
// "Open the original page": the shell opens it as an article so the
// header's arrow (and the browser's Back) returns here. A modified click
// keeps the link's own address for a new tab.
function openLink(a, zim, page, label) {
  a.href = zpath(zim, page); a.textContent = label;
  a.onclick = function(e) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    e.preventDefault(); tell({ zimi: 'open', zim: zim, path: page });
  };
}
// What is kept (bookmarks, lists, Liked, where you were): the shell's Saved,
// this browser's or, signed in, the account's. Same origin, so a page calls it
// directly, saved().itemsFor({ app: 'books' }), saved().save(item) and the
// rest (docs/features/saving.md); null when the page is open on its own,
// outside the shell. Any change, from the page, the panel or another device,
// reaches the page as window.__saved().
function saved() { try { return (window.parent !== window && window.parent.Saved) || null; } catch (e) { return null; } }
// Highlights in text the page draws itself: the shell's Highlights, whose
// attach(document, ref, {root}) returns a handle (refresh, goTo, missing,
// detach); null outside the shell. docs/features/saving.md.
function highlights() { try { return (window.parent !== window && window.parent.Highlights) || null; } catch (e) { return null; } }
// A ZIM's own HTML, just put on the page: its links that leave the library
// for the web get the reader's arrow (or become plain text, as the person
// chose), and say where they go before they go. The shell does it
// (zimiMarkLinks); a page open on its own, outside the shell, is left as is.
function markLinks(root) { try { return window.parent !== window ? window.parent.zimiMarkLinks(root) : 0; } catch (e) { return 0; } }
// The thing open in an app (a video, a question, a post) has three controls:
// Like, Save and Lists, drawn from the store and drawn again by savedPaint()
// whenever it changes (the page's window.__saved calls it). item is what
// Saved keeps: {kind, app, zim, path, title, meta}. opts.save names Save in
// the app's words ([off, on]: ZimiTube's "Watch later"); opts.thread keeps
// where you are in a long thread once it is saved (threadRestore below). The
// page's markup holds the place: <span class="svbar"></span> in its actions.
// savedBar(null) when the thing closes.
var SV_HEART = '<svg class="fill" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 5.6a5.5 5.5 0 0 0-7.8 0L12 6.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 22l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/></svg>';
var SV_MARK = '<svg class="fill" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
var SV_LISTS = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/></svg>';
var _svItem = null, _svOpts = {};
function savedBar(item, opts) {
  threadFlush();
  _svItem = item || null; _svOpts = opts || {};
  savedPaint();
}
function svButtons() {
  var S = saved(), it = _svItem, w = STR.sv || {};
  if (!S || !it) return '';
  var on = S.has(it), liked = on && S.inList(it, S.LIKED), names = _svOpts.save || [w.save, w.saved];
  var b = function(which, pressed, icon, label, extra) {
    return '<button type="button" class="svb' + (pressed ? ' on' : '') + '" data-sv="' + which + '"' + (extra || ' aria-pressed="' + pressed + '"') +
      ' onclick="savedDo(this)">' + icon + '<span>' + esc(label) + '</span></button>';
  };
  return b('like', liked, SV_HEART, liked ? w.liked : w.like) + b('save', on, SV_MARK, on ? names[1] || names[0] : names[0]) +
    b('lists', false, SV_LISTS, w.lists, ' aria-haspopup="menu" title="' + esc(w.add_to_list || '') + '"');
}
function savedPaint() { document.querySelectorAll('.svbar').forEach(function(bar) { bar.innerHTML = svButtons(); }); }
function savedDo(el) {
  var S = saved(), it = _svItem, which = el.getAttribute('data-sv');
  if (!S || !it) return;
  if (which === 'lists') { pickLists(it, el); return; }
  if (which === 'save') { if (S.has(it)) S.remove(it); else { S.save(it); threadWrite(); } }
  else if (S.inList(it, S.LIKED)) S.removeFromList(it, S.LIKED);
  else S.addToList(it, S.LIKED);
  savedPaint();
}
// The shell's list picker (every list, a tick where the item is, a new one),
// opened over the control that asked for it.
function pickLists(item, el) {
  var p = window.parent, f = window.frameElement, r = el.getBoundingClientRect();
  if (!f || typeof p.savedPickLists !== 'function') return;
  var o = f.getBoundingClientRect();
  p.savedPickLists(item, { left: o.left + r.left, right: o.left + r.right, top: o.top + r.top, bottom: o.top + r.bottom });
}
// Where you are in a long thread you saved, as a share of the way down, so it
// opens there again on any screen: written once the scroll settles, and
// threadRestore() as the thread is drawn. A thread under two screens tall
// has no place worth keeping.
var THREAD_MIN_SCREENS = 2;
var THREAD_SETTLE_MS = 700;
var THREAD_TOP = 0.02;      // this near the top is the top: the place is let go
var _threadTimer = null;
function threadOf() { return _svItem && _svOpts.thread ? _svItem : null; }
function threadRoom() { return document.documentElement.scrollHeight - window.innerHeight; }
function threadWrite() {
  clearTimeout(_threadTimer); _threadTimer = null;
  var S = saved(), it = threadOf();
  if (!S || !it || !S.has(it) || threadRoom() < window.innerHeight * (THREAD_MIN_SCREENS - 1)) return;
  var f = Math.round(window.scrollY / threadRoom() * 1000) / 1000;
  if (f > THREAD_TOP) S.setPosition(it, { f: f });
  else if (S.position(it)) S.clearPosition(it);
}
function threadFlush() { if (_threadTimer) threadWrite(); }
function threadRestore() {
  var S = saved(), it = threadOf(), p = S && it && S.has(it) ? S.position(it) : null;
  if (p && p.where && p.where.f > 0) window.scrollTo(0, Math.round(p.where.f * threadRoom()));
}
window.addEventListener('scroll', function() {
  if (!threadOf()) return;
  clearTimeout(_threadTimer);
  _threadTimer = setTimeout(threadWrite, THREAD_SETTLE_MS);
}, { passive: true });
// A saved item's list chips for an app's Saved view: All, Liked and each list
// holding something of this app's, with how many. on is the list shown ('' all).
function savedListChips(app, on, fn) {
  var S = saved(), w = STR.sv || {};
  if (!S) return '';
  var chip = function(id, name, n) {
    return '<button type="button" class="chip tag' + (on === id ? ' on' : '') + '" aria-pressed="' + (on === id) + '" onclick="' + fn + '(' + J(id) + ')">' +
      esc(name) + ' <span class="n">' + n + '</span></button>';
  };
  var lists = S.lists({ app: app }).filter(function(l) { return l.count; });
  if (!lists.length) return '';
  return chip('', w.all, S.itemsFor({ app: app }).length) + lists.map(function(l) { return chip(l.id, l.builtin ? w.liked : l.name, l.count); }).join('');
}
// A value into an onclick attribute.
function J(v) { return JSON.stringify(v).replace(/"/g, '&quot;'); }
// A word to the shell (the app's address, its title, a door to the catalog).
// Silent while the shell itself is steering (Back and Forward), or every
// step would write the address the shell just restored.
var _fromShell = false;
function tell(msg) { if (_fromShell) return; try { if (window.parent !== window) window.parent.postMessage(msg, location.origin); } catch (e) {} }
// The shell steering the page: Back or Forward landed on an address of this
// app, and the page shows it without a reload. Each page sets window.__route.
window.addEventListener('message', function(e) {
  if (e.origin !== location.origin || !e.data) return;
  if (e.data.zimi === 'route' && typeof window.__route === 'function') {
    _fromShell = true;
    try { window.__route(e.data.id || ''); } finally { _fromShell = false; }
  } else if (e.data.zimi === 'home') {
    // The front page, whatever is open: the app's icon in the breadcrumb.
    try { if (typeof window.__home === 'function') window.__home(); } catch (err) {}
  } else if (e.data.zimi === 'random') {
    // The dice, inside the app: a video, a question, a post by chance.
    try { if (typeof window.__random === 'function') window.__random(); } catch (err) {}
  } else if (e.data.zimi === 'saved') {
    // What is kept changed: the page draws its own part of it again.
    try { if (typeof window.__saved === 'function') window.__saved(); } catch (err) {}
  } else if (e.data.zimi === 'back-request') {
    // The header's arrow: a step back inside the page (a list to the home),
    // or, at the home already, the word that lets the shell leave.
    var handled = false;
    try { handled = typeof window.__back === 'function' && !!window.__back(); } catch (err) { handled = false; }
    if (!handled) tell({ zimi: 'at-home' });
  }
});
// Back in the page's own chrome: the shell's history when it has a step to
// give back, the page's home otherwise.
// Where the page is: at its top (the shelves) or inside (a list, a thing).
// The shell shows its back arrow only inside, as it does for an article;
// the page reports whenever a view is shown or hidden.
var _topTold;
function tellTop() {
  var top = typeof window.__top === 'function' ? !!window.__top() : true;
  if (top === _topTold) return;
  _topTold = top;
  window.parent.postMessage({ zimi: 'top', top: top }, location.origin);
}
document.addEventListener('DOMContentLoaded', function() {
  new MutationObserver(function() { requestAnimationFrame(tellTop); }).observe(document.body, { attributes: true, attributeFilter: ['hidden'], subtree: true });
  tellTop();
});
// The shell's strings and the opening state, carried in the hash.
function strings(defaults) {
  try { var s = JSON.parse(decodeURIComponent(location.hash.slice(1) || '') || '{}'); for (var k in s) defaults[k] = s[k]; } catch (e) {}
  if (defaults.lang) document.documentElement.lang = defaults.lang;
  if (defaults.dir === 'rtl') document.documentElement.dir = 'rtl';
  return defaults;
}
// One or many, in the shell's words: "1 video", "12 videos".
function count(n, one, many) { return n + ' ' + (Number(n) === 1 ? one : many); }
// The way onward, pointing the way the text runs (see .chev in apps.css).
var CHEV = ' <span class="chev"></span>';
// A ZIM's own icon.
function zimIcon(zim, cls) { return '<img' + (cls ? ' class="' + cls + '"' : '') + ' src="' + esc(zpath(zim, '-/icon')) + '" alt="" loading="lazy">'; }
// Zimi's header steps aside while you read. The page tells the shell where
// it is scrolled to; the shell decides (down into the content hides the
// header, up or back near the top brings it back) and does the hiding, on
// a phone-sized screen only. appChrome.immersive(true) keeps it hidden
// until immersive(false): a video playing on a phone turned sideways. Any
// page the reader shows can say the same two things to the shell:
// {zimi: 'scroll', y} and {zimi: 'immersive', on}.
var appChrome = (function() {
  var ticking = false;
  window.addEventListener('scroll', function() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function() { ticking = false; tell({ zimi: 'scroll', y: Math.max(0, window.scrollY || 0) }); });
  }, { passive: true });
  return { immersive: function(on) { tell({ zimi: 'immersive', on: !!on }); } };
})();
// Back from a thing to its list lands where you were in the list, not at
// its top: keepPlace() as the thing opens from the list, returnToPlace()
// as it closes.
var _place = 0;
function keepPlace() { _place = window.scrollY || 0; }
function returnToPlace() { window.scrollTo(0, _place); _place = 0; }
