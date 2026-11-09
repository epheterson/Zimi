// ── Almanac: the sky you remember ──
// Every orbital launch ever tried (launches.py, McDowell's GCAT), loaded on the Launches button's first press and never
// otherwise. A launch opens at its pad at lift-off on the clock; its ascent is drawn in the 3D Earth (and, from a place
// that could see it, in the live sky); the satellites it left are drawn as they were, either reconstructed from the
// launch's orbit (almanac-launchflight.js) or exact, from the person's own Space-Track login. "From here" and "From the
// pad" put the place and the time in the live sky.
// Shares almanac-earth.js's global scope: its helpers (_aeT, _aeFlyTo, _aeGoTo, _aePointCloud ...) and the page's
// (_getLocation, _almLinkPlace, _tzFmt ...). The maths is almanac-launchflight.js's.

// ── The data ──
var AL_URL = '/almanac-launches';
var AL_COLS = ['t', 'veh', 'pad', 'mission', 'ok', 'perigee', 'apogee', 'inc', 'az', 'n', 'names', 'sepMin', 'odays', 'operi', 'oapo', 'tag'];   // launches.py COLUMNS
var AL_MS_PER_MIN = 60000;
var AL_ROWS_MAX = 250;                       // the list draws this many rows; a longer one asks for a narrower filter
var AL_BATCH_MIN = 4, AL_BATCH_MAX = 130;    // launches.py MIN_BATCH; the most satellites drawn from one launch
var AL_DEP_DEFAULT_KM = 300, AL_DEP_MIN_KM = 200, AL_DEP_MAX_KM = 2000;
var AL_DEP_ORBIT_DAYS = 4;                   // GCAT's catalogued orbit is the deployment's if it is dated within this many days of lift-off
// ── Seen from a place ──
var AL_WINDOW_HOURS = 72, AL_WINDOW_STEP_S = 30, AL_WINDOWS_SHOWN = 3;
var AL_TRAIL_S = 12, AL_TRAIL_STEP_S = 2;    // the rocket's trail in the sky: this far back, a point this often
// ── In the 3D view ──
var AL_FLY_TILT_RAD = 0.22;                  // the view looks this far south of the pad, so the pad sits above the sheet
var AL_FLY_DIST = 1.28;                      // Earth radii from the centre when the view comes to a pad: the ascent fits
var AL_TRACK_COLOR = 0xffc978, AL_TRACK_ALPHA = 0.8, AL_BOOSTER_COLOR = 0x9be7ff, AL_BOOSTER_ALPHA = 0.6;
var AL_ROCKET_COLOR = [1, 0.8, 0.5], AL_PLUME_COLOR = [0.7, 0.9, 1], AL_BOOSTER_POINT = [0.8, 0.95, 1];
var AL_DOT_COLOR = { recon: [1, 0.82, 0.45], exact: [0.62, 0.85, 1] }, AL_DOT_PX = 3, AL_ROCKET_PX = 7, AL_PLUME_PX = 30, AL_PLUME_ALPHA = 0.28;
var AL_UNLIT_ALPHA = 0.35;                   // what a satellite in the Earth's shadow keeps
var AL_BEFORE_S = 20;                        // the clock opens this long before lift-off in "From here", so the watcher is in place
var AL_SKY_RESCUE_MS = 400;                  // after the view closes, the page is given this long to settle before the sky is scrolled to
var AL_SRC = { recon: 'recon', exact: 'exact' };
var AL_SPACETRACK_URL = '/manage/spacetrack', AL_SPACETRACK_FETCH_URL = '/manage/spacetrack/fetch';
var AL_SEL_NONE = -1;

var _al = {
  state: 'idle', data: null, rows: null, years: [], sites: [], vehs: [],
  sheet: false, sheetEl: null, view: 'list', filter: { year: '', site: '', veh: '' },
  sel: AL_SEL_NONE, cur: null, flight: null, dep: null, depSource: AL_SRC.recon, exact: null, st: null,
  gl: null, track: null, boost: null, rocket: null, dots: null, scene: null, windows: null, sight: null
};

function _alOpen() { return _al.sheet; }
function _alLoad() {
  if (_al.state === 'loading' || _al.state === 'ready') return Promise.resolve();
  _al.state = 'loading';
  return _aeFetch(AL_URL).then(_aeJson).then(function (d) {
    _al.data = d;
    _al.rows = d.l;
    var yrs = {}, sites = {}, vehs = {};
    d.l.forEach(function (r) {
      var y = new Date(r[0] * AL_MS_PER_MIN).getUTCFullYear(), site = d.pads[r[2]][2];
      yrs[y] = 1; sites[site] = (sites[site] || 0) + 1; vehs[r[1]] = (vehs[r[1]] || 0) + 1;
    });
    _al.years = Object.keys(yrs).map(Number).sort(function (a, b) { return b - a; });
    _al.sites = Object.keys(sites).sort(function (a, b) { return sites[b] - sites[a] || (a < b ? -1 : 1); });
    _al.vehs = Object.keys(vehs).map(Number).sort(function (a, b) { return vehs[b] - vehs[a] || (d.veh[a] < d.veh[b] ? -1 : 1); });
    _al.state = 'ready';
  }).catch(function (e) { _al.state = 'failed'; throw e; });
}

