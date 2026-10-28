/* ZimiGames: the Mahjong tile faces, drawn here (no fonts beyond the system's Latin), shared by Mahjong solitaire
   and the four-player game. A face is a number 0 to 41: 0-8 circles, 9-17 bamboo, 18-26 characters, 27-30 winds,
   31-33 dragons, 34-37 flowers, 38-41 seasons. Our own art, GPL-3.0. No network, no modules. */
(function (root) {
  'use strict';
  var FIRST_FLOWER = 34, FIRST_SEASON = 38;
  var NAMES = ['circles', 'bamboo', 'characters'];
  var WIND = ['East', 'South', 'West', 'North'], DRAGON = ['Red dragon', 'Green dragon', 'White dragon'];
  var FLOWER = ['Plum', 'Orchid', 'Chrysanthemum', 'Bamboo flower'], SEASON = ['Spring', 'Summer', 'Autumn', 'Winter'];

  // A tile's name: from the string table when the page has one (mahjong.face.*), in English otherwise (node tests).
  function tr(id, vars, english) { return root.ZimiText && root.ZimiText.has(id) ? root.ZimiText.T(id, vars) : english; }
  function faceName(f) {
    if (f < 27) { var i = (f / 9) | 0; return tr('mahjong.face.number', { n: f % 9 + 1, suit: tr('mahjong.suit.' + i, null, NAMES[i]) }, (f % 9 + 1) + ' of ' + NAMES[i]); }
    if (f < 31) return tr('mahjong.face.wind', { wind: tr('mahjong.wind.' + (f - 27), null, WIND[f - 27]) }, WIND[f - 27] + ' wind');
    if (f < 34) return tr('mahjong.dragon.' + (f - 31), null, DRAGON[f - 31]);
    return f < FIRST_SEASON ? tr('mahjong.flower.' + (f - FIRST_FLOWER), null, FLOWER[f - FIRST_FLOWER]) : tr('mahjong.season.' + (f - FIRST_SEASON), null, SEASON[f - FIRST_SEASON]);
  }

  // The four seasons are drawn as what they are (a sprout, the sun, a leaf, a snowflake), so no word is printed on a tile.
  var SEASON_ART = [
    '<path d="M20 40V22" stroke="COL" stroke-width="2.6" stroke-linecap="round" fill="none"/><path d="M20 26C12 26 8 21 8 14c7 0 12 3 12 12z" fill="COL"/><path d="M20 22c0-7 4-11 12-11 0 7-4 11-12 11z" fill="COL"/>',
    '<circle cx="20" cy="24" r="7" fill="COL"/><path d="M20 8v5M20 35v5M4 24h5M31 24h5M9 13l3.5 3.5M27.5 31.5L31 35M31 13l-3.5 3.5M12.5 31.5L9 35" stroke="COL" stroke-width="2.6" stroke-linecap="round"/>',
    '<path d="M20 8C30 12 33 22 28 31 25 36 22 38 20 40 18 38 15 36 12 31 7 22 10 12 20 8z" fill="COL"/><path d="M20 14v26M20 24l-6-5M20 29l6-5" stroke="#f7f2e4" stroke-width="1.8" stroke-linecap="round" fill="none"/>',
    '<path d="M20 8v32M6.1 16l27.8 16M6.1 32L33.9 16" stroke="COL" stroke-width="2.6" stroke-linecap="round"/><circle cx="20" cy="24" r="3.4" fill="COL"/>'
  ];

  // ── tile faces, drawn here (no fonts beyond the system's Latin) ──
  var INK = { 0: '#1565c0', 1: '#2e7d32', 2: '#c62828' };
  function num(n, color) { return '<text x="20" y="29" text-anchor="middle" font-size="27" font-weight="800" font-family="Georgia,\'Times New Roman\',serif" fill="' + color + '">' + n + '</text>'; }
  function ring(cx, cy, r, color) { return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="2.6"/><circle cx="' + cx + '" cy="' + cy + '" r="' + (r / 2.6).toFixed(1) + '" fill="' + color + '"/>'; }
  function faceMarkup(f) {
    var s, c;
    if (f < 27) {
      var suit = (f / 9) | 0, n = f % 9 + 1; c = INK[suit];
      s = num(n, c);
      if (suit === 0) s += ring(20, 42, 5.6, c);
      else if (suit === 1) s += '<g stroke="' + c + '" stroke-width="2.4" stroke-linecap="round"><path d="M16 36v13M24 36v13" fill="none"/><path d="M14 41h4M22 41h4M14 46h4M22 46h4" stroke-width="1.6"/></g>';
      else s += '<path d="M12 38h16M20 35v14M13 45h14" stroke="' + c + '" stroke-width="3.4" stroke-linecap="round" fill="none"/>';
    } else if (f < 31) {
      var mark = tr('mahjong4.initial.' + (f - 27), null, 'ESWN'[f - 27]);
      s = '<text x="20" y="' + (mark.length > 1 ? 33 : 35) + '" text-anchor="middle" font-size="' + (mark.length > 1 ? 22 : 31) + '" font-weight="800" font-family="Georgia,serif" fill="#1a237e">' + mark + '</text>';
      s += '<path d="M9 12h22" stroke="#1a237e" stroke-width="2.4" stroke-linecap="round"/>';
    } else if (f === 31) {
      s = '<path d="M20 8l13 18-13 18-13-18z" fill="#c62828"/><path d="M20 17l6 9-6 9-6-9z" fill="#f7f2e4"/>';
    } else if (f === 32) {
      s = '<path d="M10 40C8 22 20 10 32 11 33 24 26 38 10 40z" fill="#2e7d32"/><path d="M12 38C18 28 24 20 29 14" stroke="#f7f2e4" stroke-width="2" fill="none"/>';
    } else if (f === 33) {
      s = '<rect x="9" y="10" width="22" height="32" rx="3" fill="none" stroke="#1565c0" stroke-width="3.2"/><rect x="14" y="15" width="12" height="22" rx="1.5" fill="none" stroke="#1565c0" stroke-width="1.6"/>';
    } else if (f < FIRST_SEASON) {
      var k = f - FIRST_FLOWER, col = ['#d81b60', '#8e24aa', '#f9a825', '#43a047'][k];
      s = '';
      for (var p = 0; p < 5; p++) { var a = p * 1.2566 - 1.5708; s += '<circle cx="' + (20 + 8.5 * Math.cos(a)).toFixed(1) + '" cy="' + (24 + 8.5 * Math.sin(a)).toFixed(1) + '" r="6.2" fill="' + col + '"/>'; }
      s += '<circle cx="20" cy="24" r="4.2" fill="#fff3c4" stroke="' + col + '" stroke-width="1.2"/><text x="20" y="49" text-anchor="middle" font-size="11" font-weight="800" font-family="Georgia,serif" fill="' + col + '">' + (k + 1) + '</text>';
    } else {
      var q = f - FIRST_SEASON, sc = ['#2e7d32', '#e65100', '#8d6e63', '#0277bd'][q];
      s = SEASON_ART[q].replace(/COL/g, sc) + '<text x="20" y="49" text-anchor="middle" font-size="11" font-weight="800" font-family="Georgia,serif" fill="' + sc + '">' + (q + 1) + '</text>';
    }
    return '<svg viewBox="0 0 40 52" aria-hidden="true">' + s + '</svg>';
  }

  root.MahjongTiles = { faceName: faceName, faceMarkup: faceMarkup, FIRST_FLOWER: FIRST_FLOWER, FIRST_SEASON: FIRST_SEASON };
})(typeof globalThis !== 'undefined' ? globalThis : this);
