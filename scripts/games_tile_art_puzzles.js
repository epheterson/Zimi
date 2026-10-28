// Shelf tile pictures for the Logic puzzles family (Simon Tatham's collection), 38 of them, for build_games_shelf.js.
// Same rules as games_tile_art.js: a 320 x 180 tile, one light from the upper left (shadows fall down and right), the
// shelf's materials (wood, felt, slate, paper, steel) and Zimi's palette, and no words: digits and symbols only.
// Each function returns the inside of the tile, background included; ids are scoped to the tile by the generator.

const { lin, rad, defs, rect, circ, ell, path_, grp, n1 } = require('./games_tile_art.js');

const INK = '#2b3550', EDGE = '#d9d2bf', AMBER = '#f59e0b', LIT = '#fde68a';
const RED = '#d1473f', BLUE = '#2f6fd6', GREEN = '#3f9f4e', PURPLE = '#8a5cc2', TEAL = '#2aa198';
const SANS = 'system-ui,-apple-system,sans-serif';
const rr = (x, y, w, h, r, fill, extra) => '<rect x="' + n1(x) + '" y="' + n1(y) + '" width="' + n1(w) + '" height="' + n1(h) + '" rx="' + r + '" fill="' + fill + '"' + (extra ? ' ' + extra : '') + '/>';
const ln = (x1, y1, x2, y2, stroke, w) => '<path d="M' + n1(x1) + ' ' + n1(y1) + 'L' + n1(x2) + ' ' + n1(y2) + '" stroke="' + stroke + '" stroke-width="' + w + '" stroke-linecap="round" fill="none"/>';
const pl = (pts, fill, extra) => path_('M' + pts.map((p) => n1(p[0]) + ' ' + n1(p[1])).join('L') + 'Z', fill, extra);
const stroke = (d, color, w, extra) => '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="' + w + '" stroke-linecap="round" stroke-linejoin="round"' + (extra ? ' ' + extra : '') + '/>';
const num = (x, y, size, fill, s) => '<text x="' + n1(x) + '" y="' + n1(y + size * 0.36) + '" font-size="' + size + '" font-weight="800" text-anchor="middle" fill="' + fill + '" font-family="' + SANS + '">' + s + '</text>';

const DEFS = defs(
  lin('paper', [[0, '#fffdf6'], [1, '#ebe5d3']]), lin('wood', [[0, '#c99a62'], [1, '#8f6538']], 0, 0, 0.4, 1),
  lin('slate', [[0, '#2d3e55'], [1, '#161d2b']], 0, 0, 0.5, 1), rad('felt', [[0, '#2f6a4d'], [1, '#17382a']], 0.35, 0.3, 0.9),
  rad('ball', [[0, '#fff'], [0.35, '#9fb4d6'], [1, '#3a4d6e']], 0.32, 0.28, 0.8), lin('tile', [[0, '#f1d9a8'], [1, '#d3aa63']], 0, 0, 0.4, 1),
  lin('steel', [[0, '#f4f6fa'], [1, '#9aa5b8']], 0, 0, 0, 1));
const BASE = { wood: '#8f6538', slate: '#161d2b', felt: '#285c43' };
const planks = '<g stroke="rgba(70,40,14,0.16)" stroke-width="1"><path d="M0 24H320M0 62H320M0 118H320M0 150H320"/></g>';
const ground = (kind) => rect(0, 0, 320, 180, 'url(#' + kind + ')') + (kind === 'wood' ? planks : '');
const tile = (kind, inner) => DEFS + ground(kind) + inner;

// A grid of cols x rows cells of size c, centred on the tile (ox, oy nudge it).
function grid(cols, rows, c, ox, oy) {
  const x0 = 160 - cols * c / 2 + (ox || 0), y0 = 90 - rows * c / 2 + (oy || 0);
  return { cols, rows, c, x0, y0, w: cols * c, h: rows * c, X: (i) => x0 + i * c, Y: (j) => y0 + j * c, mx: (i) => x0 + (i + 0.5) * c, my: (j) => y0 + (j + 0.5) * c };
}
// A sheet of paper under the grid, lit from the upper left.
const board = (g, pad, fill) => rr(g.x0 - pad + 3, g.y0 - pad + 4, g.w + 2 * pad, g.h + 2 * pad, 6, 'rgba(0,0,0,0.32)') +
  rr(g.x0 - pad, g.y0 - pad, g.w + 2 * pad, g.h + 2 * pad, 6, fill || 'url(#paper)', 'stroke="' + EDGE + '" stroke-width="0.8"') +
  rr(g.x0 - pad + 1, g.y0 - pad + 1, g.w + 2 * pad - 2, 2, 1, '#fff', 'fill-opacity="0.7"');
const rules = (g, color, w) => {
  let d = '';
  for (let i = 1; i < g.cols; i++) d += 'M' + n1(g.X(i)) + ' ' + n1(g.y0) + 'V' + n1(g.y0 + g.h);
  for (let j = 1; j < g.rows; j++) d += 'M' + n1(g.x0) + ' ' + n1(g.Y(j)) + 'H' + n1(g.x0 + g.w);
  return stroke(d, color, w || 1);
};
const frame = (g, color, w) => rect(g.x0, g.y0, g.w, g.h, 'none', 'stroke="' + (color || INK) + '" stroke-width="' + (w || 2.4) + '"');
const cell = (g, i, j, fill, inset, extra) => rect(g.X(i) + (inset || 0), g.Y(j) + (inset || 0), g.c - 2 * (inset || 0), g.c - 2 * (inset || 0), fill, extra);
const digit = (g, i, j, s, fill, k) => num(g.mx(i), g.my(j), g.c * (k || 0.56), fill || INK, s);
// A wall between cells: from lattice point (i, j) to (i2, j2).
const wall = (g, i, j, i2, j2, color, w) => ln(g.X(i), g.Y(j), g.X(i2), g.Y(j2), color || INK, w || 4);
const PAL = [RED, BLUE, GREEN, AMBER, PURPLE, TEAL];
// A paper grid: sheet, rules, frame; the usual start of a pencil puzzle.
const paperGrid = (g, pad) => board(g, pad || 8) + rules(g, '#b3aca0', 1) + frame(g);
// A ball with the shared steel gradient, shadowed; `fill` replaces the gradient.
const marble = (x, y, r, fill) => ell(x + r * 0.2, y + r * 0.8, r * 0.95, r * 0.35, 'rgba(0,0,0,0.3)') + circ(x, y, r, fill || 'url(#ball)') + circ(x - r * 0.3, y - r * 0.35, r * 0.28, '#fff', 'fill-opacity="0.7"');

const ART = {};
const BG = {};
const add = (name, kind, fn) => { ART[name] = () => tile(kind, fn()); BG[name] = BASE[kind]; };

// Black Box: beams fired into a dark box find the balls hidden in it.
add('blackbox', 'slate', () => {
  const g = grid(8, 8, 15, 0, 2);
  const ball = (i, j) => marble(g.mx(i), g.my(j), 5.6, 'url(#ball)');
  const badge = (x, y, s, f) => circ(x, y, 6.5, f) + num(x, y, 9, '#fff', s);
  return board(g, 14) + rect(g.x0, g.y0, g.w, g.h, '#27344f') + rules(g, 'rgba(255,255,255,0.12)', 1) +
    ln(g.x0 - 6, g.my(2), g.mx(2) - 6, g.my(2), AMBER, 2.2) + circ(g.x0 - 6, g.my(2), 4, AMBER) +
    ln(g.mx(4), g.y0 - 7, g.mx(4), g.y0 + g.h + 7, '#7fd0ff', 2.2) + badge(g.mx(4), g.y0 - 7, '1', BLUE) + badge(g.mx(4), g.y0 + g.h + 7, '1', BLUE) +
    ball(2, 2) + ball(5, 5) + ball(6, 1);
});

