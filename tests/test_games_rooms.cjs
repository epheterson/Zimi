// ZimiGames' rooms (shelf.js, pure): Kids, Arcade, Game night and Solo, each a filter drawn from what games.json already says
// of a game (its kind, how many play), plus one short list of kids' games no fact names. Not a hand-tagged copy of the catalog.
//
// Run: node tests/test_games_rooms.cjs   (exit 0 = pass)

const path = require('path');
const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
const S = require(path.join(dir, 'shelf.js'));
const rows = require(path.join(dir, 'games.json'));
let failures = 0;
const check = (ok, label) => { if (ok) console.log('ok: ' + label); else { console.error('FAIL: ' + label); failures++; } };

const byPath = {};
rows.forEach((r) => { if (!byPath[r.path] || r.players) byPath[r.path] = r; });
const pages = Object.keys(byPath);
const room = (id) => pages.filter((p) => S.inRoom(id, byPath[p], p));

check(Array.isArray(S.ROOMS) && S.ROOMS.join() === 'all,kids,arcade,night,solo', 'the rooms are All, Kids, Arcade, Game night and Solo, in that order');
check(room('all').length === pages.length, 'All is every game');
check(['memory.html', 'echo.html', 'noughts.html', 'snakesandladders.html', 'fourinarow.html'].every((p) => room('kids').includes(p)), 'Kids holds the kids\' kind and the short list');
check(room('arcade').length === pages.filter((p) => byPath[p].kind === 'arcade').length && room('arcade').includes('snake.html'), 'Arcade is the arcade kind');
check(['hearts.html', 'spades.html', 'liarsdice.html'].every((p) => room('night').includes(p)) && !room('night').includes('chess.html'), 'Game night is a table of three or more, not a duel');
check(['sudoku.html', 'puzzles/loopy.html', 'solitaire.html'].every((p) => room('solo').includes(p)) && !room('solo').includes('snake.html') && !room('solo').includes('chess.html'), 'Solo is the quiet one-player games, not the arcade');
check(S.ROOMS.every((id) => room(id).length >= 6), 'every room has games in it');
const listed = Object.keys(S.KIDS_TOO || {});
check(listed.length <= 8 && listed.every((p) => byPath[p]), 'the kids\' list is short and every game on it is on the shelf');
check(!S.inRoom('kids', null, 'x.html') && S.inRoom('all', null, 'x.html'), 'a game with no facts is only in All');

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
