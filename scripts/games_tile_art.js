// Shelf tile pictures drawn by code for build_games_shelf.js: one function per game, each returning the inside of a 320 x 180 tile
// (the generator lays the base colour under it). One light from the upper left, the shelf's materials (felt, wood, paper, steel)
// and Zimi's palette, and no words: numbers and symbols only, because the shelf is read in ten languages.
// Every gradient id carries its tile's prefix, since all the tiles share one page.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const n1 = (n) => String(Math.round(n * 10) / 10);
const lin = (id, stops, x1 = 0, y1 = 0, x2 = 1, y2 = 1) => '<linearGradient id="' + id + '" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '">' +
  stops.map(([o, c, a]) => '<stop offset="' + o + '" stop-color="' + c + '"' + (a === undefined ? '' : ' stop-opacity="' + a + '"') + '/>').join('') + '</linearGradient>';
const rad = (id, stops, cx = 0.5, cy = 0.5, r = 0.5, fx = cx, fy = cy) => '<radialGradient id="' + id + '" cx="' + cx + '" cy="' + cy + '" r="' + r + '" fx="' + fx + '" fy="' + fy + '">' +
  stops.map(([o, c, a]) => '<stop offset="' + o + '" stop-color="' + c + '"' + (a === undefined ? '' : ' stop-opacity="' + a + '"') + '/>').join('') + '</radialGradient>';
const defs = (...d) => '<defs>' + d.join('') + '</defs>';
const rect = (x, y, w, h, fill, extra) => '<rect x="' + n1(x) + '" y="' + n1(y) + '" width="' + n1(w) + '" height="' + n1(h) + '" fill="' + fill + '"' + (extra ? ' ' + extra : '') + '/>';
const circ = (x, y, r, fill, extra) => '<circle cx="' + n1(x) + '" cy="' + n1(y) + '" r="' + n1(r) + '" fill="' + fill + '"' + (extra ? ' ' + extra : '') + '/>';
const ell = (x, y, rx, ry, fill, extra) => '<ellipse cx="' + n1(x) + '" cy="' + n1(y) + '" rx="' + n1(rx) + '" ry="' + n1(ry) + '" fill="' + fill + '"' + (extra ? ' ' + extra : '') + '/>';
const path_ = (d, fill, extra) => '<path d="' + d + '" fill="' + fill + '"' + (extra ? ' ' + extra : '') + '/>';
const grp = (attrs, inner) => '<g ' + attrs + '>' + inner + '</g>';

// ── The land, projected onto a globe (orthographic) ────────────────────────
let landRings = null;
function land() {
  if (landRings) return landRings;
  const sb = { window: {} };
  sb.root = sb.window;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'zimi', 'builtin', 'games', 'world-land.js'), 'utf8'), sb);
  landRings = String(sb.window.WORLD_LAND_D || vm.runInContext('this.WORLD_LAND_D', sb)).split('Z').filter(Boolean).map((r) =>
    r.replace(/^M/, '').split(/L/).map((p) => p.split(',').map(Number)));
  return landRings;
}
const RAD = Math.PI / 180;
// A longitude/latitude on the globe centred at (lon0, lat0): x right, y down, in units of the radius; `near` says it faces us.
function ortho(lon, lat, lon0, lat0) {
  const l = (lon - lon0) * RAD, p = lat * RAD, p0 = lat0 * RAD;
  const cosc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l);
  return { x: Math.cos(p) * Math.sin(l), y: -(Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(l)), near: cosc > 0 };
}
// The land as one path inside a globe of radius r at (cx, cy). Points round the back are laid along the rim, and the clip finishes the edge.
function globeLand(cx, cy, r, lon0, lat0) {
  let d = '';
  land().forEach((ring) => {
    const pts = ring.map(([gx, gy]) => ortho(gx * 0.45 - 180, 90 - gy * 0.45, lon0, lat0));
    if (!pts.some((p) => p.near)) return;
    let last = null, out = '';
    pts.forEach((p) => {
      let x = p.x, y = p.y;
      if (!p.near) { const m = Math.hypot(x, y) || 1; x /= m; y /= m; }
      const X = cx + x * r, Y = cy + y * r;
      if (last && Math.hypot(X - last[0], Y - last[1]) < 1.1) return;
      out += (out ? 'L' : 'M') + n1(X) + ' ' + n1(Y);
      last = [X, Y];
    });
    if (out.indexOf('L') > 0) d += out + 'Z';
  });
  return d;
}
// One meridian or parallel as a polyline over the near face.
function globeLine(cx, cy, r, lon0, lat0, pts) {
  let d = '', pen = false;
  pts.forEach(([lo, la]) => {
    const p = ortho(lo, la, lon0, lat0);
    if (!p.near) { pen = false; return; }
    d += (pen ? 'L' : 'M') + n1(cx + p.x * r) + ' ' + n1(cy + p.y * r);
    pen = true;
  });
  return d;
}
const range = (a, b, s) => { const o = []; for (let v = a; v <= b + 1e-9; v += s) o.push(v); return o; };

// A map pin standing on the point (x, y): its tip is there, its round head above it.
function pin(x, y, s, body, hi) {
  const t = 'translate(' + n1(x) + ' ' + n1(y) + ') scale(' + s + ')';
  return grp('transform="' + t + '"',
    ell(2, 1, 9, 3.4, 'rgba(0,0,0,0.35)') +
    path_('M0 0C-3 -9 -13 -17 -13 -27a13 13 0 0 1 26 0C13 -17 3 -9 0 0Z', body, 'stroke="rgba(0,0,0,0.35)" stroke-width="1"') +
    circ(0, -27, 5.2, 'rgba(255,255,255,0.92)') +
    path_('M-9 -33C-7 -39 -2 -40 1 -39', 'none', 'stroke="' + hi + '" stroke-width="2.4" stroke-linecap="round" opacity="0.8"'));
}

const ART = {};

// Where in the World: a globe on the table, a pin dropped on it.
ART.whereintheworld = () => {
  const cx = 160, cy = 102, r = 64, lon0 = 12, lat0 = 24;
  const lines = range(-180, 180, 30).map((lo) => globeLine(cx, cy, r, lon0, lat0, range(-90, 90, 6).map((la) => [lo, la]))).concat(
    range(-60, 60, 30).map((la) => globeLine(cx, cy, r, lon0, lat0, range(-180, 180, 6).map((lo) => [lo, la])))).join('');
  const target = ortho(3, 41, lon0, lat0);
  return defs(
    lin('wiw-wood', [[0, '#c99a62'], [1, '#8f6538']], 0, 0, 0.4, 1),
    rad('wiw-sea', [[0, '#7cc6e6'], [0.55, '#2f86b8'], [1, '#17517d']], 0.36, 0.3, 0.8),
    rad('wiw-land', [[0, '#9cc76a'], [1, '#4f8a45']], 0.3, 0.25, 0.9),
    rad('wiw-shade', [[0.55, '#0b1f33', 0], [1, '#0b1f33', 0.55]], 0.36, 0.3, 0.85),
    rad('wiw-gloss', [[0, '#fff', 0.55], [1, '#fff', 0]], 0.28, 0.2, 0.3),
    '<clipPath id="wiw-clip"><circle cx="' + cx + '" cy="' + cy + '" r="' + r + '"/></clipPath>') +
    rect(0, 0, 320, 180, 'url(#wiw-wood)') +
    '<g stroke="rgba(70,40,14,0.16)" stroke-width="1"><path d="M0 24H320M0 62H320M0 118H320M0 150H320"/></g>' +
    ell(cx + 10, 166, 62, 8, 'rgba(40,22,6,0.38)') +
    circ(cx, cy, r, 'url(#wiw-sea)') +
    grp('clip-path="url(#wiw-clip)"',
      '<path d="' + lines + '" fill="none" stroke="#fff" stroke-opacity="0.18" stroke-width="0.8"/>' +
      '<path d="' + globeLand(cx, cy, r, lon0, lat0) + '" fill="url(#wiw-land)" stroke="#2f6a3c" stroke-width="0.7" stroke-linejoin="round"/>' +
      circ(cx, cy, r, 'url(#wiw-shade)')) +
    circ(cx, cy, r - 0.5, 'none', 'stroke="rgba(255,255,255,0.35)" stroke-width="1"') +
    circ(cx, cy, r, 'url(#wiw-gloss)') +
    ell(cx + target.x * r, cy + target.y * r, 13, 4.4, 'none', 'stroke="#fff" stroke-opacity="0.75" stroke-width="1.6"') +
    pin(cx + target.x * r, cy + target.y * r, 1.1, '#e0452f', '#ffb3a3');
};