// Bridges: numbered islands joined by single and double bridges.
add('bridges', 'slate', () => {
  const g = grid(5, 4, 1, 0, 0);
  const P = { a: [105, 44, 3], b: [160, 44, 4], c: [215, 44, 2], d: [160, 92, 3], e: [105, 138, 2], f: [215, 138, 2] };
  const link = (p, q, dbl) => { const [x1, y1] = P[p], [x2, y2] = P[q], v = x1 === x2, o = dbl ? 3 : 0;
    return (dbl ? ln(x1 + (v ? -o : 0), y1 + (v ? 0 : -o), x2 + (v ? -o : 0), y2 + (v ? 0 : -o), INK, 2.4) + ln(x1 + (v ? o : 0), y1 + (v ? 0 : o), x2 + (v ? o : 0), y2 + (v ? 0 : o), INK, 2.4) : ln(x1, y1, x2, y2, INK, 2.4)); };
  void g;
  return rr(83 + 3, 18 + 4, 154, 144, 8, 'rgba(0,0,0,0.32)') + rr(83, 18, 154, 144, 8, 'url(#paper)', 'stroke="' + EDGE + '"') +
    link('a', 'b', true) + link('b', 'c') + link('a', 'e') + link('b', 'd', true) + link('c', 'f') + link('e', 'f') +
    Object.keys(P).map((k) => circ(P[k][0] + 1.5, P[k][1] + 2.5, 13, 'rgba(0,0,0,0.25)') + circ(P[k][0], P[k][1], 13, '#fff', 'stroke="' + INK + '" stroke-width="2.4"') + num(P[k][0], P[k][1], 16, INK, P[k][2])).join('');
});

// Cube: roll a cube over a grid and pick up the blue squares.
add('cube', 'wood', () => {
  const g = grid(4, 4, 34, 0, 0), blue = { '0,0': 1, '3,1': 1, '1,3': 1, '3,3': 1 };
  let out = paperGrid(g, 9);
  Object.keys(blue).forEach((k) => { const [i, j] = k.split(',').map(Number); out += cell(g, i, j, BLUE, 3, 'fill-opacity="0.85"'); });
  const cx = g.mx(1), cy = g.my(1) - 2, r = 13;
  out += ell(cx + 3, cy + 17, 15, 5, 'rgba(0,0,0,0.3)') + pl([[cx, cy - r - 2], [cx + r, cy - r / 2 - 1], [cx, cy + 1], [cx - r, cy - r / 2 - 1]], '#fffdf6', 'stroke="' + INK + '" stroke-width="1.6" stroke-linejoin="round"') +
    pl([[cx - r, cy - r / 2 - 1], [cx, cy + 1], [cx, cy + r + 2], [cx - r, cy + r / 2 + 1]], '#c8d1e0', 'stroke="' + INK + '" stroke-width="1.6" stroke-linejoin="round"') +
    pl([[cx + r, cy - r / 2 - 1], [cx, cy + 1], [cx, cy + r + 2], [cx + r, cy + r / 2 + 1]], '#8e9bb4', 'stroke="' + INK + '" stroke-width="1.6" stroke-linejoin="round"') + circ(cx - 1, cy - r / 2, 3, BLUE);
  return out;
});

// Dominosa: every pair of numbers once, as dominoes on a grid.
add('dominosa', 'wood', () => {
  const g = grid(5, 4, 30, 0, 0), vals = ['01', '20', '12', '03', '31', '23', '02', '10', '33', '22', '11', '00', '13', '21', '30', '02', '32', '10', '12', '01'];
  const doms = [[0, 0, 1, 0], [2, 0, 2, 1], [3, 0, 4, 0], [0, 1, 0, 2], [1, 1, 1, 2], [3, 1, 4, 1], [2, 2, 3, 2], [4, 2, 4, 3], [0, 3, 1, 3], [2, 3, 3, 3]];
  let out = board(g, 9);
  doms.forEach(([a, b, c, d], k) => {
    const x = g.X(a) + 2, y = g.Y(b) + 2, w = (c - a + 1) * g.c - 4, h = (d - b + 1) * g.c - 4;
    out += rr(x + 1.5, y + 2.5, w, h, 6, 'rgba(0,0,0,0.25)') + rr(x, y, w, h, 6, k % 3 === 0 ? LIT : '#fffdf6', 'stroke="' + INK + '" stroke-width="1.8"');
    out += digit(g, a, b, vals[k][0], INK, 0.6) + digit(g, c, d, vals[k][1], INK, 0.6);
    out += c > a ? ln(g.X(a) + g.c, y + 5, g.X(a) + g.c, y + h - 5, '#b3aca0', 1.2) : ln(x + 5, g.Y(b) + g.c, x + w - 5, g.Y(b) + g.c, '#b3aca0', 1.2);
  });
  return out;
});

