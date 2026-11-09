// ── Almanac: every active satellite ──
// The Earth view's "all satellites" layer, loaded on its first use (almanac-earth.js _aeSatsAllSet) and never otherwise:
//   - the catalogue (satcatalog.py, /almanac-satellites?all=1): about fifteen thousand satellites as columns of
//     orbital elements, with owner, launch date and radar size;
//   - one THREE.Points for all of them, a vertex shader that carries each a second or so past its last sample along its
//     velocity, and a Web Worker that runs SGP4 for the lot, so the main thread only copies two arrays now and then;
//   - filters (constellation, orbit, owner), the tapped satellite's card, and its orbit;
//   - the passes: sunlit satellites over the person's place while the sky is dark, listed in a sheet, drawn as moving
//     points in the live sky (almanac-sky.js _skyPaintActors calls _asSkyPaint), with the GPS satellites overhead.
// The elements fade by age: a set a few days old is as good as exact, one a month old is a rough guess, and past
// AS_AGE_GONE_DAYS the satellite is not drawn. Brightness is an estimate (a diffuse sphere the size of the satellite's
// radar cross-section, or a stated size for the big constellations) and the sheet says so.
// Shares almanac-earth.js's global scope: its helpers (_aeT, _aeProject, _aeLine ...) and the page's (_getLocation ...).

// ── The catalogue ──
var AS_URL = '/almanac-satellites?all=1';
var AS_REFRESH_URL = '/manage/satellites/refresh';
var AS_COLS = ['norad', 'name', 'epoch', 'mm', 'ecc', 'inc', 'raan', 'argp', 'ma', 'bstar', 'owner', 'launch', 'rcs'];
var AS_EPOCH_ORIGIN_MS = Date.UTC(2000, 0, 1);       // satcatalog.py EPOCH_ORIGIN: the epoch column counts days from here
var AS_LAUNCH_ORIGIN_MS = Date.UTC(1957, 0, 1);      // satcatalog.py LAUNCH_ORIGIN
var AS_MU_KM3_S2 = 398600.4418;                      // Earth's GM: the semi-major axis from the mean motion
var AS_LEO_MAX_KM = AE_SATS_REF.leoMaxKm, AS_GEO_MIN_KM = AE_SATS_REF.geoMinKm;   // the orbit classes, by mean altitude
var AS_ORBITS = ['leo', 'meo', 'geo'];
var AS_GROUPS = ['starlink', 'oneweb', 'iridium', 'gnss', 'other'];
var AS_GROUP_RE = [/^STARLINK/, /^ONEWEB/, /^IRIDIUM/, /^(GPS |NAVSTAR|GLONASS|GALILEO|BEIDOU|QZS|IRNSS|NAVIC)/];
var AS_GROUP_COLOR = { starlink: [0.43, 0.91, 0.85], oneweb: [0.72, 0.6, 1.0], iridium: [1.0, 0.62, 0.35], gnss: [0.55, 0.85, 1.0], other: [0.93, 0.93, 0.9] };
var AS_GROUP_TERM = { starlink: 'term:starlink', oneweb: 'term:oneweb', iridium: 'term:iridium', gnss: 'term:gnss', other: 'term:satellite_constellation' };
var AS_ORBIT_TERM = { leo: 'term:leo', meo: 'term:meo', geo: 'term:geo' };
// The owners SATCAT names, as the country whose flag stands for them (the rest show their code).
var AS_OWNER_ISO = { US: 'US', UK: 'GB', PRC: 'CN', CIS: 'RU', JPN: 'JP', IND: 'IN', FR: 'FR', GER: 'DE', IT: 'IT', CA: 'CA', ESA: 'EU', SKOR: 'KR', ISRA: 'IL', AUS: 'AU', BRAZ: 'BR', SPN: 'ES', TURK: 'TR', UAE: 'AE', ARGN: 'AR', LUXE: 'LU', NETH: 'NL', SWTZ: 'CH', SWED: 'SE', NOR: 'NO', TWN: 'TW', THAI: 'TH', INDO: 'ID', SAUD: 'SA', EGYP: 'EG', MEX: 'MX', POL: 'PL', ISS: 'US' };
var AS_OWNER_CHIPS = 6;                               // the most numerous owners get a chip of their own
var AS_GPS_KEY = 'zimi_ae_sats_gps', AS_ON = '1';   // the layer's own choice is SK.ALM_SATS_ALL (app.js)

// ── Drawing ──
var AS_POINT_PX = 2.6, AS_POINT_GEO_PX = 3.4, AS_POINT_SELECTED_PX = 9;
var AS_AGE_FRESH_DAYS = AE_SATS_REF.ageFreshDays, AS_AGE_GONE_DAYS = AE_SATS_REF.ageGoneDays;   // element age: fully drawn up to the first, gone by the second
var AS_ALPHA_FLOOR = 0.12;
var AS_RESAMPLE_MS = 1000;                            // a fresh sample of every satellite this often (display time)
var AS_EXTRAP_MAX_S = 30;                             // the shader's carry past a sample never exceeds this
var AS_FAST_RATE = 600;                               // a clock running faster than this (x real time) hides the dots
var AS_ALPHA_REFRESH_MS = 5000;
var AS_ORBIT_POINTS = 144, AS_ORBIT_COLOR = 0xffd27a, AS_ORBIT_ALPHA = 0.55, AS_ORBIT_REFRESH_MS = 10 * 60 * 1000;
var AS_TAP_RADIUS_PX = 22;
var AS_EARTH_RE_KM = 6371;                            // AE_EARTH_RADIUS_KM, which the worker is given

// ── The passes ──
var AS_PASS_HOURS = 30, AS_PASS_STEP_S = 60, AS_PASS_REFINE_S = 10, AS_PASS_MIN_EL = AE_SATS_REF.passMinEl, AS_PASS_SUN_ALT = AE_SATS_REF.passSunAlt;
var AS_PASS_MAG_LIMIT = AE_SATS_REF.passMag, AS_PASS_MAX = 60, AS_PASS_LONE_STARLINKS = 12;
var AS_PASS_AREA_M2 = AE_SATS_REF.areaM2;             // used where SATCAT has no radar size
var AS_PASS_MIN_RCS_M2 = AE_SATS_REF.minRcsM2;        // a satellite with a radar size below this is not offered
var AS_PASS_LEO_MM = 11;                              // revolutions a day: a pass needs an orbit this low
var AS_TRAIN_GAP_S = AE_SATS_REF.trainGapS, AS_TRAIN_MIN = 3, AS_TRAIN_RAAN_DEG = AE_SATS_REF.trainRaanDeg;
var AS_ISS_NORAD = 25544;
var AS_PASS_SKY_FRAME_MS = 500;
var AS_GPS_MIN_EL = AE_SATS_REF.gpsMinEl;

var _as = {
  on: false, state: 'idle',              // idle | loading | ready | failed
  data: null, lib: null, worker: null, workerReady: false,
  cloud: null, scene: null, sel: -1, selLine: null, selAt: 0,
  filter: { group: {}, orbit: {}, owner: {} },
  sampleMs: 0, posting: false, alphaAt: -Infinity, shown: 0,
  passes: null, passPlace: null, passBusy: false, sheet: false, gps: false, bar: null
};

function _asPref(on) { _prefWrite(SK.ALM_SATS_ALL, on ? AS_ON : null); }
function _asGpsOn() { try { return localStorage.getItem(AS_GPS_KEY) === AS_ON; } catch (e) { return false; } }

