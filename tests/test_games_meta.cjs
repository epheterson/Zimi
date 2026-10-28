// ZimiGames' facts and orders (builtin/games/games.json metadata, shelf.js groupsFor), no DOM.
//
// Run: node tests/test_games_meta.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
globalThis.ZimiText = require(path.join(dir, 'text.js'));
const S = require(path.join(dir, 'shelf.js'));
const rows = require(path.join(dir, 'games.json'));
const index = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

let failures = 0;
const check = (ok, label) => {
  if (!ok) { failures++; console.log('FAIL ' + label); }
};
const ids = list => list.map(g => g.items.map(i => i.path).join(',')).join(' | ');

// Every game page has exactly one row that carries the facts.
const KINDS = ['cards', 'board', 'tiles', 'dice', 'puzzle', 'word', 'arcade', 'kids', 'library'];
const pages = [...new Set(rows.map(r => r.path))];
pages.forEach(p => {
  const withMeta = rows.filter(r => r.path === p && r.origin);
  check(withMeta.length === 1, p + ' has exactly one row with metadata (has ' + withMeta.length + ')');
  const m = withMeta[0];
  if (!m) return;
  check(m.origin && 'year' in m.origin && 'era' in m.origin, p + ' origin has year and era');
  check(m.origin.year === null || Number.isInteger(m.origin.year), p + ' year is a whole number or null');
  check(m.origin.era === null || typeof m.origin.era === 'string', p + ' era is text or null');
  check(S.REGIONS.includes(m.region), p + ' region is one of the nine (' + m.region + ')');
  check(/^\d( to \d)?$/.test(m.players), p + ' players reads "2" or "2 to 4" (' + m.players + ')');
  check(/^(5|10|15|30) min\+?$/.test(m.length), p + ' length is 5, 10, 15 or 30 min (' + m.length + ')');
  check(KINDS.includes(m.kind), p + ' kind is known (' + m.kind + ')');
  check(typeof m.computer === 'boolean', p + ' computer is true or false');
  // When the year and the era both exist they agree (an era of "1890s" holds the year 1890..1899).
  const e = S.eraYear(m.origin.era);
  if (m.origin.year !== null && e !== null) {
    const decade = /s$/.test(m.origin.era);
    check(decade ? m.origin.year >= e && m.origin.year < e + (e % 100 === 0 ? 100 : 10) : Math.abs(m.origin.year - e) <= 50, p + ' year ' + m.origin.year + ' agrees with era ' + m.origin.era);
  }
});
// A page's other row (a game with two Q-IDs) carries none, so the data lives once.
rows.forEach(r => { if (r.origin) check(rows.find(x => x.path === r.path) === r, r.path + ': the facts sit on the first row'); });

