// Settings sync in the browser (app.js), on users.py's convention: the server
// orders changes and no device clock is asked; a change made signed in is
// pending until the account takes it; coming down, the account wins every key
// it holds that is not pending; a change made signed out stays here; a new
// account is never handed the last one's changes; the first account a
// browser ever follows, if it never held a setting, takes the browser's own
// (from before sync) once, on the keys it lacks.
//
// Runs app.js's own functions in a sandbox whose Date throws: a clock read
// anywhere in the sync is a failure.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8').replace(/\r\n/g, '\n'); // a Windows checkout's line ends
function grab(re, label) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + label + ' from app.js');
  return m[0];
}
const fn = (name) => grab(new RegExp('\\nfunction ' + name + '\\([^]*?\\n\\}\\n'), name);
// A function an older app.js lacks: none (the behaviour its test asks for is then missing).
const fnIf = (name) => { const m = src.match(new RegExp('\\nfunction ' + name + '\\([^]*?\\n\\}\\n')); return m ? m[0] : ''; };

let failures = 0;
function ok(label, cond, extra) {
  if (cond) console.log('PASS  ' + label);
  else { failures++; console.log('FAIL  ' + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
}

function browser() {
  const store = {};
  const ctx = {
    console, JSON, Object, Array, String, Promise,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    Blob: class { constructor(parts) { this.size = parts.join('').length; } },
    Date: { now() { throw new Error('a device clock was read'); } },
    timers: [], sent: [], applied: [], answer: null,
    _SAVED_PUSH_MS: 2000, _SAVED_PUSH_OFTEN_MS: 20000, _SAVED_KEEPALIVE_MAX: 60000,
    Saved: { use: () => false }, _savedBase: null,
    _savedChanged() {}, _savedPull() {}, _liveRestart() {}, _liveClient: 'tab-1',
    status: 200, down: false, rechecks: 0,
  };
  ctx._accountRecheck = () => { ctx.rechecks++; };
  ctx.setTimeout = (f, ms) => { ctx.timers.push(f); ctx.waits.push(ms); return ctx.timers.length; };
  ctx.waits = [];
  ctx.clearTimeout = (id) => { if (id) ctx.timers[id - 1] = null; };
  ctx._prefApplied = (keys) => ctx.applied.push(...keys);
  // The server: answers with what the test says it holds after the change.
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
    grab(/var _PREF_KEYS = \[[^]*?\];/, '_PREF_KEYS'),
    fn('_getStorageJSON'),
    'var _accountId = null, _prefPushTimer = null, _prefPushing = null, _prefFilling = false, _prefRetryTimer = null;',
    ...['_isPrefKey', '_rawGet', '_prefState', '_prefSaveState', '_prefChanged', '_prefWrite',
      '_accountSet', '_prefPushSoon', '_prefPush', '_prefTake'].map(fn),
    fnIf('_prefRetryLater'),
  ].join('\n'), ctx);
  ctx.store = store;
  ctx.fire = async () => { const t = ctx.timers.filter(Boolean); ctx.timers.length = 0; for (const f of t) await f(); await new Promise((r) => setImmediate(r)); };
  return ctx;
}
const settle = () => new Promise((r) => setImmediate(r));
const THEME = 'zimi_reader_theme', LANGS = 'zimi_pref_languages', VIEW = 'zimi_library_view';