// ── Reading the catalogue ──
function _asDecode(payload) {
  var cols = payload.cols || [], rows = payload.sats || [], n = rows.length, ix = {};
  AS_COLS.forEach(function (c) { ix[c] = cols.indexOf(c); });
  if (AS_COLS.some(function (c) { return ix[c] < 0; }) || !n) return null;
  var d = {
    n: n, fetched: payload.fetched, source: payload.source, stale: !!payload.stale,
    norad: new Int32Array(n), epoch: new Float64Array(n), mm: new Float64Array(n), ecc: new Float64Array(n),
    inc: new Float64Array(n), raan: new Float64Array(n), argp: new Float64Array(n), ma: new Float64Array(n), bstar: new Float64Array(n),
    launch: new Int32Array(n), rcs: new Float32Array(n), alt: new Float32Array(n),
    group: new Uint8Array(n), orbit: new Uint8Array(n), owner: new Uint8Array(n),
    name: new Array(n), owners: [], ownerCount: {}
  };
  var ownerIx = {};
  for (var i = 0; i < n; i++) {
    var r = rows[i];
    d.norad[i] = r[ix.norad]; d.name[i] = r[ix.name]; d.epoch[i] = r[ix.epoch];
    d.mm[i] = r[ix.mm]; d.ecc[i] = r[ix.ecc]; d.inc[i] = r[ix.inc]; d.raan[i] = r[ix.raan];
    d.argp[i] = r[ix.argp]; d.ma[i] = r[ix.ma]; d.bstar[i] = r[ix.bstar];
    d.launch[i] = r[ix.launch] == null ? -1 : r[ix.launch];
    d.rcs[i] = r[ix.rcs] == null ? NaN : r[ix.rcs];
    d.alt[i] = _asAltitudeKm(d.mm[i], d.ecc[i]);
    d.orbit[i] = d.alt[i] < AS_LEO_MAX_KM ? 0 : d.alt[i] < AS_GEO_MIN_KM ? 1 : 2;
    var g = 0;
    while (g < AS_GROUP_RE.length && !AS_GROUP_RE[g].test(d.name[i])) g++;
    d.group[i] = g;
    var o = r[ix.owner] || '';
    if (!(o in ownerIx)) { ownerIx[o] = d.owners.length; d.owners.push(o); d.ownerCount[o] = 0; }
    d.owner[i] = ownerIx[o];
    d.ownerCount[o]++;
  }
  d.topOwners = d.owners.filter(Boolean).sort(function (a, b) { return d.ownerCount[b] - d.ownerCount[a]; }).slice(0, AS_OWNER_CHIPS);
  return d;
}
// Mean altitude (km) from the mean motion in revolutions a day: the orbit's size, not its height at a moment.
function _asAltitudeKm(mm, ecc) {
  var nRad = mm * 2 * Math.PI / 86400, a = Math.cbrt(AS_MU_KM3_S2 / (nRad * nRad));
  return a - AS_EARTH_RE_KM;
}
function _asOmm(d, i) {
  return {
    OBJECT_NAME: d.name[i], NORAD_CAT_ID: d.norad[i],
    EPOCH: new Date(AS_EPOCH_ORIGIN_MS + d.epoch[i] * MS_PER_DAY).toISOString(),
    MEAN_MOTION: d.mm[i], ECCENTRICITY: d.ecc[i], INCLINATION: d.inc[i], RA_OF_ASC_NODE: d.raan[i],
    ARG_OF_PERICENTER: d.argp[i], MEAN_ANOMALY: d.ma[i], BSTAR: d.bstar[i], MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0
  };
}
function _asEpochMs(d, i) { return AS_EPOCH_ORIGIN_MS + d.epoch[i] * MS_PER_DAY; }