// Every tile on the shelf has facts: from its row, or from the shelf's own fallback.
const byPath = {};
rows.forEach(r => { if (r.origin && !byPath[r.path]) byPath[r.path] = r; });
const meta = p => byPath[p] || S.FALLBACK[p] || null;
const tiles = [...index.matchAll(/<a class="ar-game" href="([^"#]+)"/g)].map(m => m[1]);
check(tiles.length > 70, 'the shelf has its tiles (' + tiles.length + ')');
tiles.forEach(t => check(meta(t), 'tile ' + t + ' has facts'));

// eraYear and the era buckets.
check(S.eraYear('c. 500 BC') === -500 && S.eraYear('1890s') === 1890 && S.eraYear('c. AD 1150') === 1150 && S.eraYear(null) === null && S.eraYear('') === null, 'eraYear reads the era text');
const era = (year, e) => (S.eraOf({ origin: { year, era: e } }) || {}).id || null;
check(era(-2600, 'c. 2600 BC') === 'ancient' && era(400, 'c. AD 400') === 'ancient', 'ancient games');
check(era(500, null) === 'medieval' && era(1697, null) === 'medieval', 'medieval and after runs to 1699');
check(era(1700, null) === 'parlour' && era(1899, null) === 'parlour', '1700s to 1800s');
check(era(1900, null) === 'modern' && era(1969, null) === 'modern', '1900s runs to 1969');
check(era(1970, null) === 'video' && era(2021, null) === 'video', 'the video game era starts in 1970');
check(era(null, '1990s') === 'video' && era(null, '1800s') === 'parlour', 'an era with no year buckets by the era');
check(era(null, null) === null, 'no age is no era');

// Fixed fixtures: titles, years and the rest chosen to hit the edges.
const fx = {
  'a.html': { origin: { year: 1976, era: '1970s' }, region: 'Americas', players: '1', length: '5 min' },
  'b.html': { origin: { year: -2600, era: 'c. 2600 BC' }, region: 'Middle East', players: '2', length: '15 min' },
  'c.html': { origin: { year: null, era: '1800s' }, region: 'Europe', players: '2 to 4', length: '30 min+' },
  'd.html': { origin: { year: null, era: null }, region: 'Worldwide/Modern', players: '3 to 6', length: '30 min' },
  'e.html': { origin: { year: 600, era: 'c. AD 600' }, region: 'South Asia', players: '2', length: '10 min' },
  'f.html': { origin: { year: 1750, era: 'c. 1750' }, region: 'Europe', players: '4', length: '10 min' },
  'g.html': { origin: { year: 1925, era: '1920s' }, region: 'Atlantis', players: '4', length: '30 min+' }
};
const items = ['g', 'f', 'e', 'd', 'c', 'b', 'a'].map(k => ({ path: k + '.html', title: k.toUpperCase() + 'game' }));
const m2 = p => fx[p] || null;

// A to Z: one flat group, by title.
let g = S.groupsFor('az', items, m2);
check(g.length === 1 && g[0].items.map(i => i.title).join() === 'Agame,Bgame,Cgame,Dgame,Egame,Fgame,Ggame', 'A to Z is one list in title order');

// Oldest first: era groups in order, oldest first inside, unknown last.
g = S.groupsFor('oldest', items, m2);
check(g.map(x => x.label).join() === 'Ancient,Medieval and after,1700s to 1800s,1900s,Video game era,Age unknown', 'timeline groups: ' + g.map(x => x.label));
check(ids(g) === 'b.html | e.html | f.html,c.html | g.html | a.html | d.html', 'timeline order: ' + ids(g));
check(S.groupsFor('oldest', [], m2).length === 0, 'no games, no groups');

// By region: the nine in order, empty ones left out, an unknown region falls under Worldwide/Modern, oldest first inside.
g = S.groupsFor('region', items, m2);
check(g.map(x => x.label).join() === 'South Asia,Middle East,Europe,Americas,Worldwide/Modern', 'region groups: ' + g.map(x => x.label));
check(ids(g) === 'e.html | b.html | f.html,c.html | a.html | g.html,d.html' || ids(g) === 'e.html | b.html | f.html,c.html | a.html | d.html,g.html', 'region order: ' + ids(g));
check(g.find(x => x.label === 'Europe').items[0].path === 'f.html', 'the older European game comes first');
check(g.every(x => x.label === 'Worldwide/Modern' || x.region === x.label), 'a region group names its region for the map');

// By players: by the most seats.
g = S.groupsFor('players', items, m2);
check(g.map(x => x.label).join() === 'Solo,Two,Three or more', 'player groups');
check(ids(g) === 'a.html | b.html,e.html | c.html,d.html,f.html,g.html', 'players order: ' + ids(g));
check(S.maxPlayers({ players: '2 to 4' }) === 4 && S.maxPlayers({ players: '1' }) === 1 && S.maxPlayers(null) === 0, 'maxPlayers');

// Quick games first: shortest first; 30 min+ after 30 min.
g = S.groupsFor('quick', items, m2);
check(g.map(x => x.label).join() === 'About 5 minutes,About 10 minutes,About 15 minutes,About 30 minutes,Half an hour and more', 'length groups: ' + g.map(x => x.label));
check(ids(g) === 'a.html | e.html,f.html | b.html | d.html | c.html,g.html', 'quick order: ' + ids(g));
check(S.minutesOf({ length: '30 min+' }) > S.minutesOf({ length: '30 min' }), '30 min+ is longer than 30 min');

// Recently played: newest first, then the rest by name; nothing played is one group.
g = S.groupsFor('recent', items, m2, ['c.html', 'a.html', 'c.html', 'zz.html']);
check(g.map(x => x.label).join() === 'Played lately,Not played yet', 'recent groups');
check(ids(g) === 'c.html,a.html | b.html,d.html,e.html,f.html,g.html', 'recent order: ' + ids(g));
g = S.groupsFor('recent', items, m2, []);
check(g.length === 1 && g[0].label === 'Nothing played yet' && g[0].items.length === 7, 'nothing played yet');

// Sections is not a grouping, and no group ever loses or doubles a game.
check(S.groupsFor('sections', items, m2) === null, 'sections is the page as written');
S.SORTS.filter(s => s !== 'sections').forEach(s => {
  const all = S.groupsFor(s, items, m2, ['b.html']).reduce((n, x) => n.concat(x.items.map(i => i.path)), []).sort().join();
  check(all === items.map(i => i.path).sort().join(), s + ' keeps every game exactly once');
});
// With a game that has no facts at all: it lands last, not nowhere.
const lone = [{ path: 'x.html', title: 'X' }, { path: 'a.html', title: 'A' }];
S.SORTS.filter(s => s !== 'sections').forEach(s => {
  const n = S.groupsFor(s, lone, m2, []).reduce((c, x) => c + x.items.length, 0);
  check(n === 2, s + ' keeps a game with no facts');
});
check(ids(S.groupsFor('oldest', lone, m2)) === 'a.html | x.html', 'a game with no facts is last on the timeline');

// The real shelf: Go is older than Chess, Chess than Pong; the timeline has every era.
const real = tiles.map(t => ({ path: t, title: t }));
g = S.groupsFor('oldest', real, meta);
const flat = g.reduce((n, x) => n.concat(x.items.map(i => i.path)), []);
check(flat.indexOf('ur.html') < flat.indexOf('go.html') && flat.indexOf('go.html') < flat.indexOf('chess.html') && flat.indexOf('chess.html') < flat.indexOf('paddles.html'), 'Ur, Go, Chess, Pong in that order');
check(g.length >= 5 && g.every(x => x.items.length > 0), 'every era has games on the real shelf');
S.REGIONS.filter(r => r !== 'Oceania').forEach(r => check(S.groupsFor('region', real, meta).some(x => x.label === r), 'the real shelf has ' + r));

// Families: each wrapper names itself, holds two or more real tiles, and no tile sits in two.
const famBlocks = [...index.matchAll(/<div class="ar-family" data-name="([^"]+)" data-line="([^"]+)">([\s\S]*?)\n    <\/div>/g)];
const inFamily = [];
check(famBlocks.length >= 5, 'the shelf has its families (' + famBlocks.length + ')');
famBlocks.forEach(m => {
  const hrefs = [...m[3].matchAll(/<a class="ar-game" href="((?:puzzles\/)?[a-z0-9]+\.html)">/g)].map(x => x[1]);
  check(hrefs.length >= 2, m[1] + ' holds at least two games');
  check(m[2].length <= 40, m[1] + ' has a short line (' + m[2].length + ' characters)');
  hrefs.forEach(h => { check(pages.includes(h), m[1] + ': ' + h + ' is a game page'); check(!inFamily.includes(h), h + ' is in one family only'); inFamily.push(h); });
});
const allTiles = [...index.matchAll(/<a class="ar-game" href="((?:puzzles\/)?[a-z0-9]+\.html)">/g)].length;
check(allTiles === tiles.length, 'every tile is still a plain link in the page (' + allTiles + ')');

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('ok test_games_meta');