// ── Shared pieces ──────────────────────────────────────────────────────────
const PAPER = '#fbf8ef', PAPER_EDGE = '#d9d2bf', INK = '#2b3550', LINK = '#2f6fd6', AMBER = '#f59e0b';
const SANS = 'system-ui,-apple-system,sans-serif';
const rr = (x, y, w, h, r, fill, extra) => '<rect x="' + n1(x) + '" y="' + n1(y) + '" width="' + n1(w) + '" height="' + n1(h) + '" rx="' + r + '" fill="' + fill + '"' + (extra ? ' ' + extra : '') + '/>';
const line = (x1, y1, x2, y2, stroke, w, extra) => '<path d="M' + n1(x1) + ' ' + n1(y1) + 'L' + n1(x2) + ' ' + n1(y2) + '" stroke="' + stroke + '" stroke-width="' + w + '" stroke-linecap="round" fill="none"' + (extra ? ' ' + extra : '') + '/>';
const at = (x, y, rot, inner) => grp('transform="translate(' + n1(x) + ' ' + n1(y) + ')' + (rot ? ' rotate(' + rot + ')' : '') + '"', inner);
const text = (x, y, size, fill, s, extra) => '<text x="' + n1(x) + '" y="' + n1(y) + '" font-size="' + size + '" font-weight="800" text-anchor="middle" fill="' + fill + '" font-family="' + SANS + '"' + (extra ? ' ' + extra : '') + '>' + s + '</text>';
// A sheet of paper, its shadow falling down and to the right.
const sheet = (w, h, inner, r) => rr(2.5, 3.5, w, h, r || 4, 'rgba(0,0,0,0.3)') + rr(0, 0, w, h, r || 4, 'url(#paper)', 'stroke="' + PAPER_EDGE + '" stroke-width="0.8"') + inner;
const PAPER_DEF = lin('paper', [[0, '#fffdf6'], [1, '#ebe5d3']]);
const SLATE_DEF = lin('slate', [[0, '#2d3e55'], [1, '#161d2b']], 0, 0, 0.5, 1);
const WOOD_DEF = lin('wood', [[0, '#c99a62'], [1, '#8f6538']], 0, 0, 0.4, 1);
const FELT_DEF = rad('felt', [[0, '#2f6a4d'], [1, '#17382a']], 0.35, 0.3, 0.9);
const lines = (x, y, w, gap, count, stroke, sw) => Array.from({ length: count }, (_, i) => line(x, y + i * gap, x + (i === count - 1 ? w * 0.6 : w), y + i * gap, stroke, sw || 2.4)).join('');
const wide = () => '<rect width="320" height="180" fill="url(#slate)"/>';
const cursor = (x, y, s) => at(x, y, 0, '<path transform="scale(' + s + ')" d="M0 0L0 17L4.4 13L7.4 20L10.2 18.8L7.2 12L13 12Z" fill="#fff" stroke="#1b1b1b" stroke-width="1.3" stroke-linejoin="round"/>');
const flag = (x, y, c) => { // a chequered flag on a pole, planted at (x, y)
  let q = '';
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) q += rect(2 + i * 6, -30 + j * 6, 6, 6, (i + j) % 2 ? '#1b1b1b' : '#fff');
  return at(x, y, 0, line(0, 0, 0, -32, '#3b2c1c', 2) + q + circ(0, -33, 2, c || AMBER));
};

// Wiki Race: pages joined by links, a pointer on the link, a chequered flag on the last page.
const page = (x, y, rot, link) => at(x, y, rot, sheet(66, 88,
  rr(8, 9, 28, 5, 2.5, INK) + rr(8, 22, 22, 20, 3, '#b9c7dc') + path_('M8 42L16 31L21 37L25 33L30 42Z', '#6f8fb8') +
  lines(35, 25, 24, 7, 3, '#b3aca0') + lines(8, 50, 50, 7, 3, '#b3aca0') +
  line(8, link, 40, link, LINK, 3) + line(8, link + 4.4, 40, link + 4.4, LINK, 1)));
ART.wikirace = () => defs(PAPER_DEF, SLATE_DEF) + wide() +
  page(24, 62, -6, 78) + page(127, 34, 0, 78) + page(230, 58, 6, 78) + flag(284, 70, AMBER) +
  path_('M92 84C102 56 114 52 126 76', 'none', 'stroke="' + AMBER + '" stroke-width="3" stroke-dasharray="1 6" stroke-linecap="round"') +
  path_('M123 71L128 80L118 80Z', AMBER, 'transform="rotate(14 123 76)"') +
  path_('M196 76C208 50 220 50 232 80', 'none', 'stroke="' + AMBER + '" stroke-width="3" stroke-dasharray="1 6" stroke-linecap="round"') +
  path_('M229 74L235 83L225 83Z', AMBER, 'transform="rotate(14 229 79)"') +
  cursor(160, 108, 1.5) + circ(40, 52, 7, '#4cae78', 'stroke="#fff" stroke-width="2.4"');

// Telephone: two tin cans on a string and a note passing along it.
const can = (open) => { // a can lying on its side, string end at x = 0 (its closed bottom), open mouth at x = -52
  return rr(-52, -28, 52, 56, 3, 'url(#tin)') + line(-36, -28, -36, 28, 'rgba(0,0,0,0.18)', 1.6) + line(-18, -28, -18, 28, 'rgba(0,0,0,0.18)', 1.6) +
    rr(-46, -20, 8, 40, 2, 'rgba(255,255,255,0.28)') +
    ell(0, 0, 10, 28, 'url(#tin2)', 'stroke="#6b7487" stroke-width="1"') + circ(2, 0, 2.2, '#2b3550') +
    ell(-52, 0, 10, 28, '#e3e8f0', 'stroke="#8e98ab" stroke-width="1.4"') + ell(-51, 0, 7.5, 24, 'url(#hole)');
};
ART.telephone = () => defs(
  lin('kraft', [[0, '#e1cba6'], [1, '#bd9c68']], 0, 0, 0.3, 1),
  lin('tin', [[0, '#f4f7fb'], [0.5, '#b8c1d1'], [1, '#6f7a90']], 0, 0, 0, 1),
  lin('tin2', [[0, '#d4dbe7'], [1, '#7b869b']]),
  rad('hole', [[0, '#1b2230'], [1, '#4a566d']], 0.6, 0.5, 0.7), PAPER_DEF) +
  rect(0, 0, 320, 180, 'url(#kraft)') +
  ell(62, 140, 52, 8, 'rgba(60,36,10,0.3)') + ell(258, 140, 52, 8, 'rgba(60,36,10,0.3)') +
  path_('M82 98Q160 150 238 98', 'none', 'stroke="rgba(60,36,10,0.3)" stroke-width="2" transform="translate(2 6)"') +
  path_('M82 98Q160 150 238 98', 'none', 'stroke="#fffaf0" stroke-width="2.6" stroke-linecap="round"') +
  at(82, 98, 0, can()) + at(238, 98, 0, grp('transform="scale(-1 1)"', can())) +
  at(160, 118, -4, grp('transform="translate(-16 -2) scale(0.9)"', sheet(30, 38, lines(5, 11, 20, 6, 4, '#b3aca0', 2) + path_('M30 0L30 10L20 0Z', '#d9d2bf')) +
    line(15, -1, 15, -1, AMBER, 0))) +
  '<g fill="none" stroke="#fffaf0" stroke-width="2.4" stroke-linecap="round" opacity="0.85"><path d="M18 70Q10 98 18 126"/><path d="M8 78Q2 98 8 118"/><path d="M302 70Q310 98 302 126"/><path d="M312 78Q318 98 312 118"/></g>';

