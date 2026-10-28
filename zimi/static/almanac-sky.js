// ── Almanac: the live sky + star chart ──
// The observer's own sky on the page's one clock (now, or wherever the time
// machine stands): every pixel is the real sky at this place, now. The Sun,
// the Moon and the planets where they truly are, the 9,096 stars of the Bright
// Star Catalogue in their colours, the Milky Way, and the air's own light from
// the Sun's and the Moon's real positions (almanac-skygl.js draws that in
// WebGL2; the Canvas 2D paint below is the same sky without it). Then the
// planisphere, and the bright-star catalogue both share.
// Loaded before almanac.js; all almanac scripts share one global scope.
//
// ── Driving the view (ZimiSky, defined at the end of this file) ──
// The sky is a panorama facing the equator until something points it:
//   ZimiSky.setView({ az, alt, fov })   look along a bearing (degrees from true
//                                       north through east), a height above the
//                                       horizon (-90..90) and a horizontal field
//                                       of view across the canvas width (1..140).
//                                       With WebGL2 this is a stereographic lens;
//                                       without it the panorama turns to az and
//                                       takes fov as its span (alt is ignored).
//   ZimiSky.getView()                   { az, alt, fov, mode: 'lens' | 'pano' }
//   ZimiSky.resetView()                 back to the page's panorama
//   ZimiSky.pointAt(clientX, clientY)   { az, alt } under a screen point, or null
//   ZimiSky.screenOf(az, alt)           { x, y, visible } in CSS px on the canvas
//   ZimiSky.setAspect(a)                the canvas's width over height (null: the page's own)
//   ZimiSky.redMode() / setRedMode(on)  the night switch: deep red on black; other
//                                       views read it, and the 'zimisky:red' event
//                                       says when it changes.
//   ZimiSky.supportsLens()              true once the GPU sky can draw a lens
// Every call is cheap; the sky draws once for the change (no frame loop).
//
// ── The look-around host (AlmanacSkyView, defined below) ──
//   AlmanacSkyView.mount(host, place)               {lat, lon, name}: the sky edge to edge in a DOM element, through the lens over
//                                                   the whole sphere; false only for a missing host or place. The GPU's sky when it
//                                                   is ready, the Canvas 2D sky's until then (and where WebGL2 is not to be had).
//   AlmanacSkyView.setView(host, az, alt, fov)      degrees; one frame for all the turns before it
//   AlmanacSkyView.redraw(host)                     paint again as it is (almanac-skyfind.js's ring)
//   AlmanacSkyView.pointAt(host, clientX, clientY)  { az, alt } or null;  screenOf(host, az, alt): { x, y, visible } CSS px
//   AlmanacSkyView.resize(host, place?) / unmount(host) / credit()
// Events on document: 'zimisky:red' ({on}) when the shared night switch moves, 'zimisky:gl' ({ready}) when the GPU sky comes or goes.
// It runs no timer and no frame loop while the view is still; the time machine's instant is used when one is set.

// The frame loop runs only while something moves (the Moon gliding to a new
// instant, the hero's sweep, a plane on the beach scene); a still sky is
// painted once, and again only when the sky has turned a pixel's worth.
var _almanacSkyRAF = null;

// Everything the sky shows for the focused instant and place, the layers it
// was painted into, and what a tap can find. See _initSkyScene.
var _skyState = null;

// Moon glide — when the focus time jumps (scrub, wheel/key step, "Go", Back to
// Now), the moon eases to its new sky position instead of snapping there.
// Duration is fixed regardless of jump size, so scrubbing years ahead still
// takes MOON_TWEEN_MS -- a graceful sweep rather than a blur -- and small steps
// (one wheel notch, one arrow key) get the same easing so mixed inputs feel
// consistent.
var MOON_TWEEN_MS = 500;

function _moonEaseOut(p) { return 1 - Math.pow(1 - p, 3); }

// Shortest signed delta (degrees) from `from` to `to`, wrapping at 360 -- so
// azimuth/tilt tweening sweeps the short way around the 0/360 seam
// instead of the long way when a jump straddles it.
function _angleDelta(from, to) { return ((to - from) % 360 + 540) % 360 - 180; }

// Sample the moon's tweened state at time `ts` (a performance.now()/rAF
// timestamp). Position (altitude/azimuth) and the disc's screen tilt ease
// geometrically; phase is sampled from REAL astronomy at the interpolated
// instant via _moonAnimPhaseAt, so the lit fraction sweeps its true path
// across the jump rather than snapping. The re-shade this costs is bounded by
// _moonSpriteCanvas's cache (illumination rounded to 1%): at the sky moon's
// ~14 px radius a full sweep is a few dozen tiny sprites, generated once.
function _skyMoonAt(s, ts) {
  var anim = s.moonAnim;
  if (!anim) return s.moonData;
  var p = (ts - anim.start) / MOON_TWEEN_MS;
  if (p >= 1) { s.moonAnim = null; return s.moonData; }
  var e = _moonEaseOut(Math.max(0, p));
  var fp = anim.from.pos, tp = anim.to.pos;
  return {
    pos: {
      altitude: fp.altitude + (tp.altitude - fp.altitude) * e,
      azimuth: fp.azimuth + _angleDelta(fp.azimuth, tp.azimuth) * e
    },
    tilt: (anim.from.tilt || 0) + _angleDelta(anim.from.tilt || 0, anim.to.tilt || 0) * e,
    phase: _moonAnimPhaseAt(anim.fromTime, anim.toTime, e),
    view: _moonAnimViewAt(anim.fromTime, anim.toTime, e)
  };
}

// (Re)target the moon's glide toward `toMoonData` (the focus instant `toTime`),
// sampling the CURRENT interpolated position as the new start. A rapid sequence
// of scrub frames or key/wheel steps thus glides continuously toward whatever
// the latest target is, instead of snapping back and re-launching each time.
// The phase sweep restarts from the previous focus time so it, too, chains.
function _skyMoonRetarget(s, toMoonData, ts, fromTime, toTime) {
  s.moonAnim = _skyReduceMotion() ? null : { from: _skyMoonAt(s, ts), to: toMoonData, start: ts, fromTime: fromTime, toTime: toTime };
  s.moonData = toMoonData;
  s.nowTime = toTime;
}

var _STARS = [
  // Orion (0-6): Betelgeuse, Rigel, Bellatrix, Mintaka, Alnilam, Alnitak, Saiph
  [5.92,7.41,.42],[5.24,-8.20,.13],[5.42,6.35,1.64],[5.53,-.30,2.23],[5.60,-1.20,1.69],[5.68,-1.94,1.77],[5.80,-9.67,2.06],
  // Ursa Major (7-13): Dubhe, Merak, Phecda, Megrez, Alioth, Mizar, Alkaid
  [11.06,61.75,1.79],[11.03,56.38,2.37],[11.90,53.69,2.44],[12.26,57.03,3.31],[12.90,55.96,1.77],[13.40,54.93,2.27],[13.79,49.31,1.86],
  // Cassiopeia (14-18): Caph, Schedar, Gamma, Ruchbah, Segin
  [.15,59.15,2.27],[.68,56.54,2.23],[.95,60.72,2.47],[1.43,60.24,2.68],[1.91,63.67,3.38],
  // Scorpius (19-25): Antares, Pi, Dschubba, Graffias, Epsilon, Shaula, Sargas
  [16.49,-26.43,1.09],[15.98,-26.11,2.89],[16.01,-22.62,2.32],[16.09,-19.81,2.62],[16.84,-34.29,2.29],[17.56,-37.10,1.63],[17.62,-43.00,1.87],
  // Leo (26-29): Regulus, Algieba, Zosma, Denebola
  [10.14,11.97,1.35],[10.33,19.84,2.01],[11.24,20.52,2.56],[11.82,14.57,2.14],
  // Cygnus (30-34): Deneb, Sadr, Delta, Gienah, Albireo
  [20.69,45.28,1.25],[20.37,40.26,2.23],[19.75,45.13,2.87],[20.77,33.97,2.48],[19.51,27.96,3.08],
  // Crux (35-38): Acrux, Mimosa, Gacrux, Delta
  [12.44,-63.10,.77],[12.80,-59.69,1.25],[12.52,-57.11,1.63],[12.25,-58.75,2.80],
  // Gemini (39-40): Castor, Pollux
  [7.58,31.89,1.58],[7.76,28.03,1.14],
  // Canis Major (41-44): Sirius, Mirzam, Adhara, Wezen
  [6.75,-16.72,-1.46],[6.38,-17.96,1.98],[6.98,-28.97,1.50],[7.14,-26.39,1.84],
  // Taurus (45-46): Aldebaran, Elnath
  [4.60,16.51,.85],[5.44,28.61,1.65],
  // Field stars (47-58): Canopus, Arcturus, Rigil Kent, Vega, Capella, Procyon,
  // Altair, Spica, Fomalhaut, Polaris, Hamal, Epsilon Leo
  [6.40,-52.70,-.72],[14.26,19.18,-.05],[14.66,-60.84,-.04],[18.62,38.78,.03],
  [5.28,46.00,.08],[7.66,5.22,.34],[19.85,8.87,.77],[13.42,-11.16,.98],
  [22.96,-29.62,1.16],[2.53,89.26,1.98],[2.12,23.46,2.00],[9.76,23.77,2.98]
];

// Real background field — the naked-eye sky beyond the named catalog above.
// Bright-star catalogue (HYG v41), every star to magnitude 4.0, culled of the
// ~58 already in _STARS; each row is [RA hours, Dec degrees, magnitude, colour
// index]. Projected by the SAME horizon geometry as the named stars
// (_projectFieldStars) so the whole scene is astronomically real and drifts
// with time/location — this REPLACES the old procedural _ensureSkyBgStars
// filler, which had no real position and did not move with the sky. Colour
// index tints each star warm (high B–V) to blue-white (low B–V).
var _SKY_FIELD_STARS = [
  [1.63,-57.24,0.45,-0.16],[14.06,-60.37,0.61,-0.23],[9.22,-69.72,1.67,0.07],[22.14,-46.96,1.73,-0.07],
  [8.16,-47.34,1.75,-0.14],[3.41,49.86,1.79,0.48],[18.40,-34.38,1.79,-0.03],[8.38,-59.51,1.86,1.20],
  [5.99,44.95,1.90,0.08],[16.81,-69.03,1.91,1.45],[6.63,16.40,1.93,0.00],[8.75,-54.71,1.93,0.04],
  [20.43,-56.74,1.94,-0.12],[9.46,-8.66,1.99,1.44],[0.73,-17.99,2.04,1.02],[18.92,-26.30,2.05,-0.13],
  [14.11,-36.37,2.06,1.01],[0.14,29.09,2.07,-0.04],[1.16,35.62,2.07,1.58],[14.85,74.16,2.07,1.47],
  [22.71,-46.88,2.07,1.61],[17.58,12.56,2.08,0.15],[3.14,40.96,2.09,-0.00],[2.06,42.33,2.10,1.37],
  [12.69,-48.96,2.20,-0.02],[8.06,-40.00,2.21,-0.27],[9.28,-59.28,2.21,0.19],[15.58,26.71,2.22,0.03],
  [9.13,-43.43,2.23,1.67],[17.94,51.49,2.24,1.52],[13.66,-53.47,2.29,-0.17],[14.70,-47.39,2.30,-0.15],
  [14.59,-42.16,2.33,-0.16],[14.75,27.07,2.35,0.97],[21.74,9.88,2.38,1.52],[17.71,-39.03,2.39,-0.17],
  [0.44,-42.31,2.40,1.08],[17.17,-15.72,2.43,0.06],[23.06,28.08,2.44,1.66],[7.40,-29.30,2.45,-0.08],
  [21.31,62.59,2.45,0.26],[9.37,-55.01,2.47,-0.14],[23.08,15.21,2.49,-0.00],[3.04,4.09,2.54,1.63],
  [16.62,-10.57,2.54,0.04],[13.93,-47.29,2.55,-0.18],[5.55,-17.82,2.58,0.21],[12.14,-50.72,2.58,-0.13],
  [12.26,-17.54,2.58,-0.11],[19.04,-29.88,2.60,0.06],[15.28,-9.38,2.61,-0.07],[15.74,6.43,2.63,1.17],
  [1.91,20.81,2.64,0.17],[5.66,-34.07,2.65,-0.12],[6.00,37.21,2.65,-0.08],[12.57,-23.40,2.65,0.89],
  [13.91,18.40,2.68,0.58],[14.98,-43.13,2.68,-0.18],[4.95,33.17,2.69,1.49],[10.78,-49.42,2.69,0.90],
  [12.62,-69.14,2.69,-0.18],[17.51,-37.30,2.70,-0.18],[7.29,-37.10,2.71,1.62],[18.35,-29.83,2.72,1.38],
  [19.77,10.61,2.72,1.51],[16.24,-3.69,2.73,1.58],[16.40,61.51,2.73,0.91],[10.72,-64.39,2.74,-0.22],
  [12.69,-1.45,2.74,0.37],[5.59,-5.91,2.75,-0.21],[13.34,-36.71,2.75,0.07],[14.85,-16.04,2.75,0.15],
  [17.72,4.57,2.76,1.17],[5.13,-5.09,2.78,0.16],[16.50,21.49,2.78,0.95],[17.24,14.39,2.78,1.16],
  [17.51,52.30,2.79,0.95],[15.59,-41.17,2.80,-0.22],[5.47,-20.76,2.81,0.81],[16.69,31.60,2.81,0.65],
  [0.43,-77.25,2.82,0.62],[16.60,-28.22,2.82,-0.21],[18.47,-25.42,2.82,1.02],[0.22,15.18,2.83,-0.19],
  [8.13,-24.30,2.83,0.46],[15.92,-63.43,2.83,0.32],[3.90,31.88,2.84,0.27],[17.42,-55.53,2.84,1.48],
  [17.53,-49.88,2.84,-0.14],[3.79,24.11,2.85,-0.09],[13.04,10.96,2.85,0.93],[21.78,-16.13,2.85,0.18],
  [1.98,-61.57,2.86,0.29],[6.38,22.51,2.87,1.62],[15.32,-68.68,2.87,0.01],[22.31,-60.26,2.87,1.39],
  [2.97,-40.30,2.88,0.13],[19.16,-21.02,2.88,0.38],[7.45,8.29,2.89,-0.10],[12.93,38.32,2.89,-0.12],
  [3.96,40.01,2.90,-0.20],[16.35,-25.59,2.90,0.30],[21.53,-5.57,2.90,0.83],[3.08,53.51,2.91,0.72],
  [9.79,-65.07,2.92,0.27],[22.72,30.22,2.93,0.85],[6.83,-50.61,2.94,1.21],[12.50,-16.52,2.94,-0.01],
  [22.10,-0.32,2.95,0.97],[3.97,-13.51,2.97,1.59],[5.63,21.14,2.97,-0.15],[18.10,-30.42,2.98,0.98],
  [13.32,-23.17,2.99,0.92],[17.79,-40.13,2.99,0.51],[19.09,13.86,2.99,0.01],[2.16,34.99,3.00,0.14],
  [11.16,44.50,3.00,1.14],[15.35,71.83,3.00,0.06],[16.86,-38.05,3.00,-0.20],[21.90,-37.36,3.00,-0.08],
  [3.72,47.79,3.01,-0.12],[6.34,-30.06,3.02,-0.16],[7.05,-23.83,3.02,-0.08],[12.17,-22.62,3.02,1.33],
  [5.03,43.82,3.03,0.54],[12.77,-68.11,3.04,-0.18],[14.53,38.31,3.04,0.19],[20.35,-14.78,3.05,0.79],
  [6.73,25.13,3.06,1.38],[10.37,41.50,3.06,1.60],[19.21,67.66,3.07,0.99],[18.29,-36.76,3.10,1.58],
  [8.92,5.95,3.11,0.98],[10.83,-16.19,3.11,1.23],[11.60,-63.02,3.11,-0.04],[20.63,-47.29,3.11,1.00],
  [5.85,-35.77,3.12,1.15],[8.99,48.04,3.12,0.22],[16.98,-55.99,3.12,1.55],[17.25,24.84,3.12,0.08],
  [14.99,-42.10,3.13,-0.21],[9.35,34.39,3.14,1.55],[9.52,-57.03,3.16,1.54],[17.25,36.81,3.16,1.44],
  [6.63,-43.20,3.17,-0.10],[9.55,51.68,3.17,0.47],[17.15,65.71,3.17,-0.12],[18.76,-26.99,3.17,-0.11],
  [5.11,41.23,3.18,-0.15],[14.71,-64.98,3.18,0.26],[4.83,6.96,3.19,0.48],[5.09,-22.37,3.19,1.46],
  [16.96,9.38,3.19,1.16],[17.83,-37.04,3.19,1.19],[21.22,30.23,3.21,0.99],[23.66,77.63,3.21,1.03],
  [15.36,-40.65,3.22,-0.23],[16.31,-4.69,3.23,0.97],[18.36,-2.90,3.23,0.94],[21.48,70.56,3.23,-0.20],
  [6.80,-61.94,3.24,0.23],[20.19,-0.82,3.24,-0.07],[7.49,-43.30,3.25,1.51],[14.11,-26.68,3.25,1.09],
  [15.07,-25.28,3.25,1.67],[18.98,32.69,3.25,-0.05],[3.79,-74.24,3.26,1.59],[0.66,30.86,3.27,1.27],
  [17.37,-25.00,3.27,-0.19],[22.91,-15.82,3.27,0.07],[5.22,-16.21,3.29,-0.11],[10.23,-70.04,3.29,-0.07],
  [15.42,58.97,3.29,1.17],[4.57,-55.04,3.30,-0.08],[10.53,-61.69,3.30,-0.09],[6.25,22.51,3.31,1.60],
  [17.42,-56.38,3.31,-0.15],[1.10,-46.72,3.32,0.89],[3.09,38.84,3.32,1.53],[17.20,-43.24,3.32,0.44],
  [17.98,-9.77,3.32,0.99],[19.12,-27.67,3.32,1.17],[4.24,-62.47,3.33,0.92],[11.24,15.43,3.33,-0.00],
  [7.82,-24.86,3.34,1.22],[5.41,-2.40,3.35,-0.24],[6.75,12.90,3.35,0.44],[8.50,60.72,3.35,0.86],
  [19.42,3.11,3.36,0.32],[15.38,-44.69,3.37,-0.19],[8.78,6.42,3.38,0.69],[13.58,-0.60,3.38,0.11],
  [5.59,9.93,3.39,-0.16],[10.28,-61.33,3.39,1.54],[12.93,3.40,3.39,1.57],[22.18,58.20,3.39,1.56],
  [4.48,15.87,3.40,0.18],[17.17,-15.73,3.40,0.60],[1.47,-43.32,3.41,1.54],[4.01,12.49,3.41,-0.10],
  [13.83,-41.69,3.41,-0.23],[15.20,-52.10,3.41,0.92],[20.75,61.84,3.41,0.91],[22.69,10.83,3.41,-0.09],
  [1.88,29.58,3.42,0.49],[16.00,-38.40,3.42,-0.21],[17.77,27.72,3.42,0.75],[20.75,-66.20,3.42,0.16],
  [9.18,-58.97,3.43,-0.19],[10.28,23.42,3.43,0.31],[19.10,-4.88,3.43,-0.10],[10.28,42.91,3.45,0.03],
  [0.82,57.82,3.46,0.59],[1.14,-10.18,3.46,1.16],[7.95,-52.98,3.46,-0.18],[15.26,33.31,3.46,0.96],
  [2.72,3.24,3.47,0.09],[13.83,-42.47,3.47,-0.17],[10.12,16.76,3.48,-0.03],[16.71,38.92,3.48,0.92],
  [1.73,-15.94,3.49,0.73],[7.03,-27.93,3.49,1.73],[11.31,33.09,3.49,1.40],[15.03,40.39,3.49,0.96],
  [18.45,-45.97,3.49,-0.18],[22.81,-51.32,3.49,0.08],[6.83,-32.51,3.50,-0.12],[7.34,21.98,3.50,0.37],
  [22.83,66.20,3.50,1.05],[19.98,19.49,3.51,1.57],[22.83,24.60,3.51,0.93],[3.72,-9.76,3.52,0.92],
  [9.69,9.89,3.52,0.52],[9.95,-54.57,3.52,-0.07],[18.83,33.36,3.52,0.00],[18.96,-21.11,3.52,1.15],
  [22.17,6.20,3.52,0.09],[12.69,-1.45,3.52,0.60],[4.48,19.18,3.53,1.01],[8.28,9.19,3.53,1.48],
  [11.55,-31.86,3.54,0.95],[15.83,-3.43,3.54,-0.04],[17.63,-15.40,3.54,0.26],[4.30,-33.80,3.55,-0.11],
  [5.78,-14.82,3.55,0.10],[14.32,-46.06,3.55,-0.18],[18.35,72.73,3.55,0.49],[20.15,-66.18,3.55,0.75],
  [0.32,-8.82,3.56,1.21],[2.28,-51.51,3.56,-0.12],[11.32,-14.78,3.56,1.11],[16.87,-38.02,3.56,-0.21],
  [7.74,24.40,3.57,0.93],[9.06,47.16,3.57,0.01],[14.53,30.37,3.57,1.30],[15.36,-36.26,3.57,1.53],
  [7.30,16.54,3.58,0.11],[20.30,-12.54,3.58,0.88],[1.63,48.63,3.59,1.27],[5.29,-6.84,3.59,-0.12],
  [5.74,-22.45,3.59,0.48],[11.84,1.76,3.59,0.52],[12.36,-60.40,3.59,1.39],[1.40,-8.18,3.60,1.06],
  [6.88,33.96,3.60,0.10],[8.67,-52.92,3.60,-0.17],[9.51,-40.47,3.60,0.37],[15.62,-28.14,3.60,1.36],
  [17.52,-60.68,3.60,-0.10],[2.83,27.26,3.61,-0.10],[3.41,9.03,3.61,0.89],[10.18,-12.35,3.61,1.01],
  [13.04,-71.55,3.61,1.19],[17.76,-64.72,3.61,1.16],[1.52,15.35,3.62,0.97],[3.82,24.05,3.62,-0.07],
  [7.75,-37.97,3.62,1.71],[16.91,-42.36,3.62,1.39],[23.03,42.33,3.62,-0.10],[11.76,-66.73,3.63,0.16],
  [20.63,14.60,3.64,0.42],[4.33,15.63,3.65,0.98],[9.53,63.06,3.65,0.36],[15.77,15.42,3.65,0.07],
  [18.11,-50.09,3.65,-0.10],[22.48,-0.02,3.65,0.41],[15.46,29.11,3.66,0.32],[15.64,-29.78,3.66,-0.18],
  [14.07,64.38,3.67,-0.05],[20.91,-58.45,3.67,1.25],[4.85,5.61,3.68,-0.16],[8.73,-33.19,3.68,-0.18],
  [19.79,18.53,3.68,1.31],[23.16,-21.17,3.68,1.20],[0.62,53.90,3.69,-0.20],[1.93,-51.61,3.69,0.84],
  [5.04,41.08,3.69,1.15],[9.75,-62.51,3.69,1.01],[11.77,47.78,3.69,1.18],[21.67,-16.66,3.69,0.32],
  [3.33,-21.76,3.70,1.61],[17.96,29.25,3.70,0.94],[23.29,3.28,3.70,0.92],[4.90,2.44,3.71,-0.18],
  [5.94,-14.17,3.71,0.34],[7.87,-40.58,3.71,1.01],[15.85,4.48,3.71,0.15],[18.12,9.56,3.71,0.16],
  [19.92,6.41,3.71,0.85],[3.55,-9.46,3.72,0.88],[3.75,24.11,3.72,-0.10],[5.99,54.28,3.72,1.01],
  [21.08,43.93,3.72,1.61],[3.45,9.73,3.73,-0.08],[14.77,1.89,3.73,-0.01],[17.89,56.87,3.73,1.18],
  [21.69,-77.39,3.73,1.01],[22.88,-7.58,3.73,1.63],[1.86,-10.34,3.74,1.14],[16.37,19.15,3.74,0.30],
  [21.25,38.05,3.74,0.39],[9.07,-47.10,3.75,1.17],[17.80,2.71,3.75,0.04],[5.56,-62.49,3.76,0.64],
  [5.86,-20.88,3.76,0.98],[6.48,-7.03,3.76,-0.11],[19.08,-21.74,3.76,1.01],[19.50,51.73,3.76,0.15],
  [22.52,50.28,3.76,0.03],[2.84,55.90,3.77,1.69],[3.75,42.58,3.77,0.42],[4.38,17.54,3.77,0.98],
  [5.65,-2.60,3.77,-0.19],[8.43,-66.14,3.77,1.13],[8.68,-46.65,3.77,0.67],[16.83,-59.04,3.77,1.56],
  [20.66,15.91,3.77,-0.06],[21.44,-22.41,3.77,1.00],[22.12,25.35,3.77,0.43],[7.15,-70.50,3.78,1.01],
  [7.43,27.80,3.78,1.02],[9.85,59.04,3.78,0.29],[10.89,-58.85,3.78,0.94],[14.69,13.73,3.78,0.04],
  [20.79,-9.50,3.78,0.00],[3.16,44.86,3.79,0.98],[10.89,34.21,3.79,1.04],[3.20,-28.99,3.80,0.54],
  [7.65,-26.80,3.80,-0.16],[15.58,10.54,3.80,0.27],[19.29,53.37,3.80,0.95],[20.23,46.74,3.80,1.27],
  [4.59,-30.56,3.81,0.96],[10.46,-58.74,3.81,0.32],[15.71,26.30,3.81,0.02],[23.63,46.46,3.81,0.98],
  [2.03,2.76,3.82,0.02],[9.31,36.80,3.82,0.07],[11.52,69.33,3.82,1.61],[16.52,1.98,3.82,0.02],
  [17.66,46.01,3.82,-0.18],[10.43,-16.84,3.83,1.46],[13.97,-42.10,3.83,-0.22],[14.80,-79.04,3.83,1.43],
  [3.74,-64.81,3.84,1.13],[3.74,32.29,3.84,0.02],[4.48,15.96,3.84,0.95],[8.92,-60.64,3.84,-0.10],
  [10.55,9.31,3.84,-0.15],[10.62,-48.23,3.84,0.30],[12.54,-72.13,3.84,-0.16],[18.13,28.76,3.84,-0.02],
  [18.23,-21.06,3.84,0.20],[19.80,70.27,3.84,0.89],[4.23,-42.29,3.85,1.08],[5.79,-51.07,3.85,0.17],
  [6.37,-33.44,3.85,0.86],[10.25,-42.12,3.85,0.05],[12.56,69.79,3.85,-0.12],[12.63,-48.54,3.85,0.05],
  [15.94,15.66,3.85,0.48],[18.39,21.77,3.85,1.17],[18.59,-8.24,3.85,1.32],[0.95,38.50,3.86,0.13],
  [4.64,-14.30,3.86,1.08],[5.52,-35.47,3.86,1.13],[16.26,-63.69,3.86,1.10],[16.56,-78.90,3.86,0.92],
  [17.94,37.25,3.86,1.35],[22.36,-1.39,3.86,-0.06],[3.76,24.37,3.87,-0.06],[8.77,-46.04,3.87,0.01],
  [13.98,-44.80,3.87,-0.21],[14.72,-5.66,3.87,0.39],[15.95,-29.21,3.87,-0.20],[19.87,1.01,3.87,0.63],
  [0.16,-45.75,3.88,1.01],[1.89,19.29,3.88,-0.05],[9.88,26.01,3.88,1.22],[15.20,-48.74,3.88,-0.03],
  [23.17,-45.25,3.88,1.00],[2.94,-8.90,3.89,1.09],[6.90,-24.18,3.89,1.74],[9.24,2.31,3.89,-0.06],
  [12.33,-0.67,3.89,0.03],[19.94,35.08,3.89,1.02],[9.66,-1.14,3.90,1.31],[11.35,-54.49,3.90,-0.16],
  [13.52,-39.41,3.90,1.19],[4.05,5.99,3.91,0.03],[8.43,-3.91,3.91,-0.01],[12.47,-50.23,3.91,-0.19],
  [15.09,-47.05,3.91,-0.14],[15.59,-14.79,3.91,1.01],[16.33,46.31,3.91,-0.15],[17.00,30.93,3.92,-0.02],
  [19.36,-17.85,3.92,0.23],[21.26,5.25,3.92,0.55],[0.44,-43.68,3.93,0.17],[1.52,-49.07,3.93,0.97],
  [2.90,52.76,3.93,0.76],[4.61,-3.35,3.93,-0.21],[7.70,-72.61,3.93,1.03],[11.14,-58.98,3.93,1.23],
  [16.11,-20.67,3.93,-0.05],[18.01,2.93,3.93,0.03],[1.14,-55.25,3.94,-0.12],[7.69,-9.55,3.94,1.02],
  [7.73,-28.95,3.94,0.16],[8.74,18.15,3.94,1.08],[20.95,41.17,3.94,0.03],[2.06,72.42,3.95,-0.00],
  [6.61,-19.26,3.95,1.04],[4.14,47.71,3.96,-0.03],[5.99,-42.82,3.96,1.15],[9.01,41.78,3.96,0.46],
  [9.19,-62.32,3.96,-0.18],[19.38,-44.46,3.96,-0.09],[19.40,-40.62,3.96,-0.10],[20.26,47.71,3.96,1.45],
  [23.38,-20.10,3.96,1.08],[4.40,-34.02,3.97,1.47],[5.86,39.15,3.97,1.13],[7.28,-67.96,3.97,0.76],
  [8.67,-35.31,3.97,0.94],[12.19,-52.37,3.97,-0.16],[15.85,-33.63,3.97,-0.04],[20.01,-72.91,3.97,-0.03],
  [22.49,-43.50,3.97,1.02],[22.78,23.57,3.97,1.07],[3.98,35.79,3.98,0.02],[21.57,45.59,3.98,0.89],
  [2.00,-21.08,3.99,1.55],[6.25,-6.27,3.99,1.32],[10.41,-74.03,3.99,0.37],[23.29,-58.24,3.99,0.41],
  [9.04,-66.40,4.00,0.14],[11.40,10.53,4.00,0.42],[16.20,-19.46,4.00,0.08],
];

// Constellation connecting lines — pairs of _STARS indices
var _CONST_LINES = [
  [0,2],[0,5],[2,3],[3,4],[4,5],[3,1],[5,6],           // Orion
  [7,8],[8,9],[9,10],[10,7],[10,11],[11,12],[12,13],    // Big Dipper
  [14,15],[15,16],[16,17],[17,18],                      // Cassiopeia
  [22,21],[21,20],[21,19],[19,23],[23,24],[24,25],      // Scorpius
  [26,27],[27,28],[28,29],[27,58],                      // Leo
  [30,31],[31,34],[32,31],[31,33],                      // Cygnus
  [35,37],[36,38],                                      // Crux
  [39,40],                                              // Gemini
  [41,42],[41,43],[43,44],                              // Canis Major
  [45,46]                                               // Taurus
];

// Red/orange giants and supergiants — warm color rendering
var _WARM_STARS = {0:1, 19:1, 40:1, 45:1, 48:1};

// Proper names for the brightest catalog stars, keyed by _STARS index. Used to
// label the star chart. Proper star names are effectively international, so
// they are not localized.
var _STAR_NAMES = {
  0: 'Betelgeuse', 1: 'Rigel', 7: 'Dubhe', 19: 'Antares', 24: 'Shaula',
  26: 'Regulus', 30: 'Deneb', 35: 'Acrux', 40: 'Pollux', 41: 'Sirius',
  45: 'Aldebaran', 47: 'Canopus', 48: 'Arcturus', 49: 'Rigil Kent.',
  50: 'Vega', 51: 'Capella', 52: 'Procyon', 53: 'Altair', 54: 'Spica',
  55: 'Fomalhaut', 56: 'Polaris'
};

// A few catalog labels don't normalize onto their AlmanacLinks key (which uses
// the full proper name); map those explicitly. Everything else is the label
// lowercased with non-alphanumerics collapsed to underscores.
var _STAR_LINK_OVERRIDES = { 'Rigil Kent.': 'star:rigil_kentaurus' };

// AlmanacLinks key for a catalog star index, or null if it has no proper name.
function _starLinkKey(idx) {
  var nm = _STAR_NAMES[idx];
  if (!nm) return null;
  if (_STAR_LINK_OVERRIDES[nm]) return _STAR_LINK_OVERRIDES[nm];
  return _almStarKey(nm);
}

