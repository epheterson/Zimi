// ── Almanac: the live sky + star chart ──
// The observer's own sky on the page's one clock (now, or wherever the time
// machine stands): the horizon, the bright stars, the planets, the Moon and
// the Sun where they truly are, and the sky's colour from the Sun's real
// altitude. Then the planisphere, and the bright-star catalogue both share.
// Loaded before almanac.js; all almanac scripts share one global scope.

// The frame loop runs only while something moves (the Moon gliding to a new
// instant, the hero's sweep, a muon falling); a still sky is painted once
// and then by timers: the live clock's drift and a slow twinkle.
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
  s.moonAnim = { from: _skyMoonAt(s, ts), to: toMoonData, start: ts, fromTime: fromTime, toTime: toTime };
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
  0: 'Betelgeuse', 1: 'Rigel', 7: 'Dubhe', 19: 'Antares', 25: 'Shaula',
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
  return 'star:' + nm.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');
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
  var r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z), R = Math.sqrt(e.x * e.x + e.y * e.y + e.z * e.z);
  return { ra: rd.ra, dec: rd.dec, mag: _planetMagnitude(name, r, Math.sqrt(gx * gx + gy * gy + gz * gz), R) };
}

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
    planets.push({ name: nm, alt: _skyRefract(ph.alt), az: ph.az, mag: pq.mag });
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
    moon: _moonPosition(now, lat, lon), planets: planets, stars: stars, galaxy: galaxy
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
var SKY_SPAN_DEG = 240;
var SKY_HORIZON_Y = 0.8;          // the horizon, as a share of the height
var SKY_ZENITH_Y = 0.05;          // where 90 degrees of altitude would stand
var SKY_HILLS = 0.016;            // the hills' height, as a share of the height
var SKY_LIVE_MS = 30000;          // live, the sky is recomputed this often (it turns 0.125 deg)
var SKY_TWINKLE_MS = 1500;        // a still sky's slow twinkle
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
// The faintest magnitude that shows, by the Sun's geometric altitude.
var SKY_LIMIT_MAG = [[-90, 4.6], [-18, 4.6], [-12, 3.5], [-6, 1.5], [0, -2], [10, -4], [90, -4]];

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
function _skyLimitingMag(alt) { var r = _skyRow(SKY_LIMIT_MAG, alt); return _skyLerp(r.a[1], r.b[1], r.f); }
// How much of the day's light there is, 0 at the end of civil twilight to 1 by day.
function _skyDaylight(alt) { return _skyClamp((alt - SKY_CIVIL_ALT) / (6 - SKY_CIVIL_ALT), 0, 1); }
// How dark for the faint sky (the Milky Way, constellation lines): 0 in
// nautical twilight to 1 by astronomical night.
function _skyDarkness(alt) { return _skyClamp((SKY_NAUTICAL_ALT + 2 - alt) / 6, 0, 1); }
// How far a bright Moon washes out the faint sky (magnitudes).
function _skyMoonGlare(moonAlt, illum) { return moonAlt > 0 ? 1.2 * (illum / 100) * _skyClamp(moonAlt / 10, 0, 1) : 0; }
// The phase of the day the Sun's geometric altitude names.
function _skyPhaseKey(alt) {
  return alt > SKY_DAY_ALT ? 'alm_sky_day' : alt > SKY_CIVIL_ALT ? 'alm_sky_civil'
    : alt > SKY_NAUTICAL_ALT ? 'alm_sky_nautical' : alt > SKY_ASTRO_ALT ? 'alm_sky_astro' : 'alm_sky_night';
}

// Screen position (device px) of an altitude/azimuth, and whether it is in view.
function _skyX(s, az) { return s.W / 2 + (((az - s.center) % 360 + 540) % 360 - 180) / SKY_SPAN_DEG * s.W; }
function _skyY(s, alt) { var yh = s.H * SKY_HORIZON_Y; return yh - alt * (yh - s.H * SKY_ZENITH_Y) / 90; }
function _skyInView(s, x, margin) { return x >= -margin && x <= s.W + margin; }

// The sky's own light: the gradient, the glow on the Sun's side, the Milky Way.
function _skyPaintSky(ctx, s) {
  var e = s.eph, g = e.sunGeoAlt, W = s.W, H = s.H, yh = H * SKY_HORIZON_Y;
  var tone = _skyTone(g), glare = _skyMoonGlare(e.moon.altitude, s.moonData.phase.illumination);
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
    ctx.fillRect(0, 0, W, yh + H * SKY_HILLS);
  }
  var dark = _skyDarkness(g) * (1 - 0.7 * _skyClamp(glare, 0, 1));
  if (dark > 0) _skyPaintGalaxy(ctx, s, dark);
}

