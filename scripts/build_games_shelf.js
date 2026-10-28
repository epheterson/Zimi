#!/usr/bin/env node
// Redraws the card-game tiles and the header lockup of ZimiGames' shelf
// (zimi/builtin/games/index.html) from the deck itself, as static inline SVG,
// so the shelf stays plain HTML for Kiwix and cannot drift from the cards.
//
//   node scripts/build_games_shelf.js          rewrite index.html in place
//
// Only each listed card tile's `ar-game-art` svg, the lockup and one hidden
// sprite (suits, gradients, the card clip) are touched; the rest is left as is.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
const file = path.join(dir, 'index.html');

// The deck, loaded the way the tests load it; ensureSprite is asked for its sprite.
let sprite = '';
const doc = {
  getElementById: () => null,
  createElement: () => ({ set innerHTML(v) { sprite = v; }, get firstChild() { return {}; } }),
  body: { insertBefore() {} },
  addEventListener() {}, querySelector: () => null, documentElement: { classList: { toggle() {} } }, hidden: false
};
const sandbox = { console, Date, setTimeout, clearTimeout, setInterval, clearInterval, document: doc };
sandbox.window = sandbox;
vm.createContext(sandbox);
// cardbacks.js draws the backs, courts.js, courts-es.js and hanafuda-art.js the court and flower cards, and cards.js asks them for both, so they load first.
for (const name of ['text.js', 'cardbacks.js', 'courts.js', 'courts-es.js', 'hanafuda-art.js', 'cards.js']) vm.runInContext(fs.readFileSync(path.join(dir, name), 'utf8'), sandbox, { filename: name });
const Z = sandbox.ZimiCards;
Z.ensureSprite();

const CARD_W = 100, CARD_H = 140, CARD_R = 7.5;
const CREAM = '#fdfcf8', EDGE = '#c9c4b8', RED = '#b3261e', BLACK = '#1b1b1b';
const FELT = '#285c43', FELT_DEEP = '#1a4130';
const CLIP = 'zs-card';

// 'KS' is the king of spades, 'TH' the ten of hearts, 'AC' the ace of clubs.
const RANKS = 'A23456789TJQK', SUITS = 'CDHS';
const cid = (s) => Z.make(RANKS.indexOf(s[0]) + 1, SUITS.indexOf(s[1]));

const num = (n) => String(Math.round(n * 100) / 100);
const place = (x, y, rot, w) => 'translate(' + num(x) + ' ' + num(y) + ')' + (rot ? ' rotate(' + rot + ')' : '') + ' scale(' + num(w / CARD_W) + ')';
// A card's art is drawn once, as a <symbol> in the sprite, and every tile that shows it <use>s it: the same court card
// sits in many tiles, and inline each copy was 15-22 KB.
const symbols = new Map();
const BIG_ART = 2000;
const hashId = (svg) => 'zs-art-' + crypto.createHash('md5').update(svg).digest('hex').slice(0, 10);
// A court figure nested in a card is the same drawing on more than one card (and in more than one sort of card): it too is a symbol of its own.
const figured = (svg) => svg.replace(/<svg ([^>]*?)x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" ([^>]*)>((?:(?!<svg)[\s\S])*?)<\/svg>/g, (all, a, x, y, w, h, rest, body) => {
  if (all.length < BIG_ART) return all;
  const sym = '<svg ' + a + rest + '>' + body + '</svg>';
  if (!symbols.has(sym)) symbols.set(sym, hashId(sym));
  return '<use href="#' + symbols.get(sym) + '" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '"/>';
});
function sized(svg) {
  svg = figured(svg);
  let id = symbols.get(svg);
  if (!id) {
    id = hashId(svg);
    symbols.set(svg, id);
  }
  return '<use href="#' + id + '" width="' + CARD_W + '" height="' + CARD_H + '"/>';
}
const symbolDefs = () => [...symbols].map(([svg, id]) => svg.replace(/^<svg /, '<symbol id="' + id + '" ').replace(/<\/svg>$/, '</symbol>')).join('');

