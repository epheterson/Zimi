// ZimiGames' Sky Detective studies the real sky before it asks about it. The game is a page in the reader's frame and cannot
// draw the Almanac's sky itself (AlmanacSkyView lives in this document, almanac-sky.js), so it asks, and this draws the sky
// edge to edge over the page, names on, to drag around and pinch to zoom, and says when the player is done.
//
//   game -> Zimi   {zimi: 'game-sky', place: {lat, lon}, ms, title, hint, start, close, motion?, motionDenied?, az?, alt?, fov?, ring?}
//   Zimi -> game   {zimi: 'game-sky-done', started: bool}    (started: the primary button; false for close, Escape or a failure)
//
// `ms` is the moment to show (the page's "tonight at nine" is not always now): the time machine's instant (_almFocus) is set
// to it while the sky is up and put back after. `start` is the primary button's label (omitted: the sky is only looked at, and
// `close` is the one button). `ring` marks the middle of the view (the thing the answer was). Every string comes from the
// game, in the player's language; nothing here is new text. Loaded on first use after the Almanac's modules (app.js _gameSkyOpen).
//
// The sky follows the phone's motion the way the Almanac's Look does (it reads the sensors through almanac-look.js's own
// _lookReadOrientation, loaded with this file). iOS asks permission, and only in answer to a tap: `motion` is that button's
// label (shown only where the phone must be asked; everywhere else the sensors are simply listened to). A finger then trims
// the view (not on a view that shows an answer: that one is aimed); with no motion (a desktop, a denied ask) it turns the view, as before. `motionDenied` is said when iOS says no.
var ZimiGameSky = (function () {
  var FOV_MIN = 8, FOV_MAX = 120, FOV_START = 90, ALT_START = 35, ALT_MAX = 90, PINCH_MIN_PX = 4, WHEEL_ZOOM = 0.0015, KEY_TURN_FRACTION = 0.1, KEY_ZOOM = 1.25;
  var MOTION_WAIT_MS = 1500, NOW_TOLERANCE_MS = 10 * 60 * 1000, CSS_ID = 'gamesky-css', STR_MAX = 160;
  var open = null;

  var CSS = '.gamesky{position:fixed;inset:0;z-index:10003;background:#05070f;color:#f0f4fc;overscroll-behavior:contain;touch-action:none;user-select:none;-webkit-user-select:none}' +
    '.gamesky-host{position:absolute;inset:0}' +
    '.gamesky-top{position:absolute;left:0;right:0;top:0;padding:calc(env(safe-area-inset-top,0px) + 12px) 16px 24px;text-align:center;pointer-events:none;background:linear-gradient(#05070fcc,#05070f00)}' +
    '.gamesky-title{margin:0;font-size:15px;font-weight:600;text-wrap:balance}' +
    '.gamesky-hint{margin:4px 0 0;font-size:13px;opacity:.75;text-wrap:balance}' +
    '.gamesky-ring{position:absolute;left:50%;top:50%;width:56px;height:56px;margin:-28px 0 0 -28px;border:2.5px solid #f59e0b;border-radius:50%;pointer-events:none}' +
    '.gamesky-credit{position:absolute;left:12px;bottom:calc(env(safe-area-inset-bottom,0px) + 74px);font-size:11px;opacity:.55;pointer-events:none}' +
    '.gamesky-bar{position:absolute;left:0;right:0;bottom:0;display:flex;gap:10px;justify-content:center;padding:12px 16px calc(env(safe-area-inset-bottom,0px) + 14px);background:linear-gradient(#05070f00,#05070fe6)}' +
    '.gamesky-btn{min-height:46px;min-width:110px;padding:0 22px;border:1px solid #ffffff44;border-radius:999px;background:#141a2c;color:inherit;font:inherit;font-weight:600;cursor:pointer}' +
    '.gamesky-btn.primary{border-color:transparent;background:#f59e0b;color:#1a1100}' +
    '.gamesky-note{position:absolute;left:0;right:0;bottom:calc(env(safe-area-inset-bottom,0px) + 74px);margin:0;text-align:center;font-size:13px;pointer-events:none;text-shadow:0 1px 3px #000}' +
    '.gamesky-btn:focus-visible{outline:2px solid #fff;outline-offset:3px}';

  // Motion needs the sensors and a secure page; where iOS must be asked, only a tap may ask.
  function motionAvailable() { return typeof _lookReadOrientation === 'function' && _lookHasSensors(); }
  function motionAsks() { return motionAvailable() && _lookNeedsPermission(); }
  function str(v) { return typeof v === 'string' ? v.slice(0, STR_MAX) : ''; }
  function num(v, fallback) { return typeof v === 'number' && isFinite(v) ? v : fallback; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }

  // The sky is shown for `ms`: the page's clock when that is now, the time machine's instant when it is not.
  function pinInstant(ms) {
    if (typeof _almFocus === 'undefined') return function () {};
    var before = _almFocus;
    _almFocus = Math.abs(ms - Date.now()) < NOW_TOLERANCE_MS ? null : new Date(ms);
    return function () { _almFocus = before; };
  }

  // The sky is a step in history, like the game's sheets: the browser's Back and Zimi's back arrow close it and stay in the game.
  // `fromHistory`: the browser already took the step; otherwise it is taken back here and the router is told to let it be.
  var swallow = false;
  function pop(e) {
    if (swallow) { swallow = false; return true; }
    if (open && !(e.state && e.state.gamesky)) { close(false, true); return true; }
    return false;
  }
  function close(started, fromHistory) {
    var o = open;
    if (!o) return;
    open = null;
    if (fromHistory !== true && history.state && history.state.gamesky) { swallow = true; history.back(); }
    document.removeEventListener('keydown', o.keys, true);
    o.stopMotion();
    try { AlmanacSkyView.unmount(o.host); } catch (e) { /* already gone */ }
    o.restore();
    if (o.root.parentNode) o.root.parentNode.removeChild(o.root);
    if (o.opener && o.opener.focus) try { o.opener.focus(); } catch (e) { /* gone */ }
    o.answer(!!started);
  }

  function openSky(d, answer) {
    var lat = num(d.place && d.place.lat, NaN), lon = num(d.place && d.place.lon, NaN);
    if (open) close(false);
    if (!isFinite(lat) || !isFinite(lon) || typeof AlmanacSkyView === 'undefined') { answer(false); return; }
    if (!document.getElementById(CSS_ID)) { var st = el('style'); st.id = CSS_ID; st.textContent = CSS; document.head.appendChild(st); }
    var root = el('div', 'gamesky'), host = el('div', 'gamesky-host'), top = el('div', 'gamesky-top'), bar = el('div', 'gamesky-bar');
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', str(d.title));
    top.appendChild(el('p', 'gamesky-title', str(d.title)));
    if (d.hint) top.appendChild(el('p', 'gamesky-hint', str(d.hint)));
    var closeBtn = el('button', 'gamesky-btn' + (d.start ? '' : ' primary'), str(d.close)), startBtn = d.start ? el('button', 'gamesky-btn primary', str(d.start)) : null;
    closeBtn.type = 'button'; bar.appendChild(closeBtn);
    if (startBtn) { startBtn.type = 'button'; bar.appendChild(startBtn); }
    var motionBtn = null;
    if (!d.ring && motionAsks() && d.motion) { motionBtn = el('button', 'gamesky-btn', str(d.motion)); motionBtn.type = 'button'; bar.insertBefore(motionBtn, bar.firstChild); }
    root.appendChild(host); root.appendChild(top);
    if (d.ring) root.appendChild(el('div', 'gamesky-ring'));
    root.appendChild(bar);
    document.body.appendChild(root);

    var restore = pinInstant(num(d.ms, Date.now()));
    if (!AlmanacSkyView.mount(host, { lat: lat, lon: lon, name: '' })) { restore(); root.remove(); answer(false); return; }
    var credit = AlmanacSkyView.credit && AlmanacSkyView.credit();
    if (credit) root.appendChild(el('p', 'gamesky-credit', credit));
    var view = { az: num(d.az, lat >= 0 ? 180 : 0), alt: num(d.alt, ALT_START), fov: num(d.fov, FOV_START) };
    var motion = null;   // the phone's reading while it drives the view: {sn, target, smooth, trim, raf, last, got, on, off, wait}
    function apply() {
      view.fov = Math.max(FOV_MIN, Math.min(FOV_MAX, view.fov)); view.alt = Math.max(-ALT_MAX, Math.min(ALT_MAX, view.alt));
      AlmanacSkyView.setView(host, view.az, view.alt, view.fov);
    }
    // A turn by hand: the view itself, or a trim on top of the phone's reading when the phone is steering.
    function turnBy(dAz, dAlt) {
      var tgt = motion && motion.got ? motion.trim : view;
      tgt.az += dAz; tgt.alt += dAlt;
      if (motion && tgt === motion.trim) follow();
      apply();
    }
    // The view takes a step toward the reading plus the trim; another frame only while it is still moving.
    function follow() {
      if (!motion || !motion.got || motion.raf) return;
      motion.raf = requestAnimationFrame(function (ts) {
        motion.raf = 0;
        var dt = motion.last ? Math.min(ts - motion.last, LOOK_MAX_STEP_MS) : 16;
        motion.last = ts;
        motion.smooth = _lookSmooth(motion.smooth, motion.target, dt, LOOK_SMOOTH_TAU_MS);
        var az = _lookNorm360(motion.smooth.az + motion.trim.az), alt = _lookClamp(motion.smooth.alt + motion.trim.alt, -ALT_MAX, ALT_MAX);
        var moving = Math.abs(_lookDelta(view.az, az)) > LOOK_SETTLED_DEG || Math.abs(view.alt - alt) > LOOK_SETTLED_DEG;
        view.az = az; view.alt = alt; apply();
        if (moving) follow(); else motion.last = 0;
      });
    }
    function stopMotion() {
      if (!motion) return;
      window.removeEventListener('deviceorientationabsolute', motion.onAbs); window.removeEventListener('deviceorientation', motion.onRel);
      clearTimeout(motion.wait); if (motion.raf) cancelAnimationFrame(motion.raf);
      motion = null;
    }
    function listenMotion() {
      if (motion || !motionAvailable()) return;
      var m = motion = { sn: _lookNewSensing(), target: null, smooth: null, trim: { az: 0, alt: 0 }, raf: 0, last: 0, got: false };
      var read = function (e, absolute) {
        if (motion !== m) return;
        var r = _lookReadOrientation(m.sn, e, absolute);
        if (!r) return;
        m.target = { az: r.view.az, alt: r.view.alt, roll: 0 };
        if (!m.got) { m.got = true; m.smooth = null; clearTimeout(m.wait); if (motionBtn) motionBtn.hidden = true; }
        follow();
      };
      m.onAbs = function (e) { read(e, true); }; m.onRel = function (e) { read(e, false); };
      window.addEventListener('deviceorientationabsolute', m.onAbs); window.addEventListener('deviceorientation', m.onRel);
      // A device with no sensor never answers: the view stays a finger's, and the button stays for a retry.
      m.wait = setTimeout(function () { if (motion === m && !m.got) stopMotion(); }, MOTION_WAIT_MS);
    }
    function say(text) {
      var n = root.querySelector('.gamesky-note') || root.appendChild(el('p', 'gamesky-note'));
      n.textContent = str(text);
    }
    if (motionBtn) motionBtn.addEventListener('click', function () {
      _lookAskSensors().then(function (r) {
        if (!open || open.root !== root) return;
        if (r === 'granted') listenMotion(); else { motionBtn.hidden = true; if (d.motionDenied) say(d.motionDenied); }
      });
    });
    var keys = function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Tab') {   // aria-modal does not hold focus: keep it on the dialog's own buttons
        var btns = root.querySelectorAll('button');
        if (!btns.length) return;
        var first = btns[0], lastBtn = btns[btns.length - 1];
        if (!root.contains(document.activeElement) || (e.shiftKey && document.activeElement === first)) { e.preventDefault(); lastBtn.focus(); }
        else if (!e.shiftKey && document.activeElement === lastBtn) { e.preventDefault(); first.focus(); }
        return;
      }
      var step = view.fov * KEY_TURN_FRACTION;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); return; }
      else if (e.key === 'ArrowLeft') turnBy(-step, 0); else if (e.key === 'ArrowRight') turnBy(step, 0);
      else if (e.key === 'ArrowUp') turnBy(0, step); else if (e.key === 'ArrowDown') turnBy(0, -step);
      else if (e.key === '+' || e.key === '=') view.fov /= KEY_ZOOM; else if (e.key === '-' || e.key === '_') view.fov *= KEY_ZOOM;
      else return;
      e.preventDefault(); apply();
    };
    document.addEventListener('keydown', keys, true);
    history.pushState(Object.assign({}, history.state, { gamesky: 1 }), '', location.href);
    open = { root: root, host: host, restore: restore, answer: answer, keys: keys, opener: document.activeElement, apply: apply, stopMotion: stopMotion };
    apply();
    if (!motionBtn && !d.ring) listenMotion();   // nothing to ask: listen at once

    // One finger turns the view (the sky follows the finger), two zoom, the wheel zooms.
    var pts = {}, last = 0;
    function span() { var k = Object.keys(pts); return k.length === 2 ? Math.hypot(pts[k[0]].x - pts[k[1]].x, pts[k[0]].y - pts[k[1]].y) : 0; }
    host.addEventListener('pointerdown', function (e) { pts[e.pointerId] = { x: e.clientX, y: e.clientY }; last = span(); try { host.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ } });
    host.addEventListener('pointermove', function (e) {
      var p = pts[e.pointerId];
      if (!p) return;
      var dx = e.clientX - p.x, dy = e.clientY - p.y, n = Object.keys(pts).length, perPx = view.fov / Math.max(1, host.clientWidth);
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (n === 1) turnBy(-dx * perPx, dy * perPx);
      else { var s = span(); if (last > PINCH_MIN_PX && s > PINCH_MIN_PX) view.fov *= last / s; last = s; }
      apply();
    });
    function lift(e) { delete pts[e.pointerId]; last = span(); }
    host.addEventListener('pointerup', lift); host.addEventListener('pointercancel', lift);
    host.addEventListener('wheel', function (e) { e.preventDefault(); view.fov *= Math.exp(e.deltaY * WHEEL_ZOOM); apply(); }, { passive: false });
    closeBtn.addEventListener('click', function () { close(false); });
    if (startBtn) startBtn.addEventListener('click', function () { close(true); });
    (startBtn || closeBtn).focus({ preventScroll: true });
  }

  window.addEventListener('resize', function () { if (open) { AlmanacSkyView.resize(open.host); open.apply(); } });

  return { open: openSky, pop: pop, close: function () { close(false); }, isOpen: function () { return !!open; } };
})();
