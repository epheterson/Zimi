// ── Almanac: the tide, here ──
// Loaded only when the Almanac's tide section scrolls near (almanac.js
// _almPlaceWatch); nothing here runs on the Almanac's first paint.
//
// NOAA CO-OPS harmonic constants (zimi/assets/tides-snapshot.json.gz),
// predicted here for any date by harmonic synthesis, the method NOAA itself
// uses (Schureman 1958; Parker 2007): 37 constituents, nodal factors f and u
// for the year, equilibrium arguments V0 at its start. Subordinate stations
// take NOAA's published time and height offsets from their reference
// station's highs and lows.
//
// The place comes from the Almanac (_getLocation): known only once someone
// picked one; nothing here asks. The server answers /almanac-place with the
// nearest stations (zimi/placedata.py); no request ever leaves this machine.

// ═══ Harmonic synthesis (pure: no DOM, loaded by tests/test_almanac_tides.cjs) ═══
var TideMath = (function() {
  var D2R = Math.PI / 180;
  var MS_PER_HOUR = 3600000;
  var JD_UNIX_EPOCH = 2440587.5;
  var JD_J2000 = 2451545.0;
  var DAYS_PER_CENTURY = 36525;
  var MS_PER_DAY = 86400000;
  // Mean inclination of the Moon's orbit to the ecliptic (Schureman's i).
  var MOON_ORBIT_INCLINATION = 5.145;
  // A metre in feet: NOAA's additive subordinate offsets are published in feet.
  var M_PER_FT = 0.3048;
  var MIN_MS = 60000;

  function mod360(x) { x %= 360; return x < 0 ? x + 360 : x; }
  function poly(c, T) { var v = 0; for (var i = c.length - 1; i >= 0; i--) v = v * T + c[i]; return v; }

  // Mean longitudes (degrees) at Julian centuries T from J2000, Meeus ch. 47
  // and 25: the Moon (s), the Sun (h), the Moon's perigee (p), the Moon's
  // ascending node (N), the Sun's perigee (p1), and the obliquity (omega).
  var S_C = [218.3164477, 481267.88123421, -0.0015786, 1 / 538841, -1 / 65194000];
  var H_C = [280.46646, 36000.76983, 0.0003032];
  var P_C = [83.3532465, 4069.0137287, -0.0103200, -1 / 80053, 1 / 18999000];
  var N_C = [125.0445479, -1934.1362891, 0.0020754, 1 / 467441, -1 / 60616000];
  var P1_C = [282.93735, 1.71946, 0.00046];
  var OMEGA_C = [23.43929111, -0.0130041667, -1.6389e-7, 5.0361e-7];

  function astro(ms) {
    var jd = JD_UNIX_EPOCH + ms / MS_PER_DAY;
    var T = (jd - JD_J2000) / DAYS_PER_CENTURY;
    var a = {
      s: mod360(poly(S_C, T)), h: mod360(poly(H_C, T)), p: mod360(poly(P_C, T)),
      N: mod360(poly(N_C, T)), p1: mod360(poly(P1_C, T)), omega: poly(OMEGA_C, T)
    };
    // Mean solar hour angle at Greenwich: 180 degrees at 00:00 UT.
    var hourAngle = mod360(180 + ((ms % MS_PER_DAY + MS_PER_DAY) % MS_PER_DAY) / MS_PER_HOUR * 15);
    a.tau = mod360(hourAngle + a.h - a.s);   // mean lunar time, T + h - s
    // Schureman's I, nu, xi (eqs. 191-193) from the node, i and omega.
    var N = a.N * D2R, i = MOON_ORBIT_INCLINATION * D2R, w = a.omega * D2R;
    var cosI = Math.cos(i) * Math.cos(w) - Math.sin(i) * Math.sin(w) * Math.cos(N);
    a.I = Math.acos(cosI);
    var t2 = Math.tan(N / 2);
    var A = Math.atan(Math.cos((w - i) / 2) / Math.cos((w + i) / 2) * t2) - N / 2;
    var B = Math.atan(Math.sin((w - i) / 2) / Math.sin((w + i) / 2) * t2) - N / 2;
    a.nu = A - B;              // radians
    a.xi = -(A + B);           // radians
    var s2I = Math.sin(2 * a.I), sI2 = Math.pow(Math.sin(a.I), 2);
    // nu' and 2nu'' for the K1 and K2 (eqs. 224, 232).
    a.nup = Math.atan2(s2I * Math.sin(a.nu), s2I * Math.cos(a.nu) + 0.3347);
    a.nupp2 = Math.atan2(sI2 * Math.sin(2 * a.nu), sI2 * Math.cos(2 * a.nu) + 0.0727);
    a.P = (a.p * D2R) - a.xi;  // Schureman's P = p - xi
    return a;
  }

  // ── Nodal factors: each returns [f, u in degrees] for an astro state ──
  function cos2(x) { return Math.cos(x) * Math.cos(x); }
  var R2D = 180 / Math.PI;
  var NODAL = {
    one: function() { return [1, 0]; },
    Mm: function(a) { return [(2 / 3 - Math.pow(Math.sin(a.I), 2)) / 0.5021, 0]; },
    Mf: function(a) { return [Math.pow(Math.sin(a.I), 2) / 0.1578, -2 * a.xi * R2D]; },
    O1: function(a) { return [Math.sin(a.I) * cos2(a.I / 2) / 0.3800, (2 * a.xi - a.nu) * R2D]; },
    J1: function(a) { return [Math.sin(2 * a.I) / 0.7214, -a.nu * R2D]; },
    OO1: function(a) { return [Math.sin(a.I) * Math.pow(Math.sin(a.I / 2), 2) / 0.0164, (-2 * a.xi - a.nu) * R2D]; },
    M2: function(a) { return [Math.pow(Math.cos(a.I / 2), 4) / 0.9154, (2 * a.xi - 2 * a.nu) * R2D]; },
    M3: function(a) { return [Math.pow(Math.cos(a.I / 2), 6) / 0.8758, (3 * a.xi - 3 * a.nu) * R2D]; },
    K1: function(a) {
      var s2 = Math.sin(2 * a.I);
      return [Math.sqrt(0.8965 * s2 * s2 + 0.6001 * s2 * Math.cos(a.nu) + 0.1006), -a.nup * R2D];
    },
    K2: function(a) {
      var s = Math.sin(a.I);
      return [Math.sqrt(19.0444 * Math.pow(s, 4) + 2.7702 * s * s * Math.cos(2 * a.nu) + 0.0981), -a.nupp2 * R2D];
    },
    // M1 and L2 carry the perigee's modulation (Schureman eqs. 197-215).
    M1: function(a) {
      var o = NODAL.O1(a), cI = Math.cos(a.I), cH = Math.cos(a.I / 2);
      var invQa = Math.sqrt(0.25 + 1.5 * cI * Math.cos(2 * a.P) / Math.sqrt(cH) + 2.25 * cI * cI / Math.pow(cH, 4));
      var Q = Math.atan2((5 * cI - 1) * Math.sin(a.P), (7 * cI + 1) * Math.cos(a.P));
      return [o[0] * invQa, (Q - a.P - a.nu) * R2D];
    },
    L2: function(a) {
      var m = NODAL.M2(a), tH = Math.tan(a.I / 2), c2P = Math.cos(2 * a.P);
      var invRa = Math.sqrt(1 - 12 * tH * tH * c2P + 36 * Math.pow(tH, 4));
      var R = Math.atan2(Math.sin(2 * a.P), 1 / (6 * tH * tH) - c2P);
      return [m[0] * invRa, m[1] - R * R2D];
    }
  };

  // Every constituent NOAA publishes, in the snapshot's order: Doodson-style
  // coefficients on (T+h-s, s, h, p, p1, 90 degrees), its speed in degrees per
  // mean solar hour (as NOAA publishes it), and its nodal factors as a product
  // of the basic ones above ([name, power] pairs; compounds multiply f, add u).
  var CONSTITUENTS = {
    M2:   [[2, 0, 0, 0, 0, 0],    28.9841042, [['M2', 1]]],
    S2:   [[2, 2, -2, 0, 0, 0],   30.0,       []],
    N2:   [[2, -1, 0, 1, 0, 0],   28.4397295, [['M2', 1]]],
    K1:   [[1, 1, 0, 0, 0, -1],   15.0410686, [['K1', 1]]],
    M4:   [[4, 0, 0, 0, 0, 0],    57.9682084, [['M2', 2]]],
    O1:   [[1, -1, 0, 0, 0, 1],   13.9430356, [['O1', 1]]],
    M6:   [[6, 0, 0, 0, 0, 0],    86.9523127, [['M2', 3]]],
    MK3:  [[3, 1, 0, 0, 0, -1],   44.0251729, [['M2', 1], ['K1', 1]]],
    S4:   [[4, 4, -4, 0, 0, 0],   60.0,       []],
    MN4:  [[4, -1, 0, 1, 0, 0],   57.4238337, [['M2', 2]]],
    NU2:  [[2, -1, 2, -1, 0, 0],  28.5125831, [['M2', 1]]],
    S6:   [[6, 6, -6, 0, 0, 0],   90.0,       []],
    MU2:  [[2, -2, 2, 0, 0, 0],   27.9682084, [['M2', 1]]],
    '2N2': [[2, -2, 0, 2, 0, 0],  27.8953548, [['M2', 1]]],
    OO1:  [[1, 3, 0, 0, 0, -1],   16.1391017, [['OO1', 1]]],
    LAM2: [[2, 1, -2, 1, 0, 2],   29.4556253, [['M2', 1]]],
    S1:   [[1, 1, -1, 0, 0, 0],   15.0,       []],
    M1:   [[1, 0, 0, 1, 0, -1],   14.4966939, [['M1', 1]]],
    J1:   [[1, 2, 0, -1, 0, -1],  15.5854433, [['J1', 1]]],
    MM:   [[0, 1, 0, -1, 0, 0],   0.5443747,  [['Mm', 1]]],
    SSA:  [[0, 0, 2, 0, 0, 0],    0.0821373,  []],
    SA:   [[0, 0, 1, 0, 0, 0],    0.0410686,  []],
    MSF:  [[0, 2, -2, 0, 0, 0],   1.0158958,  [['M2', -1]]],
    MF:   [[0, 2, 0, 0, 0, 0],    1.0980331,  [['Mf', 1]]],
    RHO:  [[1, -2, 2, -1, 0, 1],  13.4715145, [['O1', 1]]],
    Q1:   [[1, -2, 0, 1, 0, 1],   13.3986609, [['O1', 1]]],
    T2:   [[2, 2, -3, 0, 1, 0],   29.9589333, []],
    R2:   [[2, 2, -1, 0, -1, 2],  30.0410667, []],
    '2Q1': [[1, -3, 0, 2, 0, 1],  12.8542862, [['O1', 1]]],
    P1:   [[1, 1, -2, 0, 0, 1],   14.9589314, []],
    '2SM2': [[2, 4, -4, 0, 0, 0], 31.0158958, [['M2', -1]]],
    M3:   [[3, 0, 0, 0, 0, 0],    43.4761563, [['M3', 1]]],
    L2:   [[2, 1, 0, -1, 0, 2],   29.5284789, [['L2', 1]]],
    '2MK3': [[3, -1, 0, 0, 0, 1], 42.9271398, [['M2', 2], ['K1', -1]]],
    K2:   [[2, 2, 0, 0, 0, 0],    30.0821373, [['K2', 1]]],
    M8:   [[8, 0, 0, 0, 0, 0],    115.9364166, [['M2', 4]]],
    MS4:  [[4, 2, -2, 0, 0, 0],   58.9841042, [['M2', 1]]]
  };

  // Diurnal constituents that appear only in NOAA's longer analyses (Cook
  // Inlet): coefficients and speeds from Schureman's Table 2.
  var MORE = {
    SIGMA1: [[1, -3, 2, 0, 0, 1],  12.9271398, [['O1', 1]]],
    CHI1:   [[1, 0, 2, -1, 0, -1], 14.5695476, [['J1', 1]]],
    THETA1: [[1, 2, -2, 1, 0, -1], 15.5125897, [['J1', 1]]],
    PI1:    [[1, 1, -3, 0, 1, 1],  14.9178647, []],
    PSI1:   [[1, 1, 1, 0, -1, -1], 15.0821353, []],
    PHI1:   [[1, 1, 2, 0, 0, -1],  15.1232059, []],
    // NOAA's "OO2" is Q1 + O1 (Foreman's OQ2), not two OO1.
    OO2:    [[2, -3, 0, 1, 0, 2],  27.3416964, [['O1', 2]]]
  };
  // The letters a shallow-water compound is spelled with, and which
  // constituent each can stand for.
  var LETTERS = { M: ['M2'], S: ['S2', 'S1'], N: ['N2'], K: ['K1', 'K2'], O: ['O1'],
    P: ['P1'], L: ['L2'], Q: ['Q1'], T: ['T2'], R: ['R2'], J: ['J1'] };
  var SPEED_TOL = 1e-4;

  // A compound from its name, the way NOAA (after Foreman) names them:
  // "2MS6" is twice M2 plus S2 at six cycles a day, "MSN2" is M2 + S2 - N2.
  // Letters say which constituents, digits before a letter how many of it,
  // the trailing digits the species; the signs, and which K or S, are found by
  // matching NOAA's published speed. Where the spelled counts do not add up
  // (NOAA writes 2(M+S) as "2MS8" and 2N2 as "N4"), the smallest counts that
  // reach the speed win. Null when nothing matches.
  var MAX_COUNT = 5;
  var _compoundMemo = {};
  function compoundOf(name, speed) {
    var key = name + '@' + speed;
    if (key in _compoundMemo) return _compoundMemo[key];
    var found = CONSTITUENTS[name] || MORE[name] || null;
    var m = !found && /^((?:\d*[MSNKOPLQTRJ])+)(\d+)$/.exec(name);
    if (m) {
      var toks = [], re = /(\d*)([MSNKOPLQTRJ])/g, t;
      while ((t = re.exec(m[1]))) toks.push([t[1] ? +t[1] : 0, t[2]]);
      found = _compoundSearch(toks, speed, true) || _compoundSearch(toks, speed, false);
    }
    _compoundMemo[key] = found;
    return found;
  }

  // Every sign, constituent and count for each letter (the spelled count
  // only, when `spelled`); the match with the fewest constituents in all.
  function _compoundSearch(toks, speed, spelled) {
    var best = null, bestCost = Infinity;
    (function walk(i, coef, spd, parts, cost) {
      if (cost >= bestCost) return;
      if (i === toks.length) {
        if (Math.abs(spd - speed) < SPEED_TOL) { best = [coef, speed, parts]; bestCost = cost; }
        return;
      }
      var opts = LETTERS[toks[i][1]];
      var counts = spelled ? [toks[i][0] || 1] : [1, 2, 3, 4, MAX_COUNT];
      for (var n = 0; n < counts.length; n++) {
        for (var o = 0; o < opts.length; o++) {
          var c = CONSTITUENTS[opts[o]];
          for (var sg = 1; sg >= -1; sg -= 2) {
            if (i === 0 && sg < 0) continue;
            var k = sg * counts[n];
            walk(i + 1,
              coef.map(function(v, j) { return v + k * c[0][j]; }),
              spd + k * c[1],
              parts.concat(c[2].map(function(q) { return [q[0], q[1] * k]; })),
              cost + counts[n]);
          }
        }
      }
    })(0, [0, 0, 0, 0, 0, 0], 0, [], 0);
    return best;
  }

  function equilibrium(coef, a) {
    return mod360(coef[0] * a.tau + coef[1] * a.s + coef[2] * a.h + coef[3] * a.p + coef[4] * a.p1 + coef[5] * 90);
  }

  function nodal(parts, a) {
    var f = 1, u = 0;
    for (var i = 0; i < parts.length; i++) {
      var b = NODAL[parts[i][0]](a), k = parts[i][1];
      // A negative power is a constituent subtracted from the compound:
      // its u subtracts and its f still multiplies (Schureman, Table 2).
      f *= Math.pow(b[0], Math.abs(k));
      u += k * b[1];
    }
    return [f, u];
  }

  // As NOAA does: V0 at 00:00 UTC on 1 January, f and u at the middle of the
  // year (00:00 UTC on 2 July), held for the whole year.
  var _yearCache = {};
  function yearTerms(year, names) {
    var key = year + '|' + names.join(',');
    if (_yearCache[key]) return _yearCache[key];
    var start = Date.UTC(2000, 0, 1); var d0 = new Date(start); d0.setUTCFullYear(year, 0, 1);
    var t0 = d0.getTime();
    var mid = new Date(start); mid.setUTCFullYear(year, 6, 2);
    var a0 = astro(t0), am = astro(mid.getTime());
    var out = { t0: t0, speed: [], vu: [], f: [] };
    for (var i = 0; i < names.length; i++) {
      // A name, or a [name, speed] pair for one of NOAA's additional ones.
      var c = typeof names[i] === 'string' ? CONSTITUENTS[names[i]] : compoundOf(names[i][0], names[i][1]);
      if (!c) { out.speed.push(0); out.vu.push(0); out.f.push(0); continue; }
      var fu = nodal(c[2], am);
      out.speed.push(c[1]);
      out.vu.push(mod360(equilibrium(c[0], a0) + fu[1]));
      out.f.push(fu[0]);
    }
    _yearCache[key] = out;
    return out;
  }

  function utcYear(ms) { return new Date(ms).getUTCFullYear(); }

  // A harmonic station, ready to evaluate: amplitudes in metres, Greenwich
  // phases in degrees, z0 = mean sea level above MLLW in metres.
  // NOAA's additional constituents, where it has them, join the standard 37.
  function harmonic(st, names) {
    var amp = [], ph = [], all = names.slice();
    for (var i = 0; i < names.length; i++) { amp.push(st.a[i] / 1000); ph.push(st.g[i] / 10); }
    for (var x in (st.x || {})) {
      var e = st.x[x];
      if (!compoundOf(x, e[2])) continue;
      all.push([x, e[2]]); amp.push(e[0] / 1000); ph.push(e[1] / 10);
    }
    return { amp: amp, ph: ph, z0: st.z0 / 1000, names: all };
  }

  // Height above MLLW (m) and its rate (m/hour) at an instant.
  function heightAt(h, ms) {
    // The year's terms, kept on the station: every sample of a day asks.
    var yr = utcYear(ms);
    if (!h.terms || h.termsYear !== yr) { h.terms = yearTerms(yr, h.names); h.termsYear = yr; }
    var y = h.terms;
    var hrs = (ms - y.t0) / MS_PER_HOUR, z = h.z0, dz = 0;
    for (var i = 0; i < h.amp.length; i++) {
      if (!h.amp[i]) continue;
      var arg = (y.speed[i] * hrs + y.vu[i] - h.ph[i]) * D2R;
      var A = y.f[i] * h.amp[i];
      z += A * Math.cos(arg);
      dz -= A * y.speed[i] * D2R * Math.sin(arg);
    }
    return [z, dz];
  }

  var SCAN_MS = 6 * MIN_MS;
  // Highs and lows between two instants: a 6-minute scan of the rate for a
  // sign change, then bisection to the second.
  function extremes(h, fromMs, toMs) {
    var out = [], prev = heightAt(h, fromMs)[1], tPrev = fromMs;
    for (var t = fromMs + SCAN_MS; t <= toMs; t += SCAN_MS) {
      var r = heightAt(h, t)[1];
      if ((prev > 0) !== (r > 0) && prev !== 0) {
        var lo = tPrev, hi = t, rlo = prev;
        while (hi - lo > 1000) {
          var m = (lo + hi) / 2, rm = heightAt(h, m)[1];
          if ((rm > 0) === (rlo > 0)) { lo = m; rlo = rm; } else hi = m;
        }
        var tx = Math.round((lo + hi) / 2);
        out.push({ t: tx, h: heightAt(h, tx)[0], high: prev > 0 });
      }
      prev = r; tPrev = t;
    }
    return out;
  }

  // A subordinate station's highs and lows: the reference's, moved by NOAA's
  // offsets (minutes; a height ratio, or feet to add).
  function subordinateExtremes(ref, off, fromMs, toMs) {
    var pad = 3 * MS_PER_HOUR;
    var base = extremes(ref, fromMs - pad, toMs + pad), out = [];
    for (var i = 0; i < base.length; i++) {
      var e = base[i];
      var t = e.t + (e.high ? off.th : off.tl) * MIN_MS;
      var k = e.high ? off.hh : off.hl;
      var hh = off.r ? e.h * k : e.h + k * M_PER_FT;
      if (t >= fromMs && t <= toMs) out.push({ t: t, h: hh, high: e.high });
    }
    return out;
  }

  // The water between two known turns, for a station NOAA predicts only as
  // highs and lows: the half-cosine NOAA's own tide tables use for heights
  // between them.
  function between(e1, e2, ms) {
    var x = (ms - e1.t) / (e2.t - e1.t);
    return e1.h + (e2.h - e1.h) * (1 - Math.cos(Math.PI * x)) / 2;
  }

  // One interface for both kinds: extremes(from, to) and height(ms).
  function predictor(rec, names, refRec) {
    if (rec.a) {
      var h = harmonic(rec, names);
      return {
        kind: 'harmonic', n: h.names.length,
        extremes: function(a, b) { return extremes(h, a, b); },
        height: function(ms) { return heightAt(h, ms)[0]; }
      };
    }
    var ref = harmonic(refRec, names);
    var cache = null;
    function turnsAround(ms) {
      if (!cache || ms < cache.a || ms > cache.b) {
        var a = ms - 36 * MS_PER_HOUR, b = ms + 36 * MS_PER_HOUR;
        cache = { a: a + 14 * MS_PER_HOUR, b: b - 14 * MS_PER_HOUR, list: subordinateExtremes(ref, rec, a, b) };
      }
      return cache.list;
    }
    return {
      kind: 'subordinate', n: ref.names.length,
      extremes: function(a, b) { return subordinateExtremes(ref, rec, a, b); },
      height: function(ms) {
        var l = turnsAround(ms);
        for (var i = 1; i < l.length; i++) if (l[i].t >= ms) return between(l[i - 1], l[i], ms);
        return NaN;
      }
    };
  }

  return {
    astro: astro, yearTerms: yearTerms, predictor: predictor, harmonic: harmonic,
    CONSTITUENTS: CONSTITUENTS, compoundOf: compoundOf, M_PER_FT: M_PER_FT,
    // The mean longitudes' polynomials, for the tables' Equations.
    MEAN: { s: S_C, h: H_C, p: P_C, N: N_C, p1: P1_C }
  };
})();