// One face-up card at (x, y), `w` wide, turned `rot` degrees about its corner.
function face(id, x, y, w, rot) {
  const colour = Z.isRed(id) ? RED : BLACK;
  return '<g transform="' + place(x, y, rot, w) + '" style="color:' + colour + '"><rect y="1.6" width="100" height="140" rx="' + CARD_R + '" fill="rgba(0,0,0,0.32)"/>' +
    '<rect width="100" height="140" rx="' + CARD_R + '" fill="' + CREAM + '" stroke="' + EDGE + '"/>' + sized(Z.faceMarkup(id, false)) + '</g>';
}
function italian(id, x, y, w, rot) {
  return '<g transform="' + place(x, y, rot, w) + '"><rect y="1.6" width="100" height="140" rx="' + CARD_R + '" fill="rgba(0,0,0,0.32)"/>' +
    '<rect width="100" height="140" rx="' + CARD_R + '" fill="' + CREAM + '" stroke="' + EDGE + '"/>' + sized(Z.italianFaceMarkup(id, false)) + '</g>';
}
function spanish(id, x, y, w, rot) {
  return '<g transform="' + place(x, y, rot, w) + '"><rect y="1.6" width="100" height="140" rx="' + CARD_R + '" fill="' + CREAM + '" stroke="' + EDGE + '"/>' + sized(Z.spanishFaceMarkup(id, false)) + '</g>';
}
function hanafuda(id, x, y, w, rot) {
  return '<g transform="' + place(x, y, rot, w) + '"><rect y="1.6" width="100" height="140" rx="' + CARD_R + '" fill="rgba(0,0,0,0.32)"/>' +
    '<rect width="100" height="140" rx="' + CARD_R + '" fill="' + CREAM + '" stroke="' + EDGE + '"/>' + sized(Z.hanafudaFaceMarkup(id, false)) + '</g>';
}
// A face-down card with the Zimi back.
function back(x, y, w, rot) {
  return '<g transform="' + place(x, y, rot, w) + '"><rect y="1.6" width="100" height="140" rx="' + CARD_R + '" fill="rgba(0,0,0,0.32)"/>' +
    '<g clip-path="url(#' + CLIP + ')">' + sized(Z.backMarkup('zimi').replace(' class="zc-bk"', '')) + '</g></g>';
}
// The edge of a card lying under another.
function edge(x, y, w) {
  return '<g transform="' + place(x, y, 0, w) + '"><rect width="100" height="140" rx="' + CARD_R + '" fill="' + CREAM + '" stroke="' + EDGE + '"/></g>';
}
// An empty slot's outline.
function slot(x, y, w) {
  return '<g transform="' + place(x, y, 0, w) + '"><rect x="1" y="1" width="98" height="138" rx="' + CARD_R + '" fill="rgba(0,0,0,0.12)" stroke="rgba(255,255,255,0.35)" stroke-width="3"/></g>';
}
const tile = (felt, inner) => '<svg class="ar-game-art" viewBox="0 0 320 180" aria-hidden="true">\n        <rect width="320" height="180" fill="' + felt + '"/>\n        ' + inner + '\n      </svg>';

