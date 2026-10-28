// ZimiGames: the recent list and the game of the day (builtin/games/recent.js), no DOM.
//
// Run: node tests/test_games_recent.cjs   (exit 0 = pass)
// Prints, with --days YYYY-MM-DD ..., one "day path" line per day from the real
// games.json: tests/test_games_links.py compares them with gamelinks.game_of_day.

const path = require('path');
globalThis.ZimiText = require(path.join(__dirname, '..', 'zimi', 'builtin', 'games', 'text.js'));
const R = require(path.join(__dirname, '..', 'zimi', 'builtin', 'games', 'recent.js'));

const days = process.argv.indexOf('--days');
if (days > 0) {
  const rows = require(path.join(__dirname, '..', 'zimi', 'builtin', 'games', 'games.json'));
  process.argv.slice(days + 1).forEach(d => console.log(d + ' ' + R.dayPick(rows, d).path));
  process.exit(0);
}

let failures = 0;
const check = (ok, label) => {
  if (!ok) { failures++; console.log('FAIL ' + label); }
};
const paths = list => list.map(e => e.path).join(',');

// record: newest first, a repeat moves up rather than doubling, the list is capped.
let list = [];
['a', 'b', 'c'].forEach((p, i) => { list = R.record(list, { path: p + '.html', title: p }, 100 + i, 6); });
check(paths(list) === 'c.html,b.html,a.html', 'newest first');
list = R.record(list, { path: 'a.html', title: 'A' }, 200, 6);
check(paths(list) === 'a.html,c.html,b.html', 'a repeat moves to the front, once');
check(list[0].title === 'A' && list[0].at === 200, 'the repeat carries its new title and time');
for (let i = 0; i < 10; i++) list = R.record(list, { path: 'g' + i + '.html', title: 'g' + i }, 300 + i, 6);
check(list.length === 6 && list[0].path === 'g9.html' && list[5].path === 'g4.html', 'capped at six, oldest dropped');
check(R.record(null, { path: 'x.html', title: 'x' }, 1).length === 1, 'no list yet');
check(paths(R.record([null, { title: 'no path' }, { path: 'k.html' }], { path: 'z.html', title: 'z' }, 1)) === 'z.html,k.html', 'junk entries are dropped');

// read: storage that is missing, broken or the wrong shape is an empty list.
const store = v => ({ getItem: () => v });
check(R.read(store(null)).length === 0, 'nothing stored');
check(R.read(store('{oops')).length === 0, 'broken JSON');
check(R.read(store('{"a":1}')).length === 0, 'not a list');
check(R.read({ getItem() { throw new Error('blocked'); } }).length === 0, 'blocked storage');
check(R.read(store(JSON.stringify(list))).length === 6, 'a stored list comes back');

// fnv1a: the published test vectors, so Python's copy can be held to the same numbers.
check(R.fnv1a('') === 0x811c9dc5, 'fnv1a of nothing');
check(R.fnv1a('a') === 0xe40c292c, 'fnv1a of a');
check(R.fnv1a('foobar') === 0xbf9cf968, 'fnv1a of foobar');

// dayPick: one game per page, by the day, the same every time.
const rows = [
  { path: 'one.html', title: 'One' },
  { path: 'one.html', title: 'One again' },
  { path: 'two.html', title: 'Two' },
  { path: 'three.html', title: 'Three' }
];
check(R.uniqueByPath(rows).length === 3, 'a page with two Q-IDs is one game');
check(R.dayPick(rows, '2026-10-24').path === R.dayPick(rows, '2026-10-24').path, 'deterministic');
check(R.dayPick(rows, '2026-10-24').path === 'two.html', 'a fixed day gives a fixed game (2026-10-24 -> two.html)');
check(R.dayPick(rows, '2026-10-25').path === 'one.html', 'the next day, another game (2026-10-25 -> one.html)');
check(R.dayPick([], '2026-10-24') === null, 'no games, no pick');
const seen = new Set();
for (let d = 1; d <= 31; d++) seen.add(R.dayPick(rows, '2026-12-' + String(d).padStart(2, '0')).path);
check(seen.size === 3, 'over a month every game comes up');

check(R.localDay(new Date(2026, 0, 5)) === '2026-01-05', 'localDay pads month and day');

// tilt: a small angle and nudge, the same every time, different between games.
const t1 = R.tilt('chess.html'), t2 = R.tilt('hearts.html');
check(JSON.stringify(t1) === JSON.stringify(R.tilt('chess.html')), 'tilt is stable');
check(JSON.stringify(t1) !== JSON.stringify(t2), 'tilt differs between games');
check(['chess', 'hearts', 'go', 'a', 'b', 'c', 'puzzles/x'].every(g => { const t = R.tilt(g + '.html'); return Math.abs(t.rot) >= 1.2 && Math.abs(t.rot) <= 5 && Math.abs(t.dy) <= 5; }), 'tilt stays within a few degrees and pixels');

// ago: how long since a play.
const NOW = 10 * 86400000;
check(R.ago(NOW, NOW - 20000) === 'just now', 'ago: seconds');
check(R.ago(NOW, NOW - 5 * 60000) === '5 minutes ago', 'ago: minutes');
check(R.ago(NOW, NOW - 2 * 3600000) === '2 hours ago', 'ago: hours');
check(R.ago(NOW, NOW - 30 * 3600000) === 'yesterday', 'ago: a day');
check(R.ago(NOW, NOW - 3 * 86400000) === '3 days ago', 'ago: days');
check(R.ago(NOW, NOW - 20 * 86400000) === '2 weeks ago', 'ago: weeks');
check(R.ago(NOW, NOW + 5000) === 'just now', 'ago: a clock set back');

// Live tiles: only a png or jpeg data URL or an svg string becomes a picture; anything else is no picture.
check(R.snapSrc({ img: 'data:image/png;base64,AAAA' }) === 'data:image/png;base64,AAAA', 'snapSrc: a png data URL');
check(R.snapSrc({ img: 'data:image/jpeg;base64,AAAA' }) !== '', 'snapSrc: a jpeg data URL');
check(R.snapSrc({ img: 'https://example.com/x.png' }) === '', 'snapSrc: no outside address');
check(R.snapSrc({ img: 'data:text/html;base64,AAAA' }) === '', 'snapSrc: no html');
check(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/.test(R.snapSrc({ svg: '<svg xmlns="x"></svg>' })), 'snapSrc: an svg string becomes a data URL');
check(R.snapSrc({ svg: '<script>alert(1)</script>' }) === '', 'snapSrc: a string that is not an svg');
check(R.snapSrc(null) === '' && R.snapSrc({}) === '', 'snapSrc: nothing kept, nothing shown');

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('games recent: ok');
