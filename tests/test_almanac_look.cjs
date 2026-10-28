// Pointing the phone at the sky (zimi/static/almanac-look.js): the maths from
// what the sensors say to where the person is looking, and what that looks
// at. The overlay and its sensors are tests/test_almanac_look.spec.mjs.
//
//   1. The view from DeviceOrientation (alpha, beta, gamma): the back of the
//      phone is the line of sight. Upright facing a compass point looks at
//      it; tipped back it looks up; flat face up it looks at the ground.
//   2. Screen rotation: the line of sight does not move when the screen
//      turns; the roll does.
//   3. The compass: iOS gives a heading of its own (and says how far to
//      trust it) which corrects alpha; Android's absolute event is alpha.
//   4. Smoothing: a noisy reading settles, across north (359 to 1) without
//      a spin the long way round.
//   5. The whole sphere: pointing down is a view of the sky under the feet (no globe, no Earth
//      link, the sky never fades out), and the maps' compass points.
//   6. The fallbacks: drag, keys and pinch turn the same view.
//
// Run: node tests/test_almanac_look.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'almanac-look.js'), 'utf8');
const ctx = { window: {}, console, Math };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const L = (name) => vm.runInContext(name, ctx);

let failures = 0;
function check(ok, label) {
  if (!ok) { console.error('FAIL: ' + label); failures++; } else console.log('ok: ' + label);
}
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const angNear = (a, b, eps = 0.01) => near(((a - b + 540) % 360 + 360) % 360 - 180, 0, eps);

// ── 1. The view from the orientation ──
const view = L('_lookViewFromEuler');
{
  // alpha is counter-clockwise from north, so heading = 360 - alpha.
  let v = view(0, 90, 0, 0);
  check(angNear(v.az, 0) && near(v.alt, 0), 'upright, alpha 0: looking at the horizon, north');
  v = view(90, 90, 0, 0);
  check(angNear(v.az, 270) && near(v.alt, 0), 'upright, alpha 90: turned a quarter to the left, west');
  v = view(270, 90, 0, 0);
  check(angNear(v.az, 90) && near(v.alt, 0), 'upright, alpha 270: east');
  v = view(180, 90, 0, 0);
  check(angNear(v.az, 180) && near(v.alt, 0), 'upright, alpha 180: south');
  v = view(0, 135, 0, 0);
  check(near(v.alt, 45) && angNear(v.az, 0), 'tipped back 45 degrees: looking 45 up, same way');
  v = view(0, 45, 0, 0);
  check(near(v.alt, -45), 'tipped forward 45 degrees: looking 45 down');
  v = view(0, 0, 0, 0);
  check(near(v.alt, -90), 'flat face up: the back looks straight down');
  v = view(0, 180, 0, 0);
  check(near(v.alt, 90), 'face down overhead: straight up');
}
{
  // Near straight up the back's heading is undefined: the top of the phone
  // says which way, and it must agree with the back's just short of there.
  const almost = view(0, 140, 0, 0);       // 50 degrees up, top pointing back (south)
  const edge = view(0, 170, 0, 0);          // 80 degrees up
  const zenith = view(0, 180, 0, 0);
  check(near(almost.alt, 50, 0.05) && angNear(almost.az, 0, 0.5), '50 up: heading by the back, north');
  check(angNear(edge.az, almost.az, 5), 'heading agrees at 50 and 80 degrees up');
  check(isFinite(zenith.az) && near(zenith.alt, 90), 'at the zenith the heading is a number, not NaN');
  const down = view(0, 2, 0, 0);
  check(isFinite(down.az), 'near flat face up the heading is a number too');
}

// ── 2. Screen rotation ──
{
  const portrait = view(0, 90, 0, 0), landscape = view(0, 90, 0, 90);
  check(angNear(portrait.az, landscape.az) && near(portrait.alt, landscape.alt), 'turning the screen does not move the line of sight');
  check(near(portrait.roll, 0), 'upright in portrait: no roll');
  // Turned a quarter (phone on its side, screen turned with it): the sensor
  // sees gamma = -90 for the same hold; the roll nets out to level.
  const onSide = view(0, 0, -90, 90);
  check(near(Math.abs(onSide.roll), 0, 0.5) && near(onSide.alt, 0) && angNear(onSide.az, 90), 'on its side with the screen turned: level, looking east');
  const otherSide = view(0, 0, 90, 270);
  check(near(Math.abs(otherSide.roll), 0, 0.5) && near(otherSide.alt, 0) && angNear(otherSide.az, 270), 'on the other side: level, looking west');
  // Upright, gamma is a turn about the vertical (the sensor's gimbal): it
  // changes the heading and must not read as roll. Tipped, it is a roll.
  check(near(view(0, 90, 20, 0).roll, 0, 0.5), 'upright, gamma turns the heading and does not roll');
  const tipped = view(0, 60, 20, 0), other = view(0, 60, -20, 0);
  check(Math.abs(tipped.roll) > 5 && near(tipped.roll, -other.roll, 0.01), 'tipped, gamma rolls the screen, left and right opposite');
  check(near(view(0, 60, 0, 0).roll, 0), 'tipped but not rolled: level');
}