// The Milky Way as a few soft strokes along the galactic equator, each one
// path (so its overlaps never stack into beads), the last only where the band
// is bright toward the centre. Breaks where the band wraps out of the view.
var SKY_GALAXY_PASSES = [[16, 0.035, 0], [8, 0.035, 0], [10, 0.04, 0.7]];   // width (deg), alpha, from weight
function _skyPaintGalaxy(ctx, s, dark) {
  var pts = s.eph.galaxy, degPx = s.W / SKY_SPAN_DEG;
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

// The stars: size and brightness from magnitude, washed out by the Sun and a
// bright Moon, dimmer low down where the air is thick; a slow twinkle (more
// near the horizon) unless motion is reduced. The named stars become tap targets.
function _skyPaintStars(ctx, s) {
  var e = s.eph, g = e.sunGeoAlt, dpr = s.dpr;
  var lm = _skyLimitingMag(g) - _skyMoonGlare(e.moon.altitude, s.moonData.phase.illumination);
  var tw = s.twinkle > 0;
  var drawn = {};
  for (var i = 0; i < e.stars.length; i++) {
    var st = e.stars[i], look = _skyStarLook(st.mag);
    var a = _skyClamp((lm - st.mag + 0.4) / 1.4, 0, 1) * _skyClamp(st.alt / 6, 0.3, 1) * look.k;
    if (a < 0.02) continue;
    var x = _skyX(s, st.az);
    if (!_skyInView(s, x, 4)) continue;
    var y = _skyY(s, st.alt);
    if (tw) a *= 1 + (0.06 + 0.18 * (1 - Math.min(st.alt, 45) / 45)) * Math.sin(st.phase + s.twinkle * 2.39996);
    a = _skyClamp(a, 0, 1);
    var r = _skyStarDevR(look.r, dpr);
    if (look.bloom && a > 0.4) _skyStarBloom(ctx, x, y, r, st.tint, a);
    ctx.fillStyle = 'rgba(' + st.tint + ',' + a.toFixed(3) + ')';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    if (st.idx >= 0) {
      drawn[st.idx] = { x: x, y: y };
      if (_STAR_NAMES[st.idx] && a > 0.3) s.bodies.push({ type: 'star', idx: st.idx, x: x / dpr, y: y / dpr, r: r / dpr, alt: st.alt, az: st.az, mag: st.mag });
    }
  }
  // Constellation lines, faint, once it is dark.
  var dark = _skyDarkness(g);
  if (dark > 0) {
    ctx.strokeStyle = 'rgba(120,150,210,' + (0.16 * dark).toFixed(3) + ')';
    ctx.lineWidth = 0.6 * dpr;
    ctx.beginPath();
    for (var k = 0; k < _CONST_LINES.length; k++) {
      var p = drawn[_CONST_LINES[k][0]], q = drawn[_CONST_LINES[k][1]];
      if (p && q && Math.abs(p.x - q.x) < s.W / 2) { ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
    }
    ctx.stroke();
  }
}

function _skyBodyR(s) { return _skyClamp(s.cssW * 0.022, SKY_BODY_PX[0], SKY_BODY_PX[1]) * s.dpr; }

// The planets: a point each, in its own colour, as bright as its magnitude
// and the sky allow. Named on a tap.
function _skyPaintPlanets(ctx, s) {
  var e = s.eph, lm = _skyLimitingMag(e.sunGeoAlt) - _skyMoonGlare(e.moon.altitude, s.moonData.phase.illumination);
  for (var i = 0; i < e.planets.length; i++) {
    var p = e.planets[i];
    if (p.alt < 0) continue;
    var x = _skyX(s, p.az);
    if (!_skyInView(s, x, 0)) continue;
    var a = _skyClamp((lm - p.mag + 0.6) / 1.4, 0, 1) * _skyClamp(p.alt / 4, 0.4, 1);
    if (a < 0.05) continue;
    // A planet is a point too, a little fuller than a star of its brightness
    // (it does not twinkle, and its steady light reads as a touch larger).
    var y = _skyY(s, p.alt), r = _skyStarDevR(_skyStarLook(p.mag).r * SKY_PLANET_R_X, s.dpr);
    var col = _PLANETS[p.name].glow;
    var gg = ctx.createRadialGradient(x, y, 0, x, y, r * 3.2);
    gg.addColorStop(0, _hexToRgba(col, 0.35 * a));
    gg.addColorStop(1, _hexToRgba(col, 0));
    ctx.fillStyle = gg;
    ctx.beginPath(); ctx.arc(x, y, r * 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = _hexToRgba(col, a);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    if (a > 0.15) s.bodies.push({ type: 'planet', name: p.name, x: x / s.dpr, y: y / s.dpr, r: r / s.dpr, alt: p.alt, az: p.az, mag: p.mag });
  }
}

// ── The Sun in the sky ──
// Its light comes through the air: the longer the path (the airmass), the
// more blue is scattered out of it, so it whitens high up and reddens low
// (Kasten & Young 1989 airmass; per-colour optical depths, Rayleigh plus a
// little haze, at 650/550/450 nm). Near the horizon refraction lifts its
// lower limb more than its upper and flattens it. Its face is limb-darkened
// as the 3D view's is (_sunLimb), and it blooms against the sky.
var SKY_SUN_DEPTH = [0.10, 0.14, 0.22];   // optical depth per airmass, red/green/blue
var SKY_SUN_EXPOSURE = [1.6, 6];          // the face's exposure on the horizon and from 10 degrees up (dimmer through more air)
var SKY_SUN_SEMIDIAMETER = 0.2666;        // degrees, the real disc's (refraction's flattening is the real one)
var SKY_SUN_STOPS = [0, 0.35, 0.6, 0.8, 0.92, 0.98, 1];   // radii where the face's gradient is sampled

// Airmass at an apparent altitude (degrees), Kasten & Young (1989).
function _skyAirmass(alt) {
  var h = Math.max(alt, -0.5);
  return 1 / (Math.sin(h * DEG_TO_RAD) + 0.50572 * Math.pow(h + 6.07995, -1.6364));
}
// The sunlight's colour after the air, scaled so its brightest channel is 1.
function _skySunTint(alt) {
  var m = _skyAirmass(alt), t = SKY_SUN_DEPTH.map(function (k) { return Math.exp(-k * m); });
  var top = Math.max(t[0], t[1], t[2]);
  return t.map(function (x) { return x / top; });
}
// How round the disc stays (vertical over horizontal), the refraction at its
// lower limb less that at its upper, over its diameter; alt is the centre's true altitude.
function _skySunFlattening(alt) {
  var lo = _skyRefract(alt - SKY_SUN_SEMIDIAMETER) - (alt - SKY_SUN_SEMIDIAMETER);
  var hi = _skyRefract(alt + SKY_SUN_SEMIDIAMETER) - (alt + SKY_SUN_SEMIDIAMETER);
  return _skyClamp(1 - (lo - hi) / (2 * SKY_SUN_SEMIDIAMETER), 0.6, 1);
}

function _skyPaintSun(ctx, s) {
  var sun = s.eph.sun;
  if (sun.alt < -2) return;
  var x = _skyX(s, sun.az), R = _skyBodyR(s);
  if (!_skyInView(s, x, R * 8)) return;
  var y = _skyY(s, sun.alt), tint = _skySunTint(sun.alt), flat = _skySunFlattening(s.eph.sunGeoAlt);
  var expo = _skyLerp(SKY_SUN_EXPOSURE[0], SKY_SUN_EXPOSURE[1], _skyClamp(sun.alt / 10, 0, 1));
  var c255 = tint.map(function (v) { return 255 * v; });
  // The bloom: a wide soft light and a bright close halo, added to the sky.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  var wide = ctx.createRadialGradient(x, y, R, x, y, R * 8);
  wide.addColorStop(0, _skyRgb(c255, 0.32));
  wide.addColorStop(0.3, _skyRgb(c255, 0.08));
  wide.addColorStop(1, _skyRgb(c255, 0));
  ctx.fillStyle = wide;
  ctx.beginPath(); ctx.arc(x, y, R * 8, 0, Math.PI * 2); ctx.fill();
  var halo = ctx.createRadialGradient(x, y, R * 0.9, x, y, R * 2.2);
  halo.addColorStop(0, _skyRgb(c255, 0.38 - 0.16 * _skyDaylight(s.eph.sunGeoAlt)));
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
    face.addColorStop(r, _skyRgb([0, 1, 2].map(function (k) { return 255 * (1 - Math.exp(-expo * tint[k] * ld[k])); })));
  }
  ctx.fillStyle = face;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  if (sun.alt > SKY_REFRACTION_FROM_DEG) s.bodies.push({ type: 'sun', x: x / s.dpr, y: y / s.dpr, r: R / s.dpr, alt: sun.alt, az: sun.az });
}

// The Moon at its place, phase and turn: the hero's own shaded sprite from the
// canonical _moonView (app.js), so the terminator and the maria lie as on the
// hero disc and the lit limb faces the true Sun. Pale by day.
function _skyPaintMoon(ctx, s, md) {
  var pos = md.pos;
  if (pos.altitude < -2) return;
  var x = _skyX(s, pos.azimuth);
  if (!_skyInView(s, x, _skyBodyR(s))) return;
  var y = _skyY(s, pos.altitude), R = _skyBodyR(s), day = _skyDaylight(s.eph.sunGeoAlt);
  if (day < 0.5) {
    var ga = (md.phase.illumination / 100) * 0.16 * (1 - day * 2);
    var mg = ctx.createRadialGradient(x, y, R, x, y, R * 3);
    mg.addColorStop(0, 'rgba(220,215,200,' + ga.toFixed(3) + ')');
    mg.addColorStop(1, 'rgba(220,215,200,0)');
    ctx.fillStyle = mg;
    ctx.beginPath(); ctx.arc(x, y, R * 3, 0, Math.PI * 2); ctx.fill();
  }
  var view = md.view;
  var spr = (typeof _moonSpriteCanvas === 'function' && _moonTexReady) ? _moonSpriteCanvas(view, R / s.dpr) : null;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((md.tilt != null ? md.tilt : view.tilt) * DEG_TO_RAD);
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.clip();
  // By night the whole disc, earthshine and all; by day only its light adds
  // to the sky's (the dark side is the sky's own blue, as it is overhead).
  var draw = function () {
    if (spr) ctx.drawImage(spr, -R, -R, R * 2, R * 2);
    else { ctx.fillStyle = '#d8d2c0'; ctx.fillRect(-R, -R, R * 2, R * 2); }
  };
  if (day < 1) { ctx.globalAlpha = 1 - day; draw(); }
  if (day > 0) { ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = 0.9 * day; draw(); }
  ctx.restore();
  if (pos.altitude > SKY_REFRACTION_FROM_DEG) s.bodies.push({ type: 'moon', x: x / s.dpr, y: y / s.dpr, r: R / s.dpr, alt: pos.altitude, az: pos.azimuth });
}

// ══ Muons ═════════════════════════════════════════════════════════════════
// Every minute about ten thousand muons cross each square metre at sea level,
// made by cosmic rays some 15 km up. A faint streak now and then stands for
// them; a tap tells why any reach the ground. The Feynman Lectures on Physics,
// Vol. I, ch. 15-4. Muon lifetime 2.197 us: Particle Data Group (2024).
var MUON_LIFETIME_S = 2.197e-6;
var MUON_BETA = 0.998;
var MUON_HEIGHT_M = 15000;
var SKY_MUON_FIRST_MS = 6000;     // the first after the page has settled
var SKY_MUON_GAP_MS = [12000, 30000];
var SKY_MUON_FALL_MS = 450;
var SKY_MUON_FADE_MS = 2600;
var SKY_MUON_FADE_STEP_MS = 400;  // the trace fades in steps this far apart
var SKY_MUON_ALPHA = 0.5;

// The muon's numbers, all from the three above.
function _muonFacts() {
  var gamma = _lorentzFactor(MUON_BETA), v = MUON_BETA * SPEED_OF_LIGHT_M_S;
  var fall = MUON_HEIGHT_M / v;                 // the fall, by a clock on the ground
  var own = fall / gamma;                       // the same fall, by the muon's clock
  return {
    gamma: gamma, fall: fall, own: own,
    reach: v * MUON_LIFETIME_S,                 // how far it goes in one lifetime, were its clock not slow
    reachSlow: v * MUON_LIFETIME_S * gamma,     // how far it goes, its clock slow
    survive: Math.exp(-own / MUON_LIFETIME_S),
    surviveNaive: Math.exp(-fall / MUON_LIFETIME_S)
  };
}

function _skyMuonSpawn(s, ts) {
  var r = _lcgRand(Math.floor(ts) % 2147483646 + 1);
  s.muons.push({ x: 0.08 + 0.84 * r(), lean: (r() - 0.5) * 0.12, start: ts });
}
// A muon's streak at ts: its top and its head (device px) and how bright.
function _skyMuonAt(s, m, ts) {
  var y0 = s.H * 0.03, y1 = s.H * SKY_HORIZON_Y;
  var x0 = m.x * s.W, x1 = x0 + m.lean * s.W;
  if (m.still) return { x0: x0, y0: y0, x1: x1, y1: y1, a: SKY_MUON_ALPHA * 0.6 };
  var age = ts - m.start, p = _skyClamp(age / SKY_MUON_FALL_MS, 0, 1);
  var a = age < SKY_MUON_FALL_MS ? SKY_MUON_ALPHA : SKY_MUON_ALPHA * (1 - (age - SKY_MUON_FALL_MS) / SKY_MUON_FADE_MS);
  return { x0: x0, y0: y0, x1: _skyLerp(x0, x1, p), y1: _skyLerp(y0, y1, p), a: a };
}
function _skyPaintMuons(ctx, s, ts) {
  var keep = [];
  for (var i = 0; i < s.muons.length; i++) {
    var m = s.muons[i], k = _skyMuonAt(s, m, ts);
    if (k.a <= 0) continue;
    keep.push(m);
    var g = ctx.createLinearGradient(k.x0, k.y0, k.x1, k.y1);
    g.addColorStop(0, 'rgba(190,220,255,0)');
    g.addColorStop(1, 'rgba(190,220,255,' + k.a.toFixed(3) + ')');
    ctx.strokeStyle = g;
    ctx.lineWidth = 1.2 * s.dpr;
    ctx.beginPath(); ctx.moveTo(k.x0, k.y0); ctx.lineTo(k.x1, k.y1); ctx.stroke();
    s.bodies.push({ type: 'muon', x0: k.x0 / s.dpr, y0: k.y0 / s.dpr, x1: k.x1 / s.dpr, y1: k.y1 / s.dpr });
  }
  s.muons = keep;
}

// ══ Life on the horizon ══════════════════════════════════════════════════
// What a person standing there would see besides the sky: the sea when the
// place is on the coast (its shore where today's tide has it), else the
// land; boats on the sea's edge, lit at night; airliners crossing with their
// navigation lights; birds by day; meteors by night, more on a shower's
// peak; the aurora where it is seen; the ISS on its real track when it is
// overhead and lit. Each is tapped to say what it is. Boats, the sea and the
// aurora belong to the still picture; planes, birds, meteors, muons and the
// ISS move, and only while one of them is on screen does a light loop run.

var SKY_EYE_KM = 3.57;            // the sea's edge, km, times the square root of eye height in metres
var SKY_EYE_M = 1.7;
var SKY_SHORE = [0.2, 0.62];      // the beach's share of the ground band, high water and low
var SKY_SEA_ROWS = 16;            // the swell's lines, nearer ones further apart
var SKY_BOATS = [[23, 3.2, 1, 'sail'], [151, 2.1, -1, 'ship'], [277, 4.4, 1, 'fish']];   // azimuth seed, deg/hour, way, kind
var SKY_ACTOR_FRAME_MS = 33;      // the moving things' frames: thirty a second is smooth at this size
var SKY_PLANE_GAP_S = [25, 70], SKY_PLANE_S = [22, 34], SKY_PLANE_ALT = [12, 48];
var SKY_BIRD_GAP_S = [30, 80], SKY_BIRD_S = [14, 22], SKY_BIRD_ALT = [4, 14];
var SKY_METEOR_SPORADIC_HR = 6;   // sporadic meteors an hour, any dark night
var SKY_METEOR_SHOWER_DAYS = 1.5; // a shower's rate falls by e every this many days from its peak
var SKY_METEOR_SPEEDUP = 10;      // meteors fall here this many times as often as in the real sky
var SKY_METEOR_MS = [450, 900];
var SKY_MAG_POLE = [80.8, -72.6]; // the geomagnetic north pole (IGRF, 2025), degrees
var SKY_AURORA_LAT = 66, SKY_AURORA_REACH = 4;   // where the oval stands quietly (geomagnetic), how far equatorward an active Sun pushes it
var SKY_ISS_MIN_ALT = 8;          // the ISS is drawn above this altitude, lit, in a dark enough sky
var SKY_SPAN_HALF = SKY_SPAN_DEG / 2;

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

// The land: two ridges, the far one paler, tied to azimuth so they turn as
// the view turns. Heights in device px above the horizon.
function _skyRidge(s, az, far) {
  var a = az * DEG_TO_RAD;
  var k = far ? [4, 11, 29] : [7, 17, 43];
  return s.H * SKY_HILLS * (far ? 1.6 : 1) * (0.55 + 0.25 * Math.sin(k[0] * a + (far ? 2.1 : 1.3)) +
    0.15 * Math.sin(k[1] * a + 0.4) + 0.05 * Math.sin(k[2] * a));
}
function _skyAzAt(s, x) { return s.center + (x / s.W - 0.5) * SKY_SPAN_DEG; }
function _skyHillAt(s, x) { return _skyRidge(s, _skyAzAt(s, x), false); }
function _skyPaintLand(ctx, s, light) {
  var W = s.W, H = s.H, yh = H * SKY_HORIZON_Y, step = 3 * s.dpr;
  var tone = _skyTone(s.eph.sunGeoAlt).hor;
  // The far ridge, hazed toward the sky's own horizon colour.
  ctx.fillStyle = _skyRgb(_skyMix(_skyMix([14, 18, 26], [70, 86, 82], light), tone, 0.45));
  ctx.beginPath(); ctx.moveTo(0, H);
  for (var x = 0; x <= W + step; x += step) ctx.lineTo(x, yh - _skyRidge(s, _skyAzAt(s, x), true));
  ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  var top = _skyMix([10, 13, 20], [40, 52, 44], light), bottom = _skyMix([5, 7, 11], [24, 31, 27], light);
  var grad = ctx.createLinearGradient(0, yh - H * SKY_HILLS, 0, H);
  grad.addColorStop(0, _skyRgb(top));
  grad.addColorStop(1, _skyRgb(bottom));
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.moveTo(0, H);
  for (x = 0; x <= W + step; x += step) ctx.lineTo(x, yh - _skyHillAt(s, x));
  ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  // A few trees on the near ridge, at fixed bearings.
  ctx.fillStyle = _skyRgb(_skyMix(top, [0, 0, 0], 0.35));
  for (var az = 3; az < 360; az += 17 + (az % 7)) {
    var tx = _skyX(s, az);
    if (!_skyInView(s, tx, 6 * s.dpr)) continue;
    var th = (5 + (az % 5)) * s.dpr * s.scale, ty = yh - _skyHillAt(s, tx) + 1;
    ctx.beginPath(); ctx.moveTo(tx, ty - th); ctx.lineTo(tx - th * 0.32, ty); ctx.lineTo(tx + th * 0.32, ty); ctx.closePath(); ctx.fill();
  }
}

// The sea: the sky's horizon colour carried down and darkened, swell lines
// closer together toward the edge, a path of light under the Sun or the
// Moon, and the shore where the tide has it (more beach at low water).
function _skyPaintSea(ctx, s, light, ts) {
  var W = s.W, H = s.H, yh = H * SKY_HORIZON_Y, dpr = s.dpr, e = s.eph;
  var tone = _skyTone(e.sunGeoAlt).hor;
  var far = _skyMix(_skyMix(tone, [8, 26, 46], 0.5), [0, 0, 0], 0.25), near = _skyMix(far, [2, 6, 12], 0.6);
  var shore = yh + (H - yh) * (1 - _skyLerp(SKY_SHORE[0], SKY_SHORE[1], 1 - s.sea.frac));
  var g = ctx.createLinearGradient(0, yh, 0, H);
  g.addColorStop(0, _skyRgb(far)); g.addColorStop(1, _skyRgb(near));
  ctx.fillStyle = g;
  ctx.fillRect(0, yh, W, H - yh);
  // The swell: short strokes, their places fixed to bearings so they turn
  // with the view; a slow shimmer on the twinkle's clock.
  var r = _lcgRand(97), ink = _skyMix(tone, [255, 255, 255], 0.3);
  ctx.lineWidth = Math.max(1, 0.8 * dpr);
  for (var row = 1; row <= SKY_SEA_ROWS; row++) {
    var f = Math.pow(row / SKY_SEA_ROWS, 1.8), y = yh + (shore - yh) * f;
    if (y >= shore - dpr) break;
    ctx.strokeStyle = _skyRgb(ink, 0.05 + 0.1 * light);
    ctx.beginPath();
    for (var k = 0; k < 9; k++) {
      var az = r() * 360 + (s.twinkle % 7) * 0.3 * (row % 2 ? 1 : -1), x = _skyX(s, az), len = (6 + 18 * f) * dpr * r();
      if (_skyInView(s, x, len)) { ctx.moveTo(x - len / 2, y); ctx.lineTo(x + len / 2, y); }
    }
    ctx.stroke();
  }
  // The light's path on the water, under the Sun or else the Moon.
  var md = s.moonData, body = e.sun.alt > -1 ? { alt: e.sun.alt, az: e.sun.az, k: 0.55, c: _skySunTint(e.sun.alt).map(function (v) { return 255 * v; }) }
    : md.pos.altitude > 0 ? { alt: md.pos.altitude, az: md.pos.azimuth, k: 0.45 * md.phase.illumination / 100, c: [230, 225, 205] } : null;
  if (body && body.alt < 55) {
    var bx = _skyX(s, body.az);
    if (_skyInView(s, bx, W * 0.1)) {
      var rr = _lcgRand(31 + (s.twinkle % 5));
      for (var i = 0; i < 46; i++) {
        var q = Math.pow(rr(), 0.7), gy = yh + (shore - yh) * q;
        var spread = (2 + 26 * q) * dpr * (1 - body.alt / 70), gw = (2 + 9 * q) * dpr * rr();
        ctx.fillStyle = _skyRgb(body.c, body.k * (0.35 + 0.65 * rr()) * (1 - 0.5 * q));
        ctx.fillRect(bx + (rr() - 0.5) * 2 * spread - gw / 2, gy, gw, Math.max(1, 0.7 * dpr));
      }
    }
  }
  // The shore: wet sand, a line of foam, dry sand.
  var sand = _skyMix([24, 24, 28], [196, 178, 140], light), wet = _skyMix(sand, near, 0.45);
  ctx.beginPath(); ctx.moveTo(0, H);
  var step = 4 * dpr;
  for (var sx = 0; sx <= W + step; sx += step) {
    var sa = _skyAzAt(s, sx) * DEG_TO_RAD;
    ctx.lineTo(sx, shore + dpr * (1.6 * Math.sin(sa * 9) + 0.7 * Math.sin(sa * 21 + 1)));
  }
  ctx.lineTo(W, H); ctx.closePath();
  var sg = ctx.createLinearGradient(0, shore, 0, H);
  sg.addColorStop(0, _skyRgb(wet)); sg.addColorStop(0.35, _skyRgb(sand)); sg.addColorStop(1, _skyRgb(_skyMix(sand, [0, 0, 0], 0.3)));
  ctx.fillStyle = sg;
  ctx.fill();
  ctx.strokeStyle = 'rgba(240,244,248,' + (0.18 + 0.32 * light).toFixed(3) + ')';
  ctx.lineWidth = 1.2 * dpr;
  ctx.stroke();
  s.bodies.push({ type: 'sea', box: [0, yh / dpr + 2, W / dpr, shore / dpr] });
  _skyPaintBoats(ctx, s, light);
}

// The boats, on the sea's edge, each on its own slow course by the page's
// clock. By day a shape against the light; by night only their lights:
// white at the masthead, red to port and green to starboard (a boat going
// right shows its starboard side to the shore).
function _skyPaintBoats(ctx, s, light) {
  var yh = s.H * SKY_HORIZON_Y, dpr = s.dpr, hours = s.nowTime / 3600000, night = 1 - light;
  for (var i = 0; i < SKY_BOATS.length; i++) {
    var b = SKY_BOATS[i], az = ((b[0] + b[1] * b[2] * hours) % 360 + 360) % 360, x = _skyX(s, az);
    var u = s.scale * dpr;
    if (!_skyInView(s, x, 20 * u)) continue;
    var len = (b[3] === 'ship' ? 16 : b[3] === 'sail' ? 7 : 9) * u, hull = (b[3] === 'ship' ? 2.6 : 1.8) * u;
    if (light > 0.05) {
      ctx.fillStyle = _skyRgb(_skyMix([30, 34, 44], [16, 20, 28], night), Math.min(1, light * 1.4));
      ctx.beginPath(); ctx.moveTo(x - len / 2, yh - hull); ctx.lineTo(x + len / 2, yh - hull); ctx.lineTo(x + len * 0.4, yh); ctx.lineTo(x - len * 0.4, yh); ctx.closePath(); ctx.fill();
      if (b[3] === 'sail') {
        ctx.fillStyle = _skyRgb([236, 236, 230], Math.min(1, light * 1.4));
        ctx.beginPath(); ctx.moveTo(x, yh - hull - 9 * u); ctx.lineTo(x + 4 * u * b[2], yh - hull - 0.5 * u); ctx.lineTo(x, yh - hull - 0.5 * u); ctx.closePath(); ctx.fill();
      } else if (b[3] === 'ship') {
        ctx.fillRect(x - len * 0.35 * b[2] - 2 * u, yh - hull - 3 * u, 4 * u, 3 * u);
      } else {
        ctx.fillRect(x - 1 * u, yh - hull - 3.5 * u, 3 * u, 3.5 * u);
      }
    }
    if (night > 0.3) {
      var a = (night - 0.3) / 0.7, mast = yh - hull - (b[3] === 'sail' ? 9 : 4) * u;
      _skyLight(ctx, x, mast, 1.1 * dpr, [255, 250, 230], a);
      _skyLight(ctx, x + b[2] * len * 0.3, yh - hull - 0.6 * u, 0.9 * dpr, b[2] > 0 ? [80, 255, 120] : [255, 70, 60], a);
    }
    s.bodies.push({ type: 'boat', kind: b[3], x: x / dpr, y: (yh - hull) / dpr, r: Math.max(4, len / dpr / 2) });
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

// The ground (land or sea) and the compass along the horizon.
function _skyPaintGround(ctx, s, ts) {
  var light = _skyDaylight(s.eph.sunGeoAlt);
  if (s.sea) _skyPaintSea(ctx, s, light, ts); else _skyPaintLand(ctx, s, light);
  var yh = s.H * SKY_HORIZON_Y, dpr = s.dpr;
  ctx.font = '600 ' + Math.round(10 * dpr) + 'px -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  var ink = light > 0.5 ? 'rgba(235,240,232,0.62)' : 'rgba(200,210,230,0.5)';
  if (s.sea && light > 0.5) ink = 'rgba(20,28,40,0.55)';
  for (var az = 0; az < 360; az += 45) {
    var cx = _skyX(s, az);
    if (!_skyInView(s, cx, -6 * dpr)) continue;
    ctx.fillStyle = ink;
    ctx.fillRect(cx - 0.5 * dpr, yh + 1 * dpr, 1 * dpr, 3 * dpr);
    ctx.fillText(_azCompass(az), cx, yh + 6 * dpr);
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
  if (!au) return;
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
    ctx.fillRect(x - step / SKY_SPAN_DEG * s.W, y1, step / SKY_SPAN_DEG * s.W * 1.6, Math.min(y0, yh) - y1);
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
  var from = s.center - dir * (SKY_SPAN_HALF + 6), to = s.center + dir * (SKY_SPAN_HALF + 6);
  return { type: type, start: performance.now(), dur: _skyRandIn(_skyRand, durS) * 1000, dir: dir,
    az0: from, az1: to, alt0: alt, alt1: alt + (_skyRand() - 0.5) * 8 };
}
// Meteors an hour at the scene's instant: the sporadic background and the
// showers near their peaks (almanac.js _METEOR_SHOWERS); and the busiest.
function _skyMeteorRate(s) {
  var rate = SKY_METEOR_SPORADIC_HR, best = null, d = new Date(s.nowTime);
  if (typeof _METEOR_SHOWERS !== 'undefined') {
    for (var i = 0; i < _METEOR_SHOWERS.length; i++) {
      var sh = _METEOR_SHOWERS[i], days = Infinity;
      for (var y = d.getUTCFullYear() - 1; y <= d.getUTCFullYear() + 1; y++) {
        days = Math.min(days, Math.abs(s.nowTime - Date.UTC(y, sh.peak[0] - 1, sh.peak[1])) / MS_PER_DAY);
      }
      var r = sh.zhr * Math.exp(-days / SKY_METEOR_SHOWER_DAYS);
      rate += r;
      if (r >= 2 && (!best || r > best.r)) best = { sh: sh, r: r };
    }
  }
  return { perHour: rate, shower: best };
}
function _skyMeteor(s) {
  var az = s.center + (_skyRand() - 0.5) * SKY_SPAN_DEG * 0.9, alt = 35 + 40 * _skyRand();
  var ang = (200 + 140 * _skyRand()) * DEG_TO_RAD, len = 6 + 10 * _skyRand();
  return { type: 'meteor', start: performance.now(), dur: _skyRandIn(_skyRand, SKY_METEOR_MS),
    az0: az, alt0: alt, az1: az + Math.cos(ang) * len, alt1: alt + Math.sin(ang) * len * 0.6 - len * 0.4 };
}
function _skyPaintActor(ctx, s, a, ts) {
  var p = _skyActorAt(a, ts), dpr = s.dpr;
  var az = a.az0 + (a.az1 - a.az0) * p, alt = a.alt0 + (a.alt1 - a.alt0) * p;
  var x = _skyX(s, az), y = _skyY(s, alt), u = s.scale * dpr, light = _skyDaylight(s.eph.sunGeoAlt);
  if (!_skyInView(s, x, 30 * dpr)) return;
  if (a.type === 'plane') {
    if (light > 0.15) {
      // A contrail, and the plane a dark speck at its head.
      var tx = _skyX(s, az - a.dir * 16);
      if (Math.abs(tx - x) < s.W / 2) {
        var cg = ctx.createLinearGradient(x, y, tx, y);
        cg.addColorStop(0, 'rgba(255,255,255,' + (0.5 * light).toFixed(3) + ')'); cg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.strokeStyle = cg; ctx.lineWidth = 1.4 * dpr;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(tx, y + (a.alt1 - a.alt0) * 0.5); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(40,46,58,' + (0.85 * light).toFixed(3) + ')';
      ctx.fillRect(x - 3 * u, y - 0.5 * u, 6 * u, 1.2 * u);
      ctx.fillRect(x - 0.6 * u, y - 2.4 * u, 1.4 * u, 5 * u);
    }
    if (light < 0.8) {
      var on = 1 - light, t = ts - a.start;
      _skyLight(ctx, x - a.dir * 3 * u, y, 0.8 * dpr, a.dir > 0 ? [255, 60, 50] : [70, 255, 110], 0.9 * on);
      _skyLight(ctx, x + a.dir * 3 * u, y, 0.8 * dpr, a.dir > 0 ? [70, 255, 110] : [255, 60, 50], 0.9 * on);
      if (t % 1000 < 60 || (t % 1000 > 160 && t % 1000 < 220)) _skyLight(ctx, x, y, 1.2 * dpr, [255, 255, 255], on);
      if (t % 1300 < 120) _skyLight(ctx, x, y - 1.2 * u, 1 * dpr, [255, 40, 30], on);
    }
    s.bodies.push({ type: 'plane', x: x / dpr, y: y / dpr, r: 6 });
  } else if (a.type === 'birds') {
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
    _skyPaintActor(ctx, s, a, ts);
  }
  s.actors = keep;
  // The ISS, on the page's clock (live: now, this frame).
  var iss = _skyIss(s, _skyLive() ? Date.now() : s.nowTime);
  s.issUp = !!iss && _skyLive();
  if (iss && s.eph.sunGeoAlt < SKY_CIVIL_ALT + 2) {
    var x = _skyX(s, iss.az);
    if (_skyInView(s, x, 4)) {
      var y = _skyY(s, iss.alt);
      _skyLight(ctx, x, y, 1.4 * s.dpr, [255, 246, 222], 1);
      s.bodies.push({ type: 'iss', x: x / s.dpr, y: y / s.dpr, r: 3, alt: iss.alt, az: iss.az, km: iss.km });
    }
  }
}
// Spawning: each timer adds one and sets the next; nothing while unseen.
function _skySpawnPlane() { _skySpawn('plane'); }
function _skySpawnBirds() { _skySpawn('birds'); }
function _skySpawnMeteor() { _skySpawn('meteor'); }
var SKY_SPAWNERS = { plane: _skySpawnPlane, birds: _skySpawnBirds, meteor: _skySpawnMeteor };
function _skySpawn(kind) {
  var s = _skyState;
  _skyTimers[kind] = 0;
  if (!_skyAwake(s) || _skyReduceMotion() || !s.eph) return;
  var g = s.eph.sunGeoAlt, gap;
  if (kind === 'plane') {
    s.actors.push(_skyCrossing(s, 'plane', SKY_PLANE_S, SKY_PLANE_ALT));
    gap = _skyRandIn(_skyRand, SKY_PLANE_GAP_S) * 1000;
  } else if (kind === 'birds') {
    if (g > 2) { var b = _skyCrossing(s, 'birds', SKY_BIRD_S, SKY_BIRD_ALT); b.n = 3 + Math.floor(_skyRand() * 5); s.actors.push(b); }
    gap = _skyRandIn(_skyRand, SKY_BIRD_GAP_S) * 1000;
  } else {
    if (g < SKY_NAUTICAL_ALT + 2) s.actors.push(_skyMeteor(s));
    // Exponential gaps at the shown rate (sped up; the tap says by how much).
    gap = -Math.log(Math.max(1e-6, _skyRand())) * 3600000 / (_skyMeteorRate(s).perHour * SKY_METEOR_SPEEDUP);
  }
  _skyKick();
  _skyTimers[kind] = setTimeout(SKY_SPAWNERS[kind], Math.max(400, gap));
}

// ══ Painting and the clock ═══════════════════════════════════════════════

// The still picture (sky, stars, bodies, aurora, ground and boats) is
// painted into its own canvas when something in it changes: the instant, a
// twinkle, the view turned, the Moon gliding. A frame is that picture and
// the moving things over it, so a plane crossing costs one copy and a few
// strokes, not a whole sky (a few thousand canvas calls, ~2-4 ms on a
// 4x-slowed phone).
function _skyPaintBase(s, ts) {
  if (!s.base) s.base = document.createElement('canvas');
  if (s.base.width !== s.W || s.base.height !== s.H) { s.base.width = s.W; s.base.height = s.H; }
  var ctx = s.base.getContext('2d');
  s.bodies = [];
  _skyPaintSky(ctx, s);
  _skyPaintAurora(ctx, s);
  _skyPaintStars(ctx, s);
  _skyPaintPlanets(ctx, s);
  _skyPaintSun(ctx, s);
  _skyPaintMoon(ctx, s, _skyMoonAt(s, ts));
  _skyPaintGround(ctx, s, ts);
  s.baseBodies = s.bodies;
  s.baseDirty = !!s.moonAnim;
}
function _skyPaint(ts) {
  var s = _skyState;
  if (!s || !s.eph || !s.canvas.isConnected) return;
  if (s.baseDirty || !s.base || s.moonAnim) _skyPaintBase(s, ts);
  var ctx = s.canvas.getContext('2d');
  ctx.clearRect(0, 0, s.W, s.H);
  ctx.drawImage(s.base, 0, 0);
  s.bodies = s.baseBodies.slice();
  // The moving things stay in the sky, never over the ground.
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, s.W, s.H * SKY_HORIZON_Y - _skyRidge(s, s.center, false) * 0.3); ctx.clip();
  _skyPaintActors(ctx, s, ts);
  _skyPaintMuons(ctx, s, ts);
  ctx.restore();
}

function _skyReduceMotion() { return typeof _almReduceMotion === 'function' && _almReduceMotion(); }
function _skyLive() { return typeof _almFocus === 'undefined' || !_almFocus; }
function _skyCovered() { return typeof _aeIsOpen !== 'undefined' && _aeIsOpen; }
function _skyAwake(s) { return s && s.inView && !document.hidden && !_skyCovered(); }

// Something is moving: the Moon's glide, the hero's sweep, a falling muon.
function _skyAnimating(s, ts) {
  if (s.moonAnim) return true;
  if (typeof _heroMoonAnim !== 'undefined' && _heroMoonAnim) return true;
  return _skyMuonsIn(s, ts, 0, SKY_MUON_FALL_MS);
}
// A plane, birds, a meteor or the ISS on screen: frames at SKY_ACTOR_FRAME_MS.
function _skyActorsMoving(s) { return s.actors.length > 0 || s.issUp; }
// Any moving muon whose age lies in [from, to) ms.
function _skyMuonsIn(s, ts, from, to) {
  for (var i = 0; i < s.muons.length; i++) {
    var age = ts - s.muons[i].start;
    if (!s.muons[i].still && age >= from && age < to) return true;
  }
  return false;
}
function _skyLoop(ts) {
  _almanacSkyRAF = null;
  var s = _skyState;
  if (!s) return;
  if (s.pending) { _skyCompute(s, s.pending); _skyArm(); }
  // With only the moving things moving, every other frame is enough.
  var onlyActors = !_skyAnimating(s, ts) && !s.baseDirty;
  if (_skyAwake(s) && !(onlyActors && ts - (s.paintedAt || 0) < SKY_ACTOR_FRAME_MS)) { _skyPaint(ts); s.paintedAt = ts; s.paints = (s.paints || 0) + 1; }
  // The hero's time-travel sweep rides this same loop (almanac.js).
  if (typeof _heroMoonTick === 'function') _heroMoonTick(ts);
  if (_skyAnimating(s, ts) || (_skyAwake(s) && _skyActorsMoving(s))) { _almanacSkyRAF = requestAnimationFrame(_skyLoop); return; }
  // A landed muon's trace fades in a few steps, not frame by frame.
  if (_skyMuonsIn(s, ts, 0, SKY_MUON_FALL_MS + SKY_MUON_FADE_MS)) {
    clearTimeout(_skyTimers.fade);
    _skyTimers.fade = setTimeout(_skyKick, SKY_MUON_FADE_STEP_MS);
  }
}
// Ask for a frame (one, or a run while something moves); never a second loop.
function _skyKick() {
  if (!_almanacSkyRAF && _skyState) _almanacSkyRAF = requestAnimationFrame(_skyLoop);
}

var _skyTimers = { live: 0, twinkle: 0, muon: 0, fade: 0, plane: 0, birds: 0, meteor: 0 };
var SKY_FIRST_SPAWN_MS = { plane: 4000, birds: 9000, meteor: 2500 };
function _skyDisarm() {
  for (var k in _skyTimers) { clearTimeout(_skyTimers[k]); _skyTimers[k] = 0; }
}
// The timers a still sky needs while it is seen: live, the clock's drift;
// unless motion is reduced, the twinkle (only with stars out) and the muons.
function _skyArm() {
  _skyDisarm();
  var s = _skyState;
  if (!_skyAwake(s) || !s.eph) return;
  if (_skyLive()) _skyTimers.live = setTimeout(_skyLiveTick, SKY_LIVE_MS);
  if (_skyReduceMotion()) return;
  if (s.eph.sunGeoAlt < -3) _skyTimers.twinkle = setTimeout(_skyTwinkleTick, SKY_TWINKLE_MS);
  var gap = s.muonCount ? SKY_MUON_GAP_MS[0] + Math.random() * (SKY_MUON_GAP_MS[1] - SKY_MUON_GAP_MS[0]) : SKY_MUON_FIRST_MS;
  _skyTimers.muon = setTimeout(_skyMuonTick, gap);
  Object.keys(SKY_FIRST_SPAWN_MS).forEach(function (kind) {
    _skyTimers[kind] = setTimeout(SKY_SPAWNERS[kind], SKY_FIRST_SPAWN_MS[kind] * (0.6 + 0.8 * Math.random()));
  });
}
function _skyLiveTick() {
  _skyTimers.live = 0;
  var s = _skyState;
  if (!_skyAwake(s) || !_skyLive()) return;
  _skyCompute(s, new Date());
  _skyKick();
  _skyTimers.live = setTimeout(_skyLiveTick, SKY_LIVE_MS);
}
function _skyTwinkleTick() {
  _skyTimers.twinkle = 0;
  var s = _skyState;
  if (!_skyAwake(s) || _skyReduceMotion() || s.eph.sunGeoAlt >= -3) return;
  s.twinkle++;
  s.baseDirty = true;
  _skyKick();
  _skyTimers.twinkle = setTimeout(_skyTwinkleTick, SKY_TWINKLE_MS);
}
function _skyMuonTick() {
  _skyTimers.muon = 0;
  var s = _skyState;
  if (!_skyAwake(s) || _skyReduceMotion()) return;
  s.muonCount = (s.muonCount || 0) + 1;
  _skyMuonSpawn(s, performance.now());
  _skyKick();
  _skyTimers.muon = setTimeout(_skyMuonTick, SKY_MUON_GAP_MS[0] + Math.random() * (SKY_MUON_GAP_MS[1] - SKY_MUON_GAP_MS[0]));
}

// Hidden tab, the 3D view over the page, the sky scrolled away: nothing runs.
function _skyPause() {
  _skyDisarm();
  if (_almanacSkyRAF) { cancelAnimationFrame(_almanacSkyRAF); _almanacSkyRAF = null; }
}
// Back in sight: live, catch up to now; then paint and re-arm.
function _skyResume() {
  var s = _skyState;
  if (!_skyAwake(s)) return;
  if (s.eph && _skyLive() && Date.now() - s.nowTime > SKY_LIVE_MS / 2) _skyCompute(s, new Date());
  _skyArm();
  _skyKick();
}
// Leaving the Almanac.
function _skyStop() {
  _skyPause();
  if (_skyState && _skyState.observer) _skyState.observer.disconnect();
  _skyHideTip();
  _skyState = null;
}

// The instant's values into the state, and the words that go with them.
function _skyCompute(s, now) {
  s.pending = null;
  var f = _skyFrame(now, s.lat, s.lon);
  s.now = now; s.nowTime = now.getTime();
  s.eph = f.eph; s.moonData = f.moonData;
  _skyGroundAt(s);
  _skyUpdateDesc(s);
  _skyCaption(s);
  return f;
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
  var w = wrap.clientWidth, h = Math.round(w / SKY_ASPECT);
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
    lat: lat, lon: lon, center: _skyHeading != null ? _skyHeading : (lat >= 0 ? 180 : 0),
    stored: loc.stored && loc.lat === lat && loc.lon === lon, name: loc.name || '',
    moonAnim: null, twinkle: 0, muons: [], bodies: [], baseBodies: [],
    actors: prev ? prev.actors : [], base: prev ? prev.base : null, baseDirty: true,
    muonCount: prev ? prev.muonCount : 0, inView: prev ? prev.inView : true,
    observer: prev && prev.observer
  };
  _skyState = s;
  if (prev) {
    var f = _skyCompute(s, now);
    if (priorMoon) s.moonAnim = { from: priorMoon, to: f.moonData, start: ts, fromTime: priorTime, toTime: now.getTime() };
  } else s.pending = now;
  // Motion reduced, a still muon stays in the sky to be tapped.
  if (_skyReduceMotion()) s.muons = [{ x: 0.86, lean: -0.03, start: 0, still: true }];
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
  _skyGroundAt(s);
  _skyKick();
}

// Screen-reader description of the sky. _tLookup falls back to English when a
// stale cached i18n file lacks these keys -- raw key names must never be
// spoken (issue #25).
function _skyUpdateDesc(s) {
  var srEl = document.getElementById('almanac-sky-desc');
  if (!srEl) return;
  var e = s.eph, sunAlt = e.sun.alt, moonPos0 = e.moon, moonM0 = s.moonData.phase;
  var when = s.now.toLocaleString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
  var sunDesc = sunAlt > 0
    ? _tLookup('alm_sun', 'Sun') + ' ' + sunAlt.toFixed(0) + '° ' + _tLookup('alm_a11y_above_horizon', 'above the horizon')
    : _tLookup('alm_sun', 'Sun') + ' ' + _tLookup('alm_a11y_below_horizon', 'below the horizon');
  var moonDesc;
  if (moonPos0.altitude > -2) {
    moonDesc = _tLookup('alm_moon', 'Moon') + ' ' + moonM0.illumination + '% ' + _tLookup('alm_a11y_illuminated', 'illuminated') +
      ', ' + moonPos0.altitude.toFixed(0) + '° ' + _tLookup('alm_a11y_altitude', 'high');
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
  return Math.abs(lat).toFixed(1) + '°' + (lat >= 0 ? 'N' : 'S') + ', ' + Math.abs(lon).toFixed(1) + '°' + (lon >= 0 ? 'E' : 'W');
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
  var facing = t('alm_sky_facing', { dir: _azCompass(s.center) });
  var html = '<span>' + phase + ' · ' + _almEsc(sunAlt) + ' · ' + _almEsc(facing) + '</span>' +
    (s.stored ? '<span class="alm-sky-place">' + _almEsc(s.name || _skyCoords(s.lat, s.lon)) + '</span>' : '');
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
  // No place chosen: under the sky, the one line asking for it.
  var inv = document.getElementById('almanac-sky-invite');
  if (inv && inv._stored !== s.stored) { inv.innerHTML = s.stored ? '' : _almPlaceInviteHtml(); inv._stored = s.stored; }
}

// ══ Taps ═════════════════════════════════════════════════════════════════
// The Sun and the Moon open the 3D view on themselves (when the browser can
// draw it; else their name and article). A planet is named, with the way to
// it in the solar system below, which is where the planets are drawn; a
// named star is named; a muon tells its story.

function _sky3DAvailable() { return typeof window.openAlmanacEarth === 'function' && !window.openAlmanacEarth.unsupported; }

// Distance (CSS px) from a point to a segment.
function _skySegDist(px, py, x0, y0, x1, y1) {
  var dx = x1 - x0, dy = y1 - y0, L = dx * dx + dy * dy;
  var u = L ? _skyClamp(((px - x0) * dx + (py - y0) * dy) / L, 0, 1) : 0;
  var qx = x0 + u * dx - px, qy = y0 + u * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
}
// What a tap at (x, y) CSS px lands on: the nearest body within reach of its
// edge, the Sun, Moon and planets before the stars, then a muon's streak.
var SKY_TAP_RANK = { sun: 0, moon: 0, planet: 0, iss: 0, plane: 1, birds: 1, meteor: 1, boat: 1, star: 2, muon: 3, aurora: 4, sea: 5 };
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
  if (b.type === 'muon') return 'term:muon';
  if (b.type === 'iss') return 'term:iss';
  if (b.type === 'meteor') return 'term:meteor_shower';
  return null;
}
var SKY_NAME_KEYS = { sun: 'alm_sun', moon: 'alm_the_moon', muon: 'alm_sky_muon', iss: 'alm_earth_iss_name', sea: 'alm_sky_sea',
  boat: 'alm_sky_boat', plane: 'alm_sky_plane', birds: 'alm_sky_birds', meteor: 'alm_sky_meteor', aurora: 'alm_sky_aurora' };
function _skyBodyName(b) {
  if (b.type === 'planet') return _tp(b.name);
  if (b.type === 'star') return _STAR_NAMES[b.idx];
  return t(SKY_NAME_KEYS[b.type]);
}
// The lines under the name for what lives on the horizon, or null.
function _skyLifeLines(b) {
  var s = _skyState;
  if (b.type === 'sea') return s.sea && typeof _atSkySeaLines === 'function' ? _atSkySeaLines(s.sea) : [];
  if (b.type === 'boat') {
    var km = SKY_EYE_KM * Math.sqrt(SKY_EYE_M);
    return [t('alm_sky_boat_line', { d: _orrNum(km, 'kilometer', 0) }), t('alm_sky_boat_lights')];
  }
  if (b.type === 'plane') return [t('alm_sky_plane_line')];
  if (b.type === 'birds') return [t('alm_sky_birds_line')];
  if (b.type === 'meteor') {
    var r = _skyMeteorRate(s), n = _orrNum(Math.round(r.perHour), null, 0);
    return [r.shower ? t('alm_sky_meteor_shower', { name: _showerName(r.shower.sh), n: n }) : t('alm_sky_meteor_line', { n: n }),
      t('alm_sky_meteor_fast', { k: _orrNum(SKY_METEOR_SPEEDUP, null, 0) })];
  }
  if (b.type === 'aurora') return [t('alm_sky_aurora_line', { g: _skyDeg(Math.abs(b.mag)) })];
  if (b.type === 'iss') return [t('alm_sky_iss_line', { km: _orrNum(Math.round(b.km), 'kilometer', 0), where: _skyDeg(b.alt) + ' ' + _azCompass(b.az) })];
  return null;
}
// The lines under a body's name.
function _skyBodyLines(b) {
  var life = _skyLifeLines(b);
  if (life) return life;
  if (b.type === 'muon') {
    var f = _muonFacts();
    return [
      t('alm_sky_muon_head', { life: _orrFmtSpan(MUON_LIFETIME_S), v: _orrNum(MUON_BETA, null, 3) + 'c', h: _orrNum(MUON_HEIGHT_M / 1000, 'kilometer', 0) }),
      t('alm_sky_muon_math', {
        g: _orrNum(f.gamma, null, 1), fall: _orrFmtSpan(f.fall), own: _orrFmtSpan(f.own),
        pct: _orrNum(f.survive * 100, 'percent', 0), d: _orrNum(Math.round(f.reach / 10) * 10, 'meter', 0)
      }),
      t('alm_sky_muon_source')
    ];
  }
  var where = _skyDeg(b.alt) + ' ' + _azCompass(b.az);
  return [b.mag != null ? t('alm_sky_body_line', { where: where, m: _orrNum(b.mag, null, 1) }) : where];
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
    var src = (b.type === 'muon' || b.type === 'meteor') && i === lines.length - 1;   // the source or the footnote, small
    html += '<span class="alm-sky-tip-line' + (src ? ' alm-sky-tip-src' : '') + '">' + _almEsc(lines[i]) + '</span>';
  }
  if (b.type === 'planet' && typeof _orreryShowBody === 'function') {
    html += '<button type="button" class="orrery-tip-btn" data-sky-orrery="' + _almEsc(b.name) + '">' + _almEsc(t('alm_sky_find_orrery')) + '</button>';
  }
  tip.innerHTML = html;
  tip.hidden = false;
  tip._sky = b;
  // Beside the body, above it when there is room, inside the scene.
  var W = wrap.clientWidth, H = wrap.clientHeight, tw = tip.offsetWidth, th = tip.offsetHeight;
  var at = b.box ? { x: b.tapX, y: b.tapY } : b.x0 != null ? { x: b.x1, y: (b.y0 + b.y1) / 2 } : b;
  var ax = at.x, ay = at.y, gap = (b.r || 4) + 8;
  var top = ay - gap - th >= 2 ? ay - gap - th : ay + gap;
  tip.style.top = _skyClamp(top, 2, Math.max(2, H - th - 2)) + 'px';
  tip.style.left = _skyClamp(ax - tw / 2, 2, Math.max(2, W - tw - 2)) + 'px';
}
function _skyHideTip() {
  var tip = document.getElementById('almanac-sky-tip');
  if (tip) { tip.hidden = true; tip._sky = null; }
}

// What a tap on a body does; returns 'view' (the 3D view opened) or 'tip'.
function _skyAct(b) {
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

// Looking round: a sideways drag turns the view the whole way round (the
// compass on the horizon turns with it); an up or down swipe still scrolls
// the page (touch-action: pan-y). The bearing faced is kept while the
// Almanac is open. Arrow keys turn it from the keyboard.
var _skyHeading = null;
var SKY_DRAG_SLOP_PX = 6, SKY_KEY_TURN_DEG = 15, SKY_CLICK_AFTER_TURN_MS = 400;
function _skyTurn(dDeg) {
  var s = _skyState;
  if (!s) return;
  s.center = _skyHeading = ((s.center + dDeg) % 360 + 360) % 360;
  s.baseDirty = true;
  _skyHideTip();
  _skyCaption(s);
  _skyKick();
}
function _skyBindLook(canvas) {
  var press = null;
  canvas.addEventListener('pointerdown', function (e) {
    if (e.button != null && e.button !== 0) return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, turning: false };
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!press || e.pointerId !== press.id) return;
    var dx = e.clientX - press.x, dy = e.clientY - press.y;
    if (!press.turning) {
      if (Math.hypot(dx, dy) < SKY_DRAG_SLOP_PX) return;
      if (Math.abs(dy) > Math.abs(dx)) { press = null; return; }   // the page's scroll
      press.turning = true;
      canvas.classList.add('alm-sky-turning');
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    }
    var s = _skyState;
    if (s) _skyTurn(-(e.clientX - press.lx) / s.cssW * SKY_SPAN_DEG);
    press.lx = e.clientX;
  });
  function end(e) {
    if (!press || e.pointerId !== press.id) return;
    // A turn is not a tap: the click that follows it is not one either.
    if (press.turning) canvas._skyTurnedAt = performance.now();
    canvas.classList.remove('alm-sky-turning');
    press = null;
  }
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    _skyTurn(e.key === 'ArrowLeft' ? -SKY_KEY_TURN_DEG : SKY_KEY_TURN_DEG);
  });
}

