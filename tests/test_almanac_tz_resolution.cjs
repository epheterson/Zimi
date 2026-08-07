// DOM-free regression test for the almanac's lat/lon -> timezone resolver
// (_almTzForLocation + _TZ_ANCHORS).
//
// There is no offline tz database in Zimi, so the resolver picks the nearest of
// a curated anchor list. Two properties are guarded:
//
//   1. Longitude is compared in RAW degrees, NOT scaled by cos(lat). Scaling is
//      what a true surface distance wants, but timezones are longitude bands:
//      the shrink de-weights the only axis that decides the answer, and it grows
//      without bound toward the poles. At 69.7degN cos(lat) is 0.35, so northern
//      Norway scored 6deg of longitude error as 2deg and resolved to Helsinki,
//      a full zone east, silently shifting every sunrise/sunset there.
//   2. Resolution is correct in the only sense the app uses it: the resolved
//      zone's UTC OFFSET must match the true zone's, in BOTH January and July.
//      The app never displays the zone string, it only feeds _tzUtcOffsetMin,
//      so America/Toronto standing in for America/Detroit is fine while
//      America/Phoenix standing in for America/Denver is not — same offset in
//      January, an hour apart in July. Checking both months is what separates
//      them.
//
// The city list mixes places whose zones are anchors, places in zones with no
// anchor at all, and places straddling zone boundaries. Nearest-anchor
// resolution is LOCAL, so an added anchor can only change answers near itself;
// that is what makes this list a real gate on anchor edits rather than a smoke
// test.
//
// Pure-helper approach, matching tests/test_reader_font.cjs: pull the anchor
// table and the resolver straight out of almanac.js by source markers and eval
// them in a sandbox, so the test drives the shipped code rather than a copy.
//
// Run: node tests/test_almanac_tz_resolution.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ALMANAC_JS = path.join(__dirname, '..', 'zimi', 'static', 'almanac.js');
const src = fs.readFileSync(ALMANAC_JS, 'utf8');

function extract(re, label) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + label + ' from almanac.js');
  return m[0];
}

const cAnchors = extract(/var _TZ_ANCHORS = \[[\s\S]*?\n\];/, '_TZ_ANCHORS');
const fResolve = extract(/function _almTzForLocation\(lat, lon\)\s*\{[\s\S]*?\n\}/, '_almTzForLocation');
// The resolver does not use DEG_TO_RAD any more, but the sandbox still defines
// it. Otherwise reintroducing the cos(lat) longitude shrink would blow up with
// a ReferenceError here instead of failing the Tromso guard below, and the
// error message would point at the test rather than at the defect.
const cDegToRad = extract(/var DEG_TO_RAD = [^;]+;/, 'DEG_TO_RAD');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(cDegToRad + '\n' + cAnchors + '\n' + fResolve, sandbox);
const resolve = sandbox._almTzForLocation;
const anchors = sandbox._TZ_ANCHORS;

// --- the yardstick ---------------------------------------------------------
// Offset of a zone at an instant, the same way zimi/static/almanac.js computes
// it (_tzUtcOffsetMin): format the instant in the zone and in UTC, subtract.
function offsetMin(tz, date) {
  const opts = {
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
  };
  const fmt = (z) => new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: z }, opts)).format(date);
  return Math.round((new Date(fmt(tz)) - new Date(fmt('UTC'))) / 60000);
}

const JAN = new Date(Date.UTC(2026, 0, 15, 12));
const JUL = new Date(Date.UTC(2026, 6, 15, 12));

