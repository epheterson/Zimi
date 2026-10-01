// The Moon's shared model as app.js defines it, for a test that runs the
// Almanac's files without the whole of app.js: the maps' URLs and the light
// (_moonLunarL, _moonLunarLambert, _moonEarthshine, _moonDisplay) that every
// 2D Moon is drawn with and almanac-earth.js writes its shader from.
//
// moonModelSource(): app.js's text for those, to run before almanac-earth.js.

const fs = require('fs');
const path = require('path');

const VARS = ['_MOON_MAP_URL', '_MOON_MAP_HI_URL', '_MOON_LUNAR_L', '_MOON_DISPLAY_GAMMA', '_MOON_ROUGH_MU',
  '_MOON_EARTHSHINE_MAX', '_MOON_EARTHSHINE_FLOOR'];
const FNS = ['_smoothstep', '_moonLunarL', '_moonLunarLambert', '_moonEarthshine', '_moonDisplay'];

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced braces extracting ' + name);
}

module.exports = function moonModelSource() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
  const vars = VARS.map((name) => {
    const m = src.match(new RegExp('^var ' + name + ' = [^\\n]*;', 'm'));
    if (!m) throw new Error('var ' + name + ' not found');
    return m[0];
  });
  return vars.concat(FNS.map((name) => extractFn(src, name))).join('\n');
};
