/* ZimiGames card backs: twelve finished designs, each drawn by code in the card's 92 x 132 art box (the cream margin is cards.js's).
   The construction rule for every back:
   - The art box is 92 x 132, centre (46, 66). A band of ground colour carries two rules (outer at inset 3.5, hairline at 7.5).
   - A patterned back puts its pattern in a field of whole cells that starts and ends on a cell line, centred on the card, so the
     pattern meets the band at its inner edge and never leaves a sliver. Everything is symmetric across both axes and the same
     turned 180 degrees (halves that point up and down are one drawing turned half a turn about the centre).
   - Scenes (night, sea, castle) are pictures: they get the band and a clean panel, and are not symmetric.
   - Lines sit on whole or half units, so they are crisp at full size; at tableau size (about 40px wide, 0.4px a unit) the cells are
     5 to 14 units, 2 to 6px, so the pattern reads as texture and never aliases into a moire.
   Only the Zimi back carries the mark. The animations are cards.css's (paused with the tab, off under reduced motion). */
(function (root) {
  'use strict';

  var W = 92, H = 132, CX = 46, CY = 66;
  var FX = 11, FY = 11, FW = 70, FH = 110; // the shared field: 7 x 11 cells of 10, or 5 x 5 of 14 x 22; an 11 unit band all round
  function f(v) { return String(+v.toFixed(2)); }
  function attrs(o) { return Object.keys(o).map(function (k) { return ' ' + k + '="' + o[k] + '"'; }).join(''); }
  function el(tag, o) { return '<' + tag + attrs(o) + '/>'; }
  function rect(x, y, w, h, o) { o = o || {}; o.x = x; o.y = y; o.width = w; o.height = h; return el('rect', o); }
  function clip(x, y, w, h, inner) {
    return '<svg x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" viewBox="' + x + ' ' + y + ' ' + w + ' ' + h + '" overflow="hidden">' + inner + '</svg>';
  }
  function turned(inner) { return '<g transform="rotate(180 ' + CX + ' ' + CY + ')">' + inner + '</g>'; }
  // The band: ground, an outer rule at inset 3.5 and a hairline at 7.5.
  function band(ground, rule, hair) {
    return rect(0, 0, W, H, { fill: ground }) +
      rect(3.5, 3.5, 85, 125, { class: 'zc-rule', fill: 'none', stroke: rule, 'stroke-width': 1.2 }) +
      rect(7.5, 7.5, 77, 117, { class: 'zc-rule', fill: 'none', stroke: rule, 'stroke-width': hair || 0.5, opacity: 0.6 });
  }
  // Diamond outline with its centre and half sizes.
  function diamond(cx, cy, a, b) { return 'M' + f(cx) + ' ' + f(cy - b) + 'l' + f(a) + ' ' + f(b) + ' ' + f(-a) + ' ' + f(b) + ' ' + f(-a) + ' ' + f(-b) + 'z'; }
  // 45 degree lines every s across a field whose sides are whole multiples of s: they meet the edge at cell corners, in V's.
  function diagonals(x0, y0, w, h, s) {
    var d = '', x1 = x0 + w, y1 = y0 + h, c, a, b;
    for (c = x0 + y0 + s; c < x1 + y1; c += s) { a = Math.max(x0, c - y1); b = Math.min(x1, c - y0); d += 'M' + a + ' ' + (c - a) + 'L' + b + ' ' + (c - b); }
    for (c = x0 - y1 + s; c < x1 - y0; c += s) { a = Math.max(x0, c + y0); b = Math.min(x1, c + y1); d += 'M' + a + ' ' + (a - c) + 'L' + b + ' ' + (b - c); }
    return d;
  }
  function circlePath(cx, cy, r) { return 'M' + f(cx - r) + ' ' + f(cy) + 'a' + f(r) + ' ' + f(r) + ' 0 1 0 ' + f(2 * r) + ' 0a' + f(r) + ' ' + f(r) + ' 0 1 0 ' + f(-2 * r) + ' 0'; }
  // A closed smooth curve through points (Catmull-Rom as cubic Beziers).
  function smooth(p) {
    var n = p.length, d = 'M' + f(p[0][0]) + ' ' + f(p[0][1]), i, a, b, c, e;
    for (i = 0; i < n; i++) {
      a = p[(i + n - 1) % n]; b = p[i]; c = p[(i + 1) % n]; e = p[(i + 2) % n];
      d += 'C' + f(b[0] + (c[0] - a[0]) / 6) + ' ' + f(b[1] + (c[1] - a[1]) / 6) + ' ' + f(c[0] - (e[0] - b[0]) / 6) + ' ' + f(c[1] - (e[1] - b[1]) / 6) + ' ' + f(c[0]) + ' ' + f(c[1]);
    }
    return d + 'z';
  }

  function make(env) {
    var T = env.T, MARK_FROM = env.MARK_FROM;

    // ── Scenes (kept from the first six), now inside the band ──
    var WAVE_PERIOD = 46, WAVE_REPEATS = 8;
    function wavePath(y, fill) {
      var d = 'M0 ' + y + 'q' + WAVE_PERIOD / 4 + '-6 ' + WAVE_PERIOD / 2 + ' 0', k;
      for (k = 0; k < WAVE_REPEATS; k++) d += 't' + WAVE_PERIOD / 2 + ' 0';
      return '<path d="' + d + 'V' + H + 'H0z" fill="' + fill + '"/>';
    }
    function stars(cls, pts) {
      return '<g class="zc-tw ' + cls + '" fill="#fff">' + pts.map(function (p) { return '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + p[2] + '"/>'; }).join('') + '</g>';
    }
    // A scene's panel: 77 x 117 at 7.5, its picture clipped to it, a hairline round it.
    function scene(ground, rule, picture) {
      return band(ground, rule) + clip(7.5, 7.5, 77, 117, picture) + rect(7.5, 7.5, 77, 117, { fill: 'none', stroke: rule, 'stroke-width': 0.8 });
    }

    // ── The twelve ──
    var ART = {
      // Black and amber. Field 70 x 110 at (11,11): 45 degree lines every 10 make rhombi that meet the band in V's. The cartouche is
      // the 5 x 9 block of cells (21..71 x 21..111) around the centre; the lattice stops on its frame. A diamond is inscribed in it and
      // the Z sits at the centre, the one place the mark appears.
      zimi: function () {
        return rect(0, 0, W, H, { fill: '#0c0c0e' }) +
          el('path', { d: diagonals(FX, FY, FW, FH, 10), fill: 'none', stroke: MARK_FROM, 'stroke-width': 0.5, opacity: 0.34 }) +
          rect(3.5, 3.5, 85, 125, { fill: 'none', stroke: 'url(#zc-g-mark)', 'stroke-width': 1.2 }) +
          rect(7.5, 7.5, 77, 117, { fill: 'none', stroke: MARK_FROM, 'stroke-width': 0.5, opacity: 0.45 }) +
          rect(FX, FY, FW, FH, { fill: 'none', stroke: MARK_FROM, 'stroke-width': 0.5, opacity: 0.45 }) +
          rect(21, 21, 50, 90, { fill: '#100d0c', stroke: 'url(#zc-g-mark)', 'stroke-width': 1.2 }) +
          '<circle cx="46" cy="66" r="24" fill="url(#zc-g-glow)"/>' +
          el('path', { d: diamond(46, 66, 25, 45), fill: '#17120f', stroke: 'url(#zc-g-mark)', 'stroke-width': 1.2 }) +
          el('path', { d: diamond(46, 66, 21.5, 38.7), fill: 'none', stroke: MARK_FROM, 'stroke-width': 0.5, opacity: 0.5 }) +
          env.markZ(46, 66, 28) +
          '<g fill="' + MARK_FROM + '">' + [[30, 31], [62, 31], [30, 101], [62, 101]].map(function (p) { return '<path d="' + diamond(p[0], p[1], 2.5, 2.5) + '"/>'; }).join('') + '</g>';
      },
      // Royal blue, ivory and red. Field 70 x 110: 7 x 11 cells of 10, a whole diamond in each (corners on the cell edges' midpoints).
      // The medallion is the 3 x 5 block at the centre (31..61 x 41..91) with a diamond inscribed in it and a red one inside that.
      classic: function () {
        var d = '', i, j;
        for (i = 0; i < 7; i++) for (j = 0; j < 11; j++) d += diamond(FX + 10 * i + 5, FY + 10 * j + 5, 5, 5);
        return band('#1d3b7a', '#e8eefc', 0.6) + el('path', { d: d, fill: 'none', stroke: '#c9d6f2', 'stroke-width': 0.7, opacity: 0.65, 'stroke-linejoin': 'round' }) +
          rect(31, 41, 30, 50, { fill: '#1d3b7a' }) +
          el('path', { d: diamond(46, 66, 15, 25), fill: '#e8eefc' }) + el('path', { d: diamond(46, 66, 8, 14), fill: '#b3322f' });
      },
      night: function () {
        return scene('#0b1a3d', '#c9d6f2', '<rect width="92" height="132" fill="url(#zc-g-night)"/>' +
          stars('zc-tw1', [[12, 16, 1], [70, 10, 0.9], [30, 34, 0.8], [82, 44, 1], [16, 62, 0.8], [58, 26, 0.7]]) +
          stars('zc-tw2', [[44, 14, 0.8], [78, 24, 0.8], [14, 40, 1], [26, 20, 0.7], [80, 70, 0.8]]) +
          stars('zc-tw3', [[62, 40, 0.7], [20, 26, 0.9], [74, 58, 0.7], [38, 22, 0.6]]) +
          '<circle cx="46" cy="58" r="26" fill="#fff" opacity=".07"/><circle cx="46" cy="58" r="17" fill="#2a3556"/>' +
          '<path d="' + env.moonLitPath(env.moonPhase(new Date()), 46, 58, 17) + '" fill="#f6f0d8"/>' +
          '<path d="M0 112Q22 98 46 110T92 106V132H0z" fill="#0b1022"/><path d="M12 112l3-12 3 12zM70 108l3-14 3 14z" fill="#0b1022"/>');
      },
      sea: function () {
        return scene('#10568f', '#fff4d6', '<rect width="92" height="132" fill="url(#zc-g-sea)"/><circle cx="68" cy="32" r="11" fill="#ffe9a8"/><circle cx="68" cy="32" r="17" fill="#ffe9a8" opacity=".25"/>' +
          '<g class="zc-boat"><path d="M30 72h26l-5 8H35z" fill="#7a3b1d"/><path d="M43 46v26M43 48l12 20H43z" fill="#fff" stroke="#fff" stroke-width="1"/><path d="M42 52 31 68h11z" fill="#f4d35e"/></g>' +
          '<g class="zc-wv zc-wv1">' + wavePath(80, '#2d9cdb') + '</g><g class="zc-wv zc-wv2">' + wavePath(94, '#1b78b8') + '</g><g class="zc-wv zc-wv3">' + wavePath(108, '#10568f') + '</g>');
      },
      // Graph paper: 7 x 11 cells of 10 in the field, the robot centred in it (its bulb to its feet is 16.5..118, lifted 1.25 so the margins match).
      robot: function () {
        var d = '', i;
        for (i = 0; i <= 11; i++) d += 'M' + FX + ' ' + (FY + 10 * i) + 'h' + FW;
        for (i = 0; i <= 7; i++) d += 'M' + (FX + 10 * i) + ' ' + FY + 'v' + FH;
        return band('#0c2b36', '#27e6ff', 0.5) + rect(FX, FY, FW, FH, { fill: '#123c4a' }) + el('path', { d: d, fill: 'none', stroke: '#27e6ff', 'stroke-width': 0.5, opacity: 0.28 }) +
          '<g transform="translate(0 -1.25)"><path d="M46 34V22" stroke="#9fb3bd" stroke-width="2"/><circle class="zc-bulb" cx="46" cy="20" r="3.5" fill="#ff5d5d"/>' +
          '<rect x="22" y="34" width="48" height="36" rx="9" fill="#cfd8dc"/><rect x="27" y="40" width="38" height="20" rx="6" fill="#102a33"/>' +
          '<circle class="zc-eye" cx="37" cy="50" r="5" fill="#27e6ff"/><circle class="zc-eye" cx="55" cy="50" r="5" fill="#27e6ff"/>' +
          '<path d="M38 64h16" stroke="#8aa0aa" stroke-width="2" stroke-linecap="round"/>' +
          '<rect x="28" y="74" width="36" height="30" rx="7" fill="#b0bec5"/><circle cx="46" cy="89" r="5" fill="#27e6ff" opacity=".8"/>' +
          '<rect x="14" y="76" width="9" height="24" rx="4.5" fill="#9fb3bd"/>' +
          '<g class="zc-arm"><rect x="69" y="76" width="9" height="24" rx="4.5" fill="#9fb3bd"/></g>' +
          '<rect x="33" y="106" width="9" height="12" rx="3" fill="#9fb3bd"/><rect x="50" y="106" width="9" height="12" rx="3" fill="#9fb3bd"/></g>';
      },
      castle: function () {
        var bat = function (cls) {
          return '<g class="zc-bat ' + cls + '"><g class="zc-wing"><path d="M0 0C-4-5-9-4-12 0-9-1-6 0-4 2z"/><path d="M0 0C4-5 9-4 12 0 9-1 6 0 4 2z"/></g><ellipse rx="2" ry="3"/></g>';
        };
        return scene('#2b1646', '#ffd166', '<rect width="92" height="132" fill="url(#zc-g-castle)"/><circle cx="70" cy="26" r="10" fill="#fbe7b0"/>' +
          '<g fill="#0a0612"><path d="M10 132V86h6V80h6v6h6V80h6v6h6V132z"/><path d="M34 132V70h24v62z"/><path d="M34 70V62h5v-5h4v5h6v-5h4v5h5v8z"/>' +
          '<path d="M60 132V90h6V84h6v6h6V84h6v6h4V132z"/><path d="M42 58l4-16 4 16z"/><path d="M14 80l4-14 4 14z"/><path d="M64 84l4-14 4 14z"/></g>' +
          '<g fill="#ffd166"><rect class="zc-lit" x="44" y="76" width="4" height="7" rx="2"/><rect class="zc-lit" x="16" y="94" width="3" height="6" rx="1.5" style="animation-delay:-1s"/><rect class="zc-lit" x="68" y="98" width="3" height="6" rx="1.5" style="animation-delay:-1.8s"/><rect class="zc-lit" x="44" y="94" width="4" height="7" rx="2" style="animation-delay:-.6s"/></g>' +
          '<g fill="#0a0612">' + bat('zc-bat1') + bat('zc-bat2') + '</g>');
      },
      // Victorian guilloche on oxblood and gold. Roses of rotated ellipses on the vertical axis: the large one at the centre, a small
      // one in each end of the field (centres 43 above and below the middle), all inside the 70 x 110 field frame.
      guilloche: function () {
        function rose(cx, cy, R, k, n, phase) {
          var g = '<g transform="translate(' + cx + ' ' + cy + ')">', i;
          for (i = 0; i < n; i++) g += '<ellipse rx="' + R + '" ry="' + f(R * k) + '" transform="rotate(' + f(phase + i * 180 / n) + ')"/>';
          return g + '</g>';
        }
        return band('#5b1423', '#d9b45f', 0.5) + rect(FX, FY, FW, FH, { fill: '#661a2b', stroke: '#d9b45f', 'stroke-width': 0.6 }) +
          '<g fill="none" stroke="#d9b45f" stroke-width=".35" opacity=".85">' + rose(46, 66, 28, 0.3, 30, 0) + rose(46, 66, 19, 0.3, 24, 3.75) +
          rose(46, 23, 10, 0.3, 18, 0) + rose(46, 109, 10, 0.3, 18, 0) + '</g>' +
          '<g fill="none" stroke="#d9b45f"><circle cx="46" cy="66" r="28.5" stroke-width=".8"/><circle cx="46" cy="66" r="9" stroke-width=".8"/><circle cx="46" cy="23" r="10.5" stroke-width=".7"/><circle cx="46" cy="109" r="10.5" stroke-width=".7"/></g>' +
          '<g fill="#d9b45f"><circle cx="46" cy="66" r="3"/><circle cx="46" cy="23" r="1.4"/><circle cx="46" cy="109" r="1.4"/></g>';
      },
      // Art Deco scales in bottle green and brass. Scales are 14 wide (5 across the 70 field), rows 3 apart, 17 rows from the top edge to
      // the middle seam (baselines 18 + 3i; the first row's crown touches the field's top, the last baseline is y = 66). The lower half
      // is the upper turned a half turn. Odd rows are shifted half a scale, so their half scales end on the field edge.
      deco: function () {
        var rows = '', i, k, y, x, d, half;
        for (i = 0; i < 17; i++) {
          y = 18 + 3 * i; d = ''; half = i % 2 ? 0 : 7;
          for (k = 0; k < 6; k++) {
            x = FX + half + 14 * k;
            if (x - 7 >= FX - 0.01 && x + 7 <= FX + FW + 0.01) d += 'M' + (x - 7) + ' ' + y + 'A7 7 0 0 1 ' + (x + 7) + ' ' + y + 'z';
            else if (x === FX) d += 'M' + x + ' ' + (y - 7) + 'A7 7 0 0 1 ' + (x + 7) + ' ' + y + 'H' + x + 'z';
            else if (x === FX + FW) d += 'M' + (x - 7) + ' ' + y + 'A7 7 0 0 1 ' + x + ' ' + (y - 7) + 'V' + y + 'z';
          }
          rows += '<path d="' + d + '" fill="' + (i % 2 ? '#d9b660' : '#c9a24a') + '"/>';
        }
        var top = '<g stroke="#0e2a22" stroke-width=".6" stroke-linejoin="round">' + rows + '</g>';
        return band('#0e2a22', '#c9a24a', 0.5) + rect(FX, FY, FW, FH, { fill: '#0e2a22' }) +
          clip(FX, FY, FW, FH, rect(FX, FY, FW, FH, { fill: '#c9a24a' }) + top + turned(top)) + rect(FX, FY, FW, FH, { fill: 'none', stroke: '#c9a24a', 'stroke-width': 0.6 }) +
          '<path d="' + diamond(46, 66, 9, 9) + '" fill="#0e2a22" stroke="#c9a24a" stroke-width="1"/><circle cx="46" cy="66" r="3" fill="#c9a24a"/>';
      },
      // Seigaiha in vermilion and ivory. Field 80 x 120 at (6,6), scales 20 wide (4 across), rows 5 apart: the top 11 rows run to the
      // seam band (y 63..69), the lower half is the upper turned a half turn; the rising sun sits on the seam.
      seigaiha: function () {
        var g = '', i, k, y, x0, d, r;
        for (i = 0; i < 12; i++) {
          y = 16 + 5 * i; x0 = i % 2 ? 16 : 6; d = '';
          for (k = 0; k < 5; k++) { if (x0 + 20 * k > 86) continue; for (r = 10; r > 2; r -= 10 / 3) d += circlePath(x0 + 20 * k, y, r); }
          g += '<path d="' + d + '" fill="#a82f2a" stroke="#f3e6c8" stroke-width=".6"/>';
        }
        var top = clip(6, 6, 80, 57, g);
        return rect(0, 0, W, H, { fill: '#a82f2a' }) + rect(2.5, 2.5, 87, 127, { fill: 'none', stroke: '#f3e6c8', 'stroke-width': 1.2 }) +
          rect(6, 6, 80, 120, { fill: '#a82f2a' }) + top + turned(top) +
          rect(6, 63, 80, 6, { fill: '#a82f2a', stroke: '#f3e6c8', 'stroke-width': 0.8 }) + rect(6, 6, 80, 120, { fill: 'none', stroke: '#f3e6c8', 'stroke-width': 0.8 }) +
          '<circle cx="46" cy="66" r="9" fill="#a82f2a" stroke="#f3e6c8" stroke-width=".8"/><circle cx="46" cy="66" r="5.5" fill="#f3e6c8"/>';
      },
      // Zellige in turquoise, ivory and ochre. 7 x 11 cells of 10, an eight pointed star (two squares) in each, ochre and navy in
      // a chessboard that is the same turned or mirrored (7 and 11 are odd). The 3 x 3 block at the centre (31..61 x 51..81) is one
      // big star; small ivory diamonds close the gaps at the inner cell corners.
      zellige: function () {
        var a = 5 / Math.SQRT2, even = '', odd = '', gaps = '', i, j, cx, cy, s;
        function star(cx, cy, r) { var q = r / Math.SQRT2; return 'M' + f(cx - q) + ' ' + f(cy - q) + 'h' + f(2 * q) + 'v' + f(2 * q) + 'h' + f(-2 * q) + 'zM' + cx + ' ' + f(cy - r) + 'l' + r + ' ' + r + ' ' + -r + ' ' + r + ' ' + -r + ' ' + -r + 'z'; }
        for (i = 0; i < 7; i++) for (j = 0; j < 11; j++) {
          cx = FX + 10 * i + 5; cy = FY + 10 * j + 5; s = star(cx, cy, 5);
          if ((i + j) % 2) odd += s; else even += s;
          if (i && j) gaps += diamond(FX + 10 * i, FY + 10 * j, 1.6, 1.6);
        }
        return band('#0b6e78', '#f4ecd4', 0.5) + rect(FX, FY, FW, FH, { fill: '#0b6e78' }) +
          '<g stroke="#f4ecd4" stroke-width=".5" stroke-linejoin="miter"><path d="' + even + '" fill="#d9962b" fill-rule="nonzero"/><path d="' + odd + '" fill="#0a4a56"/></g>' +
          el('path', { d: gaps, fill: '#f4ecd4' }) +
          rect(31, 51, 30, 30, { fill: '#0b6e78' }) +
          '<g stroke="#f4ecd4" stroke-width=".7"><path d="' + star(46, 66, 15) + '" fill="#d9962b"/><path d="' + star(46, 66, 8.5) + '" fill="#0a4a56"/></g><circle cx="46" cy="66" r="2.4" fill="#f4ecd4"/>' +
          rect(FX, FY, FW, FH, { fill: 'none', stroke: '#f4ecd4', 'stroke-width': 0.6 });
      },
      // The north sky, as it is: the celestial pole at the centre of the card, declination rings every 10 degrees (one unit a degree)
      // and right ascension spokes every 2 hours, then the real stars of Ursa Major, Ursa Minor and Cassiopeia from their right
      // ascension and declination, turned so the Dipper (RA 12h) is at the top; Cassiopeia (RA 1h) lands at the bottom, as in the sky.
      chart: function () {
        var d = '', i, a, s = '', lines = '', S = {
          dubhe: [11.062, 61.75, 1.8], merak: [11.031, 56.38, 2.4], phecda: [11.897, 53.69, 2.4], megrez: [12.257, 57.03, 3.3], alioth: [12.9, 55.96, 1.8], mizar: [13.399, 54.93, 2.2], alkaid: [13.792, 49.31, 1.9],
          polaris: [2.53, 89.26, 2.0], yildun: [17.537, 86.59, 4.4], eps: [16.766, 82.04, 4.2], zeta: [15.734, 77.79, 4.3], eta: [16.292, 75.76, 5.0], pherkad: [15.345, 71.83, 3.0], kochab: [14.845, 74.16, 2.1],
          caph: [0.153, 59.15, 2.3], schedar: [0.675, 56.54, 2.2], gamma: [0.945, 60.72, 2.4], ruchbah: [1.43, 60.24, 2.7], segin: [1.907, 63.67, 3.4]
        };
        function at(st) { var th = (st[0] * 15 - 183) * Math.PI / 180, r = 90 - st[1]; return [CX - r * Math.sin(th), CY - r * Math.cos(th)]; }
        function chain(names) { return 'M' + names.map(function (n) { var p = at(S[n]); return f(p[0]) + ' ' + f(p[1]); }).join('L'); }
        for (i = 1; i <= 6; i++) d += circlePath(CX, CY, 10 * i);
        for (i = 0; i < 6; i++) { a = i * Math.PI / 6; d += 'M' + f(CX - 70 * Math.cos(a)) + ' ' + f(CY - 70 * Math.sin(a)) + 'L' + f(CX + 70 * Math.cos(a)) + ' ' + f(CY + 70 * Math.sin(a)); }
        lines = chain(['dubhe', 'merak', 'phecda', 'megrez', 'dubhe']) + chain(['megrez', 'alioth', 'mizar', 'alkaid']) +
          chain(['polaris', 'yildun', 'eps', 'zeta', 'eta', 'pherkad', 'kochab', 'zeta']) + chain(['caph', 'schedar', 'gamma', 'ruchbah', 'segin']);
        Object.keys(S).forEach(function (n) {
          var p = at(S[n]), r = 0.45 + (5 - S[n][2]) * 0.3;
          s += '<circle cx="' + f(p[0]) + '" cy="' + f(p[1]) + '" r="' + f(r) + '"' + (S[n][2] < 2.3 ? ' class="zc-tw ' + (S[n][2] < 2 ? 'zc-tw2' : 'zc-tw3') + '"' : '') + '/>';
        });
        return band('#060c1f', '#7f9bdc', 0.5) + rect(FX, FY, FW, FH, { fill: '#0a1430' }) +
          clip(FX, FY, FW, FH, '<path d="' + d + '" fill="none" stroke="#7fa8ff" stroke-width=".35" opacity=".4"/><path d="' + lines + '" fill="none" stroke="#9fb8ff" stroke-width=".5" opacity=".75"/><g fill="#f6f1dc">' + s + '</g>') +
          rect(FX, FY, FW, FH, { fill: 'none', stroke: '#9fb8ff', 'stroke-width': 0.6, opacity: 0.8 });
      },
      // A survey sheet in paper and sepia. Contours of one hill, r = k * (1 + .08 cos 2t + (.03 + k/420) cos 4t + k/520 cos 6t) squeezed to 0.66 wide,
      // one every 5 units, every 4th an index line; only even harmonics, so the hill is mirrored on both axes and the same turned.
      // The neat line is 7 segments of 10 across and 11 down, dark and light alternating, dark at both ends.
      topo: function () {
        var d = '', idx = '', r0, t, p, n = 24, i, ring = '', v;
        for (r0 = 5; r0 <= 65; r0 += 5) {
          p = [];
          for (i = 0; i < n; i++) { t = 2 * Math.PI * i / n; v = r0 * (1 + 0.08 * Math.cos(2 * t) + (0.03 + r0 / 420) * Math.cos(4 * t) + (r0 / 520) * Math.cos(6 * t)); p.push([CX + 0.66 * v * Math.cos(t), CY + v * Math.sin(t)]); }
          if (r0 % 20) d += smooth(p); else idx += smooth(p);
        }
        for (i = 0; i < 7; i += 2) ring += 'M' + (FX + 10 * i) + ' 7.5h10v3.5h-10zM' + (FX + 10 * i) + ' 121h10v3.5h-10z';
        for (i = 0; i < 11; i += 2) ring += 'M7.5 ' + (FY + 10 * i) + 'h3.5v10h-3.5zM81 ' + (FY + 10 * i) + 'h3.5v10h-3.5z';
        return rect(0, 0, W, H, { fill: '#e6d6ae' }) + rect(3.5, 3.5, 85, 125, { fill: 'none', stroke: '#5a3a1c', 'stroke-width': 1.2 }) +
          rect(7.5, 7.5, 77, 117, { fill: 'none', stroke: '#5a3a1c', 'stroke-width': 0.5 }) + el('path', { d: ring, fill: '#5a3a1c' }) +
          rect(FX, FY, FW, FH, { fill: '#efe2bf' }) +
          clip(FX, FY, FW, FH, '<path d="' + d + '" fill="none" stroke="#9b6a3a" stroke-width=".5"/><path d="' + idx + '" fill="none" stroke="#7d4f23" stroke-width=".9"/>') +
          rect(FX, FY, FW, FH, { fill: 'none', stroke: '#5a3a1c', 'stroke-width': 0.6 }) +
          '<path d="M46 62.5l3.4 6h-6.8z" fill="#5a3a1c"/><circle cx="46" cy="66.2" r=".7" fill="#efe2bf"/>';
      }
    };
    var IDS = ['zimi', 'classic', 'night', 'sea', 'robot', 'castle', 'guilloche', 'deco', 'seigaiha', 'zellige', 'chart', 'topo'];
    var BACKS = IDS.map(function (id) { return { id: id, get name() { return T('cards.back.' + id); } }; });
    function backMarkup(id) {
      var art = (ART[id] || ART.zimi)();
      return '<svg viewBox="0 0 ' + env.FACE_W + ' ' + env.FACE_H + '" preserveAspectRatio="xMidYMid slice" class="zc-bk" aria-hidden="true"><rect width="100" height="140" fill="' + env.CARD_CREAM + '"/>' +
        '<svg x="4" y="4" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" overflow="hidden">' + art + '</svg></svg>';
    }
    // Gradients live once in the page's sprite (a reference into a display:none clone would break).
    var defs = '<radialGradient id="zc-g-glow"><stop offset="0" stop-color="' + MARK_FROM + '" stop-opacity=".34"/><stop offset="1" stop-color="' + MARK_FROM + '" stop-opacity="0"/></radialGradient>' +
      '<linearGradient id="zc-g-night" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1a3d"/><stop offset="1" stop-color="#3a4f8a"/></linearGradient>' +
      '<linearGradient id="zc-g-sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fd6f5"/><stop offset="1" stop-color="#2b8fc9"/></linearGradient>' +
      '<linearGradient id="zc-g-castle" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b1646"/><stop offset=".7" stop-color="#8a3f6b"/><stop offset="1" stop-color="#e58a4b"/></linearGradient>';
    return { BACKS: BACKS, backMarkup: backMarkup, defs: defs };
  }
  root.ZimiCardBacks = make;
  if (typeof module !== 'undefined' && module.exports) module.exports = make;
})(typeof window !== 'undefined' ? window : globalThis);