// [name, lat, lon, true IANA zone]
const CITIES = [
  // High latitude, where the cos(lat) shrink did its worst damage.
  ['Tromso', 69.65, 18.96, 'Europe/Oslo'],
  ['Bodo', 67.28, 14.40, 'Europe/Oslo'],
  ['Kiruna', 67.86, 20.23, 'Europe/Stockholm'],
  ['Rovaniemi', 66.50, 25.73, 'Europe/Helsinki'],
  ['Murmansk', 68.97, 33.08, 'Europe/Moscow'],
  ['Reykjavik', 64.15, -21.94, 'Atlantic/Reykjavik'],
  ['Fairbanks', 64.84, -147.72, 'America/Anchorage'],
  // Europe, including the wide-CET case that a sparse anchor list misroutes.
  ['Oslo', 59.91, 10.75, 'Europe/Oslo'],
  ['Bergen', 60.39, 5.32, 'Europe/Oslo'],
  ['Stavanger', 58.97, 5.73, 'Europe/Oslo'],
  ['Gothenburg', 57.71, 11.97, 'Europe/Stockholm'],
  ['Malmo', 55.60, 13.00, 'Europe/Stockholm'],
  ['Copenhagen', 55.68, 12.57, 'Europe/Copenhagen'],
  ['Tallinn', 59.44, 24.75, 'Europe/Tallinn'],
  ['Riga', 56.95, 24.11, 'Europe/Riga'],
  ['Turku', 60.45, 22.27, 'Europe/Helsinki'],
  ['StPetersburg', 59.93, 30.34, 'Europe/Moscow'],
  ['Berlin', 52.52, 13.40, 'Europe/Berlin'],
  ['Munich', 48.14, 11.58, 'Europe/Berlin'],
  ['Hamburg', 53.55, 9.99, 'Europe/Berlin'],
  ['Frankfurt', 50.11, 8.68, 'Europe/Berlin'],
  ['Vienna', 48.21, 16.37, 'Europe/Vienna'],
  ['Prague', 50.08, 14.44, 'Europe/Prague'],
  ['Bratislava', 48.15, 17.11, 'Europe/Bratislava'],
  ['Ljubljana', 46.06, 14.51, 'Europe/Ljubljana'],
  ['Zagreb', 45.81, 15.98, 'Europe/Zagreb'],
  ['Skopje', 41.99, 21.43, 'Europe/Skopje'],
  ['Budapest', 47.50, 19.04, 'Europe/Budapest'],
  ['Krakow', 50.06, 19.94, 'Europe/Warsaw'],
  ['Gdansk', 54.35, 18.65, 'Europe/Warsaw'],
  ['Milan', 45.46, 9.19, 'Europe/Rome'],
  ['Naples', 40.85, 14.27, 'Europe/Rome'],
  ['Marseille', 43.30, 5.37, 'Europe/Paris'],
  ['Brussels', 50.85, 4.35, 'Europe/Brussels'],
  ['Barcelona', 41.39, 2.17, 'Europe/Madrid'],
  ['Seville', 37.39, -5.98, 'Europe/Madrid'],
  ['Porto', 41.15, -8.61, 'Europe/Lisbon'],
  ['Edinburgh', 55.95, -3.19, 'Europe/London'],
  ['Belfast', 54.60, -5.93, 'Europe/London'],
  ['Cardiff', 51.48, -3.18, 'Europe/London'],
  ['Manchester', 53.48, -2.24, 'Europe/London'],
  ['Thessaloniki', 40.64, 22.94, 'Europe/Athens'],
  ['Sofia', 42.70, 23.32, 'Europe/Sofia'],
  ['Odesa', 46.48, 30.72, 'Europe/Kyiv'],
  ['Ankara', 39.93, 32.86, 'Europe/Istanbul'],
  // Americas, including the Phoenix/Denver same-offset-different-DST trap.
  ['ElPaso', 31.76, -106.49, 'America/Denver'],
  ['Tucson', 32.22, -110.97, 'America/Phoenix'],
  ['SaltLake', 40.76, -111.89, 'America/Denver'],
  ['Calgary', 51.05, -114.07, 'America/Edmonton'],
  ['Seattle', 47.61, -122.33, 'America/Los_Angeles'],
  ['Portland', 45.52, -122.68, 'America/Los_Angeles'],
  ['SanFrancisco', 37.77, -122.42, 'America/Los_Angeles'],
  ['SanDiego', 32.72, -117.16, 'America/Los_Angeles'],
  ['Houston', 29.76, -95.37, 'America/Chicago'],
  ['Dallas', 32.78, -96.80, 'America/Chicago'],
  ['Nashville', 36.16, -86.78, 'America/Chicago'],
  ['KansasCity', 39.10, -94.58, 'America/Chicago'],
  ['Omaha', 41.26, -95.93, 'America/Chicago'],
  ['Minneapolis', 44.98, -93.27, 'America/Chicago'],
  ['Winnipeg', 49.90, -97.14, 'America/Winnipeg'],
  ['Atlanta', 33.75, -84.39, 'America/New_York'],
  ['Charlotte', 35.23, -80.84, 'America/New_York'],
  ['Miami', 25.76, -80.19, 'America/New_York'],
  ['Boston', 42.36, -71.06, 'America/New_York'],
  ['Detroit', 42.33, -83.05, 'America/Detroit'],
  ['Montreal', 45.50, -73.57, 'America/Toronto'],
  ['Ottawa', 45.42, -75.70, 'America/Toronto'],
  ['Guadalajara', 20.66, -103.35, 'America/Mexico_City'],
  ['Monterrey', 25.69, -100.32, 'America/Monterrey'],
  ['Guatemala', 14.63, -90.51, 'America/Guatemala'],
  ['Quito', -0.18, -78.47, 'America/Guayaquil'],
  ['Caracas', 10.48, -66.90, 'America/Caracas'],
  ['LaPaz', -16.50, -68.15, 'America/La_Paz'],
  ['RioDeJaneiro', -22.91, -43.17, 'America/Sao_Paulo'],
  ['Recife', -8.05, -34.88, 'America/Recife'],
  ['Cordoba', -31.42, -64.18, 'America/Argentina/Buenos_Aires'],
  ['Rosario', -32.95, -60.64, 'America/Argentina/Buenos_Aires'],
  ['Montevideo', -34.90, -56.16, 'America/Montevideo'],
  // Africa / Middle East.
  ['CapeTown', -33.92, 18.42, 'Africa/Johannesburg'],
  ['Durban', -29.86, 31.02, 'Africa/Johannesburg'],
  ['Accra', 5.60, -0.19, 'Africa/Accra'],
  ['Abuja', 9.06, 7.49, 'Africa/Lagos'],
  ['Dakar', 14.72, -17.47, 'Africa/Dakar'],
  ['Addis', 9.03, 38.74, 'Africa/Addis_Ababa'],
  ['Kampala', 0.35, 32.58, 'Africa/Kampala'],
  ['DarEsSalaam', -6.79, 39.21, 'Africa/Dar_es_Salaam'],
  ['Harare', -17.83, 31.05, 'Africa/Harare'],
  ['Kinshasa', -4.44, 15.27, 'Africa/Kinshasa'],
  ['Algiers', 36.75, 3.06, 'Africa/Algiers'],
  ['Tunis', 36.81, 10.18, 'Africa/Tunis'],
  ['Marrakesh', 31.63, -8.01, 'Africa/Casablanca'],
  ['Jerusalem', 31.77, 35.21, 'Asia/Jerusalem'],
  ['Beirut', 33.89, 35.50, 'Asia/Beirut'],
  ['Baghdad', 33.31, 44.36, 'Asia/Baghdad'],
  ['KuwaitCity', 29.38, 47.99, 'Asia/Kuwait'],
  ['Doha', 25.29, 51.53, 'Asia/Qatar'],
  ['Muscat', 23.59, 58.41, 'Asia/Dubai'],
  ['Mashhad', 36.30, 59.61, 'Asia/Tehran'],
  // Asia / Oceania.
  ['Kabul', 34.56, 69.21, 'Asia/Kabul'],
  ['Tashkent', 41.30, 69.24, 'Asia/Tashkent'],
  ['Lahore', 31.55, 74.34, 'Asia/Karachi'],
  ['Delhi', 28.61, 77.21, 'Asia/Kolkata'],
  ['Chennai', 13.08, 80.27, 'Asia/Kolkata'],
  ['Bangalore', 12.97, 77.59, 'Asia/Kolkata'],
  ['Colombo', 6.93, 79.86, 'Asia/Colombo'],
  ['Chittagong', 22.36, 91.78, 'Asia/Dhaka'],
  ['Hanoi', 21.03, 105.85, 'Asia/Ho_Chi_Minh'],
  ['HoChiMinh', 10.82, 106.63, 'Asia/Ho_Chi_Minh'],
  ['PhnomPenh', 11.56, 104.92, 'Asia/Phnom_Penh'],
  ['KualaLumpur', 3.14, 101.69, 'Asia/Kuala_Lumpur'],
  ['Surabaya', -7.25, 112.75, 'Asia/Jakarta'],
  ['Denpasar', -8.65, 115.22, 'Asia/Makassar'],
  ['Cebu', 10.32, 123.89, 'Asia/Manila'],
  ['Beijing', 39.90, 116.41, 'Asia/Shanghai'],
  ['Guangzhou', 23.13, 113.26, 'Asia/Shanghai'],
  ['Chengdu', 30.57, 104.07, 'Asia/Shanghai'],
  ['Harbin', 45.80, 126.53, 'Asia/Shanghai'],
  ['Taipei', 25.03, 121.57, 'Asia/Taipei'],
  ['Osaka', 34.69, 135.50, 'Asia/Tokyo'],
  ['Nagoya', 35.18, 136.91, 'Asia/Tokyo'],
  ['Sapporo', 43.06, 141.35, 'Asia/Tokyo'],
  ['Busan', 35.18, 129.08, 'Asia/Seoul'],
  ['Darwin', -12.46, 130.85, 'Australia/Darwin'],
  ['Melbourne', -37.81, 144.96, 'Australia/Melbourne'],
  ['Canberra', -35.28, 149.13, 'Australia/Sydney'],
  ['Cairns', -16.92, 145.77, 'Australia/Brisbane'],
  ['Hobart', -42.88, 147.33, 'Australia/Hobart'],
  ['Christchurch', -43.53, 172.64, 'Pacific/Auckland'],
  ['Dunedin', -45.87, 170.50, 'Pacific/Auckland'],
  ['Wellington', -41.29, 174.78, 'Pacific/Auckland'],
  // Remote and fractional island zones — the sun map plots a clickable dot in
  // every distinct UTC-offset zone (tests/test_tz_borders.cjs gates that), and
  // each dot must also resolve to the right IANA zone here. Fiji and Apia are
  // the anchor-shadow cases: without their own anchors Suva falls to Noumea
  // (+11, an hour off) and Samoa to Pago Pago (a full day off).
  ['PagoPago', -14.28, -170.70, 'Pacific/Pago_Pago'],
  ['Apia', -13.83, -171.77, 'Pacific/Apia'],
  ['Taiohae', -8.91, -140.10, 'Pacific/Marquesas'],
  ['StJohns', 47.56, -52.71, 'America/St_Johns'],
  ['Grytviken', -54.28, -36.51, 'Atlantic/South_Georgia'],
  ['PontaDelgada', 37.74, -25.67, 'Atlantic/Azores'],
  ['Eucla', -31.68, 128.89, 'Australia/Eucla'],
  ['LordHowe', -31.55, 159.08, 'Australia/Lord_Howe'],
  ['Noumea', -22.28, 166.46, 'Pacific/Noumea'],
  ['KingstonNorfolk', -29.06, 167.96, 'Pacific/Norfolk'],
  ['Suva', -17.77, 177.97, 'Pacific/Fiji'],
  ['WaitangiChatham', -43.95, -176.56, 'Pacific/Chatham'],
  ['Nukualofa', -21.14, -175.20, 'Pacific/Tongatapu'],
  ['Kiritimati', 1.87, -157.43, 'Pacific/Kiritimati'],
];

