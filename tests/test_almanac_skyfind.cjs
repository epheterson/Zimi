// Find in the sky (zimi/static/almanac-skyfind.js): ask for a named thing and
// be led to it. The maths and the lists, in a bare vm (no elements):
//
//   1. Matching. A name, a part of one, an accent-free spelling, a designation
//      (M31, "messier 31") or another name it goes by finds the thing; the
//      closer the match and the brighter the thing, the earlier.
//   2. Where it is. A found thing stands where the live sky has it (the planets,
//      the Sun and the Moon against the positions JPL Horizons gives; a star
//      by the height it reaches over a day, which is 90 - latitude + declination).
//   3. The way to it. The angle to it, the way it lies on the screen, and when
//      it counts as in view.
//   4. The names are the names: every star named here sits within half a degree
//      of the Hipparcos place the navigation tables carry for that name.
//   5. Every string it speaks is in the English file, and the module is loaded
//      by a tap, not with the Almanac.
//
// Run: node tests/test_almanac_skyfind.cjs   (exit 0 = pass)
const fs = require('fs');
const path = require('path');
const { makeSky, read, check, done, STATIC } = require('./sky_harness.cjs');

const sky = makeSky();
const S = sky.S;
S.fetch = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(fs.readFileSync(path.join(STATIC, 'earth', 'constellations-v1.json'), 'utf8'))) });
S._almFocusInstant = undefined;
const en = Object.assign(JSON.parse(fs.readFileSync(path.join(STATIC, 'i18n', 'en.json'), 'utf8')), JSON.parse(fs.readFileSync(path.join(STATIC, 'i18n', 'almanac', 'en.json'), 'utf8')));
// The words as the page has them (the harness's t() answers with the key).
sky.run('function t(k, v) { var s = ' + JSON.stringify(en).replace(/</g, '\\u003c') + '[k] || k; if (v) for (var n in v) s = s.replace("{" + n + "}", v[n]); return s; }');
sky.run('function _almStarKey(n) { return "star:" + n.toLowerCase(); } function _tp(n) { return n; } function _almEsc(s) { return String(s); } function _skyReduceMotion() { return true; } function _azCompass(a) { return ["N","NE","E","SE","S","SW","W","NW"][Math.round(a / 45) % 8]; }');
sky.run(read('almanac-navdata.js') + '; var _navStars = AR_NAV_STARS;');
sky.run(read('almanac-skyfind.js'));

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
function sep(alt1, az1, alt2, az2) {
  const c = Math.sin(alt1 * D2R) * Math.sin(alt2 * D2R) + Math.cos(alt1 * D2R) * Math.cos(alt2 * D2R) * Math.cos((az1 - az2) * D2R);
  return Math.acos(Math.max(-1, Math.min(1, c))) * R2D;
}