// ── The worker: SGP4 for everything, off the main thread ──
// Written as a function and sent as its source, so it needs no file of its own (the Almanac ZIM packs only what its
// page loads) and no path that differs between Zimi and a ZIM. It knows nothing of this file.
function _asWorkerMain() {
  'use strict';
  var lib = null, N = 0, recs = null, epochMs = null, radius = 6371, EPOCH0 = 0;
  var D2R = Math.PI / 180, MS_DAY = 86400000;
  var A_WGS = 6378.137, F_WGS = 1 / 298.257223563, E2 = F_WGS * (2 - F_WGS);
  var SUN_MAG = 0, ALBEDO = 0;

  function init(m) {
    importScripts(m.sgpUrl);
    lib = self.SatelliteJS;
    N = m.n; radius = m.radius; EPOCH0 = m.epoch0; SUN_MAG = m.sunMag; ALBEDO = m.albedo; epochMs = new Float64Array(N);
    recs = new Array(N);
    var bad = 0;
    for (var i = 0; i < N; i++) {
      epochMs[i] = EPOCH0 + m.epoch[i] * MS_DAY;
      try {
        var r = lib.json2satrec({
          OBJECT_NAME: '', NORAD_CAT_ID: m.norad[i], EPOCH: new Date(epochMs[i]).toISOString(),
          MEAN_MOTION: m.mm[i], ECCENTRICITY: m.ecc[i], INCLINATION: m.inc[i], RA_OF_ASC_NODE: m.raan[i],
          ARG_OF_PERICENTER: m.argp[i], MEAN_ANOMALY: m.ma[i], BSTAR: m.bstar[i], MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0
        });
        recs[i] = r.error ? null : r;
      } catch (e) { recs[i] = null; }
      if (!recs[i]) bad++;
    }
    return bad;
  }
  // Positions (Earth radii) and velocities (radii a second) in TEME, with a flag for each satellite SGP4 answered for.
  function tick(ms) {
    var pos = new Float32Array(N * 3), vel = new Float32Array(N * 3), ok = new Uint8Array(N);
    for (var i = 0; i < N; i++) {
      var rec = recs[i];
      if (!rec) continue;
      var pv = lib.sgp4(rec, (ms - epochMs[i]) / 60000);
      if (!pv || !pv.position || typeof pv.position.x !== 'number' || isNaN(pv.position.x)) continue;
      var p = pv.position, v = pv.velocity, k = i * 3;
      pos[k] = p.x / radius; pos[k + 1] = p.y / radius; pos[k + 2] = p.z / radius;
      vel[k] = v.x / radius; vel[k + 1] = v.y / radius; vel[k + 2] = v.z / radius;
      ok[i] = 1;
    }
    return { pos: pos, vel: vel, ok: ok };
  }

  // The Sun's direction (a unit vector, equatorial) to a few hundredths of a degree: all the dark sky and the shadow need.
  function sunUnit(ms) {
    var n = ms / MS_DAY + 2440587.5 - 2451545.0;
    var L = (280.460 + 0.9856474 * n) * D2R, g = (357.528 + 0.9856003 * n) * D2R;
    var lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R, eps = (23.439 - 0.0000004 * n) * D2R;
    return [Math.cos(lam), Math.cos(eps) * Math.sin(lam), Math.sin(eps) * Math.sin(lam)];
  }
  function gmst(ms) {
    var n = ms / MS_DAY + 2440587.5 - 2451545.0;
    return (((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24) * 15 * D2R;
  }
  // The place: its frame (up, east, north in the equatorial axes) and position, at a local sidereal angle.
  function frame(lat, lon, th) {
    var sl = Math.sin(lat), cl = Math.cos(lat), st = Math.sin(th), ct = Math.cos(th), N0 = A_WGS / Math.sqrt(1 - E2 * sl * sl);
    return {
      up: [cl * ct, cl * st, sl], east: [-st, ct, 0], north: [-sl * ct, -sl * st, cl],
      pos: [N0 * cl * ct, N0 * cl * st, N0 * (1 - E2) * sl]
    };
  }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  // Magnitude of a diffuse sphere of cross-section area A (m2) lit by the Sun and seen from the place.
  function magnitude(sat, sun, obs, area) {
    var rho = [obs[0] - sat[0], obs[1] - sat[1], obs[2] - sat[2]], range = Math.sqrt(dot(rho, rho));
    var c = Math.max(-1, Math.min(1, dot(sun, rho) / range)), phi = Math.acos(c);
    var p = 2 / (3 * Math.PI) * (Math.sin(phi) + (Math.PI - phi) * Math.cos(phi));
    var d = range * 1000;
    return SUN_MAG - 2.5 * Math.log10(Math.max(1e-30, ALBEDO * area * p / (Math.PI * d * d)));
  }
  function sunlit(sat, sun) {
    var along = dot(sat, sun);
    if (along >= 0) return true;
    var px = sat[0] - sun[0] * along, py = sat[1] - sun[1] * along, pz = sat[2] - sun[2] * along;
    return Math.sqrt(px * px + py * py + pz * pz) > A_WGS;
  }
  // One satellite seen from the place at ms: {el, az, mag} when it is up and lit, else null.
  function look(i, ms, lat, lon, area, minEl) {
    var pv = lib.sgp4(recs[i], (ms - epochMs[i]) / 60000);
    if (!pv || !pv.position || typeof pv.position.x !== 'number' || isNaN(pv.position.x)) return null;
    var sat = [pv.position.x, pv.position.y, pv.position.z], th = gmst(ms) + lon, f = frame(lat, lon, th);
    var rho = [sat[0] - f.pos[0], sat[1] - f.pos[1], sat[2] - f.pos[2]], range = Math.sqrt(dot(rho, rho));
    var el = Math.asin(dot(rho, f.up) / range) / D2R;
    if (el < minEl) return null;
    var sun = sunUnit(ms);
    if (!sunlit(sat, sun)) return null;
    var az = (Math.atan2(dot(rho, f.east), dot(rho, f.north)) / D2R + 360) % 360;
    return { el: el, az: az, mag: magnitude(sat, sun, f.pos, area) };
  }
  // Every pass over the place in the next hours: runs of steps where the satellite is up, lit and bright enough while
  // the sky is dark, then each run's edges found to a few seconds.
  function passes(m) {
    var lat = m.lat * D2R, lon = m.lon * D2R, steps = Math.floor(m.hours * 3600 / m.step), t0 = m.t0, out = [];
    var sunAlt = new Float32Array(steps);
    for (var k = 0; k < steps; k++) {
      var t = t0 + k * m.step * 1000, f = frame(lat, lon, gmst(t) + lon);
      sunAlt[k] = Math.asin(dot(sunUnit(t), f.up)) / D2R;
    }
    for (var c = 0; c < m.cand.length; c++) {
      var i = m.cand[c], area = m.area[c];
      var altKm = m.altKm[c], dip = Math.acos(radius / (radius + altKm)) / D2R + 3;   // below this the satellite is in shadow at any height of the sky
      var reach = m.inc[c] > 90 ? 180 - m.inc[c] : m.inc[c];
      if (Math.abs(m.lat) > reach + dip + 20) continue;
      var run = null;
      for (var k2 = 0; k2 < steps; k2++) {
        if (sunAlt[k2] > m.sunAlt || sunAlt[k2] < -dip - 8) { if (run) { out.push(finish(i, run, lat, lon, area, m)); run = null; } continue; }
        var tt = t0 + k2 * m.step * 1000, lk = look(i, tt, lat, lon, area, m.minEl);
        if (lk && lk.mag <= m.magLimit) { if (!run) run = { first: tt }; run.last = tt; }
        else if (run) { out.push(finish(i, run, lat, lon, area, m)); run = null; }
      }
      if (run) out.push(finish(i, run, lat, lon, area, m));
    }
    return out.filter(Boolean);
  }
  function finish(i, run, lat, lon, area, m) {
    var from = run.first - m.step * 1000, to = run.last + m.step * 1000, a = null, best = null, z = null, mag = 99;
    for (var t = from; t <= to; t += m.refine * 1000) {
      var lk = look(i, t, lat, lon, area, 0);
      if (!lk || lk.el < m.minEl || lk.mag > m.magLimit) continue;
      if (!a) a = { t: t, az: lk.az };
      z = { t: t, az: lk.az };
      if (!best || lk.el > best.el) best = { t: t, az: lk.az, el: lk.el };
      if (lk.mag < mag) mag = lk.mag;
    }
    if (!a || !best) return null;
    return { i: i, start: a.t, peak: best.t, end: z.t, el: best.el, azS: a.az, azP: best.az, azE: z.az, mag: mag };
  }

  self.onmessage = function (e) {
    var m = e.data, out = { id: m.id, cmd: m.cmd };
    try {
      if (m.cmd === 'init') out.bad = init(m);
      else if (m.cmd === 'tick') { var r = tick(m.ms); out.ms = m.ms; out.pos = r.pos; out.vel = r.vel; out.ok = r.ok; }
      else if (m.cmd === 'passes') out.list = passes(m);
    } catch (err) { out.error = String(err && err.message || err); }
    var tr = [];
    if (out.pos) tr = [out.pos.buffer, out.vel.buffer, out.ok.buffer];
    self.postMessage(out, tr);
  };
}

var _asCalls = {};
function _asAsk(msg, transfer) {
  return new Promise(function (resolve, reject) {
    if (!_as.worker) { reject(new Error('no worker')); return; }
    var id = ++_asAsk.n;
    _asCalls[id] = { resolve: resolve, reject: reject };
    msg.id = id;
    _as.worker.postMessage(msg, transfer || []);
  });
}
_asAsk.n = 0;
function _asStartWorker(d) {
  var blob = new Blob(['(' + _asWorkerMain.toString() + ')()'], { type: 'text/javascript' });
  var url = URL.createObjectURL(blob);
  var w = new Worker(url);
  URL.revokeObjectURL(url);
  w.onmessage = function (e) {
    var c = _asCalls[e.data.id];
    if (!c) return;
    delete _asCalls[e.data.id];
    if (e.data.error) c.reject(new Error(e.data.error)); else c.resolve(e.data);
  };
  w.onerror = function () {
    Object.keys(_asCalls).forEach(function (k) { _asCalls[k].reject(new Error('worker')); delete _asCalls[k]; });
  };
  _as.worker = w;
  return _asAsk({
    cmd: 'init', sunMag: AE_SATS_REF.sunMag, albedo: AE_SATS_REF.albedo, sgpUrl: new URL(AE_SGP4_URL, document.baseURI).href, n: d.n, radius: AS_EARTH_RE_KM, epoch0: AS_EPOCH_ORIGIN_MS,
    norad: d.norad, epoch: d.epoch, mm: d.mm, ecc: d.ecc, inc: d.inc, raan: d.raan, argp: d.argp, ma: d.ma, bstar: d.bstar
  });
}

// ── Turning it on and off ──
// Called by almanac-earth.js: the button, and the view's open when the choice was kept.
function _asSet(on) {
  _as.on = !!on;
  _asPref(_as.on);
  if (_as.on) _asLoad();
  if (_as.state === 'ready') _asBuildBar();
  if (!_as.on) { _asCloseSheet(); _asSelect(-1); }
  _asSync();
}
function _asLoad() {
  if (_as.state === 'loading' || _as.state === 'ready') return Promise.resolve();
  _as.state = 'loading';
  _asSync();
  return Promise.all([_aeLoadSgp4(), _aeFetch(AS_URL).then(_aeJson)]).then(function (res) {
    _as.lib = res[0];
    var d = _asDecode(res[1]);
    if (!d) throw new Error('catalogue');
    _as.data = d;
    return _asStartWorker(d);
  }).then(function () {
    _as.state = 'ready';
    _asBuildBar();
    _asApplyFilters();
    _asNeedPasses();
  }).catch(function () {
    _as.state = 'failed';
    if (_as.worker) { _as.worker.terminate(); _as.worker = null; }
  }).then(function () {
    _asSync();
    if (typeof _ae !== 'undefined' && _ae) { _ae.dirty = true; _aeKick(); }
  });
}
// The button's look and the strip's visibility follow the state.
function _asSync() {
  var b = _aeById('ae-sats-btn');
  if (b) {
    b.setAttribute('aria-pressed', String(_as.on));
    b.setAttribute('aria-busy', String(_as.on && _as.state === 'loading'));
    b.classList.toggle('as-failed', _as.on && _as.state === 'failed');
  }
  _asSyncBar();
  if (_as.cloud) _as.cloud.visible = _as.on && _as.state === 'ready';
}
// Leaving the Almanac: the worker and the catalogue go; what is kept is the choice.
function _asRelease() {
  if (_as.worker) { _as.worker.terminate(); _as.worker = null; }
  _asCalls = {};
  _as.state = 'idle'; _as.data = null; _as.cloud = null; _as.scene = null; _as.selLine = null; _as.sel = -1;
  _as.passes = null; _as.passPlace = null; _as.passBusy = false; _as.sampleMs = 0; _as.posting = false; _as.alphaAt = -Infinity;
  if (_as.bar && _as.bar.parentNode) _as.bar.parentNode.removeChild(_as.bar);
  if (_as.sheetEl && _as.sheetEl.parentNode) _as.sheetEl.parentNode.removeChild(_as.sheetEl);
  _as.bar = _as.sheetEl = null; _as.sheet = false;
}
// The GPU scene was freed and will be made again: what hung on it is gone.
function _asGlGone() { _as.cloud = null; _as.scene = null; _as.selLine = null; }

// ── The points ──
var AS_VERT = [
  'attribute vec3 aVel; attribute vec3 aColor; attribute float aAlpha; attribute float aSize;',
  'uniform float dpr; uniform float dt;',
  'varying vec3 vColor; varying float vAlpha;',
  'void main() {',
  '  vColor = aColor; vAlpha = aAlpha;',
  '  gl_PointSize = aSize * dpr;',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position + aVel * dt, 1.0);',
  '}'
].join('\n');
function _asMakeCloud() {
  var S = _ae.gl, THREE = S.THREE, n = _as.data.n;
  var g = new THREE.BufferGeometry();
  ['position', 'aVel', 'aColor'].forEach(function (k) { g.setAttribute(k, new THREE.BufferAttribute(new Float32Array(n * 3), 3)); });
  ['aAlpha', 'aSize'].forEach(function (k) { g.setAttribute(k, new THREE.BufferAttribute(new Float32Array(n), 1)); });
  var u = { dpr: { value: S.dpr }, dt: { value: 0 }, glow: { value: 0 }, fade: _aeFadeU };
  var m = new THREE.ShaderMaterial({ uniforms: u, vertexShader: AS_VERT, fragmentShader: AE_POINTS_FRAG, transparent: true, depthWrite: false, depthTest: true });
  var p = new THREE.Points(g, m);
  p.frustumCulled = false;
  p.renderOrder = 1;
  S.scene.add(p);
  var d = _as.data, col = g.attributes.aColor.array;
  for (var i = 0; i < n; i++) { var c = AS_GROUP_COLOR[AS_GROUPS[d.group[i]]]; col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]; }
  // The selected satellite's orbit.
  _as.selLine = _aeLine(THREE, THREE.LineLoop, AS_ORBIT_POINTS, AS_ORBIT_COLOR, AS_ORBIT_ALPHA);
  S.scene.add(_as.selLine);
  _as.cloud = p; _as.scene = S.scene;
  _as.sampleMs = 0; _as.alphaAt = -Infinity; _as.hold = null;
  _asApplyFilters();
}

