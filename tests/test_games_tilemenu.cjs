// ZimiGames: what the tile menu's Reset progress clears (builtin/games/tilemenu.js), no DOM.
//
// Run: node tests/test_games_tilemenu.cjs   (exit 0 = pass)

const path = require('path');
const M = require(path.join(__dirname, '..', 'zimi', 'builtin', 'games', 'tilemenu.js'));

let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log('FAIL ' + label); } };

check(M.idOf('checkers.html') === 'checkers', 'a game page is its id');
check(M.idOf('puzzles/fifteen.html?x=1#y') === 'fifteen', 'a puzzle is its file name, query and fragment dropped');
check(M.pathOf('./chess.html#a') === 'chess.html', 'a tile href is its path');

const keys = [
  'zimi.games.save.sudoku', 'zimi.games.stats.sudoku', 'zimi.games.sudoku.stats', 'zimi.games.sudoku.state',
  'zimi.games.sudoku.settings', 'zimi.games.sudoku2.stats', 'zimi.games.save.sudoku2', 'zimi.games.settings',
  'zimi.games.recent', 'zimi.games.snaps', 'other.sudoku.stats',
];
const gone = M.resetKeys('sudoku', keys);
check(gone.join() === 'zimi.games.save.sudoku,zimi.games.stats.sudoku,zimi.games.sudoku.stats,zimi.games.sudoku.state',
  'reset clears the saved game, the state and the stats of that game, nothing else: ' + gone.join());
check(M.resetKeys('chess', keys).length === 0, 'another game has nothing to clear');
check(M.hasSave('sudoku', keys), 'a saved game is a save');
check(!M.hasSave('sudoku', ['zimi.games.sudoku.stats', 'zimi.games.stats.sudoku']), 'stats alone are not a save');
check(!M.hasSave('sudoku', ['zimi.games.save.sudoku2']), 'a save of a game named alike is not this one');
check(M.resetKeys('a.b', ['zimi.games.save.a.b', 'zimi.games.save.aXb']).join() === 'zimi.games.save.a.b', 'ids match literally');

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('tilemenu: ok');
