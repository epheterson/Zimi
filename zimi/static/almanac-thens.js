// ── Almanac: there and then ──
// A curated list of moments worth standing in (zimi/static/earth/thens-v1.json, built by scripts/build_thens.cjs and checked against the
// Almanac's own ephemeris by tests/test_almanac_thens.cjs): the place, the instant and the way to face. It lives in the Launches sheet
// (almanac-launches.js draws the sheet and asks this file for the body of its "thens" view), loaded with it on the button's first press.
// One tap stands there then: the ground view where the body is supported, else the live sky.
// Shares the Almanac's global scope; every name here is _at* or AT_*.

var AT_URL = '/static/earth/thens-v1.json';
var AT_GROUPS = ['spaceflight', 'sky', 'history', 'places'];
var AT_FACE_UP_DEG = 8;                    // the ground view is turned so the thing stands this far above the middle of the screen
var AT_FACE_MAX_DEG = 70;
var AT_FACE_WAIT_MS = 250, AT_FACE_TRIES = 120;
var AT_SKY_SETTLE_MS = 400;
var AT_DATE_OPTS = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
var AT_ICON = '<path d="M12 3l2.4 5.6 6.1.5-4.6 4 1.4 6-5.3-3.2L6.7 19l1.4-6-4.6-4 6.1-.5z"/>';
var AT_ICON_BACK = '<path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/>';

var _alThenAt = { data: null, state: 'idle', query: '', open: null };

function _atSvg(path, size) {
  var s = size || 16;
  return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
}
function _atLoad() {
  if (_alThenAt.state === 'ready') return Promise.resolve();
  if (_alThenAt.state === 'loading') return _alThenAt.promise;
  _alThenAt.state = 'loading';
  _alThenAt.promise = _aeFetch(AT_URL).then(_aeJson).then(function (d) { _alThenAt.data = d; _alThenAt.state = 'ready'; }).catch(function (e) { _alThenAt.state = 'failed'; throw e; });
  return _alThenAt.promise;
}
function _alThenAtTitle(m) { return _aeT('then_' + m.id.replace(/-/g, '_')); }
function _atSeeText(m) {
  if (m.launch && m.see !== 'train') return _aeT('alm_launch_sight_' + m.see);
  return _aeT('then_see_' + m.see);
}
function _atBody(m) { return m.place.body || 'earth'; }
function _atWhen(m) {
  var tz = _atBody(m) === 'earth' && typeof _almTzForLocation === 'function' ? _almTzForLocation(m.place.lat, m.place.lon) : 'UTC';   // another body has no zone: UTC
  try { return (tz ? _tzFmt(tz, AT_DATE_OPTS) : new Intl.DateTimeFormat(undefined, AT_DATE_OPTS)).format(new Date(m.instant)); } catch (e) { return new Date(m.instant).toISOString(); }
}
function _atYear(m) { return String(new Date(m.instant).getUTCFullYear()); }
function _atMatches(m, q) {
  if (!q) return true;
  var hay = (_alThenAtTitle(m) + ' ' + m.place.name + ' ' + _atYear(m)).toLowerCase();
  return q.toLowerCase().split(/\s+/).every(function (w) { return hay.indexOf(w) >= 0; });
}

