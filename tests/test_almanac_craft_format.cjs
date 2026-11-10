// A craft model file the parser does not recognise (the ISS's 1.15 format, "ZISS", kept by a browser under the same name) ends at the
// dot with the one line the view already says, and is not asked for again. A file it reads still loads once.
// Run: node tests/test_almanac_craft_format.cjs   (exit 0 = pass)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label);
}
const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'almanac-earth.js'), 'utf8');
function fn(name) {
  const a = src.indexOf('\nfunction ' + name + '(') + 1;
  if (a <= 0) throw new Error(name);
  let i = src.indexOf('{', a), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) return src.slice(a, i + 1); }
  throw new Error(name);
}
function bytes(magic) {
  const b = Buffer.alloc(256);
  b.write(magic, 0, 'latin1');
  b.writeFloatLE(1, 8);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
}
async function world(magic, parse) {
  const hints = [], fetched = [];
  const C = { Math, Promise, Array, Float32Array, Uint8Array, Uint16Array, Uint32Array, DataView, String, Error, setTimeout, clearTimeout,
    _aeCraft: {}, AE_CRAFT_SLOW_MS: 400, _ae: { dirty: false }, _aeKick() {}, _aeT: (k) => k, _aeHideHint() {},
    _aeShowHint: (t) => hints.push(t), _aeCraftUrl: () => '/static/earth/iss-v1.bin',
    fetch: (u) => { fetched.push(u); return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(bytes(magic)) }); } };
  vm.createContext(C);
  vm.runInContext(['_aeCraftLoad'].map(fn).join('\n'), C);
  if (parse) vm.runInContext(fn('_aeCraftParse'), C); else C._aeCraftParse = () => { throw new Error('craft format'); };
  return { C, hints, fetched };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

(async () => {
  // The parser itself: an unknown magic is refused, not read as the other format.
  const refuse = await world('ZISS', true);
  let err = null;
  try { refuse.C._aeCraftParse(bytes('ZISS')); } catch (e) { err = e; }
  check(err && /craft format ZISS/.test(err.message), 'a file in an unknown format (ZISS) is refused by the parser');

  // The loader: one request, one line, then nothing more.
  const w = await world('ZISS', true);
  w.C._aeCraftLoad('iss'); await tick();
  check(w.hints.join() === 'alm_craft_failed' && w.C._aeCraft.iss.failed && w.C._aeCraft.iss.bad && !w.C._aeCraft.iss.loading, 'the view says the one line (a dot) and marks the file as not readable');
  w.C._aeCraftLoad('iss'); w.C._aeCraftLoad('iss'); await tick();
  check(w.fetched.length === 1 && w.hints.length === 1, 'and it is not asked for again, however often the view wants it');

  // A network failure is not that: it may be asked again.
  const n = await world('ZCRF', false);
  n.C.fetch = () => Promise.reject(new Error('offline'));
  n.C._aeCraftLoad('iss'); await tick();
  check(n.C._aeCraft.iss.failed && !n.C._aeCraft.iss.bad, 'a failure to reach the server is not marked unreadable (a later visit asks again)');
  process.exit(failures ? 1 : 0);
})();
