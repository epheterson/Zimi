// The Downloads row shows a recent rate and an ETA, not the average since
// start. Eric on 1.10 from his phone: "Downloads page has no ETA". The
// average (bytes / elapsed) was the only speed on the row, and it lags a
// swarm that just found peers by minutes and never notices a stall.
//
// Pinned here: the rate follows the bytes that arrived between two polls,
// smoothed; the first poll has no rate (nothing to compare yet); bytes going
// backwards (a restarted transfer) do not produce a negative rate; and the
// ETA rounds to something a person can read.
//
// Run: node tests/test_download_eta.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
function extract(re, label) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + label + ' from app.js');
  return m[0];
}

let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}

const ctx = {
  // The strings, with the placeholder filled the way t() fills it.
  t: (key, vars) => key === 'dl_eta_left' ? vars.time + ' left' : key === 'dl_eta_under_minute' ? 'under a minute left' : key,
};
vm.createContext(ctx);
vm.runInContext([
  extract(/var _dlRates = \{\};/, '_dlRates'),
  extract(/var _DL_RATE_SMOOTHING = [^;]+;/, '_DL_RATE_SMOOTHING'),
  extract(/function _dlRecentRate\(dl, now\) \{[\s\S]*?\n\}/, '_dlRecentRate'),
  extract(/function _fmtEta\(seconds\) \{[\s\S]*?\n\}/, '_fmtEta'),
].join('\n'), ctx);

// ── rate ───────────────────────────────────────────────────────────────────
const dl = { id: 'x', downloaded_bytes: 0 };
ok('first poll has no rate yet', ctx._dlRecentRate(dl, 1000) === null);
dl.downloaded_bytes = 10 * 1024 * 1024;
const r1 = ctx._dlRecentRate(dl, 3000);
ok('second poll: 10 MB in 2 s is 5 MB/s', Math.round(r1 / 1024 / 1024) === 5, String(r1));
dl.downloaded_bytes = 12 * 1024 * 1024;
const r2 = ctx._dlRecentRate(dl, 5000);
ok('a slow poll pulls the estimate down but not all the way (smoothed)',
  r2 < r1 && r2 > 1024 * 1024, (r2 / 1024 / 1024).toFixed(2) + ' MB/s');
dl.downloaded_bytes = 1024;  // restarted from scratch
const r3 = ctx._dlRecentRate(dl, 7000);
ok('bytes going backwards never yield a negative rate', r3 === null || r3 >= 0, String(r3));
ok('and the next poll starts fresh from the new byte count', ctx._dlRates.x.bytes === 1024);
ok('rates are per download', ctx._dlRecentRate({ id: 'y', downloaded_bytes: 5 }, 8000) === null);

// ── eta ────────────────────────────────────────────────────────────────────
ok('30 s reads as under a minute', ctx._fmtEta(30) === 'under a minute left');
ok('4 min', ctx._fmtEta(4 * 60 + 20) === '4m left', ctx._fmtEta(260));
ok('1 h 12 min', ctx._fmtEta(72 * 60) === '1h 12m left', ctx._fmtEta(4320));
ok('exactly 2 h has no dangling minutes', ctx._fmtEta(120 * 60) === '2h left', ctx._fmtEta(7200));
ok('1 day 3 h', ctx._fmtEta(27 * 3600) === '1d 3h left', ctx._fmtEta(97200));
ok('nonsense input is empty, not NaN', ctx._fmtEta(NaN) === '' && ctx._fmtEta(-5) === '' && ctx._fmtEta(Infinity) === '');

// ── the row uses them, and seeds come after downloads ──────────────────────
const row = src.slice(src.indexOf('for (const dl of renderDls) {'), src.indexOf("h += '</div>';  // close .dl-grid"));
ok('the row shows the ETA', /esc\(eta\)/.test(row));
ok('a paused, queued or verifying row forgets its rate', /if \(dl\.paused \|\| dl\.queued \|\| dl\.done \|\| dl\.checking\) delete _dlRates\[dl\.id\]/.test(row));
ok('verifying has its own label and never a rate or ETA', /dl\.checking\) \{[\s\S]*?tH\('dl_verifying'/.test(row));
ok('seeds are appended after the downloads', /h \+= seedHtml;\n\s*h \+= '<\/div>';  \/\/ close \.dl-grid/.test(src));
ok('the tab is patched in place rather than rebuilt', /_morphInto\(dlEl, h\)/.test(src) && !/dlEl\.innerHTML = h;/.test(src));

console.log(failures ? failures + ' FAILED' : 'all passed');
process.exit(failures ? 1 : 0);