// ── The body of the sheet ──
function _atHtml() {
  if (_alThenAt.state === 'failed') return '<h3>' + _almEsc(_aeT('then_title')) + '</h3><p>' + _almEsc(_aeT('alm_launch_unavailable')) + '</p>';
  if (_alThenAt.state !== 'ready') return '<h3>' + _almEsc(_aeT('then_title')) + '</h3><p class="al-note" aria-busy="true">…</p>';
  return _alThenAt.open ? _atDetailHtml(_alThenAt.open) : _atListHtml();
}
function _atHeader(title) {
  return '<button type="button" class="al-back" id="at-back" aria-label="' + _almEsc(_aeT('alm_launches')) + '">' + _atSvg(AT_ICON_BACK, 18) + '</button><h3>' + _almEsc(title) + '</h3>';
}
function _atListHtml() {
  var html = _atHeader(_aeT('then_title')) + '<div class="al-filters"><label>' + _atSvg('<circle cx="11" cy="11" r="6"/><path d="M16 16l5 5"/>') +
    '<input id="at-q" type="search" value="' + _almEsc(_alThenAt.query) + '" aria-label="' + _almEsc(_aeT('then_search')) + '" placeholder="' + _almEsc(_aeT('then_search')) + '"></label></div>', any = false;
  AT_GROUPS.forEach(function (g) {
    var rows = _alThenAt.data.moments.filter(function (m) { return m.family === g && _atMatches(m, _alThenAt.query); });
    if (!rows.length) return;
    any = true;
    html += '<h4 class="at-group">' + _almEsc(_aeT('then_group_' + g)) + '</h4>';
    rows.forEach(function (m) {
      html += '<button type="button" class="al-row at-row" data-id="' + _almEsc(m.id) + '"><i class="al-dot"></i><b>' + _almEsc(_alThenAtTitle(m)) + '</b><span>' + _almEsc(_atYear(m)) + '</span>' +
        '<span class="al-sub">' + _almEsc(m.place.name) + '</span></button>';
    });
  });
  if (!any) html += '<p>' + _almEsc(_aeT('then_none')) + '</p>';
  return html;
}
// Whether the ground view can run here (no WebGL2, no ground: the list and each entry's facts still stand).
function _atGround() { return typeof _os3DAvailable !== 'function' || _os3DAvailable(); }
function _atDetailHtml(m) {
  return _atHeader(_alThenAtTitle(m)) + '<ul class="al-facts">' +
    '<li>' + _atSvg('<path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4"/>') + '<span>' + _almEsc(_atWhen(m)) + '</span></li>' +
    '<li>' + _atSvg('<path d="M12 21.5s-6.5-6.2-6.5-11.3a6.5 6.5 0 0 1 13 0c0 5.1-6.5 11.3-6.5 11.3z"/><circle cx="12" cy="10.2" r="2.3"/>') + '<span>' + _almEsc(m.place.name) + '</span></li>' +
    '<li>' + _atSvg(AT_ICON) + '<span>' + _almEsc(_atSeeText(m)) + '</span></li></ul>' +
    '<p class="al-note">' + _almEsc(m.notes) + '</p>' +
    (_atGround() ? '' : '<p class="al-note" id="at-no3d">' + _almEsc(_aeT('then_no_3d')) + '</p>') +
    '<div class="al-acts"><button type="button" class="ae-btn" id="at-stand"' + (_atGround() ? '' : ' disabled') + '>' + _atSvg('<circle cx="12" cy="5" r="2.2"/><path d="M12 8v7M8 11l4-1 4 1M9.5 21l2.5-6 2.5 6"/>', 18) + _almEsc(_aeT('then_stand')) + '</button>' +
    (_atBody(m) === 'earth' ? '<button type="button" class="ae-btn" id="at-sky">' + _atSvg('<path d="M3 18c4-9 10-13 18-13"/><circle cx="12" cy="10" r="1.8" fill="currentColor" stroke="none"/>', 18) + _almEsc(_aeT('then_live_sky')) + '</button>' : '') + '</div>' +
    '<p class="al-note">' + m.refs.map(function (r) { return '<a href="' + _almEsc(r) + '" target="_blank" rel="noopener noreferrer">' + _almEsc(m.source.name) + '</a>'; }).slice(0, 1).join('') + '</p>';
}
function _atBind() {
  var el = _al.sheetEl, back = _aeById('at-back');
  if (back) back.onclick = function () { if (_alThenAt.open) { _alThenAt.open = null; _alRender(); } else { _al.view = 'list'; _alRender(); } };
  var q = _aeById('at-q');
  if (q) q.oninput = function () { _alThenAt.query = this.value; var pos = this.selectionStart; _alRender(); var n = _aeById('at-q'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } };
  Array.prototype.forEach.call(el.querySelectorAll('.at-row'), function (b) {
    b.onclick = function () { _alThenAt.open = _alThenAt.data.moments.filter(function (m) { return m.id === b.getAttribute('data-id'); })[0]; _alRender(); };
  });
  var st = _aeById('at-stand'), sk = _aeById('at-sky');
  if (st) st.onclick = function () { _atGo(_alThenAt.open, 'stand'); };
  if (sk) sk.onclick = function () { _atGo(_alThenAt.open, 'sky'); };
}

// ── Going there ──
// Turn the ground view to face `look` once it has arrived.
function _atFace(look) {
  var tries = 0;
  (function wait() {
    var st = typeof _ae !== 'undefined' && _ae && _ae.stand;
    if (st && st.mode === 'ground') {
      st.userYaw = look.az * Math.PI / 180 - st.yaw;
      st.userPitch = Math.max(0, Math.min(AT_FACE_MAX_DEG, look.el - AT_FACE_UP_DEG)) * Math.PI / 180 - AE_STAND_PITCH_DEG * Math.PI / 180;
      st.dirty = true; _ae.dirty = true;
    } else if (++tries < AT_FACE_TRIES) setTimeout(wait, AT_FACE_WAIT_MS);
  })();
}
// A launch's moment selects the launch, so its rocket and batch are drawn where the view looks.
function _atSelectLaunch(m) {
  if (!m.launch || _al.state !== 'ready') return;
  for (var i = 0; i < _al.rows.length; i++) if (_al.rows[i][15] === m.launch) { _alSelect(i); return; }
}
// Stand there then: the clock at the instant (held, to look at), the place, the direction. 'stand' is the ground view where it is there
// (the Earth), 'sky' the live sky at the place.
function _atGo(m, how) {
  _atSelectLaunch(m);
  _aeGoTo(m.instant);
  if (typeof _almClockSetRate === 'function') _almClockSetRate(0);
  if ((how === 'stand' || _atBody(m) !== 'earth') && typeof _aeStandAt === 'function') {
    _alHideSheet();
    Promise.resolve(_aeStandAt(_atBody(m), m.place.lat, m.place.lon)).then(function (ok) { if (ok !== false) { if (_atBody(m) === 'earth') { _alStandRegister(); if (typeof _osStandClouds === 'function') _osStandClouds('clear'); } _atFace(m.look); } });
    return;
  }
  if (typeof _almLinkPlace !== 'undefined') _almLinkPlace = { lat: m.place.lat, lon: m.place.lon };
  _aeClose();
  setTimeout(function () {
    if (typeof _renderAlmanacContent === 'function') _renderAlmanacContent();
    var cv = typeof _skyState !== 'undefined' && _skyState && _skyState.canvas;
    if (cv && cv.scrollIntoView) cv.scrollIntoView({ block: 'center' });
    _alKick();
  }, AT_SKY_SETTLE_MS);
}