// ── Filters ──
function _asVisible(i) {
  var d = _as.data, f = _as.filter;
  if (d.norad[i] === AS_ISS_NORAD || _asIsGpsDrawn(i)) return false;
  var g = AS_GROUPS[d.group[i]], o = AS_ORBITS[d.orbit[i]], ow = d.owners[d.owner[i]];
  return (!_asAny(f.group) || f.group[g]) && (!_asAny(f.orbit) || f.orbit[o]) && (!_asAny(f.owner) || f.owner[ow]);
}
function _asAny(set) { for (var k in set) if (set[k]) return true; return false; }
// The GPS satellites the view already draws and names (its own layer) are not drawn twice.
function _asIsGpsDrawn(i) {
  if (!_ae.sats) return false;
  if (!_as.gpsIds || _as.gpsFor !== _ae.sats) {
    _as.gpsIds = {}; _as.gpsFor = _ae.sats;
    _ae.sats.list.forEach(function (s) { _as.gpsIds[s.omm.NORAD_CAT_ID] = 1; });
  }
  return !!_as.gpsIds[_as.data.norad[i]];
}
function _asApplyFilters() {
  if (!_as.cloud || !_as.data) return;
  var d = _as.data, size = _as.cloud.geometry.attributes.aSize.array, n = d.n, shown = 0;
  for (var i = 0; i < n; i++) {
    var on = _asVisible(i);
    size[i] = !on ? 0 : i === _as.sel ? AS_POINT_SELECTED_PX : d.orbit[i] === 2 ? AS_POINT_GEO_PX : AS_POINT_PX;
    if (on) shown++;
  }
  _as.shown = shown;
  _as.cloud.geometry.attributes.aSize.needsUpdate = true;
  _as.alphaAt = -Infinity;
  _asCount();
  if (typeof _ae !== 'undefined' && _ae) { _ae.dirty = true; _aeKick(); }
}
function _asCount() {
  var el = _aeById('as-count');
  if (el) el.textContent = _orrNum(_as.shown, null, 0);
}

