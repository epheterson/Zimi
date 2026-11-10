// ── Almanac: what the land is ──
// One answer, for every window on the Earth, to "what grows here": the live sky card's foreground (almanac-skyland.js) and Stand here's
// trees and ground read the same one-degree grid (zimi/static/earth/landcover-v1.bin, built by scripts/build_landcover.py from the
// Blue Marble colour map and the Natural Earth land mask), so they cannot disagree. A small file with nothing of the 3D view in it:
// either lane loads it alone.
//
//   _osLandCoverLoad(cb)        fetch and read the grid, once; resolves (and calls cb(true | false)) when it is in or has failed
//   _osLandCover(lat, lon)      null until it is loaded; then { cls, coast, rgb }:
//                               cls   'sea' | 'broadleaf' | 'conifer' | 'grass' | 'desert' (shrub and desert) | 'snow' | 'tundra'
//                               coast true when the one-degree cell holds both land and sea (a beach is possible)
//                               rgb   the cell's mean colour on the Blue Marble, 0..1 (null for sea): a tint, not a picture

var OL_URL = '/static/earth/landcover-v1.bin';
var OL_MAGIC = 'ZCOV', OL_VERSION = 1, OL_HEADER_BYTES = 10;
var OL_CLASSES = ['sea', 'broadleaf', 'conifer', 'grass', 'desert', 'snow', 'tundra'];
var OL_CLASS_MASK = 7, OL_COAST_BIT = 8;
var OL_TINT_MAX = [7, 7, 3];   // red, green and blue in 3, 3 and 2 bits

var _olGrid = null, _olLoading = null;

// The grid from the file's bytes, or null if they are not this format.
function _olParse(buf) {
  if (!buf || buf.byteLength < OL_HEADER_BYTES) return null;
  var v = new DataView(buf), u8 = new Uint8Array(buf);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== OL_MAGIC || u8[4] !== OL_VERSION) return null;
  var w = v.getUint16(6, true), h = v.getUint16(8, true), n = w * h, cells = new Uint8Array(n), pos = OL_HEADER_BYTES, k = 0, land = 0;
  while (k < n) {
    if (pos + 2 > buf.byteLength) return null;
    var val = u8[pos], len = u8[pos + 1];
    pos += 2;
    if (!len || k + len > n) return null;
    if ((val & OL_CLASS_MASK) !== 0) land += len;
    cells.fill(val, k, k + len);
    k += len;
  }
  if (buf.byteLength - pos !== land) return null;
  var tint = new Uint8Array(n), j = pos;
  for (k = 0; k < n; k++) if ((cells[k] & OL_CLASS_MASK) !== 0) tint[k] = u8[j++];
  return { w: w, h: h, cells: cells, tint: tint };
}
function _olRgb(b) {   // each channel was stored as its square root
  var r = ((b >> 5) & 7) / OL_TINT_MAX[0], g = ((b >> 2) & 7) / OL_TINT_MAX[1], bl = (b & 3) / OL_TINT_MAX[2];
  return [r * r, g * g, bl * bl];
}
// The answer for a place from a grid (the pure half: no loading).
function _olAt(g, lat, lon) {
  if (!g || !isFinite(lat) || !isFinite(lon)) return null;
  var x = Math.min(g.w - 1, Math.max(0, Math.floor((((lon + 180) % 360) + 360) % 360 / 360 * g.w))), y = Math.min(g.h - 1, Math.max(0, Math.floor((90 - lat) / 180 * g.h)));
  var i = y * g.w + x, c = g.cells[i], k = c & OL_CLASS_MASK;
  return { cls: OL_CLASSES[k] || 'sea', coast: (c & OL_COAST_BIT) !== 0, rgb: k ? _olRgb(g.tint[i]) : null };
}
function _osLandCover(lat, lon) { return _olAt(_olGrid, lat, lon); }
function _osLandCoverLoad(cb) {
  if (_olGrid) { if (cb) cb(true); return Promise.resolve(true); }
  if (!_olLoading) {
    _olLoading = fetch(OL_URL).then(function (r) { if (!r.ok) throw new Error('landcover'); return r.arrayBuffer(); })
      .then(function (buf) { _olGrid = _olParse(buf); return !!_olGrid; }, function () { return false; })
      .then(function (ok) { if (!ok) _olLoading = null; return ok; });
  }
  return _olLoading.then(function (ok) { if (cb) cb(ok); return ok; });
}
