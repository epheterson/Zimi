// Chess: the captured strips. What each side has lost, biggest first, and the lead in pawns.
// Run: node tests/test_games_chess_caps.cjs   (exit 0 = pass)
const fs = require('fs'), path = require('path'), vm = require('vm');
const sb = {}; vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'zimi', 'builtin', 'games', 'chess-engine.js'), 'utf8'), sb);
const E = sb.ZimiChessEngine();
let failures = 0;
const check = (ok, label) => { if (ok) console.log('ok: ' + label); else { console.error('FAIL: ' + label); failures++; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let p = E.startPosition();
check(E.takenFrom(p, E.WHITE).list.length === 0 && E.takenFrom(p, E.BLACK).worth === 0, 'start position: nothing taken');

// White has lost 2 bishops, 2 knights and a pawn (13); Black 2 bishops, a knight and a pawn (10). Black leads by 3.
p = E.parseFen('r2q1rk1/ppp2ppp/2n5/3p4/3P4/2P5/PP3PPP/R2QR1K1 w - - 0 1');
const w = E.takenFrom(p, E.WHITE), b = E.takenFrom(p, E.BLACK);
check(same(w.list, [3, 3, 2, 2, 1]) && w.worth === 13, 'white lost 2B 2N P (biggest first), worth 13');
check(same(b.list, [3, 3, 2, 1]) && b.worth === 10, 'black lost 2B N P, worth 10');
check(w.worth - b.worth === 3, 'Black is up 3 (white lost more)');
// The strip for the side on top (Black) shows what White lost, and it carries the lead; paintCaps uses exactly this.
check(E.takenFrom(p, E.WHITE).worth - E.takenFrom(p, E.BLACK).worth > 0, 'lead is positive for the side that took more');
process.exit(failures ? 1 : 0);
