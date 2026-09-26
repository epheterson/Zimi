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
