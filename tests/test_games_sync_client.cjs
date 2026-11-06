// The games' account sync in the browser (app.js), on the one sync store the
// settings use (_syncStore): a push the server failed is tried again after a
// while, as the settings' is; a key the account would not keep (its answer's
// ``refused``: over the per-key or per-account cap) is neither sent again and
// again nor lost: signing out sets it aside for that person's next sign-in.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
function grab(re, label) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + label + ' from app.js');
  return m[0];
}
const fn = (name) => grab(new RegExp('\\nfunction ' + name + '\\([^]*?\\n\\}\\n'), name);
const line = (re, label) => grab(re, label);

let failures = 0;
function ok(label, cond, extra) {
  if (cond) console.log('PASS  ' + label);
  else { failures++; console.log('FAIL  ' + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
}

function browser() {
  const store = {};
  const ctx = {
    console, JSON, Object, Array, String, Promise, RegExp, Date,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
      get length() { return Object.keys(store).length; },
      key: (i) => Object.keys(store)[i],
    },
    Blob: class { constructor(parts) { this.size = parts.join('').length; } },
    timers: [], waits: [], sent: [], answer: null, status: 200, down: false, rechecks: 0,
    _SAVED_PUSH_OFTEN_MS: 20000, _SAVED_KEEPALIVE_MAX: 60000, _liveClient: 'tab-1', _accountId: null,
    _showToast() {}, t: (k) => k,
  };
  ctx._accountRecheck = () => { ctx.rechecks++; };
  ctx.setTimeout = (f, ms) => { ctx.timers.push(f); ctx.waits.push(ms); return ctx.timers.length; };
  ctx.clearTimeout = (id) => { if (id) ctx.timers[id - 1] = null; };
  ctx.fetch = (url, opts) => {
    ctx.sent.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (ctx.down) return Promise.reject(new TypeError('Failed to fetch'));
    const d = typeof ctx.answer === 'function' ? ctx.answer(ctx.sent[ctx.sent.length - 1]) : ctx.answer;
    const st = ctx.status;
    return Promise.resolve({ ok: st >= 200 && st < 300, status: st, json: () => Promise.resolve(d) });
  };
  vm.createContext(ctx);
  vm.runInContext([
    grab(/var SK = \{[^]*?\n\};/, 'SK'),
    fn('_getStorageJSON'),
    line(/const _reEscape = [^\n]*\n/, '_reEscape'),
    line(/var _GAMES_STORE_PREFIXES = [^\n]*\n/, 'prefixes'),
    line(/var _GAMES_KEY_RE = [^\n]*\n/, 'key re'),
    line(/var _GAMES_LOCAL = [^\n]*\n/, 'local'),
    line(/var _GAMES_PUSH_MS = [^\n]*\n/, 'push ms'),
    line(/var _GAMES_KEPT_CITIES = [^\n]*\n/, 'kept'),
    'var _gamesAccount = null, _gamesPulledAt = 0, _gamesSync = null;',
    ...['_rawGet', '_syncState', '_syncSaveState', '_accountUrl', '_accountRefused', '_syncStore',
      '_isGamesKey', '_gamesKeys', '_gamesState', '_gamesSaveState', '_gamesJSON', '_gamesMerge', '_gamesWrite',
      '_gamesChanged', '_gamesStore', '_gamesPushSoon', '_gamesPush', '_gamesPull', '_gamesTake',
      '_gamesUnsent', '_gamesForgetPerson', '_gamesFollow', '_gamesLeave'].map(fn),
    'function _gamesTellFrame() {}',
  ].join('\n'), ctx);
  ctx.store = store;
  ctx.fire = async () => { const t = ctx.timers.filter(Boolean); ctx.timers.length = 0; for (const f of t) await f(); await new Promise((r) => setImmediate(r)); };
  return ctx;
}
const settle = () => new Promise((r) => setImmediate(r));
const STATS = 'zimi.games.stats', CITY = 'zimi.zimcity.kept';

(async () => {
  // a failed push is tried again after a while, as the settings' is
  {
    const b = browser();
    b.answer = { rev: 0, settings: {} };
    b._gamesFollow('kid');
    await settle(); await settle();
    b.store[STATS] = '{"v":1}';
    b._gamesChanged(STATS);
    b.status = 503;
    b.waits.length = 0;
    await b.fire(); await settle();
    ok('a failed push waits for its retry ' + b.waits.join(','), b.waits.join(',') === '20000' && b.timers.filter(Boolean).length === 1, b.waits);
    b.status = 200;
    b.answer = { rev: 1, settings: { [STATS]: { v: '{"v":1}', r: 1 } } };
    await b.fire(); await settle();
    ok('...and when the server is back it goes, no longer pending', !Object.keys(b._gamesState().pending).length);
  }

  // a key the account would not keep is neither sent again and again nor lost
  {
    const b = browser();
    b.answer = { rev: 0, settings: {} };
    b._gamesFollow('kid');
    await settle(); await settle();
    b.store[CITY] = '[{"at":1,"big":"' + 'x'.repeat(50) + '"}]';
    b._gamesChanged(CITY);
    b.answer = { rev: 0, settings: {}, refused: [CITY] };
    await b.fire(); await settle();
    const st = b._gamesState();
    ok('refused: out of the pending list, kept as refused', !st.pending[CITY] && st.refused[CITY] === 1, st);
    const sentBefore = b.sent.length;
    await b.fire(); await settle();
    ok('...and not sent again on its own', b.sent.length === sentBefore);
    const city = b.store[CITY];
    await b._gamesLeave();
    const after = b._gamesState();
    ok('signing out sets it aside for that person, not lost', !!after.aside.kid && after.aside.kid[CITY] === city, after.aside);
    ok('...and the games leave the screen', b.store[CITY] === undefined);
  }

  if (failures) { console.log(failures + ' FAILED'); process.exit(1); }
  console.log('all games-sync client checks passed');
})();