// ── One launch ──
// A launch row as the maths wants it.
function _alLaunch(i) {
  var d = _al.data, r = _al.rows[i], pad = d.pads[r[2]], ms = r[0] * AL_MS_PER_MIN;
  return { i: i, ms: ms, name: d.veh[r[1]], mission: r[3], ok: !!r[4], perigeeKm: r[5], apogeeKm: r[6], incDeg: r[7], n: r[9], names: r[10] || [],
    sepMin: r[11], odays: r[12], operi: r[13], oapo: r[14], tag: r[15],
    lat: pad[3], lon: pad[4], siteName: pad[2], padName: pad[1], site: pad[0], country: pad[5] };
}
// The height a batch is let go at: GCAT's catalogued orbit when it is dated just after lift-off, else the launch's own.
function _alDeployKm(L) {
  var near = L.operi != null && L.oapo != null && L.odays != null && Math.abs(L.odays) <= AL_DEP_ORBIT_DAYS;
  var km = near ? (L.operi + L.oapo) / 2 : L.perigeeKm != null && L.apogeeKm != null ? (L.perigeeKm + L.apogeeKm) / 2 : AL_DEP_DEFAULT_KM;
  return Math.max(AL_DEP_MIN_KM, Math.min(AL_DEP_MAX_KM, km));
}
function _alHasBatch(L) { return L.n >= AL_BATCH_MIN && L.sepMin != null && L.incDeg != null && L.ok; }
function _alSelect(i) {
  var L = _alLaunch(i);
  _al.sel = i; _al.cur = L; _al.windows = null; _al.sight = null; _al.exact = null; _al.depSource = AL_SRC.recon;
  _al.flight = _lfAscent({ name: L.name, lat: L.lat, lon: L.lon, siteName: L.siteName, incDeg: L.incDeg, perigeeKm: L.perigeeKm, ok: L.ok });
  _al.dep = null;
  if (_alHasBatch(L)) {
    _al.dep = _lfDeploy({ mission: L.mission, inc: L.incDeg, n: Math.min(L.n, AL_BATCH_MAX), depKm: _alDeployKm(L) }, _al.flight, L.ms, L.sepMin);
  }
  var place = _alPlace();
  if (place) _al.sight = _lfObserve(_al.flight, L, L.ms, place.lat, place.lon);
  _alTrackBuild();
  _alKick();
}
function _alClear() {
  _al.sel = AL_SEL_NONE; _al.cur = null; _al.flight = null; _al.dep = null; _al.sight = null; _al.windows = null; _al.exact = null;
  _alTrackBuild();
  _alKick();
}
function _alKick() {
  if (typeof _ae !== 'undefined' && _ae) { _ae.dirty = true; if (typeof _aeKick === 'function') _aeKick(); }
  if (typeof _skyKick === 'function' && typeof _skyState !== 'undefined' && _skyState) _skyKick();
}
function _alPlace() {
  var p = typeof _getLocation === 'function' ? _getLocation() : null;
  return p && p.lat != null && p.stored ? { lat: p.lat, lon: p.lon } : null;
}

// ── Words ──
var AL_ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
function _alArrow(az) { return AL_ARROWS[Math.round(az / 45) % 8]; }
function _alZone() { return typeof _almDisplayTz === 'function' ? _almDisplayTz() : null; }
function _alFmt(ms, opts) {
  var tz = _alZone();
  try { return (tz ? _tzFmt(tz, opts) : new Intl.DateTimeFormat(undefined, opts)).format(new Date(ms)); } catch (e) { return new Date(ms).toISOString(); }
}
var AL_DATE_OPTS = { year: 'numeric', month: 'short', day: 'numeric' }, AL_TIME_OPTS = { hour: 'numeric', minute: '2-digit' }, AL_DAY_OPTS = { weekday: 'short', day: 'numeric', month: 'short' };
function _alDateText(ms) { return _alFmt(ms, AL_DATE_OPTS); }
function _alTimeText(ms) { return _alFmt(ms, AL_TIME_OPTS); }
function _alKm(n) { return _orrNum(Math.round(n), null, 0); }
function _alOrbitText(L) {
  var inc = L.incDeg != null ? ' · ' + _orrNum(L.incDeg, null, 1) + '°' : '';
  if (L.perigeeKm != null && L.apogeeKm != null && L.perigeeKm > 0) return _alKm(L.perigeeKm) + ' × ' + _alKm(L.apogeeKm) + ' km' + inc;
  return L.apogeeKm != null && L.apogeeKm > 0 ? _alKm(L.apogeeKm) + ' km' + inc : inc.slice(3);
}