(async () => {
  // signed out: a change is this browser's
  {
    const b = browser();
    b._prefWrite(THEME, 'sepia');
    ok('signed out, a change stays here: nothing pending, nothing sent', b.store[THEME] === 'sepia' && !b.timers.filter(Boolean).length && !b.sent.length);
    b._accountSet('kid', true);
    ok('...and signing in later does not make it the account\'s', !Object.keys(b._prefState().pending).length);
  }

  // signed in: pending until taken, with no clock and no loop
  {
    const b = browser();
    b._accountSet('kid', true);
    b._prefState(); // owner set
    b._prefWrite(THEME, 'sepia');
    ok('signed in, a change is pending and goes soon', b._prefState().pending[THEME] === 1 && b.timers.filter(Boolean).length === 1);
    b.answer = { rev: 7, settings: { [THEME]: { v: 'sepia', r: 7 } } };
    await b.fire();
    const body = b.sent[0].body;
    ok('what goes up is the value, whose it is and which page sent it (so it skips its own echo): no time, no revision of this device\'s', b.sent[0].url === '/userdata/settings' && JSON.stringify(body) === JSON.stringify({ changes: { [THEME]: { v: 'sepia' } }, account: 'kid', client: 'tab-1' }), body);
    ok('taken, it is no longer pending', !Object.keys(b._prefState().pending).length);
    await b.fire();
    ok('and nothing more goes: no loop', b.sent.length === 1, b.sent.length);
  }

  // a change made again while the first was on its way stays pending
  {
    const b = browser();
    b._accountSet('kid', true);
    b._prefWrite(THEME, 'sepia');
    b.answer = () => { b.store[THEME] = 'dark'; return { rev: 1, settings: { [THEME]: { v: 'sepia', r: 1 } } }; };
    await b.fire();
    ok('changed again since it was sent: still pending, and kept', b._prefState().pending[THEME] === 1 && b.store[THEME] === 'dark');
  }

  // coming down: the account wins every key it holds that is not pending
  {
    const b = browser();
    b._accountSet('kid', true);
    b.store[VIEW] = 'list';          // set here signed out, before
    b.store['zimi_reader_family'] = 'serif'; // a key the account lacks
    b._prefWrite(THEME, 'dark');     // pending here
    b._prefTake({ rev: 4, settings: { [VIEW]: { v: 'tiles', r: 2 }, [THEME]: { v: 'sepia', r: 3 }, [LANGS]: { v: null, r: 4 } } });
    ok('the account\'s value is taken', b.store[VIEW] === 'tiles' && b.applied.includes(VIEW));
    ok('a pending change here is not overwritten', b.store[THEME] === 'dark');
    ok('a key the account lacks stays this browser\'s', b.store['zimi_reader_family'] === 'serif');
  }

  // a second account on this browser starts from its own
  {
    const b = browser();
    b._accountSet('alice', true);
    b._prefWrite(THEME, 'dark');
    ok('alice\'s change is pending', b._prefState().pending[THEME] === 1);
    b._accountSet('bob', true);
    ok('bob is not handed alice\'s pending changes', !Object.keys(b._prefState().pending).length && b._prefState().owner === 'bob');
    b._prefTake({ rev: 2, settings: { [THEME]: { v: 'light', r: 2 } } });
    ok('bob\'s account wins every key it holds', b.store[THEME] === 'light');
    b.timers.length = 0;
    await settle();
    ok('nothing of alice\'s goes to bob', !b.sent.length);
  }

  // an account that never held a setting takes this browser's own, once
  {
    const b = browser();
    b.store[LANGS] = '["en","es"]';
    b._accountSet('kid', true);
    b.answer = (req) => ({ rev: 1, settings: { [LANGS]: { v: '["en","es"]', r: 1 } } });
    b._prefTake({ rev: 0, settings: {} });
    await settle(); await settle();
    const first = b.sent[0] && b.sent[0].body;
    ok('first sync: this browser\'s settings fill it', first && first.fill === true && first.changes[LANGS].v === '["en","es"]', first);
    b._prefTake({ rev: 0, settings: {} });
    await settle();
    ok('...once', b.sent.length === 1, b.sent.length);
    b._accountLeave = null;
    b._accountSet('other', true);
    b._prefTake({ rev: 0, settings: {} });
    await settle();
    ok('a browser that followed an account before never fills the next: they were not its own', b.sent.length === 1, b.sent.length);
    const c = browser();
    c.store[LANGS] = '["de"]';
    c._accountSet('kid', true);
    c._prefTake({ rev: 1, settings: { [LANGS]: { v: '["en","es"]', r: 1 } } });
    await settle();
    ok('an account that holds settings is never filled: it wins', !c.sent.length && c.store[LANGS] === '["en","es"]');
  }

  // the server failing: a wait, never a push every moment
  for (const how of ['5xx', 'network']) {
    const b = browser();
    b._accountSet('kid', true);
    b._prefWrite(THEME, 'sepia');
    if (how === '5xx') b.status = 503; else b.down = true;
    b.waits.length = 0;
    await b.fire();
    await settle();
    const live = b.timers.filter(Boolean).length;
    ok(how + ': the failed push waits ' + b.waits.join(','), live === 1 && b.waits.join(',') === '20000', b.waits);
    b._prefWrite(VIEW, 'tiles'); // another change meanwhile does not hurry it
    ok(how + ': ...and a change meanwhile does not hurry it', b.timers.filter(Boolean).length === 1, b.waits);
    ok(how + ': still pending, nothing lost', b._prefState().pending[THEME] === 1 && b._prefState().pending[VIEW] === 1);
    b.status = 200; b.down = false;
    b.answer = { rev: 2, settings: { [THEME]: { v: 'sepia', r: 1 }, [VIEW]: { v: 'tiles', r: 2 } } };
    const before = b.sent.length;
    await b.fire();
    await settle();
    ok(how + ': when it comes back, one push takes both', b.sent.length === before + 1 && !Object.keys(b._prefState().pending).length, b.sent.length - before);
    await b.fire();
    ok(how + ': and then nothing more', b.sent.length === before + 1);
  }

  // refused: not this account (409) or no account (401): asked whose, no retry
  for (const st of [401, 409]) {
    const b = browser();
    b._accountSet('kid', true);
    b._prefWrite(THEME, 'sepia');
    b.status = st;
    await b.fire();
    await settle();
    ok(st + ': whose account it is, asked again; no retry of the push', b.rechecks === 1 && !b.timers.filter(Boolean).length, { rechecks: b.rechecks, timers: b.timers.filter(Boolean).length });
    ok(st + ': every call names the account', b.sent[0].body.account === 'kid', b.sent[0].body);
  }

  // seeded only once the fill is taken
  {
    const b = browser();
    b.store[LANGS] = '["en","es"]';
    b._accountSet('kid', true);
    b.status = 503;
    b._prefTake({ rev: 0, settings: {} });
    await settle(); await settle();
    ok('a fill that failed leaves the browser unseeded, to fill at the next pull', b._prefState().seeded === false && b.sent.length === 1);
    b.status = 200;
    b.answer = { rev: 1, settings: { [LANGS]: { v: '["en","es"]', r: 1 } } };
    b._prefTake({ rev: 0, settings: {} });
    await settle(); await settle();
    ok('...and seeded once it is taken', b._prefState().seeded === true && b.sent.length === 2 && b.sent[1].body.fill === true);
  }

  if (failures) { console.log(failures + ' FAILED'); process.exit(1); }
  console.log('all settings-sync client checks passed');
})();