// The sliding-number family on one tray: Fifteen (one gap, a tile sliding into it), Sixteen (no gap: a whole row shifts and its end wraps
// round), Twiddle (a 2 x 2 block turning). `move` places the one thing each does; the rest of the tray is the same.
const ORDER = [3, 1, 7, 4, 5, 2, 12, 8, 9, 6, 11, 15, 13, 10, 14, 0];
const TRAY = (g) => rr(g.x0 - 8 + 3, g.y0 - 8 + 4, g.w + 16, g.h + 16, 8, 'rgba(0,0,0,0.35)') + rr(g.x0 - 8, g.y0 - 8, g.w + 16, g.h + 16, 8, '#4a3220') + rr(g.x0 - 4, g.y0 - 4, g.w + 8, g.h + 8, 4, '#2a1b10');
// One numbered tile with its top-left corner at (x, y), turned by `rot` degrees about its middle.
const woodTile = (x, y, c, v, rot, lift) => {
  const body = rr(x + 2.5, y + 3.5 + (lift || 0), c - 3, c - 3, 5, 'rgba(0,0,0,' + (lift ? 0.5 : 0.4) + ')') + rr(x + 1.5, y + 1.5, c - 3, c - 3, 5, 'url(#tile)', 'stroke="#a57a3b" stroke-width="1"') +
    rr(x + 3.5, y + 2.5, c - 7, 2, 1, '#fff', 'fill-opacity="0.55"') + num(x + c / 2, y + c / 2, c * 0.5, '#4a3220', v);
  return rot ? grp('transform="rotate(' + rot + ' ' + n1(x + c / 2) + ' ' + n1(y + c / 2) + ')"', body) : body;
};
const arrowHead = (x, y, dir, size, color) => pl(dir > 0 ? [[x, y - size], [x, y + size], [x + size * 1.3, y]] : [[x, y - size], [x, y + size], [x - size * 1.3, y]], color);
const slider = (move) => {
  const n = 4, g = grid(n, n, 34, 0, 0), v = (i, j) => ORDER[(j * n + i) % 16] || (j * n + i + 1);
  let out = TRAY(g);
  const skip = move === 'gap' ? { '3,3': 1, '2,3': 1 } : move === 'row' ? { '0,0': 1, '1,0': 1, '2,0': 1, '3,0': 1 } : move === 'turn' ? { '1,1': 1, '2,1': 1, '1,2': 1, '2,2': 1 } : {};
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (!skip[i + ',' + j]) out += woodTile(g.X(i), g.Y(j), g.c, v(i, j));
  if (move === 'gap') {   // 14 slides right into the empty corner, a dashed outline where it was
    out += rr(g.X(2) + 2, g.Y(3) + 2, g.c - 4, g.c - 4, 5, 'none', 'stroke="rgba(255,255,255,0.45)" stroke-width="1.6" stroke-dasharray="4 3"') + woodTile(g.X(2) + 12, g.Y(3), g.c, 14, 0, 1);
  }
  if (move === 'row') {   // the whole top row moves one place right: its last tile comes round on the left, and arrows say so
    const sh = 16;
    out += rect(g.x0 - 6, g.Y(0) - 2, g.w + 12, g.c + 4, 'rgba(245,158,11,0.22)', 'stroke="' + AMBER + '" stroke-width="2.4"');
    for (let i = 0; i < n; i++) out += woodTile(g.X(i) + sh, g.Y(0), g.c, v(i, 0), 0, 1);
    out += woodTile(g.X(0) + sh - g.c, g.Y(0), g.c, v(3, 0), 0, 1);
    for (let j = 0; j < n; j++) out += arrowHead(g.x0 + g.w + 12, g.my(j), 1, 6, AMBER) + arrowHead(g.x0 - 12, g.my(j), -1, 6, AMBER);
  }
  if (move === 'turn') {  // the 2 x 2 block, each tile turned a little, on an amber panel, with a half-turn arrow over it
    const cx = g.X(2), cy = g.Y(2);
    out += rect(g.X(1) - 2, g.Y(1) - 2, 2 * g.c + 4, 2 * g.c + 4, 'rgba(245,158,11,0.3)', 'stroke="' + AMBER + '" stroke-width="3" rx="6"');
    [[1, 1], [2, 1], [1, 2], [2, 2]].forEach(([i, j]) => { out += woodTile(g.X(i), g.Y(j), g.c, v(i, j), i === j ? 9 : -9); });
    out += circ(cx, cy, 14, AMBER, 'stroke="#fff" stroke-width="2"') + stroke('M' + n1(cx - 6) + ' ' + n1(cy + 2) + 'A6.5 6.5 0 1 1 ' + n1(cx + 2) + ' ' + n1(cy + 6.2), '#fff', 2.6) + pl([[cx + 6, cy + 2], [cx + 6, cy + 10], [cx - 1, cy + 6.5]], '#fff');
  }
  return out;
};
add('fifteen', 'wood', () => slider('gap'));
add('sixteen', 'wood', () => slider('row'));

// Filling: numbers that name the size of their region.
add('filling', 'wood', () => {
  const g = grid(5, 5, 28, 0, 0), map = ['11223', '14223', '44233', '45533', '55553'], size = { 1: 3, 2: 4, 3: 5, 4: 4, 5: 5 };
  const col = { 1: '#f3b8a8', 2: '#b9d6f2', 3: '#cfe8b3', 4: '#f6dc8e', 5: '#d9c3ec' };
  let out = board(g, 8);
  map.forEach((row, j) => row.split('').forEach((ch, i) => { out += cell(g, i, j, col[ch]); }));
  out += rules(g, 'rgba(43,53,80,0.25)', 1) + frame(g);
  const shown = { '0,0': 1, '2,0': 1, '4,1': 1, '0,3': 1, '2,3': 1, '3,4': 1 };
  Object.keys(shown).forEach((k) => { const [i, j] = k.split(',').map(Number); out += digit(g, i, j, size[map[j][i]], INK); });
  return out;
});

// Flip: tap a square and its neighbours flip; light them all.
add('flip', 'slate', () => {
  const g = grid(5, 5, 28, 0, 0), on = '01101101110111011011010110'.slice(0, 25);
  let out = rr(g.x0 - 8 + 3, g.y0 - 8 + 4, g.w + 16, g.h + 16, 8, 'rgba(0,0,0,0.4)') + rr(g.x0 - 8, g.y0 - 8, g.w + 16, g.h + 16, 8, '#0e131d');
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) {
    const lit = on[j * 5 + i] === '1';
    out += rr(g.X(i) + 2, g.Y(j) + 2, g.c - 4, g.c - 4, 5, lit ? LIT : '#2d3e55') + (lit ? rr(g.X(i) + 4, g.Y(j) + 3, g.c - 8, 3, 1.5, '#fff', 'fill-opacity="0.7"') : rr(g.X(i) + 4, g.Y(j) + 3, g.c - 8, 2, 1, '#fff', 'fill-opacity="0.12"'));
  }
  const cx = g.mx(2), cy = g.my(2), r = g.c * 1.5;
  return out + stroke('M' + n1(cx - g.c / 2) + ' ' + n1(cy - r) + 'h' + g.c + 'v' + n1(r - g.c / 2) + 'h' + n1(r - g.c / 2) + 'v' + g.c + 'h' + n1(-(r - g.c / 2)) + 'v' + n1(r - g.c / 2) + 'h' + n1(-g.c) + 'v' + n1(-(r - g.c / 2)) + 'h' + n1(-(r - g.c / 2)) + 'v' + n1(-g.c) + 'h' + n1(r - g.c / 2) + 'z', AMBER, 3);
});

// Flood: spread one colour from the corner until the whole grid is one.
add('flood', 'slate', () => {
  const g = grid(6, 6, 23, 0, 0), m = ['000241', '001432', '031205', '412534', '253142', '340215'];
  const col = ['#f59e0b', RED, BLUE, GREEN, PURPLE, TEAL];
  let out = rr(g.x0 - 7 + 3, g.y0 - 7 + 4, g.w + 14, g.h + 14, 8, 'rgba(0,0,0,0.4)') + rr(g.x0 - 7, g.y0 - 7, g.w + 14, g.h + 14, 8, '#0e131d');
  m.forEach((row, j) => row.split('').forEach((ch, i) => { out += rr(g.X(i) + 0.8, g.Y(j) + 0.8, g.c - 1.6, g.c - 1.6, 3.5, col[+ch]) + rr(g.X(i) + 2.5, g.Y(j) + 1.8, g.c - 5, 2.2, 1, '#fff', 'fill-opacity="0.35"'); }));
  return out + circ(g.mx(0), g.my(0), 4, '#fff', 'fill-opacity="0.9"');
});

// Galaxies: divide the grid so each region turns upside down into itself around its dot.
add('galaxies', 'felt', () => {
  const g = grid(5, 5, 28, 0, 0);
  const walls = [[2, 0, 2, 2], [0, 2, 2, 2], [2, 2, 3, 2], [3, 2, 3, 0], [3, 0, 3, 0], [3, 2, 5, 2], [1, 2, 1, 4], [1, 4, 3, 4], [3, 2, 3, 5], [3, 4, 5, 4]];
  let out = paperGrid(g, 8);
  out = out.replace(rules(g, '#b3aca0', 1), rules(g, '#c9c2ae', 1));
  walls.forEach(([a, b, c, d]) => { out += wall(g, a, b, c, d, INK, 4); });
  return out + [[2, 1], [1, 3], [4, 1], [2, 4], [4, 3.4]].map(([i, j]) => circ(g.X(i) + (i % 1 ? 0 : 0), g.Y(j), 5.2, '#fff', 'stroke="' + INK + '" stroke-width="2"')).join('');
});