// ═══ The panel ═══════════════════════════════════════════════════════════════
// Everything below runs in the Almanac (almanac.js globals: _getLocation,
// _saveLocation, _almRepaintFocus, _almFocusInstant, _almTzForLocation,
// _tzFmt, _tzUtcOffsetMin, _almEsc, _principalPhaseOnDay, _moonGlyphSVG, _sunPosition).

var AT_MS_HOUR = 3600000;
var AT_MS_DAY = 86400000;
var AT_CURVE_STEP_MS = 10 * 60000;       // one sample every ten minutes
var AT_NEXT_WINDOW_MS = 26 * AT_MS_HOUR; // the next turn is always within a day
// Past this, a tide station describes some other water: its tide is shown
// as the nearest station's, with how far it is. Within it the place is on
// the coast (the live sky draws the sea, at this tide's level).
var AT_TIDE_NEAR_KM = 80;
var AT_KM_PER_MI = 1.609344;
var AT_TIDE_YEARS = 200;   // how far from today a tide prediction is offered
var AT_UNITS_KEY = 'zimi_almanac_units';
var AT_LTR = '⁦', AT_POP = '⁩';   // left-to-right isolate, and its end
var AT_CURVE_H = 196, AT_CURVE_PAD_T = 40, AT_CURVE_PAD_B = 22;
var AT_DEFAULT_W = 568;   // the Almanac's column, before it has been measured