// ── Each frame ──
// Called by almanac-earth.js after its own satellites.
function _asFrame(ms, sc) {
  if (!_as.on || _as.state !== 'ready') return;
  if (!_as.cloud || _as.scene !== _ae.gl.scene) _asMakeCloud();
  var cloud = _as.cloud, fast = typeof _almRate !== 'undefined' && Math.abs(_almRate) > AS_FAST_RATE;
  cloud.visible = _ae.target === 'earth' && !fast;
  if ((_ae.selected || _ae.place || _ae.lm) && _as.sel >= 0) _asSelect(-1);   // the view's own cards win
  _asSyncBar();
  if (!cloud.visible) return;
  cloud.rotation.z = _aeEqEq(sc);
  var dt = _as.sampleMs ? _aeClamp((ms - _as.sampleMs) / 1000, -AS_EXTRAP_MAX_S, AS_EXTRAP_MAX_S) : 0;
  cloud.material.uniforms.dt.value = dt;
  if (!_as.posting && (!_as.sampleMs || Math.abs(ms - _as.sampleMs) >= AS_RESAMPLE_MS)) _asSample(ms);
  if (_as.sel >= 0) _asUpdateSelOrbit(ms, sc);
}
function _asSample(ms) {
  _as.posting = true;
  _asAsk({ cmd: 'tick', ms: ms }).then(function (r) {
    _as.posting = false;
    if (!_as.cloud) return;
    var a = _as.cloud.geometry.attributes;
    a.position.array.set(r.pos); a.aVel.array.set(r.vel);
    a.position.needsUpdate = a.aVel.needsUpdate = true;
    _as.ok = r.ok; _as.sampleMs = r.ms;
    _asAlphas(r.ms);
    _ae.dirty = true; _aeKick();
  }).catch(function () { _as.posting = false; });
}
// Fade by the age of each satellite's elements at the instant shown; one SGP4 could not answer for does not draw.
function _asAlphas(ms) {
  if (ms - _as.alphaAt < AS_ALPHA_REFRESH_MS && ms >= _as.alphaAt) return;
  var d = _as.data, al = _as.cloud.geometry.attributes.aAlpha.array, ok = _as.ok, n = d.n;
  var t = (ms - AS_EPOCH_ORIGIN_MS) / MS_PER_DAY;
  for (var i = 0; i < n; i++) {
    var age = Math.abs(t - d.epoch[i]);
    al[i] = !ok[i] || age >= AS_AGE_GONE_DAYS ? 0
      : age <= AS_AGE_FRESH_DAYS ? 1 : Math.max(AS_ALPHA_FLOOR, 1 - (age - AS_AGE_FRESH_DAYS) / (AS_AGE_GONE_DAYS - AS_AGE_FRESH_DAYS));
  }
  _as.cloud.geometry.attributes.aAlpha.needsUpdate = true;
  _as.alphaAt = ms;
}

// ── Taps ──
// A tap near a dot picks the nearest, unless it is behind the Earth. True when it took the tap.
function _asTap(x, y) {
  if (!_as.on || _as.state !== 'ready' || !_as.cloud || !_as.cloud.visible || !_as.sampleMs) return false;
  var a = _as.cloud.geometry.attributes, pos = a.position.array, vel = a.aVel.array, size = a.aSize.array, alpha = a.aAlpha.array;
  var dt = _as.cloud.material.uniforms.dt.value, cz = Math.cos(_as.cloud.rotation.z), sz = Math.sin(_as.cloud.rotation.z), n = _as.data.n;
  var found = [];
  for (var i = 0; i < n; i++) {
    if (!size[i] || alpha[i] <= 0) continue;
    var k = i * 3, px = pos[k] + vel[k] * dt, py = pos[k + 1] + vel[k + 1] * dt, pz = pos[k + 2] + vel[k + 2] * dt;
    var p = [px * cz - py * sz, px * sz + py * cz, pz], s = _aeProject(p);
    if (!s) continue;
    var dd = Math.hypot(s.x - x, s.y - y);
    if (dd < AS_TAP_RADIUS_PX) found.push({ i: i, d: dd, p: p });
  }
  found.sort(function (u, v) { return u.d - v.d; });
  for (var j = 0; j < found.length; j++) {
    if (_aeBehindEarth(found[j].p)) continue;
    _asSelect(found[j].i);
    return true;
  }
  return false;
}
function _asSelect(i) {
  if (i === _as.sel) return;
  var before = _as.sel;
  _as.sel = i;
  if (i >= 0) { _ae.selected = null; _ae.place = null; _ae.lm = null; }
  if (_as.cloud) {
    var size = _as.cloud.geometry.attributes.aSize.array, d = _as.data;
    [before, i].forEach(function (k) {
      if (k >= 0) size[k] = _asVisible(k) || k === i ? (k === i ? AS_POINT_SELECTED_PX : d.orbit[k] === 2 ? AS_POINT_GEO_PX : AS_POINT_PX) : 0;
    });
    _as.cloud.geometry.attributes.aSize.needsUpdate = true;
  }
  if (_as.selLine) { _as.selLine.visible = i >= 0; _as.selAt = 0; }
  if (_ae && _ae.gl) { _aeRenderCard(); _ae.dirty = true; _aeKick(); }
}
function _asHasSel() { return _as.sel >= 0 && _as.on && !!_as.data; }

// The selected satellite's orbit: one revolution from now, in the scene's frame (the cloud's own turn applied).
function _asUpdateSelOrbit(ms, sc) {
  if (!_as.selLine || Math.abs(ms - _as.selAt) < AS_ORBIT_REFRESH_MS && _as.selAt) return;
  var rec = _asRec(_as.sel);
  if (!rec) { _as.selLine.visible = false; return; }
  var d = _as.data, i = _as.sel, periodMs = 1440 / d.mm[i] * 60000, eqeq = _aeEqEq(sc), arr = _as.selLine.geometry.attributes.position.array, epoch = _asEpochMs(d, i);
  for (var k = 0; k < AS_ORBIT_POINTS; k++) {
    var pv = _as.lib.sgp4(rec, (ms + periodMs * k / AS_ORBIT_POINTS - epoch) / 60000);
    if (!pv || !pv.position || isNaN(pv.position.x)) { _as.selLine.visible = false; return; }
    var q = _aeTemeToScene(pv.position, eqeq);
    arr[k * 3] = q[0]; arr[k * 3 + 1] = q[1]; arr[k * 3 + 2] = q[2];
  }
  _as.selLine.geometry.attributes.position.needsUpdate = true;
  _as.selLine.geometry.setDrawRange(0, AS_ORBIT_POINTS);
  _as.selLine.visible = true;
  _as.selAt = ms;
}
var _asRecs = {};
function _asRec(i) {
  if (!_as.lib || !_as.data || i < 0) return null;
  if (!(i in _asRecs)) {
    try { var r = _as.lib.json2satrec(_asOmm(_as.data, i)); _asRecs[i] = r.error ? null : r; } catch (e) { _asRecs[i] = null; }
  }
  return _asRecs[i];
}
// Position (km, TEME) and speed (km/s) of one satellite at a time, or null.
function _asStateAt(i, ms) {
  var rec = _asRec(i);
  if (!rec) return null;
  var pv = _as.lib.sgp4(rec, (ms - _asEpochMs(_as.data, i)) / 60000);
  if (!pv || !pv.position || isNaN(pv.position.x)) return null;
  var v = pv.velocity, p = pv.position;
  return { pos: p, alt: Math.hypot(p.x, p.y, p.z) - AS_EARTH_RE_KM, speed: Math.hypot(v.x, v.y, v.z) };
}