// ── The sheet ──
var AL_CSS = [
  '.al-sheet{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(150px + env(safe-area-inset-bottom));width:min(440px,calc(100% - 32px));max-height:46vh;overflow-y:auto;overscroll-behavior:contain;box-sizing:border-box;background:rgba(18,18,20,.985);border:1px solid var(--border);border-radius:12px;padding:10px 12px;font-size:13px;color:var(--text2);pointer-events:auto}',
  '.al-sheet[hidden]{display:none}',
  '.al-sheet h3{margin:0 56px 8px 0;font-size:14px;font-weight:600;color:var(--text)}',
  '.al-x,.al-back{position:absolute;top:6px;background:none;border:0;color:var(--text2);font-size:20px;cursor:pointer;line-height:1;padding:4px 6px}',
  '.al-x{right:8px}.al-back{right:36px}',
  '.al-filters{display:flex;gap:6px;margin-bottom:6px}',
  '.al-filters label{flex:1 1 0;min-width:0;display:flex;align-items:center;gap:4px;color:var(--text2)}',
  '.al-filters svg{flex:none}',
  '.al-filters select{flex:1 1 0;min-width:0;width:100%;font:inherit;font-size:12.5px;color:var(--text);background:var(--surface,rgba(255,255,255,.06));border:1px solid var(--border);border-radius:8px;padding:5px 4px}',
  '.al-row{display:grid;grid-template-columns:12px 1fr auto;gap:1px 8px;width:100%;text-align:start;font:inherit;color:inherit;background:none;border:0;border-top:1px solid var(--border);padding:7px 0;cursor:pointer;align-items:baseline}',
  '.al-row:first-of-type{border-top:0}',
  '.al-row b{font-weight:600;color:var(--text);font-variant-numeric:tabular-nums}',
  '.al-row .al-sub{grid-column:2/4;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.al-dot{width:8px;height:8px;border-radius:50%;background:#7bd88f;align-self:center}',
  '.al-dot.bad{background:#ff7d6e}',
  '.al-note{margin:6px 0 0;font-size:11.5px;opacity:.8}',
  '.al-facts{margin:0 0 8px;padding:0;list-style:none}',
  '.al-facts li{display:flex;gap:8px;align-items:baseline;padding:2px 0}',
  '.al-facts svg{flex:none;opacity:.7;transform:translateY(3px)}',
  '.al-sight{margin:0 0 8px;padding:8px 10px;border-radius:9px;background:rgba(255,255,255,.06);color:var(--text)}',
  '.al-sight.no{color:var(--text2)}',
  '.al-acts{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 8px}',
  '.al-acts .ae-round{width:38px;height:38px;padding:0;display:inline-flex;align-items:center;justify-content:center}',
  '.al-src{display:flex;gap:6px;align-items:center;margin:0 0 6px}',
  '.al-src .ae-btn{font-size:12px;padding:4px 10px;min-height:28px}',
  '.al-win{display:grid;grid-template-columns:auto 1fr auto;gap:2px 10px;width:100%;text-align:start;font:inherit;color:inherit;background:none;border:0;border-top:1px solid var(--border);padding:6px 0;cursor:pointer;font-variant-numeric:tabular-nums}',
  '.al-win b{color:var(--text);font-weight:600}',
  '.al-st{display:grid;gap:6px;margin:6px 0}',
  '.al-st input{font:inherit;color:var(--text);background:var(--surface,rgba(255,255,255,.06));border:1px solid var(--border);border-radius:8px;padding:6px 8px;min-width:0}',
  '@media (orientation:landscape) and (max-height:500px){.al-sheet{bottom:calc(56px + env(safe-area-inset-bottom));max-height:70vh}}'
].join('');
var AL_ICON = {
  year: '<path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4"/>',
  site: '<path d="M12 21.5s-6.5-6.2-6.5-11.3a6.5 6.5 0 0 1 13 0c0 5.1-6.5 11.3-6.5 11.3z"/><circle cx="12" cy="10.2" r="2.3"/>',
  veh: '<path d="M12 2.5c3 2.6 4.3 6 4.3 9.6l-1.6 3.4H9.3l-1.6-3.4C7.7 8.5 9 5.1 12 2.5z"/><path d="M10.3 18.5v3M13.7 18.5v3"/>',
  orbit: '<circle cx="12" cy="12" r="9" opacity=".55"/><circle cx="17" cy="6.5" r="1.8" fill="currentColor" stroke="none"/>',
  pad: '<path d="M4 20h16M7 20V9l5-6 5 6v11"/>',
  eye: '<path d="M2 12s3.600-6.500 10-6.500S22 12 22 12s-3.600 6.500-10 6.500S2 12 2 12z"/><circle cx="12" cy="12" r="2.800"/>',
  stand: '<circle cx="12" cy="5" r="2.200"/><path d="M12 8v7M8 11l4-1 4 1M9.500 21l2.500-6 2.500 6"/>',
  dots: '<circle cx="5" cy="15" r="1.600" fill="currentColor" stroke="none"/><circle cx="10" cy="12" r="1.600" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.600" fill="currentColor" stroke="none"/><circle cx="20" cy="6" r="1.600" fill="currentColor" stroke="none"/>',
  path: '<path d="M4 20c1-9 6-14 16-16"/><circle cx="20" cy="4" r="1.500" fill="currentColor" stroke="none"/>'
};
function _alSvg(name, size) {
  var s = size || 16;
  return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + AL_ICON[name] + '</svg>';
}
function _alToggle() { if (_al.sheet) _alCloseSheet(); else _alOpenSheet(); }
function _alOpenSheet() {
  var host = _aeById('ae-view') || (_ae && _ae.el);
  if (!host) return;
  if (typeof _asCloseSheet === 'function') _asCloseSheet();
  if (!document.getElementById('al-style')) {
    var st = document.createElement('style');
    st.id = 'al-style';
    st.textContent = AL_CSS;
    document.head.appendChild(st);
  }
  if (!_al.sheetEl) {
    _al.sheetEl = document.createElement('div');
    _al.sheetEl.className = 'al-sheet';
    _al.sheetEl.setAttribute('role', 'dialog');
    _al.sheetEl.setAttribute('aria-label', _aeT('alm_launches'));
    host.appendChild(_al.sheetEl);
  }
  _al.sheet = true;
  _al.sheetEl.hidden = false;
  if (!_al.filter.year) _al.filter.year = String(new Date(_aeDisplayMs()).getUTCFullYear());
  _alRender();
  _alLoad().then(_alRender).catch(_alRender);
}
function _alCloseSheet() {
  _al.sheet = false;
  if (_al.sheetEl) _al.sheetEl.hidden = true;
  _alClear();
  if (typeof _aeMarkToggles === 'function') _aeMarkToggles();
}
function _alPlaceSheet() {
  var el = _al.sheetEl, views = _aeById('ae-views');
  if (!el || !views || !el.parentNode) return;
  var hb = el.parentNode.getBoundingClientRect(), vb = views.getBoundingClientRect();
  el.style.bottom = Math.max(8, hb.bottom - vb.top + 6) + 'px';
  el.style.maxHeight = Math.max(140, vb.top - hb.top - 64) + 'px';
}
function _alRender() {
  var el = _al.sheetEl;
  if (!el || el.hidden) return;
  var html = '<button type="button" class="al-x" id="al-x" aria-label="' + _almEsc(_aeT('alm_tm_close')) + '">×</button>';
  if (_al.state === 'failed') html += '<p>' + _almEsc(_aeT('alm_launch_unavailable')) + '</p>';
  else if (_al.state !== 'ready') html += '<h3>' + _almEsc(_aeT('alm_launches')) + '</h3><p class="al-note" aria-busy="true">…</p>';
  else if (_al.view === 'launch' && _al.cur) html += _alLaunchHtml();
  else html += _alListHtml();
  el.innerHTML = html;
  _alPlaceSheet();
  _aeById('al-x').onclick = _alCloseSheet;
  if (_al.state !== 'ready') return;
  if (_al.view === 'launch' && _al.cur) _alBindLaunch(); else _alBindList();
}