function _skyBindTaps(canvas) {
  if (canvas._skyTaps) return;
  canvas._skyTaps = true;
  _skyBindLook(canvas);
  canvas.addEventListener('click', function (e) {
    if (performance.now() - (canvas._skyTurnedAt || -1e9) < SKY_CLICK_AFTER_TURN_MS) return;
    _skyTapAt(e.clientX, e.clientY);
  });
  canvas.addEventListener('mousemove', function (e) {
    var r = canvas.getBoundingClientRect(), hit = _skyHitTest(e.clientX - r.left, e.clientY - r.top);
    canvas.style.cursor = hit ? 'pointer' : 'grab';
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
  function drawLabel(txt, x, y, off) {
    var leftHalf = x <= cx;
    ctx.textAlign = leftHalf ? 'left' : 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(txt, x + (leftHalf ? off : -off), y - 3);
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
      label: (_STAR_NAMES[i] || t('alm_star')) + ' \u00b7 ' + p.alt.toFixed(0) + '\u00b0 ' +
             _azCompass(p.az) + ' \u00b7 mag ' + mag.toFixed(1)
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
      label: _tp(nm) + ' \u00b7 ' + aa.alt.toFixed(0) + '\u00b0 ' + _azCompass(aa.az)
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
      label: t('alm_the_moon') + ' \u00b7 ' + mp.altitude.toFixed(0) + '\u00b0 ' +
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
      (moonUp ? ' · ' + t('alm_the_moon') : '') + '</div>';
  }
}