// ── The card ──
function _asFlag(code) {
  var iso = AS_OWNER_ISO[code];
  if (!iso || iso.length !== 2) return '';
  return String.fromCodePoint(0x1F1E6 + iso.charCodeAt(0) - 65, 0x1F1E6 + iso.charCodeAt(1) - 65);
}
function _asOwnerName(code) {
  var iso = AS_OWNER_ISO[code];
  if (iso && typeof Intl !== 'undefined' && Intl.DisplayNames) {
    try {
      var lang = (typeof _lang !== 'undefined' && _lang) || document.documentElement.lang || 'en';
      var n = new Intl.DisplayNames([lang], { type: 'region' }).of(iso);
      if (n && n !== iso) return n;
    } catch (e) {}
  }
  return code;
}
function _asGroupLabel(g) { return g === 'other' ? _aeT('alm_sats_other') : { starlink: 'Starlink', oneweb: 'OneWeb', iridium: 'Iridium', gnss: 'GNSS' }[g]; }
// Drawn into the Earth view's card by almanac-earth.js _aeRenderCardBody; true when it is its card.
function _asRenderCard(card) {
  if (!_asHasSel()) return false;
  var d = _as.data, i = _as.sel, g = AS_GROUPS[d.group[i]], o = AS_ORBITS[d.orbit[i]];
  var owner = d.owners[d.owner[i]];
  var html = '<button type="button" class="ae-card-x" id="ae-card-x" aria-label="' + _almEsc(_aeT('alm_tm_close')) + '">×</button>' +
    '<h3>' + _almEsc(d.name[i]) + '</h3>';
  html += '<p>' + (owner ? _almEsc((_asFlag(owner) + ' ' + _asOwnerName(owner)).trim()) : '') +
    (d.launch[i] >= 0 ? (owner ? ' · ' : '') + _almEsc(_aeT('alm_sats_launched', { date: _aeFmtDate(AS_LAUNCH_ORIGIN_MS + d.launch[i] * MS_PER_DAY) })) : '') + '</p>';
  html += '<p id="as-card-line"></p><p class="as-card-learn">' +
    _asLearn(AS_GROUP_TERM[g], _almEsc(_asGroupLabel(g))) + ' · ' + _asLearn(AS_ORBIT_TERM[o], o.toUpperCase()) + '</p>';
  html += '<p id="as-card-age" class="ae-card-note"></p>';
  card.innerHTML = html;
  card.hidden = false;
  _aeById('ae-card-x').onclick = function () { _asSelect(-1); };
  _asUpdateCard(_aeDisplayMs());
  return true;
}
function _asLearn(key, html) { return _aeLinked(key) ? _aeLink(key, html) : html; }
function _asUpdateCard(ms) {
  if (!_asHasSel()) return false;
  var line = _aeById('as-card-line');
  if (!line) return true;
  var st = _asStateAt(_as.sel, ms);
  if (st) line.textContent = _aeT('alm_sats_line', { alt: _orrNum(st.alt, null, 0), v: _orrNum(st.speed, null, 2) });
  var age = _aeById('as-card-age'), days = Math.abs(ms - _asEpochMs(_as.data, _as.sel)) / MS_PER_DAY;
  if (age) age.textContent = days > AS_AGE_FRESH_DAYS ? _aeT('alm_earth_approx', { date: _aeFmtDate(_asEpochMs(_as.data, _as.sel)) }) : '';
  return true;
}

// ── The strip: filters, the count, the passes ──
var AS_BAR_CSS = [
  '.as-bar{box-sizing:border-box;width:100%;display:flex;gap:6px;align-items:center;padding:0 16px;overflow-x:auto;scrollbar-width:none;pointer-events:auto;-webkit-mask-image:linear-gradient(90deg,transparent,#000 12px,#000 calc(100% - 12px),transparent);mask-image:linear-gradient(90deg,transparent,#000 12px,#000 calc(100% - 12px),transparent)}',
  '.as-bar::-webkit-scrollbar{display:none}',
  '.as-bar[hidden],.as-sheet[hidden]{display:none}',
  '.as-bar .ae-btn{flex:none;font-size:12px;padding:6px 10px;min-height:30px;display:inline-flex;align-items:center;gap:6px}',
  '.as-bar .ae-round{width:30px;height:30px;padding:0}',
  '.as-dot{width:8px;height:8px;border-radius:50%;background:currentColor;flex:none}',
  '.as-count{flex:none;font-size:12px;color:var(--text2);font-variant-numeric:tabular-nums;padding:0 4px}',
  '.as-sep{flex:none;width:1px;height:18px;background:var(--border)}',
  '.as-flag{font-size:15px;line-height:1}',
  '.as-failed{opacity:.5}',
  '.as-sheet{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(150px + env(safe-area-inset-bottom));width:min(420px,calc(100% - 32px));max-height:42vh;overflow-y:auto;overscroll-behavior:contain;box-sizing:border-box;background:rgba(18,18,20,.985);border:1px solid var(--border);border-radius:12px;padding:10px 12px;font-size:13px;color:var(--text2);pointer-events:auto}',
  '.as-sheet h3{margin:0 24px 6px 0;font-size:14px;font-weight:600;color:var(--text)}',
  '.as-sheet .as-x{position:absolute;top:6px;right:8px;background:none;border:0;color:var(--text2);font-size:20px;cursor:pointer;line-height:1}',
  '.as-pass{display:grid;grid-template-columns:auto 1fr auto;gap:2px 10px;width:100%;text-align:start;font:inherit;color:inherit;background:none;border:0;border-top:1px solid var(--border);padding:7px 0;cursor:pointer}',
  '.as-pass:first-of-type{border-top:0}',
  '.as-pass b{font-weight:600;color:var(--text);font-variant-numeric:tabular-nums}',
  '.as-pass span{font-variant-numeric:tabular-nums}',
  '.as-note{margin:6px 0 0;font-size:11.5px;opacity:.8}',
  '.as-gps{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px}',
  '@media (orientation:landscape) and (max-height:500px){.as-sheet{bottom:calc(56px + env(safe-area-inset-bottom))}}'
].join('');
var AS_PASSES_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18c4-9 10-13 18-13"/><circle cx="9" cy="12.5" r="1.7" fill="currentColor" stroke="none"/><circle cx="15" cy="8.6" r="1.7" fill="currentColor" stroke="none"/></svg>';

function _asChip(kind, key, inner, label) {
  return '<button type="button" class="ae-btn" data-k="' + kind + '" data-v="' + _almEsc(key) + '" aria-pressed="false"' +
    (label ? ' aria-label="' + _almEsc(label) + '" title="' + _almEsc(label) + '"' : '') + '>' + inner + '</button>';
}
function _asBuildBar() {
  if (_as.bar && _as.bar.isConnected) return;
  var host = _aeById('ae-view') || (_ae && _ae.el);
  if (!host) return;
  if (!document.getElementById('as-style')) {
    var st = document.createElement('style');
    st.id = 'as-style';
    st.textContent = AS_BAR_CSS;
    document.head.appendChild(st);
  }
  var d = _as.data, html = '<span class="as-count" id="as-count" aria-live="polite"></span><span class="as-sep"></span>';
  AS_GROUPS.forEach(function (g) {
    var c = AS_GROUP_COLOR[g];
    html += _asChip('group', g, '<i class="as-dot" style="background:rgb(' + c.map(function (x) { return Math.round(x * 255); }).join(',') + ')"></i>' + _almEsc(_asGroupLabel(g)));
  });
  html += '<span class="as-sep"></span>';
  AS_ORBITS.forEach(function (o) { html += _asChip('orbit', o, o.toUpperCase()); });
  html += '<span class="as-sep"></span>';
  d.topOwners.forEach(function (o) {
    html += _asChip('owner', o, _asFlag(o) ? '<span class="as-flag">' + _asFlag(o) + '</span>' : _almEsc(o), _asOwnerName(o));
  });
  html += '<span class="as-sep"></span><button type="button" class="ae-btn ae-round" id="as-passes" aria-label="' + _almEsc(_aeT('alm_sats_passes')) + '" title="' + _almEsc(_aeT('alm_sats_passes')) + '" aria-pressed="false">' + AS_PASSES_SVG + '</button>';
  var bar = document.createElement('div');
  bar.className = 'as-bar';
  bar.id = 'as-bar';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', _aeT('alm_sats_all'));
  bar.hidden = true;
  bar.innerHTML = html;
  bar.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button');
    if (!b) return;
    if (b.id === 'as-passes') { _asToggleSheet(); return; }
    var set = _as.filter[b.getAttribute('data-k')], v = b.getAttribute('data-v');
    set[v] = !set[v];
    b.setAttribute('aria-pressed', String(!!set[v]));
    _asApplyFilters();
  });
  var views = _aeById('ae-views');
  if (views && views.parentNode) views.parentNode.insertBefore(bar, views); else host.appendChild(bar);   // in the bottom stack, above the view chips
  _as.bar = bar;
  _asCount();
  _asSync();
}
// The strip is for the Earth: it goes while the view is elsewhere.
function _asSyncBar() {
  if (!_as.bar) return;
  var hide = !(_as.on && _as.state === 'ready' && _ae && _ae.target === 'earth');
  if (_as.bar.hidden !== hide) _as.bar.hidden = hide;
  if (hide && _as.sheet) _asCloseSheet();
}