// ── 3. The compass ──
const fix = L('_lookHeadingOffset');
{
  // iOS: alpha is relative to wherever the phone woke; the heading it gives
  // says where north is. After correction the view agrees with it.
  const raw = view(100, 90, 0, 0);               // az 260 by alpha alone
  const off = fix(raw.az, 75);                    // but the compass says 75
  check(angNear(raw.az + off, 75), 'the offset carries the alpha view onto the compass heading');
  check(angNear(fix(10, 350), -20), 'offset across north is -20, not 340');
  const apply = L('_lookApplyOffset');
  const again = apply(raw, off);
  check(angNear(again.az, 75) && near(again.alt, raw.alt), 'applying the offset turns the heading and leaves the altitude');
}
{
  // Pointing high at the Moon, iOS's heading swings half a turn; the view must not.
  const next = L('_lookNextOffset');
  check(next(null, 30, 10, 16) === 30, 'the first reading is taken as it is');
  check(next(30, 210, 10, 16) === 30, 'a half-turn flip near level is ignored');
  check(next(30, 200, 70, 16) === 30 && next(30, 60, 70, 1000) === 30, 'pointing high, the held offset stays whatever the compass says');
  const settled = next(30, 40, 10, 400);
  check(settled > 30 && settled < 40, 'near level, a small difference settles toward the compass');
  check(next(30, 100, 10, 1000) > 95, 'near level, a real large difference (a phone woken elsewhere) is followed quickly');
}
{
  const trust = L('_lookCompassNeedsCalibrating');
  check(trust({ accuracy: -1 }) === true, 'iOS accuracy -1: needs calibrating');
  check(trust({ accuracy: 45 }) === true, 'iOS accuracy 45 degrees: needs calibrating');
  check(trust({ accuracy: 10 }) === false, 'iOS accuracy 10 degrees: fine');
  check(trust({ accuracy: null, absolute: true }) === false, 'an absolute reading with no accuracy figure: fine');
  check(trust({ accuracy: null, absolute: false }) === true, 'a relative reading with no compass: not north-aligned');
}

// ── 4. Smoothing ──
const smooth = L('_lookSmooth');
{
  let s = { az: 359, alt: 10, roll: 0 };
  const next = smooth(s, { az: 1, alt: 10, roll: 0 }, 16, 120);
  check(next.az > 359 || next.az < 1, 'from 359 toward 1 goes through north');
  check(angNear(next.az, 359 + 2 * (1 - Math.exp(-16 / 120)), 0.2), 'the step is the exponential share of the 2 degrees');
  s = { az: 0, alt: 0, roll: 0 };
  for (let i = 0; i < 200; i++) s = smooth(s, { az: 90, alt: 30, roll: 0 }, 16, 120);
  check(angNear(s.az, 90, 0.1) && near(s.alt, 30, 0.1), 'it settles on the reading');
  const first = smooth(null, { az: 200, alt: 5, roll: 3 }, 16, 120);
  check(first.az === 200 && first.alt === 5, 'the first reading is taken as it is');
  let noisy = { az: 100, alt: 20, roll: 0 }, max = 0;
  for (let i = 0; i < 300; i++) {
    const j = (i % 2 ? 1 : -1) * 3;
    noisy = smooth(noisy, { az: 100 + j, alt: 20 + j, roll: 0 }, 16, 120);
    max = Math.max(max, Math.abs(noisy.az - 100));
  }
  check(max < 1, 'plus or minus 3 degrees of jitter shows as under 1');
}

// ── 5. The whole sphere ──
{
  const down = view(0, 0, 0, 0);
  check(down.alt < -80, 'a phone held flat, face up, back to the ground: looking straight down (' + down.alt.toFixed(0) + ' deg)');
  check(vm.runInContext('_lookClamp(-120, -90, 90)', ctx) === -90, 'the view can reach straight down');
  const code = src.replace(/\/\/.*$/gm, '');
  check(!/ZimiGlobe|openEarth|earth\/near|look-globe|look-earth|globeEl/.test(code), 'Look has no globe and no link to an Earth view: the sky under you is the sky');
  check(!/skyHost\.style\.opacity/.test(code), 'the sky is never faded out as the phone tips down');
}

// ── 6. The fallbacks ──
{
  const drag = L('_lookDragBy');
  let v = drag({ az: 100, alt: 10 }, 50, 0, 60, 390);
  check(v.az < 100 && near(v.alt, 10), 'dragging right turns the view left (the sky follows the finger)');
  v = drag({ az: 100, alt: 10 }, 0, 50, 60, 390);
  check(v.alt > 10, 'dragging down looks higher');
  v = drag({ az: 5, alt: 85 }, -400, -400, 60, 390);
  check(v.alt >= -90 && v.alt <= 90 && v.az >= 0 && v.az < 360, 'drag stays on the sphere and in 0..360');
  const key = L('_lookKeyBy');
  v = key({ az: 359, alt: 0 }, 'ArrowRight');
  check(angNear(v.az, 4), 'arrow right turns 5 degrees, across north');
  v = key({ az: 10, alt: 88 }, 'ArrowUp');
  check(v.alt === 90, 'arrow up stops at the zenith');
  check(key({ az: 10, alt: 0 }, 'q') === null, 'other keys are not ours');
  const pinch = L('_lookFovByPinch');
  check(near(pinch(60, 100, 200), 30), 'fingers twice as far apart: half the field');
  check(pinch(60, 100, 5000) === L('LOOK_FOV_MIN_DEG'), 'the field stops at its narrowest');
  check(pinch(60, 100, 1) === L('LOOK_FOV_MAX_DEG'), 'and at its widest');
}

// ── 7. Where it points, in words ──
{
  const label = L('_lookCompassPoint');
  check(label(0) === 'N' && label(90) === 'E' && label(180) === 'S' && label(270) === 'W', 'the four points');
  check(label(44) === 'NE' && label(359) === 'N' && label(337) === 'NNW', 'between them, to sixteen');
}

// ── 8. In the person's language ──
{
  check(L('_lookPointName')(90) === 'E', "without the Almanac's letters the point is the plain one");
  ctx._azCompass = (az) => ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'][Math.round(((az % 360) + 360) % 360 / 45) % 8];
  check(L('_lookPointName')(90) === 'O' && L('_lookPointName')(135) === 'SO', 'with them, East is O in German');
}

if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('all passed');