// "r,g,b" tint for a star from its B–V colour index: hot blue-white stars have
// a low (even negative) index, cool amber stars a high one. Buckets, not a
// gradient — plenty at this scale, and cheap. Shared by the field draw.
function _starTint(ci) {
  if (ci == null) return '220,230,255';
  if (ci < 0.0)  return '202,222,255';  // blue-white (O/B)
  if (ci < 0.3)  return '226,236,255';  // white (A)
  if (ci < 0.6)  return '248,248,235';  // yellow-white (F)
  if (ci < 1.0)  return '255,240,208';  // yellow (G/K)
  return '255,214,170';                 // orange-red (K/M)
}

// ══ The sky's ephemeris ══════════════════════════════════════════════════
// Every position is of date. The catalogue's J2000 stars and the planets'
// J2000 orbits are carried to the instant by precession (Meeus 21.2-21.3),
// so the sky drifts the right way across a scrubbed millennium. Held to JPL
// Horizons within a degree in tests/test_almanac_live_sky.cjs.

var SKY_OBLIQUITY_J2000_DEG = 23.4392911;
var SKY_LIGHT_DAYS_PER_AU = 0.0057755183;   // light time, days per AU (Meeus 33.3)
var SKY_REFRACTION_FROM_DEG = -1;           // below this no refraction is added

// Local sidereal time (radians) for an instant and longitude: the one value
// every body in the scene shares.
function _skyLST(now, lon) {
  var JD = _dateToJD(now.getTime());
  var GMST = (280.46061837 + 360.98564736629 * (JD - JD_J2000)) % 360;
  return (GMST + lon) * DEG_TO_RAD;
}

// The rotation that carries J2000 equatorial vectors to the mean equator and
// equinox of date, T Julian centuries from J2000 (Meeus 21.2, 21.3).
function _skyPrecession(T) {
  var as = DEG_TO_RAD / 3600, T2 = T * T, T3 = T2 * T;
  var zeta = (2306.2181 * T + 0.30188 * T2 + 0.017998 * T3) * as;
  var z = (2306.2181 * T + 1.09468 * T2 + 0.018203 * T3) * as;
  var th = (2004.3109 * T - 0.42665 * T2 - 0.041833 * T3) * as;
  var cA = Math.cos(zeta), sA = Math.sin(zeta), cZ = Math.cos(z), sZ = Math.sin(z), cT = Math.cos(th), sT = Math.sin(th);
  return [
    [cA * cT * cZ - sA * sZ, -sA * cT * cZ - cA * sZ, -sT * cZ],
    [cA * cT * sZ + sA * cZ, -sA * cT * sZ + cA * cZ, -sT * sZ],
    [cA * sT, -sA * sT, cT]
  ];
}
function _skyVec(ra, dec) { var c = Math.cos(dec); return [c * Math.cos(ra), c * Math.sin(ra), Math.sin(dec)]; }
function _skyMul(P, v) {
  return [P[0][0] * v[0] + P[0][1] * v[1] + P[0][2] * v[2],
          P[1][0] * v[0] + P[1][1] * v[1] + P[1][2] * v[2],
          P[2][0] * v[0] + P[2][1] * v[1] + P[2][2] * v[2]];
}
function _skyRaDec(v) { return { ra: Math.atan2(v[1], v[0]), dec: Math.atan2(v[2], Math.sqrt(v[0] * v[0] + v[1] * v[1])) }; }

// The Sun's apparent RA/Dec of date (radians), Meeus ch. 25 at low accuracy:
// a hundredth of a degree, far finer than a pixel of this sky.
function _skySunRaDec(T) {
  var L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  var M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * DEG_TO_RAD;
  var C = (1.914602 - 0.004817 * T) * Math.sin(M) + (0.019993 - 0.000101 * T) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  var om = (125.04 - 1934.136 * T) * DEG_TO_RAD;
  var lam = (L0 + C - 0.00569 - 0.00478 * Math.sin(om)) * DEG_TO_RAD;
  var eps = (23.439291 - 0.0130042 * T + 0.00256 * Math.cos(om)) * DEG_TO_RAD;
  return { ra: Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)), dec: Math.asin(Math.sin(eps) * Math.sin(lam)) };
}

// A planet as seen from the Earth: RA/Dec of date (radians) and magnitude,
// from the orrery's own orbits (_planetHelio3D) where the light that arrives
// now left it. P is the instant's precession.
function _skyPlanet(name, T, P) {
  var e = _planetHelio3D('Earth', T);
  var p = _planetHelio3D(name, T);
  var d = Math.sqrt((p.x - e.x) * (p.x - e.x) + (p.y - e.y) * (p.y - e.y) + (p.z - e.z) * (p.z - e.z));
  p = _planetHelio3D(name, T - d * SKY_LIGHT_DAYS_PER_AU / JULIAN_CENTURY);
  var gx = p.x - e.x, gy = p.y - e.y, gz = p.z - e.z;
  var eps = SKY_OBLIQUITY_J2000_DEG * DEG_TO_RAD, ce = Math.cos(eps), se = Math.sin(eps);
  var rd = _skyRaDec(_skyMul(P, [gx, gy * ce - gz * se, gy * se + gz * ce]));
  var r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z), R = Math.sqrt(e.x * e.x + e.y * e.y + e.z * e.z), D = Math.sqrt(gx * gx + gy * gy + gz * gz);
  // The lit fraction of the disc (the phase angle's cosine from the triangle Sun-planet-Earth) and the disc's semidiameter.
  var phase = (1 + _skyClamp((r * r + D * D - R * R) / (2 * r * D), -1, 1)) / 2;
  return { ra: rd.ra, dec: rd.dec, mag: _planetMagnitude(name, r, D, R), phase: phase, semi: Math.asin(SKY_PLANET_RADIUS_KM[name] / (D * SKY_KM_PER_AU)) / DEG_TO_RAD };
}
var SKY_KM_PER_AU = 149597870.7;
var SKY_PLANET_RADIUS_KM = { Mercury: 2440, Venus: 6052, Mars: 3396, Jupiter: 71492, Saturn: 60268, Uranus: 25559, Neptune: 24764 };

// Altitude and azimuth in degrees (azimuth from north through east) of RA/Dec
// at local sidereal time lst, all radians.
function _skyHorizontal(ra, dec, lst, sinLat, cosLat) {
  var H = lst - ra, sd = Math.sin(dec), cd = Math.cos(dec), cH = Math.cos(H);
  var alt = Math.asin(Math.max(-1, Math.min(1, sinLat * sd + cosLat * cd * cH)));
  var az = Math.atan2(-cd * Math.sin(H), sd * cosLat - cd * cH * sinLat);
  return { alt: alt / DEG_TO_RAD, az: (az / DEG_TO_RAD + 360) % 360 };
}

// The lift the air gives a body near the horizon: its apparent altitude from
// its true one, degrees (Saemundsson 1986, Meeus 16.4; Bennett's formula is
// the inverse, from the apparent).
function _skyRefract(alt) {
  return alt > SKY_REFRACTION_FROM_DEG ? alt + 1.02 / Math.tan((alt + 10.3 / (alt + 5.11)) * DEG_TO_RAD) / 60 : alt;
}

// The catalogue as unit vectors, built once: the named stars, then the field.
var _skyStarsJ2000 = null;
function _skyCatalogue() {
  if (_skyStarsJ2000) return _skyStarsJ2000;
  var out = [], i, s;
  for (i = 0; i < _STARS.length; i++) {
    s = _STARS[i];
    out.push({ v: _skyVec(s[0] * 15 * DEG_TO_RAD, s[1] * DEG_TO_RAD), mag: s[2], tint: _WARM_STARS[i] ? '255,210,160' : '220,230,255', idx: i, phase: i * 2.1 });
  }
  for (i = 0; i < _SKY_FIELD_STARS.length; i++) {
    s = _SKY_FIELD_STARS[i];
    out.push({ v: _skyVec(s[0] * 15 * DEG_TO_RAD, s[1] * DEG_TO_RAD), mag: s[2], tint: _starTint(s[3]), idx: -1, phase: (s[0] * 137.508) % 6.2832 });
  }
  _skyStarsJ2000 = out;
  return out;
}

// The Milky Way: the galactic equator (b = 0) every 5 degrees of longitude as
// J2000 vectors, each with a weight that is brightest toward the centre in
// Sagittarius. The north galactic pole and the equator's node: IAU 1958 as
// restated for J2000 (RA 192.85948, Dec 27.12825, l of the celestial pole 122.93192).
var SKY_NGP_RA_DEG = 192.85948, SKY_NGP_DEC_DEG = 27.12825, SKY_NCP_L_DEG = 122.93192;
var SKY_GALAXY_STEP_DEG = 5;
var _skyGalaxyJ2000 = null;
function _skyGalaxy() {
  if (_skyGalaxyJ2000) return _skyGalaxyJ2000;
  var out = [], dG = SKY_NGP_DEC_DEG * DEG_TO_RAD;
  for (var l = 0; l < 360; l += SKY_GALAXY_STEP_DEG) {
    var x = (SKY_NCP_L_DEG - l) * DEG_TO_RAD;
    var dec = Math.asin(Math.cos(dG) * Math.cos(x));
    var ra = SKY_NGP_RA_DEG * DEG_TO_RAD + Math.atan2(Math.sin(x), -Math.sin(dG) * Math.cos(x));
    out.push({ v: _skyVec(ra, dec), w: 0.35 + 0.65 * (0.5 + 0.5 * Math.cos(l * DEG_TO_RAD)) });
  }
  _skyGalaxyJ2000 = out;
  return out;
}

// Everything the sky shows at one instant and place, positions only. The Sun
// carries its geometric altitude too: twilight is counted on that.
function _skyEphemeris(now, lat, lon) {
  var T = _jdToJulianCentury(_dateToJD(now.getTime()));
  var P = _skyPrecession(T), lst = _skyLST(now, lon);
  var sinLat = Math.sin(lat * DEG_TO_RAD), cosLat = Math.cos(lat * DEG_TO_RAD);
  function place(v) { var rd = _skyRaDec(_skyMul(P, v)); return _skyHorizontal(rd.ra, rd.dec, lst, sinLat, cosLat); }
  var sq = _skySunRaDec(T), sun = _skyHorizontal(sq.ra, sq.dec, lst, sinLat, cosLat);
  var planets = [];
  for (var i = 0; i < _VISIBLE_PLANETS.length; i++) {
    var nm = _VISIBLE_PLANETS[i], pq = _skyPlanet(nm, T, P);
    var ph = _skyHorizontal(pq.ra, pq.dec, lst, sinLat, cosLat);
    planets.push({ name: nm, alt: _skyRefract(ph.alt), az: ph.az, mag: pq.mag, phase: pq.phase, semi: pq.semi });
  }
  var cat = _skyCatalogue(), stars = [];
  for (var j = 0; j < cat.length; j++) {
    var h = place(cat[j].v);
    if (h.alt > 0) stars.push({ alt: h.alt, az: h.az, mag: cat[j].mag, tint: cat[j].tint, idx: cat[j].idx, phase: cat[j].phase });
  }
  var gal = _skyGalaxy(), galaxy = [];
  for (var k = 0; k < gal.length; k++) { var gh = place(gal[k].v); galaxy.push({ alt: gh.alt, az: gh.az, w: gal[k].w }); }
  return {
    sun: { alt: _skyRefract(sun.alt), az: sun.az }, sunGeoAlt: sun.alt,
    moon: _moonPosition(now, lat, lon), planets: planets, stars: stars, galaxy: galaxy, P: P, lst: lst
  };
}

// The scene's values for an instant: the ephemeris and the Moon as every Moon
// on the page draws it (the canonical _moonView from app.js, the same view the
// hero disc and the Today card turn by, so the lit limb faces the true Sun).
function _skyFrame(now, lat, lon) {
  var eph = _skyEphemeris(now, lat, lon);
  var view = _moonView(now, lat, lon);
  return { eph: eph, moonData: { pos: eph.moon, tilt: view.tilt, phase: _moonPhase(now), view: view } };
}

// ══ How the sky looks ═════════════════════════════════════════════════════
// A panorama facing the equator (south from the northern hemisphere, north
// from the southern), 240 degrees of azimuth across, east on the left when
// facing south: the sky as it is, never mirrored for a right-to-left page.
var SKY_ASPECT = 1.8;
var SKY_ASPECT_PHONE = 1.3, SKY_PHONE_MAX_W = 520;   // a phone's window is taller: the sky needs height more than width
var SKY_SPAN_DEG = 240;
var SKY_HORIZON_Y = 0.8;          // the horizon, as a share of the height
var SKY_ZENITH_Y = 0.05;          // where 90 degrees of altitude would stand
var SKY_LIVE_MS = 30000;          // live, the sky is recomputed this often (it turns 0.125 deg)
var SKY_TAP_PX = 22;              // a fingertip's reach beyond a body's edge (CSS px)
var SKY_BODY_PX = [8, 14];        // Sun and Moon radius, CSS px, by the canvas width
var SKY_DAY_ALT = -0.833;         // the Sun's centre at sunrise and sunset (refraction and semidiameter)
var SKY_CIVIL_ALT = -6, SKY_NAUTICAL_ALT = -12, SKY_ASTRO_ALT = -18;

// The sky's zenith and horizon colours by the Sun's geometric altitude: day,
// the three twilights, night. Linear between rows.
var SKY_TONES = [
  [-90, [3, 5, 10], [6, 9, 16]],
  [-18, [4, 7, 15], [9, 13, 24]],
  [-12, [7, 13, 32], [20, 26, 50]],
  [-9, [10, 20, 46], [46, 42, 74]],
  [-6, [16, 31, 66], [106, 74, 96]],
  [-3, [27, 50, 94], [194, 116, 96]],
  [0, [42, 80, 132], [236, 158, 108]],
  [4, [50, 102, 160], [228, 194, 166]],
  [10, [42, 104, 170], [176, 208, 228]],
  [90, [30, 92, 168], [142, 192, 228]]
];

function _skyLerp(a, b, f) { return a + (b - a) * f; }
function _skyClamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
// Row lookup in an altitude table: the two rows around alt and how far between.
function _skyRow(table, alt) {
  for (var i = 1; i < table.length; i++) {
    if (alt <= table[i][0] || i === table.length - 1) {
      var a = table[i - 1], b = table[i];
      return { a: a, b: b, f: _skyClamp((alt - a[0]) / (b[0] - a[0]), 0, 1) };
    }
  }
}
function _skyMix(c1, c2, f) { return [_skyLerp(c1[0], c2[0], f), _skyLerp(c1[1], c2[1], f), _skyLerp(c1[2], c2[2], f)]; }
function _skyRgb(c, a) { return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + (a == null ? 1 : a.toFixed(3)) + ')'; }
function _skyTone(alt) { var r = _skyRow(SKY_TONES, alt); return { zen: _skyMix(r.a[1], r.b[1], r.f), hor: _skyMix(r.a[2], r.b[2], r.f) }; }
// The faintest magnitude that shows under a dark sky by the Sun's geometric altitude: the eye's, from how bright the sky is (almanac-skygl.js).
function _skyLimitingMag(alt) { return _sgLimitMag(_sgSkyLum(alt, -90, 0, 0)); }
// How much of the day's light there is, 0 at the end of civil twilight to 1 by day.
function _skyDaylight(alt) { return _skyClamp((alt - SKY_CIVIL_ALT) / (6 - SKY_CIVIL_ALT), 0, 1); }
// How dark for the faint sky (the Milky Way, constellation lines): 0 in
// nautical twilight to 1 by astronomical night.
function _skyDarkness(alt) { return _skyClamp((SKY_NAUTICAL_ALT + 2 - alt) / 6, 0, 1); }
// The phase of the day the Sun's geometric altitude names.
function _skyPhaseKey(alt) {
  return alt > SKY_DAY_ALT ? 'alm_sky_day' : alt > SKY_CIVIL_ALT ? 'alm_sky_civil'
    : alt > SKY_NAUTICAL_ALT ? 'alm_sky_nautical' : alt > SKY_ASTRO_ALT ? 'alm_sky_astro' : 'alm_sky_night';
}

// ══ Where things stand on the canvas ═════════════════════════════════════
// Two ways of looking. The page's panorama maps bearing to x and height to y
// linearly (240 degrees across, the ground below the horizon). A lens, once
// ZimiSky.setView points the sky somewhere, is stereographic about a chosen
// direction: nothing stretches however wide. almanac-skygl.js draws the same
// two maps on the GPU (SG_GLSL_VIEW); _skyScreen is theirs, run forward.
var SKY_LENS_FOV = [1, 140];              // the horizontal field of view a lens takes, degrees (a degree shows Venus's phase)
var SKY_PANO_SPAN = [60, 360];            // and what the panorama takes of it without a GPU

// Screen position (device px) of an altitude/azimuth, and whether it is in view.
function _skyX(s, az) { return s.W / 2 + (((az - s.center) % 360 + 540) % 360 - 180) / s.span * s.W; }
function _skyY(s, alt) { var yh = s.H * SKY_HORIZON_Y; return yh - alt * (yh - s.H * SKY_ZENITH_Y) / 90; }
function _skyInView(s, x, margin) { return x >= -margin && x <= s.W + margin; }

function _skyEnu(az, alt) { var c = Math.cos(alt * DEG_TO_RAD); return [c * Math.sin(az * DEG_TO_RAD), c * Math.cos(az * DEG_TO_RAD), Math.sin(alt * DEG_TO_RAD)]; }
function _skyDot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function _skyCross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
// The lens about a direction: its axes in (east, north, up), and radians per
// device px at the centre (stereographic: r = 2 tan(theta / 2), the edge of the
// width at half the field of view).
function _skyMakeLens(look, W) {
  var fwd = _skyEnu(look.az, look.alt), right = [Math.cos(look.az * DEG_TO_RAD), -Math.sin(look.az * DEG_TO_RAD), 0];
  return { az: look.az, alt: look.alt, fov: look.fov, fwd: fwd, right: right, up: _skyCross3(right, fwd),
    k: 2 * Math.tan(look.fov * DEG_TO_RAD / 4) / (W / 2) };
}
// Where a direction falls: { x, y } device px, visible when on the canvas.
function _skyScreen(s, az, alt, margin) {
  var m = margin || 0, x, y;
  if (!s.lens) { x = _skyX(s, az); y = _skyY(s, alt); }
  else {
    var h = _skyEnu(az, alt), c = _skyClamp(_skyDot3(h, s.lens.fwd), -1, 1), th = Math.acos(c);
    if (th > Math.PI * 0.99) return { x: -1e6, y: -1e6, visible: false };
    var sn = Math.sin(th), r = 2 * Math.tan(th / 2), qx = sn > 1e-9 ? _skyDot3(h, s.lens.right) / sn : 0, qy = sn > 1e-9 ? _skyDot3(h, s.lens.up) / sn : 0;
    x = s.W / 2 + qx * r / s.lens.k; y = s.H / 2 - qy * r / s.lens.k;
  }
  return { x: x, y: y, visible: x >= -m && x <= s.W + m && y >= -m && y <= s.H + m };
}
// The direction under a device px: the inverse of _skyScreen.
function _skyDirAt(s, x, y) {
  if (!s.lens) { return { az: ((s.center + (x / s.W - 0.5) * s.span) % 360 + 360) % 360, alt: (s.H * SKY_HORIZON_Y - y) * 90 / (s.H * (SKY_HORIZON_Y - SKY_ZENITH_Y)) }; }
  var px = x - s.W / 2, py = s.H / 2 - y, pl = Math.sqrt(px * px + py * py), L = s.lens;
  var th = 2 * Math.atan(pl * L.k / 2), qx = pl ? px / pl : 0, qy = pl ? py / pl : 0, st = Math.sin(th), ct = Math.cos(th);
  var d = [0, 1, 2].map(function (i) { return L.fwd[i] * ct + (L.right[i] * qx + L.up[i] * qy) * st; });
  return { az: (Math.atan2(d[0], d[1]) / DEG_TO_RAD + 360) % 360, alt: Math.asin(_skyClamp(d[2], -1, 1)) / DEG_TO_RAD };
}
// Device px of one degree at the centre of the view.
function _skyPxPerDeg(s) { return s.lens ? DEG_TO_RAD / s.lens.k : s.W / s.span; }
// What the GPU sky is told about the view.
function _skyGLView(s) {
  var L = s.lens;
  return { mode: L ? 1 : 0, centerAz: s.center, spanDeg: s.span, horizonY: s.H * SKY_HORIZON_Y, zenithY: s.H * SKY_ZENITH_Y,
    fwd: L ? L.fwd : [0, 1, 0], right: L ? L.right : [1, 0, 0], up: L ? L.up : [0, 0, 1], lensK: L ? L.k : 1 };
}

// ══ What the viewer has chosen ═══════════════════════════════════════════
// Kept in this browser. The defaults are the sky as a person on a beach sees
// it (the beach with its life, the Sun and Moon at a size that can be found, a
// dark site); the true horizon is a choice, and so is whatever else was
// chosen: only what the viewer set is saved, so a default that changes later
// reaches everyone who never chose.
var SKY_SETTINGS_KEY = 'zimi_sky_settings';
var SKY_SETTING_DEFAULTS = { skin: 'beach', lines: 'off', size: 'auto', dial: 0 };   // a real sky has no lines: a figure shows when its star is tapped
var SKY_SETTING_VALUES = { skin: ['horizon', 'beach'], lines: ['off', 'lines', 'names'], size: ['auto', 'true', 'large'] };
var _skySettings = null, _skyChosen = {};
function _skyLoadSettings() {
  var out = {}, k, saved = {};
  try { saved = JSON.parse(localStorage.getItem(SKY_SETTINGS_KEY)) || {}; } catch (e) {}
  _skyChosen = {};
  for (k in SKY_SETTING_DEFAULTS) out[k] = SKY_SETTING_DEFAULTS[k];
  for (k in SKY_SETTING_VALUES) if (SKY_SETTING_VALUES[k].indexOf(saved[k]) >= 0) out[k] = _skyChosen[k] = saved[k];
  if (typeof saved.dial === 'number' && saved.dial >= 0 && saved.dial <= 1) out.dial = _skyChosen.dial = saved.dial;
  return out;
}
function _skySetting(k) { if (!_skySettings) _skySettings = _skyLoadSettings(); return _skySettings[k]; }
// Choose one; the sky draws once for it.
function _skySet(k, v) {
  if (_skySetting(k) === v) return;
  _skySettings[k] = _skyChosen[k] = v;
  try { localStorage.setItem(SKY_SETTINGS_KEY, JSON.stringify(_skyChosen)); } catch (e) {}
  var s = _skyState;
  if (s) { if (k === 'dial' && s.eph) _skyBrightness(s); s.baseDirty = true; if (k === 'skin') _skyArm(); _skyKick(); }
}

// ── Red night mode ──
// Red is one of the app's themes (Light, Dark, Red), stamped as the class
// night-red on <html> (by the shell before first paint). The sky follows it
// and draws deep red on black when it is set. The theme is chosen in the shell
// (Settings, Theme), not in the sky's settings.
var SKY_NIGHT_CLASS = 'night-red';
var _skyRedSeen = false;
function _skyRedOn() {
  var root = typeof document !== 'undefined' && document.documentElement;
  return !!(root && root.classList && root.classList.contains(SKY_NIGHT_CLASS));
}
// The switch is the shell's (app.js _nightSet: the theme, the class on <html>); the sky follows.
function _skySetRed(on) {
  if (typeof _nightSet === 'function') _nightSet(on);
  _skyRedChanged();
}
// The sky's picture and the words about it (under the Moon) wear the red together.
function _skyRedScope(on) {
  var scopes = document.querySelectorAll ? document.querySelectorAll('.almanac-sky-wrap, .alm-sky-info') : [];
  for (var i = 0; i < scopes.length; i++) scopes[i].classList.toggle('sky-red', on);
}
// The sky's side of a change, whoever made it.
function _skyRedChanged() {
  var on = _skyRedOn();
  if (on === _skyRedSeen) return;
  _skyRedSeen = on;
  _skyRedScope(on);
  if (typeof CustomEvent === 'function' && document.dispatchEvent) document.dispatchEvent(new CustomEvent('zimisky:red', { detail: { on: on } }));
  _skyKickDirty();
}
function _skyWatchNight() {
  if (_skyWatchNight.on || typeof MutationObserver !== 'function' || !document.documentElement) return;
  _skyWatchNight.on = true;
  _skyRedSeen = _skyRedOn();
  new MutationObserver(_skyRedChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
}

// The sky's own light: the gradient, the glow on the Sun's side, the Milky Way.
function _skyPaintSky(ctx, s) {
  var e = s.eph, g = e.sunGeoAlt, W = s.W, H = s.H, yh = H * SKY_HORIZON_Y;
  var tone = _skyTone(g), glare = _skyClamp(_sgMoonSkyLum(e.moon.altitude, s.moonData.phase.illumination) / SG_MOON_SKY_FULL, 0, 1);
  // A bright Moon lifts a dark sky toward blue.
  var night = 1 - _skyDaylight(g);
  var zen = _skyMix(tone.zen, [22, 34, 60], glare * 0.18 * night), hor = _skyMix(tone.hor, [30, 42, 66], glare * 0.15 * night);
  var grad = ctx.createLinearGradient(0, 0, 0, yh);
  grad.addColorStop(0, _skyRgb(zen));
  grad.addColorStop(1, _skyRgb(hor));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // The glow on the Sun's side, strongest as it crosses the horizon.
  var gs = _skyClamp(1 - Math.abs(g + 1) / 13, 0, 1);
  if (gs > 0) {
    var sx = _skyClamp(_skyX(s, e.sun.az), -0.4 * W, 1.4 * W);
    var warm = g > 2 ? [255, 236, 200] : _skyMix([214, 92, 84], [255, 160, 90], _skyClamp((g + 8) / 10, 0, 1));
    var rg = ctx.createRadialGradient(sx, yh, 0, sx, yh, W * 0.6);
    rg.addColorStop(0, _skyRgb(warm, 0.55 * gs));
    rg.addColorStop(0.45, _skyRgb(warm, 0.16 * gs));
    rg.addColorStop(1, _skyRgb(warm, 0));
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, yh);
  }
  var dark = _skyDarkness(g) * (1 - 0.7 * _skyClamp(glare, 0, 1));
  if (dark > 0) _skyPaintGalaxy(ctx, s, dark);
}

// The Milky Way as a few soft strokes along the galactic equator, each one
// path (so its overlaps never stack into beads), the last only where the band
// is bright toward the centre. Breaks where the band wraps out of the view.
var SKY_GALAXY_PASSES = [[16, 0.035, 0], [8, 0.035, 0], [10, 0.04, 0.7]];   // width (deg), alpha, from weight
function _skyPaintGalaxy(ctx, s, dark) {
  var pts = s.eph.galaxy, degPx = s.W / s.span;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (var p = 0; p < SKY_GALAXY_PASSES.length; p++) {
    var pass = SKY_GALAXY_PASSES[p];
    ctx.lineWidth = pass[0] * degPx;
    ctx.strokeStyle = 'rgba(200,210,235,' + (pass[1] * dark).toFixed(3) + ')';
    ctx.beginPath();
    var open = false;
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      var ax = _skyX(s, a.az), bx = _skyX(s, b.az);
      if ((a.alt < -8 && b.alt < -8) || Math.abs(ax - bx) > s.W / 2 || (a.w + b.w) / 2 < pass[2]) { open = false; continue; }
      if (!open) ctx.moveTo(ax, _skyY(s, a.alt));
      ctx.lineTo(bx, _skyY(s, b.alt));
      open = true;
    }
    ctx.stroke();
  }
  ctx.restore();
}

// How a star of a magnitude looks to the eye: a point. The eye cannot resolve
// any star's disc, so brightness is carried by intensity; only the brightest
// few (Sirius, Vega, Rigel...) bloom a little wider, as they do on a dark
// night and in any unretouched photo. Radius in CSS pixels; drawn never
// smaller than about a device pixel across, so a 3x phone gets crisp points, not
// CSS pixels tripled.
var SKY_STAR_R_FAINT = 0.5;       // the faintest stars shown (CSS px radius)
var SKY_STAR_R_BRIGHT = 0.8;      // a first-magnitude star
var SKY_STAR_BLOOM_MAG = 0.5;     // brighter than this, a star blooms
var SKY_STAR_BLOOM_PER_MAG = 0.18; // extra radius per magnitude past the bloom
var SKY_STAR_R_MAX = 1.15;        // Sirius, the brightest, stays under this
var SKY_STAR_FAINT_MAG = 4.5;     // where the radius reaches its floor
var SKY_STAR_DIM = 0.42;          // intensity of the faintest, against 1 for the brightest
var SKY_PLANET_R_X = 1.3;        // a planet against a star of its magnitude
var SKY_STAR_GLOW_X = 5;          // the bloom's halo, in star radii
function _skyStarLook(mag) {
  var r;
  if (mag < SKY_STAR_BLOOM_MAG) r = Math.min(SKY_STAR_R_MAX, SKY_STAR_R_BRIGHT + (SKY_STAR_BLOOM_MAG - mag) * SKY_STAR_BLOOM_PER_MAG);
  else r = SKY_STAR_R_BRIGHT - (SKY_STAR_R_BRIGHT - SKY_STAR_R_FAINT) * _skyClamp((mag - SKY_STAR_BLOOM_MAG) / (SKY_STAR_FAINT_MAG - SKY_STAR_BLOOM_MAG), 0, 1);
  var k = 1 - (1 - SKY_STAR_DIM) * _skyClamp((mag - SKY_STAR_BLOOM_MAG) / (SKY_STAR_FAINT_MAG - SKY_STAR_BLOOM_MAG), 0, 1);
  return { r: r, k: k, bloom: mag < SKY_STAR_BLOOM_MAG };
}
// A star's radius in device pixels: never so small that antialiasing on a 1x
// screen greys it away.
var SKY_STAR_MIN_DEV_R = 0.65;
function _skyStarDevR(rCss, dpr) { return Math.max(SKY_STAR_MIN_DEV_R, rCss * dpr); }

// The stars the Canvas 2D sky draws itself (the GPU draws all of them when it
// can): size from magnitude, brightness from how bright the sky is
// (_sgStarVisibility, the GPU's own formula), thinned and reddened by the air
// they come through, each steady between paints but not between paintings.
// The named stars become tap targets either way.
// Look names what the eye cannot see by day: a bright star or a planet the sky's light hides is a thin ring where it
// stands (the name is written beside it by _skyHostLabels), dark under light so it reads on the blue and on the black.
var SKY_DAY_MARK_PX = 6, SKY_DAY_MARK_MAG = 1.8, SKY_DAY_MARK_SEEN = 0.6;   // a planet fainter than this share of itself in the sky is ringed
function _skyDayMark(ctx, x, y, dpr) {
  var r = SKY_DAY_MARK_PX * dpr;
  ctx.save();
  ctx.lineWidth = 3 * dpr; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.stroke();
  ctx.restore();
  return r;
}
function _skyPaintStars(ctx, s, gpu) {
  var e = s.eph, dpr = s.dpr, lm = s.lm, scint = !_skyReduceMotion();
  for (var i = 0; i < e.stars.length; i++) {
    var st = e.stars[i], named = st.idx >= 0 && _STAR_NAMES[st.idx];
    if (gpu && (!named || _skyNames)) continue;   // the GPU draws them; the bright ones are tapped by designation once those are loaded
    var look = _skyStarLook(st.mag), X = _skyAirmass(st.alt);
    var a = _sgStarVisibility(st.mag + SG_EXTINCTION_MAG * (X - 1), lm);
    var hidden = s.hosted && named && st.mag <= SKY_DAY_MARK_MAG && st.alt > 0 && a <= 0.3;   // Look names it by day though the sky hides it
    if (a < 0.02 && !hidden) continue;
    var p = _skyScreen(s, st.az, st.alt, 4);
    if (!p.visible) continue;
    if (hidden) { s.bodies.push({ type: 'star', idx: st.idx, x: p.x / dpr, y: p.y / dpr, r: _skyDayMark(ctx, p.x, p.y, dpr) / dpr, alt: st.alt, az: st.az, mag: st.mag }); continue; }
    var r = _skyStarDevR(look.r, dpr);
    if (!gpu && !_skyUnderMoon(s, p.x, p.y)) {
      if (scint) a *= 1 + _sgScintillation(st.alt) * Math.sin(st.phase + s.twinkle * 2.39996);
      a = _skyClamp(a, 0, 1);
      if (look.bloom && a > 0.4) _skyStarBloom(ctx, p.x, p.y, r, st.tint, a);
      ctx.fillStyle = 'rgba(' + st.tint + ',' + a.toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    }
    if (named && a > 0.3) s.bodies.push({ type: 'star', idx: st.idx, x: p.x / dpr, y: p.y / dpr, r: r / dpr, alt: st.alt, az: st.az, mag: st.mag });
  }
}