// Group: fill a table so every row and column is a permutation (a group's Cayley table).
add('group', 'felt', () => {
  const g = grid(4, 4, 32, 0, 0), cols = [RED, BLUE, GREEN, AMBER];
  let out = paperGrid(g, 9);
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    if ((i * 3 + j * 5) % 4 === 1) continue;
    const c = cols[(i + j) % 4];
    out += circ(g.mx(i) + 1, g.my(j) + 2, 10.5, 'rgba(0,0,0,0.22)') + circ(g.mx(i), g.my(j), 10.5, c) + circ(g.mx(i) - 3, g.my(j) - 3.5, 3, '#fff', 'fill-opacity="0.45"');
  }
  return out;
});

// Inertia: slide until something stops you; collect the gems and keep off the mines.
add('inertia', 'slate', () => {
  const g = grid(6, 5, 26, 0, 0);
  const gem = (i, j) => pl([[g.mx(i), g.my(j) - 9], [g.mx(i) + 8, g.my(j)], [g.mx(i), g.my(j) + 9], [g.mx(i) - 8, g.my(j)]], '#7fd0ff', 'stroke="#fff" stroke-width="1.2" stroke-linejoin="round"') + pl([[g.mx(i), g.my(j) - 9], [g.mx(i) - 8, g.my(j)], [g.mx(i), g.my(j)]], '#fff', 'fill-opacity="0.55"');
  const block = (i, j) => rr(g.X(i) + 1.5, g.Y(j) + 1.5, g.c - 3, g.c - 3, 4, 'url(#steel)', 'stroke="#6c7a92"');
  let out = rr(g.x0 - 8 + 3, g.y0 - 8 + 4, g.w + 16, g.h + 16, 8, 'rgba(0,0,0,0.4)') + rr(g.x0 - 8, g.y0 - 8, g.w + 16, g.h + 16, 8, '#0e131d') + rules(g, 'rgba(255,255,255,0.1)', 1);
  out += block(2, 1) + block(4, 3) + block(0, 4) + block(5, 0) + gem(0, 0) + gem(3, 3) + gem(5, 2) + gem(1, 4);
  out += circ(g.mx(3), g.my(1), 8, '#1b1b1b', 'stroke="' + RED + '" stroke-width="2.2"') + circ(g.mx(3) - 2.5, g.my(1) - 2.5, 2, '#fff', 'fill-opacity="0.6"');
  out += ln(g.mx(1), g.my(2), g.mx(3) - 8, g.my(2), AMBER, 2.2).replace('fill="none"', 'fill="none" stroke-dasharray="1 5"') + marble(g.mx(1), g.my(2), 8.5, 'url(#ball)');
  return out;
});

// Keen: a Latin square where each cage must make its number.
add('keen', 'wood', () => {
  const g = grid(4, 4, 34, 0, 0), vals = ['2314', '4132', '1243', '3421'], hide = { '0,0': 1, '3,0': 1, '1,1': 1, '2,2': 1, '0,3': 1, '3,3': 1 };
  let out = paperGrid(g, 9);
  const cage = (a, b, c, d, label) => { const x = g.X(a) + 3, y = g.Y(b) + 3, w = (c - a + 1) * g.c - 6, h = (d - b + 1) * g.c - 6;
    return rect(x, y, w, h, 'none', 'stroke="' + INK + '" stroke-width="1.6" stroke-dasharray="3 2.4" rx="3"') + num(x + 7, y + 7, 9, INK, label); };
  out += cage(0, 0, 1, 0, '5+') + cage(2, 0, 2, 1, '3−') + cage(3, 0, 3, 1, '2×') + cage(0, 1, 0, 2, '6×') + cage(1, 1, 1, 1, '1') + cage(1, 2, 2, 2, '7+') + cage(0, 3, 1, 3, '3÷') + cage(2, 3, 3, 3, '4−') + cage(3, 2, 3, 2, '4');
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if (!hide[i + ',' + j]) out += num(g.mx(i) + 3, g.my(j) + 4, 17, INK, vals[j][i]);
  return out;
});

// Light Up: place lamps so every square is lit and no two lamps see each other.
add('lightup', 'slate', () => {
  const g = grid(5, 5, 28, 0, 0), black = { '1,0': '', '3,1': '2', '0,2': '1', '4,3': '', '2,4': '1' }, lamp = [2, 1], lampB = [0, 3];
  let out = board(g, 8);
  for (let i = 0; i < 5; i++) if (i !== 1 || true) out += cell(g, i, lamp[1], LIT);
  for (let j = 0; j < 5; j++) out += cell(g, lamp[0], j, LIT);
  out += cell(g, 0, 3, LIT) + cell(g, 1, 3, LIT);
  out += rules(g, '#b3aca0', 1) + frame(g);
  Object.keys(black).forEach((k) => { const [i, j] = k.split(',').map(Number); out += cell(g, i, j, INK) + (black[k] ? digit(g, i, j, black[k], '#fff') : ''); });
  const bulb = (i, j) => circ(g.mx(i), g.my(j), 9, 'rgba(245,158,11,0.35)') + circ(g.mx(i), g.my(j), 6.3, '#fff7d6', 'stroke="' + AMBER + '" stroke-width="2"');
  return out + bulb(lamp[0], lamp[1]) + bulb(lampB[0], lampB[1]);
});

// Loopy: one loop through the dots; each number counts the sides of its cell that the loop uses.
add('loopy', 'slate', () => {
  const g = grid(4, 4, 34, 0, 0), d = 'M' + g.X(0) + ' ' + g.Y(1) + 'V' + g.Y(0) + 'H' + g.X(2) + 'V' + g.Y(1) + 'H' + g.X(3) + 'V' + g.Y(0) + 'H' + g.X(4) + 'V' + g.Y(3) + 'H' + g.X(3) + 'V' + g.Y(4) + 'H' + g.X(1) + 'V' + g.Y(3) + 'H' + g.X(0) + 'Z';
  let out = board(g, 12), dots = '';
  for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) dots += circ(g.X(i), g.Y(j), 2.4, '#7b8499');
  out += dots + stroke(d, AMBER, 4.2) + stroke(d, '#ffd27a', 1.2, 'transform="translate(-0.6 -0.6)"');
  [[0, 0, 2], [2, 0, 3], [1, 1, 1], [3, 1, 2], [2, 2, 1], [0, 2, 3], [3, 3, 2]].forEach(([i, j, v]) => { out += digit(g, i, j, v, INK, 0.5); });
  return out;
});

// Magnets: every magnet is + and -, or neutral; the numbers count the poles in each line.
add('magnets', 'slate', () => {
  const g = grid(4, 4, 34, 0, 0);
  const mag = (a, b, c, d, kind) => {
    const x = g.X(a) + 2, y = g.Y(b) + 2, w = (c - a + 1) * g.c - 4, h = (d - b + 1) * g.c - 4, horiz = c > a;
    const half = (hx, hy, hw, hh, f, sign) => rr(hx, hy, hw, hh, 5, f) + (sign ? sign(hx + hw / 2, hy + hh / 2) : '');
    const plus = (cx, cy) => ln(cx - 6, cy, cx + 6, cy, '#fff', 3) + ln(cx, cy - 6, cx, cy + 6, '#fff', 3), minus = (cx, cy) => ln(cx - 6, cy, cx + 6, cy, '#fff', 3);
    let o = rr(x + 2, y + 3, w, h, 6, 'rgba(0,0,0,0.38)');
    if (kind === 'n') return o + rr(x, y, w, h, 6, '#6a7488') + rr(x + 3, y + 2, w - 6, 2, 1, '#fff', 'fill-opacity="0.35"');
    const [h1, h2] = horiz ? [[x, y, w / 2, h], [x + w / 2, y, w / 2, h]] : [[x, y, w, h / 2], [x, y + h / 2, w, h / 2]];
    return o + half(h1[0], h1[1], h1[2], h1[3], RED, plus) + half(h2[0], h2[1], h2[2], h2[3], BLUE, minus) + rr(x + 3, y + 2, w - 6, 2, 1, '#fff', 'fill-opacity="0.35"');
  };
  return board(g, 9, '#202b3e') + mag(0, 0, 1, 0, 'm') + mag(2, 0, 2, 1, 'm') + mag(3, 0, 3, 1, 'n') + mag(0, 1, 0, 2, 'n') + mag(1, 1, 1, 2, 'm') + mag(2, 2, 3, 2, 'm') + mag(0, 3, 1, 3, 'm') + mag(2, 3, 3, 3, 'n');
});

