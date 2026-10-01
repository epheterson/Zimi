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
//   1. The clock: one clock, the Almanac's (its focus, or now). The view
//      shows it, its speeds run it and land the page on the moment, a moment
//      chosen on the orrery becomes the page's when the view opens on it,
//      and Now brings the page and the orrery back to now.
//   2. The orbital data: told the server is refreshing, the open view asks
//      once more and gets the fresh elements; a failed load says so and is
//      asked for again at the next open; no data at all is said plainly.
//   3. The ISS: a dot while its place along the orbit is known, faded while
//      it is roughly known, and past two weeks the orbit alone, dated.
//   4. Memory: closing the view shrinks its drawing buffer to a pixel;
//      closing the Almanac (its real teardown) disposes every geometry,
//      material and map, loses the context and swaps in a fresh canvas,
//      and the next open builds it all again; no multisampling at 2x+.
//   5. Maps that fail: the Moon's face draws a plain grey Moon (never black
//      on black) and the city lights none, the note says so, and the next
//      open asks again; the day map (the view itself) gives the GPU back and
//      says the view is unavailable, and the next open starts over.
//   6. Satellite data from the internet: under Ask first, stale data is
//      dated and offered fresh to a viewer who may fetch (one POST, and the
//      view redraws from its answer; a failure says so); under Never, or to
//      anyone else, it is dated and nothing more. The gear shows the choice
//      to everyone, lets an admin change it (one POST, then the view asks
//      again), and says why when it cannot be changed.
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
    removeAttribute(k) { delete this.attrs[k]; },
  };
  el.style = {
    setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; },
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
  querySelector() { return null; },
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
  compile() { this.calls.push(['compile']); }
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
const fetches = [];      // queued answers: an object (the JSON), { __status } (a refusal), or 'fail'
const requests = [];     // every request made: { url, method, body }
let fetchCount = 0;
function fakeFetch(url, opts) {
  fetchCount++;
  requests.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body });
  const next = fetches.shift();
  if (!next || next === 'fail') return Promise.reject(new TypeError('Failed to fetch'));
  if (next.__status) return Promise.resolve({ ok: false, status: next.__status, json: () => Promise.resolve({}) });
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
  'function _tp(n) { return n; } function _cancelAllRAF() {} function _setWindowTitle() {}' +
  // The page's side of the clock: where it settles, recorded.
  'var _almSettled = []; function _almScrubSettle(d) { _almSettled.push(d.getTime()); _almFocus = d; }' +
  'function _almBackToToday() { _almSettled.push(null); _almFocus = null; } function _almHeroLiveStop() {}', S);
for (const fn of ['_dateToJD', '_almEsc', '_jdnToGregorian', '_cnDeltaTdays', '_speedToSlider', '_formatSpeed',
                  '_almanacTeardown', '_almFocusInstant']) vm.runInContext(extractFn(almSrc, fn), S);
vm.runInContext(extractFn(read('app.js'), '_smoothstep'), S);
// The shared angle and Moon-orientation helpers the view borrows from the
// Almanac's other files (one global scope in the browser).
vm.runInContext(extractFn(read('almanac-sky.js'), '_angleDelta'), S);
vm.runInContext('var _MOON_EQUATOR_TILT_DEG = 1.54242;', S);
for (const fn of ['_moonEqCoords', '_moonLimbAngles', '_moonLimbAnglesOf', '_moonAxisOf', '_moonView', '_moonPhase', '_normDeg360'])
  vm.runInContext(extractFn(read('app.js'), fn), S);
