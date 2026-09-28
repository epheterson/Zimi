// The Almanac's 3D Earth (zimi/static/almanac-earth.js) as a view: what it
// shows and when, what it holds on to, and what it says when something is
// missing. The maths behind each pixel is tests/test_almanac_earth.cjs.
//
// Executed from the shipped files: almanac-orrery.js (the clock the view is
// a close-up of), almanac-earth.js, the vendored satellite.js, and the
// vendored three.js with only the two parts that need a GPU or a network
// replaced (WebGLRenderer records its calls, TextureLoader answers as told).
// The DOM is a small fake that remembers what was written to it.
//
//   1. The clock: the view shows the orrery's instant (a ride moves it), a
//      clock moved off now is not Live, and Now brings the orrery back too.
//   2. The orbital data: told the server is refreshing, the open view asks
//      once more and gets the fresh elements; a failed load says so and is
//      asked for again at the next open; no data at all is said plainly.
//   3. The ISS: a dot while its place along the orbit is known, faded while
//      it is roughly known, and past two weeks the orbit alone, dated.
//
// Run: node tests/test_almanac_earth_view.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STATIC = path.join(ROOT, 'zimi', 'static');
const read = (f) => fs.readFileSync(path.join(STATIC, f), 'utf8');
const almSrc = read('almanac.js');
const DAY = 86400000;

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced braces extracting ' + name);
}
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// ── A DOM that remembers ──
// Elements by id are made on first ask and live under one parent, so the
// view can swap its canvas for a fresh one the way it does in a browser.
const NULL_IDS = new Set(['almanac-orrery']);   // the orrery's canvas: not drawn here
const byId = new Map();
function fakeEl(id) {
  const el = {
    id, hidden: false, textContent: '', innerHTML: '', className: '', style: {}, attrs: {}, listeners: {},
    clientWidth: 390, clientHeight: 844, parentNode: null,
    classList: {
      set: new Set(),
      add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); },
      toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); },
    },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    appendChild(c) { c.parentNode = el; return c; },
    replaceChild(fresh, old) { fresh.parentNode = el; old.parentNode = null; if (old.id) byId.set(old.id, fresh); },
    cloneNode() { const c = fakeEl(el.id); c.className = el.className; c.attrs = Object.assign({}, el.attrs); return c; },
    focus() {}, setPointerCapture() {}, getBoundingClientRect() { return { left: 0, top: 0 }; },
  };
  return el;
}
const root = fakeEl('root');
const document = {
  hidden: false,
  body: fakeEl('body'),
  head: fakeEl('head'),
  getElementById(id) {
    if (NULL_IDS.has(id)) return null;
    if (!byId.has(id)) { const e = fakeEl(id); e.parentNode = root; byId.set(id, e); }
    return byId.get(id);
  },
  createElement() { return fakeEl(null); },
  querySelectorAll() { return []; },
  addEventListener() {},
};
const text = (id) => document.getElementById(id).textContent;

// ── three.js, with the GPU and the network stood in for ──
const renderers = [];
class FakeRenderer {
  constructor(opts) { this.opts = opts; this.calls = []; this.pr = 1; this.capabilities = { getMaxAnisotropy: () => 16 }; renderers.push(this); }
  setPixelRatio(r) { this.pr = r; }
  getPixelRatio() { return this.pr; }
  setClearColor() {}
  setSize(w, h, style) { this.calls.push(['setSize', w, h, style]); }
  render() { this.calls.push(['render']); }
  dispose() { this.calls.push(['dispose']); }
  forceContextLoss() { this.calls.push(['forceContextLoss']); }
  lastSize() { const s = this.calls.filter((c) => c[0] === 'setSize').pop(); return s && s.slice(1); }
  did(name) { return this.calls.some((c) => c[0] === name); }
}
const mapPlan = {};      // url -> 'fail' to make that map fail to load
const mapAsks = [];      // every url asked for
const textures = [];     // every map handed to the view
let THREE = null;
// The vendored three.js is tree-shaken to what the view uses, which has no
// Texture class of its own: a map here is what the view touches of one.
function fakeTexture(url) {
  const tx = { isTexture: true, url, anisotropy: 1, disposed: false, dispose() { this.disposed = true; } };
  textures.push(tx);
  return tx;
}