// Map: colour the regions with four colours so no two neighbours match.
add('map', 'wood', () => {
  const ox = 85, oy = 30, reg = [
    [[[0, 0], [60, 0], [50, 45], [0, 55]], RED], [[[60, 0], [150, 0], [150, 40], [95, 50], [50, 45]], BLUE], [[[0, 55], [50, 45], [60, 85], [0, 120]], GREEN],
    [[[50, 45], [95, 50], [100, 95], [60, 85]], AMBER], [[[95, 50], [150, 40], [150, 120], [100, 95]], RED], [[[0, 120], [60, 85], [100, 95], [150, 120]], BLUE]];
  let out = rr(ox + 3, oy + 4, 150, 120, 5, 'rgba(0,0,0,0.32)');
  out += '<clipPath id="mc"><rect x="' + ox + '" y="' + oy + '" width="150" height="120" rx="5"/></clipPath><g clip-path="url(#mc)">';
  reg.forEach(([pts, c]) => { out += pl(pts.map(([x, y]) => [ox + x, oy + y]), c, 'fill-opacity="0.85" stroke="' + INK + '" stroke-width="2.4" stroke-linejoin="round"'); });
  out += rect(ox, oy, 150, 3, '#fff', 'fill-opacity="0.35"') + '</g>' + rect(ox, oy, 150, 120, 'none', 'stroke="' + INK + '" stroke-width="2.4" rx="5"');
  return out;
});

// Mosaic: each number counts the shaded squares around it, itself included.
add('mosaic', 'wood', () => {
  const g = grid(5, 5, 28, 0, 0), shade = { '1,0': 1, '2,0': 1, '0,1': 1, '1,1': 1, '3,2': 1, '3,3': 1, '4,3': 1, '2,4': 1 }, clue = { '0,0': 3, '2,1': 4, '4,0': 0, '1,2': 3, '2,2': 5, '4,2': 2, '0,3': 1, '3,4': 3, '1,4': 2 };
  let out = board(g, 8);
  Object.keys(shade).forEach((k) => { const [i, j] = k.split(',').map(Number); out += cell(g, i, j, '#4a5876'); });
  out += rules(g, '#b3aca0', 1) + frame(g);
  Object.keys(clue).forEach((k) => { const [i, j] = k.split(',').map(Number); out += digit(g, i, j, clue[k], shade[k] ? '#fff' : INK); });
  return out;
});

// Net: turn the tiles until the wires join up to the powered centre. Net is told by a turning arrow on one tile; Netslide by a row of the
// board slid out of line, with an arrow on each end of every row and column (the wires wrap round).
const wires = (slide) => {
  const g = grid(3, 3, slide ? 38 : 48, 0, 0), masks = [[4, 6, 4], [3, 13, 4], [2, 11, 9]], lit = { '1,1': 1, '1,0': 1, '0,1': 1, '0,0': 1, '1,2': 1, '0,2': 1, '2,2': 1, '2,1': 1 };
  const arm = { 1: [0, -1], 2: [1, 0], 4: [0, 1], 8: [-1, 0] }, SHIFT = 16, SLID = 2;   // Netslide: the bottom row, slid right
  let out = board(g, slide ? 8 : 11, '#1f2b40');
  out += rect(g.x0, g.y0, g.w, g.h, '#25334d') + rules(g, 'rgba(255,255,255,0.12)', 1);
  const tileAt = (i, j, dx) => {
    const m = masks[j][i], on = lit[i + ',' + j], col = on ? AMBER : '#aab4c8', x = g.mx(i) + dx, y = g.my(j);
    let t = dx ? rect(g.X(i) + dx, g.Y(j), g.c, g.c, '#2d3d5c', 'stroke="' + AMBER + '" stroke-width="1.4"') : '';
    Object.keys(arm).forEach((b) => { if (m & b) t += ln(x, y, x + arm[b][0] * g.c / 2, y + arm[b][1] * g.c / 2, col, 5.5); });
    if (m !== 15 && [1, 2, 4, 8].includes(m)) t += rr(x - 7, y - 7, 14, 14, 3, col);
    return t;
  };
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) if (!(slide && j === SLID)) out += tileAt(i, j, 0);
  if (slide) {
    out += rect(g.x0 - 6, g.Y(SLID) + 1, g.w + 12 + SHIFT, g.c - 2, 'rgba(245,158,11,0.2)', 'stroke="' + AMBER + '" stroke-width="2"');
    for (let i = 0; i < 3; i++) out += tileAt(i, SLID, SHIFT);
  }
  out += rr(g.mx(1) - 11, g.my(1) - 11, 22, 22, 4, '#fffdf6', 'stroke="' + AMBER + '" stroke-width="3"') + circ(g.mx(1), g.my(1), 4.5, AMBER);
  if (slide) for (let k = 0; k < 3; k++) {
    const e = 13, h = 8;   // big arrows at both ends of every row and column
    out += pl([[g.mx(k) - h, g.y0 - e], [g.mx(k) + h, g.y0 - e], [g.mx(k), g.y0 - e - 12]], AMBER) + pl([[g.mx(k) - h, g.y0 + g.h + e], [g.mx(k) + h, g.y0 + g.h + e], [g.mx(k), g.y0 + g.h + e + 12]], AMBER) +
      pl([[g.x0 - e, g.my(k) - h], [g.x0 - e, g.my(k) + h], [g.x0 - e - 12, g.my(k)]], AMBER) + pl([[g.x0 + g.w + e, g.my(k) - h], [g.x0 + g.w + e, g.my(k) + h], [g.x0 + g.w + e + 12, g.my(k)]], AMBER);
  } else {   // a turning arrow around the lone grey end at the top right
    const cx = g.mx(2), cy = g.my(0);
    out += circ(cx, cy, 20, 'rgba(255,255,255,0.1)', 'stroke="#fff" stroke-width="0"') + stroke('M' + n1(cx - 16) + ' ' + n1(cy + 4) + 'A16 16 0 1 1 ' + n1(cx + 4) + ' ' + n1(cy + 16), '#fff', 3.4) + pl([[cx + 4, cy + 9], [cx + 4, cy + 23], [cx - 8, cy + 16]], '#fff');
  }
  return out;
};
add('net', 'slate', () => wires(false));
add('netslide', 'slate', () => wires(true));