vm.runInContext(require('./moon_model.cjs')(), S);
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
    // One clock: the Almanac's. Live, it is now.
    check(Math.abs(run('_aeDisplayMs()') - Date.now()) < 5000 && run('_aeIsLive()') === true, 'live, the view shows now');
    S._almFocus = new Date(Date.UTC(2031, 4, 21, 12));
    check(run('_aeDisplayMs()') === Date.UTC(2031, 4, 21, 12), 'the time machine, when set, is the view\'s clock');
    check(run('_aeIsLive()') === false, 'under the time machine the view is not Live');
    // The orrery's own clock (a ride to Mars moves it 259 days on) is not a
    // second clock: the view shows the page's.
    S._orreryTimeOffset = 259 * DAY;
    check(run('_aeDisplayMs()') === Date.UTC(2031, 4, 21, 12), 'the orrery\'s ride does not move the view off the page\'s clock');
    // A speed runs the page's clock: an hour a second for a second.
    S._almFocus = null; S._orreryTimeOffset = 0; run('_almSettled = []; _ae.speed = 3600;');
    run('_aeRunClock(3600 * 1000)');
    check(S._almFocus && Math.abs(S._almFocus.getTime() - (Date.now() + 3600 * 1000)) < 5000 && run('_aeIsLive()') === false,
      'an hour a second runs the page\'s clock an hour on');
    const ran = S._almFocus.getTime();
    run('_aeSetSpeed(1)');
    check(run('_almSettled.length') === 1 && run('_almSettled[0]') === ran, 'back at real time the page lands on the moment it ran to');
    run('_aeSetSpeed(1)');
    check(run('_almSettled.length') === 1, 'and lands once');
    // Now: the page and the orrery.
    S._orreryTimeOffset = 259 * DAY;
    run('_aeNow()');
    check(S._almFocus === null && S._orreryTimeOffset === 0 && run('_aeIsLive()') === true, 'Now brings the page and the orrery back to now');
    // The orrery spins fast from the start as scenery: opening the view from
    // it leaves the page at now; a moment someone chose there (the slider, a
    // ride) becomes the page's.
    S._orreryTimeOffset = 40 * DAY; S._orreryClockChosen = false; run('_almSettled = [];');
    run('_aeAdoptOrreryClock()');
    check(S._almFocus === null && run('_aeIsLive()') === true, 'the orrery\'s own spin: the view opens at now, Live');
    S._orreryClockChosen = true;
    run('_aeAdoptOrreryClock()');
    check(S._almFocus && Math.abs(S._almFocus.getTime() - (Date.now() + 40 * DAY)) < 5000 && run('_aeIsLive()') === false,
      'a moment chosen on the orrery: the page and the view open there');
    S._orreryClockChosen = false; S._almFocus = new Date(Date.UTC(2031, 4, 21, 12)); run('_almSettled = [];');
    run('_aeAdoptOrreryClock()');
    check(run('_aeDisplayMs()') === Date.UTC(2031, 4, 21, 12) && run('_almSettled.length') === 0, 'the time machine: the view opens at its moment');
    S._almFocus = null; S._orreryTimeOffset = 0;
    check(/function _orrerySliderInput\(val\) \{\s*_orreryClockChosen = true;/.test(fs.readFileSync(path.join(STATIC, 'almanac-orrery.js'), 'utf8')) &&
      /function _orrerySnapToNow\(\) \{[^}]*_orreryClockChosen = false;/.test(fs.readFileSync(path.join(STATIC, 'almanac-orrery.js'), 'utf8')),
      'the slider chooses a moment; Now lets it go');
    // One orrery loop: a second start took over nothing and ran beside the
    // first, and the Earth view's pause stopped only one of them.
    check(/if \(_almanacOrreryRAF\) cancelAnimationFrame\(_almanacOrreryRAF\);\s*_almanacOrreryRAF = requestAnimationFrame\(_orreryAnimate\);/.test(fs.readFileSync(path.join(STATIC, 'almanac-orrery.js'), 'utf8')),
      'the orrery asks for one frame at a time, whoever starts it');
    // A partial solar eclipse is drawn, as an eclipse map draws it: the
    // shadow's edge and a line at every quarter of the Sun covered.
    const frag = run('AE_EARTH_FRAG');
    check(/float cover = 1\.0 - light;/.test(frag) && /fract\(cover \* 4\.0/.test(frag) && /step\(0\.004, cover\)/.test(frag),
      'the Earth draws the lines of a partial eclipse where the Moon covers some of the Sun');
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

  // ── 4. Memory ─────────────────────────────────────────────────────────
  {
    const r1 = run('_ae.gl.renderer');
    check(r1.opts.antialias === false, 'at a 3x screen (drawn at 2x) there is no multisampling');
    run('_aeClose()');
    check(JSON.stringify(r1.lastSize()) === '[1,1,false]', 'closing the view shrinks its drawing buffer to one pixel');
    fetches.push(answer({}));
    run('openAlmanacEarth()');
    await flush();
    check(JSON.stringify(r1.lastSize()) === '[390,844,false]', 'opening it again sizes it to the view');

    // Everything the scene holds on the GPU, to be counted back.
    const held = new Set();
    run('_ae.gl.scene').traverse((o) => {
      if (o.geometry) held.add(o.geometry);
      if (o.material) held.add(o.material);
    });
    let disposed = 0;
    held.forEach((x) => x.addEventListener('dispose', () => { disposed++; }));
    const maps = textures.filter((x) => !x.disposed);
    const oldCanvas = document.getElementById('ae-canvas');
    S._almanacOpen = true;
    run('_almanacTeardown()');   // closing the Almanac, as its close button does
    check(run('_aeIsOpen') === false, 'closing the Almanac closes the view');
    check(run('_ae.gl') === null, 'and lets the scene go');
    check(held.size > 10 && disposed === held.size, 'every geometry and material is disposed (' + disposed + ' of ' + held.size + ')');
    check(maps.length === 3 && maps.every((x) => x.disposed), 'every map is disposed');
    check(textures.some((x) => x.url === S.AE_TEX_MOON_HI) && textures.filter((x) => x.url === S.AE_TEX_MOON).every((x) => x.disposed),
      'the Moon\'s 4096 map replaced its 1024 one, which was given back then');
    check(r1.did('dispose') && r1.did('forceContextLoss'), 'the renderer is disposed and its context given back');
    const fresh = document.getElementById('ae-canvas');
    check(fresh !== oldCanvas && oldCanvas.parentNode === null, 'a fresh canvas replaces the one whose context is lost');
    check(!!(fresh.listeners.pointerdown && fresh.listeners.wheel), 'and takes the pointer and the wheel');

    S._almanacOpen = true;
    S.window.devicePixelRatio = 1;
    const built = renderers.length;
    fetches.push(answer({}));
    run('openAlmanacEarth()');
    await flush();
    const r2 = run('_ae.gl && _ae.gl.renderer');
    check(renderers.length === built + 1 && r2 && r2.opts.canvas === fresh, 'the next open builds the view again on the fresh canvas');
    check(r2 && r2.opts.antialias === true, 'at 1x it multisamples');
    check(mapAsks.filter((u) => u === S.AE_TEX_DAY).length >= 2, 'and loads its maps again');
    S.window.devicePixelRatio = 3;
  }

  // ── 5. Maps that fail ─────────────────────────────────────────────────
  {
    const openFresh = async () => {
      run('_aeRelease()');
      fetches.push(answer({}));
      run('openAlmanacEarth()');
      await flush();
    };
    const msg = () => document.getElementById('ae-msg');
    mapPlan[S.AE_TEX_MOON] = 'fail';
    await openFresh();
    check(run('_ae.gl.moonUni.moonMapped && _ae.gl.moonUni.moonMapped.value') === 0,
      'without its map the Moon is drawn plain grey, not black on black');
    check(note().includes('alm_earth_maps_failed'), 'and the note says a map did not load');
    delete mapPlan[S.AE_TEX_MOON];
    const moonAsks = mapAsks.filter((u) => u === S.AE_TEX_MOON).length;
    await reopen();
    check(mapAsks.filter((u) => u === S.AE_TEX_MOON).length === moonAsks + 1, 'the next open asks for it again');
    check(run('_ae.gl.moonUni.moonMapped ? _ae.gl.moonUni.moonMapped.value : null') === 1 && !note().includes('alm_earth_maps_failed'),
      'and with it the Moon has its face and the note clears');

    mapPlan[S.AE_TEX_DAY] = 'fail';
    document.getElementById('ae-lbl-iss').hidden = false;   // placed by the last frame drawn
    await openFresh();
    const r = renderers[renderers.length - 1];
    check(run('_ae.gl') === null && r.did('dispose') && r.did('forceContextLoss'),
      'without the day map the view gives its GPU back');
    check(msg().textContent === 'alm_earth_unavailable' && !msg().hidden, 'and says it is unavailable');
    check(document.getElementById('ae-lbl-iss').hidden === true, 'with no label left over from the last scene');
    delete mapPlan[S.AE_TEX_DAY];
    const built = renderers.length;
    await reopen();
    check(renderers.length === built + 1 && run('!!(_ae.gl && _ae.gl.earthUni.dayMap.value)'), 'the next open starts over and gets it');
    check(msg().hidden === true, 'and the message goes');
  }

  // ── 6. Satellite data from the internet ───────────────────────────────
  {
    const el = (id) => document.getElementById(id);
    const stale = (over) => answer(Object.assign({ mode: 'ask', locked: null, stale: true, can_change: true }, over));
    const lastReq = () => requests[requests.length - 1];
    // A frame first (none run here on their own): it places the satellites,
    // which is what says whether any is drawn.
    const askText = () => {
      run('_ae.gl && _aeUpdate(_aeDisplayMs()); _aeUpdateText(_aeDisplayMs())');
      return el('ae-ask').hidden ? null : text('ae-ask-text');
    };

    // Ask first, stale, and an admin: the data's date stands before the offer.
    fetches.push(stale({}));
    await reopen();
    check(lastReq().url === S.AE_SATS_URL && lastReq().method === 'GET', 'the view asks for its data with a GET');
    const offered = askText();
    check(offered !== null && offered.includes('alm_earth_data_from'), 'under Ask first, stale data is dated and offered fresh (' + offered + ')');
    check(!note().includes('alm_earth_data_from'), 'and the date is not said twice');
    check(text('ae-fresh') === 'alm_earth_get_fresh', 'the button says Get fresh data');

    // The button: one POST, and the view redraws from its answer.
    const before = requests.length;
    fetches.push(answer({ source: 'cache', fetched: '2026-09-28T18:00:00Z', mode: 'ask', stale: false, can_change: true }));
    el('ae-fresh').onclick();
    check(text('ae-fresh') === 'alm_earth_getting_fresh' && el('ae-fresh').disabled === true, 'pressed, it says it is getting fresh data, and waits');
    await flush();
    check(requests.length === before + 1 && lastReq().method === 'POST' && lastReq().url === S.AE_SATS_REFRESH_URL,
      'Get fresh data is one POST to the admin route');
    check(run('_ae.sats.source') === 'cache' && run('_ae.sats.fetched') === '2026-09-28T18:00:00Z', 'and the fresh elements are drawn');
    check(askText() === null && note().includes('alm_earth_data_from'), 'fresh, the offer goes and the note dates the data again');

    fetches.push(stale({}));
    await reopen();
    fetches.push('fail');
    el('ae-fresh').onclick();
    await flush();
    check((askText() || '').includes('alm_earth_fresh_failed') && el('ae-fresh').disabled === false,
      'a fetch that failed says so, and can be tried again');
    fetches.push({ __status: 401 });
    el('ae-fresh').onclick();
    await flush();
    check(askText() === null, 'refused (no longer an admin), the offer goes');

    fetches.push(stale({ can_change: false }));
    await reopen();
    check(askText() === null && note().includes('alm_earth_data_from'), 'a viewer who may not fetch sees the date and no button');
    fetches.push(stale({ mode: 'never' }));
    await reopen();
    check(askText() === null && note().includes('alm_earth_data_from'), 'under Never, stale data is dated and nothing more');
    fetches.push(stale({ mode: 'auto', refreshing: true }));
    await reopen();
    check(askText() === null, 'under Automatically nothing is offered: the server is fetching already');

    // The gear.
    const gear = el('ae-gear'), panel = el('ae-set');
    fetches.push(stale({}));
    await reopen();
    check(panel.hidden === true, 'the setting is put away at open');
    gear.onclick();
    const html = panel.innerHTML;
    check(panel.hidden === false && gear.getAttribute('aria-expanded') === 'true', 'the gear opens "Satellite data from the internet"');
    check(/value="ask" checked/.test(html) && !/disabled/.test(html), 'an admin sees Ask first chosen, and may change it');
    check(['alm_earth_sat_ask', 'alm_earth_sat_auto', 'alm_earth_sat_never'].every((k) => html.includes(k)), 'with all three choices');
    const n0 = requests.length;
    fetches.push({ mode: 'auto', locked: null, choices: ['ask', 'auto', 'never'] });
    fetches.push(stale({ mode: 'auto', refreshing: true }));
    panel.onchange({ target: { name: 'ae-sat-mode', value: 'auto' } });
    await flush();
    const saved = requests[n0];
    check(saved && saved.method === 'POST' && saved.url === S.AE_SATS_SETTING_URL && JSON.parse(saved.body).mode === 'auto',
      'choosing Automatically saves it with one POST');
    check(requests.length === n0 + 2 && requests[n0 + 1].method === 'GET', 'then the view asks again');
    check(/value="auto" checked/.test(panel.innerHTML), 'and shows the new choice');

    const panelFor = async (over) => { fetches.push(stale(over)); await reopen(); gear.onclick(); return panel.innerHTML; };
    let h = await panelFor({ can_change: false });
    check(/value="ask" checked/.test(h) && (h.match(/ disabled/g) || []).length === 3 && h.includes('alm_earth_sat_admin_only'),
      'anyone else sees the choice read-only, and why');
    const n1 = requests.length;
    panel.onchange({ target: { name: 'ae-sat-mode', value: 'never' } });
    await flush();
    check(requests.length === n1, 'and a change from them sends nothing');
    h = await panelFor({ mode: 'never', locked: 'env' });
    check(/value="never" checked/.test(h) && /disabled/.test(h) && h.includes('env_controlled') && h.includes('ZIMI_SATELLITE_UPDATES'),
      'set by ZIMI_SATELLITE_UPDATES, it cannot be changed here and says so');
    h = await panelFor({ mode: 'never', locked: 'offline' });
    check(/value="never" checked/.test(h) && /disabled/.test(h) && h.includes('alm_earth_sat_offline'),
      'under ZIMI_OFFLINE it is Never, and says why');

    const escape = { key: 'Escape', preventDefault() {}, stopPropagation() {}, target: null };
    run('_ae.el').listeners.keydown[0](escape);
    check(panel.hidden === true && run('_aeIsOpen') === true, 'Escape puts the panel away and leaves the view open');
    gear.onclick();
    el('ae-canvas').listeners.pointerdown[0]({ pointerId: 1, clientX: 0, clientY: 0 });
    check(panel.hidden === true, 'so does a touch on the globe');
    run('_ae.el').listeners.keydown[0](escape);
    check(run('_aeIsOpen') === false, 'and the next Escape leaves the view');
  }

  if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
  console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