// Dictionary Bluff: an open dictionary, one headword, the choices of meanings and one filled in.
ART.bluff = () => defs(PAPER_DEF, WOOD_DEF, lin('leather', [[0, '#9b3d34'], [1, '#5c1f1c']]),
  lin('pageL', [[0, '#fffdf6'], [0.85, '#f3eedd'], [1, '#d7cfba']], 0, 0, 1, 0), lin('pageR', [[0, '#d7cfba'], [0.15, '#f3eedd'], [1, '#fffdf6']], 0, 0, 1, 0)) +
  rect(0, 0, 320, 180, 'url(#wood)') + '<g stroke="rgba(70,40,14,0.16)"><path d="M0 30H320M0 150H320"/></g>' +
  rr(34, 30, 252, 128, 7, 'rgba(40,22,6,0.4)', 'transform="translate(4 5)"') +
  rr(34, 30, 252, 128, 7, 'url(#leather)') +
  path_('M44 38C84 34 130 38 160 48L160 150C130 142 84 138 44 142Z', 'url(#pageL)') +
  path_('M276 38C236 34 190 38 160 48L160 150C190 142 236 138 276 142Z', 'url(#pageR)') +
  '<path d="M44 142C84 138 130 142 160 150C190 142 236 138 276 142" fill="none" stroke="#d9d2bf" stroke-width="2"/>' +
  rr(60, 58, 52, 8, 4, INK) + line(60, 76, 112, 76, '#b3aca0', 2.4) + lines(60, 90, 80, 9, 5, '#b3aca0') +
  [0, 1, 2].map((i) => circ(186, 66 + i * 26, 6, i === 1 ? AMBER : '#fff', 'stroke="#8c826f" stroke-width="1.6"') + lines(200, 66 + i * 26, 56, 8, 2, '#b3aca0', 2.4)).join('') +
  path_('M166 146L166 176L172 170L178 176L178 148Z', AMBER, 'stroke="rgba(0,0,0,0.25)" stroke-width="0.8"');

// An opening quotation mark as printed (66): the ball low, its tail rising to the right. (x, y) is the ball's centre.
const quoteMark = (x, y, k) => grp('transform="translate(' + n1(x + 8 * k) + ' ' + n1(y + 12 * k) + ') scale(' + k + ')"',
  circ(0, 0, 7, AMBER) + path_('M-6.6 -2C-6.4 -11 -0.5 -18 9 -20.5L10.2 -16.4C4.2 -14.2 2.2 -9.6 3.6 -4Z', AMBER));

// First Lines: the opening of a page, and the book it came from.
ART.firstlines = () => defs(PAPER_DEF, WOOD_DEF, lin('cloth', [[0, '#7fb0a0'], [1, '#2c5d56']]), lin('gold', [[0, '#f6dc8b'], [1, '#c79a3a']])) +
  rect(0, 0, 320, 180, 'url(#wood)') + '<g stroke="rgba(70,40,14,0.16)"><path d="M0 30H320M0 150H320"/></g>' +
  at(26, 36, -7, sheet(104, 110,
    quoteMark(14, 26, 1.25) + quoteMark(42, 26, 1.25) +
    line(14, 56, 88, 56, '#b3aca0', 3) + line(14, 68, 88, 68, '#b3aca0', 3) + line(14, 80, 60, 80, '#b3aca0', 3) + line(14, 94, 80, 94, '#d6cfbd', 3))) +
  rr(172, 28, 100, 128, 3, 'rgba(40,22,6,0.4)', 'transform="translate(5 6)"') +
  rr(166, 36, 100, 128, 3, '#efe7d0') + rr(166, 36, 100, 124, 3, '#d9d2bf') +
  rr(164, 26, 100, 128, 4, 'url(#cloth)') + rr(164, 26, 12, 128, 4, 'rgba(0,0,0,0.22)') + line(180, 28, 180, 152, 'rgba(255,255,255,0.28)', 1.4) +
  rr(190, 38, 62, 104, 2, 'none', 'stroke="url(#gold)" stroke-width="2"') + rr(205, 62, 32, 24, 3, 'url(#gold)') + path_('M221 98L229 108L221 118L213 108Z', 'url(#gold)');

// Quizzical: a question card, four answers, one right.
ART.quizzical = () => defs(PAPER_DEF, SLATE_DEF, lin('amber', [[0, '#ffc44d'], [1, '#d97706']]), lin('chip', [[0, '#c8d2e4'], [1, '#8c9bb5']], 0, 0, 0, 1), lin('ok', [[0, '#6cc68f'], [1, '#2f8f5b']], 0, 0, 0, 1)) + wide() +
  at(66, 18, -2, sheet(188, 66, circ(34, 33, 21, 'url(#amber)', 'stroke="#fff" stroke-width="2.4"') + text(34, 44, 32, '#fff', '?') + lines(68, 24, 106, 10, 3, '#b3aca0', 4))) +
  [[44, 100, 0], [168, 100, 1], [44, 134, 0], [168, 134, 0]].map(([x, y, ok]) =>
    rr(x + 1.5, y + 2.5, 108, 26, 8, 'rgba(0,0,0,0.3)') + rr(x, y, 108, 26, 8, ok ? 'url(#ok)' : 'url(#chip)', 'stroke="rgba(255,255,255,0.5)" stroke-width="1"') +
    (ok ? path_('M' + (x + 44) + ' ' + (y + 13) + 'L' + (x + 52) + ' ' + (y + 20) + 'L' + (x + 66) + ' ' + (y + 6), 'none', 'stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"')
      : line(x + 30, y + 13, x + 78, y + 13, 'rgba(255,255,255,0.7)', 4))).join('');

// Higher or Lower: two cards, one hidden, an arrow each way.
const tarot = (x, y, face) => at(x, y, 0, sheet(112, 130, face, 7));
ART.higherlower = () => defs(PAPER_DEF, SLATE_DEF, lin('sky', [[0, '#9ec5ee'], [1, '#e8f1fb']], 0, 0, 0, 1), lin('amber', [[0, '#ffc44d'], [1, '#d97706']]),
  lin('up', [[0, '#6cc68f'], [1, '#2f8f5b']], 0, 0, 0, 1), lin('down', [[0, '#ef7a6a'], [1, '#c0362a']], 0, 0, 0, 1)) + wide() +
  tarot(26, 24, rr(10, 10, 92, 72, 6, 'url(#sky)') + path_('M10 82L38 34L52 54L64 40L102 82Z', '#6f8fb8') + path_('M30 46L38 34L46 46L41 44L38 47L34 44Z', '#fff') +
    circ(84, 26, 7, '#ffd36b') + rr(26, 94, 60, 24, 12, INK) + text(56, 112, 15, '#fff', '8,849', 'font-variant-numeric="tabular-nums"')) +
  tarot(182, 24, rr(10, 10, 92, 72, 6, '#27334a') + circ(56, 46, 26, 'url(#amber)', 'stroke="#fff" stroke-width="2.4"') + text(56, 58, 34, '#fff', '?') +
    rr(26, 94, 60, 24, 12, '#c8d2e4') + text(56, 112, 15, INK, '?')) +
  path_('M160 28L174 52L146 52Z', 'url(#up)', 'stroke="#fff" stroke-width="2.4" stroke-linejoin="round"') +
  path_('M160 152L174 128L146 128Z', 'url(#down)', 'stroke="#fff" stroke-width="2.4" stroke-linejoin="round"');

