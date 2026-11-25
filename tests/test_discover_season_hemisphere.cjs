// The home page's season card names the season of the hemisphere the sky is
// drawn for: a chosen place, else the device's time zone, else none at all.
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const appSource = require('./app_source.cjs');
const { extractFn, check, done } = require('./sky_harness.cjs');
const src = appSource();

function ctx(tz, place) {
  const S = {
    Math, Date, JSON, Object, console, String, Number,
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: tz }) }) },
    _almChosenPlace: () => place, t: (k) => k, fmtPct: (n) => Math.round(n) + '%',
    document: { head: { appendChild: () => {} }, createElement: () => ({}) },
    _renderDiscover() {},
  };
  vm.createContext(S);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'zone-places.js'), 'utf8'), S);
  vm.runInContext('var _zonePlacesLoading = false, _discoverDrawn = null;' + extractFn(src, '_almPlaceOrZone') + extractFn(src, '_almHemisphere'), S);
  vm.runInContext(src.slice(src.indexOf('var _SEASONS_NORTH'), src.indexOf('function _todaySeason(')) + extractFn(src, '_todaySeason'), S);
  return (c) => vm.runInContext(c, S);
}
const oct14 = 'new Date(2026, 9, 14)';
const season = (run) => run('_todaySeason(' + oct14 + ', _almHemisphere())');
{
  const sydney = ctx('Australia/Sydney', null);
  check(sydney('_almHemisphere()') === 'south' && /season_spring/.test(season(sydney)), 'a Sydney device in October is in spring, not autumn');
  check(/season_spring/.test(season(ctx('Africa/Windhoek', null))), 'Windhoek too (a zone outside the old table)');
  check(/season_autumn/.test(season(ctx('America/Denver', null))), 'Denver is in autumn');
  const unknown = ctx('Mars/Olympus', null);
  check(unknown('_almHemisphere()') === null && season(unknown) === '', 'a zone nobody knows is given no season');
  check(ctx('America/Denver', { lat: -33.9, lon: 151.2 })('_almHemisphere()') === 'south', 'a chosen place beats the time zone');
}
done();
