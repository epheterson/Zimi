// ── Almanac: the tide and the frost, here ──
// Loaded only when the Almanac's place panel scrolls near (almanac.js
// _almPlaceWatch); nothing here runs on the Almanac's first paint. Two answers
// for the chosen place, both from data that ships with Zimi:
//
//   Tides   NOAA CO-OPS harmonic constants (zimi/assets/tides-snapshot.json.gz),
//           predicted here for any date by harmonic synthesis, the method NOAA
//           itself uses (Schureman 1958; Parker 2007): 37 constituents, nodal
//           factors f and u for the year, equilibrium arguments V0 at its start.
//           Subordinate stations take NOAA's published time and height offsets
//           from their reference station's highs and lows.
//   Frost   NOAA NCEI 1991-2020 climate normals: last spring and first fall
//           freeze at 32 F and 28 F, at 10, 50 and 90 percent.
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
        kind: 'harmonic',
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
      kind: 'subordinate',
      extremes: function(a, b) { return subordinateExtremes(ref, rec, a, b); },
      height: function(ms) {
        var l = turnsAround(ms);
        for (var i = 1; i < l.length; i++) if (l[i].t >= ms) return between(l[i - 1], l[i], ms);
        return NaN;
      }
    };
  }

  return {
    astro: astro, yearTerms: yearTerms, predictor: predictor,
    CONSTITUENTS: CONSTITUENTS, compoundOf: compoundOf, M_PER_FT: M_PER_FT
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
// Past this, a tide station describes some other water: say how far the
// nearest is instead of drawing it as this place's tide.
var AT_TIDE_NEAR_KM = 80;
// Past this, freeze dates describe another climate (a few hundred metres of
// elevation already moves them a week or more).
var AT_FROST_NEAR_KM = 150;
// Within this, an inland place is offered its nearest coast; past it (Denver's
// nearest is on the Gulf of California) the line would only be noise.
var AT_TIDE_FAR_KM = 300;
var AT_KM_PER_MI = 1.609344;
var AT_TIDE_YEARS = 200;   // how far from today a tide prediction is offered
var AT_UNITS_KEY = 'zimi_almanac_units';
var AT_LTR = '⁦', AT_POP = '⁩';   // left-to-right isolate, and its end
var AT_FROST_32F = 32, AT_FROST_28F = 28;
// Days before each month in a non-leap year: NCEI writes dates as month/day.
var AT_DAYS_BEFORE = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
var AT_CURVE_H = 168, AT_CURVE_PAD_T = 18, AT_CURVE_PAD_B = 22;
var AT_STRIP_H = 46;
var AT_DEFAULT_W = 568;   // the Almanac's column, before it has been measured

var _at = {
  key: null,        // the place the last answer was for
  data: null,       // /almanac-place answer for it
  loading: false,
  tideId: null,     // a station picked over the nearest, for this place
  frostId: null,
  picking: null,    // 'tide' | 'frost' while a station list is open
  query: '',
  results: null,
  sheetMonth: null  // {y, m} while the month table is open
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
  if (_at.sheetMonth) _atSheetRender();
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
function _atTemp(f) {
  return _atUnits() === 'ft' ? f + '°F' : _atNum((f - 32) * 5 / 9, 0) + '°C';
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
  _at.tideId = _at.frostId = null; _at.picking = null;
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
function _atFrostStation() {
  var list = (_at.data && _at.data.frost && _at.data.frost.stations) || [];
  if (_at.frostId) for (var i = 0; i < list.length; i++) if (list[i].id === _at.frostId) return list[i];
  if (_at.frostPicked && _at.frostPicked.id === _at.frostId) return _at.frostPicked;
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
  if (!loc.stored) { host.innerHTML = _atEmptyHtml(); return; }
  _atEnsureData(loc);
  if (_at.loading || !_at.data) { host.innerHTML = ''; return; }
  if (_at.data.failed) { host.innerHTML = ''; return; }
  var tide = _atTideStation(), frost = _atFrostStation();
  var tideNear = tide && (_at.tideId || tide.km <= AT_TIDE_NEAR_KM);
  var frostNear = frost && (_at.frostId || frost.km <= AT_FROST_NEAR_KM);
  var html = '';
  if (tideNear) html += _atTideHtml(tide);
  if (frostNear) html += _atFrostHtml(frost, tideNear);
  if (!tideNear && !frostNear) {
    html += _atSection(t('alm_place_title'), '<p class="at-quiet">' + _almEsc(t('alm_place_none')) + '</p>' + _atSearchHtml());
  } else if (!tideNear && tide && tide.km <= AT_TIDE_FAR_KM) {
    // Inland: one quiet line, and the way to the coast if wanted.
    html += '<p class="at-quiet at-far"><button type="button" class="at-link" onclick="_atPick(\'tide\')">' +
      _almEsc(t('alm_tide_far', { name: _atTideName(tide), d: _atDistance(tide.km) })) + '</button></p>';
    if (_at.picking === 'tide') html += _atPickerHtml('tide');
  }
  host.innerHTML = html;
  _atBindCurve();
}

// Re-render for a new focus instant or place (almanac.js _almRepaintFocus).
function _atRepaint() { _atRender(); }

function _atSection(title, body, cls) {
  return '<section class="almanac-section at-section' + (cls ? ' ' + cls : '') + '">' +
    '<div class="almanac-section-title">' + _almEsc(title) + '</div>' + body + '</section>';
}

function _atEmptyHtml() {
  return _atSection(t('alm_place_title'),
    '<p class="at-quiet">' + _almEsc(t('alm_place_empty')) + '</p>' + _atSearchHtml());
}

function _atSearchHtml() {
  var res = '';
  if (_at.results) {
    var rows = _at.results.tides.stations.map(function(s) { return _atRowHtml('tide', s, _atTideName(s)); })
      .concat(_at.results.frost.stations.map(function(s) { return _atRowHtml('frost', s, s.name); }));
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
  var tag = '<span class="at-row-kind">' + _almEsc(t(kind === 'tide' ? 'alm_tide_title' : 'alm_frost_kind')) + '</span>';
  return '<li><button type="button" class="at-row" onclick="_atChoose(\'' + kind + '\',\'' + _almEsc(s.id) + '\')">' +
    '<span class="at-row-name">' + _almEsc(name) + '</span>' + (_at.picking ? '' : tag) + dist + '</button></li>';
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
      if (_at.picking) {
        // Inside a station list: only that kind.
        d = { tides: { stations: _at.picking === 'tide' ? d.tides.stations : [] }, frost: { stations: _at.picking === 'frost' ? d.frost.stations : [] } };
      }
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
  if (_at.results) pool = kind === 'tide' ? _at.results.tides.stations : _at.results.frost.stations;
  if (_at.data && !_at.data.failed) pool = pool.concat(kind === 'tide' ? _at.data.tides.stations : _at.data.frost.stations);
  var st = null;
  for (var i = 0; i < pool.length; i++) if (pool[i].id === id) { st = pool[i]; break; }
  if (!st) return;
  if (!_getLocation().stored) {
    // No place yet: a station chosen by name IS the place. One place, one
    // clock: the whole Almanac follows it.
    var lat = kind === 'tide' ? st.la : st.lat, lon = kind === 'tide' ? st.lo : st.lon;
    _at.query = ''; _at.results = null;
    _saveLocation(lat, lon, kind === 'tide' ? _atTitle(st.n) : st.name);
    _almRepaintFocus();
    return;
  }
  if (kind === 'tide') { _at.tideId = id; _at.tidePicked = st; } else { _at.frostId = id; _at.frostPicked = st; }
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
  var near = kind === 'tide' ? _at.data.tides.stations : _at.data.frost.stations;
  var list = _at.results ? (kind === 'tide' ? _at.results.tides.stations : _at.results.frost.stations) : near;
  var rows = list.map(function(s) { return _atRowHtml(kind, s, kind === 'tide' ? _atTideName(s) : s.name); });
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
function _atTideDay(st, focusMs) {
  var tz = _atTideTz(st), p = _atPredictor(st);
  var start = _atDayStart(focusMs, tz);
  var end = _atDayStart(start + 26 * AT_MS_HOUR, tz);
  return { tz: tz, start: start, end: end, p: p, turns: p.extremes(start, end) };
}

function _atTideHtml(st) {
  var focus = _almFocusInstant().getTime();
  // Harmonic constants describe today's harbour; centuries away its shape,
  // depth and sea level were or will be other. Say so rather than predict.
  if (Math.abs(new Date(focus).getUTCFullYear() - new Date().getUTCFullYear()) > AT_TIDE_YEARS) {
    return _atSection(t('alm_tide_title'), '<p class="at-quiet">' + _almEsc(t('alm_tide_beyond', { n: AT_TIDE_YEARS })) + '</p>', 'at-tides');
  }
  var day = _atTideDay(st, focus);
  var next = day.p.extremes(focus, focus + AT_NEXT_WINDOW_MS)[0];
  var nowH = day.p.height(focus);
  var lead = '';
  if (next) {
    var when = _atTime(next.t, day.tz);
    lead = '<div class="at-lead">' +
      '<span class="at-lead-dir ' + (next.high ? 'rising' : 'falling') + '">' + _almEsc(t(next.high ? 'alm_tide_rising' : 'alm_tide_falling')) + '</span>' +
      '<span class="at-lead-next">' + _almEsc(t(next.high ? 'alm_tide_next_high' : 'alm_tide_next_low', { time: when })) +
      '<span class="at-lead-h">' + _almEsc(_atHeight(next.h)) + '</span></span>' +
      (isFinite(nowH) ? '<span class="at-lead-now">' + _almEsc(t('alm_tide_now', { h: _atHeight(nowH) })) + '</span>' : '') +
      '</div>';
  }
  var turns = day.turns.map(function(e) {
    return '<li class="' + (e.high ? 'hi' : 'lo') + '"><span class="at-turn-k">' + _almEsc(t(e.high ? 'alm_tide_high' : 'alm_tide_low')) + '</span>' +
      '<span class="at-turn-t">' + _almEsc(_atTime(e.t, day.tz)) + '</span><span class="at-turn-h">' + _almEsc(_atHeight(e.h)) + '</span></li>';
  }).join('');
  var note = st.refrec
    ? t('alm_tide_note_sub', { ref: _atTitle(st.refrec.n) })
    : t('alm_tide_note');
  var body = lead +
    '<div class="at-curve" id="at-curve">' + _atCurveSvg(st, day, focus) + '</div>' +
    '<ol class="at-turns">' + turns + '</ol>' +
    _atStationLine('tide', _atTideName(st), st.km, true) +
    (_at.picking === 'tide' ? _atPickerHtml('tide') : '') +
    '<div class="at-foot"><button type="button" class="at-btn" onclick="_atSheetOpen()">' + _almEsc(t('alm_tide_month')) + '</button>' +
    '<p class="at-note">' + _almEsc(note) + '</p></div>';
  return _atSection(t('alm_tide_title'), body, 'at-tides');
}

// The day's water as one shape: midnight to midnight in the harbour's time,
// night shaded from the Sun's altitude, the turns as dots, the focused
// instant as the Almanac's amber line. Height runs from the chart datum (0,
// mean lower low water) to the station's mean higher high water, widened
// only when the day goes past them, so springs look bigger than neaps.
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
  if (!pts.length || hi - lo < 1e-3) return '';
  var span = day.end - day.start, W = _atWidth(), H = AT_CURVE_H;
  var top = AT_CURVE_PAD_T, bot = H - AT_CURVE_PAD_B;
  function X(ms) { return (ms - day.start) / span * W; }
  function Y(h) { return bot - (h - lo) / (hi - lo) * (bot - top); }
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
    ticks += '<line class="at-tick" x1="' + X(tm).toFixed(1) + '" x2="' + X(tm).toFixed(1) + '" y1="' + (H - AT_CURVE_PAD_B + 4) + '" y2="' + (H - AT_CURVE_PAD_B + 8) + '"/>' +
      '<text class="at-tick-l" x="' + X(tm).toFixed(1) + '" y="' + (H - 4) + '">' + _almEsc(_tzFmt(day.tz, { hour: 'numeric' }).format(new Date(tm))) + '</text>';
  }
  var zero = lo < 0 ? '<line class="at-datum" x1="0" x2="' + W + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '"/>' : '';
  var dots = day.turns.map(function(e) {
    return '<circle class="at-dot ' + (e.high ? 'hi' : 'lo') + '" cx="' + X(e.t).toFixed(1) + '" cy="' + Y(e.h).toFixed(1) + '" r="4"/>';
  }).join('');
  var nowLine = '';
  if (focus >= day.start && focus <= day.end) {
    var fh = day.p.height(focus);
    nowLine = '<line class="at-now" x1="' + X(focus).toFixed(1) + '" x2="' + X(focus).toFixed(1) + '" y1="' + top / 2 + '" y2="' + bot + '"/>' +
      (isFinite(fh) ? '<circle class="at-now-dot" cx="' + X(focus).toFixed(1) + '" cy="' + Y(fh).toFixed(1) + '" r="5"/>' : '');
  }
  var desc = day.turns.map(function(e) { return t(e.high ? 'alm_tide_high' : 'alm_tide_low') + ' ' + _atTime(e.t, day.tz) + ' ' + _atHeight(e.h); }).join(', ');
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + _almEsc(desc) + '">' +
    '<defs><linearGradient id="at-water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--at-water)" stop-opacity="0.42"/>' +
    '<stop offset="1" stop-color="var(--at-water)" stop-opacity="0.04"/></linearGradient></defs>' +
    night + zero + '<path class="at-area" d="' + area + '" fill="url(#at-water)"/><path class="at-line" d="' + path + '"/>' +
    ticks + dots + nowLine + '</svg>';
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

// ── The month, as a printable table ─────────────────────────────────────────
function _atSheetOpen() {
  var st = _atTideStation();
  if (!st) return;
  var tz = _atTideTz(st);
  var parts = _tzFmt(tz, { year: 'numeric', month: 'numeric' }, 'en-US').formatToParts(_almFocusInstant());
  var p = {};
  parts.forEach(function(x) { p[x.type] = +x.value; });
  _at.sheetMonth = { y: p.year, m: p.month - 1 };
  var sheet = _atEl('at-sheet');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'at-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    document.body.appendChild(sheet);
    sheet.addEventListener('keydown', function(e) { if (e.key === 'Escape') _atSheetClose(); });
  }
  document.body.classList.add('at-sheet-open');
  _atSheetRender();
  var close = sheet.querySelector('.at-sheet-close');
  if (close) close.focus({ preventScroll: true });
}
function _atSheetClose() {
  _at.sheetMonth = null;
  var s = _atEl('at-sheet');
  if (s) s.remove();
  document.body.classList.remove('at-sheet-open');
}
function _atSheetStep(dir) {
  var m = _at.sheetMonth;
  m.m += dir;
  if (m.m < 0) { m.m = 11; m.y--; } else if (m.m > 11) { m.m = 0; m.y++; }
  _atSheetRender();
}

function _atSheetRender() {
  var sheet = _atEl('at-sheet'), st = _atTideStation();
  if (!sheet || !st || !_at.sheetMonth) return;
  var tz = _atTideTz(st), p = _atPredictor(st), y = _at.sheetMonth.y, m = _at.sheetMonth.m;
  var first = _atMidnight(y, m, 1, tz);
  var monthName = _tzFmt(tz, { month: 'long', year: 'numeric' }).format(new Date(first + 12 * AT_MS_HOUR));
  var wd = _tzFmt(tz, { weekday: 'short' });
  var rows = '', d = 1;
  for (;;) {
    var s = _atMidnight(y, m, d, tz);
    var mo = +_tzFmt(tz, { month: 'numeric' }, 'en-US').format(new Date(s + 12 * AT_MS_HOUR)) - 1;
    if (mo !== m) break;
    var e = _atMidnight(y, m, d + 1, tz);
    var turns = p.extremes(s, e);
    var jdn = Math.floor((s + 12 * AT_MS_HOUR) / AT_MS_DAY) + 2440588;
    var phase = typeof _principalPhaseOnDay === 'function' ? _principalPhaseOnDay(jdn, tz) : null;
    var moon = phase ? '<span class="at-moon" title="' + _almEsc(_localMoonName(phase.name)) + '">' + _moonGlyphSVG(phase.p, 12) + '</span>' : '';
    var cells = '';
    for (var i = 0; i < 4; i++) {
      var tn = turns[i];
      cells += tn ? '<td class="' + (tn.high ? 'hi' : 'lo') + '"><span class="at-c-t">' + _almEsc(_atTime(tn.t, tz)) + '</span> <span class="at-c-h">' + _almEsc(_atHeight(tn.h, true)) + '</span></td>' : '<td></td>';
    }
    rows += '<tr><th scope="row"><span class="at-d">' + d + '</span> <span class="at-wd">' + _almEsc(wd.format(new Date(s + 12 * AT_MS_HOUR))) + '</span>' + moon + '</th>' + cells + '</tr>';
    d++;
  }
  var unit = t(_atUnits() === 'ft' ? 'alm_unit_ft' : 'alm_unit_m');
  sheet.innerHTML =
    '<div class="at-sheet-bar">' +
      '<button type="button" class="at-btn at-sheet-nav" onclick="_atSheetStep(-1)" aria-label="' + _almEsc(t('alm_tide_prev_month')) + '">‹</button>' +
      '<button type="button" class="at-btn at-sheet-nav" onclick="_atSheetStep(1)" aria-label="' + _almEsc(t('alm_tide_next_month')) + '">›</button>' +
      '<span class="at-sheet-gap"></span>' +
      '<button type="button" class="at-btn" onclick="window.print()">' + _almEsc(t('alm_tide_print')) + '</button>' +
      '<button type="button" class="at-btn at-sheet-close" onclick="_atSheetClose()">' + _almEsc(t('alm_tm_close')) + '</button>' +
    '</div>' +
    '<div class="at-sheet-page">' +
      '<h2 class="at-sheet-title">' + _almEsc(t('alm_tide_month_title', { station: _atTideName(st) })) + '</h2>' +
      '<div class="at-sheet-sub">' + _almEsc(monthName) + ' · ' + _almEsc(t('alm_tide_sheet_units', { unit: unit })) + '</div>' +
      '<table class="at-table"><thead><tr><th scope="col">' + _almEsc(t('alm_tide_col_day')) + '</th>' +
      '<th scope="col" colspan="4">' + _almEsc(t('alm_tide_col_turns')) + '</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p class="at-sheet-note">' + _almEsc(st.refrec ? t('alm_tide_note_sub', { ref: _atTitle(st.refrec.n) }) : t('alm_tide_note')) + ' ' +
      _almEsc(t('alm_tide_sheet_source', { lat: st.la.toFixed(3), lon: st.lo.toFixed(3), id: st.id })) + '</p>' +
    '</div>';
}

// ── Frost ────────────────────────────────────────────────────────────────────
// Day of a non-leap year for a date in the focused year (Feb 29 reads as Feb 28).
function _atDoy(ms, tz) {
  var parts = _tzFmt(tz, { month: 'numeric', day: 'numeric' }, 'en-US').formatToParts(new Date(ms));
  var p = {};
  parts.forEach(function(x) { p[x.type] = +x.value; });
  return AT_DAYS_BEFORE[p.month - 1] + Math.min(p.day, p.month === 2 ? 28 : 31);
}
function _atDoyDate(doy) {
  var m = 0;
  while (m < 11 && AT_DAYS_BEFORE[m + 1] < doy) m++;
  var d = new Date(Date.UTC(2001, m, doy - AT_DAYS_BEFORE[m]));
  return _tzFmt('UTC', { month: 'short', day: 'numeric' }).format(d);
}
function _atPct(p) { return new Intl.NumberFormat(_atLang(), { style: 'percent' }).format(Math.round(p * 20) / 20); }

// Chance of a frost still to come in spring (or already come in fall), from
// the three dates NCEI gives (10, 50, 90 percent), linear between them.
function _atOdds(doy, d10, d50, d90, spring) {
  var pts = spring ? [[d90, 0.9], [d50, 0.5], [d10, 0.1]] : [[d10, 0.1], [d50, 0.5], [d90, 0.9]];
  if (doy <= pts[0][0]) return pts[0][1];
  if (doy >= pts[2][0]) return pts[2][1];
  var i = doy <= pts[1][0] ? 0 : 1, a = pts[i], b = pts[i + 1];
  return a[1] + (b[1] - a[1]) * (doy - a[0]) / Math.max(1, b[0] - a[0]);
}

// Days on the frost year: 0 = 1 July. Every station's first fall frost falls
// before its last spring frost on it, wherever New Year lands between them.
var AT_FROST_YEAR_START = 182;
function _atFy(doy) { return (doy - AT_FROST_YEAR_START + 365) % 365; }

function _atFrostStatus(f, doy) {
  var d = _atFy(doy);
  if (d < _atFy(f.f32_10)) return ['safe', t('alm_frost_safe')];
  if (d <= _atFy(f.f32_90)) return ['odds', t('alm_frost_odds_fall', { p: _atPct(_atOdds(d, _atFy(f.f32_10), _atFy(f.f32_50), _atFy(f.f32_90), false)) })];
  if (d < _atFy(f.l32_90)) return ['wait', t('alm_frost_still')];
  if (d <= _atFy(f.l32_10)) return ['odds', t('alm_frost_odds_spring', { p: _atPct(_atOdds(d, _atFy(f.l32_10), _atFy(f.l32_50), _atFy(f.l32_90), true)) })];
  return ['safe', t('alm_frost_safe')];
}

function _atFrostHtml(f, withUnits) {
  var loc = _getLocation(), tz = _almDisplayTz(loc);
  var doy = _atDoy(_almFocusInstant().getTime(), tz);
  var hasDates = f.l32_50 > 0 && f.f32_50 > 0;
  var AT_RARE = 500;   // occ32 is per mille: under half the years freeze
  var body;
  if (hasDates && f.occ32 >= 0 && f.occ32 < AT_RARE) {
    body = '<p class="at-frost-none">' + _almEsc(t('alm_frost_rare', { p: _atPct(f.occ32 / 1000) })) + '</p>' +
      '<p class="at-frost-more">' + _almEsc(t('alm_frost_rare_when', { a: _atDoyDate(f.f32_10), b: _atDoyDate(f.l32_10) })) + '</p>';
  } else if (!hasDates) {
    // No average dates: either it hardly ever freezes, or it can freeze in
    // any month. NCEI's "percent of years with a freeze" tells which.
    var occ = f.occ32 / 1000;
    var msg = occ <= 0 ? t('alm_frost_never')
      : occ >= 0.9 ? t('alm_frost_any')
      : t('alm_frost_rare', { p: _atPct(occ) });
    body = '<p class="at-frost-none">' + _almEsc(msg) + '</p>';
  } else {
    var status = _atFrostStatus(f, doy);
    // As the tide card: what is true on the day shown, then the year it
    // sits in, then the dates that year turns on.
    body =
      '<p class="at-status ' + status[0] + '">' + _almEsc(status[1]) + '</p>' +
      '<div class="at-strip">' + _atStripSvg(f, doy, tz) + '</div>' +
      '<div class="at-frost-pair">' +
        _atFrostFact(t('alm_frost_last'), f.l32_50, f.l32_90, f.l32_10) +
        _atFrostFact(t('alm_frost_first'), f.f32_50, f.f32_10, f.f32_90) +
      '</div>' +
      '<p class="at-frost-more">' +
        (f.gsl32 > 0 ? _almEsc(tPlural('alm_frost_season', f.gsl32)) : '') +
        (f.l28_50 > 0 && f.f28_50 > 0 ? '<span>' + _almEsc(t('alm_frost_hard', { temp: _atTemp(AT_FROST_28F), a: _atDoyDate(f.l28_50), b: _atDoyDate(f.f28_50) })) + '</span>' : '') +
      '</p>';
  }
  body += _atStationLine('frost', f.name, f.km, !withUnits) +
    (_at.picking === 'frost' ? _atPickerHtml('frost') : '') +
    '<p class="at-note">' + _almEsc(t('alm_frost_note', { temp: _atTemp(AT_FROST_32F) })) + '</p>';
  return _atSection(t('alm_frost_title'), body, 'at-frost');
}

function _atFrostFact(label, d50, a, b) {
  return '<div class="at-fact"><div class="at-fact-l">' + _almEsc(label) + '</div>' +
    '<div class="at-fact-v">' + _almEsc(_atDoyDate(d50)) + '</div>' +
    '<div class="at-fact-r">' + _almEsc(t('alm_frost_range', { a: _atDoyDate(a), b: _atDoyDate(b) })) + '</div></div>';
}

// The year as a strip: the growing season solid between the average dates,
// fading in and out across the 10 to 90 percent spread (so the uncertainty is
// the gradient, not a number), the focused day as the amber mark.
function _atStripSvg(f, doy, tz) {
  var W = _atWidth(), H = AT_STRIP_H, bandY = 8, bandH = 18;
  function X(d) { return (d - 1) / 365 * W; }
  // l90 <= l10 <= f10 <= f90 along the year, each pushed a year on if it
  // would fall before the one it follows.
  var seq = [f.l32_90, f.l32_10, f.f32_10, f.f32_90];
  for (var i = 1; i < seq.length; i++) while (seq[i] < seq[i - 1]) seq[i] += 365;
  var a = X(seq[0]), b = X(seq[1]), c = X(seq[2]), d = X(seq[3]);
  var g = '<defs>' +
    '<linearGradient id="at-sp" x1="' + a + '" x2="' + b + '" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="var(--at-grow)" stop-opacity="0"/><stop offset="1" stop-color="var(--at-grow)" stop-opacity="0.85"/></linearGradient>' +
    '<linearGradient id="at-fa" x1="' + c + '" x2="' + d + '" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="var(--at-grow)" stop-opacity="0.85"/><stop offset="1" stop-color="var(--at-grow)" stop-opacity="0"/></linearGradient>' +
    '<clipPath id="at-year"><rect x="0" y="0" width="' + W + '" height="' + H + '" rx="4"/></clipPath>' +
    '</defs>';
  var grow = '<g id="at-grow">' +
    '<rect x="' + a + '" y="' + bandY + '" width="' + Math.max(0, b - a) + '" height="' + bandH + '" fill="url(#at-sp)"/>' +
    '<rect class="at-strip-grow" x="' + b + '" y="' + bandY + '" width="' + Math.max(0, c - b) + '" height="' + bandH + '"/>' +
    '<rect x="' + c + '" y="' + bandY + '" width="' + Math.max(0, d - c) + '" height="' + bandH + '" fill="url(#at-fa)"/></g>';
  var band = '<rect class="at-strip-bg" x="0" y="' + bandY + '" width="' + W + '" height="' + bandH + '" rx="4"/>' +
    '<g clip-path="url(#at-year)">' + grow + (d > W ? '<use href="#at-grow" transform="translate(' + (-W) + ' 0)"/>' : '') + '</g>';
  var months = '';
  for (var m = 0; m < 12; m++) {
    var x0 = X(AT_DAYS_BEFORE[m] + 1);
    if (m) months += '<line class="at-strip-tick" x1="' + x0 + '" x2="' + x0 + '" y1="' + bandY + '" y2="' + (bandY + bandH) + '"/>';
    var mid = X(AT_DAYS_BEFORE[m] + 15);
    months += '<text class="at-strip-m" x="' + mid + '" y="' + (H - 4) + '">' + _almEsc(_tzFmt('UTC', { month: 'narrow' }).format(new Date(Date.UTC(2001, m, 15)))) + '</text>';
  }
  var mark = '<line class="at-strip-now" x1="' + X(doy) + '" x2="' + X(doy) + '" y1="2" y2="' + (bandY + bandH + 4) + '"/>';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">' + g + band + months + mark + '</svg>';
}