// ── The list ──
function _alMatches(r) {
  var f = _al.filter, d = _al.data;
  if (f.year && String(new Date(r[0] * AL_MS_PER_MIN).getUTCFullYear()) !== f.year) return false;
  if (f.site && d.pads[r[2]][2] !== f.site) return false;
  if (f.veh !== '' && String(r[1]) !== f.veh) return false;
  return true;
}
function _alSelectHtml(id, icon, label, options, value) {
  return '<label>' + _alSvg(icon) + '<select id="' + id + '" aria-label="' + _almEsc(label) + '"><option value="">' + _almEsc(_aeT('alm_launch_all')) + '</option>' +
    options.map(function (o) { return '<option value="' + _almEsc(o[0]) + '"' + (String(o[0]) === String(value) ? ' selected' : '') + '>' + _almEsc(o[1]) + '</option>'; }).join('') + '</select></label>';
}
function _alListHtml() {
  var d = _al.data, f = _al.filter, rows = [], focus = _aeDisplayMs(), nearest = -1, best = Infinity;
  for (var i = 0; i < _al.rows.length; i++) if (_alMatches(_al.rows[i])) rows.push(i);
  var shown = rows;
  if (rows.length > AL_ROWS_MAX) {
    // Around the clock's moment, not the list's start.
    rows.forEach(function (idx, k) { var gap = Math.abs(_al.rows[idx][0] * AL_MS_PER_MIN - focus); if (gap < best) { best = gap; nearest = k; } });
    var from = Math.max(0, Math.min(rows.length - AL_ROWS_MAX, nearest - AL_ROWS_MAX / 2));
    shown = rows.slice(from, from + AL_ROWS_MAX);
  }
  var html = '<h3>' + _almEsc(_aeT('alm_launches')) + ' · ' + _orrNum(rows.length, null, 0) + '</h3><div class="al-filters">' +
    _alSelectHtml('al-year', 'year', _aeT('alm_launch_year'), _al.years.map(function (y) { return [y, String(y)]; }), f.year) +
    _alSelectHtml('al-site', 'site', _aeT('alm_launch_site'), _al.sites.slice(0, 80).map(function (s) { return [s, s]; }), f.site) +
    _alSelectHtml('al-veh', 'veh', _aeT('alm_launch_vehicle'), _al.vehs.slice(0, 120).map(function (v) { return [v, d.veh[v]]; }), f.veh) + '</div>';
  if (!rows.length) html += '<p>' + _almEsc(_aeT('alm_launch_none')) + '</p>';
  var near = -1, gap = Infinity;
  shown.forEach(function (idx) { var g = Math.abs(_al.rows[idx][0] * AL_MS_PER_MIN - focus); if (g < gap) { gap = g; near = idx; } });
  shown.forEach(function (idx) {
    var r = _al.rows[idx], ms = r[0] * AL_MS_PER_MIN, pad = d.pads[r[2]];
    html += '<button type="button" class="al-row" data-i="' + idx + '"' + (idx === near ? ' data-near="1"' : '') + '><i class="al-dot' + (r[4] ? '' : ' bad') + '" title="' + _almEsc(_aeT(r[4] ? 'alm_launch_ok' : 'alm_launch_failed')) + '"></i>' +
      '<b>' + _almEsc(_alDateText(ms) + ' · ' + _alTimeText(ms)) + '</b><span>' + _almEsc(pad[2]) + '</span>' +
      '<span class="al-sub">' + _almEsc(d.veh[r[1]] + (r[3] ? ' · ' + r[3] : '')) + '</span></button>';
  });
  if (rows.length > shown.length) html += '<p class="al-note">' + _almEsc(_aeT('alm_launch_more', { n: _orrNum(rows.length - shown.length, null, 0) })) + '</p>';
  html += '<p class="al-note">' + _almEsc(_aeT('alm_launch_credit', { date: d.gcat || '' })) + '</p>';
  return html;
}
function _alBindList() {
  var el = _al.sheetEl;
  [['al-year', 'year'], ['al-site', 'site'], ['al-veh', 'veh']].forEach(function (p) {
    _aeById(p[0]).onchange = function () { _al.filter[p[1]] = this.value; _alRender(); };
  });
  Array.prototype.forEach.call(el.querySelectorAll('.al-row'), function (b) {
    b.onclick = function () { _alOpenLaunch(Number(b.getAttribute('data-i'))); };
  });
  var near = el.querySelector('[data-near]');
  if (near && near.scrollIntoView) { var top = near.offsetTop - el.clientHeight / 3; el.scrollTop = Math.max(0, top); }
}