// Known residuals: real zone boundaries too fine for anchor resolution to
// split. Listed rather than deleted so the gap stays visible, and so a future
// anchor that fixes one shows up as a surprise pass here.
const KNOWN_RESIDUALS = {
  // Jordan (UTC+3, no DST) has no anchor; Cairo is the nearest and follows
  // Egypt's DST.
  Amman: [31.96, 35.94, 'Asia/Amman'],
  // Kolkata sits ~2deg of longitude from Dhaka across an international border,
  // inside India's own half-hour offset.
  Kolkata: [22.57, 88.36, 'Asia/Kolkata'],
};

let failed = 0;
let passed = 0;

for (const [name, lat, lon, trueTz] of CITIES) {
  const got = resolve(lat, lon);
  const janOk = offsetMin(got, JAN) === offsetMin(trueTz, JAN);
  const julOk = offsetMin(got, JUL) === offsetMin(trueTz, JUL);
  if (janOk && julOk) {
    passed++;
  } else {
    failed++;
    console.error(
      `FAIL ${name}: resolved ${got} ` +
      `(UTC${offsetMin(got, JAN) / 60}/${offsetMin(got, JUL) / 60}) ` +
      `but ${trueTz} is UTC${offsetMin(trueTz, JAN) / 60}/${offsetMin(trueTz, JUL) / 60}`
    );
  }
}

