// StreetZim's address interface (jasontitus/streetzim#18): the viewer reads #map=zoom/lat/lng (and #pin=lat,lng&label=)
// on load and on hashchange and writes #map= back after each move. Zimi speaks that; __szMap stays as the fallback for
// maps built before it. A fake new-style frame honours the hash, a fake old-style one has only the handle.
//
// Run: node tests/test_streetzim_hash.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const pick = (re, label) => { const m = src.match(re); if (!m) throw new Error('could not extract ' + label); return m[0]; };
let failures = 0;
function ok(label, cond, detail) { console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : '')); if (!cond) failures++; }

// A frame window. `speaks`: reads its hash when it is replaced, and writes its own back (as replaceState would) after moving.
// `handle`: exposes the MapLibre-like handle.
function frame(speaks, handle) {
  const st = { lat: 0, lng: 0, zoom: 2 };
  const win = {
    location: {
      hash: '',
      href: 'http://x/w/osm/index.html',
      replace(u) {
        this.hash = '#' + u.split('#')[1];
        if (!speaks) return;
        const m = /map=([\d.]+)\/(-?[\d.]+)\/(-?[\d.]+)/.exec(this.hash);
        if (m) { st.zoom = +m[1]; st.lat = +m[2]; st.lng = +m[3]; }
        const p = /pin=(-?[\d.]+),(-?[\d.]+)&label=([^&]*)/.exec(this.hash);
        win.pin = p ? { lat: +p[1], lng: +p[2], label: decodeURIComponent(p[3]) } : null;
        this.hash = '#map=' + st.zoom + '/' + st.lat + '/' + st.lng;  // the map's own spelling
      },
    },
    st,
  };
  if (handle) win.__szMap = { getCenter: () => ({ lat: st.lat, lng: st.lng }), getZoom: () => st.zoom, jumpTo(o) { st.lng = o.center[0]; st.lat = o.center[1]; st.zoom = o.zoom; win.jumped = (win.jumped || 0) + 1; }, on() {}, once() {}, getBounds: null };
  return win;
}

function world(win) {
  const ctx = {
    Math, parseFloat, isFinite, String, encodeURIComponent, setTimeout: () => 0, clearTimeout() {},
    document: { getElementById: () => ({ contentWindow: win }) },
    readerOpen: true, currentArticle: { zim: 'osm', path: 'index.html' },
    _isMapPage: () => true, zimsCache: [{ name: 'osm', kind: 'map', map_source: 'StreetZim' }],
    _watchReaderMap() {}, _histFollowMap() {}, history: { state: null, replaceState() {} }, location: { pathname: '/', search: '', hash: '' },
  };
  vm.createContext(ctx);
  vm.runInContext([
    pick(/var _MAP_HANDLES = [^\n]*\n/, 'handles'),
    pick(/function _readerMap\(\) \{[\s\S]*?\n\}/, '_readerMap'),
    pick(/function _readerWin\(\) \{[\s\S]*?\n\}/, '_readerWin'),
    pick(/var _mapWroteHash = '';\nvar _mapHashWin = null;\n/, 'state'),
    pick(/function _frameHash\(win\) \{[\s\S]*?\n\}/, '_frameHash'),
    pick(/function _hashMapWin\(\) \{[\s\S]*?\n\}/, '_hashMapWin'),
    pick(/function _hashMapPos\(\) \{[\s\S]*?\n\}/, '_hashMapPos'),
    pick(/function _setMapHash\(win, pos, pin\) \{[\s\S]*?\n\}/, '_setMapHash'),
    pick(/function _mapPinHash\(lat, lng, label\) \{[\s\S]*?\n\}/, '_mapPinHash'),
    pick(/function mapPositionHash\(zoom, lat, lng\) \{[\s\S]*?\n\}/, 'mapPositionHash'),
    pick(/var _MAP_HASH_RE = [^\n]*\n/, 're'),
    pick(/function parseMapHash\(hash\) \{[\s\S]*?\n\}/, 'parseMapHash'),
    pick(/var _mapPinLabel = '';\n/, 'pinLabel'),
    pick(/function _putMapAt\(map, pos\) \{[\s\S]*?\n\}/, '_putMapAt'),
    pick(/function _currentMapPositionHash\(\) \{[\s\S]*?\n\}/, '_currentMapPositionHash'),
  ].join('\n'), ctx);
  return ctx;
}
const at = { lat: 21.3069, lng: -157.8583, zoom: 14 };

// New-style map, no handle at all: moved and read by hash alone.
{
  const w = frame(true, false), c = world(w);
  c._putMapAt(null, at);
  ok('a map with no handle is moved by its hash', w.st.lat === 21.3069 && w.st.zoom === 14 && /^#map=14\//.test(w.location.hash), w.location.hash);
  ok('and read back from the hash it wrote', c._currentMapPositionHash() === 'map=14.00/21.30690/-157.85830', c._currentMapPositionHash());
}
// New-style map that also has the handle: a pin travels in the hash, the handle is not what is read once it has spoken.
{
  const w = frame(true, true), c = world(w);
  c._mapPinLabel = 'Honolulu Zoo';
  c._putMapAt(w.__szMap, at);
  ok('a place result asks for a pin by name', w.pin && w.pin.label === 'Honolulu Zoo' && w.pin.lat === 21.3069, JSON.stringify(w.pin));
  c._mapPinLabel = '';
  c._putMapAt(w.__szMap, { lat: 1, lng: 2, zoom: 5 });
  ok('once the map has rewritten its hash it is known to speak it: no handle jump', c._hashMapPos() && c._hashMapPos().lat === 1, JSON.stringify(c._hashMapPos()));
  w.st.lat = 9; w.location.hash = '#map=7/9/2';  // the person pans: the map writes its own hash
  ok('position comes from the map\'s own hash', c._currentMapPositionHash() === 'map=7.00/9.00000/2.00000', c._currentMapPositionHash());
}
// Old-style map: only the handle. The hash is never relied on, even though Zimi wrote a #map= there.
{
  const w = frame(false, true), c = world(w);
  c._putMapAt(w.__szMap, at);
  ok("an old map is moved by its handle", w.st.lat === 21.3069 && w.jumped === 1, JSON.stringify([w.st, w.jumped, w.location.hash]));
  w.st.lat = 30; w.st.lng = -100;  // the person pans; the old map's hash goes stale
  ok('and read from its handle, not the hash Zimi left', c._hashMapPos() === null && c._currentMapPositionHash() === 'map=14.00/30.00000/-100.00000', c._currentMapPositionHash());
}
ok('Kiwix maps2zim still gets its own #lat=&lon=&zoom=', /url \+= '#lat=' \+ mp\.lat \+ '&lon=' \+ mp\.lng \+ '&zoom=' \+ Math\.round\(mp\.zoom\)/.test(src));
ok('place results carry the name to openArticle', /pos: 'map=' \+ \(p\.zoom \|\| 15\) \+ '\/' \+ p\.lat \+ '\/' \+ p\.lng, label: p\.name/.test(src) && /label: el\.getAttribute\('data-title'\)/.test(src));
ok('a StreetZim map opens with its address in the frame URL', /else if \(mp && mz && mz\.map_source === 'StreetZim'\)/.test(src));

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('all passed');
