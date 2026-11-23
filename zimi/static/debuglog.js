// The server's debug log, client half (zimi/debuglog.py). Fetched only while the server keeps a debug log (app.js _debugLogHeard):
// records what the person taps and what the app does, and posts it to /debuglog every few seconds and when the page is left.
// Never an input's value, a password, or what is typed: a tapped field is named by its type and id only.
var _dbl = (function () {
  var FLUSH_MS = 4000, MAX_QUEUE = 500, MAX_BATCH_BYTES = 40000, SLOW_FRAME_MS = 100, SLOW_GAP_MS = 250, VIEW_POLL_MS = 1000, TEXT_MAX = 40;
  var q = [], timer = null, viewTimer = null, raf = 0, on = false, lastView = '', lastSlow = 0, undo = [];

  function rec(k, fields) {
    if (!on) return;
    var e = { t: Date.now(), k: k };
    for (var p in fields) e[p] = fields[p];
    q.push(e);
    if (q.length > MAX_QUEUE) q.shift();
  }

  var CONTROL_SEL = 'button,a,summary,label,[role=button],[onclick]';
  // What was tapped, in words: tag#id.class "visible text". The nearest thing a person would call a control.
  function describe(el) {
    var c = el && el.closest ? el.closest(CONTROL_SEL + ',input,select,textarea,[id]') : null;
    c = c || el;
    if (!c || !c.tagName) return '?';
    var tag = c.tagName.toLowerCase(), s = tag;
    if (c.id) s += '#' + c.id;
    if (c.classList && c.classList.length) s += '.' + Array.prototype.slice.call(c.classList, 0, 3).join('.');
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return s + (c.type ? '[' + c.type + ']' : '') + (c.name ? '[name=' + c.name + ']' : '');
    // Words come from a control, never from a bare container that merely has an id: a tapped panel's text can hold a token.
    var isControl = c.matches && c.matches(CONTROL_SEL);
    var txt = (c.getAttribute('aria-label') || c.title || (isControl ? c.textContent : '') || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
    if (txt) s += ' "' + txt + '"';
    if (tag === 'a' && c.getAttribute('href')) s += ' ->' + c.getAttribute('href').split('?')[0].slice(0, 80);
    return s;
  }
  function onTap(e, where) {
    rec('tap', { el: describe(e.target), x: Math.round(e.clientX), y: Math.round(e.clientY), in: where });
  }
  function onErr(e) { rec('error', { msg: String(e.message || e.error || e).slice(0, 300), at: (e.filename || '').split('/').pop() + ':' + (e.lineno || 0) }); }
  function onRej(e) { var r = e.reason; rec('rejection', { msg: String((r && r.message) || r).slice(0, 300) }); }
  function nav() { rec('nav', { url: location.pathname + location.search.slice(0, 80) + location.hash.slice(0, 120) }); }

  // The view on screen, as app.js keeps it: logged when it changes.
  function viewNow() {
    var v = [];
    try { if (typeof mode !== 'undefined') v.push('mode=' + mode); } catch (e) {}
    try { if (typeof readerOpen !== 'undefined' && readerOpen) v.push('reader=' + ((currentArticle && (currentArticle.zim + '/' + currentArticle.path)) || '?')); } catch (e) {}
    try { if (typeof _almanacOpen !== 'undefined' && _almanacOpen) v.push('almanac'); } catch (e) {}
    return v.join(' ');
  }
  function pollView() { var v = viewNow(); if (v !== lastView) { lastView = v; rec('view', { v: v }); } }

  // A page inside the reader frame (an article, a game, an app) has its own document: taps and errors there too.
  function hookFrame(f) {
    try {
      var d = f.contentDocument, w = f.contentWindow;
      if (!d || !w || d.__dbl) return;
      d.__dbl = 1;
      d.addEventListener('click', function (e) { onTap(e, 'frame'); }, true);
      w.addEventListener('error', onErr);
      w.addEventListener('unhandledrejection', onRej);
      rec('frame', { url: String(w.location.pathname).slice(0, 160) });
    } catch (e) {}
  }
  function onLoadCapture(e) { if (e.target && e.target.id === 'reader-frame') hookFrame(e.target); }

  function wrapConsole(name) {
    var orig = console[name];
    console[name] = function () {
      try { rec('console.' + name, { msg: Array.prototype.map.call(arguments, function (a) { return a && a.message ? a.message : typeof a === 'object' ? '[object]' : String(a); }).join(' ').slice(0, 300) }); } catch (e) {}
      return orig.apply(this, arguments);
    };
    undo.push(function () { console[name] = orig; });
  }
  function wrapHistory(name) {
    var orig = history[name];
    history[name] = function () { var r = orig.apply(this, arguments); nav(); return r; };
    undo.push(function () { history[name] = orig; });
  }

  // Frames that took longer than SLOW_FRAME_MS (a stall the person felt), at most one line per SLOW_GAP_MS.
  function frame(now) {
    if (!on) return;
    if (frame.last && !document.hidden && now - frame.last > SLOW_FRAME_MS && now - lastSlow > SLOW_GAP_MS) { lastSlow = now; rec('slow', { ms: Math.round(now - frame.last) }); }
    frame.last = document.hidden ? 0 : now;
    raf = requestAnimationFrame(frame);
  }

  function client() { try { return _liveClient; } catch (e) { return ''; } }
  function take() {
    var out = [], size = 0;
    while (q.length && size < MAX_BATCH_BYTES) { var s = JSON.stringify(q[0]); size += s.length + 1; out.push(q.shift()); }
    return out;
  }
  function flush(leaving) {
    if (!q.length) return;
    var batch = take(), body = JSON.stringify({ client: client(), events: batch });
    if (leaving && navigator.sendBeacon) {
      // A refused beacon keeps its batch for the next flush; only an accepted one goes on to the rest.
      if (!navigator.sendBeacon('/debuglog', new Blob([body], { type: 'application/json' }))) { q = batch.concat(q).slice(-MAX_QUEUE); return; }
      if (q.length) flush(true);
      return;
    }
    fetch('/debuglog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).then(function (r) {
      if (r.status === 404) stop(); // the server's log was turned off
      else if (r.status === 429 || r.status >= 500) q = batch.concat(q).slice(-MAX_QUEUE); // try again with the next flush
    }).catch(function () { q = batch.concat(q).slice(-MAX_QUEUE); });
    if (q.length) flush(false);
  }
  function onHide() { if (document.visibilityState === 'hidden') flush(true); }
  function onPageHide() { flush(true); }
  function onTapDoc(e) { onTap(e, 'page'); }

  function start() {
    if (on) return;
    on = true; window._dblOn = true;
    try { if (typeof _aeDbgOn !== 'undefined') _aeDbgOn = true; } catch (e) {} // the 3D log (almanac-debug3d.js) feeds this one
    rec('start', { url: location.href.slice(0, 200), vw: innerWidth, vh: innerHeight, dpr: window.devicePixelRatio, touch: 'ontouchstart' in window, ua: navigator.userAgent.slice(0, 160) });
    document.addEventListener('click', onTapDoc, true);
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);
    window.addEventListener('hashchange', nav);
    window.addEventListener('popstate', nav);
    document.addEventListener('load', onLoadCapture, true);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    ['warn', 'error'].forEach(wrapConsole);
    ['pushState', 'replaceState'].forEach(wrapHistory);
    var f = document.getElementById('reader-frame'); if (f) hookFrame(f);
    timer = setInterval(function () { flush(false); }, FLUSH_MS);
    viewTimer = setInterval(pollView, VIEW_POLL_MS);
    frame.last = 0; raf = requestAnimationFrame(frame);
  }
  function stop() {
    if (!on) return;
    flush(true);
    on = false; window._dblOn = false;
    try { if (typeof _aeDbgOn !== 'undefined') _aeDbgOn = (typeof _aeDbgDevice !== 'undefined' && _aeDbgDevice); } catch (e) {}
    document.removeEventListener('click', onTapDoc, true);
    window.removeEventListener('error', onErr);
    window.removeEventListener('unhandledrejection', onRej);
    window.removeEventListener('hashchange', nav);
    window.removeEventListener('popstate', nav);
    document.removeEventListener('load', onLoadCapture, true);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onPageHide);
    undo.forEach(function (u) { u(); }); undo = [];
    clearInterval(timer); clearInterval(viewTimer); cancelAnimationFrame(raf);
    q = [];
  }
  return { start: start, stop: stop, rec: rec, flush: flush, describe: describe, get on() { return on; } };
})();