// ── Timers, frames and the network ──
const timers = [];
const fetches = [];      // queued answers: an object (the JSON), or 'fail'
let fetchCount = 0;
function fakeFetch() {
  fetchCount++;
  const next = fetches.shift();
  if (!next || next === 'fail') return Promise.reject(new TypeError('Failed to fetch'));
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(next) });
}

const S = {
  Math, Date, Intl, Object, JSON, console, String, Number, Array, isNaN, Float32Array, Uint8Array,
  document,
  window: { devicePixelRatio: 3, addEventListener() {} },
  performance: { now: () => Date.now() },
  requestAnimationFrame: () => 1,
  cancelAnimationFrame() {},
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  clearTimeout() {},
  fetch: fakeFetch,
};
vm.createContext(S);
vm.runInContext(
  'var JD_UNIX_EPOCH = 2440587.5, JD_J2000 = 2451545.0, MS_PER_DAY = 86400000, JULIAN_CENTURY = 36525;' +
  'var DEG_TO_RAD = Math.PI / 180; var _almanacOpen = true; var _almFocus = null; var _currentLang = "en";' +
  'function t(k, vars) { return vars ? k + JSON.stringify(vars) : k; }' +
  'function _tp(n) { return n; }', S);
for (const fn of ['_dateToJD', '_almEsc', '_jdnToGregorian', '_cnDeltaTdays', '_speedToSlider', '_formatSpeed']) vm.runInContext(extractFn(almSrc, fn), S);
vm.runInContext(read('almanac-orrery.js'), S);
vm.runInContext(read('almanac-earth.js'), S);
vm.runInContext(read('earth/satellite-7.1.0.min.js'), S);
S.window.SatelliteJS = S.SatelliteJS;
const run = (code) => vm.runInContext(code, S);