const TILES = {
  solitaire: () => tile(FELT, face(cid('KS'), 70, 38, 76, -14) + face(cid('QH'), 122, 34, 76, 0) + face(cid('JC'), 176, 38, 76, 14)),
  freecell: () => tile(FELT_DEEP, slot(24, 22, 56) + slot(92, 22, 56) + face(cid('AD'), 172, 22, 56) + face(cid('AS'), 240, 22, 56) +
    [[52, ['9C', '8H']], [138, ['KS', 'QH', 'JC']], [224, ['7D', '6S']]].map(([x, col]) =>
      col.map((c, i) => face(cid(c), x, 106 + i * 18, 44)).join('')).join('')),
  spider: () => tile(FELT, ['KS', 'QS', 'JS', 'TS', '9S'].map((c, k) => face(cid(c), 56 + 24 * k, 24 + 18 * k, 56)).join('') +
    [214, 223, 232].map((x) => edge(x, 104, 40)).join('') + face(cid('AS'), 241, 104, 40)),
  hearts: () => tile(FELT_DEEP, back(20, 30, 40) + back(140, -30, 40) + back(260, 30, 40) + face(cid('QS'), 100, 48, 58, -8) + face(cid('AH'), 160, 44, 58, 8)),
  pyramid: () => {
    const rows = [['KS'], ['QH', '6C'], ['7S', 'AD', 'KD'], ['AC', '6H', 'QD', '7C']];
    let out = '';
    rows.forEach((r, i) => r.forEach((c, j) => { out += face(cid(c), 138 - 22 * i + 44 * j, 22 + 34 * i, 40); }));
    return tile(FELT, out);
  },
  golf: () => {
    const cols = [['2C', '2H', '7S'], ['8H', '8S', '3D'], ['4S', '4D', 'JC'], ['KD', 'KC', '9C'], ['6C', '6S', '5H']];
    let out = '';
    cols.forEach((col, i) => col.forEach((c, j) => { out += face(cid(c), 28 + 54 * i, 18 + 16 * j, 46); }));
    return tile(FELT_DEEP, out + back(110, 112, 46) + face(cid('8D'), 166, 112, 46));
  },
  tripeaks: () => {
    let out = '';
    [53, 149, 245].forEach((x) => { out += back(x, 22, 22) + back(x - 12, 44, 22) + back(x + 12, 44, 22); });
    ['4C', '5D', '6S', '7D', '8C', '9D', 'TS', 'JH', 'QC'].forEach((c, k) => { out += face(cid(c), 30 + 30 * k, 74, 28); });
    out += back(120, 128, 30) + face(cid('7H'), 158, 128, 30) +
      '<circle cx="270" cy="150" r="16" fill="#d97706"/><text x="270" y="156" font-size="15" font-weight="800" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif">x5</text>';
    return tile(FELT, out);
  }
};
// The non-card tiles that were redrawn (scripts/games_tile_art.js): each one's art is scoped so its gradient ids stay its own on the shared page.
const TILE_ART = require('./games_tile_art.js');
const TILE_BASE = { whereintheworld: '#8f6538', wikirace: '#161d2b', telephone: '#bd9c68', bluff: '#8f6538', firstlines: '#8f6538', quizzical: '#161d2b', higherlower: '#161d2b', minesweeper: '#161d2b', paddles: '#121620', fleet: '#123d63', mahjong4: '#17382a', droppin: '#8f6538', lander: '#05070f', babel: '#f6d398', sudoku: '#8f6538', snake: '#0f2417', fiveletters: '#161d2b', t2048: '#bcc5d3', bricks: '#121824', memory: '#141b29' };
// An id may not start with a digit, so 2048's art is keyed t2048 and goes on the 2048 tile.
const TILE_GAME = { t2048: '2048' };
Object.keys(TILE_ART.ART).forEach((name) => { TILES[TILE_GAME[name] || name] = () => tile(TILE_BASE[name], TILE_ART.scoped(name, TILE_ART.ART[name]())); });
// The Logic puzzles family (Simon Tatham's collection): 38 tiles, drawn in scripts/games_tile_art_puzzles.js, keyed by their page 'puzzles/<name>'.
// Mines, Solo and Guess are not here: they are Minesweeper, Sudoku and Code Breaker, which are on the shelf.
const PUZ = require('./games_tile_art_puzzles.js');
const PUZZLE_ORDER = ['net', 'netslide', 'bridges', 'loopy', 'pearl', 'slant', 'signpost', 'tracks', 'untangle', 'pattern', 'mosaic', 'lightup', 'tents', 'magnets', 'dominosa', 'map', 'keen', 'towers', 'unequal', 'filling', 'range', 'singles', 'unruly', 'group', 'undead', 'galaxies', 'rect', 'palisade', 'blackbox', 'fifteen', 'sixteen', 'twiddle', 'cube', 'inertia', 'pegs', 'samegame', 'flood', 'flip'];
Object.keys(PUZ.ART).forEach((n) => { TILES['puzzles/' + n] = () => tile(PUZ.BG[n], TILE_ART.scoped('pz-' + n, PUZ.ART[n]())); });
// The world card games. Their art carries numbers only, never a word: the shelf is read in ten languages.
const pill = (x, y, w, label) => '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="22" rx="11" fill="rgba(0,0,0,0.3)"/><text x="' + (x + w / 2) + '" y="' + (y + 16) + '" font-size="15" font-weight="700" text-anchor="middle" fill="rgba(255,255,255,0.85)" font-family="ui-monospace,Menlo,monospace">' + label + '</text>';
function cribBoard() {
  const groups = (x0, n) => Array.from({ length: n }, (_, k) => x0 + 12 * k);
  const top = [].concat(groups(40, 5), groups(106, 5), groups(172, 5), groups(238, 4)), low = [].concat(groups(40, 5), groups(106, 5), groups(172, 5));
  const holes = (xs, y) => xs.map((x) => '<circle cx="' + x + '" cy="' + y + '" r="1.8"/>').join('');
  return '<rect x="24" y="22" width="272" height="64" rx="9" fill="#8a5a2e" stroke="#5e3b1a"/><g fill="rgba(30,16,4,0.7)">' + holes(top, 38) + holes(top, 50) + holes(low, 66) + holes(low, 78) + '</g>' +
    '<circle cx="196" cy="38" r="4.4" fill="#f59e0b" stroke="#fff" stroke-width="1.2"/><circle cx="172" cy="38" r="3.2" fill="#f59e0b" stroke="#000" stroke-opacity=".5"/>' +
    '<circle cx="130" cy="50" r="4.4" fill="#38bdf8" stroke="#fff" stroke-width="1.2"/><circle cx="106" cy="50" r="3.2" fill="#38bdf8" stroke="#000" stroke-opacity=".5"/>';
}
Object.assign(TILES, {
  spades: () => tile(FELT_DEEP, face(cid('KS'), 78, 40, 62, -12) + face(cid('AS'), 130, 32, 62) + face(cid('QS'), 182, 40, 62, 12) + pill(136, 142, 48, '500')),
  euchre: () => tile(FELT_DEEP, face(cid('JD'), 66, 34, 72, -12) + face(cid('JH'), 124, 30, 72) + face(cid('AH'), 182, 34, 72, 12)),
  gin: () => tile(FELT, face(cid('5H'), 54, 40, 58, -10) + face(cid('6H'), 100, 34, 58) + face(cid('7H'), 146, 36, 58, 10) + face(cid('KS'), 236, 52, 46, 6) +
    pill(136, 142, 48, '0')),
  cribbage: () => tile(FELT_DEEP, cribBoard() + face(cid('5H'), 70, 102, 52) + face(cid('JS'), 134, 102, 52) + face(cid('5D'), 198, 102, 52) +
    '<text x="272" y="150" font-size="30" font-weight="700" text-anchor="middle" fill="rgba(255,255,255,0.85)" font-family="ui-monospace,Menlo,monospace">29</text>'),
  crazyeights: () => tile(FELT, back(28, 48, 56) + face(cid('8S'), 112, 32, 76, -8) + face(cid('8H'), 176, 34, 76, 8) +
    [[1, 56], [0, 92]].map((p) => '<g transform="translate(270 ' + p[1] + ') scale(1.2)" fill="rgba(255,255,255,0.85)"><use href="#zc-s-' + p[0] + '"/></g>').join('')),
  durak: () => tile(FELT_DEEP, back(96, -34, 40) + back(142, -34, 40) + back(188, -34, 40) + face(cid('7C'), 112, 44, 58) + face(cid('9S'), 132, 58, 58, 8) + face(cid('AH'), 26, 92, 46) + back(46, 92, 46)),
  bridge: () => tile(FELT_DEEP, back(92, -34, 40) + back(140, -34, 40) + back(188, -34, 40) +
    [['AS', 82, 104, -12], ['KS', 112, 98, -4], ['QH', 150, 98, 4], ['JD', 180, 104, 12]].map(([c, x, y, r]) => face(cid(c), x, y, 56, r)).join('')),
  scopa: () => tile(FELT, italian(0, 56, 34, 64, -12) + italian(19, 128, 28, 64) + italian(26, 200, 34, 64, 12)),
  belote: () => tile(FELT_DEEP, face(cid('JS'), 70, 34, 70, -12) + face(cid('9S'), 126, 30, 70) + face(cid('AS'), 182, 34, 70, 12)),
  skat: () => tile(FELT_DEEP, face(cid('JC'), 66, 34, 66, -14) + face(cid('JS'), 112, 30, 66, -5) + face(cid('JH'), 158, 30, 66, 5) + face(cid('JD'), 204, 34, 66, 14)),
  truco: () => tile(FELT, spanish(20, 66, 34, 66, -12) + spanish(30, 126, 28, 66) + spanish(26, 186, 34, 66, 12)),
  koikoi: () => tile(FELT_DEEP, hanafuda(0, 62, 34, 62, -12) + hanafuda(8, 129, 28, 62) + hanafuda(28, 196, 34, 62, 12)),
  bigtwo: () => tile(FELT, face(cid('2S'), 76, 36, 70, -12) + face(cid('2H'), 126, 30, 70) + face(cid('AS'), 176, 36, 70, 12)),
  tienlen: () => tile(FELT_DEEP, face(cid('2S'), 76, 36, 70, -12) + face(cid('2C'), 126, 30, 70) + face(cid('2D'), 176, 36, 70, 12)),
  canasta: () => tile(FELT, face(cid('7C'), 66, 34, 66, -12) + face(cid('7D'), 112, 30, 66, -4) + face(cid('7H'), 158, 30, 66, 4) + face(cid('2S'), 204, 34, 66, 12)),
  holdem: () => tile(FELT_DEEP, ['QH', 'JH', 'TH', '2C', '7D'].map((c, k) => face(cid(c), 52 + 44 * k, 24, 40)).join('') + face(cid('AS'), 118, 78, 46, -8) + face(cid('KS'), 160, 78, 46, 8)),
  blackjack: () => tile(FELT, face(cid('AS'), 98, 34, 72, -8) + face(cid('KH'), 150, 30, 72, 8) + pill(124, 142, 72, '21')),
  teenpatti: () => tile(FELT_DEEP, face(cid('AS'), 76, 36, 70, -12) + face(cid('AD'), 126, 30, 70) + face(cid('AH'), 176, 36, 70, 12))
});

