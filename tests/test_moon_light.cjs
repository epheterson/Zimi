// The Moon's light: one model (app.js) for the 2D discs and the 3D view's
// shader, and the look it promises.
//   - the full Moon is a flat disc (lunar-Lambert at zero phase), not a ball
//     darkening to its rim;
//   - the terminator is a gradual fade, not a line (Eric, 2026-09-30: "soften
//     terminator to match reality", against his phone photo of an 84% waning
//     gibbous): the shown brightness climbs over many degrees of sunlight;
//   - earthshine follows the Earth's phase seen from the Moon: brightest at
//     new Moon, gone (to the outline's floor) at full;
//   - almanac-earth.js writes its shader from these same constants.
// Run: node tests/test_moon_light.cjs

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; }
  else console.log('ok: ' + label);
}

const S = { Math, console };
vm.createContext(S);
vm.runInContext(require('./moon_model.cjs')(), S);
const run = (code) => vm.runInContext(code, S);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Full Moon: the Sun behind the viewer, mu0 = mu everywhere on the disc.
const L0 = run('_moonLunarL(1)');
check(L0 === 1, 'at zero phase L is 1: all Lommel-Seeliger');
const full = [1, 0.7, 0.4].map((mu) => run('_moonLunarLambert(' + mu + ', ' + mu + ', 1)'));
check(near(full[0], 1, 1e-9) && near(full[1], 1, 1e-9),
  'the full Moon is as bright at 45 degrees from its centre as at it (' + full.map((x) => x.toFixed(3)) + ')');

// The terminator: nothing past it, and a fade, not a step, before it.
check(run('_moonLunarLambert(0, 0.7, 0.5)') === 0 && run('_moonLunarLambert(-0.1, 0.7, 0.5)') === 0,
  'no sunlight past the terminator');
const L = run('_moonLunarL(2 * 0.84 - 1)');   // 84% lit: Eric's photo
const shown = (mu0) => run('_moonDisplay(_moonLunarLambert(' + mu0 + ', 0.6, ' + L + '))');
const lit = shown(0.6);
const deg = (d) => Math.sin(d * Math.PI / 180);
check(shown(deg(2)) < 0.25 * lit, 'two degrees of sunlight shows under a quarter of the lit side (' + (shown(deg(2)) / lit).toFixed(2) + ')');
check(shown(deg(6)) > 0.25 * lit && shown(deg(6)) < 0.85 * lit,
  'six degrees is part way up the fade, not at either end (' + (shown(deg(6)) / lit).toFixed(2) + ')');
let mono = true;
for (let d = 0.5; d < 30; d += 0.5) if (shown(deg(d + 0.5)) < shown(deg(d))) mono = false;
check(mono, 'and it only climbs, the Sun rising');

// Earthshine follows the Earth's phase.
const es = (k) => run('_moonEarthshine(' + (2 * k - 1) + ')');
check(es(0.02) > es(0.25) && es(0.25) > es(0.84) && es(0.84) > es(1), 'earthshine fades from crescent to full');
check(near(es(1), run('_MOON_EARTHSHINE_FLOOR'), 1e-9), 'at full Moon only the dark limb\'s outline is left');
check(run('_moonDisplay(_moonEarthshine(-0.76))') < 0.25, 'and beside a crescent it stays faint on the screen');

// The 3D view's shader is written from the same constants.
const earth = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'almanac-earth.js'), 'utf8');
check(/_aeGlslNum\(_MOON_LUNAR_L\[3\]\)/.test(earth) && /_aeGlslNum\(_MOON_ROUGH_MU\)/.test(earth) &&
  /1 \/ _MOON_DISPLAY_GAMMA/.test(earth) && /_moonEarthshine\(/.test(earth),
  'almanac-earth.js builds its Moon shader from app.js\'s model');

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all passed');
