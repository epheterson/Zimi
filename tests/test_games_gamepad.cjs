// ZimiGames' controller reading (builtin/games/gamepad.js): pads folded into held inputs, edge and repeat timing,
// and where focus goes. No DOM.
//
// Run: node tests/test_games_gamepad.cjs   (exit 0 = pass)

const path = require('path');
const G = require(path.join(__dirname, '..', 'zimi', 'builtin', 'games', 'gamepad.js'));

let failures = 0;
const check = (ok, label) => { if (!ok) { failures++; console.log('FAIL ' + label); } };
const pad = (down = [], axes = [0, 0]) => ({ connected: true, axes, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: down.includes(i), value: down.includes(i) ? 1 : 0 })) });
const on = h => Object.keys(h).filter(k => h[k]).join();

check(on(G.held([pad()])) === '', 'nothing held on a quiet pad');
check(on(G.held([pad([12, 0])])) === 'up,a', 'D-pad up and A');
check(on(G.held([pad([13, 14, 1, 9])])) === 'down,left,b,start', 'D-pad down-left, B and Start');
check(on(G.held([pad([], [-0.9, 0.1])])) === 'left', 'the left stick pushed left is left');
check(on(G.held([pad([], [0.3, -0.4])])) === '', 'a stick inside the dead zone is nothing');
check(on(G.held([pad([], [0.8, 0.9])])) === 'down,right', 'a stick pushed diagonally is two directions');
check(on(G.held([pad([14]), pad([15])])) === '', 'two pads pushing opposite ways cancel');
check(on(G.held([pad([0]), pad([12])])) === 'up,a', 'two pads act as one');
check(on(G.held([{ connected: false, axes: [], buttons: [{ pressed: true }] }, null])) === '', 'a gone pad and a null slot are ignored');
check(on(G.held([{ axes: [], buttons: [0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] }])) === 'up,a', 'analogue values count as pressed past half');

// Edge and repeat.
const step = G.stepper();
const kinds = (now, h) => step(now, G.held(h)).map(e => e.input + ':' + e.kind).join();
check(kinds(0, [pad()]) === '', 'no events at rest');
check(kinds(16, [pad([15])]) === 'right:down', 'a press is one down');
check(kinds(200, [pad([15])]) === '', 'held, nothing before the delay');
check(kinds(16 + G.REPEAT_DELAY_MS, [pad([15])]) === 'right:repeat', 'held past the delay, it repeats');
check(kinds(16 + G.REPEAT_DELAY_MS + 50, [pad([15])]) === '', 'and waits for the next beat');
check(kinds(16 + G.REPEAT_DELAY_MS + G.REPEAT_EVERY_MS, [pad([15])]) === 'right:repeat', 'then keeps beating');
check(kinds(2000, [pad([15, 0])]) === 'right:repeat,a:down', 'A pressed while right is held is its own down');
check(kinds(2016, [pad([0])]) === 'right:up', 'letting go of right is an up');
check(kinds(5000, [pad([0])]) === '', 'A held does not repeat');
check(kinds(5016, [pad()]) === 'a:up', 'letting go of A is an up');

// Where focus goes: a 3 x 2 grid of 40-pixel cells, 50 apart.
const grid = [];
for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) grid.push({ x: c * 50, y: r * 50, w: 40, h: 40 });
check(G.nearest(grid[0], grid, 'right') === 1, 'right from the top left is its neighbour');
check(G.nearest(grid[0], grid, 'down') === 3, 'down from the top left is the cell below');
check(G.nearest(grid[1], grid, 'down') === 4, 'down from the middle is the middle below');
check(G.nearest(grid[0], grid, 'left') === -1 && G.nearest(grid[0], grid, 'up') === -1, 'the edge has nothing beyond it');
check(G.nearest(grid[5], grid, 'left') === 4, 'left from the bottom right');
const wide = [{ x: 0, y: 0, w: 300, h: 40 }, { x: 0, y: 60, w: 100, h: 40 }, { x: 200, y: 60, w: 100, h: 40 }];
check(G.nearest(wide[0], wide, 'down') === 1 || G.nearest(wide[0], wide, 'down') === 2, 'down from a wide bar reaches a cell under it');

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('ok test_games_gamepad');