// Minesweeper: raised tiles, opened squares with their counts, a flag, a mine.
ART.minesweeper = () => {
  const GRID = ['UU1..1UU', 'U221.2FU', 'UF1..1UU', 'UU311MUU'];
  const colour = { 1: '#2f6fd6', 2: '#2f8a4a', 3: '#d03a2c' };
  let out = '';
  GRID.forEach((row, j) => row.split('').forEach((c, i) => {
    const x = 16 + i * 36, y = 18 + j * 36;
    if (c === 'U' || c === 'F') {
      out += rect(x, y, 36, 36, '#8190a8') + path_('M' + x + ' ' + y + 'H' + (x + 36) + 'L' + (x + 32) + ' ' + (y + 4) + 'H' + (x + 4) + 'V' + (y + 32) + 'L' + x + ' ' + (y + 36) + 'Z', '#eef2f8') +
        path_('M' + (x + 36) + ' ' + (y + 36) + 'H' + x + 'L' + (x + 4) + ' ' + (y + 32) + 'H' + (x + 32) + 'V' + (y + 4) + 'L' + (x + 36) + ' ' + y + 'Z', '#6a7890') + rect(x + 4, y + 4, 28, 28, '#c3ccda');
      if (c === 'F') out += at(x + 18, y + 18, 0, line(-3, 11, 7, 11, '#1b1b1b', 3) + line(1, -11, 1, 11, '#1b1b1b', 2.4) + path_('M1 -12L-10 -6L1 0Z', '#d93a2b'));
    } else {
      out += rect(x, y, 36, 36, c === 'M' ? '#e0584a' : '#e9e4d6', 'stroke="#b9b29f" stroke-width="1"');
      if (c === 'M') out += circ(x + 18, y + 18, 7.5, '#1b1b1b') + line(x + 18, y + 7, x + 18, y + 29, '#1b1b1b', 2.4) + line(x + 7, y + 18, x + 29, y + 18, '#1b1b1b', 2.4) + circ(x + 15.5, y + 15.5, 2.4, '#fff');
      else if (colour[c]) out += text(x + 18, y + 26, 22, colour[c], c);
    }
  }));
  return defs(SLATE_DEF) + wide() + rr(10, 12, 300, 156, 8, 'rgba(0,0,0,0.35)') + out;
};

// Paddles: a table seen from above, a ball over the net, a bat each side.
const bat = (x, y, rot, rubber) => at(x, y, rot,
  path_('M-6 19L-8.5 47Q0 51 8.5 47L6 19Z', 'rgba(0,0,0,0.3)', 'transform="translate(3 3)"') + circ(2.4, 3, 23, 'rgba(0,0,0,0.3)') +
  path_('M-5.5 18L-8 46Q0 50 8 46L5.5 18Z', 'url(#handle)', 'stroke="#6b4522" stroke-width="0.8"') + rr(-7.4, 40, 14.8, 3, 1.5, 'rgba(0,0,0,0.22)') + path_('M-3 22L-5 44', 'none', 'stroke="#fff" stroke-opacity="0.35" stroke-width="1.6" stroke-linecap="round"') +
  path_('M-13 14L-5.5 25L5.5 25L13 14Z', '#b9854b') +
  circ(0, 0, 23, '#17181d') + circ(0, 0, 21, 'url(#' + rubber + ')') + circ(0, 0, 21, 'url(#pimple)') + path_('M-14 -8A16 16 0 0 1 -4 -16', 'none', 'stroke="#fff" stroke-opacity="0.5" stroke-width="3" stroke-linecap="round"'));
ART.paddles = () => defs(
  lin('floor', [[0, '#2a3246'], [1, '#121620']], 0, 0, 0.4, 1), lin('table', [[0, '#2f78b8'], [1, '#17507f']], 0, 0, 0.5, 1),
  lin('handle', [[0, '#e2b97c'], [1, '#97693a']], 0, 0, 1, 0), rad('red', [[0, '#ef5a45'], [1, '#a5261c']], 0.35, 0.3, 0.85), rad('black', [[0, '#6a7188'], [0.6, '#2c3040'], [1, '#14161c']], 0.35, 0.3, 0.85),
  '<pattern id="pimple" width="4" height="4" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="0.8" fill="#000" fill-opacity="0.22"/></pattern>',
  rad('ball', [[0, '#fff'], [1, '#f6b75a']], 0.35, 0.3, 0.75)) +
  rect(0, 0, 320, 180, 'url(#floor)') +
  rr(30, 30, 266, 130, 7, 'rgba(0,0,0,0.4)') + rr(24, 24, 272, 132, 7, 'url(#table)') + rr(30, 30, 260, 120, 3, 'none', 'stroke="#fff" stroke-opacity="0.8" stroke-width="2"') +
  line(30, 90, 290, 90, '#fff', 1.6, 'stroke-opacity="0.55"') +
  rect(158, 20, 7, 144, 'rgba(0,0,0,0.28)') + rect(157, 19, 4, 142, '#fff', 'fill-opacity="0.92"') + circ(159, 19, 3, '#d9d2bf') + circ(159, 161, 3, '#d9d2bf') +
  '<g stroke="#fff" stroke-opacity="0.35" stroke-width="1.2" stroke-dasharray="1 5" stroke-linecap="round"><path d="M70 120L142 70"/></g>' +
  circ(150, 78, 6.4, 'rgba(0,0,0,0.3)', 'transform="translate(5 7)"') + circ(150, 78, 6.4, 'url(#ball)') +
  bat(60, 118, 24, 'red') + bat(262, 64, 204, 'black');

// Fleet: the sea from above, the grid, ships in steel, a peg for a miss and a fire for a hit.
const ship = (x, y, len, rot) => at(x, y, rot,
  path_('M2.5 3.5H' + (len - 8 + 2.5) + 'L' + (len + 2.5) + ' 15.5L' + (len - 8 + 2.5) + ' 27.5H2.5Z', 'rgba(0,0,0,0.3)') +
  path_('M0 0H' + (len - 8) + 'L' + len + ' 12L' + (len - 8) + ' 24H0Z', 'url(#hull)', 'stroke="#46536b" stroke-width="1"') +
  rr(6, 5, len - 22, 14, 3, 'url(#deck)') + rr(len * 0.35, 8, 14, 8, 2, '#8d9bb3') + circ(len * 0.7, 12, 4, '#46536b') + line(10, 12, len - 18, 12, '#46536b', 0.8));
ART.fleet = () => defs(
  lin('sea', [[0, '#2b78a8'], [1, '#123d63']], 0, 0, 0.5, 1), lin('hull', [[0, '#c4cddc'], [1, '#6e7b92']], 0, 0, 0.3, 1), lin('deck', [[0, '#e4e9f1'], [1, '#aab5c8']]),
  rad('fire', [[0, '#fff3b0'], [0.4, '#ffb02e'], [1, '#e8442b', 0]]), rad('peg', [[0, '#fff'], [1, '#c9d0dc']], 0.35, 0.3, 0.8)) +
  rect(0, 0, 320, 180, 'url(#sea)') +
  '<g stroke="#fff" stroke-opacity="0.2" stroke-width="1.2">' + range(0, 320, 40).map((x) => '<path d="M' + x + ' 0V180"/>').join('') + range(0, 180, 36).map((y) => '<path d="M0 ' + y + 'H320"/>').join('') + '</g>' +
  ship(36, 44, 112, 0) + ship(196, 22, 100, 90) + ship(50, 114, 76, 0) +
  circ(132, 98, 9, 'rgba(0,0,0,0.3)', 'transform="translate(2 3)"') + circ(132, 98, 9, 'url(#peg)') + circ(132, 98, 3.4, '#8896ad') +
  circ(236, 156, 9, 'rgba(0,0,0,0.3)', 'transform="translate(2 3)"') + circ(236, 156, 9, 'url(#peg)') + circ(236, 156, 3.4, '#8896ad') +
  circ(98, 56, 20, 'url(#fire)') + circ(98, 56, 8, '#e8442b', 'stroke="#fff" stroke-width="2"') + circ(95.5, 53.5, 2.6, '#ffd0c8') +
  circ(246, 72, 17, 'url(#fire)') + circ(246, 72, 7, '#e8442b', 'stroke="#fff" stroke-width="2"') + circ(243.8, 69.8, 2.2, '#ffd0c8');

