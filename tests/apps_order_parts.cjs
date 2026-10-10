// The parts of app.js that put the apps in the library's order (#100), for
// the tests that run the apps row or the Apps page outside a browser. Call it
// once the context holds the apps' own parts (the _installed* readers and
// each app's tile): the tile map is built from them.
//
// loadAppsOrder(src, ctx): src is app.js, ctx a vm context. A context without
// a localStorage gets one, so the order is the default until a test sets it.

const vm = require('vm');

const PARTS = [
  /function _zimChangedAt\(z\) \{[^\n]*\n/,
  /function _byFirstSeenDesc\(a, b\) \{[^\n]*\n/,
  /function _byUpdatedDesc\(a, b\) \{[^\n]*\n/,
  /var LIBRARY_SORTS = [^\n]*\n/,
  /function _librarySort\(\) \{[\s\S]*?\n\}/,
  /var _LIBRARY_SORTERS = \{[\s\S]*?\n\};/,
  /function _sortLibrary\(list\) \{[\s\S]*?\n\}/,
  /function _appTitle\(app\) \{[^\n]*\n/,
  /function _appZims\(app\) \{[\s\S]*?\n\}/,
  /var _APP_TILES = [^\n]*\n/,
  /var _APP_SORT_DATE = \{[\s\S]*?\n\};/,
  /function _appSortValue\(app, mode\) \{[\s\S]*?\n\}/,
  /function _appsByName\(apps\) \{[\s\S]*?\n\}/,
  /function _sortApps\(apps\) \{[\s\S]*?\n\}/,
  /function _shownApps\(\) \{[^\n]*\n/,
  /function _appsZimNames\(\) \{[\s\S]*?\n\}/,
  /function _appsGridHtml\(tiles\) \{[\s\S]*?\n\}/,
  /var _CAT_HEAD_OPENS = [^\n]*\n/,
];

module.exports = function loadAppsOrder(src, ctx) {
  if (!ctx.SK) ctx.SK = {};
  if (!ctx.SK.LIBRARY_SORT) ctx.SK.LIBRARY_SORT = 'zimi_library_sort';
  if (!ctx.localStorage) {
    const store = {};
    ctx.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  }
  vm.runInContext(PARTS.map(re => {
    const m = src.match(re);
    if (!m) throw new Error('could not extract ' + re + ' from app.js');
    return m[0];
  }).join('\n'), ctx);
};