// Palisade: wall the grid into regions of the size each number says.
add('palisade', 'felt', () => {
  const g = grid(5, 5, 28, 0, 0);
  let out = paperGrid(g, 8).replace(rules(g, '#b3aca0', 1), rules(g, '#c9c2ae', 1));
  [[0, 2, 2, 2], [2, 0, 2, 2], [2, 2, 2, 4], [2, 3, 5, 3], [4, 0, 4, 2], [4, 2, 5, 2], [1, 3, 1, 5], [3, 3, 3, 5]].forEach(([a, b, c, d]) => { out += wall(g, a, b, c, d, INK, 4.2); });
  [[0, 0, 4], [3, 0, 3], [2, 2, 2], [0, 4, 3], [4, 4, 2], [4, 1, 3]].forEach(([i, j, v]) => { out += digit(g, i, j, v, INK, 0.5); });
  return out;
});

// Pattern: the clues on each row and column say the runs of filled squares, and the picture appears.
add('pattern', 'wood', () => {
  const c = 24, gx = 160 - 60 + 14, gy = 90 - 60 + 14, g = { cols: 5, rows: 5, c, x0: gx, y0: gy, w: 5 * c, h: 5 * c, X: (i) => gx + i * c, Y: (j) => gy + j * c, mx: (i) => gx + (i + 0.5) * c, my: (j) => gy + (j + 0.5) * c };
  const pic = ['01110', '11111', '11111', '01110', '00100'], rowClue = ['3', '5', '5', '3', '1'], colClue = [['2'], ['4'], ['5'], ['4'], ['2']];
  let out = rr(gx - 40 + 3, gy - 30 + 4, 5 * c + 52, 5 * c + 42, 6, 'rgba(0,0,0,0.32)') + rr(gx - 40, gy - 30, 5 * c + 52, 5 * c + 42, 6, 'url(#paper)', 'stroke="' + EDGE + '"');
  pic.forEach((row, j) => row.split('').forEach((ch, i) => { if (ch === '1') out += cell(g, i, j, INK, 1); }));
  out += rules(g, '#b3aca0', 1) + frame(g, INK, 2) + '<path d="M' + g.X(0) + ' ' + g.Y(0) + 'V' + g.Y(5) + '" />';
  rowClue.forEach((s, j) => { out += num(gx - 16, g.my(j), 15, INK, s); });
  colClue.forEach((s, i) => { out += num(g.mx(i), gy - 14, 15, INK, s[0]); });
  return out;
});

// Pearl: one loop through every pearl, straight through the white ones and bending at the black ones.
add('pearl', 'felt', () => {
  const g = grid(5, 5, 28, 0, 0), d = 'M' + g.mx(1) + ' ' + g.my(1) + 'H' + g.mx(3) + 'V' + g.my(2) + 'H' + g.mx(4) + 'V' + g.my(4) + 'H' + g.mx(2) + 'V' + g.my(3) + 'H' + g.mx(1) + 'V' + g.my(1) + 'Z';
  let out = paperGrid(g, 8).replace(rules(g, '#b3aca0', 1), rules(g, '#c9c2ae', 1));
  out += stroke(d, INK, 4.2);
  const pearl = (i, j, black) => circ(g.mx(i), g.my(j), 7.6, black ? INK : '#fff', 'stroke="' + INK + '" stroke-width="2.2"') + (black ? circ(g.mx(i) - 2.4, g.my(j) - 2.6, 2, '#fff', 'fill-opacity="0.55"') : '');
  return out + pearl(1, 1, true) + pearl(3, 1, true) + pearl(2, 4, false) + pearl(4, 3, false) + pearl(3, 2, false) + pearl(1, 2, false);
});

// Pegs: jump a peg over its neighbour into a hole, and clear the board down to one.
add('pegs', 'wood', () => {
  const cx = 160, cy = 92, s = 19;
  let out = ell(cx + 4, cy + 6, 78, 76, 'rgba(0,0,0,0.35)') + circ(cx, cy, 78, '#6e4624') + circ(cx, cy, 73, '#9a6a37', 'stroke="#52331a" stroke-width="2"') + circ(cx, cy, 70, 'none', 'stroke="#d0a468" stroke-opacity="0.55" stroke-width="1.2"');
  const holes = [], full = { '3,1': 1, '2,2': 1, '3,2': 1, '4,2': 1, '1,3': 1, '2,3': 1, '4,3': 1, '5,3': 1, '2,4': 1, '3,4': 1, '4,4': 1, '3,5': 1 };
  for (let j = 0; j < 7; j++) for (let i = 0; i < 7; i++) if (!((i < 2 || i > 4) && (j < 2 || j > 4))) holes.push([i, j]);
  holes.forEach(([i, j]) => { const x = cx + (i - 3) * s, y = cy + (j - 3) * s; out += circ(x, y, 6.2, '#2e1c0d') + circ(x - 0.5, y - 0.8, 5.4, '#3d2812'); });
  holes.forEach(([i, j]) => { if (full[i + ',' + j]) { const x = cx + (i - 3) * s, y = cy + (j - 3) * s; out += marble(x, y, 6.6, i === 3 && j === 4 ? 'url(#ball)' : 'url(#ball)'); } });
  const jx = cx, jy = cy + 3 * s - 2 * s;
  void jx; void jy;
  return out + stroke('M' + (cx) + ' ' + (cy + 4 * s * 0.75) + 'Q' + (cx + 16) + ' ' + (cy + 4) + ' ' + cx + ' ' + (cy - 18), AMBER, 2.4, 'stroke-dasharray="1 5"') + pl([[cx - 5, cy - 14], [cx + 5, cy - 14], [cx, cy - 22]], AMBER);
});

// Range: shade squares so every number sees that many white squares in its row and column.
add('range', 'wood', () => {
  const g = grid(5, 5, 28, 0, 0), dark = { '1,0': 1, '3,1': 1, '0,2': 1, '4,3': 1, '2,3': 1, '1,4': 1 }, clue = { '0,0': 3, '2,0': 5, '4,1': 3, '2,2': 7, '1,3': 4, '3,4': 3, '4,0': 2 };
  let out = board(g, 8);
  Object.keys(dark).forEach((k) => { const [i, j] = k.split(',').map(Number); out += cell(g, i, j, INK); });
  out += rules(g, '#b3aca0', 1) + frame(g);
  Object.keys(clue).forEach((k) => { const [i, j] = k.split(',').map(Number); out += digit(g, i, j, clue[k], INK, 0.52); });
  return out;
});

// Rectangles: divide the grid into rectangles, each holding one number that is its area.
add('rect', 'wood', () => {
  const g = grid(5, 5, 28, 0, 0);
  let out = board(g, 8);
  [[0, 0, 1, 1, '#f3b8a8', 4], [2, 0, 4, 0, '#b9d6f2', 3], [2, 1, 4, 2, '#cfe8b3', 6], [0, 2, 1, 4, '#f6dc8e', 6], [2, 3, 4, 4, '#d9c3ec', 6]].forEach(([a, b, c, d, f, v]) => {
    out += rect(g.X(a) + 1.5, g.Y(b) + 1.5, (c - a + 1) * g.c - 3, (d - b + 1) * g.c - 3, f, 'rx="4" stroke="' + INK + '" stroke-width="2.2"') + digit(g, a, b, v, INK, 0.5);
  });
  return out + rules(g, 'rgba(43,53,80,0.18)', 1);
});

