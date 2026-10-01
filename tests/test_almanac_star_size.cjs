// The live sky's stars are points, the way the eye sees them: brightness by
// magnitude carried by intensity, only the brightest few a little wider
// (zimi/static/almanac-sky.js _skyStarLook / _skyStarDevR). Before this, a
// first-magnitude star was a 3.8 px disc and Sirius 4.7 px; on a 3x phone
// that was a 14-device-pixel blob.
//
// Run: node tests/test_almanac_star_size.cjs   (exit 0 = pass)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'almanac-sky.js'), 'utf8');
function extractFn(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}
const consts = src.split('\n').filter((l) => /^var SKY_(STAR|PLANET)_/.test(l)).join('\n');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(consts + '\n' + ['_skyClamp', '_skyStarLook', '_skyStarDevR'].map(extractFn).join('\n'), ctx);
const look = ctx._skyStarLook, devR = ctx._skyStarDevR;

let failures = 0;
const check = (ok, label) => { if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label); };

const sirius = look(-1.46), vega = look(0.03), betelgeuse = look(0.5), polaris = look(1.98), faint = look(4.5), fainter = look(6);
check(sirius.r * 2 <= 2.4, 'Sirius, the brightest star, is under 2.4 CSS px across (' + (sirius.r * 2).toFixed(2) + ')');
check(polaris.r * 2 <= 1.5, 'a second-magnitude star is a point, under 1.5 CSS px across (' + (polaris.r * 2).toFixed(2) + ')');
check(faint.r * 2 <= 1, 'a faint star is at most one CSS px across');
check(fainter.r === faint.r, 'the radius has a floor');
check(sirius.r > vega.r && vega.r > betelgeuse.r && betelgeuse.r >= polaris.r && polaris.r > faint.r, 'brighter is never smaller');
check(sirius.bloom && vega.bloom && !betelgeuse.bloom && !polaris.bloom, 'only stars brighter than magnitude 0.5 bloom');
// Intensity carries the magnitude: across the visible range the brightness
// spread is much larger than the size spread.
check(betelgeuse.k === 1 && faint.k < 0.45, 'intensity falls from 1 to under 0.45 by magnitude 4.5');
check(polaris.r / faint.r < 1.5, 'size varies far less than intensity between magnitudes 2 and 4.5');
// Device pixels, not CSS pixels doubled: a floor in device pixels,
// and a point on a 3x phone is the same CSS size as on a 1x screen.
check(devR(0.1, 1) === ctx.SKY_STAR_MIN_DEV_R && devR(faint.r, 1) >= faint.r, 'at 1x a star is never smaller than its floor in device pixels');
check(Math.abs(devR(polaris.r, 3) / 3 - polaris.r) < 1e-9, 'at 3x the CSS size holds');

// Planets are points too: Jupiter at its brightest is under 3.2 CSS px across
// (it was a 6 px disc with a glow).
check(look(-2.9).r * ctx.SKY_PLANET_R_X * 2 < 3.2, 'Jupiter at its brightest is a point, under 3.2 CSS px across');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
