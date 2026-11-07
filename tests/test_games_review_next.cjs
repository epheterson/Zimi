// Findings from the bots' review of 1.15.3 that were queued for the next release: a held key that rolls to its neighbour
// (never into a key another finger holds, never to another row), and an own-daily game's run that starts at the first touch.
//
// Run: node tests/test_games_review_next.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'zimi', 'builtin', 'games');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};

// ── Play.hold: a thumb rolls from one key to the next in its row ──
{
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(read('util.js'), sb, { filename: 'util.js' });
  vm.runInContext(read('playkit.js'), sb, { filename: 'playkit.js' });
  const Play = sb.ArcadePlay;
  const parent = {};
  // A key is a box: row 0 holds Left and Right, row 1 holds Down; the pointer is wherever `at` says.
  function key(name, left, row) {
    const on = {}, attrs = {}, e = {
      name, parentNode: parent,
      rect: { left, right: left + 50, top: row * 60, bottom: row * 60 + 50, width: 50, height: 50 },
      addEventListener(t, f) { (on[t] = on[t] || []).push(f); },
      fire(t, ev) { (on[t] || []).forEach((f) => f(ev || {})); },
      setAttribute(k, v) { attrs[k] = v; }, getAttribute(k) { return k in attrs ? attrs[k] : null; },
      setPointerCapture() {}, releasePointerCapture() {},
      getBoundingClientRect() { return e.rect; }, closest() { return e; }
    };
    e.log = [];
    Play.hold(e, (v) => e.log.push(v));
    return e;
  }
  let at = null;
  sb.document = { elementFromPoint: () => at };
  const down = (k, id) => k.fire('pointerdown', { pointerId: id, preventDefault() {} });

  const L = key('left', 0, 0), R = key('right', 60, 0);
  down(L, 1);
  at = R; L.fire('pointermove', { pointerId: 1, clientX: 70, clientY: 10 });
  check(L.log.join() === 'true,false' && R.log.join() === 'true', 'a finger rolling onto the next key in its row lets go of one and holds the other');

  // A second finger already holds Down: the first finger sliding onto it leaves Down to that finger.
  const L2 = key('left', 0, 1), D2 = key('down', 60, 1);
  down(D2, 2);
  down(L2, 1);
  at = D2; L2.fire('pointermove', { pointerId: 1, clientX: 70, clientY: 70 });
  check(L2.log.join() === 'true' && D2.log.join() === 'true', 'never onto a key another finger holds');

  // Left to the key below it (not the same row) is not a roll.
  const L3 = key('left', 0, 0), D3 = key('down', 0, 1), R3 = key('right', 60, 0);
  down(L3, 1);
  at = D3; L3.fire('pointermove', { pointerId: 1, clientX: 10, clientY: 70 });
  check(L3.log.join() === 'true' && D3.log.length === 0, 'a key on another row is not a neighbour to roll onto');
  at = R3; L3.fire('pointermove', { pointerId: 1, clientX: 70, clientY: 10 });
  check(L3.log.join() === 'true,false' && R3.log.join() === 'true', 'and the same row still is');
}

// ── an own-daily game opened from its ordinary page starts its run at the first touch ──
{
  const store = {}, listeners = {};
  const doc = {
    readyState: 'complete', body: { appendChild() {} }, head: { appendChild() {} }, createElement: () => ({}),
    documentElement: { setAttribute() {}, classList: { add() {}, remove() {} } },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); }, querySelector: () => null, querySelectorAll: () => [], title: 'Game - ZimiGames'
  };
  const sb = {
    console, document: doc, location: { pathname: '/w/zimi_games/fiveletters.html', search: '', hash: '' }, addEventListener() {},
    matchMedia: () => ({ matches: false }), Date, URL,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; },
      key: (i) => Object.keys(store)[i], get length() { return Object.keys(store).length; }
    }
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(read('util.js'), sb, { filename: 'util.js' });
  vm.runInContext(read('shell.js'), sb, { filename: 'shell.js' });
  const S = sb.ZimiShell;
  check(!S.daily && S.DAILY['fiveletters.html'] === 'own', 'fiveletters is an own-daily page, opened here as an ordinary one');
  const touch = () => (listeners.pointerdown || []).forEach((f) => f({ target: { closest: () => null } }));
  S.game({ daily: () => false });
  touch();
  check(!Object.keys(store).some((k) => k.startsWith('zimi.games.day.')), 'a round that is not the day\'s starts no run');
  S.game({ daily: () => true });
  touch();
  const run = JSON.parse(store['zimi.games.day.' + S.day()] || '{}')['fiveletters.html'];
  check(!!run && typeof run.start === 'number', 'the day\'s round starts its run at the first touch, so its time on the board is not 0:00');
}

process.exit(failures ? 1 : 0);