// ── One launch ──
function _alOpenLaunch(i) {
  _alSelect(i);
  _al.view = 'launch';
  _alRender();
  _alGoPad();
}
function _alBack() { _al.view = 'list'; _alClear(); _alRender(); }
function _alFact(icon, text) { return '<li>' + _alSvg(icon) + '<span>' + _almEsc(text) + '</span></li>'; }
function _alSightText() {
  var s = _al.sight, L = _al.cur;
  if (!_alPlace()) return { no: true, text: _aeT('alm_launch_no_place') };
  if (!s.seen) return { no: true, text: _aeT('alm_launch_not_visible', { km: _alKm(s.padKm) }) };
  var t0 = L.ms + s.first.t * 1000;
  var head = _aeT('alm_launch_visible', { time: _alTimeText(t0), dir: _alArrow(s.first.az) + ' ' + Math.round(s.first.az) + '°', el: Math.round(s.peak.el) });
  return { no: false, text: head + ' ' + _aeT('alm_launch_sight_' + s.sight) };
}
function _alProfileText() {
  var f = _al.flight;
  return _aeT(f.guessed ? 'alm_launch_profile_guess' : f.family === 'falcon' ? 'alm_launch_profile_falcon' : 'alm_launch_profile_typical');
}
function _alLaunchHtml() {
  var L = _al.cur, f = _al.flight, sight = _alSightText();
  var html = '<button type="button" class="al-back" id="al-back" aria-label="' + _almEsc(_aeT('alm_launch_back')) + '">↩</button>' +
    '<h3>' + _almEsc(L.name + (L.mission ? ' · ' + L.mission : '')) + '</h3><ul class="al-facts">' +
    _alFact('year', _alDateText(L.ms) + ' · ' + _alTimeText(L.ms) + ' (' + new Date(L.ms).toISOString().slice(11, 16) + ' UTC)') +
    _alFact('site', L.siteName + (L.padName && L.padName !== '-' ? ' · ' + L.padName : '') + ' · ' + _orrNum(Math.abs(L.lat), null, 2) + (L.lat < 0 ? '°S ' : '°N ') + _orrNum(Math.abs(L.lon), null, 2) + (L.lon < 0 ? '°W' : '°E')) +
    _alFact('orbit', (L.ok ? '' : _aeT('alm_launch_failed') + ' · ') + _alOrbitText(L) + (L.n ? ' · ' + _aeT('alm_launch_payloads', { n: L.n }) + (L.names.length ? ': ' + L.names.join(', ') : '') : '')) +
    _alFact('path', _alProfileText() + ' · ' + _orrNum(f.az, null, 0) + '°') + '</ul>' +
    '<p class="al-sight' + (sight.no ? ' no' : '') + '">' + _almEsc(sight.text) + '</p>' +
    '<div class="al-acts">' +
      _alAct('al-pad', 'pad', 'alm_launch_pad') + _alAct('al-here', 'eye', 'alm_launch_from_here') + _alAct('al-frompad', 'stand', 'alm_launch_from_pad') +
      (typeof _aeStandAt === 'function' ? _alAct('al-ground', 'stand', 'alm_launch_on_ground') : '') +
    '</div>';
  if (_al.dep) html += _alBatchHtml();
  return html;
}
function _alAct(id, icon, key) {
  var t = _almEsc(_aeT(key));
  return '<button type="button" class="ae-btn ae-round" id="' + id + '" aria-label="' + t + '" title="' + t + '">' + _alSvg(icon, 18) + '</button>';
}
function _alBatchHtml() {
  var L = _al.cur, dep = _al.dep, src = _al.depSource;
  var html = '<div class="al-src" role="group" aria-label="' + _almEsc(_aeT('alm_launch_dots')) + '">' + _alSvg('dots') +
    '<button type="button" class="ae-btn" id="al-recon" aria-pressed="' + (src === AL_SRC.recon) + '">' + _almEsc(_aeT('alm_launch_recon')) + '</button>' +
    '<button type="button" class="ae-btn" id="al-exact" aria-pressed="' + (src === AL_SRC.exact) + '">' + _almEsc(_aeT('alm_launch_exact')) + '</button></div>' +
    '<p class="al-note">' + _almEsc(src === AL_SRC.recon ? _aeT('alm_launch_recon_note', { min: L.sepMin, n: dep.n }) : _alExactNote()) + '</p>';
  if (src === AL_SRC.exact && _al.st && _al.st.form) html += _alSpaceTrackForm();
  html += _alWindowsHtml();
  return html;
}
// The times this batch can be seen from the person's place, from the clock's moment on.
function _alWindowsHtml() {
  var dep = _al.dep, place = _alPlace();
  if (!dep || !place || _al.depSource !== AL_SRC.recon) return '';
  var from = dep.sepMs;
  if (!_al.windows || _al.windows.from !== from) {
    _al.windows = { from: from, list: _lfBatchWindows(dep, from, from + AL_WINDOW_HOURS * 3600000, place.lat, place.lon, AE_SATS_REF.passMinEl, AL_WINDOW_STEP_S * 1000) };
  }
  var list = _al.windows.list.slice(0, AL_WINDOWS_SHOWN);
  if (!list.length) return '<p class="al-note">' + _almEsc(_aeT('alm_launch_no_windows')) + '</p>';
  return '<div class="al-wins">' + list.map(function (w) {
    return '<button type="button" class="al-win" data-ms="' + w.start + '"><b>' + _almEsc(_alFmt(w.start, AL_DAY_OPTS) + ' ' + _alTimeText(w.start)) + '</b>' +
      '<span>' + _almEsc(_aeT('alm_launch_n_sats', { n: w.count })) + '</span><span>' + _alArrow(w.azStart) + ' — ' + _alArrow(w.azEnd) + ' · ' + Math.round(w.peakEl) + '°</span></button>';
  }).join('') + '</div>';
}
function _alBindLaunch() {
  _aeById('al-back').onclick = _alBack;
  _aeById('al-pad').onclick = function () { _alGoPad(); };
  _aeById('al-here').onclick = function () { _alStandThen('here'); };
  _aeById('al-frompad').onclick = function () { _alStandThen('pad'); };
  var g = _aeById('al-ground');
  if (g) g.onclick = function () { _aeGoTo(_al.cur.ms); _aeStandAt('earth', _al.cur.lat, _al.cur.lon); };
  var r = _aeById('al-recon'), x = _aeById('al-exact');
  if (r) r.onclick = function () { _al.depSource = AL_SRC.recon; _alRender(); _alKick(); };
  if (x) x.onclick = _alUseExact;
  Array.prototype.forEach.call(_al.sheetEl.querySelectorAll('.al-win'), function (b) {
    b.onclick = function () { _alStandThenAt('here', Number(b.getAttribute('data-ms'))); };
  });
  var st = _aeById('al-st-save');
  if (st) st.onclick = _alSpaceTrackSave;
}