// Guard the metric itself and not merely its outputs. Tromso is the sharpest
// discriminator available: Stockholm's anchor is nearer in longitude, Helsinki's
// is nearer in latitude, and at 69.7degN a cos(lat) shrink of the longitude term
// is exactly what flips the winner from the first to the second. So a
// reintroduced shrink fails here even if the anchor list changes underneath.
const tromso = resolve(69.65, 18.96);
if (offsetMin(tromso, JAN) !== offsetMin('Europe/Oslo', JAN)) {
  failed++;
  console.error(
    `FAIL metric guard (Tromso): resolved ${tromso}, expected Norway's offset. ` +
    'A cos(lat)-scaled longitude term is the usual cause.'
  );
}

for (const [name, spec] of Object.entries(KNOWN_RESIDUALS)) {
  const got = resolve(spec[0], spec[1]);
  const ok = offsetMin(got, JAN) === offsetMin(spec[2], JAN) && offsetMin(got, JUL) === offsetMin(spec[2], JUL);
  if (ok) console.log(`NOTE ${name} now resolves correctly (${got}) — promote it into CITIES`);
}

console.log(`\n${passed}/${CITIES.length} cities resolved to the correct UTC offset in January and July`);
console.log(`${anchors.length} anchors`);
if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('PASS');
