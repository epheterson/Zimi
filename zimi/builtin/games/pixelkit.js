/* ZimiGames: pixel art helpers for the classic-style games (Hopper, Muncher, Crossing, Blast, Quest, Pet).
   Our own code, GPL-3.0. No network, no modules. Sprites are drawn here as rows of characters and a palette,
   never loaded from files. The canvas keeps its logical pixels (a few hundred wide) and the browser scales it
   by a whole number, so every art pixel stays square and crisp. */
(function (root) {
  'use strict';
  var Kit = {};

  // A sprite: rows of equal-length strings; '.' is clear, any other character looks up the palette.
  // Returns a small canvas (cached by the caller) so drawing it is a single drawImage.
  Kit.sprite = function (rows, pal, flip) {
    var w = rows[0].length, h = rows.length, cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var c = cv.getContext('2d');
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var ch = rows[y].charAt(x);
      if (ch === '.' || ch === ' ' || !pal[ch]) continue;
      c.fillStyle = pal[ch];
      c.fillRect(flip ? w - 1 - x : x, y, 1, 1);
    }
    return cv;
  };
  // A sprite pair (facing right, facing left), built once.
  Kit.sprites = function (rows, pal) { return { r: Kit.sprite(rows, pal, false), l: Kit.sprite(rows, pal, true) }; };

  // The whole-number scale that fits a w x h canvas in the room left on the page, at most maxScale.
  Kit.scaleFor = function (w, h, availW, availH, maxScale) {
    var s = Math.floor(Math.min(availW / w, availH / h, maxScale || 8));
    return Math.max(1, s);
  };
  // Size the canvas: its pixels are the logical pixels, its CSS size a whole multiple of them.
  // chrome: the page height the canvas does not get, the pad aside (Play.room takes the pad's row or its sides off).
  Kit.fit = function (cv, w, h, chrome, maxScale) {
    var room = root.ArcadePlay.room(chrome), availW = room.w, availH = room.h;
    var s = Kit.scaleFor(w, h, availW, availH, maxScale);
    cv.width = w; cv.height = h;
    cv.style.width = (w * s) + 'px'; cv.style.height = (h * s) + 'px';
    var ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    if (!cv.pxWatched) { cv.pxWatched = true; cv.addEventListener('contextrestored', function () { window.dispatchEvent(new Event('resize')); }); }
    return { scale: s, ctx: ctx };
  };

  // Keys held, by action. map: { key: action }. Returns the held table; onPress(action) fires on a fresh press
  // (not on auto-repeat). Typing in a field, or Ctrl/Cmd shortcuts, never count. blockedFn() true = ignore keys.
  Kit.keyboard = function (map, onPress, blockedFn) {
    var held = {};
    function actionOf(e) { return map[e.key] || (e.key.length === 1 ? map[e.key.toLowerCase()] : undefined); }
    function clear() { Object.keys(held).forEach(function (k) { held[k] = false; }); }
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var t = e.target && e.target.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA') return;
      if (blockedFn && blockedFn()) return;
      var a = actionOf(e);
      if (!a) return;
      // A button that has focus keeps Space and Enter for itself.
      if ((e.key === ' ' || e.key === 'Enter') && t === 'BUTTON') return;
      e.preventDefault();
      if (!held[a] && !e.repeat && onPress) onPress(a);
      held[a] = true;
    });
    document.addEventListener('keyup', function (e) { var a = actionOf(e); if (a) held[a] = false; });
    window.addEventListener('blur', clear);
    return { held: held, clear: clear };
  };

  // Touch keys: each [element id, action] holds its action down while pressed (and fires onPress on the way down).
  Kit.touchKeys = function (pairs, held, onPress) {
    pairs.forEach(function (p) {
      var el = document.getElementById(p[0]);
      if (!el) return;
      root.ArcadePlay.hold(el, function (down) { held[p[1]] = down; if (down && onPress) onPress(p[1]); });
    });
  };

  // Text on the canvas in a tiny 3x5 pixel font (digits, capitals, a few marks), so labels are pixel art too.
  var FONT = {
    '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111', '4': '101101111001001',
    '5': '111100111001111', '6': '111100111101111', '7': '111001001010010', '8': '111101111101111', '9': '111101111001111',
    'A': '010101111101101', 'B': '110101110101110', 'C': '011100100100011', 'D': '110101101101110', 'E': '111100110100111',
    'F': '111100110100100', 'G': '011100101101011', 'H': '101101111101101', 'I': '111010010010111', 'J': '001001001101010',
    'K': '101101110101101', 'L': '100100100100111', 'M': '101111111101101', 'N': '110101101101101', 'O': '010101101101010',
    'P': '110101110100100', 'Q': '010101101110011', 'R': '110101110101101', 'S': '011100010001110', 'T': '111010010010010',
    'U': '101101101101111', 'V': '101101101101010', 'W': '101101111111101', 'X': '101101010101101', 'Y': '101101010010010',
    'Z': '111001010100111', '-': '000000111000000', '!': '010010010000010', ':': '000010000010000', '.': '000000000000010',
    '+': '000010111010000', ' ': '000000000000000'
  };
  // The pixel font has capitals and a few marks only. A label with anything else (an accent, a CJK or Arabic word) is
  // set in the page's own face at the same height instead, so a translated label is never blank or half drawn.
  function inFont(str) { return String(str).toUpperCase().split('').every(function (ch) { return FONT[ch]; }); }
  var measure = null;
  function plainFont(s) { return '800 ' + Math.round(6.5 * s) + 'px system-ui, -apple-system, sans-serif'; }
  function plainWidth(str, s) {
    if (!measure) measure = document.createElement('canvas').getContext('2d');
    measure.font = plainFont(s); return measure.measureText(String(str)).width;
  }
  Kit.text = function (ctx, str, x, y, color, scale) {
    var s = scale || 1, cx = x;
    if (!inFont(str)) {
      ctx.save(); ctx.font = plainFont(s); ctx.textBaseline = 'top'; ctx.textAlign = 'left'; ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(1, s);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.strokeText(String(str), x, y - s * 0.5); ctx.fillStyle = color; ctx.fillText(String(str), x, y - s * 0.5);
      ctx.restore(); return x + plainWidth(str, s);
    }
    ctx.fillStyle = color;
    String(str).toUpperCase().split('').forEach(function (ch) {
      var g = FONT[ch];
      for (var i = 0; i < 15; i++) if (g.charAt(i) === '1') ctx.fillRect(cx + (i % 3) * s, y + Math.floor(i / 3) * s, s, s);
      cx += 4 * s;
    });
    return cx;
  };
  Kit.textWidth = function (str, scale) { var s = scale || 1; return inFont(str) ? String(str).length * 4 * s - s : plainWidth(str, s); };
  Kit.textCentered = function (ctx, str, cx, y, color, scale) { Kit.text(ctx, str, Math.round(cx - Kit.textWidth(str, scale) / 2), y, color, scale); };

  Kit.clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };

  root.PixelKit = Kit;
})(typeof globalThis !== 'undefined' ? globalThis : window);