// ── Write ──────────────────────────────────────────────────────────────────
let html = fs.readFileSync(file, 'utf8');

// The header: the ZimiGames icon (icon.svg, from scripts/icons) then the name as text in the page's own heading face (selectable, translatable).
const brand = '<h1 class="ar-brand"><img class="ar-lockup" src="icon.svg" alt="" width="40" height="40"><span>ZimiGames</span></h1>';
html = html.replace(/<h1 class="ar-brand">[\s\S]*?<\/h1>/, () => brand);

// The family's tiles: the names and blurbs are the string table's English (text/en.json), so the shelf and every language agree.
{
  const en = JSON.parse(fs.readFileSync(path.join(dir, 'text', 'en.json'), 'utf8'));
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const tiles = PUZZLE_ORDER.map((n) => '    <a class="ar-game" href="puzzles/' + n + '.html">\n      <svg class="ar-game-art" viewBox="0 0 320 180" aria-hidden="true"></svg>\n' +
    '      <span class="ar-game-text"><strong>' + esc(en['game.puzzles.' + n + '.title']) + '</strong><span>' + esc(en['game.puzzles.' + n + '.blurb'] || en['game.puzzles.' + n + '.tile']) + '</span></span>\n    </a>').join('\n');
  const family = '<!-- zimi-shelf:puzzles -->\n    <div class="ar-family" data-name="' + esc(en['shelf.family.logicpuzzles.name']) + '" data-line="' + esc(en['shelf.family.logicpuzzles.line']) + '">\n' + tiles + '\n    </div>\n    <!-- /zimi-shelf:puzzles -->';
  // games.json carries the English blurb and why of each puzzle too (Discover's card, the About page): kept equal to the table's.
  const gj = path.join(dir, 'games.json'), rows = JSON.parse(fs.readFileSync(gj, 'utf8'));
  rows.forEach((r) => {
    const m = /^puzzles\/([a-z0-9]+)\.html$/.exec(r.path);
    if (!m) return;
    r.blurb = en['game.puzzles.' + m[1] + '.blurb'] || en['game.puzzles.' + m[1] + '.tile'] || r.blurb;
    r.why = en['game.puzzles.' + m[1] + '.why'] || r.why;
  });
  fs.writeFileSync(gj, JSON.stringify(rows, null, 1) + '\n');
  html = html.replace(/<!-- zimi-shelf:puzzles -->[\s\S]*?<!-- \/zimi-shelf:puzzles -->/, () => family);
}
let redrawn = [];
// The art runs to the tile's text: a redrawn tile holds card svgs of its own,
// so stopping at the first </svg> would leave the rest behind on a second run.
html = html.replace(/(<a class="ar-game" href="((?:puzzles\/)?[a-z0-9]+)\.html">\s*)<svg class="ar-game-art"[\s\S]*?(\s*<span class="ar-game-text">)/g, (all, head, name, text) => {
  if (!TILES[name]) return all;
  redrawn.push(name);
  return head + TILES[name]() + text;
});
// The sprite goes last: it holds the symbols the tiles above asked for.
const spriteSvg = sprite.replace('</defs>', symbolDefs() + '<clipPath id="' + CLIP + '"><rect width="100" height="140" rx="' + CARD_R + '"/></clipPath></defs>');
html = /<!-- zimi-shelf:sprite -->[\s\S]*?<!-- \/zimi-shelf:sprite -->/.test(html)
  ? html.replace(/<!-- zimi-shelf:sprite -->[\s\S]*?<!-- \/zimi-shelf:sprite -->/, () => '<!-- zimi-shelf:sprite -->' + spriteSvg + '<!-- /zimi-shelf:sprite -->')
  : html.replace('<main class="ar-shelf">', () => '<!-- zimi-shelf:sprite -->' + spriteSvg + '<!-- /zimi-shelf:sprite -->\n<main class="ar-shelf">');