// ── Passes ──
function _asPlace() {
  var p = typeof _getLocation === 'function' ? _getLocation() : null;
  return p && p.lat != null ? { lat: p.lat, lon: p.lon, stored: p.stored } : null;
}
// The pass list for the place and the next day, asked of the worker when there is none for this place yet.
function _asNeedPasses(place) {
  place = place || _asPlace();
  if (!place || _as.state !== 'ready' || _as.passBusy) return;
  var t = _as.passPlace;
  if (t && Math.abs(t.lat - place.lat) < 0.05 && Math.abs(t.lon - place.lon) < 0.05 && Date.now() - t.at < AS_PASS_HOURS * 1800 * 1000) return;
  var d = _as.data, cand = [], area = [], altKm = [], inc = [];
  for (var i = 0; i < d.n; i++) {
    if (d.mm[i] < AS_PASS_LEO_MM || d.alt[i] > AS_LEO_MAX_KM) continue;
    var a = _asAreaM2(i);
    if (!a) continue;
    cand.push(i); area.push(a); altKm.push(d.alt[i]); inc.push(d.inc[i]);
  }
  _as.passBusy = true;
  var t0 = Date.now();
  _asAsk({
    cmd: 'passes', lat: place.lat, lon: place.lon, t0: t0, hours: AS_PASS_HOURS, step: AS_PASS_STEP_S, refine: AS_PASS_REFINE_S,
    minEl: AS_PASS_MIN_EL, sunAlt: AS_PASS_SUN_ALT, magLimit: AS_PASS_MAG_LIMIT,
    cand: cand, area: area, altKm: altKm, inc: inc
  }).then(function (r) {
    _as.passes = _asTrim(_asGroupTrains(r.list.sort(function (u, v) { return u.start - v.start; })));
    _as.passPlace = { lat: place.lat, lon: place.lon, at: t0 };
    _asRenderSheet();
    _skyKickNow();
  }).catch(function () {
    _as.passes = [];
    _as.passPlace = { lat: place.lat, lon: place.lon, at: t0 };   // not asked again at every paint
  }).then(function () { _as.passBusy = false; });
}
// A satellite's size for the brightness estimate: its radar cross-section, or a stated size for the big constellations.
function _asAreaM2(i) {
  var d = _as.data, g = AS_GROUPS[d.group[i]];
  if (d.norad[i] === AS_ISS_NORAD) return AS_PASS_AREA_M2.iss;
  if (d.rcs[i] >= AS_PASS_MIN_RCS_M2) return d.rcs[i];
  return AS_PASS_AREA_M2[g] || 0;
}
// Starlinks launched together cross the sky in a line: passes close in time and in orbital plane are one train.
function _asGroupTrains(list) {
  var d = _as.data, out = [], open = null;
  list.forEach(function (p) {
    var star = AS_GROUPS[d.group[p.i]] === 'starlink';
    if (star && open && p.peak - open.last <= AS_TRAIN_GAP_S * 1000 && Math.abs(d.raan[p.i] - d.raan[open.i]) < AS_TRAIN_RAAN_DEG) {
      open.members.push(p.i); open.last = p.peak; open.end = Math.max(open.end, p.end); open.mag = Math.min(open.mag, p.mag);
      return;
    }
    var q = Object.assign({ members: [p.i], last: p.peak }, p);
    out.push(q);
    open = star ? q : null;
  });
  return out;
}
// A dusk sky has hundreds of Starlinks over a place: those that are not trains are cut to the brightest, in time order.
function _asTrim(list) {
  var d = _as.data;
  var lone = list.filter(function (p) { return AS_GROUPS[d.group[p.i]] === 'starlink' && p.members.length < AS_TRAIN_MIN; })
    .sort(function (u, v) { return u.mag - v.mag; }).slice(AS_PASS_LONE_STARLINKS);
  return list.filter(function (p) { return lone.indexOf(p) < 0; }).slice(0, AS_PASS_MAX);
}
var AS_ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
function _asArrow(az) { return AS_ARROWS[Math.round(az / 45) % 8]; }
// The zone the Almanac's clock shows (almanac.js _almClockParts): the place's when it is not the device's.
var AS_TIME_OPTS = { hour: 'numeric', minute: '2-digit' }, AS_DAY_OPTS = { year: 'numeric', month: 'numeric', day: 'numeric' }, AS_WEEKDAY_OPTS = { weekday: 'short' };
function _asZone(ms) { return _almClockParts(new Date(ms)).tzId; }
function _asTimeText(ms, tz) { return _tzFmt(tz, AS_TIME_OPTS).format(new Date(ms)); }
function _asDayText(ms, tz) {
  var a = new Date(ms);
  if (_tzFmt(tz, AS_DAY_OPTS).format(a) === _tzFmt(tz, AS_DAY_OPTS).format(new Date())) return '';
  return _tzFmt(tz, AS_WEEKDAY_OPTS).format(a) + ' ';
}
function _asRenderSheet() {
  var el = _as.sheetEl;
  if (!el || el.hidden) return;
  var d = _as.data, now = Date.now(), tz = _asZone(now);
  var html = '<button type="button" class="as-x" id="as-x" aria-label="' + _almEsc(_aeT('alm_tm_close')) + '">×</button><h3>' + _almEsc(_aeT('alm_sats_passes')) + ' · ' + _almEsc(_formatTimezone(null, tz, new Date(now))) + '</h3>';
  var gps = _asGpsNow();
  html += '<div class="as-gps"><span>' + _almEsc(_aeT('alm_sats_gps_overhead')) + ' · <b>' + gps.length + '</b></span>' +
    '<button type="button" class="ae-btn" id="as-gps-btn" aria-pressed="' + _asGpsOn() + '">' + _almEsc(_aeT('alm_sats_in_sky')) + '</button></div>';
  var list = (_as.passes || []).filter(function (p) { return p.end > now; });
  if (!_as.passes) html += '<p class="as-note" aria-busy="true">…</p>';
  else if (!list.length) html += '<p>' + _almEsc(_aeT('alm_sats_no_passes')) + '</p>';
  list.forEach(function (p) {
    var name = p.members.length >= AS_TRAIN_MIN ? _aeT('alm_sats_train', { n: p.members.length }) : d.name[p.i];
    html += '<button type="button" class="as-pass" data-i="' + p.i + '"><b>' + _almEsc(_asDayText(p.start, tz) + _asTimeText(p.start, tz)) + '</b>' +
      '<span>' + _almEsc(name) + '</span><span>' + _almEsc(_orrNum(p.mag, null, 1)) + '</span>' +
      '<span></span><span>' + _asArrow(p.azS) + ' — ' + _asArrow(p.azE) + '</span><span>' + _almEsc(_orrNum(p.el, null, 0)) + '°</span></button>';
  });
  html += '<p class="as-note">' + _almEsc(_aeT('alm_sats_mag_note')) + '</p>';
  el.innerHTML = html;
  _asPlaceSheet();
  _aeById('as-x').onclick = _asCloseSheet;
  _aeById('as-gps-btn').onclick = function () {
    try { localStorage.setItem(AS_GPS_KEY, _asGpsOn() ? '' : AS_ON); } catch (e) {}
    if (_asGpsOn() === false) try { localStorage.removeItem(AS_GPS_KEY); } catch (e) {}
    this.setAttribute('aria-pressed', String(_asGpsOn()));
    _skyKickNow();
  };
  Array.prototype.forEach.call(el.querySelectorAll('.as-pass'), function (b) {
    b.onclick = function () { _asSelect(Number(b.getAttribute('data-i'))); _asCloseSheet(); };
  });
}
function _asToggleSheet() { if (_as.sheet) _asCloseSheet(); else _asOpenSheet(); }
function _asOpenSheet() {
  var host = _aeById('ae-view') || (_ae && _ae.el);
  if (!host) return;
  if (!_as.sheetEl) {
    _as.sheetEl = document.createElement('div');
    _as.sheetEl.className = 'as-sheet';
    _as.sheetEl.setAttribute('role', 'dialog');
    _as.sheetEl.setAttribute('aria-label', _aeT('alm_sats_passes'));
    host.appendChild(_as.sheetEl);
  }
  _as.sheet = true;
  _as.sheetEl.hidden = false;
  var b = _aeById('as-passes');
  if (b) b.setAttribute('aria-pressed', 'true');
  _asSelect(-1);
  _asNeedPasses();
  _asRenderSheet();
}
// The sheet stands on the strip, and reaches no higher than the top controls (their column is 56 px).
var AS_SHEET_TOP_CLEAR_PX = 56, AS_SHEET_GAP_PX = 6;
function _asPlaceSheet() {
  var el = _as.sheetEl, bar = _as.bar;
  if (!el || !bar || !el.parentNode) return;
  var hb = el.parentNode.getBoundingClientRect(), bb = bar.getBoundingClientRect();
  el.style.bottom = Math.max(8, hb.bottom - bb.top + AS_SHEET_GAP_PX) + 'px';
  el.style.maxHeight = Math.max(120, bb.top - hb.top - AS_SHEET_TOP_CLEAR_PX) + 'px';
}
function _asCloseSheet() {
  _as.sheet = false;
  if (_as.sheetEl) _as.sheetEl.hidden = true;
  var b = _aeById('as-passes');
  if (b) b.setAttribute('aria-pressed', 'false');
}