// Mahjong for Four: the table, four walls, the discards, the dice.
const backTile = (x, y, w, h) => rect(x + 1, y + 1.6, w, h, 'rgba(0,0,0,0.35)') + rect(x, y, w, h, '#f2ead0') + rect(x, y, w, h - 3.2, '#2f9a66', 'stroke="#1d6e47" stroke-width="0.6"') + rect(x + 1, y + 1, w - 2, 1.6, 'rgba(255,255,255,0.3)');
const dots = (cx, cy, k, colour) => ({ 1: [[0, 0]], 2: [[0, -5], [0, 5]], 3: [[-4, -5], [0, 0], [4, 5]], 4: [[-4, -4], [4, -4], [-4, 4], [4, 4]], 5: [[-4, -5], [4, -5], [0, 0], [-4, 5], [4, 5]] }[k] || []).map(([dx, dy]) => circ(cx + dx, cy + dy, k === 1 ? 5 : 2.5, colour)).join('');
const faceTile = (x, y, rot, art) => at(x, y, rot, rr(1.4, 2.2, 20, 28, 3, 'rgba(0,0,0,0.35)') + rr(0, 0, 20, 28, 3, '#f5efd9', 'stroke="#cfc6a8" stroke-width="0.8"') + rr(1.5, 1.5, 17, 23, 2, '#fffaec') + rect(0, 25, 20, 3, '#2f9a66', 'opacity="0.0"') + art);
ART.mahjong4 = () => {
  let walls = '';
  for (let i = 0; i < 14; i++) { walls += backTile(62 + i * 14.6, 14, 13, 18) + backTile(62 + i * 14.6, 140, 13, 18); }
  for (let j = 0; j < 8; j++) { walls += backTile(16, 38 + j * 12.8, 18, 11) + backTile(286, 38 + j * 12.8, 18, 11); }
  const green = (cx, cy) => line(cx, cy - 8, cx, cy + 8, '#2a8a56', 2.6) + line(cx - 4, cy - 4, cx - 4, cy + 4, '#2a8a56', 2.2) + line(cx + 4, cy - 4, cx + 4, cy + 4, '#2a8a56', 2.2);
  return defs(FELT_DEF) + rect(0, 0, 320, 180, 'url(#felt)') + walls +
    faceTile(96, 56, -8, dots(10, 13, 3, '#2f6fd6')) + faceTile(120, 62, 6, green(10, 13)) + faceTile(146, 54, -4, dots(10, 13, 5, '#c93a2e')) +
    faceTile(172, 62, 8, dots(10, 13, 1, '#c93a2e')) + faceTile(96, 90, 5, dots(10, 13, 4, '#2f8a4a')) + faceTile(122, 94, -7, dots(10, 13, 2, '#2f6fd6')) +
    faceTile(148, 88, 4, green(10, 13)) + faceTile(174, 94, -5, dots(10, 13, 3, '#2f6fd6')) +
    at(214, 84, 14, rr(1.6, 2.4, 15, 15, 3, 'rgba(0,0,0,0.3)') + rr(0, 0, 15, 15, 3, '#fffdf4', 'stroke="#cfc6a8" stroke-width="0.8"') + circ(7.5, 7.5, 2.4, '#d03a2c')) +
    at(232, 96, -12, rr(1.6, 2.4, 15, 15, 3, 'rgba(0,0,0,0.3)') + rr(0, 0, 15, 15, 3, '#fffdf4', 'stroke="#cfc6a8" stroke-width="0.8"') + circ(4, 4, 1.8, '#1b1b1b') + circ(11, 11, 1.8, '#1b1b1b') + circ(7.5, 7.5, 1.8, '#1b1b1b'));
};

// Drop Pin: a paper map on the table, creased, with a pin dropped on it.
ART.droppin = () => {
  const roads = '<g fill="none" stroke-linecap="round"><path d="M-10 118L330 96" stroke="#d6cdb4" stroke-width="9"/><path d="M-10 118L330 96" stroke="#fff6d8" stroke-width="6"/><path d="M96 -10L132 190" stroke="#d6cdb4" stroke-width="8"/><path d="M96 -10L132 190" stroke="#fff" stroke-width="5"/><path d="M200 -10L214 190" stroke="#d6cdb4" stroke-width="6"/><path d="M200 -10L214 190" stroke="#fff" stroke-width="3.6"/></g>';
  return defs(WOOD_DEF, lin('mapfold', [[0, '#000', 0], [0.5, '#000', 0.12], [1, '#fff', 0.3]], 0, 0, 1, 0)) +
    rect(0, 0, 320, 180, 'url(#wood)') + '<g stroke="rgba(70,40,14,0.16)"><path d="M0 30H320M0 150H320"/></g>' +
    at(30, 18, -2, rr(4, 6, 262, 148, 3, 'rgba(40,22,6,0.4)') + '<clipPath id="mapclip"><rect width="262" height="148" rx="3"/></clipPath>' +
      grp('clip-path="url(#mapclip)"', rect(0, 0, 262, 148, '#f1ead6') + at(-30, -18, 2, '<g>' +
        path_('M60 0C80 40 60 70 100 110C120 130 150 150 140 190L240 190C250 150 220 120 250 80C270 50 250 20 270 0Z', '#a9d1ea') +
        path_('M60 0C80 40 60 70 100 110C120 130 150 150 140 190', 'none', 'stroke="#7fb4d6" stroke-width="2"') +
        ell(240, 130, 32, 22, '#bcd9a0') + ell(236, 126, 20, 12, '#a8cf8a') + rect(150, 20, 30, 24, '#e6dcc0') + rect(150, 52, 30, 22, '#e6dcc0') + rect(184, 20, 30, 24, '#ece3c9') + rect(236, 20, 40, 26, '#e6dcc0') + rect(20, 80, 40, 30, '#e6dcc0') +
        rect(150, 138, 40, 30, '#e6dcc0') + rect(210, 160, 50, 30, '#e6dcc0') + roads + '</g>') +
        rect(87, 0, 88, 148, 'url(#mapfold)') + rect(174, 0, 88, 148, 'url(#mapfold)') + rect(87, 0, 1, 148, 'rgba(0,0,0,0.14)') + rect(174, 0, 1, 148, 'rgba(0,0,0,0.14)')) +
      rr(0, 0, 262, 148, 3, 'none', 'stroke="#cfc6a8" stroke-width="1"')) +
    ell(212, 104, 18, 6, 'none', 'stroke="' + AMBER + '" stroke-opacity="0.9" stroke-width="2"') + pin(212, 104, 1.3, AMBER, '#ffe3a3');
};