(async function main() {
  // The figures load as the sheet's own open does.
  await new Promise((resolve) => { sky.run('_skyLoadConstellations(function () {})'); setTimeout(resolve, 50); });
  const list = sky.run('_sfBuild()');
  const names = (q, n) => sky.run('_sfMatch(_sfBuild(), ' + JSON.stringify(q) + ', ' + (n || 8) + ')').map((f) => f.name);

  // ── 1. Matching ──
  check(names('ven')[0] === 'Venus', '"ven" finds Venus first (' + names('ven').join(', ') + ')');
  check(names('SATURN')[0] === 'Saturn', 'case does not count');
  check(names('m31')[0].indexOf('M31') >= 0 && names('messier 31')[0].indexOf('M31') >= 0, 'M31 and "messier 31" find the Andromeda Galaxy');
  check(names('andromeda').some((n) => /Andromeda Galaxy/.test(n)) && names('andromeda').indexOf('Andromeda') >= 0, '"andromeda" finds the galaxy and the figure (' + names('andromeda').join(', ') + ')');
  check(names('pleiades')[0].indexOf('M45') >= 0 && names('seven sisters')[0].indexOf('M45') >= 0, 'the Pleiades by either name');
  check(names('orion').indexOf('Orion') >= 0 && names('orion').some((n) => /Orion Nebula/.test(n)), '"orion" finds the figure and the nebula');
  check(names('iss')[0] === 'alm_earth_iss_name' || /Space Station|ISS/i.test(names('iss')[0] || ''), '"iss" finds the space station (' + names('iss')[0] + ')');
  check(names('moon')[0] === 'Moon', '"moon" finds the Moon first');
  check(names('north star')[0] === 'Polaris', '"north star" finds Polaris');
  check(names('xyzzy').length === 0 && names('').length === 0, 'nothing for what is not there, nothing for nothing');
  check(sky.run('_sfFold("  Café   Étoile ")') === 'cafe etoile', 'accents and runs of space do not count');
  check(names('sirius')[0] === 'Sirius' && names('sir')[0] === 'Sirius', 'a part of a name');
  check(names('a').length <= 8, 'no more results than a screen has');

  // ── 2. Where it is ──
  const HORIZONS = [['2026-10-01T06:00:00Z', 37.7749, -122.4194, { Saturn: [130.468430, 42.541784], Mars: [34.033903, -23.657360], Jupiter: [18.073736, -34.816966], Uranus: [75.256266, 15.714299] }, [314.372036, -45.950935], [69.894449, 17.062372]]];
  for (const [iso, lat, lon, planets, sunPos, moonPos] of HORIZONS) {
    const at = (id) => sky.run('_sfPosition(_sfFindById(' + JSON.stringify(id) + '), new Date(' + JSON.stringify(iso) + '), ' + lat + ', ' + lon + ')');
    for (const nm of Object.keys(planets)) {
      const p = at('planet:' + nm);
      const d = sep(p.alt, p.az, planets[nm][1], planets[nm][0]);
      check(d < 1, nm + ' is within a degree of Horizons (' + d.toFixed(2) + ' deg)');
    }
    const sun = at('sun'), moon = at('moon');
    check(sep(sun.alt, sun.az, sunPos[1], sunPos[0]) < 1, 'the Sun is where Horizons has it');
    check(sep(moon.alt, moon.az, moonPos[1], moonPos[0]) < 1, 'the Moon is where Horizons has it');
  }
  // A star's greatest height over a day: 90 - latitude + declination (Sirius -16.72, Betelgeuse +7.41; refraction adds a hair).
  const peak = (id, lat) => {
    let best = -90;
    for (let m = 0; m < 1440; m += 4) { const p = sky.run('_sfPosition(_sfFindById(' + JSON.stringify(id) + '), new Date(' + (Date.parse('2026-10-01T00:00:00Z') + m * 60000) + '), ' + lat + ', -122.4194)'); if (p.alt > best) best = p.alt; }
    return best;
  };
  const sirius = list.find((f) => f.name === 'Sirius'), betel = list.find((f) => f.name === 'Betelgeuse');
  check(Math.abs(peak(sirius.id, 37.7749) - (90 - 37.7749 - 16.716)) < 0.4, 'Sirius peaks at 90 - lat + dec over a day');
  check(Math.abs(peak(betel.id, 37.7749) - (90 - 37.7749 + 7.407)) < 0.4, 'Betelgeuse peaks at 90 - lat + dec over a day');
  check(Math.abs(peak(sirius.id, -33.8688) - (90 - 33.8688 - 16.716)) < 0.4 || Math.abs(peak(sirius.id, -33.8688) - (90 - Math.abs(-33.8688 - -16.716))) < 0.4, 'and from Sydney (south of it) at 90 - |lat - dec|');
  const m31 = list.find((f) => /M31/.test(f.name));
  check(Math.abs(peak(m31.id, 37.7749) - (90 - 37.7749 + 41.269)) < 0.4 || peak(m31.id, 37.7749) > 85, 'M31 peaks where its declination says (' + peak(m31.id, 37.7749).toFixed(1) + ' deg)');
  const orion = list.find((f) => f.kind === 'con' && f.name === 'Orion');
  check(orion && Math.abs(peak(orion.id, 37.7749) - (90 - 37.7749 + 5)) < 12, 'a constellation stands where its figure does (Orion peaks near ' + peak(orion.id, 37.7749).toFixed(1) + ' deg)');
  check(sky.run('_sfPosition(_sfFindById("iss"), new Date("2026-10-01T06:00:00Z"), 37.77, -122.42)') === null, 'the space station, its elements not loaded, is not placed');

  // ── With nothing typed: what is up and bright ──
  const sugg = sky.run('_sfSuggest(_sfBuild(), new Date("2026-10-01T06:00:00Z"), 37.7749, -122.4194)').map((f) => f.name);
  check(sugg.indexOf('Moon') >= 0 && sugg.indexOf('Saturn') >= 0 && sugg.indexOf('Mars') < 0 && sugg.indexOf('Sun') < 0 && sugg.indexOf('Uranus') < 0, 'the offer is the Moon and Saturn: up; not Mars or the Sun: down, not Uranus (found by name only) (' + sugg.join(', ') + ')');

  // ── 3. The way to it ──
  const g = (view, pos) => sky.run('_sfGuide(' + JSON.stringify(view) + ', ' + JSON.stringify(pos) + ')');
  const south = { az: 180, alt: 0, fov: 60 };
  let r = g(south, { az: 180, alt: 30 });
  check(Math.abs(r.sep - 30) < 1e-6 && (r.angle < 0.01 || r.angle > 359.99) && !r.inView, 'straight above the view: 30 degrees, the arrow up');
  r = g(south, { az: 270, alt: 0 });
  check(Math.abs(r.sep - 90) < 1e-6 && Math.abs(r.angle - 90) < 0.01, 'west of a view toward the south: 90 degrees, the arrow to the right');
  r = g(south, { az: 90, alt: 0 });
  check(Math.abs(r.angle - 270) < 0.01, 'east of it: the arrow to the left');
  r = g(south, { az: 183, alt: 2 });
  check(r.inView && r.sep < 4, 'a few degrees off the middle is in view');
  r = g(south, { az: 0, alt: 0 });
  check(Math.abs(r.sep - 180) < 1e-6, 'directly behind: 180 degrees');
  r = g({ az: 180, alt: 60, fov: 60 }, { az: 180, alt: 90 });
  check(Math.abs(r.sep - 30) < 1e-6 && (r.angle < 0.01 || r.angle > 359.99), 'looking up at 60: the zenith is 30 degrees on, and up the screen');
  r = g({ az: 90, alt: 0, fov: 60 }, { az: 90, alt: -20 });
  check(Math.abs(r.sep - 20) < 1e-6 && Math.abs(r.angle - 180) < 0.01, 'below the view: the arrow down');

  // ── 4. The names are the names ──
  const nav = {};
  for (const n of sky.run('_navStars')) nav[n[1].toLowerCase()] = n;
  let checked = 0;
  for (const f of list.filter((x) => x.kind === 'star')) {
    const want = nav[f.name.toLowerCase()];
    if (!want) continue;
    const star = sky.run('_STARS[' + f.idx + ']'), d = sep(star[1], star[0] * 15, want[3], want[2]);
    checked++;
    check(d < 0.5, f.name + ' is the star at its place in the tables (' + d.toFixed(2) + ' deg)');
  }
  check(checked >= 28, 'most of the names could be checked (' + checked + ')');
  check(list.filter((x) => x.kind === 'star').length >= 45, 'about fifty stars are named');
  check(sky.run('new Set(Object.keys(SF_EXTRA_STAR_NAMES).concat(Object.keys(_STAR_NAMES)).map(Number)).size') === sky.run('Object.keys(SF_EXTRA_STAR_NAMES).length + Object.keys(_STAR_NAMES).length'), 'no star is named twice');

  // ── 5. Its words, and when it loads ──
  const src = read('almanac-skyfind.js'), used = new Set();
  for (const m of src.matchAll(/'(sky_find_[a-z_]+)'/g)) used.add(m[1]);
  for (const k of Object.keys(sky.run('SF_KIND_KEYS')).map((x) => sky.run('SF_KIND_KEYS')[x])) used.add(k);
  const missing = [...used].filter((k) => !en[k]);
  check(used.size >= 12 && !missing.length, 'every string it speaks is in the English file (' + used.size + ' keys' + (missing.length ? ', missing ' + missing.join(', ') : '') + ')');
  const app = read('app.js');
  check(/function openAlmanacFind\(/.test(app) && /almanac-skyfind\.js\?v=/.test(app) && !/_ALMANAC_MODULES = \[[^\]]*skyfind/.test(fs.readFileSync(path.join(STATIC, '..', 'templates', 'index.html'), 'utf8')), 'it is loaded by a tap on a Find button, not with the Almanac');
  check(/almanac-skyfind\.js/.test(fs.readFileSync(path.join(STATIC, '..', 'http.py'), 'utf8')), 'and a change to it busts the service worker cache');
  // Find is the phone-motion view's and nowhere else: not on the live sky, not on the star chart, not in the page.
  const code = (name) => read(name).replace(/\/\/.*$/gm, '');
  check(!/openAlmanacFind|data-sky-find|_skyEnsureFindButton|_sfChartMark|_sfTurnChart|alm-sc-tool/.test(code('almanac-sky.js')), 'the live sky and the star chart have no Find');
  check(!/openAlmanacFind/.test(code('almanac.js')), 'the page has no way into Find');
  check(/openAlmanacFind\('look'\)/.test(code('almanac-look.js')), 'Look has it');
  check(!/_sfChipHost|sf-chip'|data-sf-point|_sfPointPhone/.test(code('almanac-skyfind.js')), 'no chip on the page, no point-your-phone button');
  done();
})();
