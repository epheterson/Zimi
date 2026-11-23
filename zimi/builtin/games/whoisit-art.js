/* ZimiGames: the faces of Who Is It, drawn from their features. Our own drawings, GPL-3.0. No network, no modules, no DOM.
   WhoIsItArt.faceSvg(face, size) is one face as an svg string; WhoIsItArt.iconSvg(featureId, size) is the same face with only that
   feature, for the question buttons. Colours are the faces' own materials and read in both themes. */
(function (root) {
  'use strict';

  var SKIN = ['#f3cdb0', '#e2ad80', '#c68642', '#94603a', '#fbe3d3'];
  var HAIR = { black: '#231d1a', brown: '#6b4226', blond: '#e6c35c', red: '#c1440e', gray: '#b9b9b9' };
  var HAT = ['#d1473f', '#3a63c9', '#3d9a4a', '#8a55c9', '#dc7a1b'];
  var EYES = ['#2b2118', '#3a6ea5', '#4d7c3a'];
  var INK = '#2b2118', MOUTH = '#8a3b2b', MOUTH_OPEN = '#7a2a22', FRECKLE = '#b5763d', GOLD = '#e8b923', LENS = 'rgba(255,255,255,0.28)';

  function p(d, fill, extra) { return '<path d="' + d + '" fill="' + fill + '"' + (extra ? ' ' + extra : '') + '/>'; }
  function c(cx, cy, r, fill, extra) { return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + fill + '"' + (extra ? ' ' + extra : '') + '/>'; }

  // face: { skin, eyes, hair, style: 'short'|'long'|'curly'|'bald', hat: false|colour index, glasses, mustache, beard, earrings, freckles, open }
  function faceParts(f) {
    var hair = HAIR[f.hair] || HAIR.brown, skin = SKIN[f.skin % SKIN.length] || SKIN[0], dark = f.style === 'bald' ? HAIR.brown : hair, back = '', front = '', mid = '';
    if (f.style === 'long') back += p('M17 48C12 8 88 8 83 48L88 94L66 94L66 64L34 64L34 94L12 94Z', hair);
    if (f.style === 'curly') [[27, 31], [39, 22], [51, 19], [63, 22], [75, 31], [22, 45], [79, 45]].forEach(function (q) { back += c(q[0], q[1], 12, hair); });
    // ears and what hangs from them
    mid += c(23, 57, 5.5, skin) + c(77, 57, 5.5, skin);
    if (f.earrings) mid += c(22, 65, 3.4, GOLD, 'stroke="#a8821a" stroke-width="0.8"') + c(78, 65, 3.4, GOLD, 'stroke="#a8821a" stroke-width="0.8"');
    // the head
    mid += '<ellipse cx="50" cy="56" rx="27" ry="31" fill="' + skin + '"/>';
    if (f.beard) mid += p('M24 60C24 98 76 98 76 60C71 80 62 85 50 85C38 85 29 80 24 60Z', dark);
    // eyes, nose, mouth
    mid += c(39, 51, 3.6, '#ffffff') + c(61, 51, 3.6, '#ffffff') + c(39, 51, 2.3, EYES[f.eyes % EYES.length] || INK) + c(61, 51, 2.3, EYES[f.eyes % EYES.length] || INK);
    mid += p('M50 53C46 62 46 64 50 65C52 65 53 64 54 63', 'none', 'stroke="' + (skin === SKIN[3] ? '#6e4426' : '#b9805a') + '" stroke-width="2" stroke-linecap="round"');
    mid += f.open ? p('M40 71C42 84 58 84 60 71Z', MOUTH_OPEN) : p('M41 72C46 77 54 77 59 72', 'none', 'stroke="' + MOUTH + '" stroke-width="2.6" stroke-linecap="round"');
    if (f.freckles) [[34, 60], [39, 62], [33, 65], [66, 60], [61, 62], [67, 65]].forEach(function (q) { mid += c(q[0], q[1], 1.5, FRECKLE); });
    if (f.mustache) mid += p('M36 67C42 60 49 63 50 67C51 63 58 60 64 67C58 71 52 69 50 70C48 69 42 71 36 67Z', dark);
    if (f.style === 'short' || f.style === 'long') front += p('M22 52C18 16 82 16 78 52C72 34 62 30 50 30C38 30 28 34 22 52Z', hair);
    if (f.glasses) front += c(39, 51, 9.8, LENS, 'stroke="' + INK + '" stroke-width="2.6"') + c(61, 51, 9.8, LENS, 'stroke="' + INK + '" stroke-width="2.6"') + p('M48.8 50.5L51.2 50.5', 'none', 'stroke="' + INK + '" stroke-width="2.6"') + p('M29.2 50L24 48M70.8 50L76 48', 'none', 'stroke="' + INK + '" stroke-width="2.2" stroke-linecap="round"');
    if (f.hat !== false && f.hat !== undefined && f.hat !== null) {
      var col = HAT[f.hat % HAT.length];
      front += p('M24 36C24 6 76 6 76 36Z', col) + '<rect x="15" y="33" width="70" height="9" rx="4.5" fill="' + col + '" stroke="rgba(0,0,0,0.3)" stroke-width="1"/>';
    }
    return back + mid + front;
  }

  // One face as a square svg. `size` is its pixel width (the viewBox is always 100).
  function faceSvg(f, size) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"' + (size ? ' width="' + size + '" height="' + size + '"' : '') + ' aria-hidden="true">' + faceParts(f) + '</svg>';
  }

  // The base a feature's icon is drawn on: a plain face with short brown hair, changed only by the feature.
  var BASE = { skin: 0, eyes: 0, hair: 'brown', style: 'short', hat: false, glasses: false, mustache: false, beard: false, earrings: false, freckles: false, open: false };
  var ICON = {
    glasses: { glasses: true }, hat: { hat: 0 }, mustache: { mustache: true }, beard: { beard: true }, bald: { style: 'bald' },
    blond: { hair: 'blond' }, red: { hair: 'red' }, black: { hair: 'black' }, brown: {}, gray: { hair: 'gray' },
    long: { style: 'long' }, curly: { style: 'curly' }, earrings: { earrings: true }, freckles: { freckles: true }, open: { open: true }
  };
  function iconSvg(id, size) {
    var f = {}, k;
    for (k in BASE) f[k] = BASE[k];
    for (k in ICON[id] || {}) f[k] = ICON[id][k];
    return faceSvg(f, size);
  }

  root.WhoIsItArt = { SKIN: SKIN, HAIR: HAIR, HAT: HAT, EYES: EYES, faceSvg: faceSvg, iconSvg: iconSvg, faceParts: faceParts };
})(typeof globalThis !== 'undefined' ? globalThis : this);