// Lander: the pad, the module on its flame, the Earth over the horizon.
ART.lander = () => {
  const leg = (sx) => line(160 + sx * 10, 80, 160 + sx * 25, 100, '#c9cdd8', 2.4) + line(160 + sx * 25, 100, 160 + sx * 25, 100, '#c9cdd8', 1) + rr(160 + sx * 25 - 5, 99, 10, 3, 1.5, '#e8ebf1');
  let stars = '';
  [[20, 20], [58, 44], [96, 14], [132, 38], [186, 18], [228, 34], [270, 12], [300, 56], [40, 84], [250, 84], [112, 70]].forEach(([x, y], i) => { stars += circ(x, y, i % 3 ? 1 : 1.6, '#fff', 'opacity="' + (i % 2 ? 0.55 : 0.9) + '"'); });
  return defs(lin('night', [[0, '#05070f'], [1, '#1b2640']], 0, 0, 0, 1), lin('rock', [[0, '#9a9fb0'], [1, '#444a5c']], 0, 0, 0.3, 1),
    rad('earth', [[0, '#8fd0f2'], [0.6, '#2f7fc0'], [1, '#143c78']], 0.35, 0.3, 0.8), lin('foil', [[0, '#f8dc86'], [1, '#b4802a']]), lin('flame', [[0, '#fff6c8'], [0.5, '#ffb02e'], [1, '#e8442b', 0]], 0, 0, 0, 1)) +
    rect(0, 0, 320, 180, 'url(#night)') + stars +
    circ(258, 44, 17, 'url(#earth)') + path_('M246 40C252 34 260 38 264 36M252 50C258 46 266 50 270 46', 'none', 'stroke="#fff" stroke-opacity="0.7" stroke-width="2.6" stroke-linecap="round"') +
    path_('M0 146C40 132 80 138 118 146L202 146C240 136 290 132 320 142L320 180L0 180Z', 'url(#rock)') +
    ell(48, 158, 16, 4, 'rgba(0,0,0,0.3)') + ell(270, 160, 20, 5, 'rgba(0,0,0,0.3)') + ell(46, 156.6, 16, 4, 'rgba(255,255,255,0.12)') +
    rr(96, 144, 128, 12, 3, '#3b4256') + rr(96, 144, 128, 5, 3, '#59617a') + circ(104, 150, 2.4, AMBER) + circ(216, 150, 2.4, AMBER) + circ(160, 150, 2.4, AMBER) +
    path_('M150 102L160 148L170 102Z', 'url(#flame)') +
    leg(-1) + leg(1) +
    path_('M142 56L178 56L186 80L174 100L146 100L134 80Z', 'rgba(0,0,0,0.3)', 'transform="translate(3 4)"') +
    path_('M142 52L178 52L186 76L174 96L146 96L134 76Z', 'url(#foil)', 'stroke="#8a5f1c" stroke-width="1"') +
    path_('M134 76L186 76', 'none', 'stroke="#8a5f1c" stroke-opacity="0.4"') + rr(148, 58, 24, 14, 6, '#27334a', 'stroke="#fff" stroke-opacity="0.6"') + path_('M152 62A8 5 0 0 1 160 60', 'none', 'stroke="#fff" stroke-opacity="0.7" stroke-width="1.6" stroke-linecap="round"') +
    rr(146, 96, 28, 6, 2, '#6b7487');
};

// Babel: the tower in the evening, five tongues speaking round it.
ART.babel = () => {
  let tiers = '';
  for (let k = 0; k < 5; k++) {
    const hb = (156 - 24 * k) / 2, ht = hb - 8, yb = 156 - 25 * k, yt = yb - 25;
    tiers += path_('M' + (160 - hb) + ' ' + yb + 'L' + (160 - ht) + ' ' + yt + 'L' + (160 + ht) + ' ' + yt + 'L' + (160 + hb) + ' ' + yb + 'Z', 'url(#stone)') +
      rect(160 - ht - 3, yt - 3, ht * 2 + 6, 4, '#f0d6a2') + rect(160 - ht - 3, yt + 1, ht * 2 + 6, 2.4, 'rgba(0,0,0,0.25)');
    const count = 6 - k;
    for (let i = 0; i < count; i++) { const ax = 160 + (i - (count - 1) / 2) * ((ht * 2 - 14) / count) * 1.0; tiers += path_('M' + n1(ax - 4) + ' ' + (yb - 2) + 'V' + (yb - 11) + 'a4 4 0 0 1 8 0V' + (yb - 2) + 'Z', '#6b4a2a'); }
  }
  const bubble = (x, y, c, flip) => at(x, y, 0, path_('M-11 -8H11a5 5 0 0 1 5 5V5a5 5 0 0 1-5 5H' + (flip ? '-4' : '4') + 'L' + (flip ? '-9' : '9') + ' 16L' + (flip ? '-8' : '8') + ' 10H-11a5 5 0 0 1-5-5V-3a5 5 0 0 1 5-5Z', 'rgba(0,0,0,0.25)', 'transform="translate(1.6 2.4)"') +
    path_('M-11 -8H11a5 5 0 0 1 5 5V5a5 5 0 0 1-5 5H' + (flip ? '-4' : '4') + 'L' + (flip ? '-9' : '9') + ' 16L' + (flip ? '-8' : '8') + ' 10H-11a5 5 0 0 1-5-5V-3a5 5 0 0 1 5-5Z', c, 'stroke="#fff" stroke-width="1.8" stroke-linejoin="round"') +
    circ(-6, 1, 1.8, '#fff') + circ(0, 1, 1.8, '#fff') + circ(6, 1, 1.8, '#fff'));
  return defs(lin('dusk', [[0, '#3f5f8f'], [0.65, '#e8a77a'], [1, '#f6d398']], 0, 0, 0, 1), lin('stone', [[0, '#f1d29c'], [0.55, '#c99a5c'], [1, '#8f6538']], 0, 0, 1, 0.3),
    rad('sun', [[0, '#fff3c4'], [0.35, '#ffd27a', 0.9], [1, '#ffd27a', 0]]), lin('dune', [[0, '#c59a58'], [1, '#8f6538']], 0, 0, 0, 1)) +
    rect(0, 0, 320, 180, 'url(#dusk)') + circ(48, 44, 46, 'url(#sun)') + circ(48, 44, 11, '#fff3c4') +
    ell(250, 120, 34, 7, 'rgba(255,255,255,0.35)') + ell(278, 112, 22, 6, 'rgba(255,255,255,0.3)') +
    path_('M0 150C60 142 110 156 170 152C230 148 280 146 320 154L320 180L0 180Z', 'url(#dune)') +
    ell(190, 158, 84, 8, 'rgba(60,36,10,0.35)') + tiers +
    bubble(70, 82, '#d9453a', false) + bubble(236, 40, '#3b82f6', true) + bubble(262, 88, '#2f9a66', true) + bubble(96, 128, '#8b5cf6', false) + bubble(202, 18, AMBER, false);
};