// ── Opening at the pad ──
// The clock at lift-off and the view down over the pad, the ascent and the first stage's way back in frame.
function _alGoPad() {
  var L = _al.cur;
  if (!L || L.lat == null) return;
  _aeGoTo(L.ms);
  var sc = _aeSceneAt(L.ms);
  _ae.place = null; _ae.lm = null; _ae.selected = null; _ae.arrived = null;
  var azel = _aeAzElOf(_aeFixedToScene(_aeGeodeticToFixed(L.lat, L.lon), sc.gast));
  azel.el = Math.max(-AE_MAX_ELEVATION, azel.el - AL_FLY_TILT_RAD);
  _aeFlyTo('earth', AL_FLY_DIST, azel);
  _alKick();
}
// "From here" and "From the pad": the place and the moment into the live sky. The pad is a place the page borrows (never
// saved); the watcher's own place is the Almanac's.
function _alStandThen(where) {
  var L = _al.cur;
  if (!L) return;
  var s = _al.sight, start = where === 'here' && s && s.seen ? L.ms + (s.first.t * 1000) - AL_BEFORE_S * 1000 : L.ms - AL_BEFORE_S * 1000;
  _alStandThenAt(where, start);
}
function _alStandThenAt(where, ms) {
  var L = _al.cur;
  if (!L) return;
  if (where === 'pad' && typeof _almLinkPlace !== 'undefined') _almLinkPlace = { lat: L.lat, lon: L.lon };
  _aeGoTo(ms);
  _aeClose();
  setTimeout(function () {
    if (typeof _renderAlmanacContent === 'function') _renderAlmanacContent();
    var cv = typeof _skyState !== 'undefined' && _skyState && _skyState.canvas;
    if (cv && cv.scrollIntoView) cv.scrollIntoView({ block: 'center' });
    _alKick();
  }, AL_SKY_RESCUE_MS);
}

// ── Exact elements from Space-Track ──
function _alExactNote() {
  var x = _al.exact;
  if (!x) return _aeT('alm_launch_exact_ask');
  if (x.state === 'busy') return '…';
  if (x.state === 'ok') return _aeT('alm_launch_exact_note', { n: x.records.length });
  if (x.state === 'login') return _aeT('alm_launch_exact_login');
  if (x.state === 'never') return _aeT('alm_launch_exact_never');
  return _aeT('alm_launch_exact_failed');
}
function _alSpaceTrackForm() {
  return '<div class="al-st"><input id="al-st-user" type="text" autocomplete="username" aria-label="' + _almEsc(_aeT('alm_launch_st_user')) + '" placeholder="' + _almEsc(_aeT('alm_launch_st_user')) + '">' +
    '<input id="al-st-pass" type="password" autocomplete="current-password" aria-label="' + _almEsc(_aeT('alm_launch_st_pass')) + '" placeholder="' + _almEsc(_aeT('alm_launch_st_pass')) + '">' +
    '<button type="button" class="ae-btn" id="al-st-save">' + _almEsc(_aeT('alm_launch_st_save')) + '</button></div>';
}
function _alUseExact() {
  _al.depSource = AL_SRC.exact;
  if (_al.exact && _al.exact.state === 'ok') { _alRender(); _alKick(); return; }
  _al.exact = { state: 'busy', records: [] };
  _alRender();
  var L = _al.cur, tag = _alTag(L);
  _aeLoadSgp4().then(function (lib) {
    return _aePost(AL_SPACETRACK_FETCH_URL, { tag: tag, ms: _aeDisplayMs() }).then(function (r) {
      if (!_al.cur || _al.cur.i !== L.i) return;
      _al.exact = { state: r.records && r.records.length ? 'ok' : 'failed', records: r.records || [], lib: lib };
    });
  }).catch(function (e) {
    if (!_al.cur || _al.cur.i !== L.i) return;
    var status = e && e.status;
    _al.exact = { state: status === 401 || status === 403 || status === 424 ? 'login' : status === 409 ? 'never' : 'failed', records: [] };
    _al.st = { form: _al.exact.state === 'login' };
  }).then(function () { _alRender(); _alKick(); });
}
function _alTag(L) { return L.tag; }
function _alSpaceTrackSave() {
  var u = _aeById('al-st-user').value.trim(), p = _aeById('al-st-pass').value;
  _aePost(AL_SPACETRACK_URL, { user: u, password: p }).then(function () { _al.st = { form: false }; _alUseExact(); }).catch(function () { _al.exact = { state: 'failed', records: [] }; _alRender(); });
}

