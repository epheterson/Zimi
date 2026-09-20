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
function tell(msg) { try { if (window.parent !== window) window.parent.postMessage(msg, location.origin); } catch (e) {} }
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