// Same Game: clear groups of matching blocks; bigger groups score more.
add('samegame', 'slate', () => {
  const g = grid(6, 5, 26, 0, 0), m = ['012200', '011210', '111221', '100222', '011202'], col = [RED, BLUE, GREEN];
  let out = rr(g.x0 - 8 + 3, g.y0 - 8 + 4, g.w + 16, g.h + 16, 8, 'rgba(0,0,0,0.4)') + rr(g.x0 - 8, g.y0 - 8, g.w + 16, g.h + 16, 8, '#0e131d');
  m.forEach((row, j) => row.split('').forEach((ch, i) => { out += rr(g.X(i) + 1.5, g.Y(j) + 1.5, g.c - 3, g.c - 3, 5, col[+ch]) + rr(g.X(i) + 3.5, g.Y(j) + 2.5, g.c - 7, 3, 1.5, '#fff', 'fill-opacity="0.4"'); }));
  // the group under the finger: the blue squares joined to (1, 1)
  const sel = [[1, 1], [2, 1], [1, 2], [0, 2], [1, 3], [0, 4]];
  return out + sel.map(([i, j]) => rect(g.X(i) + 1, g.Y(j) + 1, g.c - 2, g.c - 2, 'none', 'stroke="#fff" stroke-width="2.2" rx="5"')).join('');
});

// Signpost: a chain of arrows numbered from 1 to the last square.
add('signpost', 'slate', () => {
  const g = grid(4, 4, 34, 0, 0), rot = [90, 135, 180, 270, 0, 45, 225, 315, 90, 0, 180, 135, 45, 270, 0, 90], tone = ['#f3b8a8', '#b9d6f2', '#cfe8b3', '#f6dc8e'];
  let out = board(g, 9), n = 0;
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    const k = j * 4 + i, end = k === 0 || k === 15;
    out += cell(g, i, j, end ? '#c9e8c0' : tone[(i + j * 3) % 4], 1.5, 'fill-opacity="' + (end ? 1 : 0.55) + '"');
    out += at(g.mx(i), g.my(j) + 3, rot[k], pl([[0, -11], [7, -2], [2.6, -2], [2.6, 8], [-2.6, 8], [-2.6, -2], [-7, -2]], INK));
    if (end) out += num(g.X(i) + 8, g.Y(j) + 8, 10, INK, k === 0 ? '1' : '16');
    n++;
  }
  return out + rules(g, '#b3aca0', 1) + frame(g);
});
function at(x, y, rot, inner) { return grp('transform="translate(' + n1(x) + ' ' + n1(y) + ')' + (rot ? ' rotate(' + rot + ')' : '') + '"', inner); }

// Singles: shade squares so no number repeats in a row or column, and the white squares stay joined.
add('singles', 'wood', () => {
  const g = grid(5, 5, 28, 0, 0), dark = { '1,0': 1, '3,0': 1, '0,2': 1, '2,3': 1, '4,2': 1, '3,4': 1 }, v = ['34524', '12433', '52141', '41325', '23514'];
  let out = board(g, 8);
  Object.keys(dark).forEach((k) => { const [i, j] = k.split(',').map(Number); out += cell(g, i, j, INK); });
  out += rules(g, '#b3aca0', 1) + frame(g);
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) out += digit(g, i, j, v[j][i], dark[i + ',' + j] ? '#8f9bb4' : INK, 0.5);
  return out + circ(g.mx(2), g.my(1), 10.5, 'none', 'stroke="' + AMBER + '" stroke-width="2.2"') + circ(g.mx(0), g.my(4), 10.5, 'none', 'stroke="' + AMBER + '" stroke-width="2.2"');
});

// Slant: a diagonal in every square; each number counts the lines that touch its corner.
add('slant', 'slate', () => {
  const g = grid(5, 5, 28, 0, 0), slash = '10110010011100110101001101'.slice(0, 25);
  let out = paperGrid(g, 8).replace(rules(g, '#b3aca0', 1), rules(g, '#d9d2bf', 1));
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) out += slash[j * 5 + i] === '1' ? ln(g.X(i) + 4, g.Y(j) + g.c - 4, g.X(i) + g.c - 4, g.Y(j) + 4, INK, 3.6) : ln(g.X(i) + 4, g.Y(j) + 4, g.X(i) + g.c - 4, g.Y(j) + g.c - 4, INK, 3.6);
  [[1, 1, 2], [3, 1, 1], [2, 2, 4], [4, 3, 0], [1, 4, 3], [3, 4, 2]].forEach(([i, j, v]) => { out += circ(g.X(i), g.Y(j), 7.5, '#fff', 'stroke="' + INK + '" stroke-width="1.8"') + num(g.X(i), g.Y(j), 10.5, INK, v); });
  return out;
});

// Tents: a tent beside every tree, no two tents touching; the numbers count tents in a line.
add('tents', 'felt', () => {
  const g = grid(5, 5, 26, 0, 0);
  let out = board(g, 22, '#e9f1dc') + rules(g, '#9bb98a', 1) + frame(g, '#355b3a', 2);
  const tree = (i, j) => rr(g.mx(i) - 2, g.my(j) + 3, 4, 8, 1, '#6b4a2a') + circ(g.mx(i), g.my(j) - 2, 9.5, '#2f8f4a') + circ(g.mx(i) - 3, g.my(j) - 5, 3.4, '#6fc27d', 'fill-opacity="0.7"');
  const tent = (i, j) => pl([[g.mx(i), g.my(j) - 10], [g.mx(i) + 11, g.my(j) + 9], [g.mx(i) - 11, g.my(j) + 9]], AMBER, 'stroke="#a05a06" stroke-width="1.6" stroke-linejoin="round"') + pl([[g.mx(i), g.my(j) - 10], [g.mx(i) + 3, g.my(j) + 9], [g.mx(i) - 3, g.my(j) + 9]], '#7a4a08');
  out += tree(0, 0) + tent(1, 0) + tree(3, 1) + tent(3, 2) + tree(0, 3) + tent(0, 4) + tree(4, 4) + tent(3, 4) + tree(2, 2);
  [1, 1, 1, 1, 1].forEach((v, k) => { out += num(g.mx(k), g.y0 - 11, 13, INK, [1, 0, 1, 2, 1][k]) ; });
  [1, 1, 1, 1, 1].forEach((v, k) => { out += num(g.x0 + g.w + 11, g.my(k), 13, INK, [1, 1, 1, 1, 1][k]); });
  return out;
});

// Towers: place a tower of every height in each row and column; the edge numbers say how many you can see.
add('towers', 'wood', () => {
  const g = grid(4, 4, 34, 0, 6), h = ['2314', '3142', '1423', '4231'];
  let out = board(g, 16) + rules(g, '#cfc8b4', 1);
  const tw = (i, j, v) => { const x = g.X(i) + 6, y = g.Y(j) + g.c - 5, w = 20, hh = v * 6 + 3, d = 6;
    return rect(x, y - hh, w, hh, ['#b9c7dc', '#9fb1cc', '#8497b6', '#6a7fa3'][v - 1], 'stroke="' + INK + '" stroke-width="1"') + pl([[x, y - hh], [x + d, y - hh - d], [x + w + d, y - hh - d], [x + w, y - hh]], '#e6edf8', 'stroke="' + INK + '" stroke-width="1"') + pl([[x + w, y - hh], [x + w + d, y - hh - d], [x + w + d, y - d], [x + w, y]], '#5d7094', 'stroke="' + INK + '" stroke-width="1"'); };
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if ((i + j) % 2 === 0) out += tw(i, j, +h[j][i]);
  [2, 3, 1, 2].forEach((v, k) => { out += num(g.mx(k), g.y0 - 7, 12, INK, v); });
  [1, 2, 3, 2].forEach((v, k) => { out += num(g.x0 - 8, g.my(k), 12, INK, v); });
  return out;
});

