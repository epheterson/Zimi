// Every game that tells the player they won or lost does it through the shell's end (ZimiShell.endSheet, or a kit that calls it),
// so the win's beat and the loss's moment are never skipped by a game with a sheet of its own. A page script that names
// shell.end.win / shell.end.lose without calling endSheet (or BoardUI.end / UI.end) is a game with its own ending.
//
// Run: node tests/test_games_end_routes.cjs   (exit 0 = pass)
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
const KITS = new Set(['shell.js', 'text.js', 'playkit.js', 'cards.js', 'boardui.js', 'roundkit.js']);
let failures = 0;
const check = (ok, label) => { if (ok) console.log('ok: ' + label); else { console.error('FAIL: ' + label); failures++; } };
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
let seen = 0;
for (const page of fs.readdirSync(dir).filter((f) => f.endsWith('.html'))) {
  const html = read(page);
  if (!/shell\.js/.test(html) || !/ar-bar/.test(html)) continue;
  const own = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => m[1]).filter((f) => !KITS.has(f) && fs.existsSync(path.join(dir, f)));
  const src = own.map(read).join('\n');
  const claims = /shell\.end\.(win|lose|wins)/.test(src);
  if (!claims) continue;
  seen++;
  check(/endSheet\(|UI\.end\(|BoardUI\.end\(|\.showEnd\(/.test(src), page + ' says win or lose through the shell\'s end');
}
check(seen >= 4, 'the check saw the games that name a result (' + seen + ')');
process.exit(failures ? 1 : 0);