// Sudoku: a printed grid on a sheet of paper, a few givens, a pencil lying across the corner.
ART.sudoku = () => {
  const GIVENS = { '0,0': 5, '2,1': 3, '4,0': 7, '6,3': 6, '3,4': 9, '8,4': 1, '1,6': 8, '5,6': 4, '7,8': 2, '2,7': 6, '7,2': 9, '4,8': 3 };
  const C = 14, X0 = 98, Y0 = 21;
  let nums = '', thin = '';
  Object.keys(GIVENS).forEach((k) => { const [i, j] = k.split(',').map(Number); nums += text(X0 + i * C + C / 2, Y0 + j * C + C - 3.2, 11.5, INK, GIVENS[k]); });
  for (let k = 1; k < 9; k++) if (k % 3) thin += '<path d="M' + (X0 + k * C) + ' ' + Y0 + 'V' + (Y0 + 9 * C) + 'M' + X0 + ' ' + (Y0 + k * C) + 'H' + (X0 + 9 * C) + '" stroke="#a9a090" stroke-width="0.8"/>';
  return defs(PAPER_DEF, WOOD_DEF, lin('pencil', [[0, '#ffd45a'], [0.5, '#f4a91c'], [1, '#c77b0c']], 0, 0, 0, 1), lin('lead', [[0, '#e8c99a'], [1, '#c9a46c']])) +
    rect(0, 0, 320, 180, 'url(#wood)') + '<g stroke="rgba(70,40,14,0.16)"><path d="M0 30H320M0 150H320"/></g>' +
    at(78, 8, -2, sheet(158, 162, '', 4) + '<g transform="translate(-78 -8)">' + thin + '</g>' +
      '<g transform="translate(-78 -8)">' + '<path d="M' + X0 + ' ' + (Y0 + 3 * C) + 'H' + (X0 + 9 * C) + 'M' + X0 + ' ' + (Y0 + 6 * C) + 'H' + (X0 + 9 * C) + 'M' + (X0 + 3 * C) + ' ' + Y0 + 'V' + (Y0 + 9 * C) + 'M' + (X0 + 6 * C) + ' ' + Y0 + 'V' + (Y0 + 9 * C) + '" stroke="#2b3550" stroke-width="1.8"/></g>' +
      '<g transform="translate(-78 -8)"><rect x="' + X0 + '" y="' + Y0 + '" width="' + 9 * C + '" height="' + 9 * C + '" fill="none" stroke="#2b3550" stroke-width="2.6"/>' + nums + text(X0 + 5 * C + C / 2, Y0 + 5 * C + C - 3.2, 11.5, AMBER, 4) + '</g>') +
    at(214, 140, -34, rr(2, 3, 112, 11, 5.5, 'rgba(0,0,0,0.32)') + rr(0, 0, 90, 11, 1.5, 'url(#pencil)') + rect(0, 3.6, 90, 1.4, '#fff', 'fill-opacity="0.45"') + rr(0, 0, 90, 11, 1.5, 'none', 'stroke="#8a5408" stroke-width="0.8"') +
      path_('M90 0L112 5.5L90 11Z', 'url(#lead)') + path_('M104 3.2L112 5.5L104 7.8Z', '#2b3550') + rr(-9, 0, 9, 11, 2, '#e8776a') + rect(-1, 0, 2.4, 11, '#c0c7d4'));
};

// Snake: scales and a shine on the body, a tongue, the apple it is going for.
ART.snake = () => {
  const BODY = 'M34 140C92 156 118 112 164 108C214 104 204 62 244 62';
  let grid = '';
  for (let i = 0; i < 16; i++) for (let j = 0; j < 9; j++) if ((i + j) % 2) grid += rect(i * 20, j * 20, 20, 20, '#fff', 'fill-opacity="0.035"');
  return defs(rad('bg', [[0, '#27573a'], [1, '#0f2417']], 0.35, 0.3, 0.95), lin('bodyg', [[0, '#8ae38f'], [1, '#2f9a4d']], 0, 0, 0, 1), rad('apple', [[0, '#ff8f7c'], [0.5, '#d9362b'], [1, '#8d1a14']], 0.35, 0.3, 0.8),
    rad('head', [[0, '#a6f0a4'], [1, '#3da85a']], 0.35, 0.3, 0.9)) +
    rect(0, 0, 320, 180, 'url(#bg)') + grid +
    '<path d="' + BODY + '" transform="translate(4 7)" fill="none" stroke="#000" stroke-opacity="0.38" stroke-width="26" stroke-linecap="round"/>' +
    '<path d="' + BODY + '" fill="none" stroke="#1e6b36" stroke-width="26" stroke-linecap="round"/>' +
    '<path d="' + BODY + '" fill="none" stroke="#4fbf6b" stroke-width="22" stroke-linecap="round"/>' +
    '<path d="' + BODY + '" fill="none" stroke="#1e6b36" stroke-opacity="0.45" stroke-width="22" stroke-dasharray="2 10" />' +
    '<path d="' + BODY + '" transform="translate(-3 -4)" fill="none" stroke="#c4f5c0" stroke-opacity="0.55" stroke-width="5" stroke-linecap="round"/>' +
    at(246, 62, -4, ell(3, 4, 21, 15, 'rgba(0,0,0,0.3)') + ell(0, 0, 21, 15, 'url(#head)', 'stroke="#1e6b36" stroke-width="1.6"') + ell(-3, -6, 11, 4, '#fff', 'fill-opacity="0.3"') +
      circ(6, -8, 4.4, '#fff') + circ(6, 8, 4.4, '#fff') + circ(7.4, -8, 2.2, '#16301f') + circ(7.4, 8, 2.2, '#16301f')) +
    path_('M266 62H280M280 62L286 57M280 62L286 67', 'none', 'stroke="#e5352b" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"') +
    ell(292, 134, 17, 5, 'rgba(0,0,0,0.38)') + circ(292, 112, 19, 'url(#apple)') + path_('M292 93Q292 86 298 82', 'none', 'stroke="#5a3a1c" stroke-width="3" stroke-linecap="round"') +
    path_('M295 88C300 80 310 80 313 83C309 90 300 91 295 88Z', '#58b85f', 'stroke="#2f7a3d" stroke-width="1"') + ell(285, 105, 5, 3.4, '#fff', 'fill-opacity="0.5" transform="rotate(-30 285 105)"');
};

// Five Letters: raised keys, one row guessed with clues, one solved, one being typed.
ART.fiveletters = () => {
  const KEY = { g: ['#4b5568', '#323a4a'], y: ['#e0b620', '#a97d0a'], v: ['#4cb05a', '#2a7a37'] };
  const rows = [['CRANE', 'ggygy'], ['ABODE', 'vvvvv']];
  let out = '';
  const key = (x, y, ch, k) => rr(x, y + 4, 42, 42, 6, KEY[k][1]) + rr(x, y, 42, 42, 6, 'url(#k' + k + ')') + rr(x + 1.5, y + 1.5, 39, 4, 2, '#fff', 'fill-opacity="0.22"') + text(x + 21, y + 30, 25, '#fff', ch, 'style="text-shadow:none"');
  rows.forEach(([w, c], j) => w.split('').forEach((ch, i) => { out += key(43 + i * 48, 14 + j * 52, ch, c[i]); }));
  for (let i = 0; i < 5; i++) {
    const x = 43 + i * 48, y = 118;
    out += rr(x, y, 42, 42, 6, i < 2 ? '#2c3548' : 'rgba(255,255,255,0.04)', 'stroke="' + (i < 2 ? '#8896ad' : '#4b5568') + '" stroke-width="2"');
    if (i < 2) out += text(x + 21, y + 30, 25, '#fff', 'AB'[i]);
  }
  return defs(lin('bg', [[0, '#2d3e55'], [1, '#161d2b']], 0, 0, 0.5, 1), lin('kg', [[0, '#667189'], [1, '#434c5f']], 0, 0, 0, 1), lin('ky', [[0, '#f2cf4d'], [1, '#cf9b12']], 0, 0, 0, 1), lin('kv', [[0, '#6cc977'], [1, '#389947']], 0, 0, 0, 1)) +
    rect(0, 0, 320, 180, 'url(#bg)') + out;
};

