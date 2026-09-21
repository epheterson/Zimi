// The apps' shared script: the few helpers every app page needs (ZimiTube,
// ZimiExchange, Reddot), inlined into each page by the server beside
// apps.css (see http._inline_apps_assets), so a page is still one document
// and a fix here reaches every app.
function esc(x) { return String(x == null ? '' : x).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
// A ZIM entry's address in Zimi.
function zpath(zim, p) { return '/w/' + encodeURIComponent(zim) + '/' + String(p).split('/').map(encodeURIComponent).join('/'); }
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
  if (e.origin !== location.origin || !e.data || e.data.zimi !== 'route' || typeof window.__route !== 'function') return;
  _fromShell = true;
  try { window.__route(e.data.id || ''); } finally { _fromShell = false; }
});
// Back in the page's own chrome: the shell's history when it has a step to
// give back, the page's home otherwise.
function goBack(home) { if (window.history.length > 1 && !_fromShell) { tell({ zimi: 'back' }); } home(); }
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