// ── The constellations and the brightest deep-sky objects ──
// The 88 IAU figures (earth/constellations-v1.json, from d3-celestial, BSD 3-Clause,
// scripts/build_constellations.py), drawn as faint lines once it is dark, and
// named when asked. The deep-sky list is the dozen-odd objects the eye finds
// without a telescope: positions J2000, magnitude, size in arcminutes.
var SKY_CONST_URL = '/static/earth/constellations-v1.json';
var SKY_LINE_ALPHA = 0.18, SKY_LINE_MIN_ALT = -0.5, SKY_REVEAL_ALPHA = 0.55;
var SKY_LINE_FADE_LM = [3, 5.5];         // the limiting magnitudes between which the figures fade in: no lines over a sky with no stars
var SKY_LINE_BRIGHT_MAG = [2.5, 4.6];    // a figure whose brightest star is this bright draws full, this faint at SKY_LINE_FAINT of it
var SKY_LINE_FAINT = 0.15;
var SKY_NAME_MAX_MAG = 4;                // names are written for the figures with a star this bright
var SKY_TAP_STAR_MAG = 4.5;              // every star this bright can be tapped
var _skyConst = null, _skyConstLoading = false, _skyConstFailed = false;
var _skyNames = null, _skyNamedBin = null, _skyTapStars = 0, _skyConMagById = {}, _skyStarDataLoading = false;
var SKY_DSO = [
  // name, designation, RA deg, Dec deg, magnitude, size ('), kind: g galaxy, n nebula, c cluster, m a galaxy the Milky Way panorama already shows (named and tapped, not drawn again)
  ['Andromeda Galaxy', 'M31', 10.685, 41.269, 3.4, 190, 'g'], ['Triangulum Galaxy', 'M33', 23.46, 30.66, 5.7, 70, 'g'],
  ['Double Cluster', 'NGC 869 / 884', 34.9, 57.13, 3.7, 60, 'c'], ['Pleiades', 'M45', 56.75, 24.12, 1.6, 110, 'c'],
  ['Hyades', 'Mel 25', 66.75, 15.87, 0.5, 330, 'c'], ['Orion Nebula', 'M42', 83.82, -5.39, 4.0, 65, 'n'],
  ['Beehive Cluster', 'M44', 130.0, 19.67, 3.1, 95, 'c'], ['Omega Centauri', 'NGC 5139', 201.7, -47.48, 3.9, 36, 'c'],
  ['Hercules Cluster', 'M13', 250.42, 36.46, 5.8, 20, 'c'], ['Lagoon Nebula', 'M8', 270.92, -24.38, 5.0, 45, 'n'],
  ['Ptolemy Cluster', 'M7', 268.46, -34.82, 3.3, 80, 'c'], ['Butterfly Cluster', 'M6', 265.08, -32.22, 4.2, 25, 'c'],
  ['Carina Nebula', 'NGC 3372', 161.27, -59.87, 1.0, 120, 'n'], ['Jewel Box', 'NGC 4755', 193.4, -60.34, 4.2, 10, 'c'],
  ['47 Tucanae', 'NGC 104', 6.02, -72.08, 4.0, 31, 'c'], ['Alpha Persei Cluster', 'Mel 20', 51.08, 49.86, 1.2, 185, 'c'],
  ['Large Magellanic Cloud', 'LMC', 80.89, -69.76, 0.9, 645, 'm'], ['Small Magellanic Cloud', 'SMC', 13.19, -72.8, 2.7, 320, 'm'],
  ['Wild Duck Cluster', 'M11', 282.77, -6.27, 6.3, 14, 'c'], ['Pinwheel of Orion', 'M35', 92.2, 24.35, 5.3, 28, 'c']
];
var SKY_DSO_COLOUR = { g: '255,238,210', n: '255,212,222', c: '215,228,255' };
var SKY_DSO_MIN_CSS_R = 2.4;       // the smallest glow, CSS px
var SKY_DSO_PENALTY_MAG = 0.8;     // an extended object needs a darker sky than a star of its magnitude