fs.writeFileSync(file, html);
console.log('redrawn: ' + redrawn.join(', '));

// ── Thumbnails ─────────────────────────────────────────────────────────────
// Each tile's art again as a standalone svg (thumbs/<game>.svg, 320x180): what
// Zimi's Discover card loads for the day's game, a small file inside the ZIM
// that needs nothing else. Whatever a tile points at by id (the card sprite,
// the clip, a pattern) is copied in beside it.
const thumbDir = path.join(dir, 'thumbs');
fs.mkdirSync(path.join(thumbDir, 'puzzles'), { recursive: true });
const DEF_TAGS = 'symbol|linearGradient|radialGradient|clipPath|pattern';
const defined = (svg, id) => svg.indexOf('id="' + id + '"') >= 0;
const grab = (id) => {
  const m = new RegExp('<(' + DEF_TAGS + ')\\b[^>]*\\bid="' + id + '"[\\s\\S]*?</\\1>').exec(html);
  return m ? m[0] : '';
};
let thumbs = 0;
html.replace(/<a class="ar-game" href="((?:puzzles\/)?[a-z0-9]+)\.html">\s*(<svg class="ar-game-art"[\s\S]*?<\/svg>)(?=\s*<span class="ar-game-text">)/g, (all, name, art) => {
  let body = art.replace(/^<svg class="ar-game-art"[^>]*>/, '').replace(/<\/svg>$/, '');
  let defs = '';
  for (let pass = 0; pass < 2; pass++) {
    const ids = new Set();
    (defs + body).replace(/(?:href="#|url\(#)([\w-]+)/g, (m, id) => { ids.add(id); return m; });
    ids.forEach((id) => { if (!defined(body + defs, id)) defs += grab(id); });
  }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">' + (defs ? '<defs>' + defs + '</defs>' : '') + body.trim() + '</svg>\n';
  fs.writeFileSync(path.join(thumbDir, name + '.svg'), svg);
  thumbs++;
  return all;
});
console.log('thumbnails: ' + thumbs);