var _at = {
  key: null,        // the place the last answer was for
  data: null,       // /almanac-place answer for it
  loading: false,
  tideId: null,     // a station picked over the nearest, for this place
  picking: null,    // 'tide' while the station list is open
  query: '',
  results: null
};

function _atEl(id) { return document.getElementById(id); }
function _atLang() { return (typeof _currentLang !== 'undefined' && _currentLang) || 'en'; }

// Feet and miles where people measure in them, metres elsewhere; the toggle
// is remembered on this device only.
function _atUnits() {
  try { var v = localStorage.getItem(AT_UNITS_KEY); if (v === 'ft' || v === 'm') return v; } catch (e) {}
  var nav = (typeof navigator !== 'undefined' && navigator.language) || '';
  return /-(US|LR|MM)$/i.test(nav) || (/^en$/i.test(nav) && _atLang() === 'en') ? 'ft' : 'm';
}
function _atSetUnits(u) {
  try { localStorage.setItem(AT_UNITS_KEY, u); } catch (e) {}
  _atRender();
}

var _atNumCache = {};
function _atNum(x, dec) {
  var k = _atLang() + dec;
  if (!_atNumCache[k]) _atNumCache[k] = new Intl.NumberFormat(_atLang(), { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return _atNumCache[k].format(x);
}
function _atHeight(m, bare) {
  var ft = _atUnits() === 'ft';
  // Isolated left to right: in Hebrew or Arabic a bare "-0.1" lets its sign
  // wander to the far side of the number, or onto the time beside it.
  var v = AT_LTR + _atNum(ft ? m / TideMath.M_PER_FT : m, ft ? 1 : 2) + AT_POP;
  return bare ? v : v + ' ' + t(ft ? 'alm_unit_ft' : 'alm_unit_m');
}
function _atDistance(km) {
  var ft = _atUnits() === 'ft', v = ft ? km / AT_KM_PER_MI : km;
  return t(ft ? 'alm_dist_mi' : 'alm_dist_km', { n: _atNum(v, v < 10 ? 1 : 0) });
}
// "SAN FRANCISCO (Golden Gate)" -> "San Francisco (Golden Gate)". Only words
// written wholly in capitals change; state codes and mixed case stay.
function _atTitle(name) {
  return String(name || '').replace(/[A-Z][A-Z'.]{2,}/g, function(w) { return w.charAt(0) + w.slice(1).toLowerCase(); });
}
function _atTideName(st) { return _atTitle(st.n) + (st.s ? ', ' + st.s : ''); }

function _atTime(ms, tz) { return AT_LTR + _tzFmt(tz, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms)) + AT_POP; }

// Local midnight, in a zone, of the day holding an instant.
function _atDayStart(ms, tz) {
  var parts = _tzFmt(tz, { year: 'numeric', month: 'numeric', day: 'numeric' }, 'en-US').formatToParts(new Date(ms));
  var p = {};
  parts.forEach(function(x) { p[x.type] = +x.value; });
  return _atMidnight(p.year, p.month - 1, p.day, tz);
}
function _atMidnight(y, m, d, tz) {
  var g = new Date(0); g.setUTCFullYear(y, m, d); g.setUTCHours(0, 0, 0, 0);
  var guess = g.getTime(), start = guess;
  // Twice: the zone's offset at the first guess can differ across a DST change.
  for (var i = 0; i < 2; i++) start = guess - _tzUtcOffsetMin(tz, new Date(start)) * 60000;
  return start;
}

// ── Data ─────────────────────────────────────────────────────────────────────
function _atFetch(url) {
  return fetch(url).then(function(r) { if (!r.ok) throw new Error(r.status); return r.json(); });
}
function _atPlaceKey(loc) { return loc.lat.toFixed(3) + ',' + loc.lon.toFixed(3); }

function _atEnsureData(loc) {
  var key = _atPlaceKey(loc);
  if (_at.key === key && (_at.data || _at.loading)) return;
  _at.key = key; _at.data = null; _at.loading = true;
  _at.tideId = null; _at.picking = null;
  _atFetch('/almanac-place?lat=' + loc.lat + '&lon=' + loc.lon).then(function(d) {
    if (_at.key !== key) return;
    _at.data = d; _at.loading = false; _atRender();
  }).catch(function() {
    if (_at.key !== key) return;
    _at.loading = false; _at.data = { failed: true }; _atRender();
  });
}

function _atTideStation() {
  var list = (_at.data && _at.data.tides && _at.data.tides.stations) || [];
  if (_at.tideId) for (var i = 0; i < list.length; i++) if (list[i].id === _at.tideId) return list[i];
  if (_at.tidePicked && _at.tidePicked.id === _at.tideId) return _at.tidePicked;
  return list[0] || null;
}

var _atPredictorMemo = { id: null, p: null };
function _atPredictor(st) {
  if (_atPredictorMemo.id !== st.id) {
    _atPredictorMemo = { id: st.id, p: TideMath.predictor(st, _at.data.tides.constituents, st.refrec) };
  }
  return _atPredictorMemo.p;
}

// The tide station's own clock: tide tables are read in the harbour's time.
function _atTideTz(st) { return _almTzForLocation(st.la, st.lo); }

// ── Render ───────────────────────────────────────────────────────────────────
function _atRender() {
  var host = _atEl('almanac-place');
  if (!host) return;
  var loc = _getLocation();
  if (!loc.stored) { _atDraw(host, _atEmptyHtml()); return; }
  _atEnsureData(loc);
  if (_at.loading || !_at.data) {
    // Hold the height while the stations come: nothing below should jump
    // twice (almanac.js keeps the first one, from before this file loaded).
    if (!host.style.minHeight && host.offsetHeight) host.style.minHeight = host.offsetHeight + 'px';
    host.innerHTML = '';
    return;
  }
  if (_at.data.failed) { _atDraw(host, ''); return; }
  // Far from any station (inland, or a coast NOAA does not cover) the nearest
  // station's tide is still shown, saying whose water it is and how far.
  var tide = _atTideStation();
  _atDraw(host, tide ? _atTideHtml(tide, !_at.tideId && tide.km > AT_TIDE_NEAR_KM) : '');
  _atBindCurve();
}

function _atDraw(host, html) {
  host.innerHTML = html;
  if (typeof _almPlaceDrawn === 'function') _almPlaceDrawn();
  // The live sky's sea follows this tide: tell it there is one now.
  if (typeof _skySeaChanged === 'function') _skySeaChanged();
}

// The sea for the live sky (almanac-sky.js): at a place on the coast (a
// station within AT_TIDE_NEAR_KM), the water's height at ms as a share of
// the day's range around it (0 low water, 1 high), with what is next.
// Null inland, before the stations have come, or beyond the tide's years.
var AT_SEA_WINDOW_MS = 13 * AT_MS_HOUR;   // a low and a high either side, anywhere
var AT_SEA_STEP_MS = 10 * 60000;          // the sea's level, to the ten minutes (the scrub asks every frame)
var _atSeaMemo = { key: null, v: null };
function _atSkySea(ms) {
  if (!_at.data || _at.data.failed || _atBeyond(ms)) return null;
  var st = _atTideStation();
  if (!st || st.km > AT_TIDE_NEAR_KM) return null;
  var key = st.id + '@' + Math.round(ms / AT_SEA_STEP_MS);
  if (_atSeaMemo.key !== key) _atSeaMemo = { key: key, v: _atSkySeaAt(st, Math.round(ms / AT_SEA_STEP_MS) * AT_SEA_STEP_MS) };
  return _atSeaMemo.v;
}
function _atSkySeaAt(st, ms) {
  var p = _atPredictor(st), h = p.height(ms);
  var turns = p.extremes(ms - AT_SEA_WINDOW_MS, ms + AT_SEA_WINDOW_MS);
  if (!isFinite(h) || !turns.length) return null;
  var lo = h, hi = h, next = null;
  for (var i = 0; i < turns.length; i++) {
    lo = Math.min(lo, turns[i].h); hi = Math.max(hi, turns[i].h);
    if (!next && turns[i].t > ms) next = turns[i];
  }
  return {
    frac: hi > lo ? (h - lo) / (hi - lo) : 0.5, h: h, next: next,
    rising: next ? next.high : false, name: _atTideName(st), tz: _atTideTz(st)
  };
}
// The sea's words for a tap on it in the sky.
function _atSkySeaLines(sea) {
  var lines = [_atTitle(sea.name), t('alm_tide_now', { h: _atHeight(sea.h) })];
  if (sea.next) lines.push(t(sea.next.high ? 'alm_tide_next_high' : 'alm_tide_next_low', { time: _atTime(sea.next.t, sea.tz) }) + ' · ' + _atHeight(sea.next.h));
  return lines;
}

// Re-render for a new focus instant or place (almanac.js _almRepaintFocus).
function _atRepaint() { _atRender(); }

function _atSection(title, body, cls) {
  return '<section class="almanac-section at-section' + (cls ? ' ' + cls : '') + '">' +
    '<div class="almanac-section-title">' + _almEsc(title) + '</div>' + body + '</section>';
}

function _atEmptyHtml() {
  return _atSection(t('alm_tide_title'),
    _almPlaceInviteHtml() + _atSearchHtml());
}

function _atSearchHtml() {
  var res = '';
  if (_at.results) {
    var rows = _at.results.tides.stations.map(function(s) { return _atRowHtml('tide', s, _atTideName(s)); });
    res = rows.length ? '<ul class="at-list">' + rows.join('') + '</ul>'
      : '<p class="at-quiet">' + _almEsc(t('alm_place_no_match')) + '</p>';
  }
  return '<div class="at-search"><input type="search" class="at-input" id="at-q" value="' + _almEsc(_at.query) + '"' +
    ' placeholder="' + _almEsc(t('alm_place_search')) + '" aria-label="' + _almEsc(t('alm_place_search')) + '"' +
    ' oninput="_atSearch(this.value)" autocomplete="off" spellcheck="false"></div>' +
    '<div id="at-results">' + res + '</div>';
}

function _atRowHtml(kind, s, name) {
  var dist = s.km != null ? '<span class="at-row-km">' + _almEsc(_atDistance(s.km)) + '</span>' : '';
  return '<li><button type="button" class="at-row" onclick="_atChoose(\'' + kind + '\',\'' + _almEsc(s.id) + '\')">' +
    '<span class="at-row-name">' + _almEsc(name) + '</span>' + dist + '</button></li>';
}

var _atSearchTimer = 0, _atSearchSeq = 0;
function _atSearch(q) {
  _at.query = q;
  clearTimeout(_atSearchTimer);
  if (!q.trim()) { _at.results = null; _atPaintResults(); return; }
  var seq = ++_atSearchSeq;
  _atSearchTimer = setTimeout(function() {
    var loc = _getLocation(), near = loc.stored ? '&lat=' + loc.lat + '&lon=' + loc.lon : '';
    _atFetch('/almanac-place?q=' + encodeURIComponent(q) + near).then(function(d) {
      if (seq !== _atSearchSeq) return;
      _at.results = d; _atPaintResults();
    }).catch(function() {});
  }, 160);
}
// Only the list repaints while typing, so the field keeps its focus and caret.
function _atPaintResults() {
  var el = _atEl('at-results');
  if (!el) return;
  var tmp = document.createElement('div');
  tmp.innerHTML = _at.picking ? _atPickerListHtml(_at.picking) : _atSearchHtml();
  var fresh = tmp.querySelector('#at-results');
  el.innerHTML = fresh ? fresh.innerHTML : '';
}

// A station chosen from a search, or from the list of nearby ones.
function _atChoose(kind, id) {
  var pool = [];
  if (_at.results) pool = _at.results.tides.stations;
  if (_at.data && !_at.data.failed) pool = pool.concat(_at.data.tides.stations);
  var st = null;
  for (var i = 0; i < pool.length; i++) if (pool[i].id === id) { st = pool[i]; break; }
  if (!st) return;
  if (!_getLocation().stored) {
    // No place yet: a station chosen by name IS the place. One place, one
    // clock: the whole Almanac follows it.
    _at.query = ''; _at.results = null;
    _saveLocation(st.la, st.lo, _atTitle(st.n));
    _almRepaintFocus();
    return;
  }
  _at.tideId = id; _at.tidePicked = st;
  _at.picking = null; _at.query = ''; _at.results = null;
  _atRender();
}

function _atPick(kind) {
  _at.picking = _at.picking === kind ? null : kind;
  _at.query = ''; _at.results = null;
  _atRender();
  var q = _atEl('at-q');
  if (q && _at.picking) q.focus({ preventScroll: true });
}

function _atPickerListHtml(kind) {
  var list = _at.results ? _at.results.tides.stations : _at.data.tides.stations;
  var rows = list.map(function(s) { return _atRowHtml(kind, s, _atTideName(s)); });
  return '<div id="at-results">' + (rows.length ? '<ul class="at-list">' + rows.join('') + '</ul>'
    : '<p class="at-quiet">' + _almEsc(t('alm_place_no_match')) + '</p>') + '</div>';
}
function _atPickerHtml(kind) {
  return '<div class="at-picker"><div class="at-search"><input type="search" class="at-input" id="at-q" value="' + _almEsc(_at.query) + '"' +
    ' placeholder="' + _almEsc(t('alm_place_search_station')) + '" aria-label="' + _almEsc(t('alm_place_search_station')) + '"' +
    ' oninput="_atSearch(this.value)" autocomplete="off" spellcheck="false"></div>' + _atPickerListHtml(kind) + '</div>';
}

// The station line under each card: its name (the way to choose another),
// how far it is, and the units toggle.
var AT_HERE_KM = 0.5;
function _atStationLine(kind, name, km, withUnits) {
  var u = _atUnits();
  var units = !withUnits ? '' : '<span class="at-units" role="group" aria-label="' + _almEsc(t('alm_units')) + '">' +
    ['ft', 'm'].map(function(x) {
      return '<button type="button" class="at-unit' + (x === u ? ' on' : '') + '" aria-pressed="' + (x === u) + '" onclick="_atSetUnits(\'' + x + '\')">' +
        _almEsc(t(x === 'ft' ? 'alm_unit_ft' : 'alm_unit_m')) + '</button>';
    }).join('') + '</span>';
  return '<div class="at-station"><button type="button" class="at-link at-station-name" aria-expanded="' + (_at.picking === kind) + '" onclick="_atPick(\'' + kind + '\')">' +
    _almEsc(name) + '</button>' + (km != null && km >= AT_HERE_KM ? '<span class="at-station-km">' + _almEsc(_atDistance(km)) + '</span>' : '') + units + '</div>';
}

// ── Tides ────────────────────────────────────────────────────────────────────
// One axis, three distances from now: the day's water (the curve), the month's
// ranges (spring and neap, against the Moon's phases), and the reason (the
// Earth from above, the bulges the Moon and Sun raise, this harbour turning
// through them). The amber mark is the Almanac's one clock in all three, and
// the curve and the figure follow the time machine frame by frame.
function _atTideDay(st, focusMs) {
  var tz = _atTideTz(st), p = _atPredictor(st);
  var start = _atDayStart(focusMs, tz);
  var end = _atDayStart(start + 26 * AT_MS_HOUR, tz);
  return { tz: tz, start: start, end: end, p: p, turns: p.extremes(start, end) };
}

function _atBeyond(focus) {
  // Harmonic constants describe today's harbour; centuries away its shape,
  // depth and sea level were or will be other. Say so rather than predict.
  return Math.abs(new Date(focus).getUTCFullYear() - new Date().getUTCFullYear()) > AT_TIDE_YEARS;
}

function _atTideHtml(st, far) {
  var focus = _almFocusInstant().getTime();
  var farHtml = far ? '<p class="at-quiet at-far">' + _almEsc(t('alm_tide_nearest', { name: _atTideName(st), d: _atDistance(st.km) })) + '</p>' : '';
  if (_atBeyond(focus)) {
    return _atSection(t('alm_tide_title'), '<p class="at-quiet">' + _almEsc(t('alm_tide_beyond', { n: AT_TIDE_YEARS })) + '</p>', 'at-tides');
  }
  var day = _atTideDay(st, focus);
  var next = day.p.extremes(focus, focus + AT_NEXT_WINDOW_MS)[0];
  var nowH = day.p.height(focus);
  var lead = '<div class="at-lead">';
  if (next) {
    lead +=
      '<span class="at-lead-dir ' + (next.high ? 'rising' : 'falling') + '">' + _almEsc(t(next.high ? 'alm_tide_rising' : 'alm_tide_falling')) + '</span>' +
      '<span class="at-lead-next">' + _almEsc(t(next.high ? 'alm_tide_next_high' : 'alm_tide_next_low', { time: _atTime(next.t, day.tz) })) +
      '<span class="at-lead-h">' + _almEsc(_atHeight(next.h)) + '</span></span>' +
      (isFinite(nowH) ? '<span class="at-lead-now">' + _almEsc(t('alm_tide_now', { h: _atHeight(nowH) })) + '</span>' : '');
  }
  lead += '</div>';
  var note = st.refrec ? t('alm_tide_note_sub', { ref: _atTitle(st.refrec.n) }) : t('alm_tide_note');
  var body = farHtml + lead +
    '<div class="at-curve" id="at-curve">' + _atCurveSvg(st, day, focus) + '</div>' +
    _atMonthHtml(st, focus) +
    _atWhyHtml(st, focus) +
    _atStationLine('tide', _atTideName(st), st.km, true) +
    (_at.picking === 'tide' ? _atPickerHtml('tide') : '') +
    '<p class="at-note">' + _almEsc(note) + ' <button type="button" class="at-link" onclick="_almRefOpen(\'tides\')">' + _almEsc(t('alm_tide_month')) + '</button></p>';
  return _atSection(t('alm_tide_title'), body, 'at-tides');
}

// The day's water as one shape: midnight to midnight in the harbour's time,
// night shaded from the Sun's altitude, each turn a dot with its time and
// height written over it, the focused instant as the Almanac's amber line.
// Height runs from the chart datum (0, mean lower low water) to the station's
// mean higher high water, widened only when the day goes past them, so
// springs look bigger than neaps.
var AT_LABEL_HALF_W = 26;   // half a turn label's width, to keep it inside
function _atCurveSvg(st, day, focus) {
  var pts = [], lo = 0, hi = (st.mhhw || (st.refrec && st.refrec.mhhw) || 0) / 1000;
  for (var t0 = day.start; t0 <= day.end; t0 += AT_CURVE_STEP_MS) {
    var h = day.p.height(t0);
    if (!isFinite(h)) continue;
    pts.push([t0, h]);
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  day.turns.forEach(function(e) { if (e.h < lo) lo = e.h; if (e.h > hi) hi = e.h; });
  _at.curve = null;
  if (!pts.length || hi - lo < 1e-3) return '';
  var span = day.end - day.start, W = _atWidth(), H = AT_CURVE_H;
  var top = AT_CURVE_PAD_T, bot = H - AT_CURVE_PAD_B;
  function X(ms) { return (ms - day.start) / span * W; }
  function Y(h) { return bot - (h - lo) / (hi - lo) * (bot - top); }
  // Kept for the time machine's frames (_atTravel): the line moves, nothing
  // is drawn again.
  _at.curve = { start: day.start, end: day.end, X: X, Y: Y, p: day.p, top: top, bot: bot };
  var path = pts.map(function(p, i) { return (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1); }).join('');
  var area = path + 'L' + X(pts[pts.length - 1][0]).toFixed(1) + ' ' + H + 'L' + X(pts[0][0]).toFixed(1) + ' ' + H + 'Z';
  // Night: where the Sun is below the horizon at the station.
  var night = '', runStart = null;
  for (var s = day.start; s <= day.end + AT_CURVE_STEP_MS; s += AT_CURVE_STEP_MS) {
    var dark = s <= day.end && _sunPosition(new Date(s), st.la, st.lo).altitude < -0.833;
    if (dark && runStart === null) runStart = s;
    if (!dark && runStart !== null) {
      night += '<rect class="at-night" x="' + X(runStart).toFixed(1) + '" y="0" width="' + (X(s) - X(runStart)).toFixed(1) + '" height="' + H + '"/>';
      runStart = null;
    }
  }
  // Hour ticks every six hours, labelled in the harbour's clock.
  var ticks = '';
  for (var k = 1; k < 4; k++) {
    var tm = day.start + k * 6 * AT_MS_HOUR;
    ticks += '<line class="at-tick" x1="' + X(tm).toFixed(1) + '" x2="' + X(tm).toFixed(1) + '" y1="' + (bot + 4) + '" y2="' + (bot + 8) + '"/>' +
      '<text class="at-tick-l" x="' + X(tm).toFixed(1) + '" y="' + (H - 4) + '">' + _almEsc(_tzFmt(day.tz, { hour: 'numeric' }).format(new Date(tm))) + '</text>';
  }
  var zero = lo < 0 ? '<line class="at-datum" x1="0" x2="' + W + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '"/>' : '';
  // Each turn says when and how high, right where it happens: the curve is
  // the table.
  var turns = day.turns.map(function(e) {
    var x = X(e.t), y = Y(e.h);
    var lx = Math.max(AT_LABEL_HALF_W, Math.min(W - AT_LABEL_HALF_W, x)).toFixed(1);
    return '<circle class="at-dot ' + (e.high ? 'hi' : 'lo') + '" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="4"/>' +
      '<text class="at-turn-l ' + (e.high ? 'hi' : 'lo') + '" x="' + lx + '" y="' + (y - 21).toFixed(1) + '">' + _almEsc(_atTime(e.t, day.tz)) + '</text>' +
      '<text class="at-turn-h" x="' + lx + '" y="' + (y - 9).toFixed(1) + '">' + _almEsc(_atHeight(e.h, true)) + '</text>';
  }).join('');
  var desc = day.turns.map(function(e) { return t(e.high ? 'alm_tide_high' : 'alm_tide_low') + ' ' + _atTime(e.t, day.tz) + ' ' + _atHeight(e.h); }).join(', ');
  var fx = Math.max(0, Math.min(W, X(focus))), fh = day.p.height(focus);
  var inDay = focus >= day.start && focus <= day.end;
  var nowLine = '<g id="at-now"' + (inDay ? '' : ' style="display:none"') + '>' +
    '<line class="at-now" id="at-now-line" x1="' + fx.toFixed(1) + '" x2="' + fx.toFixed(1) + '" y1="' + (top / 2) + '" y2="' + bot + '"/>' +
    '<circle class="at-now-dot" id="at-now-dot" cx="' + fx.toFixed(1) + '" cy="' + (isFinite(fh) ? Y(fh) : bot).toFixed(1) + '" r="5"/></g>';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" height="' + H + '" role="img" aria-label="' + _almEsc(desc) + '">' +
    '<defs><linearGradient id="at-water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--at-water)" stop-opacity="0.42"/>' +
    '<stop offset="1" stop-color="var(--at-water)" stop-opacity="0.04"/></linearGradient></defs>' +
    night + zero + '<path class="at-area" d="' + area + '" fill="url(#at-water)"/><path class="at-line" d="' + path + '"/>' +
    ticks + turns + nowLine + '</svg>';
}

// ── The month: each day's range, with the Moon's phases over it ─────────────
// Thirty days around the one shown, each a bar as tall as that day's range
// (highest high to lowest low). The springs and neaps are simply there, in
// the harbour's own numbers, under the new, quarter and full Moons that cause
// them; a little after them, too, since a sea takes a day or two to answer.
// A bar is a day to go to.
var AT_MONTH_BEFORE = 14, AT_MONTH_AFTER = 15;
var AT_MONTH_STEP_MS = 20 * 60000;   // a day's range from samples this far apart
var AT_MONTH_MIN_BAR = 0.06;         // the smallest range still shows as a bar
var _atMonthMemo = { key: null, days: null };

function _atMonthDays(st, focus) {
  var tz = _atTideTz(st), p = _atPredictor(st);
  var d0 = _atDayStart(focus, tz);
  var key = st.id + '|' + d0 + '|' + tz;
  if (_atMonthMemo.key === key) return _atMonthMemo.days;
  var days = [];
  for (var k = -AT_MONTH_BEFORE; k <= AT_MONTH_AFTER; k++) {
    // Noon plus whole days, back to that day's midnight: DST-proof.
    var s = _atDayStart(d0 + 12 * AT_MS_HOUR + k * AT_MS_DAY, tz);
    var e = _atDayStart(s + 26 * AT_MS_HOUR, tz);
    var lo = Infinity, hi = -Infinity;
    for (var x = s; x <= e; x += AT_MONTH_STEP_MS) {
      var h = p.height(x);
      if (!isFinite(h)) continue;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    var jdn = Math.floor((s + 12 * AT_MS_HOUR) / AT_MS_DAY) + 2440588;
    days.push({ k: k, start: s, range: hi > lo ? hi - lo : 0,
      phase: typeof _principalPhaseOnDay === 'function' ? _principalPhaseOnDay(jdn, tz) : null });
  }
  _atMonthMemo = { key: key, days: days };
  return days;
}

function _atMonthHtml(st, focus) {
  var days = _atMonthDays(st, focus), tz = _atTideTz(st);
  var max = 0;
  days.forEach(function(d) { if (d.range > max) max = d.range; });
  if (!max) return '';
  var dayFmt = _tzFmt(tz, { day: 'numeric' }), longFmt = _tzFmt(tz, { month: 'short', day: 'numeric' });
  var cols = days.map(function(d) {
    var mid = new Date(d.start + 12 * AT_MS_HOUR);
    var frac = Math.max(AT_MONTH_MIN_BAR, d.range / max);
    var moon = d.phase ? '<span class="at-m-moon" title="' + _almEsc(_localMoonName(d.phase.name)) + '">' + _moonGlyphSVG(d.phase.p, 12) + '</span>' : '<span class="at-m-moon"></span>';
    var label = t('alm_tide_range_day', { date: longFmt.format(mid), h: _atHeight(d.range) }) + (d.phase ? ', ' + _localMoonName(d.phase.name) : '');
    return '<button type="button" class="at-m-day' + (d.k === 0 ? ' on' : '') + (d.phase ? ' ph' : '') + '"' +
      (d.k === 0 ? ' aria-current="date"' : '') + ' aria-label="' + _almEsc(label) + '" onclick="_atGoDay(' + d.k + ')">' +
      moon + '<span class="at-m-well"><span class="at-m-bar" style="height:' + (frac * 100).toFixed(1) + '%"></span></span>' +
      '<span class="at-m-n">' + (d.phase || d.k === 0 ? _almEsc(dayFmt.format(mid)) : '') + '</span></button>';
  }).join('');
  return '<div class="at-month"><div class="at-sub">' + _almEsc(t('alm_tide_range_title')) + '</div>' +
    '<div class="at-m-row" dir="ltr">' + cols + '</div></div>';
}

// A day in the month: the same time of day, that many days on. The whole
// Almanac goes there; this section is only one of the things that follow.
function _atGoDay(k) {
  if (!k) return;
  _almScrubSettle(new Date(_almFocusInstant().getTime() + k * AT_MS_DAY), { land: true });
}

// ── Why: the Earth from above, and the water's two bulges ───────────────────
// Seen from above the North Pole, the Sun off to the right, the Moon where its
// elongation puts it. The water is the equilibrium tide, drawn larger than
// life: a bulge toward the Moon and one away from it, and the Sun's, a little
// under half as tall (0.46), along its own line. In line at new and full Moon
// they add (springs); at the quarters they cross (neaps). The amber dot is the
// harbour, carried round by the Earth's turn, once a day through both bulges.
var AT_FIG_W = 176, AT_FIG_H = 132;
var AT_FIG_CX = 66, AT_FIG_CY = 66;
var AT_FIG_EARTH_R = 27, AT_FIG_SEA_R = 33;
var AT_FIG_MOON_BULGE = 9, AT_FIG_SUN_RATIO = 0.46;
var AT_FIG_MOON_ORBIT = 56, AT_FIG_MOON_R = 6;
var AT_FIG_SEA_STEPS = 72;
var AT_FIG_SUN_R = 7, AT_FIG_SUN_GLOW = 22;     // the Sun, and its glow

function _atFigState(st, ms) {
  var phase = _moonPhase(new Date(ms)).phase;            // 0 new, 0.5 full
  var moonA = phase * 2 * Math.PI;                       // from the Sun's line
  // Mean solar time at the harbour: noon faces the Sun.
  var hours = ((ms / AT_MS_HOUR + st.lo / 15) % 24 + 24) % 24;
  var placeA = Math.PI + hours / 24 * 2 * Math.PI;
  return { phase: phase, moonA: moonA, placeA: placeA };
}
function _atFigPt(a, r) {
  // Counter-clockwise from the right, as seen from above the North Pole.
  return [AT_FIG_CX + r * Math.cos(a), AT_FIG_CY - r * Math.sin(a)];
}
function _atFigSeaPath(moonA) {
  var d = '';
  for (var i = 0; i < AT_FIG_SEA_STEPS; i++) {
    var a = i / AT_FIG_SEA_STEPS * 2 * Math.PI;
    var r = AT_FIG_SEA_R + AT_FIG_MOON_BULGE * (Math.cos(2 * (a - moonA)) + AT_FIG_SUN_RATIO * Math.cos(2 * a)) / (1 + AT_FIG_SUN_RATIO);
    var p = _atFigPt(a, r);
    d += (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
  }
  return d + 'Z';
}

function _atFigSvg(st, ms) {
  var s = _atFigState(st, ms);
  var moon = _atFigPt(s.moonA, AT_FIG_MOON_ORBIT), place = _atFigPt(s.placeA, AT_FIG_EARTH_R);
  var R = AT_FIG_MOON_R;
  return '<svg viewBox="0 0 ' + AT_FIG_W + ' ' + AT_FIG_H + '" width="' + AT_FIG_W + '" height="' + AT_FIG_H + '" role="img" aria-label="' + _almEsc(t('alm_tide_fig_label')) + '">' +
    '<defs><radialGradient id="at-sun"><stop offset="0.3" stop-color="var(--at-sun)" stop-opacity="0.7"/><stop offset="1" stop-color="var(--at-sun)" stop-opacity="0"/></radialGradient></defs>' +
    // The Sun, off to the right (not to scale: it would be 23,000 Earths away).
    '<circle cx="' + (AT_FIG_W - AT_FIG_SUN_GLOW) + '" cy="' + AT_FIG_CY + '" r="' + AT_FIG_SUN_GLOW + '" fill="url(#at-sun)"/>' +
    '<circle class="at-fig-sun" cx="' + (AT_FIG_W - AT_FIG_SUN_GLOW) + '" cy="' + AT_FIG_CY + '" r="' + AT_FIG_SUN_R + '"/>' +
    '<circle class="at-fig-orbit" cx="' + AT_FIG_CX + '" cy="' + AT_FIG_CY + '" r="' + AT_FIG_MOON_ORBIT + '"/>' +
    '<path class="at-fig-sea" id="at-fig-sea" d="' + _atFigSeaPath(s.moonA) + '"/>' +
    // The Earth: its night half away from the Sun.
    '<circle class="at-fig-earth" cx="' + AT_FIG_CX + '" cy="' + AT_FIG_CY + '" r="' + AT_FIG_EARTH_R + '"/>' +
    '<path class="at-fig-night" d="M' + AT_FIG_CX + ' ' + (AT_FIG_CY - AT_FIG_EARTH_R) + 'A' + AT_FIG_EARTH_R + ' ' + AT_FIG_EARTH_R + ' 0 0 0 ' + AT_FIG_CX + ' ' + (AT_FIG_CY + AT_FIG_EARTH_R) + 'Z"/>' +
    '<circle class="at-fig-pole" cx="' + AT_FIG_CX + '" cy="' + AT_FIG_CY + '" r="1.5"/>' +
    // The Moon: lit on its Sun side, wherever it is.
    '<g id="at-fig-moon" transform="translate(' + moon[0].toFixed(1) + ' ' + moon[1].toFixed(1) + ')">' +
      '<circle class="at-fig-moon-dark" r="' + R + '"/>' +
      '<path class="at-fig-moon-lit" d="M0 ' + (-R) + 'A' + R + ' ' + R + ' 0 0 1 0 ' + R + 'Z"/></g>' +
    '<circle class="at-fig-place" id="at-fig-place" cx="' + place[0].toFixed(1) + '" cy="' + place[1].toFixed(1) + '" r="3.5"/>' +
    '</svg>';
}

// What the month is doing, read from the harbour's own ranges (the bars),
// not from the phase: a sea answers the Sun and Moon a day or two late, so
// its biggest tides follow new and full Moon. A day whose range tops (or
// bottoms) every day within AT_WHY_REACH of it is a spring (or a neap), and
// so are the days beside it; between, the next day says growing or easing.
var AT_WHY_REACH = 3;
// Where the once-a-day tide is as big as the twice-a-day one, (K1 + O1) /
// (M2 + S2) above 1.5 (Defant's form number), the month follows the Moon's
// distance north and south of the equator, not its phase.
var AT_DIURNAL_FORM = 1.5;
var AT_IDX_M2 = 0, AT_IDX_S2 = 1, AT_IDX_K1 = 3, AT_IDX_O1 = 5;

function _atDiurnal(st) {
  var a = (st.a ? st : st.refrec || {}).a;
  if (!a) return false;
  return (a[AT_IDX_K1] + a[AT_IDX_O1]) / Math.max(1, a[AT_IDX_M2] + a[AT_IDX_S2]) > AT_DIURNAL_FORM;
}

// The next of the given principal phases (_PRINCIPAL_PHASES p values) after
// an instant, as its English name for _localMoonName.
var AT_PHASE_NAMES = { 0: 'New Moon', 0.25: 'First Quarter', 0.5: 'Full Moon', 0.75: 'Last Quarter' };
function _atNextPhase(phase, targets) {
  var best = null, gap = 2;
  targets.forEach(function(p) {
    var g = ((p - phase) % 1 + 1) % 1;
    if (g < gap) { gap = g; best = p; }
  });
  return AT_PHASE_NAMES[best];
}

function _atWhyState(st, focus) {
  var days = _atMonthDays(st, focus), i0 = AT_MONTH_BEFORE;
  function extreme(i, sign) {
    for (var j = Math.max(0, i - AT_WHY_REACH); j <= Math.min(days.length - 1, i + AT_WHY_REACH); j++) {
      if (sign * (days[j].range - days[i].range) > 0) return false;
    }
    return true;
  }
  function near(sign) { return extreme(i0 - 1, sign) || extreme(i0, sign) || extreme(i0 + 1, sign); }
  var diurnal = _atDiurnal(st), phase = _atFigState(st, focus).phase;
  var kind = near(1) ? (diurnal ? 'tropic' : 'spring')
    : near(-1) ? (diurnal ? 'equatorial' : 'neap')
    : days[i0 + 1].range > days[i0].range ? 'growing' : 'easing';
  if (diurnal) return { kind: kind, desc: 'alm_tide_why_diurnal_desc' };
  if (kind === 'growing') return { kind: kind, desc: 'alm_tide_why_growing_desc', phase: _atNextPhase(phase, [0, 0.5]) };
  if (kind === 'easing') return { kind: kind, desc: 'alm_tide_why_easing_desc', phase: _atNextPhase(phase, [0.25, 0.75]) };
  return { kind: kind, desc: 'alm_tide_why_' + kind + '_desc' };
}

function _atWhyHtml(st, focus) {
  var s = _atWhyState(st, focus);
  return '<div class="at-why">' +
    '<div class="at-fig" id="at-fig">' + _atFigSvg(st, focus) + '</div>' +
    '<div class="at-why-text"><div class="at-why-k">' + _almEsc(t('alm_tide_why_' + s.kind)) + '</div>' +
    '<p class="at-why-d">' + _almEsc(t(s.desc, s.phase ? { phase: _localMoonName(s.phase) } : undefined)) + '</p></div></div>' +
    '<p class="at-why-n">' + _almEsc(t('alm_tide_fig_note')) + '</p>';
}

// One time-machine frame: the Moon goes round, the bulges follow it, the
// harbour turns through them, and the day's amber line slides along the
// water. Attributes only: no text, no layout.
function _atTravel(focus) {
  var st = _at.data && !_at.data.failed && _atTideStation();
  var fig = _atEl('at-fig');
  if (!st || !fig) return;
  var ms = focus.getTime();
  if (_atBeyond(ms)) return;
  var s = _atFigState(st, ms);
  var moon = _atFigPt(s.moonA, AT_FIG_MOON_ORBIT), place = _atFigPt(s.placeA, AT_FIG_EARTH_R);
  _atEl('at-fig-sea').setAttribute('d', _atFigSeaPath(s.moonA));
  _atEl('at-fig-moon').setAttribute('transform', 'translate(' + moon[0].toFixed(1) + ' ' + moon[1].toFixed(1) + ')');
  var pl = _atEl('at-fig-place');
  pl.setAttribute('cx', place[0].toFixed(1)); pl.setAttribute('cy', place[1].toFixed(1));
  var c = _at.curve, g = _atEl('at-now');
  if (!c || !g) return;
  var inDay = ms >= c.start && ms <= c.end;
  g.style.display = inDay ? '' : 'none';
  if (!inDay) return;
  var x = c.X(ms).toFixed(1), h = c.p.height(ms);
  var line = _atEl('at-now-line'), dot = _atEl('at-now-dot');
  line.setAttribute('x1', x); line.setAttribute('x2', x);
  dot.setAttribute('cx', x); dot.setAttribute('cy', (isFinite(h) ? c.Y(h) : c.bot).toFixed(1));
}

// The drawings are made at the width they are shown (their viewBox is that
// many pixels), so text and dots keep their size on any screen; a resize to a
// new width draws them again.
var _atDrawnW = 0, _atResizeTimer = 0;
function _atWidth() {
  var host = _atEl('almanac-place');
  var w = host && host.clientWidth;
  _atDrawnW = w > 0 ? Math.round(w) : AT_DEFAULT_W;
  return _atDrawnW;
}
function _atBindCurve() {
  if (_atBindCurve.bound) return;
  _atBindCurve.bound = true;
  window.addEventListener('resize', function() {
    clearTimeout(_atResizeTimer);
    _atResizeTimer = setTimeout(function() {
      var host = _atEl('almanac-place');
      if (host && host.clientWidth && Math.round(host.clientWidth) !== _atDrawnW) _atRender();
    }, 150);
  });
}