function _skyEquVec(raDeg, decDeg) { return _skyVec(raDeg * DEG_TO_RAD, decDeg * DEG_TO_RAD); }
function _skyLoadConstellations(onReady) {
  if (_skyConst || _skyConstLoading || _skyConstFailed || typeof fetch !== 'function') return;
  _skyConstLoading = true;
  fetch(SKY_CONST_URL).then(function (r) { if (!r.ok) throw new Error('lines'); return r.json(); }).then(function (d) {
    _skyConst = d.c.map(function (c) {
      return { id: c[0], name: c[1], gen: c[2], vec: _skyEquVec(c[3], c[4]), runs: c[5].map(function (run) {
        var pts = []; for (var i = 0; i < run.length; i += 2) pts.push(_skyEquVec(run[i], run[i + 1])); return pts; }) };
    });
    onReady();
  }).catch(function () { _skyConstFailed = true; }).then(function () { _skyConstLoading = false; });
}
// The bright stars' designations (a star on the tap's way to its figure and its name), once the GPU has the catalogue:
// which stars have proper names, how many can be tapped, and each figure's brightest star.
function _skyEnsureStarData(onReady) {
  if (_skyNames || _skyStarDataLoading || _sgFailed.names || !_sg || !_sg.starCount) return;
  _skyStarDataLoading = true;
  _sgLoadStarNames().then(function (names) {
    var st = _sg && _sg.stars;
    if (!st) return;
    var k = 0, i, j;
    while (k < st.n && st.mag[k] <= SKY_TAP_STAR_MAG) k++;
    var named = {}, legacy = _skyCatalogue(), cosTol = Math.cos(0.1 * DEG_TO_RAD);
    for (i = 0; i < legacy.length; i++) {
      if (legacy[i].idx < 0 || !_STAR_NAMES[legacy[i].idx]) continue;
      for (j = 0; j < k; j++) {
        if (legacy[i].v[0] * st.vec[3 * j] + legacy[i].v[1] * st.vec[3 * j + 1] + legacy[i].v[2] * st.vec[3 * j + 2] > cosTol) { named[j] = legacy[i].idx; break; }
      }
    }
    _skyConMagById = {};
    for (var bin in names) {
      var id = names[bin][1];
      if (_skyConMagById[id] == null || st.mag[bin] < _skyConMagById[id]) _skyConMagById[id] = st.mag[bin];
    }
    _skyTapStars = k; _skyNamedBin = named; _skyNames = names;
    onReady();
  }).catch(function () {}).then(function () { _skyStarDataLoading = false; });
}
function _skyConMag(c) { var m = _skyConMagById[c.id]; return m == null ? 6 : m; }
function _skyConById(id) { for (var i = 0; _skyConst && i < _skyConst.length; i++) if (_skyConst[i].id === id) return _skyConst[i]; return null; }
// A J2000 vector as altitude and bearing (degrees) through the scene's rotation.
function _skyAltAzOf(M, v) {
  var E = M[0] * v[0] + M[1] * v[1] + M[2] * v[2], N = M[3] * v[0] + M[4] * v[1] + M[5] * v[2], U = M[6] * v[0] + M[7] * v[1] + M[8] * v[2];
  return { alt: Math.asin(_skyClamp(U, -1, 1)) / DEG_TO_RAD, az: (Math.atan2(E, N) / DEG_TO_RAD + 360) % 360 };
}
// How strongly a figure is drawn: faded by how many stars the sky shows (lm) and by how bright its own brightest star is, never over a Moon-washed or city sky.
function _skyLineAlpha(lm, conMag, dark) {
  var fade = _skyClamp((lm - SKY_LINE_FADE_LM[0]) / (SKY_LINE_FADE_LM[1] - SKY_LINE_FADE_LM[0]), 0, 1);
  var bright = SKY_LINE_FAINT + (1 - SKY_LINE_FAINT) * _skyClamp((SKY_LINE_BRIGHT_MAG[1] - conMag) / (SKY_LINE_BRIGHT_MAG[1] - SKY_LINE_BRIGHT_MAG[0]), 0, 1);
  return SKY_LINE_ALPHA * fade * bright * dark;
}
// The figures wanted now: all of them in 'lines' or 'names' mode, the one whose star was tapped in any mode.
function _skyFiguresWanted(s) { return _skySetting('lines') !== 'off' || !!s.reveal; }
function _skyPaintConstellations(ctx, s, M) {
  var mode = _skySetting('lines'), dark = _skyDarkness(s.eph.sunGeoAlt), all = mode !== 'off', dpr = s.dpr, reveal = s.reveal, labels = [];
  if (!_skyConst || (!all && !reveal)) return;
  ctx.save();
  ctx.lineWidth = Math.max(1, 0.7 * dpr);
  for (var i = 0; i < _skyConst.length; i++) {
    var c = _skyConst[i], a = all ? _skyLineAlpha(s.lm, _skyConMag(c), dark) : 0;
    if (reveal === c.id) a = Math.max(a, SKY_REVEAL_ALPHA);
    if (a < 0.01) continue;
    ctx.strokeStyle = 'rgba(120,150,210,' + a.toFixed(3) + ')';
    ctx.beginPath();
    for (var r = 0; r < c.runs.length; r++) {
      var prev = null;
      for (var k = 0; k < c.runs[r].length; k++) {
        var aa = _skyAltAzOf(M, c.runs[r][k]), p = aa.alt > SKY_LINE_MIN_ALT ? _skyScreen(s, aa.az, aa.alt, s.W) : null;
        if (p && prev && Math.abs(p.x - prev.x) < s.W / 2 && (p.visible || prev.visible)) { ctx.moveTo(prev.x, prev.y); ctx.lineTo(p.x, p.y); }
        prev = p;
      }
    }
    ctx.stroke();
    if ((mode === 'names' && _skyConMag(c) <= SKY_NAME_MAX_MAG && a > 0.01) || reveal === c.id) labels.push({ c: c, mag: reveal === c.id ? -9 : _skyConMag(c), a: a });
  }
  if (labels.length) _skyPaintFigureNames(ctx, s, M, labels);
  ctx.restore();
}
// The figures' names, the brightest first, each only where it does not cover one already written.
function _skyPaintFigureNames(ctx, s, M, labels) {
  var dpr = s.dpr, placed = [];
  labels.sort(function (x, y) { return x.mag - y.mag; });
  ctx.font = '600 ' + Math.round(9 * dpr) + 'px ' + SKY_FONT;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (var j = 0; j < labels.length; j++) {
    var c = labels[j].c, ca = _skyAltAzOf(M, c.vec);
    if (ca.alt < 4) continue;
    var cp = _skyScreen(s, ca.az, ca.alt, -8 * dpr);
    if (!cp.visible) continue;
    var text = c.name.toUpperCase(), w = ctx.measureText(text).width + 6 * dpr, h = 12 * dpr, clash = false;
    for (var q = 0; q < placed.length; q++) if (Math.abs(placed[q].x - cp.x) < (placed[q].w + w) / 2 && Math.abs(placed[q].y - cp.y) < h) { clash = true; break; }
    if (clash) continue;
    placed.push({ x: cp.x, y: cp.y, w: w });
    ctx.fillStyle = 'rgba(150,175,225,' + Math.max(0.35, Math.min(0.75, labels[j].a * 3)).toFixed(3) + ')';
    ctx.fillText(text, cp.x, cp.y);
  }
}
// Every star down to magnitude 4.5 can be tapped: its name or its Bayer or Flamsteed designation, its magnitude and its figure.
function _skyPaintStarBodies(s, M, ctx) {
  var st = _sg && _sg.stars;
  if (!st || !_skyNames) return;
  var dpr = s.dpr, lm = s.lm;
  for (var i = 0; i < _skyTapStars; i++) {
    var unseen = _sgStarVisibility(st.mag[i], lm) < 0.05;
    var hidden = unseen && s.hosted && st.mag[i] <= SKY_DAY_MARK_MAG && _skyNamedBin[i] != null;   // Look names it by day though the sky hides it
    if (unseen && !hidden) continue;
    var aa = _skyAltAzOf(M, [st.vec[3 * i], st.vec[3 * i + 1], st.vec[3 * i + 2]]);
    if (aa.alt <= 0) continue;
    var p = _skyScreen(s, aa.az, aa.alt, 4);
    if (!p.visible || _skyUnderMoon(s, p.x, p.y)) continue;
    if (hidden) _skyDayMark(ctx, p.x, p.y, dpr);
    var nm = _skyNames[i];
    s.bodies.push({ type: 'star', bin: i, idx: _skyNamedBin[i] == null ? -1 : _skyNamedBin[i], desig: nm ? nm[0] : '', con: nm ? nm[1] : '',
      x: p.x / dpr, y: p.y / dpr, r: _skyStarDevR(_skyStarLook(st.mag[i]).r, dpr) / dpr, alt: aa.alt, az: aa.az, mag: st.mag[i] });
  }
}
// Show the figure of a tapped star until the tip goes.
function _skyRevealFigure(id) {
  var s = _skyState;
  if (!s || s.reveal === id) return;
  s.reveal = id; s.baseDirty = true;
  _skyKick();
}
function _skyPaintDeepSky(ctx, s, M) {
  var dark = _skyDarkness(s.eph.sunGeoAlt), names = _skySetting('lines') === 'names', dpr = s.dpr, ppd = _skyPxPerDeg(s);
  if (dark <= 0) return;
  for (var i = 0; i < SKY_DSO.length; i++) {
    var o = SKY_DSO[i], vis = _sgStarVisibility(o[4] + SKY_DSO_PENALTY_MAG, s.lm);
    if (vis < 0.05) continue;
    var aa = _skyAltAzOf(M, _skyEquVec(o[2], o[3]));
    if (aa.alt < 2) continue;
    var p = _skyScreen(s, aa.az, aa.alt, 10 * dpr);
    if (!p.visible) continue;
    var r = Math.max(SKY_DSO_MIN_CSS_R * dpr, o[5] / 60 / 2 * ppd), tint = SKY_DSO_COLOUR[o[6]];
    if (tint) {
      var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, 'rgba(' + tint + ',' + (0.34 * vis).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + tint + ',0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    }
    if (names && r > 3 * dpr) {
      ctx.font = '500 ' + Math.round(9 * dpr) + 'px ' + SKY_FONT;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(210,225,255,' + (0.6 * dark).toFixed(3) + ')';
      ctx.fillText(o[1], p.x + r + 3 * dpr, p.y);
    }
    if (vis > 0.3) s.bodies.push({ type: 'dso', name: o[0], desig: o[1], x: p.x / dpr, y: p.y / dpr, r: Math.max(4, r / dpr), alt: aa.alt, az: aa.az, mag: o[4] });
  }
}

// How big the Sun and the Moon are drawn. The true size is half a degree
// (about a pixel across on the page's wide panorama), so a Sun or Moon is
// never drawn smaller than the legacy disc you can find with a finger, until the
// view is close enough that the true size is bigger: 'true' draws the real
// size (never under about a pixel), 'large' always the findable disc.
var SKY_SUN_SEMI_DEG = 0.2666, SKY_TRUE_FLOOR_CSS_PX = 1.2;
function _skyBodyRadius(s, semiDeg) {
  var exact = semiDeg * _skyPxPerDeg(s), legacy = _skyClamp(s.cssW * 0.022, SKY_BODY_PX[0], SKY_BODY_PX[1]) * s.dpr, size = _skySetting('size');
  if (size === 'large') return legacy;
  if (size === 'true') return Math.max(exact, SKY_TRUE_FLOOR_CSS_PX * s.dpr);
  return Math.max(exact, legacy);
}
// Its apparent semidiameter, degrees: asin(R / distance).
// From the place, the Moon is nearer by the Earth's radius times the sine of its altitude (up to 1.7% bigger overhead): pass its altitude.
var SKY_MOON_RADIUS_KM = 1737.4, SKY_EARTH_EQ_RADIUS_KM = 6378.14;
function _skyMoonSemi(date, altDeg) {
  var d = _moonDistance(date);
  if (altDeg != null) d = Math.sqrt(Math.max(1, d * d + SKY_EARTH_EQ_RADIUS_KM * SKY_EARTH_EQ_RADIUS_KM - 2 * d * SKY_EARTH_EQ_RADIUS_KM * Math.sin(altDeg * DEG_TO_RAD)));
  return Math.asin(SKY_MOON_RADIUS_KM / d) / DEG_TO_RAD;
}

// The planets: a point each, in its own colour, as bright as its magnitude
// and the sky allow; a lit shape of its phase once the view is close enough
// to see one. Named on a tap.
var SKY_PHASED_PLANETS = ['Mercury', 'Venus', 'Mars'];
var SKY_PLANET_PHASE_PX = 3;     // the disc's radius (CSS px) from which its phase is drawn
function _skyPaintPlanets(ctx, s) {
  var e = s.eph, lm = s.lm, ppd = _skyPxPerDeg(s);
  for (var i = 0; i < e.planets.length; i++) {
    var p = e.planets[i];
    if (p.alt < 0) continue;
    var pt = _skyScreen(s, p.az, p.alt);
    if (!pt.visible || _skyUnderMoon(s, pt.x, pt.y)) continue;
    var a = _sgStarVisibility(p.mag + SG_EXTINCTION_MAG * (_skyAirmass(p.alt) - 1), lm);
    if (a < 0.05) {
      if (s.hosted) s.bodies.push({ type: 'planet', name: p.name, x: pt.x / s.dpr, y: pt.y / s.dpr, r: _skyDayMark(ctx, pt.x, pt.y, s.dpr) / s.dpr, alt: p.alt, az: p.az, mag: p.mag, phase: p.phase });   // Look names it by day though the sky hides it
      continue;
    }
    // A planet is a point too, a little fuller than a star of its brightness
    // (it does not twinkle, and its steady light reads as a touch larger).
    var x = pt.x, y = pt.y, r = _skyStarDevR(_skyStarLook(p.mag).r * SKY_PLANET_R_X, s.dpr), disc = p.semi * ppd;
    var col = _PLANETS[p.name].glow;
    var gg = ctx.createRadialGradient(x, y, 0, x, y, r * 3.2);
    gg.addColorStop(0, _hexToRgba(col, 0.35 * a));
    gg.addColorStop(1, _hexToRgba(col, 0));
    ctx.fillStyle = gg;
    ctx.beginPath(); ctx.arc(x, y, r * 3.2, 0, Math.PI * 2); ctx.fill();
    if (disc >= SKY_PLANET_PHASE_PX * s.dpr) {
      var sp = _skyScreen(s, e.sun.az, e.sunGeoAlt), ang = Math.atan2(sp.y - y, sp.x - x);
      _skyDrawPhase(ctx, x, y, disc, p.phase, ang, col, a);
      r = disc;
    } else {
      ctx.fillStyle = _hexToRgba(col, a);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    if (s.hosted && a < SKY_DAY_MARK_SEEN) _skyDayMark(ctx, x, y, s.dpr);   // faint in the blue (Venus by day): ringed so it can be found
    if (a > 0.15 || s.hosted) s.bodies.push({ type: 'planet', name: p.name, x: x / s.dpr, y: y / s.dpr, r: r / s.dpr, alt: p.alt, az: p.az, mag: p.mag, phase: p.phase });
  }
}
// A disc lit to a fraction k, its bright side toward `angle` (canvas radians):
// the shadow side a faint disc, the lit part a half circle and the terminator
// an ellipse.
function _skyDrawPhase(ctx, x, y, R, k, angle, col, a) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(angle);
  ctx.fillStyle = _hexToRgba(col, 0.12 * a);
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = _hexToRgba(col, a);
  ctx.beginPath();
  ctx.arc(0, 0, R, -Math.PI / 2, Math.PI / 2, false);
  var rx = R * Math.abs(2 * k - 1);
  if (k >= 0.5) ctx.ellipse(0, 0, rx, R, 0, Math.PI / 2, 3 * Math.PI / 2, false);
  else ctx.ellipse(0, 0, rx, R, 0, Math.PI / 2, -Math.PI / 2, true);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ── The Sun in the sky ──
// Its light comes through the air: the longer the path (the airmass), the
// more blue is scattered out of it, so it whitens high up and reddens low
// (Kasten & Young 1989 airmass; per-colour optical depths, Rayleigh plus a
// little haze, at 650/550/450 nm). Near the horizon refraction lifts its
// lower limb more than its upper and flattens it. Its face is limb-darkened
// as the 3D view's is (_sunLimb), and it blooms against the sky.
var SKY_SUN_DEPTH = [0.10, 0.14, 0.22];   // optical depth per airmass, red/green/blue
var SKY_SUN_EXPOSURE = [3.5, 9];          // the face's exposure on the horizon and from 4 degrees up: through the air it is still the brightest thing in the sky
var SKY_SUN_FULL_EXPOSURE_ALT = 4;        // degrees
var SKY_SUN_FEATHER = 0.85, SKY_SUN_FEATHER_FROM = 0.9;   // a high Sun's face fades out over its last tenth
var SKY_SUN_STOPS = [0, 0.35, 0.6, 0.8, 0.92, 0.98, 1];   // radii where the face's gradient is sampled

// Airmass at an apparent altitude (degrees), Kasten & Young (1989): the
// constants the GPU's own airmass is generated from (SG_GLSL_AIRMASS).
var SKY_AIRMASS_A = 0.50572, SKY_AIRMASS_B = 6.07995, SKY_AIRMASS_C = 1.6364;
function _skyAirmass(alt) {
  var h = Math.max(alt, -0.5);
  return 1 / (Math.sin(h * DEG_TO_RAD) + SKY_AIRMASS_A * Math.pow(h + SKY_AIRMASS_B, -SKY_AIRMASS_C));
}
var SKY_FONT = '-apple-system, system-ui, sans-serif';
// The sunlight's colour after the air, scaled so its brightest channel is 1.
function _skySunTint(alt) {
  var m = _skyAirmass(alt), t = SKY_SUN_DEPTH.map(function (k) { return Math.exp(-k * m); });
  var top = Math.max(t[0], t[1], t[2]);
  return t.map(function (x) { return x / top; });
}
// How round the disc stays (vertical over horizontal), the refraction at its
// lower limb less that at its upper, over its diameter; alt is the centre's true altitude.
function _skySunFlattening(alt) {
  var lo = _skyRefract(alt - SKY_SUN_SEMI_DEG) - (alt - SKY_SUN_SEMI_DEG);
  var hi = _skyRefract(alt + SKY_SUN_SEMI_DEG) - (alt + SKY_SUN_SEMI_DEG);
  return _skyClamp(1 - (lo - hi) / (2 * SKY_SUN_SEMI_DEG), 0.6, 1);
}

function _skyPaintSun(ctx, s) {
  var sun = s.eph.sun;
  if (sun.alt < -2) return;
  var pt = _skyScreen(s, sun.az, sun.alt), R = _skyBodyRadius(s, SKY_SUN_SEMI_DEG), x = pt.x, y = pt.y;
  if (!(x >= -R * 8 && x <= s.W + R * 8 && y >= -R * 8 && y <= s.H + R * 8)) return;
  var tint = _skySunTint(sun.alt), flat = _skySunFlattening(s.eph.sunGeoAlt);
  var expo = _skyLerp(SKY_SUN_EXPOSURE[0], SKY_SUN_EXPOSURE[1], _skyClamp(sun.alt / SKY_SUN_FULL_EXPOSURE_ALT, 0, 1));
  var c255 = tint.map(function (v) { return 255 * v; }), high = _skyClamp(sun.alt / SKY_SUN_FULL_EXPOSURE_ALT, 0, 1);
  // The bloom: a wide soft light and a bright close halo, added to the sky.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  var wide = ctx.createRadialGradient(x, y, R, x, y, R * 8);
  var glare = _skyClamp(1 - s.obsc, 0.02, 1);   // the Moon in front of it takes the glare, and leaves the corona
  wide.addColorStop(0, _skyRgb(c255, 0.32 * glare));
  wide.addColorStop(0.3, _skyRgb(c255, 0.08 * glare));
  wide.addColorStop(1, _skyRgb(c255, 0));
  ctx.fillStyle = wide;
  ctx.beginPath(); ctx.arc(x, y, R * 8, 0, Math.PI * 2); ctx.fill();
  var halo = ctx.createRadialGradient(x, y, R * 0.9, x, y, R * 2.2);
  halo.addColorStop(0, _skyRgb(c255, (0.38 - 0.16 * _skyDaylight(s.eph.sunGeoAlt)) * glare));
  halo.addColorStop(1, _skyRgb(c255, 0));
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(x, y, R * 2.2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // The face: limb-darkened in each colour, through the air's tint, flattened.
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, flat);
  var face = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
  for (var i = 0; i < SKY_SUN_STOPS.length; i++) {
    var r = SKY_SUN_STOPS[i], ld = _sunLimb(Math.sqrt(Math.max(0, 1 - r * r)));
    // Through a soft exposure, as a camera sees it: the centre burns to white-yellow, the limb stays warm.
    // A high Sun's edge dissolves into its own glare (no outline); a low one keeps its limb.
    face.addColorStop(r, _skyRgb([0, 1, 2].map(function (k) { return 255 * (1 - Math.exp(-expo * tint[k] * ld[k])); }), r > SKY_SUN_FEATHER_FROM ? 1 - SKY_SUN_FEATHER * high * (r - SKY_SUN_FEATHER_FROM) / (1 - SKY_SUN_FEATHER_FROM) : 1));
  }
  ctx.fillStyle = face;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  if (sun.alt > SKY_REFRACTION_FROM_DEG) {
    var scale = R / (SKY_SUN_SEMI_DEG * _skyPxPerDeg(s));
    s.bodies.push({ type: 'sun', x: x / s.dpr, y: y / s.dpr, r: R / s.dpr, alt: sun.alt, az: sun.az, enlarged: scale > 1.15 ? scale : 0 });
  }
}

// The Earth's shadow on the Moon (a lunar eclipse), from the geometry: the
// Moon's centre from the point opposite the Sun (geocentric, where the shadow
// stands in space), the umbra and penumbra at the Moon's distance with Danjon's
// enlargement for the air (1.02). null when the Moon is nowhere near the shadow.
// The magnitudes are the eclipse catalogues': umbral 1 is the Moon just covered.
var SKY_DANJON = 1.02, SKY_SUN_PARALLAX_ARCSEC = 8.794, SKY_ECLIPSE_REACH_DEG = 2;
function _skyEclipse(date) {
  var T = _jdToJulianCentury(_dateToJD(date.getTime())), eq = _moonEqCoords(date), sun = _skySunRaDec(T);
  var m = _skyVec(eq.ra, eq.dec), a = _skyVec(sun.ra + Math.PI, -sun.dec);
  var sep = Math.acos(_skyClamp(_skyDot3(m, a), -1, 1)) / DEG_TO_RAD;
  if (sep > SKY_ECLIPSE_REACH_DEG) return null;
  var dist = _moonDistance(date), moonSemi = _skyMoonSemi(date), moonPar = Math.asin(SKY_EARTH_EQ_RADIUS_KM / dist) / DEG_TO_RAD;
  var e = _planetHelio3D('Earth', T), R = Math.sqrt(e.x * e.x + e.y * e.y + e.z * e.z);
  var sunSemi = SKY_SUN_SEMI_DEG / R, sunPar = SKY_SUN_PARALLAX_ARCSEC / 3600 / R;
  var umbra = SKY_DANJON * (moonPar + sunPar - sunSemi), penumbra = SKY_DANJON * (moonPar + sunPar + sunSemi);
  return { sep: sep, moonSemi: moonSemi, umbra: umbra, penumbra: penumbra,
    umbralMag: (umbra + moonSemi - sep) / (2 * moonSemi), penumbralMag: (penumbra + moonSemi - sep) / (2 * moonSemi), moon: m, anti: a };
}
// The direction on the canvas from a sky vector's place toward where another
// vector (in the same frame) lies, a unit vector in device px.
function _skyScreenToward(s, pos, v) {
  var p0 = _skyScreen(s, pos.azimuth, pos.altitude), h = _skyEnu(pos.azimuth, pos.altitude);
  var t = [v[0] - _skyDot3(v, h) * h[0], v[1] - _skyDot3(v, h) * h[1], v[2] - _skyDot3(v, h) * h[2]], l = Math.sqrt(_skyDot3(t, t)) || 1;
  var q = [h[0] + 0.02 * t[0] / l, h[1] + 0.02 * t[1] / l, h[2] + 0.02 * t[2] / l], ql = Math.sqrt(_skyDot3(q, q));
  var p1 = _skyScreen(s, (Math.atan2(q[0], q[1]) / DEG_TO_RAD + 360) % 360, Math.asin(q[2] / ql) / DEG_TO_RAD);
  var dx = p1.x - p0.x, dy = p1.y - p0.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
  return { x: dx / d, y: dy / d };
}
// The turn of the zenith's direction on the canvas from straight up (radians):
// nothing in the panorama, a little off the lens's axis. The Moon's phase turn
// is measured from the zenith.
function _skyZenithRoll(s, az, alt) {
  if (!s.lens) return 0;
  var p0 = _skyScreen(s, az, alt), p1 = _skyScreen(s, az, Math.min(alt + 0.5, 89.9));
  return Math.atan2(p1.x - p0.x, -(p1.y - p0.y));
}

// The Moon at its place, phase and turn: the hero's own shaded sprite from the
// canonical _moonView (app.js), so the terminator and the maria lie as on the
// hero disc and the lit limb faces the true Sun. Pale by day, and copper in
// the Earth's shadow.
function _skyPaintMoon(ctx, s, md) {
  var pos = md.pos;
  if (pos.altitude < -2) return;
  var pt = _skyScreen(s, pos.azimuth, pos.altitude), semi = _skyMoonSemi(s.now), R = _skyBodyRadius(s, semi), ppd = _skyPxPerDeg(s);
  if (!(pt.x >= -R && pt.x <= s.W + R && pt.y >= -R && pt.y <= s.H + R)) return;
  var x = pt.x, y = pt.y, day = _skyDaylight(s.eph.sunGeoAlt);
  if (day < 0.5) {
    var ga = (md.phase.illumination / 100) * 0.16 * (1 - day * 2) * Math.sqrt(s.moonShare == null ? 1 : s.moonShare);
    var mg = ctx.createRadialGradient(x, y, R, x, y, R * 3);
    mg.addColorStop(0, 'rgba(220,215,200,' + ga.toFixed(3) + ')');
    mg.addColorStop(1, 'rgba(220,215,200,0)');
    ctx.fillStyle = mg;
    ctx.beginPath(); ctx.arc(x, y, R * 3, 0, Math.PI * 2); ctx.fill();
  }
  var view = md.view;
  var spr = (typeof _moonSpriteCanvas === 'function' && _moonTexReady) ? _moonSpriteCanvas(view, R / s.dpr) : null;
  if (s.obsc > 0.02 && s.obsc <= 0.5) _skyBlackOverSun(ctx, s, x, y, R);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((md.tilt != null ? md.tilt : view.tilt) * DEG_TO_RAD + _skyZenithRoll(s, pos.azimuth, pos.altitude));
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.clip();
  // Its light adds to the sky's, never covers it: against a dark sky the whole
  // disc shows, earthshine and all; against a bright one the dark side is the
  // sky's own colour, as it is overhead by day and in the twilight.
  // In front of the Sun its night side is black: all of it in an eclipse that covers most of the Sun, else the Sun's disc where the Moon is over it.
  if (s.obsc > 0.5) { ctx.fillStyle = '#000'; ctx.fillRect(-R, -R, R * 2, R * 2); }
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 1 - 0.1 * day;
  if (s.obsc > 0.5) { /* in front of the Sun its night side is black: no sprite */ }
  else if (spr) ctx.drawImage(spr, -R, -R, R * 2, R * 2);
  else { ctx.fillStyle = '#d8d2c0'; ctx.fillRect(-R, -R, R * 2, R * 2); }
  ctx.restore();
  if (s.obsc > 0.9) _skyPaintCorona(ctx, x, y, R, s.obsc);
  _skyPaintEarthShadow(ctx, s, x, y, R, semi);
  if (pos.altitude > SKY_REFRACTION_FROM_DEG) {
    var scale = R / (semi * ppd);
    s.bodies.push({ type: 'moon', x: x / s.dpr, y: y / s.dpr, r: R / s.dpr, alt: pos.altitude, az: pos.azimuth, enlarged: scale > 1.15 ? scale : 0 });
  }
}
// The Sun's disc where the Moon's disc (centre x, y, radius R) is over it: black, and the Sun's glare around it left alone.
function _skyBlackOverSun(ctx, s, x, y, R) {
  var sun = s.eph.sun, sp = _skyScreen(s, sun.az, sun.alt), Rs = _skyBodyRadius(s, SKY_SUN_SEMI_DEG);
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = 'rgba(0,0,0,0.96)';
  ctx.beginPath(); ctx.arc(sp.x, sp.y, Rs, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
// The Sun's outer atmosphere around a total eclipse's black disc: pearly white, a few Moon radii wide.
var SKY_CORONA_RADII = 3.4;
function _skyPaintCorona(ctx, x, y, R, obsc) {
  var k = Math.pow((obsc - 0.9) / 0.1, 3), g = ctx.createRadialGradient(x, y, R * 0.98, x, y, R * SKY_CORONA_RADII);
  g.addColorStop(0, 'rgba(250,246,236,' + (0.85 * k).toFixed(3) + ')');
  g.addColorStop(0.25, 'rgba(235,236,244,' + (0.3 * k).toFixed(3) + ')');
  g.addColorStop(1, 'rgba(220,226,240,0)');
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = g;
  // A ring, not a disc: the Moon's black face is left alone.
  ctx.beginPath(); ctx.arc(x, y, R * SKY_CORONA_RADII, 0, Math.PI * 2); ctx.arc(x, y, R * 0.98, 0, Math.PI * 2, true); ctx.fill();
  ctx.restore();
}
// The Earth's shadow across the disc when there is one: the penumbra a
// grey shading, the umbra copper (the air bends red light into it).
function _skyPaintEarthShadow(ctx, s, x, y, R, semi) {
  var ec = _skyEclipse(s.now);
  if (!ec || ec.penumbralMag <= 0) return;
  var eq = s.eph, M = _sgHorizonMatrix([[1, 0, 0], [0, 1, 0], [0, 0, 1]], eq.lst, s.lat);
  var tan = [ec.anti[0] - _skyDot3(ec.anti, ec.moon) * ec.moon[0], ec.anti[1] - _skyDot3(ec.anti, ec.moon) * ec.moon[1], ec.anti[2] - _skyDot3(ec.anti, ec.moon) * ec.moon[2]];
  var tl = Math.sqrt(_skyDot3(tan, tan)) || 1, te = [0, 1, 2].map(function (i) { return (M[3 * i] * tan[0] + M[3 * i + 1] * tan[1] + M[3 * i + 2] * tan[2]) / tl; });
  var dir = _skyScreenToward(s, s.moonData.pos, te), k = R / semi;
  var cx = x + dir.x * ec.sep * k, cy = y + dir.y * ec.sep * k, ru = ec.umbra * k, rp = ec.penumbra * k;
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.clip();
  var pg = ctx.createRadialGradient(cx, cy, ru * 0.9, cx, cy, rp);
  pg.addColorStop(0, 'rgba(30,24,22,0.38)'); pg.addColorStop(1, 'rgba(30,24,22,0)');
  ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(cx, cy, rp, 0, Math.PI * 2); ctx.fill();
  if (ec.umbralMag > 0) {
    var ug = ctx.createRadialGradient(cx, cy, 0, cx, cy, ru);
    ug.addColorStop(0, 'rgba(92,24,10,0.92)'); ug.addColorStop(0.55, 'rgba(128,38,14,0.9)');
    ug.addColorStop(0.85, 'rgba(170,70,32,0.82)'); ug.addColorStop(1, 'rgba(212,118,66,0.4)');
    ctx.fillStyle = ug; ctx.beginPath(); ctx.arc(cx, cy, ru, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// ══ Life on the horizon ══════════════════════════════════════════════════
// One scene everywhere, a window on the sky: an invented beach with palms,
// looking out to sea (the sea lies every way, whatever the real coast does). Where a tide station is near, the water stands where today's tide
// has it (more sand at low water); elsewhere at half tide, and claims no
// tide. Boats on the sea's edge, lit at night; now and then a whale; airliners
// crossing with their navigation lights; birds by day; meteors by night, more
// on a shower's peak; the aurora where it is seen; the ISS on its real track
// when it is overhead and lit. Each is tapped to say what it is. The sea,
// the boats and the aurora belong to the still picture; the palms are drawn
// over each frame from cached sprites, swaying on a light timer while seen
// (still when motion is reduced); planes, birds, whales, meteors and the
// ISS move, and only while one of them is on screen does a frame loop run.

var SKY_EYE_KM = 3.57;            // the sea's edge, km, times the square root of eye height in metres
var SKY_EYE_M = 1.7;
var SKY_SHORE = [0.3, 0.66];      // the beach's share of the ground band, high water and low
var SKY_SHORE_AMP = [2.4, 0.8];   // the edge of the sand wanders by these (CSS px, two waves along the shore), so up to their sum either side
var SKY_SHORE_WAVE = SKY_SHORE_AMP[0] + SKY_SHORE_AMP[1];
var SKY_SHALLOW_PX = 6, SKY_SHALLOW_MIX = 0.8;   // the last of the water above the sand is shallow: this deep, this much sand through it
var SKY_CALM_FRAC = 0.5;          // the sea's level where no tide station is near: half tide
// The palms: azimuth, height (share of the scene's height), lean, and how far
// their feet stand above the bottom (share of the ground band). Two groups
// at the picture's two edges (it faces the equator, 60 to 300 degrees), their
// crowns reaching in no further than the equinox's rising Moon (90) and
// setting Sun (270, and the 260 of an autumn evening at 38 N): the sunset
// and the moonrise are not behind a frond.
var SKY_PALMS = [[50, 0.4, -0.12, 0.05], [58, 0.29, 0.08, 0.15], [292, 0.25, -0.06, 0.17], [304, 0.37, 0.12, 0.07]];
// A palm's fronds: angle from the crown (0 to the right, negative up),
// length and droop (shares of the height), width (share of the length).
// Each rises from the crown and arches over.
var SKY_FRONDS = [[-2.95, 0.6, 0.36, 0.07], [-2.45, 0.58, 0.16, 0.075], [-1.95, 0.48, 0.02, 0.075], [-1.2, 0.46, 0.0, 0.075],
  [-0.65, 0.58, 0.14, 0.075], [-0.2, 0.6, 0.34, 0.07], [2.75, 0.46, 0.5, 0.065], [0.4, 0.46, 0.5, 0.065]];
var SKY_SWAY_MS = 80;             // the breeze's frames: twelve a second, only while seen and motion is not reduced
var SKY_SWAY_RAD = 0.045;         // how far a crown swings; the trunk bends a quarter of that
var SKY_RIM_PX = 1;               // the rim light's width, CSS px
// The moving things at the pace of the real sky ("It's nice but it's all too
// frequent and fast", Eric): a whale now and then, an airliner every few
// minutes taking a few minutes to cross, birds a little more often.
var SKY_WHALE_GAP_S = [240, 600], SKY_WHALE_S = [5, 6.5];
var SKY_WHALE_BLOW = 0.22;        // the share of a whale's time that is its blow, before it leaps
var SKY_WHALE_LEN = 11;           // its length, in the silhouette's units
var SKY_WHALE_SCALE = 1.4;        // the silhouette's unit, in the scene's (k)
var SKY_WHALE_DARK = [[10, 12, 16], [24, 28, 36]];   // its back, by night and by day: darker than the sea
var SKY_WHALE_FIN = [208, 218, 226];                 // a humpback's flippers are white
var SKY_SEA_ROWS = 16;            // the swell's lines, nearer ones further apart
// Azimuth seed, degrees an hour, way, kind: a ship at 22 km/h some 20 km out swings 63 degrees an hour, a fishing boat making 3 knots some 6 km out 50; one lies at anchor.
var SKY_BOAT_LIGHTS_ON_ALT = 0, SKY_BOAT_LIGHTS_FULL_DEG = 8;   // lights from the Sun's setting, in full this far below it
var SKY_SHIP_HULL_DOWN = 0.8;     // how much of a distant ship's hull is below the horizon, in hull heights
var SKY_BOAT_LIGHT_R = 0.7;       // a boat's light is a point from the shore: about a middling star (CSS px radius)
var SKY_BOATS = [[23, 0, 1, 'sail'], [151, 63, -1, 'ship'], [277, 50, 1, 'fish']];
var SKY_ACTOR_FRAME_MS = 33;      // the moving things' frames: thirty a second is smooth at this size
// An airliner flies a straight line 9 to 12 km up at 800 to 940 km/h and is
// seen as it really moves: overhead it crosses a degree or more a second,
// near the horizon a point that scarcely creeps, taking four to six minutes
// to cross. Its track is laid on the ground (how near it passes, which way it
// flies) and its place in the sky follows from that and the Earth's curve.
// Where it flies in the real world no offline page can say: it is an
// illustration of an airliner, and its tap says so.
var SKY_PLANE_GAP_S = [420, 1080];       // an airliner every seven to eighteen minutes: a sky is not a flight path
var SKY_PLANE_KM = [9, 12], SKY_PLANE_KM_S = [0.22, 0.26];   // cruising height; ground speed, km a second
var SKY_PLANE_PASS_KM = [4, 30];          // how near the ground track passes the viewer
var SKY_PLANE_MIN_ALT = 10;               // it comes out of the haze at this height and goes back into it
var SKY_PLANE_FADE_DEG = 8;               // and is in full this far higher
var SKY_PLANE_SEEN_FROM = 0.7;            // the first airliner after the sky is looked at is already flying: seen anywhere in this share of its track; every later one comes from the haze
var SKY_PLANE_CONTRAIL_SHARE = 0.4;       // the share of airliners leaving a trail the air keeps (the air must be cold and damp at their height)
// A trail forms a little behind the engines, stays where it was laid (the air it is in moves, the airliner
// does not take it along), drifts with the wind, spreads and thins until it is gone. Seconds behind the airliner.
var SKY_CONTRAIL_S = [3, 110], SKY_CONTRAIL_STEPS = 14;
var SKY_CONTRAIL_ALPHA = 0.4, SKY_CONTRAIL_FADE_S = 55;    // how bright it starts, and the seconds it takes to fall by a factor e
var SKY_CONTRAIL_WIDTH_PX = [0.9, 2.6];                     // thin where it is new, spread where it is old
var SKY_CONTRAIL_WIND_KM_S = [0.004, 0.02];                 // the wind at that height, 15 to 70 km/h: how fast the laid trail drifts
var SKY_CONTRAIL_SHEAR = 0.00015;                           // the wind changes across the layer: km a second to the power 1.5 of age, sideways
var SKY_CONTRAIL_GAP_AFTER_S = 45, SKY_CONTRAIL_GAP_RATE = 0.37, SKY_CONTRAIL_GAP_AT = 0.72;   // aged, it breaks up in places
var SKY_EARTH_KM = 6371;
var SKY_WINGSPAN_KM = 0.06;               // an A320's wingtips are 36 m apart, a 777's 65: its lights stand this far apart
var SKY_NAV_ARC_COS = Math.cos(110 * Math.PI / 180), SKY_NAV_FEATHER = 0.12;   // a wingtip light shines from dead ahead to 110 degrees round; behind, a white tail light
var SKY_PLANE_NEAR_KM = 25;               // its lights are this bright at this range, dimmer further out (they fall as the square of the range)
var SKY_PLANE_DIM_MIN = 0.4;
// Its lights as a navigator sees them from the ground: points about as
// bright as a middling star (CSS px radius, alpha), never lamps.
var SKY_PLANE_NAV_LIGHT = [0.5, 0.5];     // red and green, the wingtips
var SKY_PLANE_TAIL = [0.45, 0.45];        // the white tail light, steady
var SKY_PLANE_STROBE = [0.7, 0.75];       // the white strobe: two flashes a second
var SKY_PLANE_STROBE_MS = 1000, SKY_PLANE_STROBE_PULSES = [[0, 60], [160, 220]];
var SKY_PLANE_BEACON = [0.55, 0.55];      // the red beacon
var SKY_PLANE_BEACON_MS = 1300, SKY_PLANE_BEACON_PULSE_MS = 120;
var SKY_PLANE_CONTRAIL_GLOW = 0.7, SKY_PLANE_CONTRAIL_GLOW_PX = 1.5;   // after sunset a trail the Sun still lights: how bright, how much wider
var SKY_PLANE_SPECK_KM = 15;              // an airliner is the full speck at this range, smaller further out
var SKY_PLANE_LIT_FADE_DEG = 1;           // the Sun leaves a 10 km height this many degrees after its first touch of the horizon's dip
var SKY_BIRD_GAP_S = [120, 300], SKY_BIRD_S = [40, 70], SKY_BIRD_ALT = [4, 14];
// Meteors at the rate the real sky gives a person standing here: the
// sporadic background and the showers near their peaks, a shower only while its
// radiant is up and its meteors streaking away from it, all of it thinned
// by how bright the sky is (a bright sky shows the brighter meteors only: the
// population index is how many times as many there are a magnitude fainter).
// No speed-up: a dark night's few an hour is what a patient eye sees.
var SKY_METEOR_SPORADIC_HR = 6;   // sporadic meteors an hour at the limiting magnitude the rates are counted at
var SKY_METEOR_SHOWER_DAYS = 1.5; // a shower's rate falls by e every this many days from its peak, where it has no width of its own below
// How fast each falls away from its peak (days per e-fold: the quick Quadrantids and Draconids, the broad Aquariids and Taurids; IMO's activity profiles).
var SKY_SHOWER_DAYS = { quadrantids: 0.45, lyrids: 1.5, eta_aquariids: 4, s_delta_aquariids: 9, alpha_capricornids: 7, perseids: 1.7,
  draconids: 0.4, orionids: 4, taurids: 10, leonids: 1.5, geminids: 1.4, ursids: 2 };
var SKY_PEAK_UTC_HOUR = 12;       // the table gives the date of the peak: its middle, the nearest to the night it is of
var SKY_SPORADIC_SWING = 0.55;    // sporadic meteors run three a night's evening hour to ten before dawn: this share either side of the mean, least at 18h solar time, most at 6h
var SKY_METEOR_POP = 2.5, SKY_METEOR_LM = 6.5;
var SKY_METEOR_MS = [350, 1000];
var SKY_METEOR_RECHECK_MS = 300000;   // the sky is looked at again this often: the rate changes with the light and the time
var SKY_METEOR_MIN_RADIANT_ALT = 5;
// The radiants at the shower's peak (IMO; right ascension, declination, degrees).
var SKY_RADIANTS = { quadrantids: [230, 49], lyrids: [271, 34], eta_aquariids: [338, -1], s_delta_aquariids: [340, -16], alpha_capricornids: [307, -10],
  perseids: [48, 58], draconids: [262, 54], orionids: [95, 16], taurids: [52, 14], leonids: [152, 22], geminids: [112, 33], ursids: [217, 76] };
var SKY_MAG_POLE = [80.8, -72.6]; // the geomagnetic north pole (IGRF, 2025), degrees
var SKY_AURORA_LAT = 66, SKY_AURORA_REACH = 4;   // where the oval stands quietly (geomagnetic), how far equatorward an active Sun pushes it
var SKY_ISS_BRIGHT_SPAN_DEG = 42, SKY_ISS_R = [1, 1.7], SKY_ISS_A = [0.6, 1];   // its radius (CSS px) and strength from the lowest height it is drawn to 50 degrees
var SKY_ISS_MIN_ALT = 8;          // the ISS is drawn above this altitude, lit, in a dark enough sky

function _skyRandIn(r, pair) { return pair[0] + (pair[1] - pair[0]) * r(); }
var _skyRand = Math.random;       // the moving things are not seeded: each is new

// The sea's state at the scene's instant (almanac-tides.js), or null.
function _skySea(s) { return typeof _atSkySea === 'function' ? _atSkySea(s.nowTime) : null; }
// The tides module has stations now: the coast may have appeared.
function _skySeaChanged() {
  var s = _skyState;
  if (!s || !s.eph) return;
  var sea = _skySea(s);
  if (!!sea === !!s.sea && (!sea || Math.abs(sea.frac - s.sea.frac) < 0.01)) return;
  s.sea = sea;
  s.baseDirty = true;
  _skyKick();
}

// How far the edge of the sand lies below the tide's line at a bearing (radians), CSS px.
function _skyShoreWave(rad) { return SKY_SHORE_AMP[0] * Math.sin(rad * 3 + 0.7) + SKY_SHORE_AMP[1] * Math.sin(rad * 7 + 2); }
function _skyAzAt(s, x) { return s.center + (x / s.W - 0.5) * s.span; }

// ── The light the ground stands in ──
// The sea and the sand are lit by the sky that is drawn, not by a colour of
// their own: while the sky paints (GPU or Canvas), the strip of it above the
// horizon is kept, flipped and at a sixth of its size, which is what a sea
// mirrors (its glow toward the Sun, the Moon's halo, the blue hour's bands),
// and read as a few colours, which is what the sand and the palms are lit by.
var SKY_REFLECT_DOWN = 6;                // the mirrored strip's size: a sea blurs what it holds
var SKY_LIGHT_KEY_PER_DEG = 10;          // the Sun's height, in tenths of a degree, that makes the ground's light worth reading again
var SKY_LIGHT_GRID = [8, 4];             // the strip read as this many colours across and down (row 0 is at the horizon)
var SKY_SAND = [206, 186, 146], SKY_WATER = [30, 85, 105];   // what the sand and the water are, in white light
var SKY_PALM_TRUNK = [96, 80, 62], SKY_PALM_FROND = [44, 90, 50];
// The share of the sky a sea mirrors by how far below the horizon it is
// looked at (degrees): the Fresnel curve of water, roughened by swell.
var SKY_FRESNEL = [[0, 0.9], [2.5, 0.62], [6, 0.4], [12, 0.22], [30, 0.1]];
var SKY_SEA_SLICE_PX = 3;                // the reflection is laid in strips this tall (CSS px), each nudged by the swell
var SKY_SEA_RIPPLE_PX = 1.6;             // how far a strip is nudged, CSS px
var SKY_AMBIENT_GAIN = 0.75;             // the sky's own light on the ground, against its brightness on screen
var SKY_SUN_ON_GROUND = 0.6, SKY_MOON_ON_GROUND = 0.2;   // the share a Sun or a full Moon above the horizon adds
var SKY_SUN_RISE_FADE_DEG = 0.8;         // the Sun lights the ground from this far below the horizon (its upper limb)
var SKY_SUN_FULL_ON_GROUND_DEG = 8;      // and in full from this high
var SKY_WATER_LUMA_REF = 0.5;            // the sky brightness at which the water shows its own colour in full
var SKY_GLINT_MAX_ALT = 32;              // a Sun or Moon higher than this is mirrored below the picture's foot: no path
var SKY_GLINT_COUNT = 46, SKY_GLINT_PER_K = 60;   // glints, and how many more a bright body makes
var SKY_GLINT_SUN = 0.9, SKY_GLINT_MOON = 0.6, SKY_MOON_PHASE_POWER = 2.5;
var SKY_GLINT_GLOW = 0.22;                // the soft column the glints stand in, against the glints' own strength

function _skyTableAt(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (var i = 1; i < table.length; i++) if (x <= table[i][0]) return _skyLerp(table[i - 1][1], table[i][1], (x - table[i - 1][0]) / (table[i][0] - table[i - 1][0]));
  return table[table.length - 1][1];
}
function _skyLuma(c) { return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; }
function _skyPxPerDegY(s) { return (s.H * SKY_HORIZON_Y - s.H * SKY_ZENITH_Y) / 90; }

// Keep the sky's strip above the horizon, mirrored, and the colours read from it.
function _skyCaptureLight(s, src) {
  var yh = Math.round(s.H * SKY_HORIZON_Y), band = s.H - yh, d = SKY_REFLECT_DOWN;
  var cw = Math.max(1, Math.ceil(s.W / d)), ch = Math.max(1, Math.ceil(band / d));
  var c = s.reflect || (s.reflect = document.createElement('canvas'));
  if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
  var g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.setTransform(1, 0, 0, -1, 0, ch);
  g.drawImage(src, 0, yh - band, s.W, band, 0, 0, cw, ch);
  g.setTransform(1, 0, 0, 1, 0, 0);
  // The ground's colours are read back from the GPU, which stops everything until it answers: only when the light has
  // changed (the Sun or Moon's height, the Moon's phase, the dial), not on each frame of the Moon's glide.
  var lightKey = Math.round(s.eph.sunGeoAlt * SKY_LIGHT_KEY_PER_DEG) + ':' + Math.round(s.eph.moon.altitude) + ':' + s.moonData.phase.illumination + ':' + _skySetting('dial');
  if (s.ground && s.lightKey === lightKey) return;
  s.lightKey = lightKey;
  var gw = SKY_LIGHT_GRID[0], gh = SKY_LIGHT_GRID[1];
  var t = s.lightGrid || (s.lightGrid = document.createElement('canvas'));
  if (t.width !== gw) { t.width = gw; t.height = gh; }
  var tg = t.getContext('2d', { willReadFrequently: true });
  tg.imageSmoothingQuality = 'high';
  tg.drawImage(c, 0, 0, cw, ch, 0, 0, gw, gh);
  try {
    var px = tg.getImageData(0, 0, gw, gh).data, hor = [0, 0, 0], avg = [0, 0, 0];
    for (var i = 0; i < gw * gh; i++) for (var k = 0; k < 3; k++) { avg[k] += px[4 * i + k] / (gw * gh); if (i < gw) hor[k] += px[4 * i + k] / gw; }
    s.ground = { hor: hor, avg: avg };
  } catch (err) { s.ground = null; }
}
// The ground's light: the sky's colours, the Sun's own once it is up, the
// Moon's when it is up in a dark sky; each channel 0 to 1.
function _skyGroundLight(s) {
  var e = s.eph, md = s.moonData, tone = _skyTone(e.sunGeoAlt).hor, g = s.ground || { hor: tone, avg: tone };
  var lit = g.avg.map(function (v) { return v / 255 * SKY_AMBIENT_GAIN; });
  if (e.sun.alt > -SKY_SUN_RISE_FADE_DEG) {
    var sun = _skySunTint(Math.max(0, e.sun.alt)), k = SKY_SUN_ON_GROUND * Math.sqrt(_skyClamp(e.sun.alt / SKY_SUN_FULL_ON_GROUND_DEG + 0.1, 0, 1));
    for (var i = 0; i < 3; i++) lit[i] += k * sun[i];
  } else if (md.pos.altitude > 0 && e.sunGeoAlt < SKY_CIVIL_ALT) {
    var m = SKY_MOON_ON_GROUND * md.phase.illumination / 100 * Math.sqrt(Math.sin(md.pos.altitude * DEG_TO_RAD));
    lit[0] += m * 0.8; lit[1] += m * 0.88; lit[2] += m;
  }
  return lit.map(function (v) { return _skyClamp(v, 0, 1); });
}
// A material's colour in that light.
function _skyLitColour(albedo, lit) { return [albedo[0] * lit[0], albedo[1] * lit[1], albedo[2] * lit[2]]; }

// The sea: the water's own colour, the sky mirrored over it the way water
// does (nearly all of it at grazing sight, little at the foot), the swell, the
// Sun's or the Moon's path, and the shore where the tide has it.
function _skyPaintSea(ctx, s, frac) {
  var W = s.W, H = s.H, yh = H * SKY_HORIZON_Y, dpr = s.dpr, e = s.eph;
  var lit = s.lit = _skyGroundLight(s), bright = _skyLuma(lit.map(function (v) { return v * 255; }));
  var hor = s.ground ? s.ground.hor : _skyTone(e.sunGeoAlt).hor;
  var shore = yh + (H - yh) * (1 - _skyLerp(SKY_SHORE[0], SKY_SHORE[1], 1 - frac));
  s.shoreY = shore;
  // The water itself, darker toward the feet where it is deeper and sees less sky.
  var gain = _skyClamp(_skyLuma(s.ground ? s.ground.avg : hor) / SKY_WATER_LUMA_REF, 0.03, 1.1);
  var far = _skyMix(SKY_WATER, [0, 0, 0], 0.25).map(function (v) { return v * gain; }), near = far.map(function (v) { return v * 0.55; });
  // The beach's edge wanders by up to SKY_SHORE_WAVE px either side of the tide's line; where it dips the water
  // still stands, and the last of it is shallow: the sand shows through, so no dark band is left between the
  // deep water and the sand where the edge is far down.
  var sand = _skyLitColour(SKY_SAND, lit), wet = _skyMix(sand.map(function (v) { return v * 0.6; }), hor, 0.35);
  var shoreLow = shore + SKY_SHORE_WAVE * dpr, shallow = _skyMix(near, _skyMix(wet, sand, 0.5), SKY_SHALLOW_MIX);
  var g = ctx.createLinearGradient(0, yh, 0, shoreLow), deepEnd = (shore - yh - SKY_SHALLOW_PX * dpr) / (shoreLow - yh);
  g.addColorStop(0, _skyRgb(far)); g.addColorStop(_skyClamp(deepEnd, 0.01, 0.99), _skyRgb(near)); g.addColorStop(1, _skyRgb(shallow));
  ctx.fillStyle = g;
  ctx.fillRect(0, yh, W, H - yh);
  // The mirrored sky, in strips each moved a little sideways by the swell.
  if (s.reflect) {
    var slice = SKY_SEA_SLICE_PX * dpr, d = SKY_REFLECT_DOWN, ripple = SKY_SEA_RIPPLE_PX * dpr, perDeg = _skyPxPerDegY(s);
    var r = _lcgRand(53 + (s.twinkle % 9));
    for (var y = yh; y < shore; y += slice) {
      var h = Math.min(slice, shore - y), a = _skyTableAt(SKY_FRESNEL, (y + h / 2 - yh) / perDeg) * (0.9 + 0.2 * r());
      ctx.globalAlpha = _skyClamp(a, 0, 1);
      ctx.drawImage(s.reflect, 0, (y - yh) / d, s.reflect.width, h / d, (r() - 0.5) * ripple - 2 * ripple, y, W + 4 * ripple, h);
    }
    ctx.globalAlpha = 1;
  }
  // The swell: short strokes, their places fixed to bearings so they turn
  // with the view; a slow shimmer on the twinkle's clock.
  var lr = _lcgRand(97), ink = _skyMix(hor, [255, 255, 255], 0.3);
  ctx.lineWidth = Math.max(1, 0.8 * dpr);
  for (var rw = 1; rw <= SKY_SEA_ROWS; rw++) {
    var f = Math.pow(rw / SKY_SEA_ROWS, 1.8), sy = yh + (shore - yh) * f;
    if (sy >= shore - dpr) break;
    ctx.strokeStyle = _skyRgb(ink, 0.04 + 0.1 * Math.min(1, bright * 1.6));
    ctx.beginPath();
    for (var k = 0; k < 9; k++) {
      var az = lr() * 360 + (s.twinkle % 7) * 0.3 * (rw % 2 ? 1 : -1), x = _skyX(s, az), len = (6 + 18 * f) * dpr * lr();
      if (_skyInView(s, x, len)) { ctx.moveTo(x - len / 2, sy); ctx.lineTo(x + len / 2, sy); }
    }
    ctx.stroke();
  }
  _skyPaintGlitter(ctx, s, yh, shore);
  // The beach: one long soft curve of sand (tied to bearings, so it turns
  // with the view), wet and holding the sky's light at the water, a thin
  // line of foam, dry sand toward the feet, the light of the hour in all of it.
  ctx.beginPath(); ctx.moveTo(0, H);
  var step = 6 * dpr;
  for (var sx = 0; sx <= W + step; sx += step) {
    var sa = _skyAzAt(s, sx) * DEG_TO_RAD;
    ctx.lineTo(sx, shore + dpr * _skyShoreWave(sa));
  }
  ctx.lineTo(W, H); ctx.closePath();
  var sg = ctx.createLinearGradient(0, shore - 3 * dpr, 0, H);
  sg.addColorStop(0, _skyRgb(wet)); sg.addColorStop(0.3, _skyRgb(sand)); sg.addColorStop(1, _skyRgb(_skyMix(sand, [0, 0, 0], 0.22)));
  ctx.fillStyle = sg;
  ctx.fill();
  ctx.strokeStyle = _skyRgb(_skyMix(hor, [240, 244, 248], 0.5), 0.08 + 0.3 * Math.min(1, bright * 1.4));
  ctx.lineWidth = 1.4 * dpr;
  ctx.stroke();
  // Only a near station's tide is the sea's to tell.
  if (s.sea) s.bodies.push({ type: 'sea', box: [0, yh / dpr + 2, W / dpr, shore / dpr] });
  _skyPaintBoats(ctx, s);
}

// The light's path on the water, under the Sun or else the Moon: broken
// glints from the horizon to where the light would strike the swell square
// (as far down as the body is high, and a little past), widening toward the
// feet; none when the body is so high its reflection is below the picture.
function _skyGlintBody(s) {
  var e = s.eph, md = s.moonData;
  if (e.sun.alt > -1) return { alt: e.sun.alt, az: e.sun.az, k: SKY_GLINT_SUN, c: _skySunTint(e.sun.alt).map(function (v) { return 255 * v; }) };
  // A half Moon sends about a tenth of a full Moon's light, a crescent far less: brightness falls faster than the lit share.
  if (md.pos.altitude > 0) return { alt: md.pos.altitude, az: md.pos.azimuth, k: SKY_GLINT_MOON * Math.pow(md.phase.illumination / 100, SKY_MOON_PHASE_POWER), c: [230, 225, 205] };
  return null;
}
function _skyPaintGlitter(ctx, s, yh, shore) {
  var body = _skyGlintBody(s);
  if (!body || body.alt > SKY_GLINT_MAX_ALT) return;
  var dpr = s.dpr, bx = _skyX(s, body.az);
  if (!_skyInView(s, bx, s.W * 0.1)) return;
  var reach = Math.min(shore - yh, (body.alt * 1.6 + 3) * _skyPxPerDegY(s)), rr = _lcgRand(31 + (s.twinkle % 5));
  // The column: broad where the light is near, narrow at the horizon, fading with distance down.
  var wide = (2 + 26) * dpr * (1 - body.alt / 70), glow = ctx.createLinearGradient(0, yh, 0, yh + reach);
  glow.addColorStop(0, _skyRgb(body.c, SKY_GLINT_GLOW * body.k)); glow.addColorStop(1, _skyRgb(body.c, 0.25 * SKY_GLINT_GLOW * body.k));
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.moveTo(bx - 2 * dpr, yh); ctx.lineTo(bx + 2 * dpr, yh); ctx.lineTo(bx + wide, yh + reach); ctx.lineTo(bx - wide, yh + reach); ctx.closePath(); ctx.fill();
  for (var i = 0, n = SKY_GLINT_COUNT + Math.round(SKY_GLINT_PER_K * body.k); i < n; i++) {
    var q = Math.pow(rr(), 0.7), gy = yh + reach * q;
    var spread = (2 + 26 * q) * dpr * (1 - body.alt / 70), gw = (2 + 9 * q) * dpr * rr();
    ctx.fillStyle = _skyRgb(body.c, body.k * (0.35 + 0.65 * rr()) * (1 - 0.5 * q));
    ctx.fillRect(bx + (rr() - 0.5) * 2 * spread - gw / 2, gy, gw, Math.max(1, 0.7 * dpr));
  }
}

// The boats, on the sea's edge. By day a shape against the light; by night
// only their lights, as the rules of the sea have them: a boat under way
// shows white above, red to port and green to starboard (one side's, from
// the shore: a boat going right shows its starboard); a ship has two white
// masthead lights, the after one higher; a fishing boat (not trawling) red over white all
// round; a boat at anchor one white light all round and nothing else. Each
// is on its own slow course by the page's clock, at the pace of a ship
// some kilometres out (SKY_BOATS), the anchored one not at all.
function _skyPaintBoats(ctx, s) {
  var yh = s.H * SKY_HORIZON_Y, dpr = s.dpr, hours = s.nowTime / 3600000, light = _skyDaylight(s.eph.sunGeoAlt), night = 1 - light;
  // The rules of the sea have the lights on from sunset; they show as the sky darkens.
  var lit = _skyClamp((SKY_BOAT_LIGHTS_ON_ALT - s.eph.sunGeoAlt) / SKY_BOAT_LIGHTS_FULL_DEG, 0, 1);
  for (var i = 0; i < SKY_BOATS.length; i++) {
    var b = SKY_BOATS[i], az = ((b[0] + b[1] * b[2] * hours) % 360 + 360) % 360, x = _skyX(s, az), kind = b[3], way = b[2];
    var u = s.scale * dpr;
    if (!_skyInView(s, x, 20 * u)) continue;
    var len = (kind === 'ship' ? 16 : kind === 'sail' ? 7 : 9) * u, hull = (kind === 'ship' ? 2.6 : 1.8) * u;
    if (light > 0.05) {
      ctx.save();
      // A ship 20 km out is hull down: the horizon is 5 km off, so only its upper works stand above it.
      if (kind === 'ship') { ctx.beginPath(); ctx.rect(0, 0, s.W, yh); ctx.clip(); ctx.translate(0, SKY_SHIP_HULL_DOWN * hull); }
      ctx.fillStyle = _skyRgb(_skyMix([30, 34, 44], [16, 20, 28], night), Math.min(1, light * 1.4));
      ctx.beginPath(); ctx.moveTo(x - len / 2, yh - hull); ctx.lineTo(x + len / 2, yh - hull); ctx.lineTo(x + len * 0.4, yh); ctx.lineTo(x - len * 0.4, yh); ctx.closePath(); ctx.fill();
      if (kind === 'sail') {
        ctx.fillStyle = _skyRgb([236, 236, 230], Math.min(1, light * 1.4));
        ctx.beginPath(); ctx.moveTo(x, yh - hull - 9 * u); ctx.lineTo(x + 4 * u * way, yh - hull - 0.5 * u); ctx.lineTo(x, yh - hull - 0.5 * u); ctx.closePath(); ctx.fill();
      } else if (kind === 'ship') {
        ctx.fillRect(x - len * 0.35 * way - 2 * u, yh - hull - 3 * u, 4 * u, 3 * u);
      } else {
        ctx.fillRect(x - 1 * u, yh - hull - 3.5 * u, 3 * u, 3.5 * u);
      }
      ctx.restore();
    }
    if (lit > 0) {
      var a = lit, mast = yh - hull - (kind === 'sail' ? 9 : 4) * u, white = [255, 250, 230];
      if (kind === 'sail') {
        _skyLight(ctx, x, mast, SKY_BOAT_LIGHT_R * dpr, white, a);   // at anchor: one white light, all round
      } else {
        if (kind === 'ship') {
          _skyLight(ctx, x + way * len * 0.28, mast, SKY_BOAT_LIGHT_R * dpr, white, a);          // the fore masthead light
          _skyLight(ctx, x - way * len * 0.28, mast - 2 * u, SKY_BOAT_LIGHT_R * dpr, white, a);   // and the after one, higher
        } else {
          _skyLight(ctx, x, mast, SKY_BOAT_LIGHT_R * dpr, white, a);                              // fishing: white
          _skyLight(ctx, x, mast - 2.4 * u, SKY_BOAT_LIGHT_R * dpr, [255, 70, 60], a);             // under red
        }
        // A ship's sidelights stand low on the bridge wings: below the horizon at her range, so only a nearer boat shows one.
        if (kind !== 'ship') _skyLight(ctx, x + way * len * 0.3, yh - hull - 0.6 * u, SKY_BOAT_LIGHT_R * dpr, way > 0 ? [80, 255, 120] : [255, 70, 60], a);
      }
    }
    s.bodies.push({ type: 'boat', kind: kind, x: x / dpr, y: (yh - hull) / dpr, r: Math.max(4, len / dpr / 2) });
  }
}

// A point of light with a little bloom.
function _skyLight(ctx, x, y, r, c, a) {
  var g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
  g.addColorStop(0, _skyRgb(c, 0.55 * a)); g.addColorStop(1, _skyRgb(c, 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r * 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = _skyRgb(c, a);
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}

// ── The palms ──
// Each palm is two sprites, trunk and crown, painted once for the light they
// stand in and redrawn each frame with the breeze's small turn: dark
// against a night sky, their edges lit warm on the side the Sun truly is when
// it is low, faintly silver under a bright Moon, their own colours by day.

// One palm's outline, in its own units: the trunk from its foot (0, 0) to the
// crown, or the fronds about the crown (0, 0), filled with `col`.
function _skyPalmTrunk(g, h, lean, col) {
  var tx = lean * h, w0 = 0.042 * h, w1 = 0.017 * h, n = 12, left = [], right = [];
  for (var i = 0; i <= n; i++) {
    var u = i / n, m = 1 - u;
    // A cubic from the foot to the crown, bowing with the lean.
    var x = 3 * m * m * u * tx * 0.1 + 3 * m * u * u * tx * 0.85 + u * u * u * tx, y = -h * u;
    var w = (w0 + (w1 - w0) * u) / 2;
    left.push([x - w, y]); right.push([x + w, y]);
  }
  g.fillStyle = col;
  g.beginPath(); g.moveTo(left[0][0], left[0][1]);
  for (i = 1; i <= n; i++) g.lineTo(left[i][0], left[i][1]);
  for (i = n; i >= 0; i--) g.lineTo(right[i][0], right[i][1]);
  g.closePath(); g.fill();
}
function _skyPalmCrown(g, h, lean, col) {
  g.fillStyle = col;
  for (var i = 0; i < SKY_FRONDS.length; i++) {
    var f = SKY_FRONDS[i], len = f[1] * h, ang = f[0] + lean * 0.5;
    var tipX = Math.cos(ang) * len, tipY = Math.sin(ang) * len * 0.5 + f[2] * len;
    var midX = tipX / 2, midY = tipY / 2 - len * 0.2;
    var n = 14, side = [], other = [];
    for (var k = 0; k <= n; k++) {
      var u = k / n, m = 1 - u;
      var x = 2 * m * u * midX + u * u * tipX, y = 2 * m * u * midY + u * u * tipY;
      var dx = 2 * m * midX + 2 * u * (tipX - midX), dy = 2 * m * midY + 2 * u * (tipY - midY), d = Math.sqrt(dx * dx + dy * dy) || 1;
      // Widest a third of the way out, ragged where the leaflets part.
      var w = f[3] * len * Math.sin(u * Math.PI) * (1 - 0.3 * u) * (k % 2 ? 0.6 : 1);
      side.push([x - dy / d * w, y + dx / d * w]); other.push([x + dy / d * w, y - dx / d * w]);
    }
    g.beginPath(); g.moveTo(0, 0);
    for (k = 0; k <= n; k++) g.lineTo(side[k][0], side[k][1]);
    for (k = n; k >= 0; k--) g.lineTo(other[k][0], other[k][1]);
    g.closePath(); g.fill();
  }
  g.beginPath(); g.arc(0, 0, 0.03 * h, 0, Math.PI * 2); g.fill();
}

// The light a palm at azimuth `az` stands in: its colours, and the rim's
// colour, strength and offset (device px, toward the light).
function _skyPalmLook(s, az) {
  var e = s.eph, md = s.moonData, lit = s.lit || _skyGroundLight(s);
  // Their own colours in the light of the hour: against a twilight sky, near black.
  var look = { trunk: _skyLitColour(SKY_PALM_TRUNK, lit), frond: _skyLitColour(SKY_PALM_FROND, lit), k: 0, dx: 0, dy: 0, rim: null };
  var src = null;
  if (e.sun.alt > -3) {
    var c = _skySunTint(Math.max(0, e.sun.alt)).map(function (v) { return 255 * v; });
    var low = _skyClamp(1 - (e.sun.alt - 2) / 14, 0, 1);
    src = { alt: e.sun.alt, az: e.sun.az, c: _skyMix([250, 236, 180], c, low), k: 0.3 + 0.45 * low * _skyClamp((e.sun.alt + 3) / 4, 0, 1) };
  } else if (md.pos.altitude > 0 && e.sunGeoAlt < SKY_CIVIL_ALT) {
    src = { alt: md.pos.altitude, az: md.pos.azimuth, c: [196, 206, 226], k: 0.4 * md.phase.illumination / 100 };
  }
  if (src) {
    var d = _angleDelta(az, src.az), px = SKY_RIM_PX * s.dpr;
    // A light behind the viewer lights the palm's face, not its edge.
    if (Math.abs(d) > 100) {
      look.trunk = _skyMix(look.trunk, src.c, 0.12 * src.k); look.frond = _skyMix(look.frond, src.c, 0.12 * src.k);
    } else {
      var up = _skyClamp(src.alt / 35, 0, 1);
      look.k = src.k; look.rim = src.c;
      look.dx = (d >= 0 ? 1 : -1) * px * (1 - 0.6 * up); look.dy = -px * (0.3 + 0.7 * up);
    }
  }
  return look;
}
function _skyPalmKey(look) {
  return [look.trunk, look.frond, look.rim || [0, 0, 0]].map(function (c) { return c.map(Math.round).join(','); }).join('|')
    + '|' + look.k.toFixed(2) + '|' + Math.round(look.dx) + ',' + Math.round(look.dy);
}
// One sprite: the outline drawn whole in the rim's colour, then in its own
// colour over it, shifted away from the light and kept inside: what is
// left of the first is the lit edge.
function _skyPalmSprite(w, h, ox, oy, draw, own, look, k) {
  var c = document.createElement('canvas');
  c.width = Math.ceil(w); c.height = Math.ceil(h);
  var g = c.getContext('2d');
  g.translate(ox, oy);
  if (look.rim) {
    draw(g, _skyRgb(_skyMix(own, look.rim, k)));
    g.globalCompositeOperation = 'source-atop';
    g.translate(-look.dx, -look.dy);
  }
  draw(g, _skyRgb(own));
  return c;
}
// A palm's sprites for the light it stands in, made only when that changes.
function _skyPalmSprites(s, i) {
  var p = SKY_PALMS[i], h = p[1] * s.H, lean = p[2], look = _skyPalmLook(s, p[0]);
  var key = _skyPalmKey(look) + '|' + s.H;
  s.palmCache = s.palmCache || [];
  var hit = s.palmCache[i];
  if (hit && hit.key === key) return hit;
  var pad = 4 * s.dpr, R = 0.72 * h, tox = (lean < 0 ? -lean * h : 0) + 0.025 * h + pad;
  hit = {
    key: key, top: [lean * h, -h], R: R, tox: tox, toy: h + pad,
    trunk: _skyPalmSprite(Math.abs(lean) * h + 0.05 * h + 2 * pad, h + 2 * pad, tox, h + pad,
      function (g, c) { _skyPalmTrunk(g, h, lean, c); }, look.trunk, look, look.k * 0.6),
    crown: _skyPalmSprite(2 * R, 2 * R, R, R, function (g, c) { _skyPalmCrown(g, h, lean, c); }, look.frond, look, look.k)
  };
  s.palmCache[i] = hit;
  return hit;
}
// The palms over the frame, each turned by the breeze (two slow waves, out
// of step from palm to palm, leaning with the wind); still when motion is reduced.
function _skyPaintPalms(ctx, s, ts) {
  var band = s.H * (1 - SKY_HORIZON_Y), t = ts / 1000, still = _skyReduceMotion();
  for (var i = 0; i < SKY_PALMS.length; i++) {
    var p = SKY_PALMS[i], x = _skyX(s, p[0]);
    if (!_skyInView(s, x, p[1] * s.H)) continue;
    var sp = _skyPalmSprites(s, i), y = s.H - band * p[3];
    var sway = still ? 0 : SKY_SWAY_RAD * (0.65 * Math.sin(t * 0.9 + i * 1.7) + 0.35 * Math.sin(t * 2.3 + i * 0.6) + 0.3);
    var bend = sway * 0.25, cs = Math.cos(bend), sn = Math.sin(bend);
    ctx.save(); ctx.translate(x, y); ctx.rotate(bend);
    ctx.drawImage(sp.trunk, -sp.tox, -sp.toy);
    ctx.restore();
    var cx = x + cs * sp.top[0] - sn * sp.top[1], cy = y + sn * sp.top[0] + cs * sp.top[1];
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(sway);
    ctx.drawImage(sp.crown, -sp.R, -sp.R);
    ctx.restore();
  }
}

// ── A whale ──
// Now and then, by day, a humpback: first its blow, a plume over the water,
// then it breaches, out of the sea head first, turning over, and back in a
// splash, somewhere between the shore and the sea's edge. Drawn as a whale
// (a blunt head, the long pectoral fin, the tail narrowing to its flukes),
// not a lozenge ("Whale doesn't look like one", Eric).
function _skyWhale(s) {
  return { type: 'whale', start: performance.now(), dur: _skyRandIn(_skyRand, SKY_WHALE_S) * 1000, dir: _skyRand() < 0.5 ? 1 : -1,
    az: s.center + (_skyRand() - 0.5) * s.span * 0.6, d: 0.15 + 0.4 * _skyRand() };
}
// The silhouette, head toward +x, about SKY_WHALE_LEN long and centred on the
// origin, in the scene's units.
function _skyWhalePath(ctx) {
  ctx.beginPath();
  ctx.moveTo(5.6, 0.2);                                   // the snout
  ctx.quadraticCurveTo(5.2, -1.3, 2.4, -1.6);             // the head's top
  ctx.quadraticCurveTo(-1.8, -1.5, -3.8, -0.5);           // the back, narrowing
  ctx.lineTo(-4.6, -0.3);                                 // the tail stock
  ctx.quadraticCurveTo(-5.4, -1.6, -6.2, -2.2);           // the upper fluke
  ctx.quadraticCurveTo(-5.8, -0.6, -5.4, 0);
  ctx.quadraticCurveTo(-5.8, 0.6, -6.2, 2.2);             // the lower fluke
  ctx.quadraticCurveTo(-5.4, 1.6, -4.6, 0.3);
  ctx.lineTo(-3.8, 0.5);
  ctx.quadraticCurveTo(-0.8, 1.9, 2.6, 1.5);              // the belly
  ctx.quadraticCurveTo(5.0, 1.2, 5.6, 0.2);
  ctx.fill();
}
// The humpback's long pectoral fin, swept back from under the head.
function _skyWhaleFin(ctx) {
  ctx.beginPath();
  ctx.moveTo(2.6, 1.0);
  ctx.quadraticCurveTo(0.8, 2.6, -1.2, 3.2);
  ctx.quadraticCurveTo(0.6, 2.0, 1.4, 1.1);
  ctx.fill();
}
function _skyPaintWhale(ctx, s, a, ts) {
  var p = _skyActorAt(a, ts), x = _skyX(s, a.az), yh = s.H * SKY_HORIZON_Y, dpr = s.dpr;
  if (!_skyInView(s, x, 30 * dpr) || !s.shoreY) return;
  var wy = yh + (s.shoreY - yh) * a.d, k = s.scale * dpr * (0.7 + 1.4 * a.d), light = _skyDaylight(s.eph.sunGeoAlt);
  var spray = 'rgba(240,246,250,';
  // The blow: a plume rising and drifting apart, before the leap.
  if (p < SKY_WHALE_BLOW) {
    var b = p / SKY_WHALE_BLOW, fade = (1 - b) * (0.4 + 0.6 * light);
    ctx.fillStyle = spray + (0.55 * fade).toFixed(3) + ')';
    for (var m = 0; m < 3; m++) {
      ctx.beginPath();
      ctx.ellipse(x + (m - 1) * 1.1 * k * b, wy - (2 + 5 * b + m * 1.2) * k, (0.8 + 1.4 * b) * k, (1.1 + 1.6 * b) * k, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // The leap: out nose first, over, and back in.
  var q = _skyClamp((p - SKY_WHALE_BLOW) / (1 - SKY_WHALE_BLOW) * 1.2, 0, 1);
  if (p >= SKY_WHALE_BLOW && q < 1) {
    var rise = Math.sin(Math.PI * q);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, s.W, wy); ctx.clip();
    var len = SKY_WHALE_LEN * SKY_WHALE_SCALE * k;
    ctx.translate(x + a.dir * (q - 0.5) * 6 * k, wy + len * (0.35 - 0.55 * rise));
    ctx.scale(a.dir * k * SKY_WHALE_SCALE, k * SKY_WHALE_SCALE);
    ctx.rotate(-1.25 + 1.9 * q);                          // nose up, over, nose down
    ctx.fillStyle = _skyRgb(_skyMix(SKY_WHALE_DARK[0], SKY_WHALE_DARK[1], light));
    _skyWhalePath(ctx);
    ctx.fillStyle = _skyRgb(SKY_WHALE_FIN, 0.35 + 0.55 * light);
    _skyWhaleFin(ctx);
    ctx.restore();
  }
  // White water where it leaves and where it falls back.
  var splash = p < SKY_WHALE_BLOW ? 0 : Math.max(1 - (p - SKY_WHALE_BLOW) / 0.2, p > 0.7 ? Math.sin(Math.PI * (p - 0.7) / 0.3) : 0);
  if (splash > 0) {
    var sx = p < 0.6 ? x - a.dir * 2 * k : x + a.dir * 4 * k;
    ctx.strokeStyle = spray + (0.85 * splash * (0.4 + 0.6 * light)).toFixed(3) + ')';
    ctx.lineWidth = Math.max(1, 0.9 * dpr);
    ctx.beginPath();
    for (var j = -3; j <= 3; j++) {
      var tall = (5 - Math.abs(j)) * k * (0.6 + 0.6 * splash);
      ctx.moveTo(sx + j * 1.6 * k, wy); ctx.lineTo(sx + j * 2.2 * k, wy - tall);
    }
    ctx.stroke();
  }
  s.bodies.push({ type: 'whale', x: x / dpr, y: (wy - 4 * k) / dpr, r: 10 });
}

// The sea and the beach, and the compass along the foot of the scene: small,
// in the sand, out of the view (Eric: "Move the compass under or something
// it's ugly"; it sat on the sea).
var SKY_COMPASS_FOOT_PX = 4;   // css px from the bottom edge to the letters' baseline
function _skyPaintGround(ctx, s) {
  _skyPaintSea(ctx, s, s.sea ? s.sea.frac : SKY_CALM_FRAC);
}
// The points of the compass along the foot of the beach: drawn after the palms, which would stand over them.
function _skyPaintCompassFoot(ctx, s) {
  var light = _skyDaylight(s.eph.sunGeoAlt), dpr = s.dpr, y = s.H - SKY_COMPASS_FOOT_PX * dpr;
  ctx.font = '600 ' + Math.round(9 * dpr) + 'px ' + SKY_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = light > 0.5 ? 'rgba(60,45,25,0.42)' : 'rgba(210,215,230,0.32)';
  for (var az = 0; az < 360; az += 45) {
    var cx = _skyX(s, az);
    if (!_skyInView(s, cx, -6 * dpr)) continue;
    ctx.fillText(_azCompass(az), cx, y);
  }
}

// ── The aurora ──
// Seen where the auroral oval passes overhead or near: by geomagnetic
// latitude (a tilted dipole), farther toward the equator when the Sun is
// active (the sunspot number the 3D Sun shows). Only in a dark sky. The
// curtain is illustrative: how bright, and when, no one can say offline.
function _skyMagLat(lat, lon) {
  var p = SKY_MAG_POLE[0] * DEG_TO_RAD, la = lat * DEG_TO_RAD, dl = (lon - SKY_MAG_POLE[1]) * DEG_TO_RAD;
  return Math.asin(Math.sin(la) * Math.sin(p) + Math.cos(la) * Math.cos(p) * Math.cos(dl)) / DEG_TO_RAD;
}
function _skySunActivity(ms) {
  if (typeof _aeSunspotNumber !== 'function') return 0.5;
  return _skyClamp(_aeSunspotNumber(_aeDecimalYear(ms)).r / 180, 0, 1.5);
}
// The oval stands about 110 km up: from under it, overhead; from a few
// degrees of latitude either side, low toward it (on the pole's side from
// equatorward of it, on the equator's side from poleward), gone past ~10.
var SKY_AURORA_SEEN_DEG = 10, SKY_AURORA_ALT_PER_DEG = 9;
function _skyAurora(s) {
  var m = _skyMagLat(s.lat, s.lon), act = _skySunActivity(s.nowTime);
  var dist = Math.abs(m) - (SKY_AURORA_LAT - SKY_AURORA_REACH * act);
  var k = _skyClamp(1 - Math.abs(dist) / SKY_AURORA_SEEN_DEG, 0, 1) * _skyDarkness(s.eph.sunGeoAlt);
  if (k <= 0.02) return null;
  var poleward = m >= 0 ? 0 : 180;
  return { k: k, mag: m, act: act, toward: dist < 0 ? poleward : (poleward + 180) % 360,
    alt: _skyClamp(90 - Math.abs(dist) * SKY_AURORA_ALT_PER_DEG, 2, 70) };
}
function _skyPaintAurora(ctx, s) {
  var au = s.aurora;
  if (!au || s.lens) return;
  var dpr = s.dpr, yh = s.H * SKY_HORIZON_Y, step = 1.5;
  var drift = s.twinkle * 0.07, reach = 80 + au.alt * 1.4;   // overhead, it spans the sky
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (var d = -reach; d <= reach; d += step) {
    var az = au.toward + d, x = _skyX(s, az);
    if (!_skyInView(s, x, 4 * dpr)) continue;
    var a = d * DEG_TO_RAD * 3 + drift;
    var curtain = 0.5 + 0.5 * Math.sin(a) * Math.sin(a * 2.7 + 1.3) + 0.25 * Math.sin(a * 7.1 + drift * 3);
    var fall = Math.exp(-Math.pow(d / (reach * 0.7), 2));
    var k = au.k * fall * _skyClamp(curtain, 0, 1.2);
    if (k < 0.02) continue;
    var top = 14 + 16 * au.k * (0.6 + 0.4 * Math.sin(a * 1.7)), base = Math.max(1, au.alt * Math.cos(d / reach * Math.PI / 2)) + 2 + 3 * Math.sin(a * 0.9 + 2);
    var y0 = _skyY(s, base), y1 = _skyY(s, top + base);
    var g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, 'rgba(90,255,160,0)');
    g.addColorStop(0.12, 'rgba(90,255,160,' + (0.3 * k).toFixed(3) + ')');
    g.addColorStop(0.55, 'rgba(70,230,150,' + (0.14 * k).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(220,70,120,' + (0.05 * k).toFixed(3) + ')');
    ctx.fillStyle = g;
    ctx.fillRect(x - step / s.span * s.W, y1, step / s.span * s.W * 1.6, Math.min(y0, yh) - y1);
  }
  ctx.restore();
  // Its tap: the band where it is brightest, when that is in view.
  var cx = _skyX(s, au.toward) / dpr, half = s.cssW * 0.2;
  if (cx > -half && cx < s.cssW + half) {
    s.bodies.push({ type: 'aurora', mag: au.mag,
      box: [Math.max(0, cx - half), _skyY(s, au.alt + 28) / dpr, Math.min(s.cssW, cx + half), _skyY(s, Math.max(1, au.alt - 2)) / dpr] });
  }
}

// ── The ISS ──
// From the satellites the 3D view has loaded (none until it has, and none
// once its elements are only approximate): where it stands in this sky, and
// whether the Sun lights it while the observer's sky is dark enough to see it.
function _skyIss(s, ms) {
  if (typeof _ae === 'undefined' || !_ae || !_ae.sats || typeof _aeSceneAt !== 'function') return null;
  var iss = null, list = _ae.sats.list;
  for (var i = 0; i < list.length; i++) if (list[i].iss) { iss = list[i]; break; }
  if (!iss || _aeSatStanding((ms - iss.epochMs) / MS_PER_DAY, true) !== 'exact') return null;
  var st = _aeSatAt(iss, ms, 0), sc = _aeSceneAt(ms);
  if (!st) return null;
  var sat = _aeTemeToScene(st.posKm, _aeEqEq(sc));
  var obs = _aeFixedToScene(_aeGeodeticToFixed(s.lat, s.lon), sc.gast);
  var up = _aeNorm(obs), d = _aeSub(sat, obs), dist = _aeLen(d), dn = _aeScale(d, 1 / dist);
  var alt = Math.asin(_aeDot(dn, up)) / DEG_TO_RAD;
  if (alt < SKY_ISS_MIN_ALT) return null;
  var east = _aeNorm(_aeCross([0, 0, 1], up)), north = _aeCross(up, east);
  var az = (Math.atan2(_aeDot(dn, east), _aeDot(dn, north)) / DEG_TO_RAD + 360) % 360;
  // In the Earth's shadow (a cylinder behind it, away from the Sun): unseen.
  var sun = _aeNorm(sc.sun), along = _aeDot(sat, sun);
  if (along < 0 && _aeLen(_aeSub(sat, _aeScale(sun, along))) < 1) return null;
  return { alt: alt, az: az, km: (_aeLen(sat) - 1) * AE_EARTH_RADIUS_KM };
}

// ── The moving things ──
// Each is {type, start, dur, az0, az1, alt0, alt1, ...}: a path across the
// sky in azimuth and altitude, so it stays put when the view turns.
function _skyActorAt(a, ts) { return _skyClamp((ts - a.start) / a.dur, 0, 1); }
function _skyCrossing(s, type, durS, altPair) {
  var dir = _skyRand() < 0.5 ? 1 : -1, alt = _skyRandIn(_skyRand, altPair);
  var from = s.center - dir * (s.span / 2 + 6), to = s.center + dir * (s.span / 2 + 6);
  return { type: type, start: performance.now(), dur: _skyRandIn(_skyRand, durS) * 1000, dir: dir,
    az0: from, az1: to, alt0: alt, alt1: alt + (_skyRand() - 0.5) * 8 };
}
// How much of the real meteor rate a sky of this brightness shows: each
// magnitude of limiting magnitude lost thins them by the population index;
// a darker sky than the one the rates are counted at shows no more (a person
// counting sees about the ZHR at best).
function _skyMeteorVisible(lm) { return Math.pow(SKY_METEOR_POP, Math.min(0, lm - SKY_METEOR_LM)); }
// Meteors an hour at the scene's instant, as seen from here: the sporadic
// background and the showers near their peaks (almanac.js _METEOR_SHOWERS)
// while their radiant is up, all thinned by the sky's brightness. perHour is
// the whole; shower is the busiest (or null); parts are the ones that count,
// each with where its radiant stands.
function _skyMeteorRate(s) {
  var seen = _skyMeteorVisible(s.lm), best = null, d = new Date(s.nowTime);
  var solarHour = _skySolarMinutes(d, s.lon) / 60, night = 1 + SKY_SPORADIC_SWING * Math.cos((solarHour - 6) / 24 * 2 * Math.PI);
  var parts = [{ perHour: SKY_METEOR_SPORADIC_HR * seen * night, radiant: null }];
  if (typeof _METEOR_SHOWERS !== 'undefined' && s.eph) {
    var sinLat = Math.sin(s.lat * DEG_TO_RAD), cosLat = Math.cos(s.lat * DEG_TO_RAD);
    for (var i = 0; i < _METEOR_SHOWERS.length; i++) {
      var sh = _METEOR_SHOWERS[i], days = Infinity, rad = SKY_RADIANTS[sh.key];
      for (var y = d.getUTCFullYear() - 1; y <= d.getUTCFullYear() + 1; y++) {
        days = Math.min(days, Math.abs(s.nowTime - Date.UTC(y, sh.peak[0] - 1, sh.peak[1], SKY_PEAK_UTC_HOUR)) / MS_PER_DAY);
      }
      var zhr = sh.zhr * Math.exp(-days / (SKY_SHOWER_DAYS[sh.key] || SKY_METEOR_SHOWER_DAYS));
      if (zhr < 0.5 || !rad) continue;
      var up = _skyHorizontal(rad[0] * DEG_TO_RAD, rad[1] * DEG_TO_RAD, s.eph.lst, sinLat, cosLat);
      if (up.alt < SKY_METEOR_MIN_RADIANT_ALT) continue;
      // The rate is counted with the radiant overhead; lower, fewer meteors enter the air from the part of the sky that shows them.
      var r = zhr * Math.sin(up.alt * DEG_TO_RAD) * seen;
      parts.push({ perHour: r, radiant: { az: up.az, alt: up.alt }, sh: sh });
      if (!best || r > best.r) best = { sh: sh, r: r };
    }
  }
  var total = 0;
  for (var j = 0; j < parts.length; j++) total += parts[j].perHour;
  return { perHour: total, shower: best && best.r >= 1 ? best : null, parts: parts };
}
// One meteor: a shower's streaks away from its radiant (the lines trace back to it); a sporadic one any way.
function _skyMeteor(s, part) {
  var az = s.center + (_skyRand() - 0.5) * s.span * 0.9, alt = 20 + 60 * _skyRand(), len = 6 + 10 * _skyRand(), ang = _skyRand() * 2 * Math.PI;
  if (part && part.radiant) {
    var dx = _angleDelta(part.radiant.az, az) * Math.cos(alt * DEG_TO_RAD), dy = alt - part.radiant.alt, n = Math.sqrt(dx * dx + dy * dy) || 1;
    ang = Math.atan2(dy / n, dx / n);
  }
  var c = Math.cos(ang), sn = Math.sin(ang), k = 1 / Math.max(0.3, Math.cos(alt * DEG_TO_RAD));
  return { type: 'meteor', start: performance.now(), dur: _skyRandIn(_skyRand, SKY_METEOR_MS),
    az0: az, alt0: alt, az1: az + c * len * k, alt1: alt + sn * len };
}

// ── An airliner ──
// The track on the ground: it passes `b` km from the viewer at azimuth
// `theta`, flying clockwise (dir 1) or the other way, `h` km up; along is the
// km from that nearest point. Where it stands in the sky follows from the
// curve of the Earth: its height above the horizon, its bearing, its range.
function _skyPlaneAt(a, p) {
  var along = _skyLerp(a.L0, a.L1, p), th = a.theta * DEG_TO_RAD, st = Math.sin(th), ct = Math.cos(th);
  return _skyPlaneFromEN(a.b * st + along * a.dir * ct, a.b * ct - along * a.dir * st, a.h);
}
// Where something h km up, E km east and N km north of the viewer, stands in the sky.
function _skyPlaneFromEN(E, N, h) {
  var rho = Math.sqrt(E * E + N * N), arc = rho / SKY_EARTH_KM, top = SKY_EARTH_KM + h;
  return { E: E, N: N, rho: rho, az: (Math.atan2(E, N) / DEG_TO_RAD + 360) % 360,
    alt: Math.atan2(top * Math.cos(arc) - SKY_EARTH_KM, top * Math.sin(arc)) / DEG_TO_RAD };
}
// A point of its trail laid `age` seconds ago: where the airliner was then, taken on by the wind (and its change across
// the layer, sideways) for as long as it has been there.
function _skyContrailAt(a, p, age) {
  var v = (a.L1 - a.L0) / (a.dur / 1000), was = _skyPlaneAt(a, p - age * v / (a.L1 - a.L0)), w = a.wind, drift = Math.pow(age, 1.5) * SKY_CONTRAIL_SHEAR, speed = Math.hypot(w[0], w[1]) || 1;
  return _skyPlaneFromEN(was.E + w[0] * age - w[1] / speed * drift, was.N + w[1] * age + w[0] / speed * drift, a.h);
}
// How far out an airliner at height h is seen down to SKY_PLANE_MIN_ALT (flat ground; the curve matters little this close).
function _skyPlaneReach(h) { return h / Math.tan(SKY_PLANE_MIN_ALT * DEG_TO_RAD); }
function _skyWind() {
  var sp = _skyRandIn(_skyRand, SKY_CONTRAIL_WIND_KM_S), dir = _skyRand() * 2 * Math.PI;
  return [sp * Math.sin(dir), sp * Math.cos(dir)];
}
function _skyPlane(s, flying) {
  var h = _skyRandIn(_skyRand, SKY_PLANE_KM), b = _skyRandIn(_skyRand, SKY_PLANE_PASS_KM), v = _skyRandIn(_skyRand, SKY_PLANE_KM_S);
  var half = Math.sqrt(Math.max(0, Math.pow(_skyPlaneReach(h), 2) - b * b)), from = -half + (flying ? 2 * half * SKY_PLANE_SEEN_FROM * _skyRand() : 0);
  return { type: 'plane', start: performance.now(), dur: (half - from) / v * 1000, dir: _skyRand() < 0.5 ? 1 : -1, h: h, b: b,
    theta: s.center + (_skyRand() - 0.5) * s.span, L0: from, L1: half, contrail: _skyRand() < SKY_PLANE_CONTRAIL_SHARE,
    wind: _skyWind(), phase: _skyRand() * SKY_PLANE_STROBE_MS };
}
// Which of its lights this side of it shows (each 0 to 1): a wingtip light
// shines from dead ahead round to 110 degrees on its own side, so from the
// side one colour only, red when the viewer is on the plane's left; from
// ahead the two meet; from behind a steady white tail light. cosPsi is the
// angle between its heading and the way to the viewer.
function _skyPlaneLights(a, pos) {
  var th = a.theta * DEG_TO_RAD, hE = a.dir * Math.cos(th), hN = -a.dir * Math.sin(th), uE = -pos.E / pos.rho, uN = -pos.N / pos.rho;
  var cosPsi = hE * uE + hN * uN, sinPsi = hE * uN - hN * uE;   // sinPsi > 0: the viewer is on its left
  var arc = _skyClamp((cosPsi - SKY_NAV_ARC_COS) / SKY_NAV_FEATHER, 0, 1), left = _skyClamp(0.5 + sinPsi * 8, 0, 1);
  return { red: arc * left, green: arc * (1 - left), tail: 1 - arc, cosPsi: cosPsi };
}
// A pulse of a repeating light: on within [from, to) ms of each period.
function _skyPulse(t, period, windows) {
  var m = ((t % period) + period) % period;
  for (var i = 0; i < windows.length; i++) if (m >= windows[i][0] && m < windows[i][1]) return true;
  return false;
}
// The trail behind an airliner: new and thin near it, drifting with the wind, spread and broken where it is old.
// By day white; a high one the Sun still lights after the ground is dark keeps a glow, and the Sun's colour.
function _skyPaintContrail(ctx, s, a, p, x, y, light, sunlit) {
  var dpr = s.dpr, e = s.eph, last = { x: x, y: y, alt: 99 }, span = SKY_CONTRAIL_S[1] - SKY_CONTRAIL_S[0];
  var tint = _skySunTint(Math.max(0, e.sun.alt)).map(function (v) { return 255 * v; }), c = _skyMix([255, 255, 255], tint, _skyClamp(1 - (e.sunGeoAlt + 3) / 10, 0, 1));
  var glow = sunlit * (1 - light), reach = 0.4 + 0.6 * sunlit;   // a trail only the Sun's last light finds is a short one
  ctx.lineCap = 'round';
  for (var i = 0; i <= SKY_CONTRAIL_STEPS; i++) {
    var age = SKY_CONTRAIL_S[0] + span * reach * i / SKY_CONTRAIL_STEPS, q = _skyContrailAt(a, p, age), qx = _skyX(s, q.az), qy = _skyY(s, q.alt);
    if (i && q.alt > 0 && last.alt > 0 && Math.abs(qx - last.x) < s.W / 2 && !(age > SKY_CONTRAIL_GAP_AFTER_S && Math.sin(age * SKY_CONTRAIL_GAP_RATE + a.phase) > SKY_CONTRAIL_GAP_AT)) {
      var fresh = Math.exp(-age / SKY_CONTRAIL_FADE_S), alpha = Math.max(SKY_CONTRAIL_ALPHA * light, SKY_PLANE_CONTRAIL_GLOW * glow) * sunlit * fresh;
      ctx.lineWidth = dpr * _skyLerp(SKY_CONTRAIL_WIDTH_PX[0], SKY_CONTRAIL_WIDTH_PX[1], (age - SKY_CONTRAIL_S[0]) / span) * (1 + SKY_PLANE_CONTRAIL_GLOW_PX * glow);
      ctx.strokeStyle = _skyRgb(c, alpha);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(qx, qy); ctx.stroke();
    }
    last = { x: qx, y: qy, alt: q.alt };
  }
}
function _skyPaintPlane(ctx, s, a, ts) {
  var p = _skyActorAt(a, ts), pos = _skyPlaneAt(a, p), dpr = s.dpr, u = s.scale * dpr, e = s.eph;
  var x = _skyX(s, pos.az), y = _skyY(s, pos.alt), light = _skyDaylight(e.sunGeoAlt);
  if (!_skyInView(s, x, 30 * dpr)) return;
  var haze = _skyClamp((pos.alt - SKY_PLANE_MIN_ALT) / SKY_PLANE_FADE_DEG, 0, 1);
  if (haze <= 0) return;
  ctx.save();
  ctx.globalAlpha = haze;
  // The Sun's light still reaches an airliner when the ground is in shadow (the horizon dips a few degrees from 10 km): its trail glows then.
  var dip = Math.acos(SKY_EARTH_KM / (SKY_EARTH_KM + a.h)) / DEG_TO_RAD, sunlit = _skyClamp((e.sunGeoAlt + dip) / SKY_PLANE_LIT_FADE_DEG, 0, 1);
  if (a.contrail && sunlit > 0 && (light > 0.1 || e.sunGeoAlt > -dip)) _skyPaintContrail(ctx, s, a, p, x, y, light, sunlit);
  // By day a speck: from the ground an airliner is a fraction of a degree long.
  if (light > 0.15) {
    var sp = _skyClamp(SKY_PLANE_SPECK_KM / pos.rho, 0.35, 1.2) * u, ahead = _skyPlaneAt(a, Math.min(1, p + 0.002)), head = Math.atan2(_skyY(s, ahead.alt) - y, _skyX(s, ahead.az) - x);
    ctx.save();
    ctx.translate(x, y); ctx.rotate(head);   // its body along its way, the wings across it
    ctx.fillStyle = 'rgba(40,46,58,' + (0.7 * light).toFixed(3) + ')';
    ctx.fillRect(-1.5 * sp, -0.35 * sp, 3 * sp, 0.7 * sp);
    ctx.fillRect(-0.3 * sp, -1.3 * sp, 0.6 * sp, 2.6 * sp);
    ctx.restore();
  } else if (sunlit > 0) {
    // After sunset a high one still catches the Sun: a bright warm point.
    _skyLight(ctx, x, y, 0.6 * dpr, _skySunTint(0).map(function (v) { return 255 * v; }), 0.9 * sunlit * (1 - light));
  }
  if (light < 0.8) {
    var on = (1 - light) * _skyClamp(SKY_PLANE_NEAR_KM * SKY_PLANE_NEAR_KM / (pos.rho * pos.rho), SKY_PLANE_DIM_MIN, 1), t = ts - a.start + a.phase;
    var nav = SKY_PLANE_NAV_LIGHT, st = SKY_PLANE_STROBE, bc = SKY_PLANE_BEACON, tail = SKY_PLANE_TAIL, lt = _skyPlaneLights(a, pos);
    // The wingtips, one red and one green, stand apart by the wingspan seen end on, and together seen from the side.
    var sep = Math.abs(lt.cosPsi) * 0.5 * SKY_WINGSPAN_KM / pos.rho / DEG_TO_RAD * _skyPxPerDeg(s);
    if (lt.red > 0.02) _skyLight(ctx, x + lt.cosPsi * sep, y, nav[0] * dpr, [255, 60, 50], nav[1] * on * lt.red);
    if (lt.green > 0.02) _skyLight(ctx, x - lt.cosPsi * sep, y, nav[0] * dpr, [70, 255, 110], nav[1] * on * lt.green);
    if (lt.tail > 0.02) _skyLight(ctx, x, y, tail[0] * dpr, [255, 255, 255], tail[1] * on * lt.tail);
    if (_skyPulse(t, SKY_PLANE_STROBE_MS, SKY_PLANE_STROBE_PULSES)) _skyLight(ctx, x, y, st[0] * dpr, [255, 255, 255], st[1] * on);
    if (_skyPulse(t, SKY_PLANE_BEACON_MS, [[0, SKY_PLANE_BEACON_PULSE_MS]])) _skyLight(ctx, x, y - 0.8 * u, bc[0] * dpr, [255, 40, 30], bc[1] * on);
  }
  ctx.restore();
  s.bodies.push({ type: 'plane', x: x / dpr, y: y / dpr, r: 6 });
}
function _skyPaintActor(ctx, s, a, ts) {
  if (a.type === 'plane') { _skyPaintPlane(ctx, s, a, ts); return; }
  var p = _skyActorAt(a, ts), dpr = s.dpr;
  var az = a.az0 + (a.az1 - a.az0) * p, alt = a.alt0 + (a.alt1 - a.alt0) * p;
  var x = _skyX(s, az), y = _skyY(s, alt), u = s.scale * dpr, light = _skyDaylight(s.eph.sunGeoAlt);
  if (!_skyInView(s, x, 30 * dpr)) return;
  if (a.type === 'birds') {
    ctx.strokeStyle = 'rgba(30,34,42,' + (0.75 * light + 0.1).toFixed(3) + ')';
    ctx.lineWidth = 1.1 * dpr;
    ctx.beginPath();
    for (var i = 0; i < a.n; i++) {
      var row = Math.ceil(i / 2), side = i % 2 ? 1 : -1;
      var bx = x - a.dir * row * 7 * u, by = y + side * row * 4 * u;
      var flap = Math.sin(ts * 0.012 + i * 1.7) * 2.2 * u, w = 3.2 * u;
      ctx.moveTo(bx - w, by - flap); ctx.quadraticCurveTo(bx - w / 2, by - flap / 2 - u, bx, by);
      ctx.quadraticCurveTo(bx + w / 2, by - flap / 2 - u, bx + w, by - flap);
    }
    ctx.stroke();
    s.bodies.push({ type: 'birds', x: x / dpr, y: y / dpr, r: 14 });
  } else if (a.type === 'meteor') {
    var hx = _skyX(s, a.az0 + (a.az1 - a.az0) * Math.max(0, p - 0.45)), hy = _skyY(s, a.alt0 + (a.alt1 - a.alt0) * Math.max(0, p - 0.45));
    var fade = p < 0.8 ? 1 : (1 - p) / 0.2;
    var mg = ctx.createLinearGradient(hx, hy, x, y);
    mg.addColorStop(0, 'rgba(220,235,255,0)'); mg.addColorStop(1, 'rgba(240,248,255,' + (0.9 * fade).toFixed(3) + ')');
    ctx.strokeStyle = mg; ctx.lineWidth = 1.3 * dpr;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(x, y); ctx.stroke();
    s.bodies.push({ type: 'meteor', x0: hx / dpr, y0: hy / dpr, x1: x / dpr, y1: y / dpr });
  }
}
function _skyPaintActors(ctx, s, ts) {
  var keep = [];
  for (var i = 0; i < s.actors.length; i++) {
    var a = s.actors[i];
    if (ts - a.start > a.dur) { if (a.type === 'meteor') s.lastMeteor = a; continue; }
    keep.push(a);
    if (a.type !== 'whale') _skyPaintActor(ctx, s, a, ts);
  }
  s.actors = keep;
  // The ISS, on the page's clock (live: now, this frame).
  var iss = _skyIss(s, _skyLive() ? Date.now() : s.nowTime);
  s.issUp = !!iss && _skyLive();
  if (iss && s.eph.sunGeoAlt < SKY_CIVIL_ALT + 2) {
    var x = _skyX(s, iss.az);
    if (_skyInView(s, x, 4)) {
      var y = _skyY(s, iss.alt);
      var near = _skyClamp((iss.alt - SKY_ISS_MIN_ALT) / SKY_ISS_BRIGHT_SPAN_DEG, 0, 1);   // about +1 magnitude at 8 degrees, -4 overhead
      _skyLight(ctx, x, y, _skyLerp(SKY_ISS_R[0], SKY_ISS_R[1], near) * s.dpr, [255, 246, 222], _skyLerp(SKY_ISS_A[0], SKY_ISS_A[1], near));
      s.bodies.push({ type: 'iss', x: x / s.dpr, y: y / s.dpr, r: 3, alt: iss.alt, az: iss.az, km: iss.km });
    }
  }
}
// Spawning: each timer adds one and sets the next; nothing while unseen.
function _skySpawnPlane() { _skySpawn('plane'); }
function _skySpawnBirds() { _skySpawn('birds'); }
function _skySpawnWhale() { _skySpawn('whale'); }
// Meteors are a Poisson process at the rate the sky shows now. The wait is
// drawn afresh each time (the process has no memory), and one longer than a
// look is cut into looks, since the light and the date move the rate: a
// meteor falls only when a wait ran out whole.
function _skyScheduleMeteor(s) {
  var rate = _skyMeteorRate(s).perHour, wait = -Math.log(Math.max(1e-6, _skyRand())) * 3600000 / Math.max(rate, 1e-6);
  _skyTimers.meteor = setTimeout(wait <= SKY_METEOR_RECHECK_MS ? _skySpawnMeteor : _skyRecheckMeteor, Math.max(400, Math.min(wait, SKY_METEOR_RECHECK_MS)));
}
function _skyRecheckMeteor() {
  var s = _skyState;
  _skyTimers.meteor = 0;
  if (_skyAwake(s) && !_skyReduceMotion() && s.eph) _skyScheduleMeteor(s);
}
function _skySpawnMeteor() {
  var s = _skyState;
  _skyTimers.meteor = 0;
  if (!_skyAwake(s) || _skyReduceMotion() || !s.eph) return;
  // Which kind falls: each shower in its share of the rate, else a sporadic one.
  var rate = _skyMeteorRate(s), at = _skyRand() * rate.perHour, part = rate.parts[0];
  for (var i = 0; i < rate.parts.length && at >= 0; i++) { part = rate.parts[i]; at -= part.perHour; }
  s.actors.push(_skyMeteor(s, part));
  _skyKick();
  _skyScheduleMeteor(s);
}
var SKY_SPAWNERS = { plane: _skySpawnPlane, birds: _skySpawnBirds, meteor: _skySpawnMeteor, whale: _skySpawnWhale };
function _skySpawn(kind) {
  var s = _skyState;
  _skyTimers[kind] = 0;
  if (!_skyAwake(s) || _skyReduceMotion() || !s.eph) return;
  var g = s.eph.sunGeoAlt, gap;
  if (kind === 'plane') {
    s.actors.push(_skyPlane(s, !s.planeSpawned));
    s.planeSpawned = true;
    gap = _skyRandIn(_skyRand, SKY_PLANE_GAP_S) * 1000;
  } else if (kind === 'birds') {
    if (g > 2) { var b = _skyCrossing(s, 'birds', SKY_BIRD_S, SKY_BIRD_ALT); b.n = 3 + Math.floor(_skyRand() * 5); s.actors.push(b); }
    gap = _skyRandIn(_skyRand, SKY_BIRD_GAP_S) * 1000;
  } else {
    if (g > 0) s.actors.push(_skyWhale(s));
    gap = _skyRandIn(_skyRand, SKY_WHALE_GAP_S) * 1000;
  }
  _skyKick();
  _skyTimers[kind] = setTimeout(SKY_SPAWNERS[kind], Math.max(400, gap));
}

// ══ Painting and the clock ═══════════════════════════════════════════════

// The sky's own light, from the GPU when there is one (almanac-skygl.js):
// the canvas it drew, or null (the Canvas 2D sky then paints it). A GPU that
// fails mid-way is dropped for good and the view falls back to the panorama.
function _skyKickDirty() {
  var s = _skyState;
  if (s) { s.baseDirty = true; _skyKick(); if (s.eph) _skyFacts(s); }   // the facts carry the Milky Way's credit once the panorama is in
  if (_skyHost) _skyHostDraw();
}
function _skyGLParams(s) {
  var e = s.eph, md = s.moonData, M = _sgHorizonMatrix(e.P, e.lst, s.lat);
  var eps = SKY_OBLIQUITY_J2000_DEG * DEG_TO_RAD, pole = [Math.sin(eps) * -1, Math.cos(eps)];
  var up = [0, 1, 2].map(function (i) { return M[3 * i + 1] * pole[0] + M[3 * i + 2] * pole[1]; });
  return { W: s.W, H: s.H, dpr: s.dpr, view: _skyGLView(s), sunAltGeo: e.sunGeoAlt, sunAz: e.sun.az,
    moonAlt: e.moon.altitude, moonAz: e.moon.azimuth, moonIllum: md.phase.illumination, moonDist: _moonDistance(s.now),
    horizon: M, eclPole: up, sunVec: _skyEnu(e.sun.az, e.sunGeoAlt), dial: _skySetting('dial'),
    seed: s.twinkle, scint: !_skyReduceMotion(), lm: s.lm, sunShare: s.sunShare, moonShare: s.moonShare, moonDisc: s.moonDisc };
}
function _skyGLSky(s) {
  if (!_sgInit() || !_sgReady()) return null;   // not started, or still compiling: the Canvas 2D sky this time, the GPU's when it is ready
  try {
    _sgLoadData(_skyKickDirty);
    return _sgDraw(_skyGLParams(s));
  } catch (err) {
    _sgDisable();
    _skyApplyView(s);
    return null;
  }
}
// Where the Moon's disc stands on the canvas (it hides what is behind it), or null.
function _skyMoonDisc(s) {
  var pos = s.moonData.pos;
  if (pos.altitude < -2) return null;
  var pt = _skyScreen(s, pos.azimuth, pos.altitude), R = _skyBodyRadius(s, _skyMoonSemi(s.now, pos.altitude));
  return { x: pt.x, y: pt.y, r: R };
}
function _skyUnderMoon(s, x, y) { var m = s.moonDisc; return !!m && (x - m.x) * (x - m.x) + (y - m.y) * (y - m.y) < m.r * m.r; }

// ══ The sphere under you (the phone's Look view only) ══
// Pointing the phone down shows what is below the horizon: the stars, planets, Sun and Moon that the Earth is
// in the way of, in the places they are. The ground is drawn as dim glass over them, so it reads as under your feet.
// The page's sky and the star chart show the sky above the horizon, as they always have.
var SKY_BELOW_MAG = 4.6;                           // the faintest star drawn under the horizon
var SKY_BELOW_INK = '170,190,230';                 // the cool ink of what is under the horizon: its names
var SKY_BELOW_VEIL = [22, 32, 58];                 // the glass over the ground
var SKY_BELOW_VEIL_ALPHA = [0.34, 0.6];            // its density at the horizon and straight down
var SKY_BELOW_VEIL_RAMP_DEG = 1.5;                 // it comes in over this many degrees below the horizon
var SKY_BELOW_VEIL_STEP_PX = 5;                    // CSS px per sample of the glass (it is smooth)
var SKY_BELOW_BODY_ALPHA = 0.82;                   // what is seen through the ground is a little dimmer
var SKY_BELOW_SUN_MIN_DEG = 2;                     // the Sun and Moon this far under are drawn here (nearer, the sky's painters have them)
// What is under the horizon at the instant: the catalogue's stars by the ephemeris's own rotation (P, lst), the
// planets, the Sun and the Moon. Kept until the instant or the place changes; a turn of the view does not touch it.
function _skyBelowBodies(s) {
  var key = s.nowTime + '|' + s.lat + '|' + s.lon;
  if (s.belowKey === key) return s.below;
  var e = s.eph, sinLat = Math.sin(s.lat * DEG_TO_RAD), cosLat = Math.cos(s.lat * DEG_TO_RAD), out = { stars: [], planets: [] }, cat = _skyCatalogue();
  for (var j = 0; j < cat.length; j++) {
    if (cat[j].mag > SKY_BELOW_MAG) continue;
    var rd = _skyRaDec(_skyMul(e.P, cat[j].v)), h = _skyHorizontal(rd.ra, rd.dec, e.lst, sinLat, cosLat);
    if (h.alt < 0) out.stars.push({ alt: h.alt, az: h.az, mag: cat[j].mag, tint: cat[j].tint, idx: cat[j].idx });
  }
  for (var i = 0; i < e.planets.length; i++) if (e.planets[i].alt < 0) out.planets.push(e.planets[i]);
  out.sun = e.sunGeoAlt < -SKY_BELOW_SUN_MIN_DEG ? { alt: e.sunGeoAlt, az: e.sun.az } : null;
  var mp = e.moon;
  out.moon = mp.altitude < -SKY_BELOW_SUN_MIN_DEG ? { alt: mp.altitude, az: mp.azimuth } : null;
  s.belowKey = key; s.below = out;
  return out;
}
// The glass over the ground: a low-resolution picture of its density by direction (denser the further down), drawn
// scaled up, so the cost is a few thousand samples however the view is turned.
function _skyPaintBelowVeil(ctx, s) {
  var step = Math.max(1, Math.round(SKY_BELOW_VEIL_STEP_PX * s.dpr)), w = Math.ceil(s.W / step), h = Math.ceil(s.H / step);
  var cv = s.veil || (s.veil = document.createElement('canvas'));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  var vc = cv.getContext('2d'), img = vc.createImageData(w, h), d = img.data, any = false;
  for (var j = 0; j < h; j++) {
    for (var i = 0; i < w; i++) {
      var alt = _skyDirAt(s, i * step + step / 2, j * step + step / 2).alt;
      if (alt >= 0) continue;
      var a = _skyLerp(SKY_BELOW_VEIL_ALPHA[0], SKY_BELOW_VEIL_ALPHA[1], _skyClamp(-alt / 90, 0, 1)) * _skyClamp(-alt / SKY_BELOW_VEIL_RAMP_DEG, 0, 1), k = 4 * (j * w + i);
      d[k] = SKY_BELOW_VEIL[0]; d[k + 1] = SKY_BELOW_VEIL[1]; d[k + 2] = SKY_BELOW_VEIL[2]; d[k + 3] = Math.round(255 * a);
      any = true;
    }
  }
  if (!any) return;
  vc.putImageData(img, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(cv, 0, 0, s.W, s.H);
  ctx.restore();
}
// The glass, then what is under it, each marked under:true so its name is written in the cool ink.
function _skyPaintBelowLens(ctx, s) {
  _skyPaintBelowVeil(ctx, s);
  var b = _skyBelowBodies(s), dpr = s.dpr, fade = SKY_BELOW_BODY_ALPHA;
  ctx.save();
  for (var j = 0; j < b.stars.length; j++) {
    var st = b.stars[j], p = _skyScreen(s, st.az, st.alt, 4);
    if (!p.visible) continue;
    var look = _skyStarLook(st.mag), r = _skyStarDevR(look.r, dpr);
    if (look.bloom) _skyStarBloom(ctx, p.x, p.y, r, st.tint, fade);
    ctx.fillStyle = 'rgba(' + st.tint + ',' + (fade * look.k).toFixed(3) + ')';
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    if (st.idx >= 0 && _STAR_NAMES[st.idx]) s.bodies.push({ type: 'star', idx: st.idx, x: p.x / dpr, y: p.y / dpr, r: r / dpr, alt: st.alt, az: st.az, mag: st.mag, under: true });
  }
  for (var k = 0; k < b.planets.length; k++) {
    var pl = b.planets[k], pt = _skyScreen(s, pl.az, pl.alt, 6 * dpr);
    if (!pt.visible) continue;
    var pr = _skyStarDevR(_skyStarLook(pl.mag).r * SKY_PLANET_R_X, dpr);
    ctx.fillStyle = _hexToRgba(_PLANETS[pl.name].glow, fade);
    ctx.beginPath(); ctx.arc(pt.x, pt.y, pr, 0, Math.PI * 2); ctx.fill();
    s.bodies.push({ type: 'planet', name: pl.name, x: pt.x / dpr, y: pt.y / dpr, r: pr / dpr, alt: pl.alt, az: pl.az, mag: pl.mag, phase: pl.phase, under: true });
  }
  if (b.moon) {
    var mp = _skyScreen(s, b.moon.az, b.moon.alt, 12 * dpr);
    if (mp.visible) {
      var mr = _skyBodyRadius(s, _skyMoonSemi(s.now, b.moon.alt)), sp = _skyScreen(s, s.eph.sun.az, s.eph.sunGeoAlt);
      _skyDrawPhase(ctx, mp.x, mp.y, mr, s.moonData.phase.illumination / 100, Math.atan2(sp.y - mp.y, sp.x - mp.x), '#dcd8c8', fade);
      s.bodies.push({ type: 'moon', x: mp.x / dpr, y: mp.y / dpr, r: mr / dpr, alt: b.moon.alt, az: b.moon.az, under: true });
    }
  }
  if (b.sun) {
    var sn = _skyScreen(s, b.sun.az, b.sun.alt, 12 * dpr);
    if (sn.visible) {
      var sr = _skyBodyRadius(s, SKY_SUN_SEMI_DEG);
      ctx.fillStyle = 'rgba(255,205,130,' + fade + ')'; ctx.beginPath(); ctx.arc(sn.x, sn.y, sr, 0, Math.PI * 2); ctx.fill();
      s.bodies.push({ type: 'sun', x: sn.x / dpr, y: sn.y / dpr, r: sr / dpr, alt: b.sun.alt, az: b.sun.az, under: true });
    }
  }
  ctx.restore();
}

// What stands on the horizon: the beach (its sea, boats, palms), or the true
// horizon, a line with the compass's ticks and its letters.
var SKY_TICK_PX = [3, 5, 8], SKY_TICK_DEG = [5, 15, 45];   // tick length (CSS px) at each step of bearing
var SKY_HORIZON_LINE = 'rgba(190,205,230,0.22)';
var SKY_HOSTED_POINT_PX = 15;          // the points of the compass in the look-around view, CSS px
function _skyPaintHorizon(ctx, s, gpu) {
  var dpr = s.dpr, e = s.eph, light = _skyDaylight(e.sunGeoAlt);
  if (!gpu && !s.lens) {   // without the GPU the ground is a plain shade of the horizon's colour
    var yh = s.H * SKY_HORIZON_Y, hor = _skyMix(_skyTone(e.sunGeoAlt).hor, [4, 5, 8], 0.72);
    var g = ctx.createLinearGradient(0, yh, 0, s.H);
    g.addColorStop(0, _skyRgb(hor)); g.addColorStop(1, _skyRgb(_skyMix(hor, [0, 0, 0], 0.5)));
    ctx.fillStyle = g;
    ctx.fillRect(0, yh, s.W, s.H - yh);
  }
  // The horizon: a line through every bearing, broken where it leaves the view.
  ctx.save();
  ctx.strokeStyle = SKY_HORIZON_LINE; ctx.lineWidth = Math.max(1, 0.8 * dpr);
  ctx.beginPath();
  var prev = null;
  for (var az = 0; az <= 360; az += 2) {
    var p = _skyScreen(s, az, 0, s.W);
    if (prev && p.visible && prev.visible && Math.abs(p.x - prev.x) < s.W / 2) { ctx.moveTo(prev.x, prev.y); ctx.lineTo(p.x, p.y); }
    prev = p;
  }
  ctx.stroke();
  // Ticks every 5 degrees, longer at 15 and 45; the letters under the points of the compass.
  ctx.strokeStyle = 'rgba(190,205,230,0.32)';
  // The look-around view is held at arm's length: its letters are the size of the other labels, and brighter.
  ctx.font = '600 ' + Math.round((s.hosted ? SKY_HOSTED_POINT_PX : 10) * dpr) + 'px ' + SKY_FONT;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillStyle = s.hosted ? 'rgba(235,240,250,0.92)' : light > 0.5 ? 'rgba(235,240,250,0.8)' : 'rgba(210,220,240,0.62)';
  ctx.beginPath();
  for (az = 0; az < 360; az += SKY_TICK_DEG[0]) {
    var q = _skyScreen(s, az, 0, 2 * dpr);
    if (!q.visible) continue;
    var step = az % SKY_TICK_DEG[2] === 0 ? 2 : az % SKY_TICK_DEG[1] === 0 ? 1 : 0, len = SKY_TICK_PX[step] * dpr;
    ctx.moveTo(q.x, q.y); ctx.lineTo(q.x, q.y + len);
    if (step === 2) ctx.fillText(_azCompass(az), q.x, q.y + len + 2 * dpr);
  }
  ctx.stroke();
  _skyPaintBelow(ctx, s);
  ctx.restore();
}
// A small mark under the horizon at the bearing of the Sun and of the Moon while they are below it: where they will rise, or set.
function _skyPaintBelow(ctx, s) {
  var e = s.eph, dpr = s.dpr, marks = [[e.sun.az, e.sun.alt, '255,205,130'], [e.moon.azimuth, e.moon.altitude, '225,232,246']];
  for (var i = 0; i < marks.length; i++) {
    if (marks[i][1] >= 0) continue;
    var q = _skyScreen(s, marks[i][0], 0, 6 * dpr);
    if (!q.visible) continue;
    var y = q.y + 22 * dpr, w = 5 * dpr;
    ctx.fillStyle = 'rgba(' + marks[i][2] + ',0.85)';
    ctx.beginPath(); ctx.moveTo(q.x, y - w); ctx.lineTo(q.x + w, y + w * 0.6); ctx.lineTo(q.x - w, y + w * 0.6); ctx.closePath(); ctx.fill();
  }
}
// The sky without the GPU, through a lens: the Sun's tone by its altitude, the horizon's glow toward the Sun, the ground dark below.
var SKY_LENS_FALLBACK_STEP = 6;   // device px per sample
function _skyPaintSkyLens(ctx, s) {
  var step = SKY_LENS_FALLBACK_STEP, w = Math.ceil(s.W / step), h = Math.ceil(s.H / step), e = s.eph, g = e.sunGeoAlt;
  var tone = _skyTone(g), sunV = _skyEnu(e.sun.az, g), glow = _skyClamp(1 - Math.abs(g + 1) / 13, 0, 1);
  var warm = g > 2 ? [255, 236, 200] : _skyMix([214, 92, 84], [255, 160, 90], _skyClamp((g + 8) / 10, 0, 1));
  var img = ctx.createImageData(w, h), d = img.data;
  for (var j = 0; j < h; j++) {
    for (var i = 0; i < w; i++) {
      var dir = _skyDirAt(s, i * step + step / 2, j * step + step / 2), c;
      if (dir.alt >= 0) {
        c = _skyMix(tone.hor, tone.zen, Math.sqrt(_skyClamp(dir.alt / 90, 0, 1)));
        var cos = Math.max(0, _skyDot3(_skyEnu(dir.az, dir.alt), sunV));
        c = _skyMix(c, warm, 0.55 * glow * Math.pow(cos, 6) * (1 - dir.alt / 120));
      } else c = _skyMix(_skyMix(tone.hor, [3, 4, 6], 0.8), [0, 0, 0], _skyClamp(-dir.alt / 60, 0, 0.5));
      var k = 4 * (j * w + i);
      d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2]; d[k + 3] = 255;
    }
  }
  var tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmp, 0, 0, s.W, s.H);
}
// Deep red on black: every colour reduced to its brightness, then to red.
var SKY_RED = 'rgb(255,18,8)', SKY_RED_LIFT = '#808080';
function _skyRedWash(ctx, s) {
  ctx.save();
  ctx.globalCompositeOperation = 'saturation'; ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, s.W, s.H);
  // With the Sun down, twice the light before it is made red: a dim star in red is no brighter than the sky
  // round it otherwise. (By day the sky is bright enough already; doubled it would be a red wall.)
  if (s.eph && s.eph.sunGeoAlt < 0) { ctx.globalCompositeOperation = 'color-dodge'; ctx.fillStyle = SKY_RED_LIFT; ctx.fillRect(0, 0, s.W, s.H); }
  ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = SKY_RED; ctx.fillRect(0, 0, s.W, s.H);
  ctx.restore();
}

// The still picture (sky, stars, bodies, aurora, ground and boats) is
// painted into its own canvas when something in it changes: the instant, the
// view turned, the Moon gliding. A frame is that picture and
// the moving things over it, so a plane crossing costs one copy and a few
// strokes, not a whole sky (a few thousand canvas calls, ~2-4 ms on a
// 4x-slowed phone).
function _skyPaintBase(s, ts) {
  if (!s.base) s.base = document.createElement('canvas');
  if (s.base.width !== s.W || s.base.height !== s.H) { s.base.width = s.W; s.base.height = s.H; }
  var ctx = s.base.getContext('2d'), e = s.eph;
  s.bodies = [];
  _skyApplyView(s);
  s.moonDisc = _skyMoonDisc(s);
  var gl = _skyGLSky(s), M = _sgHorizonMatrix(e.P, e.lst, s.lat), beach = _skySetting('skin') === 'beach' && !s.lens;
  if (gl) ctx.drawImage(gl, 0, 0); else if (s.lens) _skyPaintSkyLens(ctx, s); else _skyPaintSky(ctx, s);
  if (beach) _skyCaptureLight(s, ctx.canvas);   // the sea mirrors the sky as drawn, before the stars and bodies go on it
  _skyPaintAurora(ctx, s);
  if (_skyFiguresWanted(s)) _skyLoadConstellations(_skyKickDirty);
  _skyEnsureStarData(_skyKickDirty);
  _skyPaintConstellations(ctx, s, M);
  _skyPaintDeepSky(ctx, s, M);
  _skyPaintStars(ctx, s, !!gl);
  if (gl) _skyPaintStarBodies(s, M, ctx);
  _skyPaintPlanets(ctx, s);
  _skyPaintSun(ctx, s);
  _skyPaintMoon(ctx, s, _skyMoonAt(s, ts));
  if (s.hosted) _skyPaintBelowLens(ctx, s);   // the phone's Look: what is under the ground, under glass
  if (beach) _skyPaintGround(ctx, s); else _skyPaintHorizon(ctx, s, !!gl);
  s.baseBodies = s.bodies;
  s.baseDirty = !!s.moonAnim;
  s.paintedTime = s.nowTime;
}
function _skyPaint(ts) {
  var s = _skyState;
  if (!s || !s.eph || !s.canvas.isConnected) return;
  if (s.baseDirty || !s.base || s.moonAnim) _skyPaintBase(s, ts);
  var ctx = s.canvas.getContext('2d'), beach = _skySetting('skin') === 'beach' && !s.lens;
  ctx.clearRect(0, 0, s.W, s.H);
  ctx.drawImage(s.base, 0, 0);
  s.bodies = s.baseBodies.slice();
  if (!s.lens) {
    // The moving things stay in the sky, never over the sea; a whale in the
    // sea; the palms in front of everything.
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, s.W, s.H * SKY_HORIZON_Y); ctx.clip();
    _skyPaintActors(ctx, s, ts);
    ctx.restore();
    if (beach) {
      for (var i = 0; i < s.actors.length; i++) if (s.actors[i].type === 'whale') _skyPaintWhale(ctx, s, s.actors[i], ts);
      _skyPaintPalms(ctx, s, ts);
      _skyPaintCompassFoot(ctx, s);
    }
  }
  if (s.issUp && !_skyTimers.iss) _skyTimers.iss = setTimeout(_skyIssTick, SKY_ISS_MS);
  if (_skyRedOn()) _skyRedWash(ctx, s);
}

// How far the sky has turned since it was painted, in device px: the Earth
// turns 360.9856 degrees a day, and nothing else in a still sky moves faster.
// A live tick that has not moved a pixel paints nothing.
var SKY_ROT_DEG_PER_MS = 360.98564736629 / 86400000, SKY_REPAINT_PX = 1;
function _skyDriftPx(s, ms) {
  if (s.paintedTime == null) return Infinity;
  return Math.abs(ms - s.paintedTime) * SKY_ROT_DEG_PER_MS * _skyPxPerDeg(s);
}

// ── The view ──
// What the sky is pointed at, asked for by ZimiSky.setView (null: the panorama).
var _skyViewReq = null, _skyAspectReq = null;
function _skyApplyView(s) {
  if (s.hosted) return;   // the look-around view keeps its own lens
  var r = _skyViewReq;
  s.lens = null; s.span = SKY_SPAN_DEG; s.center = s.lat >= 0 ? 180 : 0;
  if (!r) return;
  if (_sgReady()) s.lens = _skyMakeLens({ az: r.az, alt: r.alt, fov: _skyClamp(r.fov, SKY_LENS_FOV[0], SKY_LENS_FOV[1]) }, s.W);
  else { s.center = r.az; s.span = _skyClamp(r.fov, SKY_PANO_SPAN[0], SKY_PANO_SPAN[1]); }
}
function _skyViewChanged() {
  var s = _skyState;
  if (!s) return;
  _skyApplyView(s);
  s.baseDirty = true;
  _skyArm();
  _skyCaption(s);
  _skyKick();
}
// ══ The sky as a view of its own (look-around) ═══════════════════════════
// AlmanacSkyView draws the sky edge to edge in a host element, apart from the
// Almanac's own sky card (which keeps working, mounted or not): the same
// painters over a state of its own, always through the lens, over the whole
// sphere, the GPU's when it is ready and the Canvas 2D sky's (the same stars,
// planets, Sun and Moon over a drawn gradient) when it is not, so a host is
// never empty. It runs no timer and no frame loop: it paints when it is
// mounted, resized, turned (one frame for all the turns that arrive before it),
// or when the red switch or the GPU's state moves, and takes the time from the
// page's clock at that moment (the time machine's instant when it is set).
var SKY_HOST_FRESH_MS = 1000;       // a turn within this of the last sums reuses them
var _skyHost = null, _skyHostFrame = 0;
function _skyHostSize(h) {
  var dpr = window.devicePixelRatio || 1, w = Math.max(1, h.host.clientWidth), ht = Math.max(1, h.host.clientHeight);
  h.canvas.width = Math.round(w * dpr); h.canvas.height = Math.round(ht * dpr);
  var s = h.s;
  s.dpr = dpr; s.W = h.canvas.width; s.H = h.canvas.height; s.cssW = w; s.scale = _skyClamp(w / 600, 0.85, 1.15);
}
function _skyHostCompute(s, now) {
  var f = _skyFrame(now, s.lat, s.lon);
  s.now = now; s.nowTime = now.getTime(); s.eph = f.eph; s.moonData = f.moonData;
  _skyBrightness(s);
  s.twinkle++;
}
function _skyHostDraw() {
  var h = _skyHost;
  if (!h || !h.host.isConnected) return;
  var s = h.s, ms = _skyLive() ? Date.now() : _almFocusInstant().getTime();
  if (!s.eph || Math.abs(ms - s.nowTime) > SKY_HOST_FRESH_MS) _skyHostCompute(s, new Date(ms));
  s.lens = _skyMakeLens(h.look, s.W);
  _skyPaintBase(s, performance.now());
  var ctx = h.canvas.getContext('2d');
  ctx.clearRect(0, 0, s.W, s.H);
  ctx.drawImage(s.base, 0, 0);
  _skyHostLabels(ctx, s);
  if (typeof _skyFind !== 'undefined' && _skyFind && typeof _sfPaintMark === 'function') _sfPaintMark(ctx, s);   // what was asked for (almanac-skyfind.js), ringed
  if (_skyRedOn()) _skyRedWash(ctx, s);
}
// Names on what the person is most likely to look for: the Sun, the Moon, the planets and the brightest
// named stars, beside each, inside the screen and clear of one another and of the readout at the top.
var SKY_LABEL_PX = 13, SKY_LABEL_STAR_MAG = 1.8, SKY_LABEL_MAX = 14, SKY_LABEL_TOP_PX = 70, SKY_LABEL_PAD_PX = 8, SKY_LABEL_GAP_PX = 5;
function _skyLabelRank(b) {
  if (b.type === 'sun') return -2;
  if (b.type === 'moon') return -1;
  if (b.type === 'planet') return 0 + (b.mag == null ? 0 : b.mag) / 10;
  if (b.type === 'star' && b.idx >= 0 && _STAR_NAMES[b.idx] && b.mag != null && b.mag <= SKY_LABEL_STAR_MAG) return 2 + b.mag / 10;
  return null;
}
// What a name must never be written over, in device px: every other body drawn (its disc, with a margin; a ring-marked planet
// such as Uranus has no name of its own to hide behind) and the letters and ticks of the compass along the horizon.
var SKY_LABEL_OBSTACLE_PAD_PX = 2, SKY_COMPASS_STEP_DEG = 45, SKY_COMPASS_LINE = 1.25;
function _skyLabelObstacles(s, measure, pad) {
  var dpr = s.dpr, out = [], m = SKY_LABEL_OBSTACLE_PAD_PX * dpr, i;
  for (i = 0; i < s.bodies.length; i++) {
    var b = s.bodies[i];
    if ((b.type !== 'planet' && b.type !== 'moon' && b.type !== 'sun' && b.type !== 'dso' && !(b.type === 'star' && b.idx >= 0)) || !isFinite(b.x) || !isFinite(b.y)) continue;
    var r = (b.r || 3) * dpr + m;
    out.push({ x0: b.x * dpr - r, x1: b.x * dpr + r, y0: b.y * dpr - r, y1: b.y * dpr + r, of: b });
  }
  if (typeof _skyScreen === 'function' && s.eph) {
    for (var az = 0; az < 360; az += SKY_COMPASS_STEP_DEG) {
      var q = _skyScreen(s, az, 0, 2 * dpr);
      if (!q.visible) continue;
      var w = measure(_azCompass(az)) * SKY_HOSTED_POINT_PX / SKY_LABEL_PX + 2 * m, top = q.y + SKY_TICK_PX[2] * dpr;
      out.push({ x0: q.x - w / 2, x1: q.x + w / 2, y0: q.y, y1: top + (2 + SKY_COMPASS_LINE * SKY_HOSTED_POINT_PX) * dpr + m });
    }
  }
  return out;
}
// [{text, x, y, align, box}] for the bodies drawn, in device px; pure but for the names.
function _skyLabelPlan(s, measure) {
  var dpr = s.dpr, pad = SKY_LABEL_PAD_PX * dpr, top = SKY_LABEL_TOP_PX * dpr, ph = SKY_LABEL_PX * dpr * 1.25;
  var cands = [], out = [], taken = _skyLabelObstacles(s, measure, pad), i;
  for (i = 0; i < s.bodies.length; i++) {
    var rk = _skyLabelRank(s.bodies[i]);
    if (rk !== null) cands.push({ b: s.bodies[i], rank: rk });
  }
  cands.sort(function (a, b) { return a.rank - b.rank; });
  for (i = 0; i < cands.length && out.length < SKY_LABEL_MAX; i++) {
    var b = cands[i].b, text = _skyBodyName(b), w = measure(text), cx = b.x * dpr, cy = b.y * dpr, gap = (b.r || 3) * dpr + SKY_LABEL_GAP_PX * dpr;
    if (cy < top || cy > s.H - pad) continue;
    var rtl = document.documentElement.dir === 'rtl', sides = rtl ? [-1, 1] : [1, -1], put = null;
    for (var k = 0; k < 2 && !put; k++) {
      var x0 = sides[k] > 0 ? cx + gap : cx - gap - w, box = { x0: x0, x1: x0 + w, y0: cy - ph / 2, y1: cy + ph / 2 };
      if (box.x0 < pad || box.x1 > s.W - pad) continue;
      if (taken.some(function (t) { return t.of !== b && box.x0 < t.x1 && box.x1 > t.x0 && box.y0 < t.y1 && box.y1 > t.y0; })) continue;
      put = { text: text, x: box.x0, y: cy, box: box, under: !!b.under };
    }
    if (put) { out.push(put); taken.push(put.box); }
  }
  return out;
}
function _skyHostLabels(ctx, s) {
  ctx.save();
  ctx.font = '600 ' + Math.round(SKY_LABEL_PX * s.dpr) + 'px ' + SKY_FONT;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  var plan = _skyLabelPlan(s, function (text) { return ctx.measureText(text).width; });
  ctx.lineJoin = 'round'; ctx.lineWidth = 3 * s.dpr; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.fillStyle = 'rgba(240,244,252,0.92)';
  for (var i = 0; i < plan.length; i++) {
    ctx.fillStyle = plan[i].under ? 'rgba(' + SKY_BELOW_INK + ',0.92)' : 'rgba(240,244,252,0.92)';
    ctx.strokeText(plan[i].text, plan[i].x, plan[i].y); ctx.fillText(plan[i].text, plan[i].x, plan[i].y);
  }
  ctx.restore();
}
// One frame for however many turns arrive before it.
function _skyHostSchedule() {
  if (_skyHostFrame || !_skyHost) return;
  _skyHostFrame = requestAnimationFrame(function () { _skyHostFrame = 0; _skyHostDraw(); });
}
function _skyHostRedraw() { _skyHostDraw(); }
function _skyHostSeen() { if (!document.hidden) _skyHostDraw(); }
function _skyHostOf(host) { return _skyHost && _skyHost.host === host ? _skyHost : null; }
var AlmanacSkyView = {
  mount: function (host, place) {
    if (!host || !place || !isFinite(place.lat) || !isFinite(place.lon)) return false;
    AlmanacSkyView.unmount(_skyHost && _skyHost.host);
    _sgInit();   // the GPU's sky comes when it is compiled; until then the Canvas 2D sky draws, and the host is painted again
    var canvas = document.createElement('canvas');
    canvas.className = 'alm-sky-host';
    canvas.setAttribute('data-red', '');
    canvas.setAttribute('role', 'img');
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
    host.appendChild(canvas);
    var s = { hosted: true, lat: place.lat, lon: place.lon, center: place.lat >= 0 ? 180 : 0, span: SKY_SPAN_DEG, lens: null, stored: true, known: true,
      moonAnim: null, twinkle: 0, bodies: [], baseBodies: [], actors: [], sea: null, aurora: null, base: null, baseDirty: true };
    _skyHost = { host: host, canvas: canvas, s: s, look: { az: place.lat >= 0 ? 180 : 0, alt: 30, fov: 90 } };
    _skyHostSize(_skyHost);
    _skyWatchNight();
    document.addEventListener('zimisky:red', _skyHostRedraw);
    document.addEventListener('visibilitychange', _skyHostSeen);
    _skyHostDraw();
    return true;
  },
  // az clockwise from north, alt up from the horizon, fov the angle across the width, all degrees (fov is held to the lens's range).
  setView: function (host, az, alt, fov) {
    var h = _skyHostOf(host);
    if (!h || !isFinite(az) || !isFinite(alt) || !isFinite(fov)) return;
    h.look = { az: ((az % 360) + 360) % 360, alt: _skyClamp(alt, -90, 90), fov: _skyClamp(fov, SKY_LENS_FOV[0], SKY_LENS_FOV[1]) };
    _skyHostSchedule();
  },
  // Paint again as it is (a mark was put on it or taken off).
  redraw: function (host) { if (_skyHostOf(host)) _skyHostSchedule(); },
  // The direction under a screen point, or null; and where a direction falls, in CSS px on the host's canvas.
  pointAt: function (host, clientX, clientY) {
    var h = _skyHostOf(host);
    if (!h) return null;
    var r = h.canvas.getBoundingClientRect();
    if (!r.width || clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
    return _skyDirAt(h.s, (clientX - r.left) * h.s.W / r.width, (clientY - r.top) * h.s.H / r.height);
  },
  screenOf: function (host, az, alt) {
    var h = _skyHostOf(host);
    if (!h) return { x: 0, y: 0, visible: false };
    var p = _skyScreen(h.s, az, alt);
    return { x: p.x / h.s.dpr, y: p.y / h.s.dpr, visible: p.visible };
  },
  unmount: function (host) {
    var h = _skyHost;
    if (!h || (host && h.host !== host)) return;
    document.removeEventListener('zimisky:red', _skyHostRedraw);
    document.removeEventListener('visibilitychange', _skyHostSeen);
    if (_skyHostFrame) { cancelAnimationFrame(_skyHostFrame); _skyHostFrame = 0; }
    if (h.canvas.parentNode) h.canvas.parentNode.removeChild(h.canvas);
    _skyHost = null;
    if (_skyState) _skyResume();   // the card, uncovered, paints again
  },
  resize: function (host, place) {
    var h = _skyHostOf(host);
    if (!h) return;
    if (place) { h.s.lat = place.lat; h.s.lon = place.lon; h.s.eph = null; }
    _skyHostSize(h);
    h.s.baseDirty = true;
    _skyHostDraw();
  },
  // The credit the panorama is owed while the GPU sky draws it ('alm_sky_credit').
  credit: function () { return _sgReady() ? t('alm_sky_credit') : ''; }
};
window.AlmanacSkyView = AlmanacSkyView;

var ZimiSky = {
  setView: function (v) {
    if (!v || !isFinite(v.az) || !isFinite(v.fov)) return;
    _skyViewReq = { az: ((v.az % 360) + 360) % 360, alt: _skyClamp(isFinite(v.alt) ? v.alt : 0, -90, 90), fov: _skyClamp(v.fov, SKY_LENS_FOV[0], SKY_PANO_SPAN[1]) };
    _sgInit();
    _skyViewChanged();
  },
  getView: function () {
    var s = _skyState;
    if (s && s.lens) return { az: s.lens.az, alt: s.lens.alt, fov: s.lens.fov, mode: 'lens' };
    return { az: s ? s.center : 180, alt: 0, fov: s ? s.span : SKY_SPAN_DEG, mode: 'pano' };
  },
  resetView: function () { _skyViewReq = null; _skyViewChanged(); },
  pointAt: function (clientX, clientY) {
    var s = _skyState;
    if (!s) return null;
    var r = s.canvas.getBoundingClientRect();
    if (!r.width || clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
    return _skyDirAt(s, (clientX - r.left) * s.W / r.width, (clientY - r.top) * s.H / r.height);
  },
  screenOf: function (az, alt) {
    var s = _skyState;
    if (!s) return { x: 0, y: 0, visible: false };
    var p = _skyScreen(s, az, alt);
    return { x: p.x / s.dpr, y: p.y / s.dpr, visible: p.visible };
  },
  setAspect: function (a) { _skyAspectReq = a > 0 ? a : null; var s = _skyState; if (s) _initSkyScene(s.now, s.lat, s.lon, false); },
  redMode: _skyRedOn,
  setRedMode: function (on) { _skySetRed(!!on); },
  supportsLens: function () { return _sgReady(); }
};

function _skyReduceMotion() { return typeof _almReduceMotion === 'function' && _almReduceMotion(); }
function _skyLive() { return typeof _almFocus === 'undefined' || !_almFocus; }
function _skyCovered() { return (typeof _aeIsOpen !== 'undefined' && _aeIsOpen) || !!(_skyHost && _skyHost.host.isConnected); }
function _skyAwake(s) { return s && s.inView && !document.hidden && !_skyCovered(); }

// Something is moving: the Moon's glide, the hero's sweep.
function _skyAnimating(s, ts) {
  if (s.moonAnim) return true;
  return typeof _heroMoonAnim !== 'undefined' && !!_heroMoonAnim;
}
// A plane, birds or a meteor on screen (the beach scene's): frames at SKY_ACTOR_FRAME_MS, by timer.
function _skyActorsMoving(s) { return s.actors.length > 0; }
function _skyLoop(ts) {
  _almanacSkyRAF = null;
  var s = _skyState;
  if (!s) return;
  if (s.pending) { _skyCompute(s, s.pending); _skyArm(); }
  // A live sky is never drawn at an old instant, whichever way the frame
  // came (Eric's phone showed night at 10:41 until a reload: the timer that
  // keeps it current had stopped while the app slept, and nothing else
  // caught it up).
  else if (_skyStale(s)) _skyCompute(s, new Date());
  // With only the moving things moving, every other frame is enough.
  var onlyActors = !_skyAnimating(s, ts) && !s.baseDirty;
  // A sky the page has just been repainted for (a jump of the clock, a resize) is drawn once whatever the
  // observer last said: its word can be stale (it speaks only on crossing the screen's edge, and a
  // measurement made while the page was laid out otherwise overwrites it), and a picture left at the old
  // instant until the next scroll is a wrong one. Measured then, so a sky that is in view wakes properly.
  if (s.forcePaint && !document.hidden && !_skyCovered()) {
    s.forcePaint = false;
    if (!s.inView && _skyMeasureInView(s)) { s.inView = true; _skyArm(); }
    else if (!s.inView) _skyPaint(ts);
  }
  if (_skyAwake(s) && !(onlyActors && ts - (s.paintedAt || 0) < SKY_ACTOR_FRAME_MS)) { _skyPaint(ts); s.paintedAt = ts; s.paints = (s.paints || 0) + 1; }
  // The hero's time-travel sweep rides this same loop (almanac.js).
  if (typeof _heroMoonTick === 'function') _heroMoonTick(ts);
  if (_skyAnimating(s, ts)) { _almanacSkyRAF = requestAnimationFrame(_skyLoop); return; }
  // Only the moving things move: the next frame is asked for at their own
  // pace, not by a vsync loop that wakes the page sixty times a second for
  // thirty paints (a phone under load fell to a frame in three).
  if (_skyAwake(s) && _skyActorsMoving(s) && !_skyTimers.actor) _skyTimers.actor = setTimeout(_skyActorTick, SKY_ACTOR_FRAME_MS);
}
function _skyActorTick() { _skyTimers.actor = 0; _skyKick(); }
// Ask for a frame (one, or a run while something moves); never a second loop.
function _skyKick() {
  if (!_almanacSkyRAF && _skyState) _almanacSkyRAF = requestAnimationFrame(_skyLoop);
}

var _skyTimers = { live: 0, iss: 0, sway: 0, sats: 0, actor: 0, plane: 0, birds: 0, meteor: 0, whale: 0 };
var SKY_ISS_MS = 500;               // the ISS crosses the sky in minutes: a frame twice a second keeps it moving
// The first of each after the sky is seen again (opening, coming back to the app).
// A plane is likely already crossing (it is seen part-way along its track); a meteor's wait is its rate's.
var SKY_FIRST_SPAWN_MS = { plane: 25000, birds: 30000, whale: 60000 };
function _skyDisarm() {
  for (var k in _skyTimers) { clearTimeout(_skyTimers[k]); _skyTimers[k] = 0; }
}
// The timers a still sky needs while it is seen: live, the clock's drift
// (which paints only once the sky has turned a pixel); on the beach scene,
// unless motion is reduced, the palms' breeze and the moving things.
function _skyArm() {
  _skyDisarm();
  _skyAttentionAt = performance.now();   // opened, resumed, or set to a new picture: it is being looked at
  var s = _skyState;
  if (!_skyAwake(s) || !s.eph) return;
  if (_skyLive()) _skyTimers.live = setTimeout(_skyLiveTick, SKY_LIVE_MS);
  if (_skyReduceMotion() || s.lens || _skySetting('skin') !== 'beach') return;
  _skyTimers.sway = setTimeout(_skySwayTick, SKY_SWAY_MS);
  Object.keys(SKY_FIRST_SPAWN_MS).forEach(function (kind) {
    _skyTimers[kind] = setTimeout(SKY_SPAWNERS[kind], SKY_FIRST_SPAWN_MS[kind] * (0.6 + 0.8 * Math.random()));
  });
  _skyScheduleMeteor(s);
  _skyPollSats(0);
}
function _skyLiveTick() {
  _skyTimers.live = 0;
  var s = _skyState;
  if (!_skyAwake(s) || !_skyLive()) return;
  _skyCompute(s, new Date(), true);
  if (s.baseDirty) _skyKick();
  else if (_skySetting('skin') === 'beach') _skyIssWatch(s);
  _skyTimers.live = setTimeout(_skyLiveTick, SKY_LIVE_MS);
}
// The ISS needs the satellite elements the 3D view keeps. The beach asks for
// them once (from Zimi's own server: what it may fetch fresher is that
// server's setting, Ask first unless the owner chose otherwise) and looks at
// every live tick whether a pass has begun or ended, since a pass is minutes.
function _skyIssWatch(s) {
  if (typeof _ae === 'undefined' || !_ae || typeof _aeLoadSats !== 'function') return;
  if (!_ae.sats && !_ae.satsLoading && !_ae.satsFailed) _aeLoadSats();
  if (_ae.sats && _skyLive() && !!_skyIss(s, Date.now()) !== !!s.issUp) _skyKick();
}
// The 3D view (which makes `_ae`) is prepared when the page is idle, and its
// elements take a moment to arrive: look every second until they are in (or
// have failed, or it has been a minute), then draw once more.
var SKY_SATS_POLL_MS = 1000, SKY_SATS_POLL_TRIES = 60, _skySatsTries = 0;
function _skyPollSats(tries) {
  _skySatsTries = tries;
  _skyPollSatsTick();
}
function _skyPollSatsTick() {
  var s = _skyState;
  _skyTimers.sats = 0;
  if (!s || !_skyAwake(s) || _skySetting('skin') !== 'beach') return;
  var ae = typeof _ae !== 'undefined' ? _ae : null;
  if (ae && ae.sats) { _skyKick(); return; }
  if (ae && ae.satsFailed) return;
  if (++_skySatsTries > SKY_SATS_POLL_TRIES) return;
  _skyIssWatch(s);
  _skyTimers.sats = setTimeout(_skyPollSatsTick, SKY_SATS_POLL_MS);
}
// The breeze: a frame (the still picture copied, the palms over it) twelve
// times a second while the beach is seen, and for as long after the last touch, scroll or key as it is likely
// being looked at: a page left open on its own settles into the still picture (nothing in it changes but the
// stars' slow drift, which the live tick paints when it has moved a pixel) and the breeze picks up at the next touch.
var SKY_BREEZE_IDLE_MS = 45000;
var _skyAttentionAt = (typeof performance !== 'undefined' ? performance.now() : 0);
function _skyBreezeParked() { return performance.now() - _skyAttentionAt > SKY_BREEZE_IDLE_MS; }
function _skySwayTick() {
  _skyTimers.sway = 0;
  if (!_skyAwake(_skyState) || _skyReduceMotion()) return;
  _skyKick();
  if (_skyBreezeParked()) return;   // the frame just asked for is the last until someone is back
  _skyTimers.sway = setTimeout(_skySwayTick, SKY_SWAY_MS);
}
function _skyAttend() {
  var was = _skyBreezeParked();
  _skyAttentionAt = performance.now();
  if (was && !_skyTimers.sway && _skyAwake(_skyState) && !_skyReduceMotion() && !_skyState.lens && _skySetting('skin') === 'beach') {
    _skyTimers.sway = setTimeout(_skySwayTick, SKY_SWAY_MS);
  }
}
function _skyIssTick() {
  _skyTimers.iss = 0;
  if (_skyAwake(_skyState)) _skyKick();
}

// Live, and older than one tick of the live clock.
function _skyStale(s) { return !!(s && s.eph && _skyLive() && Date.now() - s.nowTime > SKY_LIVE_MS); }
// Whether the canvas is on screen now, measured: the observer's last word can
// be from before the app slept (it reports nothing while the page is frozen).
function _skyMeasureInView(s) {
  if (!s || !s.canvas || !s.canvas.isConnected) return false;
  var r = s.canvas.getBoundingClientRect();
  return r.bottom > 0 && r.top < (window.innerHeight || document.documentElement.clientHeight) && r.width > 0;
}

// Hidden tab, the 3D view over the page, the sky scrolled away: nothing runs.
function _skyPause() {
  _skyDisarm();
  if (_almanacSkyRAF) { cancelAnimationFrame(_almanacSkyRAF); _almanacSkyRAF = null; }
}
// Back in sight: live, catch up to now; then paint and re-arm.
function _skyResume() {
  var s = _skyState;
  _sgRetryLoads();   // what failed to load may now (back from the switcher, the network back)
  _skyConstFailed = false;
  if (s) s.inView = _skyMeasureInView(s);
  if (!_skyAwake(s)) return;
  if (s.eph && _skyLive() && Date.now() - s.nowTime > SKY_LIVE_MS / 2) _skyCompute(s, new Date());
  _skyArm();
  _skyKick();
}
// Back from the app switcher or a locked screen: iOS does not always say so
// with visibilitychange (almanac.js resumes on that), so a page shown again
// from the back-forward cache, or the window focused again, catches up too.
// Only when the sky has fallen behind: a resume re-arms everything.
function _skyWake() {
  if (typeof _almanacOpen !== 'undefined' && _almanacOpen && !document.hidden && _skyStale(_skyState)) _skyResume();
}
if (typeof window.addEventListener === 'function') {   // not in the tests' bare window
  window.addEventListener('pageshow', _skyWake);
  window.addEventListener('focus', _skyWake);
  ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) { window.addEventListener(ev, _skyAttend, { passive: true, capture: true }); });
  window.addEventListener('scroll', _skyAttend, { passive: true, capture: true });
}

// Leaving the Almanac.
function _skyStop() {
  _skyPause();
  if (!_skyHost) _sgDispose();   // the GPU goes back with the Almanac, unless the look-around still draws
  if (_skyState && _skyState.observer) _skyState.observer.disconnect();
  _skyHideTip();
  _skyState = null;
}

// The instant's values into the state, and the words that go with them.
function _skyCompute(s, now, quiet) {
  var was = s.baseDirty, seaWas = s.sea;
  s.pending = null;
  var f = _skyFrame(now, s.lat, s.lon);
  s.now = now; s.nowTime = now.getTime();
  s.eph = f.eph; s.moonData = f.moonData;
  _skyBrightness(s);
  _skyGroundAt(s);
  // A live tick that has not turned the sky a pixel leaves the picture alone.
  if (quiet && !was && _skyDriftPx(s, s.nowTime) < SKY_REPAINT_PX && (_skySetting('skin') !== 'beach' || _skySeaSame(seaWas, s.sea))) s.baseDirty = false;
  if (s.baseDirty) s.twinkle++;
  _skyUpdateDesc(s);
  _skyCaption(s);
  _skyFacts(s);
  return f;
}
function _skySeaSame(a, b) { return !!a === !!b && (!a || Math.abs(a.frac - b.frac) < 0.005); }
// How bright the sky is at the instant (the Sun's light, the Moon's, the place's
// own), and so the faintest star it shows.
function _skyBrightness(s) {
  var e = s.eph;
  s.obsc = _skySolarObscuration(s);
  s.sunShare = _sgSunShare(s.obsc);
  s.moonShare = e.moon.altitude > -2 ? _sgMoonShare(_skyEclipse(s.now)) : 1;
  s.lum = _sgSkyLum(e.sunGeoAlt, e.moon.altitude, s.moonData.phase.illumination, _skySetting('dial'), s.sunShare, s.moonShare);
  s.lm = _sgLimitMag(s.lum);
}
// How much of the Sun's disc the Moon covers (0 to 1), by the two discs' apparent
// places: the area where two circles overlap over the Sun's own. A solar eclipse
// dims the sky as it grows.
var SKY_ECLIPSE_REACH_SOLAR_DEG = 1;
function _skySolarObscuration(s) {
  var sun = s.eph.sun, moon = s.eph.moon;
  if (sun.alt < -2 || moon.altitude < -2) return 0;
  var a = _skyEnu(sun.az, sun.alt), b = _skyEnu(moon.azimuth, moon.altitude);
  var sep = Math.acos(_skyClamp(_skyDot3(a, b), -1, 1)) / DEG_TO_RAD;
  if (sep > SKY_ECLIPSE_REACH_SOLAR_DEG) return 0;
  return _skyCircleOverlap(sep, SKY_SUN_SEMI_DEG, _skyMoonSemi(s.now, moon.altitude));
}
// The share of the first circle's (radius r1) area that a second (r2) covers, centres d apart.
function _skyCircleOverlap(d, r1, r2) {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r2 - r1)) return r2 >= r1 ? 1 : (r2 * r2) / (r1 * r1);
  var a1 = Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1)), a2 = Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
  var area = r1 * r1 * a1 + r2 * r2 * a2 - 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
  return area / (Math.PI * r1 * r1);
}
// What stands on the horizon at the instant: the sea's level, the aurora.
function _skyGroundAt(s) {
  s.sea = _skySea(s);
  s.aurora = _skyAurora(s);
  s.baseDirty = true;
}

// `animateMoon` -- true only for a repaint that reinitializes this same canvas
// for a NEW focus instant (scrub settle, wheel/key-step settle, "Go", Back to
// Now). Live loads and resizes omit it and get the Moon's place at once.
// Nothing is painted here. Opening the Almanac does not even do the sums:
// they and the first paint come in the next animation frame, where the old
// scene drew its first frame too.
function _initSkyScene(now, lat, lon, animateMoon) {
  var canvas = document.getElementById('almanac-sky-canvas');
  if (!canvas) return;
  var wrap = canvas.parentElement;
  var dpr = window.devicePixelRatio || 1;
  var w = wrap.clientWidth, h = Math.round(w / (_skyAspectReq || (w < SKY_PHONE_MAX_W ? SKY_ASPECT_PHONE : SKY_ASPECT)));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  var ts = performance.now();
  var prev = (_skyState && _skyState.canvas === canvas) ? _skyState : null;
  var priorMoon = (animateMoon && prev) ? _skyMoonAt(prev, ts) : null;
  var priorTime = prev ? prev.nowTime : now.getTime();
  var loc = _getLocation();
  var s = {
    canvas: canvas, dpr: dpr, W: canvas.width, H: canvas.height, cssW: w, scale: _skyClamp(w / 600, 0.85, 1.15),
    lat: lat, lon: lon, center: lat >= 0 ? 180 : 0,
    stored: loc.stored && loc.lat === lat && loc.lon === lon, name: loc.name || '',
    known: loc.known && loc.lat === lat && loc.lon === lon,
    moonAnim: null, twinkle: 0, bodies: [], baseBodies: [],
    actors: prev ? prev.actors : [], base: prev ? prev.base : null, baseDirty: true,
    inView: prev ? prev.inView : true, forcePaint: !!prev,
    observer: prev && prev.observer
  };
  _skyState = s;
  _skyApplyView(s);
  if (prev) {
    var f = _skyCompute(s, now);
    if (priorMoon && !_skyReduceMotion()) s.moonAnim = { from: priorMoon, to: f.moonData, start: ts, fromTime: priorTime, toTime: now.getTime() };
  } else s.pending = now;
  if (!s.observer && typeof IntersectionObserver === 'function') {
    s.observer = new IntersectionObserver(function (entries) {
      var st = _skyState;
      if (!st) return;
      st.inView = entries[entries.length - 1].isIntersecting;
      if (st.inView) _skyResume(); else _skyPause();
    });
    s.observer.observe(canvas);
  }
  _skyBindTaps(canvas);
  _skyBindSettings();
  _skyHideTip();
  _skyArm();
  _skyKick();
}

// The time machine's frames: the new instant's sky, drawn on the next frame,
// with the Moon gliding there. The loop is not restarted, the canvas kept.
function _skySetInstant(now) {
  var s = _skyState;
  if (!s) return;
  if (!s.eph) { s.pending = now; _skyKick(); return; }
  var fromTime = s.nowTime;
  var f = _skyFrame(now, s.lat, s.lon);
  s.now = now;
  s.eph = f.eph;
  _skyMoonRetarget(s, f.moonData, performance.now(), fromTime, now.getTime());
  _skyBrightness(s);
  _skyGroundAt(s);
  s.twinkle++;
  _skyKick();
}

// Screen-reader description of the sky. _tLookup falls back to English when a
// stale cached i18n file lacks these keys -- raw key names must never be
// spoken (issue #25).
function _skyUpdateDesc(s) {
  var srEl = document.getElementById('almanac-sky-desc');
  if (!srEl) return;
  var e = s.eph, sunAlt = e.sun.alt, moonPos0 = e.moon, moonM0 = s.moonData.phase;
  var when = s.now.toLocaleString((typeof _currentLang !== 'undefined') ? _currentLang : undefined, {
    weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
  var sunDesc = sunAlt > 0
    ? _tLookup('alm_sun', 'Sun') + ' ' + _orrNum(sunAlt, null, 0) + '° ' + _tLookup('alm_a11y_above_horizon', 'above the horizon')
    : _tLookup('alm_sun', 'Sun') + ' ' + _tLookup('alm_a11y_below_horizon', 'below the horizon');
  var moonDesc;
  if (moonPos0.altitude > -2) {
    moonDesc = _tLookup('alm_moon', 'Moon') + ' ' + moonM0.illumination + '% ' + _tLookup('alm_a11y_illuminated', 'illuminated') +
      ', ' + _orrNum(moonPos0.altitude, null, 0) + '° ' + _tLookup('alm_a11y_altitude', 'high');
  } else {
    moonDesc = _tLookup('alm_moon', 'Moon') + ' ' + _tLookup('alm_a11y_below_horizon', 'below the horizon');
  }
  var lm = _skyLimitingMag(e.sunGeoAlt);
  var starsVisible = e.stars.filter(function (st) { return st.mag < lm; }).length;
  var planetsUp = e.planets.filter(function (p) { return p.alt > 0 && p.mag < lm + 0.6; }).map(function (p) { return _tp(p.name); });
  var starsDesc = starsVisible > 0
    ? starsVisible + ' ' + _tLookup('alm_a11y_stars_visible', 'stars visible')
    : _tLookup('alm_a11y_no_stars', 'No stars currently above the horizon');
  var skyFor = _tLookup('alm_a11y_sky_for', 'Almanac sky for {when}.').replace('{when}', when);
  srEl.textContent = skyFor + ' ' + _tLookup(_skyPhaseKey(e.sunGeoAlt), '') + '. ' + sunDesc + '. ' + moonDesc + '. ' +
    (planetsUp.length ? planetsUp.join(', ') + '. ' : '') + starsDesc + '.';
}

// An altitude in whole degrees, in the reader's digits ("-3°", never "-0°").
function _skyDeg(x) { return _orrNum(Math.round(x) || 0, null, 0) + '°'; }

// "37.8°N, 122.4°W", the place in numbers (the star chart's caption too).
function _skyCoords(lat, lon) {
  return _orrNum(Math.abs(lat), null, 1) + '°' + (lat >= 0 ? 'N' : 'S') + ', ' + _orrNum(Math.abs(lon), null, 1) + '°' + (lon >= 0 ? 'E' : 'W');
}

// The line on the ground: the light of the hour (twilight linked to its
// article), the Sun's altitude, and the place, said to be assumed when no
// place was chosen (never a request for one).
function _skyCaption(s) {
  var el = document.getElementById('almanac-sky-cap');
  if (!el) return;
  var g = s.eph.sunGeoAlt, key = _skyPhaseKey(g);
  var phase = _almEsc(t(key));
  if (key !== 'alm_sky_day' && key !== 'alm_sky_night') phase = _lterm('twilight', phase);
  var sunAlt = t('alm_sky_sun_alt', { a: _skyDeg(s.eph.sun.alt) });
  var facing = t('alm_sky_facing', { dir: _azCompass(s.lens ? s.lens.az : s.center) });
  // The season, by the Sun, in this place's hemisphere ("Where do we say the
  // season", Eric, 2026-10-03): the sky is where the year shows.
  var season = typeof _almSeasonText === 'function' ? _almSeasonText(s.nowTime, s.lat) : '';
  // One lead line (the light of the hour), under it what is true of it here
  // (the Sun, the way the picture faces, the place) and the year, quieter.
  var where = [_almEsc(sunAlt), _almEsc(facing)];
  if (s.stored) where.push(_almEsc(s.name || _skyCoords(s.lat, s.lon)));
  var html = '<span class="alm-sky-lead">' + phase + '</span><span class="alm-sky-sub">' + where.join(' · ') + '</span>' +
    (season ? '<span class="alm-sky-sub alm-sky-season">' + _almEsc(season) + '</span>' : '');
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
  // No place chosen: under the sky, the one line asking for it.
  var inv = document.getElementById('almanac-sky-invite');
  if (inv && inv._stored !== s.stored) { inv.innerHTML = s.stored ? '' : _almPlaceInviteHtml(); inv._stored = s.stored; }
}

// ══ Taps ═════════════════════════════════════════════════════════════════
// The Sun and the Moon open the 3D view on themselves (when the browser can
// draw it; else their name and article). A planet is named, with the way to
// it in the solar system below, which is where the planets are drawn; a
// named star is named.

function _sky3DAvailable() { return typeof window.openAlmanacEarth === 'function' && !window.openAlmanacEarth.unsupported; }

// Distance (CSS px) from a point to a segment.
function _skySegDist(px, py, x0, y0, x1, y1) {
  var dx = x1 - x0, dy = y1 - y0, L = dx * dx + dy * dy;
  var u = L ? _skyClamp(((px - x0) * dx + (py - y0) * dy) / L, 0, 1) : 0;
  var qx = x0 + u * dx - px, qy = y0 + u * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
}
// What a tap at (x, y) CSS px lands on: the nearest body within reach of its
// edge, the Sun, Moon and planets before the stars.
var SKY_TAP_RANK = { sun: 0, moon: 0, planet: 0, iss: 0, plane: 1, birds: 1, meteor: 1, boat: 1, whale: 1, star: 2, dso: 2, aurora: 3, sea: 4 };
function _skyHitTest(x, y) {
  var s = _skyState;
  if (!s) return null;
  var best = null, bestRank = 99, bestGap = Infinity;
  for (var i = 0; i < s.bodies.length; i++) {
    var b = s.bodies[i], gap;
    if (b.box) gap = x >= b.box[0] && x <= b.box[2] && y >= b.box[1] && y <= b.box[3] ? 0 : Infinity;
    else if (b.x0 != null) gap = _skySegDist(x, y, b.x0, b.y0, b.x1, b.y1);
    else gap = Math.sqrt((b.x - x) * (b.x - x) + (b.y - y) * (b.y - y)) - b.r;
    if (gap > SKY_TAP_PX) continue;
    var rank = SKY_TAP_RANK[b.type];
    if (rank < bestRank || (rank === bestRank && gap < bestGap)) { best = b; bestRank = rank; bestGap = gap; }
  }
  return best;
}

function _skyBodyKey(b) {
  if (b.type === 'sun') return 'planet:sun';
  if (b.type === 'moon') return 'planet:moon';
  if (b.type === 'planet') return 'planet:' + b.name.toLowerCase();
  if (b.type === 'star') return _starLinkKey(b.idx);
  if (b.type === 'iss') return 'term:iss';
  return SKY_LIFE_KEYS[b.type] || null;
}
// What lives on the horizon and in the air, and its article (almanac-links.js SKY).
var SKY_LIFE_KEYS = { sea: 'sky:sea', boat: 'sky:ship', whale: 'sky:whale', plane: 'sky:airliner', birds: 'sky:birds',
  meteor: 'sky:meteor', aurora: 'sky:aurora' };
var SKY_NAME_KEYS = { sun: 'alm_sun', moon: 'alm_moon', iss: 'alm_earth_iss_name', sea: 'alm_sky_sea',
  boat: 'alm_sky_boat', whale: 'alm_sky_whale', plane: 'alm_sky_plane', birds: 'alm_sky_birds', meteor: 'alm_sky_meteor', aurora: 'alm_sky_aurora' };
function _skyBodyName(b) {
  if (b.type === 'planet') return _tp(b.name);
  if (b.type === 'star') {
    if (b.idx >= 0 && _STAR_NAMES[b.idx]) return _STAR_NAMES[b.idx];
    var con = _skyConById(b.con);
    return b.desig ? b.desig + ' ' + (con ? con.gen : b.con) : t('alm_star');
  }
  if (b.type === 'dso') return b.desig;
  return t(SKY_NAME_KEYS[b.type]);
}
// The lines under the name for what lives on the horizon, or null.
function _skyLifeLines(b) {
  var s = _skyState;
  if (b.type === 'sea') return s.sea && typeof _atSkySeaLines === 'function' ? _atSkySeaLines(s.sea) : [];
  if (b.type === 'boat') {
    var km = SKY_EYE_KM * Math.sqrt(SKY_EYE_M);
    return [t('alm_sky_boat_line', { d: _orrNum(km, 'kilometer', 0) }), t('alm_sky_boat_lights'), t('alm_sky_illustration')];
  }
  if (b.type === 'plane') return [t('alm_sky_plane_line'), t('alm_sky_plane_note')];
  if (b.type === 'whale') return [t('alm_sky_whale_line'), t('alm_sky_illustration')];
  if (b.type === 'birds') return [t('alm_sky_birds_line'), t('alm_sky_illustration')];
  if (b.type === 'meteor') {
    var r = _skyMeteorRate(s), n = _orrNum(Math.round(r.perHour), null, 0);
    return [r.shower ? t('alm_sky_meteor_shower', { name: _showerName(r.shower.sh), n: n }) : r.perHour < 1 ? t('alm_sky_meteor_few') : t('alm_sky_meteor_line', { n: n })];
  }
  if (b.type === 'aurora') return [t('alm_sky_aurora_line', { g: _skyDeg(Math.abs(b.mag)) })];
  if (b.type === 'iss') return [t('alm_sky_iss_line', { km: _orrNum(Math.round(b.km), 'kilometer', 0), where: _skyDeg(b.alt) + ' ' + _azCompass(b.az) })];
  return null;
}
// The lines under a body's name.
function _skyBodyLines(b) {
  var life = _skyLifeLines(b);
  if (life) return life;
  var where = _skyDeg(b.alt) + ' ' + _azCompass(b.az);
  var lines = [b.mag != null ? t('alm_sky_body_line', { where: where, m: _orrNum(b.mag, null, 1) }) : where];
  if (b.type === 'star' && b.con) { var cc = _skyConById(b.con); if (cc) lines.push(t('alm_sky_in_con', { c: cc.name })); }
  // The planets whose phase shows (they pass between us and the Sun, or are not far from it).
  if (b.type === 'planet' && b.phase != null && SKY_PHASED_PLANETS.indexOf(b.name) >= 0) lines.push(t('alm_sky_f_moon_lit', { p: _orrNum(Math.round(b.phase * 100), null, 0) + '%' }));
  if (b.enlarged) lines.push(t('alm_sky_enlarged', { n: _orrNum(Math.round(b.enlarged), null, 0) }));
  return lines;
}

// The tip: the name (its article's link when the library has it), the lines,
// and for a planet the way to it in the solar system.
function _skyShowTip(b) {
  var tip = document.getElementById('almanac-sky-tip'), wrap = tip && tip.parentElement;
  if (!tip) return;
  var key = _skyBodyKey(b), name = _almEsc(_skyBodyName(b));
  if (key && window.AlmanacLinks && window.AlmanacLinks.linkFor(key)) name = window.AlmanacLinks.wrap(key, name);
  var html = '<span class="alm-sky-tip-name">' + name + '</span>';
  var lines = _skyBodyLines(b);
  for (var i = 0; i < lines.length; i++) {
    html += '<span class="alm-sky-tip-line">' + _almEsc(lines[i]) + '</span>';
  }
  if (b.type === 'planet' && typeof _orreryShowBody === 'function') {
    html += '<button type="button" class="orrery-tip-btn" data-sky-orrery="' + _almEsc(b.name) + '">' + _almEsc(t('alm_sky_find_orrery')) + '</button>';
  }
  tip.innerHTML = html;
  tip.hidden = false;
  tip._sky = b;
  // Beside the body, above it when there is room, inside the scene.
  var W = wrap.clientWidth, H = (_skyState && _skyState.canvas && _skyState.canvas.clientHeight) || wrap.clientHeight, tw = tip.offsetWidth, th = tip.offsetHeight;
  var at = b.box ? { x: b.tapX, y: b.tapY } : b.x0 != null ? { x: b.x1, y: (b.y0 + b.y1) / 2 } : b;
  var ax = at.x, ay = at.y, gap = (b.r || 4) + 8;
  var top = ay - gap - th >= 2 ? ay - gap - th : ay + gap;
  tip.style.top = _skyClamp(top, 2, Math.max(2, H - th - 2)) + 'px';
  tip.style.left = _skyClamp(ax - tw / 2, 2, Math.max(2, W - tw - 2)) + 'px';
}
function _skyHideTip() {
  var s = _skyState;
  if (s && s.reveal) { s.reveal = null; s.baseDirty = true; if (s.eph) _skyKick(); }
  var tip = document.getElementById('almanac-sky-tip');
  if (tip) { tip.hidden = true; tip._sky = null; }
}

// What a tap on a body does; returns 'view' (the 3D view opened) or 'tip'.
function _skyAct(b) {
  if (b.type === 'star' && b.con) { _skyRevealFigure(b.con); if (!_skyConst) { _skyLoadConstellations(_skyKickDirty); } }
  if ((b.type === 'sun' || b.type === 'moon') && _sky3DAvailable()) {
    _skyHideTip();
    window.openAlmanacEarth({ target: b.type, from: 'sky' });
    return 'view';
  }
  _skyShowTip(b);
  return 'tip';
}

function _skyTapAt(clientX, clientY) {
  var s = _skyState;
  if (!s) return null;
  var r = s.canvas.getBoundingClientRect();
  var hit = _skyHitTest(clientX - r.left, clientY - r.top);
  if (!hit) { _skyHideTip(); return null; }
  hit.tapX = clientX - r.left; hit.tapY = clientY - r.top;
  return _skyAct(hit);
}

function _skyBindTaps(canvas) {
  if (canvas._skyTaps) return;
  canvas._skyTaps = true;
  canvas.addEventListener('click', function (e) {
    _skyTapAt(e.clientX, e.clientY);
  });
  canvas.addEventListener('mousemove', function (e) {
    var r = canvas.getBoundingClientRect(), hit = _skyHitTest(e.clientX - r.left, e.clientY - r.top);
    canvas.style.cursor = hit ? 'pointer' : '';
  });
  var tip = document.getElementById('almanac-sky-tip');
  if (tip && !tip._skyBound) {
    tip._skyBound = true;
    tip.addEventListener('click', function (e) {
      var el = e.target.closest && e.target.closest('[data-sky-orrery]');
      if (!el) return;
      e.stopPropagation();
      _skyHideTip();
      _orreryShowBody(el.getAttribute('data-sky-orrery'));
    });
  }
}

// Star chart — a circular planisphere of the sky above the chosen location at
// this moment. Zenith at the center, horizon at the rim; N is up and E is to
// the left, the way the sky reads when you hold a chart overhead. All positions
// come from the same offline RA/Dec → alt/az math as the rest of the almanac.
// Star-chart interactivity. Scrubbing re-runs the same offline alt/az math at
// the scrubbed instant (nothing is fetched), and every drawn body is recorded
// in _starChartBodies so a tap can identify it.
var _starChartBase = null;    // the focused moment (driven by the pinned scrubber)

var _starChartBodies = [];    // hit-test targets collected during the draw

var _starChartViewLat = null; // null = use the saved location; set by dragging

var _starChartViewLon = null;

var _starChartDragged = false; // suppresses the tap-to-identify after a drag

var _starChartSelectedKey = null; // the currently selected body's link key (2nd
                                  // tap on the same one opens its article)

var _scTouchPanning = false;      // a touch gesture began inside the disc

function _starChartResetLoc() {
  _starChartViewLat = null;
  _starChartViewLon = null;
  _drawStarChart(_starChartTime());
}

// True when a client point falls within the inscribed disc of the square canvas
// — the only region that owns the pan gesture. Corners belong to the page.
function _insideChartDisc(canvas, clientX, clientY) {
  var rect = canvas.getBoundingClientRect();
  var px = clientX - rect.left - rect.width / 2;
  var py = clientY - rect.top - rect.height / 2;
  var R = Math.min(rect.width, rect.height) / 2;
  return px * px + py * py <= R * R;
}

// Drag the chart to stand somewhere else on Earth. This is a preview only —
// it never overwrites the saved location the rest of the almanac uses.
function _initStarChartDrag(canvas) {
  var dragging = false, lastX = 0, lastY = 0, moved = 0;
  // touch-action is `auto`, so a touch that starts in the square's corners
  // scrolls the page normally. Containment lives in these listeners, not
  // clip-path (which only clips hit-testing in some browsers, not Safari):
  //   - touchstart records only whether the gesture began inside the disc; it
  //     does NOT preventDefault, so a stationary tap still yields its click
  //     (tap-to-identify / open the article).
  //   - touchmove (non-passive) preventDefaults only for an inside-started
  //     gesture, cancelling the page scroll so the pan owns it. A corner-started
  //     gesture is left to scroll the page.
  // Bound once — _initStarChartDrag re-runs per render, and addEventListener
  // would otherwise stack duplicates (unlike the reassigned pointer handlers).
  if (!canvas._scTouchBound) {
    canvas._scTouchBound = true;
    canvas.addEventListener('touchstart', function (e) {
      var tt = e.touches[0];
      _scTouchPanning = !!tt && _insideChartDisc(canvas, tt.clientX, tt.clientY);
    }, { passive: true });
    canvas.addEventListener('touchmove', function (e) {
      if (_scTouchPanning) e.preventDefault();
    }, { passive: false });
    var _scTouchClear = function () { _scTouchPanning = false; };
    canvas.addEventListener('touchend', _scTouchClear);
    canvas.addEventListener('touchcancel', _scTouchClear);
  }
  canvas.onpointerdown = function (e) {
    // Only the circular disc is interactive. A press in the square's corners
    // (outside the inscribed circle) must not start a rotation or capture the
    // pointer — it belongs to the page (scroll). This mirrors the touch guard
    // above and keeps mouse/stylus honest.
    if (!_insideChartDisc(canvas, e.clientX, e.clientY)) return;
    dragging = true; moved = 0;
    lastX = e.clientX; lastY = e.clientY;
    _starChartDragged = false;
    if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) {} }
  };
  canvas.onpointermove = function (e) {
    if (!dragging) {
      // Hover affordance: pointer cursor only over a body that resolves to an
      // installed article. Plain (grab) cursor everywhere else.
      var hr = canvas.getBoundingClientRect();
      var over = _starChartBodyAt(e.clientX - hr.left, e.clientY - hr.top);
      canvas.style.cursor = _starChartLinkFor(over) ? 'pointer' : '';
      return;
    }
    var dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (moved < 4) return; // still a tap
    _starChartDragged = true;
    var loc = _getLocation();
    var lat = (_starChartViewLat === null ? loc.lat : _starChartViewLat) + dy * 0.4;
    var lon = (_starChartViewLon === null ? loc.lon : _starChartViewLon) - dx * 0.6;
    // Carry over the poles rather than hitting a wall: walking north past the
    // North Pole is walking south down the opposite meridian. Longitude wraps
    // at the date line, so panning is continuous in both axes.
    if (lat > 90) { lat = 180 - lat; lon += 180; }
    else if (lat < -90) { lat = -180 - lat; lon += 180; }
    // A hair short of the pole itself, where azimuth is undefined.
    _starChartViewLat = Math.max(-89.9, Math.min(89.9, lat));
    _starChartViewLon = ((lon + 180) % 360 + 360) % 360 - 180;
    _drawStarChart(_starChartTime());
  };
  canvas.onpointerup = canvas.onpointercancel = function (e) {
    dragging = false;
    if (canvas.releasePointerCapture) { try { canvas.releasePointerCapture(e.pointerId); } catch (err) {} }
  };
}

function _starChartTime() {
  return _starChartBase ? new Date(_starChartBase.getTime()) : new Date();
}

// Azimuth to an 8-point compass label, reusing the localized cardinals.
function _azCompass(az) {
  var N = t('alm_dir_n'), E = t('alm_dir_e'), S = t('alm_dir_s'), W = t('alm_dir_w');
  var pts = [N, N + E, E, S + E, S, S + W, W, N + W];
  return pts[Math.round(((az % 360) + 360) % 360 / 45) % 8];
}

// Nearest drawn body within the tap radius of a canvas point, or null.
function _starChartBodyAt(x, y) {
  var best = null, bestD = 18;
  for (var i = 0; i < _starChartBodies.length; i++) {
    var b = _starChartBodies[i];
    var d = Math.sqrt((b.x - x) * (b.x - x) + (b.y - y) * (b.y - y));
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}

// The resolved article for a body, or null (no key / not in the installed
// library / batch not yet landed).
function _starChartLinkFor(body) {
  return (body && body.key && window.AlmanacLinks) ? window.AlmanacLinks.linkFor(body.key) : null;
}

function _starChartClick(ev) {
  if (_starChartDragged) { _starChartDragged = false; return; } // that was a pan
  var canvas = document.getElementById('almanac-starchart');
  var info = document.getElementById('alm-sc-info');
  if (!canvas || !info) return;
  var r = canvas.getBoundingClientRect();
  var best = _starChartBodyAt(ev.clientX - r.left, ev.clientY - r.top);
  if (!best) { info.innerHTML = ''; _starChartSelectedKey = null; return; }
  var link = _starChartLinkFor(best);
  // Second tap on the same, already-selected linkable body opens its installed
  // article (closed-set authority — same open path the name-link hint uses).
  if (link && best.key && best.key === _starChartSelectedKey) {
    window.AlmanacLinks.open(best.key);
    return;
  }
  // First tap selects: name it in the info line, carrying the dotted-amber link
  // hint ONLY when its curated Q-ID actually resolved (no link → no hint, never
  // a search). A resolved body is remembered so a second tap can open it.
  var label = _almEsc(best.label);
  info.innerHTML = link ? window.AlmanacLinks.wrap(best.key, label) : label;
  _starChartSelectedKey = link ? best.key : null;
}

function _renderStarChart(baseNow) {
  _starChartBase = baseNow;
  _starChartViewLat = null;
  _starChartViewLon = null;
  var cv = document.getElementById('almanac-starchart');
  if (cv) _initStarChartDrag(cv);
  var info = document.getElementById('alm-sc-info');
  if (info) info.innerHTML = '';
  _starChartSelectedKey = null;
  _drawStarChart(baseNow);
}

// The soft halo a bright star throws: faint, a few radii wide, under its point.
function _skyStarBloom(ctx, x, y, r, tint, a) {
  var R = r * SKY_STAR_GLOW_X;
  var gg = ctx.createRadialGradient(x, y, 0, x, y, R);
  gg.addColorStop(0, 'rgba(' + tint + ',' + (0.22 * a).toFixed(3) + ')');
  gg.addColorStop(1, 'rgba(' + tint + ',0)');
  ctx.fillStyle = gg;
  ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
}

// Decorative dim background starfield for the planisphere disc — a cached,
// deterministic field (not astronomically real, not linkable) so the schematic
// chart disc reads as a dense night sky rather than the ~25-35 catalog stars
// typically above the horizon at once. (The horizon SCENE uses real positions —
// see _projectFieldStars — but the planisphere is a labelled diagram, where an
// even ambient fill behind the named stars reads better than 460 mag dots.)
// Cached by disc size only (not lat/lon/time), so panning/scrubbing is free.
var _starChartBgStars = null;

function _ensureStarChartBgStars(size) {
  if (_starChartBgStars && _starChartBgStars.size === size) return _starChartBgStars.stars;
  var sr = _lcgRand(137);
  var count = 150;
  var half = size / 2;
  var stars = [];
  for (var i = 0; i < count; i++) {
    var ang = sr() * Math.PI * 2;
    var rad = Math.sqrt(sr()) * (half - 16); // area-uniform over the disc, clear of the rim labels
    stars.push({
      x: half + Math.cos(ang) * rad,
      y: half + Math.sin(ang) * rad,
      r: 0.3 + sr() * 0.45,
      a: 0.06 + sr() * 0.13
    });
  }
  _starChartBgStars = { size: size, stars: stars };
  return stars;
}

var SKY_LABEL_NUDGES_PX = [-3, 10, -14, 21, -25], SKY_LABEL_H_PX = 10;   // where a chart name may stand, from the body's own height
function _drawStarChart(now) {
  var canvas = document.getElementById('almanac-starchart');
  if (!canvas) return;
  var wrap = canvas.parentElement;
  var dpr = window.devicePixelRatio || 1;
  var size = Math.min(wrap.clientWidth, 360);
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  _starChartBodies = [];

  var loc = _getLocation();
  var panned = _starChartViewLat !== null;
  var lat = panned ? _starChartViewLat : loc.lat;
  var lon = panned ? _starChartViewLon : loc.lon;
  var cx = size / 2, cy = size / 2;
  var R = size / 2 - 16; // leave room for cardinal labels
  // Shared alt/az from apparent local sidereal time.
  var JD = _dateToJD(now.getTime());
  var LST = _skyLST(now, lon);
  var latR = lat * DEG_TO_RAD;
  var sinLat = Math.sin(latR), cosLat = Math.cos(latR);
  function altAz(raRad, decRad) { return _skyHorizontal(raRad, decRad, LST, sinLat, cosLat); }
  // Azimuthal (zenith-centered) projection with N up, E left (looking up).
  function project(altDeg, azDeg) {
    var r = (90 - altDeg) / 90 * R;
    var a = azDeg * DEG_TO_RAD;
    return { x: cx - r * Math.sin(a), y: cy - r * Math.cos(a) };
  }

  var styles = getComputedStyle(document.documentElement);
  var amber = (styles.getPropertyValue('--amber') || '#e0b060').trim();

  // Label helper — anchor toward the center so names near the rim grow inward
  // and never clip off the disc.
  // A name that would stand on one already written moves to the next place about its body (above, below, further
  // above, further below) and is written at the first that is clear; with none clear it keeps its first place.
  var labelBoxes = [];
  function drawLabel(txt, x, y, off) {
    var leftHalf = x <= cx, w = ctx.measureText(txt).width, lx = x + (leftHalf ? off : -off);
    ctx.textAlign = leftHalf ? 'left' : 'right';
    ctx.textBaseline = 'alphabetic';
    var box = null;
    for (var n = 0; n < SKY_LABEL_NUDGES_PX.length && !box; n++) {
      var by = y + SKY_LABEL_NUDGES_PX[n], c = { x0: leftHalf ? lx : lx - w, x1: leftHalf ? lx + w : lx, y0: by - SKY_LABEL_H_PX, y1: by + 2, ty: by };
      if (!labelBoxes.some(function (p) { return c.x0 < p.x1 && p.x0 < c.x1 && c.y0 < p.y1 && p.y0 < c.y1; })) box = c;
    }
    if (!box) box = { x0: leftHalf ? lx : lx - w, x1: leftHalf ? lx + w : lx, y0: y - 3 - SKY_LABEL_H_PX, y1: y - 1, ty: y - 3 };
    labelBoxes.push(box);
    ctx.fillText(txt, lx, box.ty);
  }

  // Sky disc + horizon rim.
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
  var sky = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  sky.addColorStop(0, '#0a1228');
  sky.addColorStop(1, '#05060d');
  ctx.fillStyle = sky;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  ctx.restore();

  // Faint decorative background stars, clipped to the disc — ambiance only,
  // drawn under the constellation lines and the real (linkable) catalog stars.
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
  var bgStars = _ensureStarChartBgStars(size);
  for (var bgi = 0; bgi < bgStars.length; bgi++) {
    var bg = bgStars[bgi];
    ctx.beginPath(); ctx.arc(bg.x, bg.y, bg.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(210,220,240,' + bg.a.toFixed(3) + ')';
    ctx.fill();
  }
  ctx.restore();

  ctx.strokeStyle = 'rgba(120,140,180,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  // Altitude ring at 30° and 60°.
  ctx.strokeStyle = 'rgba(120,140,180,0.12)';
  ctx.beginPath(); ctx.arc(cx, cy, R * 2 / 3, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, R / 3, 0, Math.PI * 2); ctx.stroke();

  // Cardinal labels (N up, E left — planisphere convention).
  ctx.fillStyle = amber;
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(t('alm_dir_n'), cx, cy - R - 7);
  ctx.fillText(t('alm_dir_s'), cx, cy + R + 7);
  ctx.fillText(t('alm_dir_e'), cx - R - 7, cy);
  ctx.fillText(t('alm_dir_w'), cx + R + 7, cy);

  // Precompute star projections.
  var proj = {};
  for (var i = 0; i < _STARS.length; i++) {
    var aa = altAz(_STARS[i][0] * 15 * DEG_TO_RAD, _STARS[i][1] * DEG_TO_RAD);
    if (aa.alt < 0) continue;
    proj[i] = project(aa.alt, aa.az);
    proj[i].alt = aa.alt; proj[i].az = aa.az;
  }
  // Constellation lines (both endpoints up).
  ctx.strokeStyle = 'rgba(120,150,210,0.28)';
  ctx.lineWidth = 0.8;
  for (var c = 0; c < _CONST_LINES.length; c++) {
    var a = proj[_CONST_LINES[c][0]], b = proj[_CONST_LINES[c][1]];
    if (a && b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
  }
  // Stars — radius and brightness by magnitude.
  var starCount = 0;
  for (var i = 0; i < _STARS.length; i++) {
    var p = proj[i]; if (!p) continue;
    starCount++;
    var mag = _STARS[i][2], look = _skyStarLook(mag);
    // The chart is drawn in CSS pixels (its context is scaled by dpr).
    var rad = _skyStarDevR(look.r, dpr) / dpr;
    var tint = _WARM_STARS[i] ? '255,208,160' : '238,242,255';
    if (look.bloom) _skyStarBloom(ctx, p.x, p.y, rad, tint, 1);
    ctx.fillStyle = 'rgba(' + tint + ',' + look.k.toFixed(3) + ')';
    ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, Math.PI * 2); ctx.fill();
    if (_STAR_NAMES[i] && mag < 1.6) {
      ctx.fillStyle = 'rgba(200,210,235,0.7)';
      ctx.font = '9px system-ui, sans-serif';
      drawLabel(_STAR_NAMES[i], p.x, p.y, rad + 2);
    }
    _starChartBodies.push({
      x: p.x, y: p.y, key: _starLinkKey(i),
      label: (_STAR_NAMES[i] || t('alm_star')) + ' \u00b7 ' + _orrNum(p.alt, null, 0) + '\u00b0 ' +
             _azCompass(p.az) + ' \u00b7 mag ' + _orrNum(mag, null, 1)
    });
  }

  // The planets where the live sky has them (_skyPlanet: their real orbits,
  // inclination and all, of date).
  var T = _jdToJulianCentury(JD), P = _skyPrecession(T);
  var planetsUp = [];
  for (var pi = 0; pi < _VISIBLE_PLANETS.length; pi++) {
    var nm = _VISIBLE_PLANETS[pi];
    var pq = _skyPlanet(nm, T, P);
    var aa = altAz(pq.ra, pq.dec);
    if (aa.alt < 0) continue;
    var pp = project(aa.alt, aa.az);
    var col = _PLANETS[nm] ? _PLANETS[nm].color : amber;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(pp.x, pp.y, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = col;
    ctx.font = 'bold 9px system-ui, sans-serif';
    drawLabel(_tp(nm), pp.x, pp.y, 5);
    _starChartBodies.push({
      x: pp.x, y: pp.y, key: 'planet:' + nm.toLowerCase(),
      label: _tp(nm) + ' \u00b7 ' + _orrNum(aa.alt, null, 0) + '\u00b0 ' + _azCompass(aa.az)
    });
    planetsUp.push(_tp(nm));
  }

  // The Moon.
  var mp = _moonPosition(now, lat, lon);
  var moonUp = mp.altitude > 0;
  if (moonUp) {
    var mpp = project(mp.altitude, mp.azimuth);
    ctx.fillStyle = '#f4f4e8';
    ctx.beginPath(); ctx.arc(mpp.x, mpp.y, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 0.5; ctx.stroke();
    _starChartBodies.push({
      x: mpp.x, y: mpp.y, key: 'planet:moon',
      label: t('alm_moon') + ' \u00b7 ' + _orrNum(mp.altitude, null, 0) + '\u00b0 ' +
             _azCompass(mp.azimuth) + ' \u00b7 ' + _moonPhase(now).illumination + '%'
    });
  }

  var cap = document.getElementById('almanac-starchart-caption');
  if (cap) {
    var coords = _skyCoords(lat, lon);
    var where = (!panned && loc.name) ? _almEsc(loc.name) : coords;
    cap.innerHTML = '<div class="alm-starchart-now">' + t('alm_stars_above') + ' ' + where +
      (panned ? ' <button class="alm-sc-reset" onclick="_starChartResetLoc()">' + _almEsc(t('alm_my_location')) + '</button>' : '') + '</div>' +
      '<div class="alm-starchart-desc">' + starCount + ' ' + t('alm_stars_up') +
      (planetsUp.length ? ' · ' + planetsUp.join(', ') : '') +
      (moonUp ? ' · ' + t('alm_moon') : '') + '</div>';
  }
}