// 2048: a tray with its wells, tiles stepped from pale to amber, the last one glowing.
ART.t2048 = () => {
  const CELL = 62, GAP = 6, X0 = 55, Y0 = 19;
  const TONE = { 2: ['#f6f7f9', '#d3d8e0', INK], 4: ['#d8eee7', '#a8cfc3', INK], 16: ['#a8d5c6', '#76b3a1', INK], 64: ['#3fb59a', '#2a8a73', '#fff'], 128: ['#2f9c85', '#1f7561', '#fff'], 2048: ['#f59e0b', '#b9700a', '#fff'] };
  const grid = [[2, 16, 64], [4, 128, 2048]];
  let out = '';
  for (let j = 0; j < 2; j++) for (let i = 0; i < 3; i++) {
    const x = X0 + GAP + i * (CELL + GAP), y = Y0 + GAP + j * (CELL + GAP), v = grid[j][i], [hi, lo, ink] = TONE[v];
    if (v === 2048) out += circ(x + CELL / 2, y + CELL / 2, 56, 'url(#glow)');
    out += rr(x, y, CELL, CELL, 8, 'rgba(0,0,0,0.28)', 'transform="translate(0 3)"') + rr(x, y, CELL, CELL, 8, hi) + rr(x, y + CELL * 0.45, CELL, CELL * 0.55, 8, lo, 'opacity="0.5"') +
      rr(x + 1, y + 1, CELL - 2, 5, 3, '#fff', 'fill-opacity="0.35"') + text(x + CELL / 2, y + CELL / 2 + (v > 999 ? 8 : 10), v > 999 ? 19 : v > 99 ? 24 : 30, ink, v);
  }
  let wells = '';
  for (let j = 0; j < 2; j++) for (let i = 0; i < 3; i++) wells += rr(X0 + GAP + i * (CELL + GAP), Y0 + GAP + j * (CELL + GAP), CELL, CELL, 8, 'rgba(0,0,0,0.28)');
  return defs(lin('bg', [[0, '#e3e8ef'], [1, '#bcc5d3']], 0, 0, 0.4, 1), lin('tray', [[0, '#3a4d6a'], [1, '#202b3e']], 0, 0, 0.3, 1), rad('glow', [[0, '#ffd27a', 0.7], [1, '#ffd27a', 0]])) +
    rect(0, 0, 320, 180, 'url(#bg)') + rr(X0 + 3, Y0 + 6, 3 * CELL + 4 * GAP, 2 * CELL + 3 * GAP, 12, 'rgba(0,0,0,0.3)') + rr(X0, Y0, 3 * CELL + 4 * GAP, 2 * CELL + 3 * GAP, 12, 'url(#tray)') + wells + out;
};

// Bricks: lit bricks in rows, a gap with a spark, a ball with a trail, a steel paddle.
ART.bricks = () => {
  const ROWS = [['#e0564d', '#a3302a'], ['#ec8a2a', '#a85a10'], ['#e2b51b', '#a07c08']];
  const MISSING = { '1,2': 1, '1,3': 1, '2,1': 1, '2,2': 1, '2,3': 1, '2,4': 1 };
  let out = '';
  ROWS.forEach(([hi, lo], j) => { for (let i = 0; i < 5; i++) { if (MISSING[j + ',' + i]) continue; const x = 24 + i * 56, y = 22 + j * 20;
    out += rr(x, y + 2.5, 50, 14, 3, 'rgba(0,0,0,0.35)') + rr(x, y, 50, 14, 3, lo) + rr(x, y, 50, 10, 3, hi) + rr(x + 2, y + 1, 46, 2.4, 1.2, '#fff', 'fill-opacity="0.45"'); } });
  return defs(lin('bg', [[0, '#27344b'], [1, '#121824']], 0, 0, 0.3, 1), lin('steel', [[0, '#f4f6fa'], [1, '#9aa5b8']], 0, 0, 0, 1), rad('ball', [[0, '#fff'], [0.4, '#ffb15c'], [1, '#d9660a']], 0.35, 0.3, 0.8), lin('trail', [[0, '#f59a45', 0], [1, '#f59a45', 0.5]], 0, 0, 1, 1)) +
    rect(0, 0, 320, 180, 'url(#bg)') + rect(0, 0, 10, 180, '#fff', 'fill-opacity="0.06"') + rect(310, 0, 10, 180, '#fff', 'fill-opacity="0.06"') + out +
    '<path d="M120 66L164 104" stroke="#f59a45" stroke-opacity="0.55" stroke-width="2.4" stroke-dasharray="1 6" stroke-linecap="round" fill="none"/>' +
    ell(176, 128, 9, 3.4, 'rgba(0,0,0,0.35)') + circ(172, 112, 8, 'url(#ball)') +
    rr(126, 154, 74, 12, 6, 'rgba(0,0,0,0.4)') + rr(124, 150, 74, 12, 6, 'url(#steel)') + rr(130, 152, 60, 2.4, 1.2, '#fff', 'fill-opacity="0.7"') + circ(132, 156, 2.2, '#d1473f') + circ(190, 156, 2.2, '#d1473f');
};

// Memory: cards on the table, backs patterned, one pair turned up.
ART.memory = () => {
  const W = 64, H = 70, X0 = 50, Y0 = 14, GX = 14, GY = 10;
  const frog = (cx, cy) => ell(cx + 1, cy + 22, 22, 4, 'rgba(0,0,0,0.18)') + ell(cx, cy + 8, 22, 15, 'url(#frog)') + circ(cx - 11, cy - 7, 9, 'url(#frog)') + circ(cx + 11, cy - 7, 9, 'url(#frog)') +
    circ(cx - 11, cy - 8, 5.4, '#fff') + circ(cx + 11, cy - 8, 5.4, '#fff') + circ(cx - 10, cy - 7.4, 2.8, '#16301f') + circ(cx + 12, cy - 7.4, 2.8, '#16301f') +
    path_('M' + (cx - 10) + ' ' + (cy + 8) + 'Q' + cx + ' ' + (cy + 17) + ' ' + (cx + 10) + ' ' + (cy + 8), 'none', 'stroke="#1e6b36" stroke-width="2.2" stroke-linecap="round"');
  let out = '';
  for (let j = 0; j < 2; j++) for (let i = 0; i < 3; i++) {
    const x = X0 + i * (W + GX), y = Y0 + j * (H + GY), up = i === 1, rot = [[-2, 1, 2], [1.5, -1, -1.5]][j][i];
    out += at(x + W / 2, y + H / 2, rot, rr(-W / 2 + 2, -H / 2 + 3.5, W, H, 9, 'rgba(0,0,0,0.38)') +
      (up ? rr(-W / 2, -H / 2, W, H, 9, 'url(#face)', 'stroke="#3d9a4a" stroke-width="3"') + at(0, -2, 0, frog(0, 0)) :
        rr(-W / 2, -H / 2, W, H, 9, 'url(#back)') + rr(-W / 2 + 5, -H / 2 + 5, W - 10, H - 10, 5, 'url(#lattice)', 'stroke="#fff" stroke-opacity="0.55" stroke-width="1.6"') + circ(0, 0, 13, '#fff', 'fill-opacity="0.92"') + text(0, 8.6, 22, '#d97706', '?') +
        rr(-W / 2 + 2, -H / 2 + 2, W - 4, 5, 3, '#fff', 'fill-opacity="0.25"')));
  }
  return defs(lin('bg', [[0, '#2f4a6a'], [1, '#141b29']], 0, 0, 0.5, 1), lin('back', [[0, '#f0950f'], [1, '#b4570a']], 0, 0, 0.3, 1), lin('face', [[0, '#fffdf6'], [1, '#e9e2cd']]),
    lin('frog', [[0, '#7fd57f'], [1, '#3f9f4e']], 0, 0, 0, 1),
    '<pattern id="lattice" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0H9M0 0V9" stroke="#fff" stroke-opacity="0.28" stroke-width="1.2"/></pattern>') +
    rect(0, 0, 320, 180, 'url(#bg)') + out;
};

// Every tile shares one page, so each tile's ids get its name in front of them.
const scoped = (name, svg) => {
  const ids = new Set(); svg.replace(/\bid="([\w-]+)"/g, (m, id) => { ids.add(id); return m; });
  return svg.replace(/\bid="([\w-]+)"/g, (m, id) => 'id="' + name + '-' + id + '"').replace(/url\(#([\w-]+)\)/g, (m, id) => ids.has(id) ? 'url(#' + name + '-' + id + ')' : m);
};

module.exports = { ART, scoped, lin, rad, defs, rect, circ, ell, path_, grp, n1 };
