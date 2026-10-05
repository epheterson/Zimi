// A map's visit follows the map (Eric, 2026-10-05: Hawaii opened "in the
// ocean ... every time"). The visit is recorded as the map opens, at its
// first view; Maps reopens the last visit; so the visit has to move with the
// map, or every reopen lands on the first view.
// Run: node tests/test_map_history_follow.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
function grab(name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('missing ' + name);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(at, i + 1);
}
let failures = 0;
const ok = (cond, label) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) failures++; };
const store = { h: [] }, saves = [];
const sb = {
  currentArticle: { zim: 'streetzim_hawaii', path: 'index.html' },
  _histLoad: () => store.h,
  _histSave: () => saves.push(JSON.stringify(store.h)),
  _normMapPos: (p) => String(p),
};
vm.createContext(sb);
vm.runInContext(grab('_histFollowMap'), sb);
store.h = [{ type: 'article', zim: 'streetzim_hawaii', path: 'index.html', pos: 'map=7.00/21.10/-166.50' }];
sb._histFollowMap('map=7.00/20.92/-156.67');
ok(store.h[0].pos === 'map=7.00/20.92/-156.67' && saves.length === 1, 'the visit moves with the map');
sb._histFollowMap('map=7.00/20.92/-156.67');
ok(saves.length === 1, 'the same place is not written again');
store.h = [{ type: 'article', zim: 'wikipedia_en', path: 'A/Hawaii', pos: '' }];
sb._histFollowMap('map=7.00/20.92/-156.67');
ok(store.h[0].pos === '' , 'another page\'s visit is left alone');
if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all map history checks passed');