// ── Overhead now, and in the live sky ──
// The GPS satellites above the horizon of the person's place, from the elements the view already holds.
function _asLook(posKm, ms, place) {
  var th = _asGmst(ms) + place.lon * Math.PI / 180, lat = place.lat * Math.PI / 180;
  var sl = Math.sin(lat), cl = Math.cos(lat), st = Math.sin(th), ct = Math.cos(th);
  var A = 6378.137, f = 1 / 298.257223563, e2 = f * (2 - f), n0 = A / Math.sqrt(1 - e2 * sl * sl);
  var ox = n0 * cl * ct, oy = n0 * cl * st, oz = n0 * (1 - e2) * sl;
  var rx = posKm.x - ox, ry = posKm.y - oy, rz = posKm.z - oz, range = Math.hypot(rx, ry, rz);
  var up = rx * cl * ct + ry * cl * st + rz * sl, east = -rx * st + ry * ct, north = -rx * sl * ct - ry * sl * st + rz * cl;
  return { el: Math.asin(up / range) * 180 / Math.PI, az: (Math.atan2(east, north) * 180 / Math.PI + 360) % 360, range: range };
}
function _asGmst(ms) {
  var n = ms / MS_PER_DAY + 2440587.5 - 2451545.0;
  return (((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24) * 15 * Math.PI / 180;
}
function _asGpsNow(ms, place) {
  place = place || _asPlace();
  ms = ms || Date.now();
  if (!place || !_ae || !_ae.sats) return [];
  var out = [];
  _ae.sats.list.forEach(function (s) {
    if (s.iss) return;
    var st = _aeSatAt(s, ms, 0);
    if (!st) return;
    var lk = _asLook(st.posKm, ms, place);
    if (lk.el >= AS_GPS_MIN_EL) out.push({ name: _aeSatShortName(s), el: lk.el, az: lk.az });
  });
  return out;
}
function _skyKickNow() { if (typeof _skyKick === 'function' && typeof _skyState !== 'undefined' && _skyState) _skyKick(); }
// The live sky: called from almanac-sky.js _skyPaintActors after the ISS. Passes under way now are drawn as moving points
// at the sky's own positions, with the GPS satellites overhead as small rings when asked for. Panorama only, like the ISS.
function _asSkyPaint(ctx, s) {
  if (!_as.on || _as.state !== 'ready') return;
  var place = { lat: s.lat, lon: s.lon };
  _asNeedPasses(place);
  var ms = _skyLive() ? Date.now() : s.nowTime, dpr = s.dpr, drawn = false;
  if (_as.passes && s.eph && s.eph.sunGeoAlt < AS_PASS_SUN_ALT + 1) {
    _as.passes.forEach(function (p) {
      if (ms < p.start || ms > p.end) return;
      p.members.forEach(function (i, k) {
        var st = _asStateAt(i, ms);
        if (!st) return;
        var lk = _asLook(st.pos, ms, place);
        if (lk.el < 0) return;
        var x = _skyX(s, lk.az);
        if (!_skyInView(s, x, 4)) return;
        var y = _skyY(s, lk.el), near = _aeClamp(1 - (p.mag - 0) / 6, 0.25, 1);
        _skyLight(ctx, x, y, (1.4 + 2 * near) * dpr, [255, 250, 235], 0.6 + 0.4 * near);
        if (p.members.length < AS_TRAIN_MIN || k === 0) {
          ctx.fillStyle = 'rgba(255,250,235,.8)';
          ctx.font = (11 * dpr) + 'px sans-serif';
          ctx.fillText(p.members.length >= AS_TRAIN_MIN ? _aeT('alm_sats_train', { n: p.members.length }) : _as.data.name[i], x + 6 * dpr, y - 6 * dpr);
        }
        drawn = true;
      });
    });
  }
  if (_asGpsOn()) {
    _asGpsNow(ms, place).forEach(function (g) {
      var x = _skyX(s, g.az);
      if (!_skyInView(s, x, 4)) return;
      var y = _skyY(s, g.el);
      ctx.strokeStyle = 'rgba(140,215,255,.85)';
      ctx.lineWidth = 1.2 * dpr;
      ctx.beginPath(); ctx.arc(x, y, 4 * dpr, 0, 6.2832); ctx.stroke();
      ctx.fillStyle = 'rgba(140,215,255,.9)';
      ctx.font = (10 * dpr) + 'px sans-serif';
      ctx.fillText(String(g.name).replace(/^GPS\s*/, ''), x + 7 * dpr, y + 3 * dpr);
      drawn = true;
    });
  }
  // The sky repaints twice a second while something of these is up (its ISS timer).
  if (drawn) s.issUp = true;
}