(async () => {
  const T = await import('data:text/javascript;base64,' + Buffer.from(read('earth/three-r186.min.js')).toString('base64'));
  class FakeLoader {
    load(url, onLoad, onProgress, onError) {
      mapAsks.push(url);
      setImmediate(() => (mapPlan[url] === 'fail' ? onError(new Error('404')) : onLoad(fakeTexture(url))));
    }
  }
  THREE = Object.assign({}, T, { WebGLRenderer: FakeRenderer, TextureLoader: FakeLoader });
  S._aeThreePromise = Promise.resolve(THREE);

  // ── 1. The clock ──────────────────────────────────────────────────────
  {
    run('_ae = _aeNewState(document.createElement("div"));');
    // A ride to Mars moves the orrery's clock 259 days on (almanac-orrery.js
    // advances _orreryTimeOffset as the rocket flies).
    S._orreryTimeOffset = 259 * DAY;
    const shown = run('_aeDisplayMs()');
    check(Math.abs(shown - (Date.now() + 259 * DAY)) < 5000,
      'after a ride to Mars the view shows the orrery\'s date, ' + new Date(shown).toISOString().slice(0, 10));
    check(run('_aeIsLive()') === false, 'a clock the orrery moved off now is not Live');
    S._orreryTimeOffset = 0;
    check(run('_aeIsLive()') === true, 'with the orrery at now, the view is Live');
    S._almFocus = new Date(Date.UTC(2031, 4, 21, 12));
    check(run('_aeDisplayMs()') === Date.UTC(2031, 4, 21, 12), 'the time machine, when set, is the orrery\'s clock and the view\'s');
    check(run('_aeIsLive()') === false, 'under the time machine the view is not Live');
    S._almFocus = null;
    S._orreryTimeOffset = 259 * DAY;
    run('_aeNow()');
    check(S._orreryTimeOffset === 0 && run('_aeIsLive()') === true, 'Now brings the orrery back to now as well');
  }

  // ── 2. The orbital data ───────────────────────────────────────────────
  const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'zimi', 'assets', 'satellites-snapshot.json'), 'utf8'));
  const answer = (over) => Object.assign({ source: 'snapshot', fetched: snap.fetched, gps: snap.gps, iss: snap.iss, refreshing: false }, over);
  const refetchTimers = () => timers.filter((x) => x.ms === S.AE_SATS_REFETCH_MS);
  const reopen = async () => { run('_aeClose()'); run('openAlmanacEarth()'); await flush(); };
  const note = () => { run('_aeUpdateText(_aeDisplayMs())'); return text('ae-note'); };
  {
    run('_ae = null;');
    fetches.push(answer({ refreshing: true }));
    run('openAlmanacEarth()');
    await flush();
    check(run('_ae.sats.list.length') === snap.gps.length + 1, 'the view loads the elements the server has');
    check(typeof S.AE_SATS_REFETCH_MS === 'number' && refetchTimers().length === 1,
      'told a refresh is running, it asks again once the refresh has had time to land');
    fetches.push(answer({ source: 'cache', fetched: '2026-09-28T12:00:00Z', refreshing: false }));
    if (refetchTimers()[0]) refetchTimers()[0].fn();
    await flush();
    check(run('_ae.sats.source') === 'cache', 'the fresh elements reach the view while it is open');
    check(refetchTimers().length === 1, 'one refresh, one more ask: never a loop');

    // A failed load is asked for again at the next open, and says so meanwhile.
    run('_ae.sats = null;');
    fetches.push('fail');
    await reopen();
    check(run('_ae.satsFailed') === true && note().includes('alm_earth_sats_unavailable'), 'a failed load says the satellites are unavailable');
    const before = fetchCount;
    fetches.push(answer({}));
    await reopen();
    check(fetchCount === before + 1 && run('!!_ae.sats && _ae.sats.list.length > 0'), 'the next open asks again and draws them');

    // Nothing here at all: no claim of data "from today".
    fetches.push(answer({ source: 'none', fetched: null, gps: [], iss: null }));
    await reopen();
    const n = note();
    check(n.includes('alm_earth_no_orbital_data') && !n.includes('alm_earth_data_from'),
      'with no orbital data the note says there is none (' + n + ')');
  }

  // ── 3. The ISS ────────────────────────────────────────────────────────
  {
    fetches.push(answer({}));
    await reopen();
    const issEpoch = Date.parse(snap.iss.EPOCH);
    // The ISS's dot, as drawn: its alpha, or null when it has none.
    const issDot = () => run('(function () { for (var i = 0; i < _ae.positions.length; i++) {' +
      ' if (_ae.sats.list[_ae.positions[i].idx].iss) return _ae.gl.sats.geometry.attributes.aAlpha.array[i]; } return null; })()');
    const ringCount = () => run('_ae.gl.issRing.geometry.drawRange.count');
    run('_aeUpdate(' + (issEpoch + DAY) + ')');
    check(issDot() === 1 && ringCount() === S.AE_ISS_RING_POINTS, 'a day from its data the ISS has its dot and its orbit');
    run('_ae.selected = { norad: ' + snap.iss.NORAD_CAT_ID + ', tapMs: ' + (issEpoch + DAY) + ' }; _aeRenderCard();');
    run('_aeUpdate(' + (issEpoch + 10 * DAY) + ')');
    check(issDot() !== null && issDot() < 1, 'ten days on the ISS dot is faded');
    run('_aeUpdate(' + (issEpoch + 20 * DAY) + ')');
    check(issDot() === null, 'twenty days on no ISS dot is drawn');
    check(ringCount() === S.AE_ISS_RING_POINTS, 'but its orbit is');
    const n = note();
    check(n.includes('alm_earth_iss_orbit_only'), 'and the note says why, with the data\'s date (' + n + ')');
    check(run('_ae.selected') === null && document.getElementById('ae-card').hidden === true,
      'a card open on the ISS closes with its dot');
  }

  if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
  console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
