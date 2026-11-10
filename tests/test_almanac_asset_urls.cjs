// A /static data file reaches the page through _almAsset (app.js), so its address changes when its content does.
//
// The server sends /static as immutable for a year. In 1.16 fourteen files under static/earth changed content under their old
// names (iss-v1.bin from one format to another, the craft models, four moons' maps, the landmarks and the probes' tables): a browser
// that had used 1.15 kept the old file and the new parser failed on it. A file is now asked for as <path>?v=<its content hash>
// (the server's __ZIMI_CONFIG.assets), or the build's when it lists none.
//
//   1. the helper: the hash of the file when listed, else the build, else nothing (the Almanac inside its own ZIM); it replaces a query
//      and keeps a relative path relative; a different hash is a different address.
//   2. the guard: no almanac*.js, app.js or other page script names a /static data file in a string without passing it through the
//      helper. Libraries whose name carries their version (three-r186, satellite-7.1.0, temml ?v=0.13.5) are the exception.
//
// Run: node tests/test_almanac_asset_urls.cjs   (exit 0 = pass)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label);
}
const STATIC = path.join(__dirname, '..', 'zimi', 'static');
const app = fs.readFileSync(path.join(STATIC, 'app.js'), 'utf8');

// ── The helper ──
{
  const a = app.indexOf('\nfunction _almAsset(') + 1;
  let i = app.indexOf('{', a), d = 0;
  for (; i < app.length; i++) { if (app[i] === '{') d++; else if (app[i] === '}' && --d === 0) break; }
  const code = app.slice(a, i + 1);
  const asset = (cfg) => { const C = { String, encodeURIComponent, window: cfg === undefined ? {} : { __ZIMI_CONFIG: cfg } }; vm.createContext(C); vm.runInContext(code, C); return C._almAsset; };
  const f = asset({ build: 'zimi-v1.16.0-abc', assets: { 'earth/iss-v1.bin': 'a1b2c3d4' } });
  check(f('/static/earth/iss-v1.bin') === '/static/earth/iss-v1.bin?v=a1b2c3d4', 'a listed file carries its own content hash');
  check(f('/static/earth/other-v1.bin') === '/static/earth/other-v1.bin?v=zimi-v1.16.0-abc', 'one the server did not list carries the build');
  check(f('/static/almanac-sun.js?v=45') === '/static/almanac-sun.js?v=zimi-v1.16.0-abc', 'a query on the address is replaced');
  const g = asset({ build: 'zimi-v1.16.0-abc', assets: { 'earth/iss-v1.bin': 'ffffffff' } });
  check(g('/static/earth/iss-v1.bin') !== f('/static/earth/iss-v1.bin'), 'a changed file is a different address');
  const h = asset({ build: 'zimi-v1.16.1-abc', assets: {} });
  check(h('/static/earth/other-v1.bin') !== f('/static/earth/other-v1.bin'), 'and an unlisted file follows the build');
  check(asset({})('static/earth/iss-v1.bin') === 'static/earth/iss-v1.bin' && asset(undefined)('/static/earth/iss-v1.bin') === '/static/earth/iss-v1.bin', 'the Almanac inside its ZIM has no config: the path stays as it is, relative or not');
  check(f('static/earth/iss-v1.bin') === 'static/earth/iss-v1.bin?v=a1b2c3d4', 'a relative path stays relative');
}

// ── The guard ──
{
  // Named for their version: a new version is a new name.
  const EXEMPT = /\/static\/(?:earth\/three-r\d+\.min\.js|earth\/satellite-[\d.]+\.min\.js|temml\/[\w.-]+\?v=[\d.]+|fieldguide-offline\.json)/;   // and the Field Guide's bundle, which the server makes from its own tables
  const files = fs.readdirSync(STATIC).filter((f) => /\.js$/.test(f) && /^(almanac|app$|capability|onesky|stand|fieldguide-card)/.test(f.replace(/\.js$/, '')));
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|\s)\/\/\s.*$/gm, '$1');
  const bad = [];
  let sites = 0;
  files.forEach((f) => {
    const text = stripComments(fs.readFileSync(path.join(STATIC, f), 'utf8'));
    const re = /(\/?static\/[\w./-]*)/g;
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 40), m.index), after = text.slice(m.index, m.index + 90);
      if (!/['"]$/.test(before)) continue;   // inside a string only (a quote opens it)
      if (EXEMPT.test(after)) continue;
      // app.js's own script addresses (?v=N) are rewritten to content hashes by the server; there only data files are the page's to version.
      const addr = (after.match(/^[\w./-]+/) || [''])[0];
      if (f === 'app.js' && !/\.(?:bin|json|webp|jpe?g|png|svg|glb)$/.test(addr)) continue;
      if (/\/$/.test(addr)) continue;   // a folder, as a prefix test (indexOf('/static/')), not an address
      sites++;
      if (!/_almAsset\(\s*['"]$/.test(before)) bad.push(f + ': ' + (before.slice(-14) + after.slice(0, 40)).replace(/\n/g, ' '));
    }
  });
  check(files.length >= 10 && sites >= 10, 'scanned ' + files.length + ' scripts, ' + sites + ' /static addresses');
  check(bad.length === 0, 'every /static data address in the page scripts passes through _almAsset' + (bad.length ? ': ' + bad.slice(0, 5).join(' | ') : ''));
}
process.exit(failures ? 1 : 0);