// ── The 3D view ──
// The ascent as two lines (the rocket's, the booster's) and moving points: the rocket, its lit exhaust, the booster, and
// the satellites. Everything is built when a launch is chosen and shown only while the view is on the Earth.
function _alFixed(lat, lon, hKm) {
  var v = _aeGeodeticToFixed(lat, lon), k = 1 + hKm / AE_EARTH_RADIUS_KM;
  return [v[0] * k, v[1] * k, v[2] * k];
}
function _alLineSet(line, pts) {
  var a = line.geometry.attributes.position;
  for (var i = 0; i < pts.length; i++) {
    var v = _alFixed(pts[i].lat, pts[i].lon, pts[i].h);
    a.array[i * 3] = v[0]; a.array[i * 3 + 1] = v[1]; a.array[i * 3 + 2] = v[2];
  }
  a.needsUpdate = true;
  line.geometry.setDrawRange(0, pts.length);
}
function _alGlReady() {
  var S = _ae && _ae.gl;
  if (!S) return false;
  if (_al.scene === S.scene && _al.track) return true;
  var THREE = S.THREE;
  _al.track = _aeLine(THREE, THREE.Line, AL_TRACK_CAPACITY, AL_TRACK_COLOR, AL_TRACK_ALPHA);
  _al.boost = _aeLine(THREE, THREE.Line, AL_TRACK_CAPACITY, AL_BOOSTER_COLOR, AL_BOOSTER_ALPHA);
  _al.rocket = _aePointCloud(THREE, 4, S.dpr, true, { depthTest: true });
  _al.dots = _aePointCloud(THREE, AL_BATCH_MAX, S.dpr, false, { depthTest: true });
  [_al.track, _al.boost, _al.rocket, _al.dots].forEach(function (o) { o.renderOrder = 1; S.scene.add(o); });
  _al.scene = S.scene;
  return true;
}
var AL_TRACK_CAPACITY = 640;
function _alTrackBuild() {
  if (!_alGlReady()) return;
  if (!_al.flight) { _al.track.visible = _al.boost.visible = _al.rocket.visible = _al.dots.visible = false; return; }
  _alLineSet(_al.track, _al.flight.points);
  if (_al.flight.booster) _alLineSet(_al.boost, _al.flight.booster); else _al.boost.geometry.setDrawRange(0, 0);
}
// Called every frame by almanac-earth.js after the satellites.
function _alFrame(ms, sc) {
  if (!_al.flight || !_al.cur || !_alGlReady()) { if (_al.track) _al.track.visible = _al.boost.visible = _al.rocket.visible = _al.dots.visible = false; return; }
  var on = _ae.target === 'earth';
  _al.track.visible = _al.boost.visible = _al.rocket.visible = _al.dots.visible = on;
  if (!on) return;
  _al.track.rotation.z = _al.boost.rotation.z = sc.gast;
  _alRocketPoints(ms, sc);
  _alDotPoints(ms, sc);
}
function _alRocketPoints(ms, sc) {
  var L = _al.cur, f = _al.flight, t = (ms - L.ms) / 1000, n = 0, at = function (p) { return _aeFixedToScene(_alFixed(p.lat, p.lon, p.h), sc.gast); };
  if (t >= 0 && t <= f.stop) {
    var p = f.points[Math.min(f.points.length - 1, Math.round(t))], pos = at(p);
    _aeSetPoint(_al.rocket, n++, pos, AL_ROCKET_COLOR, 1, AL_ROCKET_PX);
    var lit = _lfSunlit(_lfEci(p.lat, p.lon, p.h, _lfGmst(ms)), _lfSunUnit(ms));
    if (p.burn > 0 && p.h >= AE_LAUNCH_REF.plumeMinKm) _aeSetPoint(_al.rocket, n++, pos, AL_PLUME_COLOR, lit ? AL_PLUME_ALPHA : AL_PLUME_ALPHA / 2, AL_PLUME_PX);
  }
  var b = f.booster;
  if (b && t >= b[0].t && t <= b[b.length - 1].t) {
    var q = b[Math.min(b.length - 1, Math.round(t - b[0].t))];
    _aeSetPoint(_al.rocket, n++, at(q), q.burn > 2 ? AL_ROCKET_COLOR : AL_BOOSTER_POINT, 1, q.burn > 2 ? AL_ROCKET_PX - 2 : AL_ROCKET_PX - 3);
  }
  _aeCommitPoints(_al.rocket, n);
}
function _alDotPoints(ms, sc) {
  var dep = _al.dep, exact = _al.depSource === AL_SRC.exact, n = 0;
  if (dep && !exact && ms >= dep.sepMs) {
    var eq = _aeEqEq(sc), sun = _lfSunUnit(ms);
    for (var k = 0; k < dep.n; k++) {
      var p = dep.at(ms, k);
      _aeSetPoint(_al.dots, n++, _aeTemeToScene({ x: p[0], y: p[1], z: p[2] }, eq), AL_DOT_COLOR.recon, _lfSunlit(p, sun) ? 1 : AL_UNLIT_ALPHA, AL_DOT_PX);
    }
  }
  if (dep && exact && _al.exact && _al.exact.state === 'ok' && _al.exact.lib) n = _alExactPoints(ms, sc, n);
  _aeCommitPoints(_al.dots, n);
}
// The satellites of Space-Track's elements for the day, by SGP4.
function _alExactPoints(ms, sc, n) {
  var x = _al.exact, eq = _aeEqEq(sc), sun = _lfSunUnit(ms);
  if (!x.recs) x.recs = x.records.map(function (o) { var r = x.lib.json2satrec(o); return r.error ? null : { rec: r, epoch: Date.parse(o.EPOCH) }; });
  x.recs.forEach(function (r) {
    if (!r || n >= AL_BATCH_MAX) return;
    var pv = x.lib.sgp4(r.rec, (ms - r.epoch) / AE_MS_PER_MINUTE);
    if (!pv || !pv.position || isNaN(pv.position.x)) return;
    var p = pv.position;
    _aeSetPoint(_al.dots, n++, _aeTemeToScene(p, eq), AL_DOT_COLOR.exact, _lfSunlit([p.x, p.y, p.z], sun) ? 1 : AL_UNLIT_ALPHA, AL_DOT_PX);
  });
  return n;
}

