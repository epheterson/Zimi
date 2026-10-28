/* ZimiGames: Road Rush's pictures. Our own sprites, drawn with canvas paths: palms, pines, rocks, bushes, houses,
   towers, lamps, cones, signs, the checkpoint gate, and three kinds of car seen from behind. Nothing is an image.
   Each sprite is drawn in a box one unit wide with its base at the origin, y up being negative; the page scales it. */
(function (root) {
  'use strict';
  var Art = {};

  // ── colours: a palette for each light, and a mix toward the fog for distance ──
  Art.PALETTES = {
    day:   { skyTop: '#3f9be6', skyBot: '#c4e8ff', sun: '#fff4b8', sunAt: [0.74, 0.3], far: '#7fb4d6', near: '#5aa35f', grassL: '#52b052', grassD: '#47a048', roadL: '#6d717b', roadD: '#666a74', rumbleA: '#d9473d', rumbleB: '#f4f1ea', lane: '#f4f1ea', fog: '#cdeaff', stars: false },
    dusk:  { skyTop: '#3b2a6b', skyBot: '#ff9a5c', sun: '#ffd27a', sunAt: [0.3, 0.9], far: '#7b4a77', near: '#4e3150', grassL: '#7d7d3e', grassD: '#707037', roadL: '#5e5a64', roadD: '#58545e', rumbleA: '#d9473d', rumbleB: '#f1d9b8', lane: '#f2d9a0', fog: '#e9a68d', stars: false },
    night: { skyTop: '#040817', skyBot: '#1c2c58', sun: '#e8eef9', sunAt: [0.78, 0.3], far: '#132244', near: '#0c1630', grassL: '#1e3d2d', grassD: '#193427', roadL: '#303440', roadD: '#2b2e39', rumbleA: '#b03030', rumbleB: '#cfd3dc', lane: '#d9dce6', fog: '#0f1a36', stars: true }
  };
  function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
  function mix(a, b, t) {
    var x = hex(a), y = hex(b);
    return 'rgb(' + Math.round(x[0] + (y[0] - x[0]) * t) + ',' + Math.round(x[1] + (y[1] - x[1]) * t) + ',' + Math.round(x[2] + (y[2] - x[2]) * t) + ')';
  }
  // The fog at distance step n of `count`: 0 near, close to 1 at the horizon.
  Art.fog = function (n, count, density) { var f = n / count; return 1 - 1 / Math.exp(f * f * density); };
  // Every road colour at every distance step, once, so a frame only looks them up.
  Art.table = function (pal, count, density) {
    var out = [], n, f, keys = ['grassL', 'grassD', 'roadL', 'roadD', 'rumbleA', 'rumbleB', 'lane'];
    for (n = 0; n < count; n++) {
      f = Art.fog(n, count, density);
      var row = { fog: f }; keys.forEach(function (k) { row[k] = mix(pal[k], pal.fog, f); });
      out.push(row);
    }
    return out;
  };

  // ── the sprites ──────────────────────────────────────────────────────────
  var CAR_COLORS = ['#d1473f', '#3a63c9', '#e9eef7', '#3d9a4a', '#e0a21a', '#8a55c9'];
  var HOUSE_WALLS = ['#e9d8b4', '#d9b38c', '#c9d6e0', '#e8b4a0'], HOUSE_ROOFS = ['#b04a3a', '#7a4a32', '#4a6a86', '#8a3a3a'];
  var SIGN_COLORS = ['#d9473d', '#3a63c9', '#2f9a5b', '#e0a21a'];

  function ell(c, x, y, rx, ry, rot) { c.beginPath(); c.ellipse(x, y, rx, ry, rot || 0, 0, 7); c.fill(); }
  function rect(c, x, y, w, h, color) { c.fillStyle = color; c.fillRect(x, y, w, h); }
  function poly(c, pts, color) { c.fillStyle = color; c.beginPath(); c.moveTo(pts[0], pts[1]); for (var i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]); c.closePath(); c.fill(); }

  // The gate's word in the page's language (the table), upper-cased where the script has case; a bare engine shows English.
  function gateWord(label) {
    var id = label === 'FINISH' ? 'roadrush.gate.finish' : 'roadrush.gate.checkpoint';
    return root.ZimiText ? root.ZimiText.T(id).toUpperCase() : label;
  }

  var DRAW = {
    palm: function (c, s, night) {
      c.fillStyle = '#7a5a3a'; c.beginPath(); c.moveTo(-0.05, 0); c.quadraticCurveTo(0.14, -0.9, 0.03, -1.7); c.lineTo(-0.03, -1.7); c.quadraticCurveTo(0.06, -0.9, 0.0, 0); c.closePath(); c.fill();
      c.fillStyle = night ? '#1f5a35' : '#2e8f45';
      for (var i = 0; i < 7; i++) { c.save(); c.translate(0.03, -1.7); c.rotate(-Math.PI * 0.95 + i * Math.PI * 0.95 / 3 + (i % 2) * 0.1); ell(c, 0.22, 0, 0.24, 0.05); c.restore(); }
      c.fillStyle = '#5a3a1a'; ell(c, 0.0, -1.66, 0.035, 0.035); ell(c, 0.07, -1.64, 0.035, 0.035);
    },
    pine: function (c, s, night) {
      rect(c, -0.04, -0.3, 0.08, 0.3, '#5a3d27');
      var g = night ? ['#173a2a', '#1b4531', '#205238'] : ['#25683f', '#2d7a49', '#378c55'];
      poly(c, [-0.34, -0.28, 0.34, -0.28, 0, -1.0], g[0]); poly(c, [-0.28, -0.7, 0.28, -0.7, 0, -1.4], g[1]); poly(c, [-0.2, -1.1, 0.2, -1.1, 0, -1.8], g[2]);
    },
    rock: function (c, s, night) {
      poly(c, [-0.5, 0, -0.42, -0.4, -0.1, -0.7, 0.26, -0.6, 0.5, -0.2, 0.46, 0], night ? '#4a5266' : '#8a8f9a');
      poly(c, [-0.1, -0.7, 0.26, -0.6, 0.5, -0.2, 0.05, -0.3], night ? '#5d667c' : '#a7acb7');
    },
    bush: function (c, s, night) {
      c.fillStyle = night ? '#1a4a2b' : '#2f8a45'; ell(c, -0.2, -0.25, 0.3, 0.25); ell(c, 0.18, -0.28, 0.32, 0.28); ell(c, 0, -0.42, 0.28, 0.26);
      c.fillStyle = 'rgba(255,255,255,0.12)'; ell(c, -0.05, -0.5, 0.14, 0.1);
    },
    house: function (c, s, night) {
      var wall = HOUSE_WALLS[s.hue % 4], roof = HOUSE_ROOFS[s.hue % 4];
      rect(c, -0.5, -0.5, 1, 0.5, night ? '#4a4f62' : wall);
      poly(c, [-0.58, -0.5, 0.58, -0.5, 0.3, -0.85, -0.3, -0.85], night ? '#2a2f40' : roof);
      rect(c, -0.12, -0.32, 0.24, 0.32, night ? '#2a2f40' : '#6a4a32'); rect(c, -0.4, -0.38, 0.18, 0.16, night ? '#f2c96a' : '#bfe3f5'); rect(c, 0.22, -0.38, 0.18, 0.16, night ? '#f2c96a' : '#bfe3f5');
    },
    tower: function (c, s, night) {
      var h = 2.4 + (s.hue % 3) * 0.5;
      rect(c, -0.45, -h, 0.9, h, night ? '#1a2240' : '#8f99ad');
      for (var y = 0; y < Math.floor(h / 0.25) - 1; y++) for (var x = 0; x < 4; x++) {
        var lit = ((x * 7 + y * 3 + s.hue) % 5) !== 0;
        rect(c, -0.36 + x * 0.2, -h + 0.12 + y * 0.25, 0.12, 0.14, night ? (lit ? '#f2d27a' : '#26304f') : '#c9e2f2');
      }
      rect(c, -0.02, -h - 0.25, 0.04, 0.25, '#555'); c.fillStyle = '#ff3b30'; ell(c, 0, -h - 0.27, 0.05, 0.05);
    },
    lamp: function (c, s, night) {
      rect(c, -0.06, -4.6, 0.12, 4.6, '#6b7280'); rect(c, -0.06, -4.6, 0.7 * (s.offset > 0 ? -1 : 1), 0.12, '#6b7280');
      var hx = 0.65 * (s.offset > 0 ? -1 : 1);
      c.fillStyle = night ? '#fff3c4' : '#d9dde4'; ell(c, hx, -4.5, 0.14, 0.07);
      if (night) { var gr = c.createRadialGradient(hx, -4.45, 0, hx, -4.45, 1.6); gr.addColorStop(0, 'rgba(255,240,180,0.55)'); gr.addColorStop(1, 'rgba(255,240,180,0)'); c.fillStyle = gr; c.fillRect(hx - 1.6, -6.1, 3.2, 3.2); }
    },
    cone: function (c) {
      rect(c, -0.5, -0.1, 1, 0.1, '#2b2b2b');
      poly(c, [-0.36, -0.1, 0.36, -0.1, 0.12, -1.1, -0.12, -1.1], '#ff7a1a'); poly(c, [-0.26, -0.45, 0.26, -0.45, 0.19, -0.7, -0.19, -0.7], '#fff');
    },
    sign: function (c, s) {
      rect(c, -0.42, -1.4, 0.06, 1.4, '#5b616e'); rect(c, 0.36, -1.4, 0.06, 1.4, '#5b616e');
      rect(c, -0.5, -1.3, 1, 0.62, '#1d2433'); rect(c, -0.46, -1.26, 0.92, 0.54, SIGN_COLORS[s.hue % 4]);
      c.fillStyle = '#fff'; for (var i = 0; i < 3; i++) poly(c, [-0.3 + i * 0.26, -0.8, -0.18 + i * 0.26, -0.99, -0.06 + i * 0.26, -0.8, -0.14 + i * 0.26, -0.8, -0.18 + i * 0.26, -0.88, -0.22 + i * 0.26, -0.8], '#fff');
    },
    gate: function (c, s) {
      rect(c, -1.04, -1.4, 0.08, 1.4, '#e9e9ee'); rect(c, 0.96, -1.4, 0.08, 1.4, '#e9e9ee');
      rect(c, -1.08, -1.5, 2.16, 0.46, '#1d2433');
      c.fillStyle = s.label === 'FINISH' ? '#f3f3ee' : '#f2a516'; c.font = '700 0.28px system-ui, sans-serif'; c.textAlign = 'center'; c.fillText(gateWord(s.label), 0, -1.17);
      for (var i = 0; i < 9; i++) { c.fillStyle = i % 2 ? '#f3f3ee' : '#1b1d22'; c.fillRect(-1.08 + i * 0.24, -1.54, 0.24, 0.06); }
    }
  };
  Art.ASPECT = { palm: 1.9, pine: 1.9, rock: 0.75, bush: 0.7, house: 0.9, tower: 3.4, lamp: 5.0, cone: 1.1, sign: 1.45, gate: 1.6 };

  // Traffic from behind: width 1, a car, a van or a truck.
  var TRAFFIC = {
    car: function (c, color, braking) {
      c.fillStyle = 'rgba(0,0,0,0.28)'; ell(c, 0, -0.02, 0.52, 0.07);
      rect(c, -0.46, -0.2, 0.14, 0.2, '#16181d'); rect(c, 0.32, -0.2, 0.14, 0.2, '#16181d');
      poly(c, [-0.5, -0.12, 0.5, -0.12, 0.46, -0.52, -0.46, -0.52], color); poly(c, [-0.36, -0.52, 0.36, -0.52, 0.26, -0.82, -0.26, -0.82], color);
      poly(c, [-0.3, -0.54, 0.3, -0.54, 0.22, -0.78, -0.22, -0.78], '#1c2430');
      rect(c, -0.46, -0.44, 0.2, 0.1, braking ? '#ff3b30' : '#b3302a'); rect(c, 0.26, -0.44, 0.2, 0.1, braking ? '#ff3b30' : '#b3302a'); rect(c, -0.3, -0.2, 0.6, 0.06, 'rgba(0,0,0,0.3)');
    },
    van: function (c, color, braking) {
      c.fillStyle = 'rgba(0,0,0,0.28)'; ell(c, 0, -0.02, 0.52, 0.07);
      rect(c, -0.46, -0.2, 0.14, 0.2, '#16181d'); rect(c, 0.32, -0.2, 0.14, 0.2, '#16181d');
      poly(c, [-0.5, -0.1, 0.5, -0.1, 0.5, -1.0, -0.5, -1.0], color); rect(c, -0.4, -0.92, 0.8, 0.22, '#1c2430');
      rect(c, -0.48, -0.5, 0.16, 0.14, braking ? '#ff3b30' : '#b3302a'); rect(c, 0.32, -0.5, 0.16, 0.14, braking ? '#ff3b30' : '#b3302a'); rect(c, -0.02, -0.7, 0.04, 0.55, 'rgba(0,0,0,0.25)');
    },
    truck: function (c, color, braking) {
      c.fillStyle = 'rgba(0,0,0,0.28)'; ell(c, 0, -0.02, 0.52, 0.07);
      rect(c, -0.46, -0.24, 0.14, 0.24, '#16181d'); rect(c, 0.32, -0.24, 0.14, 0.24, '#16181d');
      rect(c, -0.5, -1.15, 1, 1.0, '#cfd4dc'); rect(c, -0.5, -1.15, 1, 0.08, '#b0b6c1'); rect(c, -0.44, -1.05, 0.88, 0.78, color);
      rect(c, -0.12, -1.05, 0.24, 0.78, 'rgba(255,255,255,0.18)');
      rect(c, -0.48, -0.36, 0.14, 0.1, braking ? '#ff3b30' : '#b3302a'); rect(c, 0.34, -0.36, 0.14, 0.1, braking ? '#ff3b30' : '#b3302a');
    }
  };
  Art.TRAFFIC_ASPECT = { car: 0.85, van: 1.0, truck: 1.15 };

  // Scenery by its kind. `night` swaps in the dark colours. Used for sprites standing on the road side.
  Art.scenery = function (c, s, night) { DRAW[s.type](c, s, night); };
  Art.traffic = function (c, car, braking) { TRAFFIC[car.type](c, CAR_COLORS[car.hue % CAR_COLORS.length], braking); };

  // The player's car from behind: bigger, with a stripe, leaning a little into a turn. steer -1..1.
  Art.player = function (c, steer, braking, night) {
    c.save(); c.transform(1, 0, -steer * 0.08, 1, 0, 0);
    c.fillStyle = 'rgba(0,0,0,0.3)'; ell(c, 0, -0.02, 0.55, 0.08);
    rect(c, -0.48, -0.22, 0.16, 0.22, '#111'); rect(c, 0.32, -0.22, 0.16, 0.22, '#111');
    poly(c, [-0.52, -0.1, 0.52, -0.1, 0.48, -0.5, -0.48, -0.5], '#f2a516'); poly(c, [-0.38, -0.5, 0.38, -0.5, 0.27, -0.8, -0.27, -0.8], '#f2a516');
    poly(c, [-0.31, -0.52, 0.31, -0.52, 0.22, -0.76, -0.22, -0.76], '#1c2430');
    rect(c, -0.06, -0.8, 0.12, 0.3, '#fff'); rect(c, -0.06, -0.5, 0.12, 0.4, '#fff');
    var lamp = braking ? '#ff3b30' : '#c43a2b';
    rect(c, -0.48, -0.44, 0.22, 0.11, lamp); rect(c, 0.26, -0.44, 0.22, 0.11, lamp); rect(c, -0.3, -0.2, 0.6, 0.06, 'rgba(0,0,0,0.3)');
    if (braking) { var g = c.createRadialGradient(0, -0.4, 0, 0, -0.4, 0.8); g.addColorStop(0, 'rgba(255,60,40,0.35)'); g.addColorStop(1, 'rgba(255,60,40,0)'); c.fillStyle = g; c.fillRect(-0.8, -1.1, 1.6, 1.4); }
    c.restore();
  };

  // The distant hills: a silhouette from a few sine waves, across `w` pixels from a given offset.
  Art.hills = function (c, w, y, amp, seed, offset, color) {
    c.fillStyle = color; c.beginPath(); c.moveTo(0, y + 2);
    for (var x = 0; x <= w; x += 6) {
      var u = (x + offset) / w * Math.PI * 2;
      c.lineTo(x, y - amp * (0.55 + 0.3 * Math.sin(u * 2 + seed) + 0.15 * Math.sin(u * 5 + seed * 2.3)));
    }
    c.lineTo(w, y + 2); c.closePath(); c.fill();
  };

  root.RoadRushArt = Art;
})(this);