// Tracks: lay one railway from the entrance to the exit; the numbers count the squares of track in each line.
add('tracks', 'felt', () => {
  const g = grid(4, 4, 32, 0, 4), pts = [[0, 1], [1, 1], [1, 2], [2, 2], [2, 1], [3, 1], [3, 3]];
  let out = board(g, 20, '#eef2e4') + rules(g, '#b9c4a6', 1);
  const d = 'M' + (g.x0 - 8) + ' ' + g.my(1) + pts.map(([i, j]) => 'L' + g.mx(i) + ' ' + g.my(j)).join('') + 'L' + g.mx(3) + ' ' + (g.y0 + g.h + 8);
  out += stroke(d, '#7a5530', 14, 'stroke-dasharray="2.4 5.4" stroke-linecap="butt" stroke-linejoin="miter"') + stroke(d, '#7f8aa0', 8) + stroke(d, '#eef2e4', 4.6);
  [1, 2, 2, 2].forEach((v, k) => { out += num(g.mx(k), g.y0 - 10, 12, INK, v); });
  return out;
});

// Twiddle: rotate a block of tiles to put the numbers in order.
add('twiddle', 'felt', () => slider('turn'));

// Undead: the ghosts, vampires and zombies in the grid; the numbers count what you can see along each line, mirrors included.
add('undead', 'felt', () => {
  const g = grid(4, 4, 34, 0, 0);
  const ghost = (x, y) => path_('M' + (x - 9) + ' ' + (y + 10) + 'V' + (y - 2) + 'A9 10 0 0 1 ' + (x + 9) + ' ' + (y - 2) + 'V' + (y + 10) + 'L' + (x + 4.5) + ' ' + (y + 6) + 'L' + x + ' ' + (y + 10) + 'L' + (x - 4.5) + ' ' + (y + 6) + 'Z', '#fff', 'stroke="' + INK + '" stroke-width="1.6" stroke-linejoin="round"') + circ(x - 3.4, y - 2, 1.8, INK) + circ(x + 3.4, y - 2, 1.8, INK);
  const zombie = (x, y) => circ(x, y, 10, '#7fc267', 'stroke="' + INK + '" stroke-width="1.6"') + circ(x - 3.6, y - 2, 2.2, '#fff', 'stroke="' + INK + '"') + circ(x + 3.6, y - 2, 2.2, '#fff', 'stroke="' + INK + '"') + ln(x - 4, y + 5, x + 4, y + 5, INK, 1.8);
  const vamp = (x, y) => circ(x, y, 10, '#e0a0a0', 'stroke="' + INK + '" stroke-width="1.6"') + pl([[x - 9, y - 4], [x, y - 12], [x + 9, y - 4], [x, y - 7]], INK) + ln(x - 4, y + 4, x + 4, y + 4, INK, 1.8) + pl([[x - 4, y + 4], [x - 2, y + 4], [x - 3, y + 9]], '#fff') + pl([[x + 4, y + 4], [x + 2, y + 4], [x + 3, y + 9]], '#fff');
  let out = paperGrid(g, 10);
  out += ln(g.X(0) + 5, g.Y(2) - 5, g.X(2) - 5, g.Y(0) + 5, '#6fa0d6', 3).replace('fill="none"', 'fill="none" opacity="0.9"') + ln(g.X(0) + 4, g.Y(2) - 4, g.X(2) - 4, g.Y(0) + 4, '#fff', 1);
  out += ghost(g.mx(1), g.my(0)) + zombie(g.mx(3), g.my(1)) + vamp(g.mx(0), g.my(2)) + ghost(g.mx(2), g.my(3)) + zombie(g.mx(1), g.my(2));
  [2, 1, 0, 2].forEach((v, k) => { out += num(g.mx(k), g.y0 - 8, 11, INK, v); });
  return out;
});

// Unequal: fill the grid with each number once per line, obeying the greater-than signs between squares.
add('unequal', 'wood', () => {
  const g = grid(4, 4, 36, 0, 0), vals = { '1,0': 3, '2,1': 1, '0,2': 4, '3,3': 2 };
  let out = paperGrid(g, 10);
  const lt = (x, y, dir) => stroke('M' + n1(x - 3 * dir) + ' ' + n1(y - 6) + 'L' + n1(x + 3 * dir) + ' ' + n1(y) + 'L' + n1(x - 3 * dir) + ' ' + n1(y + 6), AMBER, 2.8);
  const ltv = (x, y, dir) => stroke('M' + n1(x - 6) + ' ' + n1(y - 3 * dir) + 'L' + n1(x) + ' ' + n1(y + 3 * dir) + 'L' + n1(x + 6) + ' ' + n1(y - 3 * dir), AMBER, 2.8);
  out += lt(g.X(1), g.my(0), 1) + lt(g.X(3), g.my(1), -1) + lt(g.X(2), g.my(2), 1) + lt(g.X(1), g.my(3), -1) + ltv(g.mx(0), g.Y(1), 1) + ltv(g.mx(2), g.Y(2), -1) + ltv(g.mx(3), g.Y(3), 1) + ltv(g.mx(1), g.Y(2), 1);
  Object.keys(vals).forEach((k) => { const [i, j] = k.split(',').map(Number); out += digit(g, i, j, vals[k], INK, 0.55); });
  return out;
});

// Unruly: fill the grid with black and white, never three alike in a row, and each line balanced.
add('unruly', 'slate', () => {
  const g = grid(6, 6, 24, 0, 0), m = ['101100', '011010', '100101', '010011', '101010', '010101'];
  let out = rr(g.x0 - 8 + 3, g.y0 - 8 + 4, g.w + 16, g.h + 16, 8, 'rgba(0,0,0,0.4)') + rr(g.x0 - 8, g.y0 - 8, g.w + 16, g.h + 16, 8, '#0e131d');
  m.forEach((row, j) => row.split('').forEach((ch, i) => {
    const black = ch === '1';
    out += rr(g.X(i) + 1.5, g.Y(j) + 1.5, g.c - 3, g.c - 3, 4.5, black ? '#3b4a68' : '#fffdf6') + rr(g.X(i) + 3.5, g.Y(j) + 2.6, g.c - 7, 2.2, 1, '#fff', 'fill-opacity="' + (black ? 0.18 : 0.8) + '"');
  }));
  return out + rr(g.X(0) + 0.5, g.Y(0) + 0.5, g.c - 1, g.c - 1, 5, 'none', 'stroke="' + RED + '" stroke-width="2.2"');
});

// Untangle: drag the points until no two lines cross.
add('untangle', 'slate', () => {
  const P = [[110, 40], [215, 52], [250, 112], [190, 146], [100, 132], [158, 88], [72, 84]];
  const E = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 6], [6, 0], [0, 5], [5, 2], [5, 3], [1, 5], [5, 4]];
  let out = rr(40 + 3, 14 + 4, 240, 152, 8, 'rgba(0,0,0,0.35)') + rr(40, 14, 240, 152, 8, 'url(#paper)', 'stroke="' + EDGE + '"');
  E.forEach(([a, b]) => { out += ln(P[a][0], P[a][1], P[b][0], P[b][1], INK, 2.2); });
  out += ln(P[1][0], P[1][1], P[5][0], P[5][1], RED, 2.6);
  return out + P.map(([x, y], k) => circ(x + 1.5, y + 2.5, 9, 'rgba(0,0,0,0.25)') + circ(x, y, 9, k === 5 ? AMBER : '#fff', 'stroke="' + INK + '" stroke-width="2.2"')).join('');
});

module.exports = { ART, BG };