// ── The live sky ──
// Called by almanac-sky.js _skyPaintActors. The rocket while it is up, with the sight it makes from this place, and the
// released satellites that are lit.
function _alSkyPaint(ctx, s) {
  if (!_al.flight || !_al.cur) return;
  var ms = _skyLive() ? Date.now() : s.nowTime, dpr = s.dpr, drawn = false, L = _al.cur, f = _al.flight;
  var t = (ms - L.ms) / 1000;
  if (t >= 0 && t <= f.stop) {
    var sunAlt = _lfSunAlt(ms, s.lat, s.lon), trail = [];
    for (var k = 0; k <= AL_TRAIL_S; k += AL_TRAIL_STEP_S) {
      var p = f.points[Math.max(0, Math.min(f.points.length - 1, Math.round(t - k)))], lk = _lfLook(s.lat, s.lon, p.lat, p.lon, p.h);
      if (lk.el < 0) break;
      var sun = _lfSunlit(_lfEci(p.lat, p.lon, p.h, _lfGmst(ms - k * 1000)), _lfSunUnit(ms - k * 1000));
      trail.push({ x: _skyX(s, lk.az), y: _skyY(s, lk.el), el: lk.el, az: lk.az, sight: _lfSight(p.burn > 0, sun, sunAlt, lk.el, p.h), h: p.h });
    }
    if (trail.length && _skyInView(s, trail[0].x, 40)) {
      var head = trail[0], jelly = head.sight === 'jellyfish';
      for (var j = trail.length - 1; j > 0; j--) {
        ctx.strokeStyle = 'rgba(255,236,200,' + (0.5 * (1 - j / trail.length)).toFixed(3) + ')';
        ctx.lineWidth = dpr * 1.6;
        ctx.beginPath(); ctx.moveTo(trail[j].x, trail[j].y); ctx.lineTo(trail[j - 1].x, trail[j - 1].y); ctx.stroke();
      }
      if (jelly) _skyLight(ctx, head.x, head.y, 9 * dpr, [160, 215, 255], 0.35);
      _skyLight(ctx, head.x, head.y, (head.sight === 'dot' || head.sight === 'day' ? 2.2 : 3) * dpr, head.sight === 'flame' ? [255, 170, 90] : [255, 244, 225], 0.95);
      ctx.fillStyle = 'rgba(255,250,235,.85)';
      ctx.font = (11 * dpr) + 'px sans-serif';
      ctx.fillText(L.name, head.x + 8 * dpr, head.y - 8 * dpr);
      s.bodies.push({ type: 'rocket', name: L.name + (L.mission ? ' · ' + L.mission : ''), x: head.x / dpr, y: head.y / dpr, r: 5, alt: head.el, az: head.az, km: head.h });
      drawn = true;
    }
  }
  var dep = _al.dep;
  if (dep && _al.depSource === AL_SRC.recon && ms >= dep.sepMs) {
    var w = _lfWatcher(ms, s.lat, s.lon), seen = 0;
    if (w.sunAlt < AE_SATS_REF.passSunAlt + 1) {
      for (var i = 0; i < dep.n; i++) {
        var v = _lfSeenBy(w, dep.at(ms, i));
        if (v.el < 0 || !v.lit) continue;
        var x = _skyX(s, v.az);
        if (!_skyInView(s, x, 4)) continue;
        _skyLight(ctx, x, _skyY(s, v.el), 1.5 * dpr, [255, 236, 190], 0.9);
        if (!seen++) s.bodies.push({ type: 'sat', name: _aeT('alm_launch_recon'), x: x / dpr, y: _skyY(s, v.el) / dpr, r: 4, alt: v.el, az: v.az, km: dep.heightKm(ms) });
      }
    }
    if (seen) drawn = true;
  }
  if (drawn) s.issUp = true;
}
