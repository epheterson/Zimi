// ── The Almanac's Tables and Calculations ──
// Eric, 2026-10-01: "the printable stuff should move into a Tables feature in
// almanac where I have tabs to tap through all the tables then sort through
// time windows for them and a print of what I'm looking at is always
// available, a nice interface, paired with a calculations tool that
// calculates all the things you had there and conversions and whatnot."
// And: "A scrollable row of tables and a scrollable row of calculations is
// it, I tap any and it opens the ui for that section with the table or the
// math and inputs. The math inputs are always ugly always we gotta find a
// nice way."
//
// One view at a time over the Almanac, inside #almanac-content (a re-render
// of the Almanac takes it away), opened from the Almanac's two rows of tiles
// (almanac.js _almTablesHtml) and loaded only then, after
// almanac-reference.js, which does the sums.
//
// The organising rule. A table is rows of time: one window (a day, a week, a
// month, a year or any range) and one place choose them, the same two
// controls on every table, and Print prints exactly what is on screen. A
// calculation is its answer, then the few things it is worked from, then the
// working: every input has a value from the first second (now, here, a
// worked example), so there is always an answer and never a Calculate button.
//
// The inputs are one small kit (_tk*): a number you drag sideways or tap to
// type, an angle that reads 41° 27.3′ N and takes it typed any common way, a
// date that opens the time machine's own lit window, a place that searches
// the Almanac's cities or asks where you are, and segmented choices.

var TB_TABLES = ALM_TB_TABLES;     // almanac.js: the tiles' order is the tabs'
var TB_CALCS = ALM_TB_CALCS;
var TB_CONSTS = ALM_TB_CONSTS;
// The window a table opens on: the span its data is naturally read over.
var TB_DEFAULT_WIN = { sunmoon: 'month', twilight: 'month', phases: 'month', tides: 'week', nav: 'day',
  stars: 'year', seasons: 'year', eclipses: 'year', calendars: 'month', suntime: 'month' };
var TB_WINDOWS = ['day', 'week', 'month', 'year', 'range'];
// The most rows of days one table draws at once (three years), and of years
// the event tables search; past these a range says it was shortened.
var TB_MAX_DAYS = 1096;
var TB_MAX_YEARS = 60;
var TB_MAX_STAR_YEARS = 10;
var TB_NAV_HOURLY_MAX_DAYS = 7;    // past a week, the navigation table steps a day at a time
var TB_MS_MIN = 60000;
var TB_MS_HOUR = 3600000;
var TB_MIN_PER_DAY = 1440;

var _tb = {
  id: null, kind: null,     // the open table or calculation, 'table' | 'calc'
  place: null,              // the tables' place (the Almanac's, until another is picked)
  win: {},                  // per table: { win, anchor:{y,m,d}, from, to }
  calc: {},                 // per calculation: its inputs
  returnFocus: null, pushed: false, expectPop: false, seq: 0
};

function _tbT(k, vars) { return t('tb_' + k, vars); }
function _tbH(k, vars) { return _almEsc(_tbT(k, vars)); }
function _tbRtl() { return document.documentElement.dir === 'rtl' || document.body.dir === 'rtl'; }
function _tbEl(id) { return document.getElementById(id); }

// ═══════════════════════════════════════════════════════════════════════
// Days, as the tables count them
// ═══════════════════════════════════════════════════════════════════════
function _tbJdn(k) { return _gregorianToJDN(k.y, k.m, k.d); }
function _tbKey(jdn) { var g = _jdnToGregorian(jdn); return { y: g.year, m: g.month, d: g.day }; }
function _tbAddDays(k, n) { return _tbKey(_tbJdn(k) + n); }
function _tbDim(y, m) { return _tbJdn({ y: m === 12 ? y + 1 : y, m: m === 12 ? 1 : m + 1, d: 1 }) - _tbJdn({ y: y, m: m, d: 1 }); }
function _tbAddMonths(k, n) {
  var mi = k.y * 12 + (k.m - 1) + n, y = Math.floor(mi / 12), m = mi - y * 12 + 1;
  return { y: y, m: m, d: Math.min(k.d, _tbDim(y, m)) };
}
function _tbSame(a, b) { return a.y === b.y && a.m === b.m && a.d === b.d; }
// Monday-first weekday index (JDN 0 was a Monday), and the week's first day
// where the reader lives (Sunday in the Americas, Monday most elsewhere).
function _tbWeekStart() {
  try {
    var loc = new Intl.Locale((typeof navigator !== 'undefined' && navigator.language) || 'en');
    var wi = loc.getWeekInfo ? loc.getWeekInfo() : loc.weekInfo;
    if (wi && wi.firstDay) return wi.firstDay % 7;   // 1 Mon … 7 Sun -> 1 … 0
  } catch (e) {}
  return 1;
}
// The ISO 8601 week of a day: the week (Monday to Sunday) holding its
// Thursday, numbered from the one holding 4 January.
function _tbIsoWeek(jdn) {
  var thursday = jdn - (jdn % 7) + 3;
  var y = _jdnToGregorian(thursday).year;
  return { year: y, week: Math.floor((thursday - _gregorianToJDN(y, 1, 1)) / 7) + 1 };
}
function _tbDayOfYear(k) { return _tbJdn(k) - _gregorianToJDN(k.y, 1, 1) + 1; }
function _tbYearLength(y) { return _gregorianToJDN(y + 1, 1, 1) - _gregorianToJDN(y, 1, 1); }
// Whole years, months and days from a to b (a no later than b); borrowing
// walks back through the real length of the month it lands in.
function _tbYmd(a, b) {
  // Whole months first (31 January and a month is 28 February), then the days left.
  var m = (b.y - a.y) * 12 + b.m - a.m;
  if (_tbJdn(_tbAddMonths(a, m)) > _tbJdn(b)) m--;
  var d = _tbJdn(b) - _tbJdn(_tbAddMonths(a, m));
  return { y: Math.floor(m / 12), m: m % 12, d: d };
}
// The calendar day an instant falls on in a zone.
function _tbDayIn(ms, tz) { var k = _arLocalDayKeyer(tz)(ms); return { y: k.y, m: k.m, d: k.d }; }

// ── Formatting a day ──
function _tbDate(k, opts) {
  return _arFmt('tbd|' + JSON.stringify(opts), Object.assign({ timeZone: 'UTC' }, opts)).format(new Date(_arDayMs(k) + 12 * TB_MS_HOUR));
}
function _tbLongDay(k) { return _tbDate(k, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); }
function _tbMonthYear(k) { return _tbDate(k, { year: 'numeric', month: 'long' }); }
function _tbShortDay(k) { return _tbDate(k, { year: 'numeric', month: 'short', day: 'numeric' }); }
function _tbRangeText(a, b) {
  if (_tbSame(a, b)) return _tbLongDay(a);
  var f = _arFmt('tbr', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
  var da = new Date(_arDayMs(a) + 12 * TB_MS_HOUR), db = new Date(_arDayMs(b) + 12 * TB_MS_HOUR);
  try { if (f.formatRange) return f.formatRange(da, db); } catch (e) {}
  return f.format(da) + ' – ' + f.format(db);
}
// A row's day: the weekday and the date, with the month or the year only
// when the window holds more than one.
function _tbDayCell(k, span) {
  var o = { weekday: 'short', day: 'numeric' };
  if (span.months) o.month = 'short';
  if (span.years) o.year = 'numeric';
  return _almEsc(_tbDate(k, o));
}
// An instant as the tables print it: the date (as above) and the time.
function _tbWhen(ms, tz, withYear) {
  var o = { timeZone: tz || undefined, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  if (withYear) o.year = 'numeric';
  return _arFmt('tbw|' + tz + withYear, o).format(new Date(Math.round(ms / TB_MS_MIN) * TB_MS_MIN));
}

// ═══════════════════════════════════════════════════════════════════════
// The place
// ═══════════════════════════════════════════════════════════════════════
function _tbMakePlace(lat, lon, name, chosen) {
  return { lat: lat, lon: lon, name: name || (_arLatText(lat) + ' ' + _arLonText(lon)), chosen: !!chosen,
    tz: _almTzForLocation(lat, lon) };
}
// The Almanac's place; before one is chosen, the city of the device's own
// time zone (the pill names it, so nothing pretends to be where you are).
function _tbAlmanacPlace() {
  var loc = _getLocation();
  if (loc.stored) return _tbMakePlace(loc.lat, loc.lon, loc.name, true);
  var tz = _almDeviceTz();
  for (var i = 0; i < _TZ_CITIES.length; i++) {
    var c = _TZ_CITIES[i];
    if (c.tz === tz) { var p = _tbMakePlace(c.lat, c.lon, t('alm_city_' + c.key), false); p.tz = tz; return p; }
  }
  var q = _tbMakePlace(loc.lat, loc.lon, '', false);
  if (tz) q.tz = tz;
  return q;
}
function _tbShortName(p) { return String(p.name).split(',')[0]; }
function _tbPlaceLine(p) {
  return _arLatText(p.lat) + ' ' + _arLonText(p.lon) + ' · ' + (p.tz || 'UTC');
}

// ═══════════════════════════════════════════════════════════════════════
// The input kit
// ═══════════════════════════════════════════════════════════════════════
// Every control is described by a spec, registered by key while its HTML is
// built: { text(), bump(n), type(str) -> bool, edit(), label, px, big }.
// A spec changes its own value; the kit then repaints every control and
// tells the open view (_tb.changed) to work its answer out again.
var _tk = { specs: {}, pop: null, drag: null };
var TK_DRAG_PX = 7;          // pixels of drag per step
var TK_DRAG_START_PX = 5;    // movement before a press becomes a drag
var TK_BIG_STEP = 10;        // Shift, Page Up/Down

function _tkReset() { _tk.specs = {}; }
function _tkSpec(key, spec) { _tk.specs[key] = spec; return spec; }

// A number: get/set, a step, bounds, digits and a unit; or wrap (angles).
function _tkNumSpec(o) {
  var digits = o.digits || 0;
  function clamp(v) {
    if (o.wrap) return ((v % o.wrap) + o.wrap) % o.wrap;
    if (o.min != null && v < o.min) v = o.min;
    if (o.max != null && v > o.max) v = o.max;
    return v;
  }
  function round(v) { var f = Math.pow(10, digits); return Math.round(v * f) / f; }
  return {
    label: o.label, unit: o.unit, px: o.px, big: o.big,
    text: function () { return o.fmt ? o.fmt(o.get()) : _arNum(o.get(), digits); },
    edit: function () { return o.editText ? o.editText(o.get()) : String(round(o.get())); },
    bump: function (n) { o.set(clamp(round(o.get() + n * (o.step || 1)))); },
    type: function (s) {
      var v = o.parse ? o.parse(s) : parseFloat(String(s).replace(',', '.').replace(/[−–]/g, '-'));
      if (!isFinite(v)) return false;
      o.set(clamp(o.digits != null ? round(v) : v));
      return true;
    },
    value: function () { return o.get(); }, min: o.min, max: o.max
  };
}

// An angle typed any common way: "41 27.3", "41°27.3'", "41.455",
// "41 27 18" (degrees, minutes, seconds), "-41.5", with N/S/E/W anywhere
// (S and W make it negative). Returns degrees, or NaN.
function _tkParseAngle(str) {
  var s = String(str || '').trim().toUpperCase().replace(/,/g, '.').replace(/[−–]/g, '-');
  if (!s) return NaN;
  var neg = /^-/.test(s) || /[SW]/.test(s);
  var nums = s.replace(/[NSEW]/g, ' ').match(/\d+(?:\.\d*)?|\.\d+/g);
  if (!nums || nums.length > 3) return NaN;
  var d = parseFloat(nums[0]), m = nums[1] != null ? parseFloat(nums[1]) : 0, sec = nums[2] != null ? parseFloat(nums[2]) : 0;
  if ((nums.length > 1 && (m >= 60 || nums[0].indexOf('.') >= 0)) || sec >= 60) return NaN;
  var v = d + m / 60 + sec / 3600;
  return neg ? -v : v;
}
// Degrees and minutes to a tenth, as an angle field shows it: 41° 27.3′.
function _tkAngleText(deg) {
  var a = Math.abs(deg), d = Math.floor(a + 1e-9), m = Math.round((a - d) * 600) / 10;
  if (m >= 60) { d += 1; m = 0; }
  return d + '° ' + (m < 10 ? '0' : '') + m.toFixed(1) + '′';
}
// An angle spec: the magnitude here, the sign as the hemisphere letter
// beside it (hemi = ['N', 'S'] or ['E', 'W']), or unsigned (an altitude).
function _tkAngleSpec(o) {
  return {
    label: o.label, px: TK_DRAG_PX, angle: true, hemi: o.hemi,
    text: function () { return _tkAngleText(o.get()); },
    edit: function () { var v = o.get(); return _tkAngleText(v).replace('° ', ' ').replace('′', '') + (o.hemi ? ' ' + o.hemi[v < 0 ? 1 : 0] : ''); },
    // A key moves a tenth of a minute, a drag a minute, Shift a degree.
    bump: function (n, big, drag) {
      var v = o.get(), sign = v < 0 ? -1 : 1, a = Math.abs(v) + n * (big ? 1 : drag ? 1 / 60 : 1 / 600);
      a = Math.max(0, Math.min(o.max, Math.round(a * 600) / 600));
      o.set(o.hemi ? sign * a : a);
    },
    type: function (s) {
      var v = _tkParseAngle(s);
      if (!isFinite(v) || Math.abs(v) > o.max) return false;
      // Typed without a hemisphere: keep the one shown.
      if (o.hemi && !/[NSEW-]/i.test(s) && o.get() < 0) v = -v;
      o.set(o.hemi ? v : Math.abs(v));
      return true;
    },
    flip: o.hemi ? function () { o.set(-o.get()); } : null,
    sign: function () { return o.get() < 0 ? 1 : 0; }
  };
}

// Controls' HTML. Numbers and angles are spinbuttons: drag sideways, use the
// arrow keys, or tap (Enter) to type.
function _tkNum(key, spec) {
  _tkSpec(key, spec);
  var html = '<span class="tk-num' + (spec.angle ? ' tk-angle' : '') + '" role="spinbutton" tabindex="0" data-tk="' + key + '" aria-label="' + _almEsc(spec.label || '') + '"' +
    (spec.min != null ? ' aria-valuemin="' + spec.min + '"' : '') + (spec.max != null ? ' aria-valuemax="' + spec.max + '"' : '') + '>' +
    '<span class="tk-v" dir="ltr"></span>' + (spec.unit ? '<span class="tk-u">' + _almEsc(spec.unit) + '</span>' : '') + '</span>';
  if (spec.hemi) html += '<button type="button" class="tk-hemi" data-tk-hemi="' + key + '" aria-label="' + _almEsc(spec.label || '') + '"></button>';
  return html;
}
// A number with a minus and a plus either side, for counts (a year, a day).
function _tkStepper(key, spec) {
  return '<span class="tk-stepper"><button type="button" class="tk-step" data-tk-step="' + key + '" data-d="-1" aria-label="−">−</button>' +
    _tkNum(key, spec) + '<button type="button" class="tk-step" data-tk-step="' + key + '" data-d="1" aria-label="+">+</button></span>';
}
// One of a few: a row of segments.
function _tkSeg(key, label, options, value, set) {
  _tkSpec(key, { seg: true, set: set });
  return '<span class="tk-seg" role="radiogroup" aria-label="' + _almEsc(label) + '">' + options.map(function (o) {
    var on = o.v === value;
    return '<button type="button" role="radio" aria-checked="' + on + '" tabindex="' + (on ? 0 : -1) + '" data-tk-seg="' + key + '" data-v="' + _almEsc(o.v) + '">' + _almEsc(o.label) + '</button>';
  }).join('') + '</span>';
}
// One of many: a pill that opens a list (with a search past a dozen).
function _tkPick(key, label, items, value, set) {
  _tkSpec(key, { pick: true, label: label, items: items, value: function () { return value(); }, set: set });
  return '<button type="button" class="tk-pill" data-tk-pick="' + key + '" aria-haspopup="listbox" aria-label="' + _almEsc(label) + '"><span class="tk-pill-v"></span>' + TK_CARET + '</button>';
}
// A date (and time): a pill that opens the time machine's lit window.
// o: { get() -> ms, set(ms), tz (null = the device's), time: bool, label }.
function _tkDate(key, o) {
  _tkSpec(key, { date: true, o: o, label: o.label });
  return '<button type="button" class="tk-pill tk-date" data-tk-date="' + key + '" aria-haspopup="dialog" aria-label="' + _almEsc(o.label || '') + '">' + TK_CAL_SVG + '<span class="tk-pill-v"></span></button>';
}
// A place: a pill that opens the search.
function _tkPlace(key, o) {
  _tkSpec(key, { place: true, o: o, label: o.label });
  return '<button type="button" class="tk-pill tk-place" data-tk-place="' + key + '" aria-haspopup="dialog" aria-label="' + _almEsc(o.label || '') + '">' + TK_PIN_SVG + '<span class="tk-pill-v"></span></button>';
}
var TK_CARET = '<svg class="tk-caret" aria-hidden="true" width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
var TK_PIN_SVG = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
var TK_CAL_SVG = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';

// Repaint every control from its spec.
function _tkPaint(root) {
  root = root || _tbEl('alm-ref');
  if (!root) return;
  root.querySelectorAll('[data-tk]').forEach(function (el) {
    var s = _tk.specs[el.getAttribute('data-tk')];
    if (!s || el.classList.contains('tk-typing')) return;
    var txt = s.text();
    var v = el.querySelector('.tk-v');
    if (v.textContent !== txt) v.textContent = txt;
    el.setAttribute('aria-valuetext', txt + (s.unit ? ' ' + s.unit : '') + (s.hemi ? ' ' + s.hemi[s.sign()] : ''));
    if (s.value) el.setAttribute('aria-valuenow', s.value());
  });
  root.querySelectorAll('[data-tk-hemi]').forEach(function (el) {
    var s = _tk.specs[el.getAttribute('data-tk-hemi')];
    if (s) el.textContent = s.hemi[s.sign()];
  });
  root.querySelectorAll('[data-tk-pick]').forEach(function (el) {
    var s = _tk.specs[el.getAttribute('data-tk-pick')], v = s.value();
    var it = s.items.filter(function (x) { return x.v === v; })[0];
    el.querySelector('.tk-pill-v').textContent = it ? it.label : '';
  });
  root.querySelectorAll('[data-tk-date]').forEach(function (el) {
    var o = _tk.specs[el.getAttribute('data-tk-date')].o;
    el.querySelector('.tk-pill-v').textContent = _tkDateText(o);
  });
  root.querySelectorAll('[data-tk-place]').forEach(function (el) {
    var p = _tk.specs[el.getAttribute('data-tk-place')].o.get();
    el.querySelector('.tk-pill-v').textContent = _tbShortName(p);
    el.title = p.name + ' · ' + _tbPlaceLine(p);
  });
}
function _tkChanged() {
  _tkPaint();
  if (_tb.changed) _tb.changed();
}

// ── A date's parts in a zone, and back ──
function _tkParts(ms, tz) {
  var c = _arClockMinutes(tz)(ms);
  return { y: c.y, m: c.m, d: c.d, h: Math.floor(c.minutes / 60), mi: Math.floor(c.minutes % 60) };
}
function _tkFromParts(p, tz) {
  var guess = _arDayMs(p) + p.h * TB_MS_HOUR + p.mi * TB_MS_MIN;
  if (!tz || tz === 'UTC') return guess;
  var ms = guess;
  // Twice: the zone's offset can differ either side of a daylight-saving change.
  for (var i = 0; i < 2; i++) {
    var off = _tzUtcOffsetMin(tz, new Date(ms));
    ms = guess - (isFinite(off) ? off : 0) * TB_MS_MIN;
  }
  return ms;
}
function _tkDateText(o) {
  var opts = { timeZone: o.tz || undefined, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' };
  if (o.time) { opts.hour = '2-digit'; opts.minute = '2-digit'; opts.hourCycle = 'h23'; }
  return _arFmt('tkd|' + o.tz + o.time, opts).format(new Date(o.get())) + (o.tz === 'UTC' && o.time ? ' UT' : '');
}
// The lit window's five drums (or three, for a date alone). Each is a
// spinbutton over the same instant: a drag or a key carries over (31 Jan +1
// day is 1 Feb), a typed value lands where it is typed.
function _tkDateSpecs(key, o) {
  function parts() { return _tkParts(o.get(), o.tz); }
  function put(p) {
    p.d = Math.min(p.d, _tbDim(p.y, p.m));
    o.set(_tkFromParts(p, o.tz));
  }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  var mons = _almTmMonAbbrs();
  var list = [
    ['mon', 'alm_tm_month', function (p) { return mons[p.m - 1]; }, function (p, n) { var k = _tbAddMonths(p, n); p.y = k.y; p.m = k.m; p.d = k.d; },
      function (p, s) { var m = _almTmMonParse(s, 0); if (!m) return false; p.m = m; return true; }],
    ['day', 'alm_tm_day', function (p) { return two(p.d); }, function (p, n) { var k = _tbAddDays(p, n); p.y = k.y; p.m = k.m; p.d = k.d; },
      function (p, s) { var v = parseInt(s, 10); if (!(v >= 1 && v <= _tbDim(p.y, p.m))) return false; p.d = v; return true; }],
    ['year', 'alm_tm_year', function (p) { return String(p.y); }, function (p, n) { p.y += n; },
      function (p, s) { var v = parseInt(String(s).replace(/[−–]/g, '-'), 10); if (!isFinite(v) || v < _AR_MIN_YEAR || v > _AR_MAX_YEAR) return false; p.y = v; return true; }]
  ];
  if (o.time) list.push(
    ['hh', 'alm_tm_hour', function (p) { return two(p.h); }, null, function (p, s) { var v = parseInt(s, 10); if (!(v >= 0 && v < 24)) return false; p.h = v; return true; }],
    ['mi', 'alm_tm_min', function (p) { return two(p.mi); }, null, function (p, s) { var v = parseInt(s, 10); if (!(v >= 0 && v < 60)) return false; p.mi = v; return true; }]);
  return list.map(function (f) {
    var id = key + '.' + f[0];
    _tkSpec(id, {
      label: t(f[1]), px: f[0] === 'mi' ? 4 : TK_DRAG_PX,
      text: function () { return f[2](parts()); },
      edit: function () { return f[2](parts()); },
      bump: function (n) {
        if (!f[3]) { o.set(o.get() + n * (f[0] === 'hh' ? TB_MS_HOUR : TB_MS_MIN)); return; }
        var p = parts(); f[3](p, n); put(p);
      },
      type: function (s) { var p = parts(); if (!f[4](p, s)) return false; put(p); return true; }
    });
    return { part: f[0], id: id };
  });
}

// ── The popover: one at a time, under its pill (a sheet from the bottom on a phone) ──
var TK_POP_NARROW_PX = 520;
function _tkPopOpen(anchor, html, cls, onBuild) {
  _tkPopClose(true);
  var view = _tbEl('alm-ref');
  if (!view) return null;
  var pop = document.createElement('div');
  pop.className = 'tk-pop ' + (cls || '');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', anchor.getAttribute('aria-label') || '');
  pop.innerHTML = html;
  var narrow = window.innerWidth < TK_POP_NARROW_PX;
  if (narrow) {
    pop.classList.add('tk-sheet');
    var scrim = document.createElement('div');
    scrim.className = 'tk-scrim';
    view.appendChild(scrim);
    _tk.scrim = scrim;
    scrim.addEventListener('click', function () { _tkPopClose(); });
  }
  view.appendChild(pop);
  if (!narrow) {
    var vr = view.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
    var w = pop.offsetWidth, left;
    if (_tbRtl()) left = Math.max(8, ar.right - vr.left - w); else left = Math.min(ar.left - vr.left, vr.width - w - 8);
    pop.style.left = Math.max(8, left) + 'px';
    var top = ar.bottom - vr.top + view.scrollTop + 6;
    // Above the pill when there is no room below it.
    if (ar.bottom + pop.offsetHeight + 12 > window.innerHeight && ar.top - pop.offsetHeight - 12 > vr.top) top = ar.top - vr.top + view.scrollTop - pop.offsetHeight - 6;
    pop.style.top = top + 'px';
  }
  _tk.pop = { el: pop, anchor: anchor };
  if (narrow) _almSheetAboveKeyboard(pop);
  if (onBuild) onBuild(pop);
  _tkPaint(pop);
  var first = pop.querySelector('input, [data-tk], button');
  if (first) first.focus({ preventScroll: true });
  return pop;
}
function _tkPopClose(quiet) {
  if (!_tk.pop) return;
  if (_tk.pop.el._almUnfit) _tk.pop.el._almUnfit();
  var a = _tk.pop.anchor;
  _tk.pop.el.remove();
  if (_tk.scrim) { _tk.scrim.remove(); _tk.scrim = null; }
  _tk.pop = null;
  if (!quiet && a && a.isConnected) a.focus({ preventScroll: true });
}

function _tkOpenDate(btn) {
  var key = btn.getAttribute('data-tk-date'), o = _tk.specs[key].o;
  var drums = _tkDateSpecs(key, o);
  var html = '<div class="tk-glass" dir="ltr">' + drums.map(function (d) {
    return (d.part === 'mi' ? '<span class="tk-colon" aria-hidden="true">:</span>' : '') +
      '<span class="tk-drum tk-drum-' + d.part + '"><span class="tk-drum-cap" aria-hidden="true">' + _almEsc(_tk.specs[d.id].label) + '</span>' + _tkNum(d.id, _tk.specs[d.id]) + '</span>';
  }).join('') + '</div>' +
    '<p class="tk-pop-hint">' + _tbH('drum_hint') + '</p>' +
    '<div class="tk-pop-row"><button type="button" class="tk-btn" data-tk-now>' + _almEsc(o.time ? t('alm_now') : _tbT('today')) + '</button>' +
    '<button type="button" class="tk-btn tk-btn-go" data-tk-done>' + _tbH('done') + '</button></div>';
  _tkPopOpen(btn, html, 'tk-pop-date', function (pop) {
    pop.querySelector('[data-tk-now]').addEventListener('click', function () {
      var now = Date.now();
      if (!o.time) { var p = _tkParts(now, o.tz); p.h = 12; p.mi = 0; now = _tkFromParts(p, o.tz); }
      o.set(now); _tkChanged();
    });
    pop.querySelector('[data-tk-done]').addEventListener('click', function () { _tkPopClose(); });
  });
}

function _tkOpenPick(btn) {
  var key = btn.getAttribute('data-tk-pick'), s = _tk.specs[key];
  var many = s.items.length > 12;
  var html = (many ? '<input type="search" class="tk-search" placeholder="' + _tbH('filter') + '" aria-label="' + _tbH('filter') + '">' : '') +
    '<div class="tk-list" role="listbox" aria-label="' + _almEsc(s.label) + '"></div>';
  _tkPopOpen(btn, html, 'tk-pop-list', function (pop) {
    var list = pop.querySelector('.tk-list'), q = pop.querySelector('.tk-search');
    function draw() {
      var f = q ? q.value.trim().toLowerCase() : '', cur = s.value(), lastGroup = null, h = '';
      s.items.forEach(function (it) {
        if (f && it.label.toLowerCase().indexOf(f) < 0 && String(it.sub || '').toLowerCase().indexOf(f) < 0) return;
        if (it.group && it.group !== lastGroup) { h += '<div class="tk-list-h">' + _almEsc(it.group) + '</div>'; lastGroup = it.group; }
        h += '<button type="button" role="option" class="tk-opt" aria-selected="' + (it.v === cur) + '" data-v="' + _almEsc(it.v) + '">' +
          '<span>' + _almEsc(it.label) + '</span>' + (it.sub ? '<span class="tk-opt-sub">' + _almEsc(it.sub) + '</span>' : '') + '</button>';
      });
      list.innerHTML = h || '<p class="tk-pop-hint">' + _tbH('no_match') + '</p>';
    }
    draw();
    if (q) q.addEventListener('input', draw);
    list.addEventListener('click', function (e) {
      var b = e.target.closest('.tk-opt');
      if (!b) return;
      s.set(b.getAttribute('data-v'));
      _tkPopClose();
      _tkChanged();
    });
    var sel = list.querySelector('[aria-selected="true"]');
    if (sel && !q) { sel.focus({ preventScroll: true }); sel.scrollIntoView({ block: 'nearest' }); }
  });
}

// A typed "lat, lon" (either part any way an angle is typed).
function _tkParseLatLon(s) {
  var parts = String(s).split(/[,;]|\s(?=[-+]?\d)(?=.*[NSEWnsew].*[NSEWnsew])/);
  if (parts.length !== 2) {
    var m = /^\s*([^NSns]*[NSns])\s*(.+[EWew])\s*$/.exec(String(s));
    if (!m) return null;
    parts = [m[1], m[2]];
  }
  var lat = _tkParseAngle(parts[0]), lon = _tkParseAngle(parts[1]);
  return _almValidLatLon(lat, lon) ? { lat: lat, lon: lon } : null;
}
function _tkOpenPlace(btn) {
  var key = btn.getAttribute('data-tk-place'), o = _tk.specs[key].o;
  var alm = _getLocation();
  var html = '<input type="search" class="tk-search" placeholder="' + _tbH('place_search') + '" aria-label="' + _tbH('place_search') + '" autocomplete="off">' +
    '<div class="tk-list" role="listbox" aria-label="' + _almEsc(o.label || '') + '"></div>';
  _tkPopOpen(btn, html, 'tk-pop-list tk-pop-place', function (pop) {
    var list = pop.querySelector('.tk-list'), q = pop.querySelector('.tk-search'), found = [];
    function choose(p) { o.set(p); _tkPopClose(); _tkChanged(); }
    function draw() {
      var s = q.value.trim(), h = '';
      found = [];
      if (!s) {
        if (navigator.geolocation) found.push({ here: true });
        if (alm.stored) found.push({ p: _tbMakePlace(alm.lat, alm.lon, alm.name, true), sub: _tbT('place_almanac') });
      } else {
        var ll = _tkParseLatLon(s);
        if (ll) found.push({ p: _tbMakePlace(ll.lat, ll.lon, '', true), sub: _tbT('place_coords') });
        _almFindCities(s, 8).forEach(function (c) { found.push({ p: _tbMakePlace(c.lat, c.lon, c.name, true) }); });
      }
      found.forEach(function (f, i) {
        if (f.here) { h += '<button type="button" role="option" class="tk-opt tk-opt-here" data-i="' + i + '">' + ALM_LOCATE_SVG + '<span>' + _almEsc(t('alm_place_here')) + '</span></button>'; return; }
        var parts = String(f.p.name).split(',');
        h += '<button type="button" role="option" class="tk-opt" data-i="' + i + '"><span>' + _almEsc(parts[0]) + '</span>' +
          '<span class="tk-opt-sub">' + _almEsc(f.sub || parts.slice(1).join(',').trim() || _tbPlaceLine(f.p)) + '</span></button>';
      });
      list.innerHTML = h || '<p class="tk-pop-hint">' + _tbH('no_match') + '</p>';
    }
    draw();
    q.addEventListener('input', draw);
    q.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && found.length) { e.preventDefault(); var b = list.querySelector('.tk-opt'); if (b) b.click(); }
    });
    list.addEventListener('click', function (e) {
      var b = e.target.closest('.tk-opt');
      if (!b) return;
      var f = found[+b.getAttribute('data-i')];
      if (!f.here) { choose(f.p); return; }
      b.querySelector('span').textContent = _tbT('locating');
      navigator.geolocation.getCurrentPosition(function (pos) {
        var lat = pos.coords.latitude, lon = pos.coords.longitude;
        choose(_tbMakePlace(lat, lon, _almNearestCityName(lat, lon), true));
      }, function () {
        if (b.isConnected) b.querySelector('span').textContent = _tbT('place_failed');
      }, { timeout: 8000 });
    });
  });
}

// ── Gestures and keys, delegated from the view ──
// A field typed into on the page itself (a number, a search): once the
// keyboard has come up, bring it into the part of the view that is left.
var TK_KEYBOARD_SETTLE_MS = 350;
function _tkBind(root) {
  root.addEventListener('focusin', function (e) {
    var el = e.target;
    if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName) || el.type === 'date' || el.closest('.tk-sheet')) return;
    setTimeout(function () { if (document.activeElement === el && el.scrollIntoView) el.scrollIntoView({ block: 'center' }); }, TK_KEYBOARD_SETTLE_MS);
  });
  root.addEventListener('pointerdown', function (e) {
    var el = e.target.closest('.tk-num');
    if (!el || el.classList.contains('tk-typing') || e.button > 0) return;
    var s = _tk.specs[el.getAttribute('data-tk')];
    if (!s) return;
    _tk.drag = { el: el, s: s, x: e.clientX, applied: 0, moved: false, id: e.pointerId };
    try { el.setPointerCapture(e.pointerId); } catch (x) {}
  });
  root.addEventListener('pointermove', function (e) {
    var d = _tk.drag;
    if (!d || e.pointerId !== d.id) return;
    var dx = (e.clientX - d.x) * (_tbRtl() ? -1 : 1);
    if (!d.moved && Math.abs(dx) < TK_DRAG_START_PX) return;
    if (!d.moved) { d.moved = true; d.el.classList.add('tk-dragging'); }
    var steps = Math.round(dx / (d.s.px || TK_DRAG_PX));
    if (steps !== d.applied) { d.s.bump(steps - d.applied, false, true); d.applied = steps; _tkChanged(); }
    e.preventDefault();
  });
  function end(e) {
    var d = _tk.drag;
    if (!d || e.pointerId !== d.id) return;
    _tk.drag = null;
    d.el.classList.remove('tk-dragging');
    if (!d.moved && e.type === 'pointerup') _tkType(d.el);
  }
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  root.addEventListener('keydown', function (e) {
    var el = e.target.closest && e.target.closest('.tk-num');
    if (el && !el.classList.contains('tk-typing') && e.target === el) {
      var s = _tk.specs[el.getAttribute('data-tk')];
      if (!s) return;
      var rtl = _tbRtl(), n = 0;
      if (e.key === 'ArrowUp') n = 1; else if (e.key === 'ArrowDown') n = -1;
      else if (e.key === 'ArrowRight') n = rtl ? -1 : 1; else if (e.key === 'ArrowLeft') n = rtl ? 1 : -1;
      else if (e.key === 'PageUp') n = TK_BIG_STEP; else if (e.key === 'PageDown') n = -TK_BIG_STEP;
      if (n) {
        e.preventDefault();
        if (s.angle) s.bump(n, e.shiftKey); else s.bump(e.shiftKey ? n * TK_BIG_STEP : n);
        _tkChanged();
        return;
      }
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'F2') { e.preventDefault(); _tkType(el); return; }
      // Typing a digit starts typing, with that digit.
      if (/^[0-9.,\-]$/.test(e.key) && !e.metaKey && !e.ctrlKey) { e.preventDefault(); _tkType(el, e.key); return; }
    }
    var seg = e.target.closest && e.target.closest('[data-tk-seg]');
    if (seg && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
      var all = Array.prototype.slice.call(seg.parentNode.children), i = all.indexOf(seg);
      var fwd = e.key === 'ArrowDown' || e.key === (_tbRtl() ? 'ArrowLeft' : 'ArrowRight');
      var next = all[(i + (fwd ? 1 : all.length - 1)) % all.length];
      e.preventDefault(); next.focus(); next.click();
    }
  });
  root.addEventListener('click', function (e) {
    var b;
    if ((b = e.target.closest('[data-tk-step]'))) {
      var s = _tk.specs[b.getAttribute('data-tk-step')];
      s.bump(+b.getAttribute('data-d')); _tkChanged(); return;
    }
    if ((b = e.target.closest('[data-tk-hemi]'))) { _tk.specs[b.getAttribute('data-tk-hemi')].flip(); _tkChanged(); return; }
    if ((b = e.target.closest('[data-tk-seg]'))) {
      var sp = _tk.specs[b.getAttribute('data-tk-seg')];
      b.parentNode.querySelectorAll('[data-tk-seg]').forEach(function (x) { var on = x === b; x.setAttribute('aria-checked', on); x.tabIndex = on ? 0 : -1; });
      sp.set(b.getAttribute('data-v')); return;
    }
    if ((b = e.target.closest('[data-tk-pick]'))) { _tkOpenPick(b); return; }
    if ((b = e.target.closest('[data-tk-date]'))) { _tkOpenDate(b); return; }
    if ((b = e.target.closest('[data-tk-place]'))) { _tkOpenPlace(b); return; }
  });
  // A press outside the open popover closes it.
  root.addEventListener('pointerdown', function (e) {
    if (_tk.pop && !_tk.pop.el.contains(e.target) && !_tk.pop.anchor.contains(e.target)) _tkPopClose(true);
  }, true);
}

// Typing into a spinbutton: its value becomes a field in place; Enter or
// leaving it keeps a value that makes sense, Escape keeps the old one.
function _tkType(el, first) {
  var key = el.getAttribute('data-tk'), s = _tk.specs[key];
  if (!s || !s.type) return;
  el.classList.add('tk-typing');
  var v = el.querySelector('.tk-v');
  var inp = document.createElement('input');
  inp.className = 'tk-in';
  inp.setAttribute('inputmode', s.angle || /\.(mon)$/.test(key) ? 'text' : 'decimal');
  inp.setAttribute('aria-label', s.label || '');
  inp.autocomplete = 'off'; inp.spellcheck = false;
  inp.value = first != null ? first : s.edit();
  inp.size = Math.max(3, inp.value.length + 1);
  v.textContent = '';
  v.appendChild(inp);
  inp.focus();
  if (first == null) inp.select();
  var done = false;
  function finish(keep) {
    if (done) return;
    done = true;
    var ok = keep ? s.type(inp.value) : true;
    el.classList.remove('tk-typing');
    if (keep && !ok) { el.classList.add('tk-bad'); setTimeout(function () { el.classList.remove('tk-bad'); }, 600); }
    v.textContent = '';
    _tkChanged();
    if (el.isConnected) el.focus({ preventScroll: true });
  }
  inp.addEventListener('input', function () { inp.size = Math.max(3, inp.value.length + 1); });
  inp.addEventListener('keydown', function (e) {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    else if (e.key === 'Tab') finish(true);
  });
  inp.addEventListener('blur', function () { finish(true); });
}

// ═══════════════════════════════════════════════════════════════════════
// The view: one table or calculation over the Almanac
// ═══════════════════════════════════════════════════════════════════════
function _tbKind(id) {
  return TB_TABLES.indexOf(id) >= 0 ? 'table' : TB_CALCS.indexOf(id) >= 0 ? 'calc' : TB_CONSTS.indexOf(id) >= 0 ? 'const' : id === 'decay' ? 'decay' : null;
}
function _tbName(id) { return id === 'decay' ? t('ref_decay') : t('tb_' + id); }

function _tbOpen(id) {
  var kind = _tbKind(id), host = _tbEl('almanac-content');
  if (!kind || !host) return;
  var el = _tbEl('alm-ref');
  if (!el) {
    _tb.returnFocus = document.activeElement;
    _tb.place = _tb.place || _tbAlmanacPlace();
    el = document.createElement('div');
    el.id = 'alm-ref';
    el.className = 'alm-ref';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'alm-ref-title');
    host.appendChild(el);
    _tkBind(el);
    // The view is a step: Back (the browser's, a phone's) leaves it for the
    // Almanac where it was, and no further.
    try { history.pushState({ mode: 'almanac', almTables: 1 }, '', location.href); _tb.pushed = true; } catch (e) {}
  }
  _tb.id = id; _tb.kind = kind; _tb.changed = null;
  _tkPopClose(true);
  _tkReset();
  var list = kind === 'calc' ? TB_CALCS : kind === 'table' ? TB_TABLES : kind === 'const' ? TB_CONSTS : [];
  el.innerHTML = '<div class="tb-head">' +
    '<div class="tb-bar">' +
      '<button type="button" class="tb-back" data-tb-close aria-label="' + _almEsc(t('back_to', { place: t('almanac') })) + '" title="' + _almEsc(t('back_to', { place: t('almanac') })) + '">' + TB_BACK_SVG + '</button>' +
      '<h2 id="alm-ref-title" tabindex="-1">' + _almEsc(_tbName(id)) + '</h2>' +
      '<span class="tb-bar-end">' +
        (kind === 'table' || kind === 'calc' ? '<button type="button" class="tb-iconbtn" data-tb-reset aria-label="' + _tbH('reset') + '" title="' + _tbH('reset') + '">' + TB_RESET_SVG + '</button>' : '') +
        (kind === 'decay' ? '' : '<button type="button" class="tb-iconbtn" data-tb-share aria-label="' + _almEsc(t('reader_share')) + '" title="' + _almEsc(t('reader_share')) + '">' + TB_SHARE_SVG + '</button>') +
        '<button type="button" class="tb-print" data-tb-print>' + ALM_PRINT_SVG + '<span>' + _almEsc(t('ref_print')) + '</span></button>' +
      '</span>' +
    '</div>' +
    (list.length ? '<nav class="tb-tabs" aria-label="' + _tbH(kind === 'calc' ? 'calcs' : kind === 'const' ? 'consts' : 'tables') + '">' + list.map(function (k) {
      return '<button type="button" class="tb-tab" data-tb-go="' + k + '"' + (k === id ? ' aria-current="page"' : '') + '>' + _almEsc(_tbName(k)) + '</button>';
    }).join('') + '</nav>' : '') +
    '</div><div class="tb-body" id="tb-body"></div>';
  el.querySelector('[data-tb-close]').addEventListener('click', function () { _tbClose(); });
  el.querySelector('[data-tb-print]').addEventListener('click', _tbPrint);
  var reset = el.querySelector('[data-tb-reset]');
  if (reset) reset.addEventListener('click', _tbReset);
  var share = el.querySelector('[data-tb-share]');
  if (share) share.addEventListener('click', _tbShare);
  el.querySelectorAll('[data-tb-go]').forEach(function (b) {
    b.addEventListener('click', function () { _tbOpen(b.getAttribute('data-tb-go')); var n = _tbEl('alm-ref').querySelector('[data-tb-go="' + b.getAttribute('data-tb-go') + '"]'); if (n) n.focus({ preventScroll: true }); });
  });
  var cur = el.querySelector('.tb-tab[aria-current]');
  if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
  el.scrollTop = 0;
  var body = _tbEl('tb-body');
  if (kind === 'table') _tbRenderTable(body);
  else if (kind === 'calc') _tbRenderCalc(body);
  else if (kind === 'const') _tbRenderConst(body);
  else _arRenderDecay(body);
  el.style.setProperty('--tb-head-h', el.querySelector('.tb-head').offsetHeight + 'px');
  if (!el.contains(document.activeElement)) el.querySelector('#alm-ref-title').focus({ preventScroll: true });
}
// Start again: back to the Almanac's day and place (a table), or to a
// calculation's own starting values. An icon beside Print, so it fits every
// page ("Start again from now and here doesn't fit each page", Eric).
var TB_RESET_SVG = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/></svg>';
function _tbReset() {
  var id = _tb.id, body = _tbEl('tb-body');
  if (!id || !body) return;
  _tkPopClose(true);
  if (_tb.kind === 'table') {
    _tb.place = _tbAlmanacPlace();
    delete _tb.win[id];
    _tbRenderTable(body);
  } else if (_tb.kind === 'calc') {
    _tb.calc[id] = TB_CALC[id].init();
    _tbCalcFields();
  }
}
// Share what is on screen as Markdown: the share sheet where there is one,
// else the clipboard (app.js _copyText says "Copied"). Eric: "reset print and
// copy/share the MD or text output".
var TB_SHARE_SVG = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7.5 7.5L12 3l4.5 4.5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
function _tbShare() {
  _tkPopClose(true);
  var text = _tbMarkdown();
  if (!text) return;
  var copy = function () { if (typeof _copyText === 'function') _copyText(text); };
  if (navigator.share) {
    navigator.share({ title: _tbName(_tb.id), text: text }).catch(function (e) { if (!e || e.name !== 'AbortError') copy(); });
  } else copy();
}
// The open table or calculation as Markdown: its name, where and when, then
// what the page shows in order (a calculation's answer and the values it was
// worked from first), headings, tables, notes. Read off the page itself, so
// every table and calculation has it with nothing of its own.
function _tbMarkdown() {
  var body = _tbEl('tb-body');
  if (!body || !_tb.id) return '';
  var md = [], txt = _tbMdText;
  var head = [].map.call(body.querySelectorAll('#tb-print-head p:not(.tb-made)'), txt).filter(Boolean);
  md.push('# ' + _tbName(_tb.id) + (head.length ? '\n\n' + head.join(' · ') : ''));
  var ans = body.querySelector('#tk-answer');
  if (ans) {
    var big = ans.querySelector('.tk-big'), sub = ans.querySelector('.tk-sub');
    md.push('**' + txt(big) + '**' + (sub && txt(sub) ? '  \n' + txt(sub) : ''));
    var fields = [].map.call(body.querySelectorAll('#tk-fields .tk-row'), function (r) {
      var l = r.querySelector('.tk-label'), c = r.querySelector('.tk-ctl');
      if (!l || !c) return '';
      var lc = l.cloneNode(true), cc = c.cloneNode(true);
      [].forEach.call(lc.querySelectorAll('.tk-hint'), function (n) { n.remove(); });
      [].forEach.call(cc.querySelectorAll('.tk-swap, .tk-step, [aria-hidden="true"]'), function (n) { n.remove(); });
      return txt(lc) && txt(cc) ? '- ' + txt(lc) + ': ' + txt(cc) : '';
    }).filter(Boolean);
    if (fields.length) md.push(fields.join('\n'));
  }
  body.querySelectorAll('#tb-out, #tk-working, #tb-how').forEach(function (host) {
    host.querySelectorAll('summary, h3, h4, li, table, dl, p.tb-note, p.tb-empty').forEach(function (n) {
      if (n.tagName === 'SUMMARY') { md.push('## ' + txt(n)); return; }
      if (n.tagName === 'H4') { md.push('### ' + txt(n)); return; }
      if (n.tagName === 'LI') { md.push('- ' + txt(n)); return; }
      if (n.tagName === 'H3') md.push('## ' + txt(n));
      else if (n.tagName === 'TABLE') md.push(_tbMdTable(n));
      else if (n.tagName === 'DL') md.push([].map.call(n.querySelectorAll('dt'), function (dt) { return '- ' + txt(dt) + ': ' + txt(dt.nextElementSibling); }).join('\n'));
      else if (txt(n)) md.push(txt(n));
    });
  });
  // A list's items one under another, not a paragraph each.
  return md.filter(Boolean).join('\n\n').replace(/^(- .*)\n\n(?=- )/gm, '$1\n') + '\n';
}
function _tbMdText(n) { return n ? String(n.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
// A cell's words, or its picture's name (a phase drawn is titled "Full moon").
function _tbMdCell(n) {
  var s = _tbMdText(n);
  if (!s && n) s = [].map.call(n.querySelectorAll('[title]'), function (x) { return x.getAttribute('title'); }).join(' ');
  return s.replace(/\|/g, '\\|');
}
// A table, its spans laid out on a grid: a heading cell over several columns
// is repeated in each, two head rows join per column, and a month's heading
// across the rows stands in its first cell.
function _tbMdTable(table) {
  var grid = [], headRows = table.tHead ? table.tHead.rows.length : 0, w = 0;
  [].forEach.call(table.rows, function (tr, ri) {
    grid[ri] = grid[ri] || [];
    var ci = 0;
    [].forEach.call(tr.cells, function (td) {
      while (grid[ri][ci] != null) ci++;
      var span = td.colSpan || 1, down = td.rowSpan || 1, text = _tbMdCell(td), group = ri >= headRows && span > 1;
      for (var r = 0; r < down; r++) {
        grid[ri + r] = grid[ri + r] || [];
        for (var c = 0; c < span; c++) grid[ri + r][ci + c] = group && c ? '' : (r && ri + r >= headRows ? '' : text);
      }
      ci += span;
      w = Math.max(w, ci);
    });
  });
  var fill = function (row) { var o = []; for (var c = 0; c < w; c++) o.push(row && row[c] != null ? row[c] : ''); return o; };
  var head = fill([]).map(function (_, c) {
    var parts = [];
    for (var h = 0; h < headRows; h++) { var x = grid[h][c]; if (x && parts[parts.length - 1] !== x) parts.push(x); }
    return parts.join(' ');
  });
  var line = function (cells) { return '| ' + cells.join(' | ') + ' |'; };
  var out = [line(head), line(head.map(function () { return '---'; }))];
  for (var b = headRows; b < grid.length; b++) out.push(line(fill(grid[b])));
  return out.join('\n');
}
var TB_BACK_SVG = '<svg class="tb-chev" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';

function _tbClose(viaHistory) {
  var el = _tbEl('alm-ref');
  _tkPopClose(true);
  if (el) el.remove();
  _tb.id = null; _tb.changed = null;
  if (_tb.pushed && !viaHistory) { _tb.pushed = false; _tb.expectPop = true; history.back(); }
  _tb.pushed = false;
  var f = _tb.returnFocus;
  _tb.returnFocus = null;
  if (f && f.isConnected && f.focus) f.focus({ preventScroll: true });
}
// Asked by almanac.js's _almTablesPop (app.js's popstate): Back with the
// view open closes the view, not the Almanac; the step the view's own close
// takes back is swallowed. True when the event was the view's.
function _tbHistoryPop(e) {
  if (_tb.expectPop) { _tb.expectPop = false; return true; }
  if (_tbEl('alm-ref') && !(e.state && e.state.almTables)) { _tbClose(true); return true; }
  return false;
}
// Escape, wherever focus is: the popover first, then the view; never the
// Almanac behind it (app.js closes that on an Escape that reaches it).
window.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape' || !_tbEl('alm-ref')) return;
  e.stopPropagation();
  e.preventDefault();
  if (_tk.pop) _tkPopClose(); else _tbClose();
}, true);
// Print the view alone, and only while it is showing. Print sets it up
// itself before asking for the dialog: iOS does not always send beforeprint,
// and without it the whole app went to paper, which is the Almanac's fixed
// frame and a blank page. The page's own Print (a browser menu, a key) still
// comes through beforeprint.
var TB_PRINT_CLASS = 'alm-ref-print';
var TB_PRINT_UNDO_MS = 60000;   // afterprint can be late or missing on a phone
function _tbPrintOn() {
  if (!(_tbEl('alm-ref') && typeof _almanacOpen !== 'undefined' && _almanacOpen)) return;
  document.documentElement.classList.add(TB_PRINT_CLASS);
  // Paper has no tap to open "How this is made": it prints open.
  var d = document.querySelector('#tb-how details');
  if (d && !d.open) { d.open = true; d.setAttribute('data-print-opened', ''); }
}
function _tbPrintOff() {
  document.documentElement.classList.remove(TB_PRINT_CLASS);
  var d = document.querySelector('#tb-how details[data-print-opened]');
  if (d) { d.open = false; d.removeAttribute('data-print-opened'); }
}
function _tbPrint() {
  _tkPopClose(true);
  if (typeof window.print !== 'function') return;
  _tbPrintOn();
  clearTimeout(_tb.printUndo);
  _tb.printUndo = setTimeout(_tbPrintOff, TB_PRINT_UNDO_MS);
  try { window.print(); } catch (e) { _tbPrintOff(); }
}
window.addEventListener('beforeprint', _tbPrintOn);
window.addEventListener('afterprint', function () { clearTimeout(_tb.printUndo); _tbPrintOff(); });

// ═══ How this is made ═══
// Eric: "add like all the stuff used to generate everything on the page".
// Under every table and calculation, closed: the inputs in effect, the method
// behind each quantity, the constants. Every number is read from the constant
// the sums themselves use; which lines a view has is TB_MADE.
var TB_MADE = {
  sunmoon: ['sun', 'moon', 'rise', 'moonrise', 'search', 'deltat'],
  twilight: ['sun', 'twilight', 'search', 'deltat'],
  phases: ['sun', 'moon', 'phases', 'deltat'],
  tides: ['tides'],
  nav: ['sun', 'moon', 'planets', 'stars', 'deltat'],
  stars: ['sun', 'stars', 'heliacal'],
  seasons: ['seasons', 'deltat'],
  eclipses: ['sun', 'moon', 'eclipses', 'deltat'],
  calendars: ['calendars'],
  suntime: ['sun', 'eot'],
  distance: ['distance'],
  sundial: ['sun', 'eot'],
  sunmoonday: ['sun', 'moon', 'rise', 'moonrise', 'twilight', 'deltat'],
  units: ['units'],
  sight: ['sun', 'moon', 'planets', 'stars', 'sight', 'deltat'],
  days: ['calendars'],
  convert: ['calendars'],
  zones: ['zones']
};
var TB_ARCMIN_PER_DEG = 60, TB_S_PER_DAY = 86400;
function _tbArcmin(deg) { return _arNum(deg * TB_ARCMIN_PER_DEG, 0) + '′'; }
// Each method: its line, and the constants it rests on.
var TB_MADE_METHOD = {
  sun: function () { return { line: _tbT('mm_sun'), c: ['aberration', 'light'] }; },
  moon: function () { return { line: _tbT('mm_moon'), c: ['moonk', 'synodic'] }; },
  rise: function () {
    return { line: _tbT('mm_rise', { alt: '−' + _tbArcmin(-AR_SUNRISE_ALT), r: _tbArcmin(AR_MOON_REFRACTION_DEG), sd: _tbArcmin(-AR_SUNRISE_ALT - AR_MOON_REFRACTION_DEG) }) };
  },
  moonrise: function () { return { line: _tbT('mm_moonrise', { k: _arNum(AR_MOON_HP_FACTOR, 4), r: _tbArcmin(AR_MOON_REFRACTION_DEG) }) }; },
  twilight: function () {
    return { line: _tbT('mm_twilight', { c: -AR_TWILIGHT_ALTS.civil, n: -AR_TWILIGHT_ALTS.nautical, a: -AR_TWILIGHT_ALTS.astronomical }) };
  },
  search: function () {
    var gridMin = AR_SAMPLE_HOURS * 60 / AR_GRID_STEPS;
    return { line: _tbT('mm_search', { h: AR_SAMPLE_HOURS, m: _arNum(gridMin, 0), s: _arNum(gridMin * 60 / Math.pow(2, AR_BISECT_STEPS), 0) }) };
  },
  deltat: function (x) {
    var jd = _dateToJD(x.mid || Date.now());
    return { line: _tbT('mm_deltat', { s: _arNum(_cnDeltaTdays(jd) * TB_S_PER_DAY, 1) }), c: ['tai'] };
  },
  phases: function () { return { line: _tbT('mm_phases', { list: AR_PHASE_ANGLES.map(function (a) { return a + '°'; }).join(', ') }) }; },
  seasons: function () { return { line: _tbT('mm_seasons') }; },
  eclipses: function () { return { line: _tbT('mm_eclipses', { m: _arNum(AR_ECL_STEP_MS / TB_MS_MIN, 0), h: _arNum(AR_ECL_HALF_SPAN_MS / TB_MS_HOUR, 0) }) }; },
  planets: function () { return { line: _tbT('mm_planets'), c: ['light', 'aberration'] }; },
  stars: function () { return { line: _tbT('mm_stars'), c: ['sidereal', 'year'] }; },
  heliacal: function () { return { line: _tbT('mm_heliacal', { av: AR_ARCUS_VISIONIS_DEG, alt: '−' + _tbArcmin(-AR_STAR_RISE_ALT) }) }; },
  sight: function () { return { line: _tbT('mm_sight', { k: _arNum(AR_DIP_ARCMIN_PER_SQRT_M, 2), t: AR_STD_TEMP_C, p: AR_STD_PRESSURE_HPA }), c: ['parallax'] }; },
  tides: function (x) {
    var m = x.made;
    if (!m) return null;
    return { line: m.ref ? _tbT('mm_tides_sub', { ref: m.ref, station: m.station }) : _tbT('mm_tides', { station: m.station, n: m.n }) };
  },
  eot: function () { return { line: _tbT('mm_eot') }; },
  calendars: function () { return { line: _tbT('mm_calendars', { list: AR_CAL_SYSTEMS.map(_arCalLabel).join(', ') }) }; },
  distance: function () { return { line: _tbT('mm_distance', { r: _arNum(TB_EARTH_R_KM, 4) }) }; },
  units: function () { return { line: _tbT('mm_units') }; },
  zones: function () { return { line: _tbT('mm_zones') }; }
};
var TB_MADE_CONST = {
  aberration: function () { return _arNum(AR_ABERRATION_ARCSEC, 5) + '″'; },
  light: function () { return _arNum(AR_LIGHT_DAYS_PER_AU * TB_S_PER_DAY, 3) + ' s'; },
  parallax: function () { return _arNum(AR_SOLAR_PARALLAX_ARCSEC, 3) + '″'; },
  moonk: function () { return _arNum(AR_MOON_K, 7); },
  synodic: function () { return _arT('days_n', { n: _arNum(_CN_SYN, 6) }); },
  sidereal: function () { return _arNum(AR_SIDEREAL_DEG_PER_DAY, 6) + '°/d'; },
  year: function () { return _arT('days_n', { n: _arNum(AR_DAYS_PER_JULIAN_YEAR, 2) }); },
  tai: function () { return AR_TAI_MINUS_UTC + ' s'; }
};
// The middle of a table's window, as an instant.
function _tbMid(span) { return (_arDayMs(span.from) + _arDayMs(span.to)) / 2; }
// A calculation's inputs in effect: its places, its date, its unit.
function _tbCalcInputs(c) {
  var places = ['place', 'a', 'b'].map(function (k) { return c[k]; }).filter(function (p) { return p && p.lat != null; });
  return { places: places, date: typeof c.ms === 'number' ? c.ms : null, mid: typeof c.ms === 'number' ? c.ms : null, units: c.unit || null };
}
function _tbMadeInputs(x) {
  var out = [], places = x.places || (x.place ? [x.place] : []), seenTz = {};
  places.forEach(function (p) { out.push(_tbT('made_place', { name: p.name || _tbPlaceLine(p), at: _arLatText(p.lat) + ' ' + _arLonText(p.lon) })); });
  var at = x.date || x.mid || Date.now();
  places.map(function (p) { return p.tz; }).concat(x.made && x.made.tz ? [x.made.tz] : []).forEach(function (tz) {
    if (!tz || seenTz[tz]) return;
    seenTz[tz] = 1;
    out.push(_tbT('made_zone', { tz: tz, off: _almTzOffsetLabel(tz, new Date(at)) }));
  });
  if (x.range) out.push(_tbT('made_dates', { range: x.range }));
  else if (x.date != null && places.length) out.push(_tbT('made_date', { date: _tbLongDay(_tbDayIn(x.date, places[0].tz)) }));
  var units = x.units || (x.made && x.made.units);
  if (units) out.push(_tbT('made_units', { u: units }));
  return out;
}
// Fill #tb-how for the open view (x: what it was worked from).
function _tbMadeFill(x) {
  var host = _tbEl('tb-how'), keys = TB_MADE[_tb.id];
  if (!host) return;
  if (!keys || !x) { host.innerHTML = ''; return; }
  var methods = [], consts = [], seen = {};
  keys.forEach(function (k) {
    var m = TB_MADE_METHOD[k](x);
    if (!m) return;
    methods.push(m.line);
    (m.c || []).forEach(function (ck) { if (!seen[ck]) { seen[ck] = 1; consts.push({ text: _tbT('mc_' + ck) + ': ' + TB_MADE_CONST[ck](), tile: TB_MADE_CONST_TILE[ck] }); } });
  });
  var was = host.querySelector('details'), open = was && was.open && !was.hasAttribute('data-print-opened');
  // A line, and for a constant the tile that holds it ("Physics").
  function group(key, lines) {
    return lines.length ? '<h4>' + _tbH(key) + '</h4><ul>' + lines.map(function (l) {
      if (typeof l === 'string') return '<li>' + _almEsc(l) + '</li>';
      return '<li>' + _almEsc(l.text) + ' · <button type="button" class="tb-how-k" data-tb-go="' + l.tile + '">' + _almEsc(_tbName(l.tile)) + '</button></li>';
    }).join('') + '</ul>' : '';
  }
  host.innerHTML = '<details class="tb-how"' + (open ? ' open' : '') + '><summary>' + _tbH('made_title') + '</summary>' +
    group('made_inputs', _tbMadeInputs(x)) + group('made_method', methods) + group('made_constants', consts) + '</details>';
  host.querySelectorAll('[data-tb-go]').forEach(function (b) { b.addEventListener('click', function () { _tbOpen(b.getAttribute('data-tb-go')); }); });
}
// Which Constants tile holds each constant a method rests on.
var TB_MADE_CONST_TILE = { aberration: 'k_physics', light: 'k_physics', parallax: 'k_nav', moonk: 'k_sunmoon', synodic: 'k_sunmoon',
  sidereal: 'k_earth', year: 'k_time', tai: 'k_time' };

// ═══ Constants ═══
// Each tile a table: name, value, unit, source. Every value is read from the
// named constant the sums use (or worked from them: a month from a mean
// motion), never typed again here.
var TB_DEG_PER_CENTURY_TO_DAYS = JULIAN_CENTURY * 360;   // a rate in degrees per century -> its period in days
function _tbPeriod(degPerCentury) { return TB_DEG_PER_CENTURY_TO_DAYS / degPerCentury; }
// Reference values no sum uses, shown for completeness: defined once here.
var TB_G_SI = 6.67430e-11;           // CODATA 2018
var TB_G0_M_S2 = 9.80665;            // standard gravity, exact (CGPM 1901)
var TB_ISA_T0_C = 15;                // ICAO standard atmosphere at sea level
var TB_ISA_LAPSE_K_PER_KM = 6.5;
var TB_SAROS_SYNODIC = 223;          // the Saros: 223 synodic months
var TB_S_PER_DAY_SI = 86400;
var TB_SRC_EXACT = 'SI';
// Rows: [name key, value, digits, unit, source]; value a number, or text.
var TB_CONST_ROWS = {
  k_earth: function () {
    var a = AE_EARTH_RADIUS_KM, f = AE_EARTH_FLATTENING;
    return [
      ['eq_radius', a, 3, 'km', 'WGS84'],
      ['polar_radius', a * (1 - f), 3, 'km', 'WGS84'],
      ['mean_radius', TB_EARTH_R_KM, 4, 'km', 'IUGG'],
      ['flattening', '1 / ' + _arNum(1 / f, 9), 0, '', 'WGS84'],
      ['gm_earth', AE_GM_EARTH, 4, 'km³/s²', 'WGS84'],
      ['g0', TB_G0_M_S2, 5, 'm/s²', 'CGPM'],
      ['rotation', AR_SIDEREAL_DEG_PER_DAY, 8, '°/d', 'Meeus 12.4'],
      ['obliquity', AE_OBLIQUITY_J2000_ARCSEC / 3600, 7, '°', 'Meeus 22.2'],
      ['obliquity_rate', AE_OBLIQUITY_RATE_ARCSEC, 4, '″/century', 'Meeus 22.2']
    ];
  },
  k_sunmoon: function () {
    return [
      ['au', AU_M / 1000, 0, 'km', 'IAU 2012'],
      ['sun_radius', AE_SUN_RADIUS_KM, 0, 'km', 'IAU 2015'],
      ['moon_dist', AE_MOON_MEAN_DIST_KM, 2, 'km', 'Meeus 47'],
      ['moon_radius', AE_MOON_RADIUS_KM, 1, 'km', 'IAU'],
      ['moon_k', AR_MOON_K, 7, '', 'IAU'],
      ['moon_motion', AE_MOON_MEAN_LON_RATE / JULIAN_CENTURY, 6, '°/d', 'Meeus 47.1'],
      ['sun_motion', AE_SUN_ANOMALY_RATE / JULIAN_CENTURY, 6, '°/d', 'Meeus 47.3'],
      ['synodic', _CN_SYN, 6, 'd', 'Meeus 49'],
      ['tropical_month', _tbPeriod(AE_MOON_MEAN_LON_RATE), 6, 'd', 'Meeus 47.1'],
      ['anomalistic', _tbPeriod(AE_MOON_ANOMALY_RATE), 6, 'd', 'Meeus 47.4'],
      ['draconic', _tbPeriod(AE_MOON_ARGLAT_RATE), 6, 'd', 'Meeus 47.5'],
      ['saros', TB_SAROS_SYNODIC * _CN_SYN, 3, 'd', TB_SAROS_SYNODIC + ' × ' + _tbT('mc_synodic')]
    ];
  },
  k_time: function () {
    var now = Date.now();
    return [
      ['day', TB_S_PER_DAY_SI, 0, 's', TB_SRC_EXACT],
      ['sidereal_day', 360 / AR_SIDEREAL_DEG_PER_DAY * TB_S_PER_DAY_SI, 4, 's', 'Meeus 12.4'],
      ['tropical_year', _CN_TROPICAL_YEAR, 4, 'd', 'Meeus 27'],
      ['julian_year', AR_DAYS_PER_JULIAN_YEAR, 2, 'd', TB_SRC_EXACT],
      ['julian_century', JULIAN_CENTURY, 0, 'd', TB_SRC_EXACT],
      ['jd_j2000', JD_J2000, 1, 'JD', 'IAU'],
      ['jd_unix', JD_UNIX_EPOCH, 1, 'JD', '1970-01-01 00:00 UTC'],
      ['delta_t', _cnDeltaTdays(_dateToJD(now)) * TB_S_PER_DAY_SI, 1, 's', 'Espenak, Meeus'],
      ['delta_t_measured', AR_MEASURED_DELTA_T.s, 1, 's', 'IERS ' + AR_MEASURED_DELTA_T.year],
      ['tai_utc', AR_TAI_MINUS_UTC, 0, 's', 'IERS'],
      ['last_leap', AR_LAST_LEAP_SECOND, 0, '', 'IERS']
    ];
  },
  k_nav: function () {
    return [
      ['nmi', TB_KM_PER.nm * 1000, 0, 'm', TB_SRC_EXACT],
      ['knot', TB_KM_PER.nm, 3, 'km/h', TB_SRC_EXACT],
      ['refraction', AR_MOON_REFRACTION_DEG * TB_ARCMIN_PER_DEG, 0, '′', 'Nautical Almanac'],
      ['std_air', AR_STD_TEMP_C + ' °C · ' + AR_STD_PRESSURE_HPA + ' hPa', 0, '', 'Nautical Almanac'],
      ['dip', AR_DIP_ARCMIN_PER_SQRT_M, 2, '′ × √m', 'Nautical Almanac'],
      ['horizon', SKY_EYE_KM, 2, 'km × √m', 'Bowditch'],
      ['sun_sd', (-AR_SUNRISE_ALT - AR_MOON_REFRACTION_DEG) * TB_ARCMIN_PER_DEG, 0, '′', 'NOAA'],
      ['sunrise_alt', AR_SUNRISE_ALT * TB_ARCMIN_PER_DEG, 0, '′', 'NOAA'],
      ['moon_hp', AR_MOON_HP_FACTOR, 4, '× HP', 'Meeus 15'],
      ['sun_parallax', AR_SOLAR_PARALLAX_ARCSEC, 3, '″', 'IAU'],
      ['twilights', [AR_TWILIGHT_ALTS.civil, AR_TWILIGHT_ALTS.nautical, AR_TWILIGHT_ALTS.astronomical].join('°, ') + '°', 0, '', 'USNO']
    ];
  },
  k_physics: function () {
    var atm = _tbUnitFactor('pressure', 'atm');
    return [
      ['c', SPEED_OF_LIGHT_M_S, 0, 'm/s', TB_SRC_EXACT],
      ['g', TB_G_SI.toExponential(5), 0, 'm³/(kg·s²)', 'CODATA 2018'],
      ['light_au', AR_LIGHT_DAYS_PER_AU * TB_S_PER_DAY_SI, 3, 's', 'Meeus 33.3'],
      ['aberration', AR_ABERRATION_ARCSEC, 5, '″', 'Meeus 23'],
      ['atm', atm, 0, 'Pa', TB_SRC_EXACT],
      ['sea_pressure', atm / _tbUnitFactor('pressure', 'hpa'), 2, 'hPa', 'ICAO'],
      ['isa_t0', TB_ISA_T0_C, 0, '°C', 'ICAO'],
      ['lapse', TB_ISA_LAPSE_K_PER_KM, 1, 'K/km', 'ICAO'],
      ['zero_c', TB_ZERO_C_K, 2, 'K', TB_SRC_EXACT]
    ];
  },
  k_units: function () {
    var rows = [];
    Object.keys(TB_UNITS).forEach(function (kind) {
      var base = TB_UNITS[kind].filter(function (u) { return u[1] === 1; })[0];
      if (!base) return;
      TB_UNITS[kind].forEach(function (u) {
        if (u === base) return;
        rows.push([null, u[1], null, _tbUnitSym(base[0]), TB_SRC_EXACT, '1 ' + _tbUnitSym(u[0]) + ' (' + _tbT('u_' + u[0]) + ')']);
      });
    });
    rows.push([null, '(°F − ' + TB_F_ZERO_C + ') × 5/9', 0, '°C', TB_SRC_EXACT, '°F']);
    return rows;
  }
};
// A value as the table shows it: text as it is; a number to its digits, or
// to its own significant figures when it has none.
function _tbConstVal(v, d) {
  if (typeof v !== 'number') return String(v);
  return d == null ? _tbSig(v, true) : _arNum(v, d);
}
function _tbRenderConst(body) {
  var rows = TB_CONST_ROWS[_tb.id]().map(function (r) {
    var name = r[5] || _tbT('kn_' + r[0]);
    // The unit beside its value: four columns do not fit a phone.
    return '<tr><th scope="row">' + _almEsc(name) + '</th><td><span dir="ltr">' + _almEsc(_tbConstVal(r[1], r[2]) + (r[3] ? ' ' + r[3] : '')) + '</span></td>' +
      '<td class="tb-src">' + _almEsc(r[4] === TB_SRC_EXACT ? 'SI · ' + _tbT('k_exact') : r[4]) + '</td></tr>';
  }).join('');
  body.innerHTML = '<div id="tb-print-head"></div><div class="tb-out" id="tb-out">' +
    _tbTable(_tbHead([_tbH('k_name'), _tbH('k_value') + ' (' + _tbH('k_unit') + ')', _tbH('k_source')]), rows, 'tb-consts') + '</div>';
  _tbEl('tb-print-head').innerHTML = _tbPrintHead([]);
}

// The heading only paper carries: what, where, when, and when worked out.
function _tbPrintHead(lines) {
  return '<header class="tb-printhead"><h1>' + _almEsc(_tbName(_tb.id)) + '</h1>' +
    lines.filter(Boolean).map(function (l) { return '<p>' + _almEsc(l) + '</p>'; }).join('') +
    '<p class="tb-made">' + _tbH('made', { date: _tbLongDay(_tbDayIn(Date.now(), null)) }) + '</p></header>';
}

// ═══════════════════════════════════════════════════════════════════════
// Tables
// ═══════════════════════════════════════════════════════════════════════
function _tbWinState(id) {
  var w = _tb.win[id];
  if (!w) {
    var k = _tbDayIn(_almFocusInstant().getTime(), _tb.place.tz);
    w = _tb.win[id] = { win: TB_DEFAULT_WIN[id] || 'month', anchor: k, from: k, to: _tbAddDays(k, 30) };
  }
  return w;
}
// The window's first and last day, and how to say it.
function _tbSpan(w) {
  var a = w.anchor, from, to, label;
  if (w.win === 'day') { from = to = a; label = _tbLongDay(a); }
  else if (w.win === 'week') {
    var j = _tbJdn(a), first = _tbWeekStart();          // 0 Sun, 1 Mon
    var back = ((j + 1) % 7 - first + 7) % 7;           // (JDN + 1) mod 7 is 0 on a Sunday
    from = _tbKey(j - back); to = _tbAddDays(from, 6); label = _tbRangeText(from, to);
  } else if (w.win === 'month') { from = { y: a.y, m: a.m, d: 1 }; to = { y: a.y, m: a.m, d: _tbDim(a.y, a.m) }; label = _tbMonthYear(a); }
  else if (w.win === 'year') { from = { y: a.y, m: 1, d: 1 }; to = { y: a.y, m: 12, d: 31 }; label = String(a.y); }
  else {
    from = w.from; to = w.to;
    if (_tbJdn(to) < _tbJdn(from)) { var x = from; from = to; to = x; }
    label = _tbRangeText(from, to);
  }
  var days = _tbJdn(to) - _tbJdn(from) + 1;
  return { from: from, to: to, label: label, days: days, months: from.y !== to.y || from.m !== to.m, years: from.y !== to.y };
}
function _tbStep(w, dir) {
  var a = w.anchor;
  if (w.win === 'day') w.anchor = _tbAddDays(a, dir);
  else if (w.win === 'week') w.anchor = _tbAddDays(a, 7 * dir);
  else if (w.win === 'month') w.anchor = _tbAddMonths(a, dir);
  else if (w.win === 'year') w.anchor = _tbAddMonths(a, 12 * dir);
  else {
    var n = (_tbJdn(w.to) - _tbJdn(w.from) + 1) * dir;
    w.from = _tbAddDays(w.from, n); w.to = _tbAddDays(w.to, n);
  }
}
// A range of days too long to draw is cut to its first TB_MAX_DAYS.
function _tbCapDays(span, max) {
  if (span.days <= max) return span;
  var s = Object.assign({}, span);
  s.to = _tbAddDays(span.from, max - 1); s.days = max; s.capped = true; s.months = true; s.years = s.from.y !== s.to.y;
  return s;
}

function _tbRenderTable(body) {
  var id = _tb.id, w = _tbWinState(id);
  var fixedPlace = id === 'tides' || id === 'nav';
  var html = '<div class="tb-controls">' +
    _tkSeg('win', _tbT('window'), TB_WINDOWS.map(function (k) { return { v: k, label: _tbT('w_' + k) }; }), w.win, function (v) {
      if (v === 'range') { var s = _tbSpan(w); w.from = s.from; w.to = s.to; }
      w.win = v; _tbRenderTable(body);
    }) +
    '<div class="tb-controls-row">' +
      (w.win === 'range'
        ? '<span class="tb-range">' + _tkDate('from', _tbDayDate(w, 'from', _tbT('from'))) + '<span class="tb-dash" aria-hidden="true">–</span>' + _tkDate('to', _tbDayDate(w, 'to', _tbT('to'))) + '</span>'
        : '<span class="tb-stepper"><button type="button" class="tb-stepbtn" data-tb-step="-1" aria-label="' + _tbH('earlier') + '">' + TB_BACK_SVG + '</button>' +
          // The day shown, over a date input: a tap opens the device's own
          // calendar ("tapping date should bring up calendar chooser", Eric).
          '<span class="tb-span-pick"><span class="tb-span" data-tb-today aria-hidden="true"></span>' +
          '<input type="date" class="tb-span-in" data-tb-date-in aria-label="' + _tbH('date') + '" title="' + _tbH('date') + '"></span>' +
          '<button type="button" class="tb-stepbtn tb-fwd" data-tb-step="1" aria-label="' + _tbH('later') + '">' + TB_BACK_SVG + '</button></span>') +
      (fixedPlace ? '' : _tkPlace('place', { label: _tbT('place'), get: function () { return _tb.place; }, set: function (p) { _tb.place = p; } })) +
    '</div></div>' +
    '<div id="tb-print-head"></div><div class="tb-out" id="tb-out" aria-live="polite"></div><div id="tb-how"></div>';
  body.innerHTML = html;
  body.querySelectorAll('[data-tb-step]').forEach(function (b) {
    b.addEventListener('click', function () { _tbStep(w, +b.getAttribute('data-tb-step')); _tbDrawTable(); });
  });
  var pick = body.querySelector('[data-tb-date-in]');
  if (pick) {
    pick.addEventListener('click', function () { try { if (pick.showPicker) pick.showPicker(); } catch (e) {} });
    pick.addEventListener('change', function () {
      var k = _tbIsoDay(pick.value);
      if (!k) return;
      w.anchor = k;
      _tbDrawTable();
    });
  }
  _tb.changed = function () { _tbDrawTable(); };
  _tkPaint(body);
  _tbDrawTable();
}
// A day as a date input holds it (yyyy-mm-dd, years 1 to 9999 only), and back.
var TB_ISO_YEARS = [1, 9999];
function _tbIsoText(k) {
  if (!k || k.y < TB_ISO_YEARS[0] || k.y > TB_ISO_YEARS[1]) return '';
  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
  return pad(k.y, 4) + '-' + pad(k.m, 2) + '-' + pad(k.d, 2);
}
function _tbIsoDay(v) {
  var m = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(v || '');
  if (!m) return null;
  var k = { y: +m[1], m: +m[2], d: +m[3] };
  return k.m >= 1 && k.m <= 12 && k.d >= 1 && k.d <= _tbDim(k.y, k.m) ? k : null;
}
// The range's ends as date pills: a day, kept at noon in the place's zone.
function _tbDayDate(w, end, label) {
  return { label: label, tz: 'UTC', time: false,
    get: function () { return _arDayMs(w[end]) + 12 * TB_MS_HOUR; },
    set: function (ms) { w[end] = _tbDayIn(ms, 'UTC'); } };
}

// Draw the open table for its window and place. Heavy tables keep the old
// rows on screen, dimmed, until the new ones are ready.
function _tbDrawTable() {
  var out = _tbEl('tb-out');
  if (!out) return;
  var id = _tb.id, w = _tbWinState(id), span = _tbSpan(w);
  var lbl = document.querySelector('[data-tb-today]');
  if (lbl) lbl.textContent = span.label;
  var pickIn = document.querySelector('[data-tb-date-in]');
  if (pickIn) pickIn.value = _tbIsoText(w.anchor);
  var seq = ++_tb.seq;
  out.classList.add('tb-busy');
  if (!out.firstChild) out.innerHTML = '<p class="tb-wait" role="status">' + _almEsc(t('ref_working')) + '</p>';
  requestAnimationFrame(function () {
    setTimeout(function () {
      if (seq !== _tb.seq || !out.isConnected) return;
      var res;
      try { res = TB_RENDER[id](span, _tb.place); }
      catch (e) { res = { html: '<p class="tb-empty">' + _tbH('failed') + '</p>' }; if (window.console) console.error(e); }
      out.innerHTML = res.html;
      out.classList.remove('tb-busy');
      var p = _tb.place;
      var placeLine = res.place === false ? null : res.place || (p.name + ' · ' + _tbPlaceLine(p));
      var ph = _tbEl('tb-print-head');
      if (ph) ph.innerHTML = _tbPrintHead([placeLine, span.label + (res.step ? ' · ' + res.step : '')]);
      _tbMadeFill({ place: res.place === false ? null : p, range: span.label, mid: _tbMid(span), made: res.made });
      out.querySelectorAll('table').forEach(function (tb) {
        if (tb.classList.contains('tb-ltr')) tb.setAttribute('dir', 'ltr');
        // A two-row head: the second row sticks under the first, at its real height.
        var h1 = tb.tHead && tb.tHead.rows[1] ? tb.tHead.rows[0].offsetHeight : 0;
        if (h1) tb.style.setProperty('--tb-h1', h1 + 'px');
      });
      var today = out.querySelector('.tb-today');
      if (today && out.querySelector('.tb-frame')) {
        var fr = out.querySelector('.tb-frame');
        fr.scrollTop = Math.max(0, today.offsetTop - fr.clientHeight / 3);
      }
    }, 0);
  });
}

// A table of rows in a scrolling frame: the head stays at the top and the
// first column at the start while the rest scrolls under them.
function _tbTable(head, rows, cls) {
  return '<div class="tb-frame"><table class="tb-table' + (cls ? ' ' + cls : '') + '"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>';
}
function _tbHead(cells) { return '<tr>' + cells.map(function (c) { return '<th scope="col">' + c + '</th>'; }).join('') + '</tr>'; }
function _tbRow(cells, cls) {
  return '<tr' + (cls ? ' class="' + cls + '"' : '') + '><th scope="row">' + cells[0] + '</th>' +
    cells.slice(1).map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
}
// A month's (or a year's) heading across a long table.
function _tbGroupRow(text, n) { return '<tr class="tb-grp"><th colspan="' + n + '" scope="colgroup"><span>' + _almEsc(text) + '</span></th></tr>'; }
function _tbEmpty(key, vars) { return '<p class="tb-empty">' + _tbH(key || 'empty', vars) + '</p>'; }
function _tbNote(html) { return '<p class="tb-note">' + html + '</p>'; }
function _tbCapNote(span) { return span.capped ? _tbNote(_tbH('capped', { n: _arNum(span.days, 0) })) : ''; }

// Rows of days: one per day of the span, a heading at each new month when
// the span holds more than one, the Almanac's own day lit.
function _tbDayRows(days, span, cells) {
  var focus = _tbDayIn(_almFocusInstant().getTime(), _tb.place.tz), lastM = null, n = 0, out = '';
  days.forEach(function (r) {
    var c = cells(r);
    n = c.length;
    if (span.days > 31 && r.m !== lastM) out += _tbGroupRow(_tbMonthYear(r), n);
    lastM = r.m;
    out += _tbRow([_tbDayCell(r, { months: false, years: false })].concat(c.slice(1)), _tbSame(r, focus) ? 'tb-today' : (c.cls || ''));
  });
  return out;
}

// ── The days of one place, worked out once for the tables that share them ──
var _tbSpanMemo = { key: null, v: null };
function _tbSunMoonDays(span, p) {
  var key = [span.from.y, span.from.m, span.from.d, span.to.y, span.to.m, span.to.d, p.lat, p.lon, p.tz].join('|');
  if (_tbSpanMemo.key !== key) _tbSpanMemo = { key: key, v: _arSpan(span.from, span.to, p.lat, p.lon, p.tz) };
  return _tbSpanMemo.v;
}
function _tbPhaseGlyph(q) {
  return '<span class="tb-ph" title="' + _almEsc(t('ref_' + AR_PHASE_KEYS[q])) + '">' + _moonGlyphSVG(q / 4, 14) + '</span>';
}
// The Moon on a day, at its noon there: the principal phase's glyph when one
// falls that day, otherwise the day's own. With words: its name (the
// principal phase's, with its time, when `principal` is given) and how much
// is lit.
function _tbDayPhase(r, tz, words, principal) {
  var noon = r.noon || _tkFromParts({ y: r.y, m: r.m, d: r.d, h: 12, mi: 0 }, tz);
  var ph = _moonPhase(new Date(noon));
  // Between the principal phases a day is a crescent or a gibbous Moon: the
  // broad names (New Moon, First Quarter...) belong to the principal days.
  var between = _localMoonName((ph.phase < 0.5 ? 'Waxing ' : 'Waning ') + (ph.illumination < 50 ? 'Crescent' : 'Gibbous'));
  var glyph = r.phase != null ? _tbPhaseGlyph(r.phase)
    : '<span class="tb-ph" title="' + _almEsc(between) + '">' + _moonGlyphSVG(ph.phase, 14) + '</span>';
  if (!words) return glyph;
  var name = principal ? '<span class="tb-hi">' + _arTH(AR_PHASE_KEYS[principal.q]) + ' ' + _tbTime(principal.ms, tz) + '</span>'
    : _almEsc(between);
  return glyph + ' ' + name + ' <span class="tb-dim">' + _tbH('lit', { n: _arNum(ph.illumination, 0) }) + '</span>';
}
function _tbTime(ms, tz) { return '<span dir="ltr">' + _almEsc(_arTime(ms, tz)) + '</span>'; }

var TB_RENDER = {
  sunmoon: function (span, p) {
    span = _tbCapDays(span, TB_MAX_DAYS);
    var S = _tbSunMoonDays(span, p), tz = p.tz;
    var head = _tbHead([_arTH('day'), _tbH('sunrise'), _tbH('noon'), _tbH('sunset'), _tbH('daylength'), _tbH('noon_height'), _tbH('moonrise'), _tbH('moonset'), _arTH('phase')]);
    var rows = _tbDayRows(S.rows, span, function (r) {
      var rise = r.polar ? '<span class="tb-dim">' + _arTH(r.polar === 'up' ? 'up_all_day' : 'down_all_day') + '</span>' : _tbTime(r.rise, tz);
      return [null, rise, _tbTime(r.noon, tz), r.polar ? '' : _tbTime(r.set, tz),
        r.polar === 'up' ? '24:00' : (r.polar === 'down' ? '0:00' : _arDuration(r.length)),
        r.noonAlt != null ? _arNum(r.noonAlt, 1) + '°' : '–',
        _tbTime(r.moonrise, tz), _tbTime(r.moonset, tz), _tbDayPhase(r, tz, false)];
    });
    return { html: _arDeltaTNote(span.from.y) + _tbTable(head, rows) + _tbCapNote(span) + _tbNote(_tbH('sunmoon_note')) };
  },
  twilight: function (span, p) {
    span = _tbCapDays(span, TB_MAX_DAYS);
    var S = _tbSunMoonDays(span, p), tz = p.tz;
    var head = '<tr><th scope="col" rowspan="2">' + _arTH('day') + '</th><th scope="colgroup" colspan="3" class="tb-sep">' + _arTH('dawn') + '</th>' +
      '<th scope="colgroup" colspan="2" class="tb-sep">' + _arTH('sun') + '</th><th scope="colgroup" colspan="3" class="tb-sep">' + _arTH('dusk') + '</th></tr>' +
      '<tr>' + [_arTH('astro'), _arTH('nautical'), _arTH('civil'), _arTH('rise'), _arTH('set'), _arTH('civil'), _arTH('nautical'), _arTH('astro')].map(function (c, i) {
        return '<th scope="col"' + (i === 0 || i === 3 || i === 5 ? ' class="tb-sep"' : '') + '>' + c + '</th>';
      }).join('') + '</tr>';
    var rows = _tbDayRows(S.rows, span, function (r) {
      return [null, _tbTime(r.astronomicalDawn, tz), _tbTime(r.nauticalDawn, tz), _tbTime(r.civilDawn, tz),
        r.polar ? '<span class="tb-dim">' + _arTH(r.polar === 'up' ? 'up_all_day' : 'down_all_day') + '</span>' : _tbTime(r.rise, tz),
        r.polar ? '' : _tbTime(r.set, tz), _tbTime(r.civilDusk, tz), _tbTime(r.nauticalDusk, tz), _tbTime(r.astronomicalDusk, tz)];
    });
    return { html: _arDeltaTNote(span.from.y) + _tbTable(head, rows) + _tbCapNote(span) + _tbNote(_tbH('twilight_note')) };
  },
  // Every day's Moon, its principal phases picked out with their times
  // ("why not show the phase per day instead of empty sometimes", Eric).
  phases: function (span, p) {
    span = _tbCapDays(span, TB_MAX_DAYS);
    var S = _tbSunMoonDays(span, p), tz = p.tz, at = {};
    S.phases.forEach(function (ph) { at[_arKeyNum(_tbDayIn(ph.ms, tz))] = ph; });
    var rows = _tbDayRows(S.rows, span, function (r) {
      var ph = at[_arKeyNum(r)];
      return [null, _tbDayPhase(r, tz, true, ph)];
    });
    return { html: _tbTable(_tbHead([_arTH('day'), _arTH('phase')]), rows, 'tb-phases') + _tbCapNote(span) };
  },
  tides: function (span) {
    var st = typeof _atTideStation === 'function' && _at.data && !_at.data.failed ? _atTideStation() : null;
    if (!_getLocation().stored || !st) return { html: _tbEmpty('tide_none'), place: false };
    span = _tbCapDays(span, TB_MAX_DAYS / 3);
    var tz = _atTideTz(st), pr = _atPredictor(st);
    if (_atBeyond(_arDayMs(span.from))) return { html: _tbEmpty('tide_far', { n: AT_TIDE_YEARS }), place: false };
    var days = [];
    for (var j = _tbJdn(span.from); j <= _tbJdn(span.to); j++) days.push(_tbKey(j));
    var rows = _tbDayRows(days, span, function (k) {
      var s = _atMidnight(k.y, k.m - 1, k.d, tz), e = _atMidnight(k.y, k.m - 1, k.d + 1, tz);
      var turns = pr.extremes(s, e), cells = [null];
      for (var i = 0; i < 4; i++) {
        var tn = turns[i];
        cells.push(tn ? '<span class="' + (tn.high ? 'tb-hi' : 'tb-lo') + '"><span dir="ltr">' + _almEsc(_arTime(tn.t, tz)) + '</span> <span class="tb-h">' + _almEsc(_atHeight(tn.h, true)) + '</span></span>' : '');
      }
      return cells;
    });
    var unit = t(_atUnits() === 'ft' ? 'alm_unit_ft' : 'alm_unit_m');
    var head = '<tr><th scope="col">' + _arTH('day') + '</th><th scope="colgroup" colspan="4">' + _almEsc(t('alm_tide_col_turns')) + ' (' + _almEsc(unit) + ')</th></tr>';
    var station = _atTideName(st);
    return { place: _tbT('tide_station', { name: station }) + ' · ' + tz,
      made: { station: station, n: pr.n, ref: st.refrec ? _atTitle(st.refrec.n) : null, tz: tz, units: unit },
      html: '<p class="tb-lede">' + _tbH('tide_station', { name: station }) + '</p>' + _tbTable(head, rows, 'tb-tides') + _tbCapNote(span) +
        _tbNote(_almEsc(st.refrec ? t('alm_tide_note_sub', { ref: _atTitle(st.refrec.n) }) : t('alm_tide_note')) + ' ' +
          _almEsc(t('alm_tide_sheet_source', { lat: st.la.toFixed(3), lon: st.lo.toFixed(3), id: st.id }))) };
  },
  nav: function (span) { return _tbNav(span); },
  stars: function (span, p) {
    var y0 = span.from.y, y1 = Math.min(span.to.y, y0 + TB_MAX_STAR_YEARS - 1), ev = [], none = {};
    var lo = _arKeyNum(span.from), hi = _arKeyNum(span.to);
    for (var y = y0; y <= y1; y++) {
      _arStarCalendar(y, p.lat, p.lon).forEach(function (s) {
        if (s.none) { none[s.none] = none[s.none] || {}; none[s.none][s.name] = 1; return; }
        [['rising', 'first_dawn'], ['setting', 'last_dusk']].forEach(function (f) {
          if (s[f[0]] == null) return;
          var k = _tbDayIn(s[f[0]], p.tz), n = _arKeyNum(k);
          if (n >= lo && n <= hi) ev.push({ ms: s[f[0]], k: k, name: s.name, mag: s.mag, what: f[1] });
        });
      });
    }
    ev.sort(function (a, b) { return a.ms - b.ms; });
    var rows = '', lastY = null;
    ev.forEach(function (e) {
      if (span.years && e.k.y !== lastY) rows += _tbGroupRow(String(e.k.y), 4);
      lastY = e.k.y;
      rows += _tbRow([_almEsc(_tbDate(e.k, { month: 'short', day: 'numeric' })), _almEsc(e.name), _arTH(e.what), _arMag(e.mag)], e.what === 'first_dawn' ? 'tb-rise' : '');
    });
    var notes = ['never', 'always', 'seen'].map(function (why) {
      var names = Object.keys(none[why] || {});
      return names.length ? _tbNote(_arTH('star_' + why, { names: names.join(', ') })) : '';
    }).join('');
    return { html: '<p class="tb-lede">' + _arTH('stars_lede') + '</p>' + (ev.length ? _tbTable(_tbHead([_arTH('date'), _arTH('star'), _tbH('event'), _arTH('mag')]), rows) : _tbEmpty('no_star')) +
      notes + _tbNote(_arTH('stars_how')) };
  },
  seasons: function (span, p) {
    var lo = _arKeyNum(span.from), hi = _arKeyNum(span.to), rows = '', n = 0, south = p.lat < 0;
    var keys = south ? ['autumn_eq', 'winter_sol', 'spring_eq', 'summer_sol'] : ['spring_eq', 'summer_sol', 'autumn_eq', 'winter_sol'];
    var y1 = Math.min(span.to.y, span.from.y + TB_MAX_YEARS);
    var all = [];
    for (var y = span.from.y; y <= y1 + 1; y++) _arSeasons(y).forEach(function (ms, i) { all.push({ ms: ms, i: i }); });
    all.forEach(function (s, i) {
      var k = _tbDayIn(s.ms, p.tz), kn = _arKeyNum(k);
      if (kn < lo || kn > hi || !all[i + 1]) return;
      var len = all[i + 1].ms - s.ms, d = Math.floor(len / MS_PER_DAY), h = Math.round((len - d * MS_PER_DAY) / TB_MS_HOUR);
      n++;
      rows += _tbRow(['<span dir="ltr">' + _almEsc(_tbWhen(s.ms, p.tz, true)) + '</span>', _arTH(keys[s.i]), _tbH('days_hours', { d: d, h: h })]);
    });
    return { html: n ? _tbTable(_tbHead([_tbH('when'), _tbH('event'), _tbH('season_len')]), rows) + _tbNote(_tbH('seasons_note')) : _tbEmpty() };
  },
  eclipses: function (span, p) {
    var lo = _arKeyNum(span.from), hi = _arKeyNum(span.to), rows = '', n = 0;
    var y1 = Math.min(span.to.y, span.from.y + TB_MAX_YEARS - 1), tz = p.tz;
    for (var y = span.from.y; y <= y1; y++) {
      _arYearEclipses(y, p.lat, p.lon).forEach(function (e) {
        var k = _tbDayIn(e.ms, tz), kn = _arKeyNum(k);
        if (kn < lo || kn > hi) return;
        n++;
        var here = e.here
          ? _arT(e.solar ? 'eclipse_seen_solar' : 'eclipse_seen_lunar', { kind: _arT('ecl_' + e.here.kind), pct: _arNum(Math.max(0, e.here.mag) * 100, 0), mag: _arNum(Math.max(0, e.here.mag), 2), time: _arTime(e.here.ms, tz), from: _arTime(e.here.start, tz), to: _arTime(e.here.end, tz) })
          : _arT('eclipse_not_seen');
        rows += _tbRow(['<span dir="ltr">' + _almEsc(_tbWhen(e.ms, tz, true)) + '</span>', _almEsc(e.type), '<span class="tb-txt">' + _almEsc(here) + '</span>'], e.here ? 'tb-seen' : '');
      });
    }
    return { html: n ? _tbTable(_tbHead([_tbH('when'), _tbH('eclipse'), _tbH('from_here')]), rows, 'tb-wrap') : _tbEmpty('no_eclipse') };
  },
  calendars: function (span) {
    span = _tbCapDays(span, TB_MAX_DAYS);
    var feasts = {}, years = {};
    for (var y = span.from.y; y <= span.to.y; y++) {
      var h = _arHolidays(y);
      AR_HOLIDAY_COLS.forEach(function (k) {
        [].concat(h[k] == null ? [] : h[k]).forEach(function (j) { (feasts[j] = feasts[j] || []).push(_arT('h_' + k)); });
      });
      var c = _arComputusGregorian(y);
      years[y] = _tbT('computus_line', { year: y, g: c.golden, e: c.epact, l: c.letters });
    }
    var others = AR_CAL_SYSTEMS.filter(function (s) { return s !== 'gregorian'; });
    var head = _tbHead([_arTH('day')].concat(others.map(function (s) { return _almEsc(_arCalLabel(s)); })).concat([_tbH('feasts')]));
    var focus = _tbDayIn(_almFocusInstant().getTime(), _tb.place.tz), rows = '', lastM = null, lastY = null;
    for (var j = _tbJdn(span.from); j <= _tbJdn(span.to); j++) {
      var k = _tbKey(j);
      if (k.y !== lastY) rows += _tbGroupRow(years[k.y], others.length + 2);
      else if (span.days > 31 && k.m !== lastM) rows += _tbGroupRow(_tbMonthYear(k), others.length + 2);
      lastY = k.y; lastM = k.m;
      var cells = [_tbDayCell(k, {})].concat(others.map(function (s) { return _almEsc(_tbCalShort(s, _arCalFromJDN(s, j))); }));
      cells.push(feasts[j] ? '<span class="tb-feast">' + _almEsc(feasts[j].join(', ')) + '</span>' : '');
      rows += _tbRow(cells, _tbSame(k, focus) ? 'tb-today' : (feasts[j] ? 'tb-feastrow' : ''));
    }
    return { place: false, html: _tbTable(head, rows) + _tbCapNote(span) + _tbNote(_arTH('feasts_notes')) };
  },
  suntime: function (span, p) {
    span = _tbCapDays(span, TB_MAX_DAYS);
    var rows = _arSunTimeSpan(span.from, span.to, p.lon, p.tz);
    var fig = span.days >= 365 ? '<figure class="tb-figure">' + _arAnalemmaSvg(rows.slice(0, 366)) + '<figcaption>' + _arTH('analemma_caption') + '</figcaption></figure>' : '';
    var head = _tbHead([_arTH('day'), _arTH('sundial_noon'), _arTH('eot'), _arTH('correction'), _tbH('declination')]);
    var body = _tbDayRows(rows, span, function (r) {
      return [null, _tbTime(r.noon, p.tz), '<span dir="ltr">' + _arMinSec(r.eot) + '</span>', '<span dir="ltr">' + _arMinSec(r.correction) + '</span>',
        '<span dir="ltr">' + _arNavDec(r.dec) + '</span>'];
    });
    return { html: '<p class="tb-lede">' + _arTH('suntime_lede') + '</p>' + _tbTable(head, body) + _tbCapNote(span) + _tbNote(_arTH('correction_how')) + fig };
  }
};
// A date in another calendar, short: "19 Tishrei 5787".
function _tbCalShort(sys, c) {
  var months = _arCalMonths(sys, c.year);
  var name = sys === 'julian' ? _arMonthShort(c.month) : (months[c.month - 1] || {}).name;
  return c.day + ' ' + name + ' ' + c.year;
}

// ── Navigation: the Nautical Almanac's pages for the window ──
function _tbNav(span) {
  var hourly = span.days <= TB_NAV_HOURLY_MAX_DAYS;
  span = _tbCapDays(span, TB_MAX_DAYS / 3);
  var t0 = _arDayMs(span.from), steps = hourly ? span.days * AR_HOURS : span.days, dt = hourly ? AR_MS_PER_HOUR : MS_PER_DAY;
  var rows = [];
  for (var i = 0; i <= steps; i++) rows.push(_arNavAt(t0 + i * dt, null));
  function step(a, b) { return _arDeltaDeg(b, a); }
  function ut(i) {
    var ms = t0 + i * dt;
    return hourly ? String(new Date(ms).getUTCHours()).padStart(2, '0') : _almEsc(_tbDayCell(_tbDayIn(ms, 'UTC'), { months: true, years: span.years }));
  }
  function group(i, n) {
    if (!hourly || i % AR_HOURS || span.days === 1) return '';
    return _tbGroupRow(_tbLongDay(_tbDayIn(t0 + i * dt, 'UTC')), n);
  }
  var perHour = hourly ? 1 : AR_HOURS;
  var head = '<tr><th scope="col" rowspan="2">UT</th><th scope="colgroup" colspan="2" class="tb-sep">' + _arTH('sun') + '</th><th scope="colgroup" colspan="5" class="tb-sep">' + _arTH('moon') + '</th></tr>' +
    '<tr><th scope="col" class="tb-sep">GHA</th><th scope="col">Dec</th><th scope="col" class="tb-sep">GHA</th>' +
    '<th scope="col">v</th><th scope="col">Dec</th><th scope="col">d</th><th scope="col">HP</th></tr>';
  var b1 = '';
  for (var h = 0; h < steps; h++) {
    var r = rows[h], n = rows[h + 1];
    var v = hourly ? (step(r.moon.gha, n.moon.gha) * 60 - AR_MOON_V_BASE_ARCMIN).toFixed(1) : '';
    var d = hourly ? ((n.moon.dec - r.moon.dec) * 60).toFixed(1) : ((n.moon.dec - r.moon.dec) * 60 / perHour).toFixed(1);
    b1 += group(h, 8) + _tbRow([ut(h), _arNavGha(r.sun.gha), _arNavDec(r.sun.dec), _arNavGha(r.moon.gha), v, _arNavDec(r.moon.dec), d, r.moon.hp.toFixed(1)], hourly && h % 6 === 5 ? 'tb-six' : '');
  }
  var head2 = '<tr><th scope="col" rowspan="2">UT</th><th scope="col" class="tb-sep">' + _arTH('aries') + '</th>' +
    AR_PLANETS.map(function (p) { return '<th scope="colgroup" colspan="2" class="tb-sep">' + _almEsc(_tp(p.charAt(0).toUpperCase() + p.slice(1))) + '</th>'; }).join('') + '</tr>' +
    '<tr><th scope="col" class="tb-sep">GHA</th>' + AR_PLANETS.map(function () { return '<th scope="col" class="tb-sep">GHA</th><th scope="col">Dec</th>'; }).join('') + '</tr>';
  var b2 = '';
  for (h = 0; h < steps; h++) {
    var cells = [ut(h), _arNavGha(rows[h].aries)];
    AR_PLANETS.forEach(function (p) { cells.push(_arNavGha(rows[h][p].gha), _arNavDec(rows[h][p].dec)); });
    b2 += group(h, 10) + _tbRow(cells, hourly && h % 6 === 5 ? 'tb-six' : '');
  }
  var html = '<p class="tb-lede">' + _arTH('daily_lede') + ' ' + _tbH(hourly ? 'nav_hourly' : 'nav_daily') + '</p>' + _arDeltaTNote(span.from.y) +
    '<h3 class="tb-h3">' + _arTH('sun_moon') + '</h3>' + _tbTable(head, b1, 'tb-ltr tb-mono') +
    '<h3 class="tb-h3">' + _arTH('aries_planets') + '</h3>' + _tbTable(head2, b2, 'tb-ltr tb-mono');
  // The day's figures, for a single day.
  if (span.days === 1) {
    var day = t0;
    var mp = function (key, target) { return _arMerPass(rows, key, target || 0); };
    var ph = _moonPhase(new Date(day + 12 * AR_MS_PER_HOUR));
    var kv = [
      [_arT('eot') + ' 00h', _arMinSec(_arEquationOfTime(day).eot)], [_arT('eot') + ' 12h', _arMinSec(_arEquationOfTime(day + 12 * AR_MS_PER_HOUR).eot)],
      [_arT('sun') + ' · ' + _arT('mer_pass'), mp('sun')],
      [_arT('moon') + ' · ' + _arT('mer_pass_upper'), mp('moon')], [_arT('moon') + ' · ' + _arT('mer_pass_lower'), mp('moon', 180)],
      [_arT('moon_age'), _arT('days_n', { n: _arNum(ph.phase * _CN_SYN, 1) })], [_arT('moon_lit'), _arNum(ph.illumination, 0) + '%'],
      [_arT('aries') + ' · ' + _arT('mer_pass'), mp('aries')]
    ];
    AR_PLANETS.forEach(function (p) {
      kv.push([_tp(p.charAt(0).toUpperCase() + p.slice(1)) + ' · SHA / ' + _arT('mer_pass'), _arNavGha(_arNorm360(rows[12][p].gha - rows[12].aries)).trim() + ' / ' + mp(p)]);
    });
    html += '<h3 class="tb-h3">' + _arTH('day_figures') + '</h3><dl class="tb-kv">' + kv.map(function (x) {
      return '<div><dt>' + _almEsc(x[0]) + '</dt><dd dir="ltr">' + _almEsc(x[1]) + '</dd></div>';
    }).join('') + '</dl>';
  }
  // The stars, at 12h UT of the window's first day: their SHA moves a few tenths a month.
  var noon = _arNavAt(t0 + 12 * AR_MS_PER_HOUR, { noPlanets: true, stars: true }).stars;
  var stars = noon.filter(function (s) { return s.num > 0; }), polaris = noon.filter(function (s) { return s.num === 0; })[0];
  var b3 = stars.map(function (s) { return _tbRow([String(s.num), _almEsc(s.name), _arNavGha(s.sha), _arNavDec(s.dec), _arMag(s.mag)]); }).join('') +
    _tbRow(['', _almEsc(polaris.name), _arNavGha(polaris.sha), _arNavDec(polaris.dec), _arMag(polaris.mag)], 'tb-foot');
  html += '<h3 class="tb-h3 tb-pagebreak">' + _arTH('stars_h') + ' · ' + _almEsc(_tbShortDay(span.from)) + ' 12h UT</h3>' +
    _tbTable(_tbHead(['No.', _arTH('star'), 'SHA', 'Dec', _arTH('mag')]), b3, 'tb-ltr tb-mono') + _tbCapNote(span) +
    _tbNote(_arTH('daily_how')) + _tbNote(_arTH('daily_accuracy'));
  return { html: html, place: false, step: _tbT(hourly ? 'nav_hourly' : 'nav_daily') };
}

// ═══════════════════════════════════════════════════════════════════════
// Calculations
// ═══════════════════════════════════════════════════════════════════════
// Each: init() -> its inputs (from now and here), fields(c) -> the input
// rows, and solve(c) -> { big, sub, working } (HTML). The answer stands at
// the top and stays in view while the inputs below it change.
// hint: a line under the label saying what the field is, for the ones a
// newcomer would not know (index error, height of eye, the limb).
function _tbField(label, ctl, cls, hint) {
  return '<div class="tk-row' + (cls ? ' ' + cls : '') + '"><span class="tk-label">' + _almEsc(label) +
    (hint ? '<span class="tk-hint">' + _almEsc(hint) + '</span>' : '') + '</span><span class="tk-ctl">' + ctl + '</span></div>';
}
function _tbHint(k) { return _tbT('hint_' + k); }
function _tbGroup(title, rows) {
  return '<section class="tk-group">' + (title ? '<h3 class="tk-group-h">' + _almEsc(title) + '</h3>' : '') + '<div class="tk-rows">' + rows + '</div></section>';
}
// The working: rows of a step and its value, the totals ruled.
function _tbWorking(rows, title) {
  return '<section class="tb-working"><h3 class="tb-h3">' + _almEsc(title || t('ref_corrections')) + '</h3><div class="tb-frame tb-frame-flat"><table class="tb-table tb-steps"><tbody>' +
    rows.map(function (r) {
      return '<tr' + (r[2] ? ' class="tb-total"' : '') + '><th scope="row">' + _almEsc(r[0]) + '</th><td><span dir="ltr">' + _almEsc(r[1]) + '</span></td></tr>';
    }).join('') + '</tbody></table></div></section>';
}
// A spec over one property of the calculation's state.
function _tbProp(c, k) { return { get: function () { return c[k]; }, set: function (v) { c[k] = v; } }; }
function _tbNumOn(c, k, o) { return _tkNumSpec(Object.assign(_tbProp(c, k), o)); }
function _tbPlaceOn(c, k, label) { return { label: label, get: function () { return c[k]; }, set: function (p) { c[k] = p; } }; }
function _tbDateOn(c, k, label, tz, time) { return { label: label, tz: tz, time: time, get: function () { return c[k]; }, set: function (v) { c[k] = v; } }; }
// Noon of the Almanac's focus day, in a zone: a date's default.
function _tbFocusNoon(tz) { var p = _tkParts(_almFocusInstant().getTime(), tz); p.h = 12; p.mi = 0; return _tkFromParts(p, tz); }
// A city of the Almanac's list by the start of its name, as a place.
function _tbCity(name) {
  var c = _almFindCities(name, 1)[0];
  return c ? _tbMakePlace(c.lat, c.lon, c.name, true) : null;
}
// The second place a two-place calculation opens with: far enough away to be
// worth asking about.
function _tbOtherPlace(here) {
  var far = ['London', 'New York', 'Tokyo'];
  for (var i = 0; i < far.length; i++) {
    var p = _tbCity(far[i]);
    if (p && _tbGreatCircle(here, p).km > 1000) return p;
  }
  return _tbCity('Sydney');
}

var TB_CALC = {};

// ── Sight reduction ──
TB_CALC.sight = {
  init: function () { return _arSightDefaults(_tb.place, _almFocusInstant().getTime()); },
  fields: function (c) {
    var bodies = [{ v: 'sun', label: t('ref_sun') }, { v: 'moon', label: t('ref_moon') }].concat(AR_PLANETS.map(function (p) {
      return { v: p, label: _tp(p.charAt(0).toUpperCase() + p.slice(1)), group: _tbT('planets') };
    })).concat(AR_NAV_STARS.slice().sort(function (a, b) { return a[1] < b[1] ? -1 : 1; }).map(function (st) {
      return { v: 'star:' + st[1], label: st[1], sub: 'mag ' + _arMag(st[8]), group: t('ref_stars_h') };
    }));
    var limbed = c.body === 'sun' || c.body === 'moon';
    var eye = { get: function () { return c.unit === 'ft' ? c.heightM * AR_FT_PER_M : c.heightM; }, set: function (v) { c.heightM = c.unit === 'ft' ? v / AR_FT_PER_M : v; } };
    return _tbGroup(t('ref_the_sight'),
        _tbField(t('ref_body'), _tkPick('body', t('ref_body'), bodies, function () { return c.body; }, function (v) { c.body = v; _tbCalcFields(); }), '', _tbHint('body')) +
        (limbed ? _tbField(t('ref_limb'), _tkSeg('limb', t('ref_limb'), [{ v: 'lower', label: t('ref_limb_lower') }, { v: 'upper', label: t('ref_limb_upper') }], c.limb, function (v) { c.limb = v; _tkChanged(); }), '', _tbHint('limb')) : '') +
        _tbField(_tbT('when_ut'), _tkDate('ms', _tbDateOn(c, 'ms', _tbT('when_ut'), 'UTC', true)), '', _tbHint('when')) +
        _tbField(t('ref_hs'), _tkNum('hs', _tkAngleSpec(Object.assign(_tbProp(c, 'hs'), { label: t('ref_hs'), max: 90 }))), '', _tbHint('hs'))) +
      _tbGroup(t('ref_instrument'),
        _tbField(t('ref_index_error'), _tkNum('ie', _tbNumOn(c, 'ie', { label: t('ref_index_error'), step: 0.1, digits: 1, min: -30, max: 30, unit: '′', fmt: function (v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1); } })), '', _tbHint('ie')) +
        _tbField(t('ref_eye_height'), _tkNum('eye', _tkNumSpec(Object.assign(eye, { label: t('ref_eye_height'), step: c.unit === 'ft' ? 1 : 0.5, digits: 1, min: 0, max: 100, fmt: function (v) { return _arNum(v, 1); } }))) +
          _tkSeg('unit', t('ref_unit'), [{ v: 'm', label: 'm' }, { v: 'ft', label: 'ft' }], c.unit, function (v) { c.unit = v; _tbCalcFields(); }), '', _tbHint('eye')) +
        _tbField(t('ref_temperature'), _tkNum('temp', _tbNumOn(c, 'tempC', { label: t('ref_temperature'), step: 1, digits: 0, min: -60, max: 60, unit: '°C' })), '', _tbHint('temp')) +
        _tbField(t('ref_pressure'), _tkNum('hpa', _tbNumOn(c, 'hPa', { label: t('ref_pressure'), step: 1, digits: 0, min: 870, max: 1090, unit: 'hPa' })), '', _tbHint('pressure'))) +
      _tbGroup(t('ref_assumed_position'),
        _tbField(t('ref_latitude'), _tkNum('lat', _tkAngleSpec(Object.assign(_tbProp(c, 'lat'), { label: t('ref_latitude'), max: 89.99, hemi: ['N', 'S'] }))), '', _tbHint('lat')) +
        _tbField(t('ref_longitude'), _tkNum('lon', _tkAngleSpec(Object.assign(_tbProp(c, 'lon'), { label: t('ref_longitude'), max: 180, hemi: ['E', 'W'] }))), '', _tbHint('lon')));
  },
  solve: function (c) {
    var r = _arReduceSight(c);
    if (!r) return { big: '–', sub: '', working: '' };
    var st = r.steps, limbed = c.body === 'sun' || c.body === 'moon';
    var lopA = Math.round(_arNorm360(r.zn + 90)), lopB = Math.round(_arNorm360(r.zn - 90));
    var lo = String(Math.min(lopA, lopB)).padStart(3, '0'), hi = String(Math.max(lopA, lopB)).padStart(3, '0');
    var warn = '';
    if (st.ha < AR_EXAMPLE_MIN_ALT / 2) warn += _tbNote('<span class="tb-warn">' + _arTH('low_altitude') + '</span>');
    if (r.hc < 0) warn += _tbNote('<span class="tb-warn">' + _arTH('below_horizon') + '</span>');
    var bearing = Math.abs(_arDeltaDeg(r.zn, 180)) < 90 ? 'S' : 'N';
    var noonMs = _arUtDay(c.ms) + (12 - c.lon * AR_HOURS_PER_DEG) * AR_MS_PER_HOUR;
    noonMs -= _arEquationOfTime(noonMs).eot * 60000;
    var onMeridian = Math.abs(_arDeltaDeg(r.lha, 0)) < AR_NOON_LHA_DEG, noonTime = new Date(noonMs).toISOString().slice(11, 19);
    return {
      big: _tbT('sight_big', { n: _arNum(Math.abs(r.intercept), 1), dir: _arT(r.intercept >= 0 ? 'toward' : 'away'), zn: String(Math.round(r.zn) % 360).padStart(3, '0') }),
      sub: _arT('lop_answer', { a: lo, b: hi, pos: _arLatText(r.foot.lat) + ' ' + _arLonText(r.foot.lon) }),
      intercept: r.intercept, zn: r.zn,
      working: warn + '<div class="tb-plot">' + _arPlotSvg(c, r) + '</div>' +
        _tbWorking([[t('ref_hs'), _arDegMin(st.hs)], [t('ref_index_corr'), _arArcmin(st.ie * 60)], [t('ref_dip'), _arArcmin(st.dip * 60)],
          [t('ref_ha'), _arDegMin(st.ha), 1], [t('ref_refraction'), _arArcmin(st.refr * 60)]]
          .concat(limbed ? [[t('ref_semi_diameter'), _arArcmin(st.sd * 60)]] : [])
          .concat([[t('ref_parallax'), _arArcmin(st.pa * 60)], [t('ref_ho'), _arDegMin(r.ho), 1],
            ['GHA', _arNavGha(r.body.gha).trim()], ['Dec', _arNavDec(r.body.dec)], ['LHA', _arNavGha(r.lha).trim()],
            ['Hc', _arDegMin(r.hc)], ['Zn', Math.round(r.zn) + '°'],
            [t('ref_intercept'), _arNum(Math.abs(r.intercept), 1) + ' ' + t('ref_nm') + ' ' + _arT(r.intercept >= 0 ? 'toward' : 'away'), 1]])) +
        '<h3 class="tb-h3">' + _arTH('noon_sight') + '</h3>' + _tbNote(onMeridian
          ? _arTH('noon_sight_text', { lat: _arLatText(_arNoonLatitude(r.ho, r.body.dec, bearing)), bearing: bearing, time: noonTime })
          : _arTH('noon_sight_when', { time: noonTime })) +
        _tbNote(_arTH('sight_how'))
    };
  }
};

// ── Sundial ──
TB_CALC.sundial = {
  init: function () { return { place: _tb.place, ms: _tbFocusNoon(_tb.place.tz) }; },
  fields: function (c) {
    return _tbGroup('', _tbField(_tbT('date'), _tkDate('ms', _tbDateOn(c, 'ms', _tbT('date'), c.place.tz, false))) +
      _tbField(_tbT('place'), _tkPlace('place', { label: _tbT('place'), get: function () { return c.place; }, set: function (p) { c.place = p; _tbCalcFields(); } })));
  },
  solve: function (c) { return _tbSundialSolve(c.place, _tbDayIn(c.ms, c.place.tz)); }
};
// Sundial time to clock time on one day at one place: the equation of time,
// the place's distance from its zone's meridian, and the zone's offset that
// day (daylight saving included). Their sum is the day's correction.
function _tbSundial(p, k) {
  var r = _arSunTimeSpan(k, k, p.lon, p.tz)[0];
  var offMin = _tzUtcOffsetMin(p.tz, new Date(r.noon));
  var lonCorr = (offMin / 60 * 15 - p.lon) * AR_MIN_PER_DEG;   // the zone's meridian less the place's, in clock minutes
  return { row: r, offMin: offMin, lonCorr: lonCorr, eot: r.eot, correction: r.correction };
}
// Minutes as words a clock reads: +59 m 24 s, +1 h 6 m 42 s.
function _tbMinWords(min) {
  var t0 = Math.round(Math.abs(min) * 60), h = Math.floor(t0 / 3600), m = Math.floor(t0 / 60) % 60, sec = t0 % 60;
  return (min < 0 ? '−' : '+') + (h ? h + ' ' + t('alm_h_abbr') + ' ' : '') + m + ' ' + t('alm_m_abbr') + ' ' + sec + ' s';
}
function _tbSundialSolve(p, k) {
  var s = _tbSundial(p, k);
  var off = s.offMin, sign = off < 0 ? '−' : '+', oh = Math.floor(Math.abs(off) / 60), om = Math.abs(off) % 60;
  var noonClock = new Date(s.row.noon);
  return {
    big: _tbT('sundial_big', { v: _tbMinWords(s.correction) }),
    sub: _tbT('sundial_clock', { time: _tzFmt(p.tz, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(noonClock) }),
    correction: s.correction,
    working: _tbWorking([
      [t('ref_eot'), _arMinSec(-s.eot)],
      [_tbT('lon_corr', { lon: _arLonText(p.lon), m: _arLonText(off / 60 * 15), z: 'UTC' + sign + oh + (om ? ':' + String(om).padStart(2, '0') : '') }), _arMinSec(s.lonCorr)],
      [t('ref_correction'), _arMinSec(s.correction), 1]
    ]) + _tbNote(_tbH('sundial_how'))
  };
}

// ── Calendar converter ──
TB_CALC.convert = {
  init: function () { var k = _tbDayIn(_almFocusInstant().getTime(), null); return { sys: 'gregorian', jdn: _tbJdn(k) }; },
  fields: function (c) {
    var cur = _arCalFromJDN(c.sys, c.jdn);
    function setPart(part) {
      return function (v) {
        var p = _arCalFromJDN(c.sys, c.jdn), y = p.year, m = p.month, d = p.day;
        if (part === 'y') y = v; else if (part === 'm') m = v; else d = v;
        var months = _arCalMonths(c.sys, y);
        m = Math.max(1, Math.min(m, months.length));
        d = Math.max(1, Math.min(d, months[m - 1].days));
        c.jdn = _arCalToJDN(c.sys, y, m, d);
      };
    }
    var months = _arCalMonths(c.sys, cur.year).map(function (mo, i) {
      return { v: String(i + 1), label: c.sys === 'gregorian' || c.sys === 'julian' ? _arMonthName(i + 1) : mo.name };
    });
    return _tbGroup('',
      _tbField(t('ref_calendar'), _tkPick('sys', t('ref_calendar'), AR_CAL_SYSTEMS.map(function (s) { return { v: s, label: _arCalLabel(s) }; }),
        function () { return c.sys; }, function (v) { c.sys = v; _tbCalcFields(); })) +
      _tbField(t('ref_day'), _tkStepper('d', _tkNumSpec({ label: t('ref_day'), get: function () { return _arCalFromJDN(c.sys, c.jdn).day; }, set: setPart('d'), min: 1, max: 30, step: 1 }))) +
      _tbField(t('ref_month'), _tkPick('m', t('ref_month'), months, function () { return String(_arCalFromJDN(c.sys, c.jdn).month); }, function (v) { setPart('m')(+v); _tbCalcFields(); })) +
      _tbField(t('ref_year_label'), _tkStepper('y', _tkNumSpec({ label: t('ref_year_label'), get: function () { return _arCalFromJDN(c.sys, c.jdn).year; },
        set: function (v) { setPart('y')(v); }, step: 1, fmt: function (v) { return String(v); } }))));
  },
  solve: function (c) {
    var k = _tbKey(c.jdn);
    var list = AR_CAL_SYSTEMS.filter(function (s) { return s !== c.sys; }).map(function (s) {
      var label = _almEsc(_arCalLabel(s)) + (s === 'islamic' ? ' <span class="tb-dim">(' + _arTH('tabular') + ')</span>' : '');
      return '<div class="tb-cal-line"><span class="tb-cal-sys">' + label + '</span><span class="tb-cal-date">' + _almEsc(_arCalDateText(s, _arCalFromJDN(s, c.jdn))) + '</span></div>';
    }).join('');
    return {
      big: _arCalDateText(c.sys, _arCalFromJDN(c.sys, c.jdn)),
      sub: _tbLongDay(k),
      extra: '<div class="tb-cal-list">' + list + '</div>',
      working: _tbWorking([[t('ref_jdn'), String(c.jdn)], [t('ref_weekday'), _tbDate(k, { weekday: 'long' })]]) + _tbNote(_arTH('cal_lede'))
    };
  }
};

// ── Days between two dates ──
TB_CALC.days = {
  init: function () {
    var k = _tbDayIn(_almFocusInstant().getTime(), null);
    return { a: _arDayMs(k) + 12 * TB_MS_HOUR, b: _arDayMs({ y: k.y + 1, m: 1, d: 1 }) + 12 * TB_MS_HOUR };
  },
  fields: function (c) {
    return _tbGroup('', _tbField(_tbT('from'), _tkDate('a', _tbDateOn(c, 'a', _tbT('from'), 'UTC', false))) +
      _tbField(_tbT('to'), _tkDate('b', _tbDateOn(c, 'b', _tbT('to'), 'UTC', false))));
  },
  solve: function (c) {
    var a = _tbDayIn(c.a, 'UTC'), b = _tbDayIn(c.b, 'UTC');
    var n = _tbJdn(b) - _tbJdn(a), lo = n < 0 ? b : a, hi = n < 0 ? a : b, ymd = _tbYmd(lo, hi), abs = Math.abs(n);
    var parts = [];
    if (ymd.y) parts.push(tPlural('alm_tm_dyear', ymd.y));
    if (ymd.m) parts.push(tPlural('alm_tm_dmonth', ymd.m));
    if (ymd.d || !parts.length) parts.push(tPlural('alm_tm_dday', ymd.d));
    function about(k) {
      var j = _tbJdn(k), w = _tbIsoWeek(j);
      return [
        [_tbLongDay(k), ''],
        [_tbT('day_of_year'), _tbT('n_of_m', { n: _tbDayOfYear(k), m: _tbYearLength(k.y) })],
        [_tbT('iso_week'), _tbT('week_n', { n: w.week, y: w.year })],
        [t('ref_jdn'), String(j)]
      ];
    }
    return {
      big: tPlural('alm_tm_dday', abs, { n: _arNum(abs, 0) }),
      sub: parts.join(' ') + (abs >= 7 ? ' · ' + _tbT('weeks_days', { w: Math.floor(abs / 7), d: abs % 7 }) : '') + (n < 0 ? ' · ' + _tbT('earlier_than') : ''),
      days: n,
      working: _tbWorking(about(a), _tbT('from')) + _tbWorking(about(b), _tbT('to')) +
        _tbNote(_tbH('days_note', { a: _tbJdn(b), b: _tbJdn(a), n: n }))
    };
  }
};

// ── Time zones ──
TB_CALC.zones = {
  init: function () { var here = _tb.place; return { a: here, b: _tbOtherPlace(here), ms: Math.round(_almFocusInstant().getTime() / TB_MS_MIN) * TB_MS_MIN }; },
  fields: function (c) {
    return _tbGroup('',
      _tbField(_tbT('here'), _tkPlace('a', { label: _tbT('here'), get: function () { return c.a; }, set: function (p) { c.a = p; _tbCalcFields(); } })) +
      _tbField(_tbT('time_here'), _tkDate('ms', _tbDateOn(c, 'ms', _tbT('time_here'), c.a.tz, true))) +
      _tbField(_tbT('there'), _tkPlace('b', { label: _tbT('there'), get: function () { return c.b; }, set: function (p) { c.b = p; } })));
  },
  solve: function (c) {
    var at = new Date(c.ms);
    var oa = _tzUtcOffsetMin(c.a.tz, at), ob = _tzUtcOffsetMin(c.b.tz, at), diff = ob - oa;
    function off(m) { var s = m < 0 ? '−' : '+', a = Math.abs(m); return 'UTC' + s + Math.floor(a / 60) + (a % 60 ? ':' + String(a % 60).padStart(2, '0') : ''); }
    function hm(m) { var a = Math.abs(m); return Math.floor(a / 60) + (a % 60 ? ':' + String(a % 60).padStart(2, '0') : '') + ' h'; }
    var fT = _tzFmt(c.b.tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), fD = _tzFmt(c.b.tz, { weekday: 'long', month: 'long', day: 'numeric' });
    var abbr = function (p) { return _formatTimezone(null, p.tz, at); };
    return {
      big: fT.format(at),
      sub: _tbT('zones_there', { date: fD.format(at), place: _tbShortName(c.b) }) + ' · ' + (diff === 0 ? _tbT('same_time') : _tbT(diff > 0 ? 'ahead' : 'behind', { h: hm(diff) })),
      diff: diff,
      working: _tbWorking([
        [_tbShortName(c.a) + ' · ' + c.a.tz, off(oa) + ' ' + abbr(c.a)],
        [_tbShortName(c.b) + ' · ' + c.b.tz, off(ob) + ' ' + abbr(c.b)],
        [_tbT('difference'), (diff < 0 ? '−' : '+') + hm(diff), 1]
      ]) + _tbNote(_tbH('zones_note'))
    };
  }
};

// ── Distance and bearing: the great circle ──
var TB_EARTH_R_KM = 6371.0088;   // the mean radius (IUGG)
var TB_KM_PER = { km: 1, mi: 1.609344, nm: 1.852 };
function _tbGreatCircle(a, b) {
  var r = Math.PI / 180, p1 = a.lat * r, p2 = b.lat * r, dp = p2 - p1, dl = (b.lon - a.lon) * r;
  var h = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  var ang = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  function brg(x1, y1, x2, dl2) { return _arNorm360(Math.atan2(Math.sin(dl2) * Math.cos(x2), Math.cos(x1) * Math.sin(x2) - Math.sin(x1) * Math.cos(x2) * Math.cos(dl2)) / r); }
  var Bx = Math.cos(p2) * Math.cos(dl), By = Math.cos(p2) * Math.sin(dl);
  var mlat = Math.atan2(Math.sin(p1) + Math.sin(p2), Math.sqrt((Math.cos(p1) + Bx) * (Math.cos(p1) + Bx) + By * By)) / r;
  var mlon = a.lon + Math.atan2(By, Math.cos(p1) + Bx) / r;
  return { km: ang * TB_EARTH_R_KM, angle: ang / r, h: h, dlat: dp / r, dlon: dl / r,
    initial: brg(p1, 0, p2, dl), final: _arNorm360(brg(p2, 0, p1, -dl) + 180),
    mid: { lat: mlat, lon: ((mlon + 540) % 360) - 180 } };
}
TB_CALC.distance = {
  init: function () { var here = _tb.place; return { a: here, b: _tbOtherPlace(here), unit: _atUnitsGuess() === 'ft' ? 'mi' : 'km' }; },
  fields: function (c) {
    return _tbGroup('',
      _tbField(_tbT('from'), _tkPlace('a', _tbPlaceOn(c, 'a', _tbT('from')))) +
      _tbField(_tbT('to'), _tkPlace('b', _tbPlaceOn(c, 'b', _tbT('to')))) +
      _tbField(_tbT('unit'), _tkSeg('unit', _tbT('unit'), [{ v: 'km', label: 'km' }, { v: 'mi', label: 'mi' }, { v: 'nm', label: _tbT('nmi') }], c.unit, function (v) { c.unit = v; _tkChanged(); })));
  },
  solve: function (c) {
    var g = _tbGreatCircle(c.a, c.b), f = TB_KM_PER[c.unit], u = c.unit === 'nm' ? _tbT('nmi') : c.unit;
    var d = g.km / f;
    return {
      big: _arNum(d, d < 100 ? 1 : 0) + ' ' + u,
      sub: _tbT('bearing_sub', { a: Math.round(g.initial), b: Math.round(g.final) }),
      km: g.km,
      working: _tbWorking([
        [_tbT('gc_dlat'), _arNum(g.dlat, 4) + '°'], [_tbT('gc_dlon'), _arNum(g.dlon, 4) + '°'],
        ['a = sin²(Δφ/2) + cos φ₁ cos φ₂ sin²(Δλ/2)', _arNum(g.h, 6)],
        [_tbT('gc_angle'), _arNum(g.angle, 4) + '°'],
        [_tbT('gc_times', { r: _arNum(TB_EARTH_R_KM, 1) }), _arNum(g.km, 1) + ' km', 1],
        [_tbT('gc_initial'), Math.round(g.initial) + '°'], [_tbT('gc_final'), Math.round(g.final) + '°'],
        [_tbT('gc_mid'), _arLatText(g.mid.lat) + ' ' + _arLonText(g.mid.lon)]
      ]) + _tbNote(_tbH('gc_note'))
    };
  }
};
function _atUnitsGuess() { return typeof _atUnits === 'function' ? _atUnits() : (/-(US|LR|MM)$/i.test(navigator.language || '') ? 'ft' : 'm'); }

// ── Units: exact factors to one base unit per kind ──
// Each by definition (the yard and pound of 1959, the US gallon of 231 in³,
// the imperial gallon of 4.54609 L, the standard atmosphere, the knot of
// 1852 m an hour); psi and the column of mercury from standard gravity.
var TB_UNITS = {
  length: [['mm', 0.001], ['cm', 0.01], ['m', 1], ['km', 1000], ['in', 0.0254], ['ft', 0.3048], ['yd', 0.9144], ['mi', 1609.344], ['nmi', 1852]],
  mass: [['g', 0.001], ['kg', 1], ['t', 1000], ['oz', 0.028349523125], ['lb', 0.45359237], ['st', 6.35029318]],
  volume: [['ml', 0.001], ['l', 1], ['m3', 1000], ['tsp', 0.00492892159375], ['tbsp', 0.01478676478125], ['floz', 0.0295735295625],
    ['cup', 0.2365882365], ['pt', 0.473176473], ['qt', 0.946352946], ['gal', 3.785411784], ['impgal', 4.54609]],
  temperature: [['c'], ['f'], ['k']],
  speed: [['mps', 1], ['kmh', 1 / 3.6], ['mph', 0.44704], ['kn', 1852 / 3600], ['fps', 0.3048]],
  pressure: [['pa', 1], ['hpa', 100], ['kpa', 1000], ['bar', 100000], ['atm', 101325], ['psi', 6894.757293168361], ['mmhg', 133.322387415], ['inhg', 3386.388640341]]
};
var TB_UNIT_SYM = { ml: 'mL', l: 'L', m3: 'm³', floz: 'fl oz', impgal: 'imp gal', c: '°C', f: '°F', k: 'K', mps: 'm/s', kmh: 'km/h', kn: 'kn', fps: 'ft/s',
  pa: 'Pa', hpa: 'hPa', kpa: 'kPa', mmhg: 'mmHg', inhg: 'inHg', nmi: 'nmi' };
function _tbUnitSym(u) { return TB_UNIT_SYM[u] || u; }
function _tbUnitFactor(kind, u) { var l = TB_UNITS[kind]; for (var i = 0; i < l.length; i++) if (l[i][0] === u) return l[i][1]; return NaN; }
// v in unit a to unit b, both of one kind. Temperature by way of kelvin.
var TB_ZERO_C_K = 273.15, TB_F_ZERO_C = 32, TB_C_PER_F = 5 / 9;
function _tbConvert(kind, v, a, b) {
  if (kind === 'temperature') {
    var k = a === 'c' ? v + TB_ZERO_C_K : a === 'f' ? (v - TB_F_ZERO_C) * TB_C_PER_F + TB_ZERO_C_K : v;
    return b === 'c' ? k - TB_ZERO_C_K : b === 'f' ? (k - TB_ZERO_C_K) / TB_C_PER_F + TB_F_ZERO_C : k;
  }
  return v * _tbUnitFactor(kind, a) / _tbUnitFactor(kind, b);
}
var TB_TEMP_RULES = { 'c>f': '°F = °C × 9/5 + 32', 'f>c': '°C = (°F − 32) × 5/9', 'c>k': 'K = °C + 273.15', 'k>c': '°C = K − 273.15',
  'f>k': 'K = (°F − 32) × 5/9 + 273.15', 'k>f': '°F = (K − 273.15) × 9/5 + 32' };
// A measure as people read one: two places past the point (four significant
// figures below one); exact, a factor shown to every place it has.
function _tbSig(v, exact) {
  if (!isFinite(v)) return '–';
  if (v === 0) return '0';
  var a = Math.abs(v);
  var o = exact ? { maximumSignificantDigits: 10 } : a >= 1 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 4 };
  return new Intl.NumberFormat(_arLang(), o).format(v);
}
TB_CALC.units = {
  init: function () { var us = _atUnitsGuess() === 'ft'; return { kind: 'length', v: 1, from: us ? 'mi' : 'km', to: us ? 'km' : 'mi' }; },
  fields: function (c) {
    var items = TB_UNITS[c.kind].map(function (u) { return { v: u[0], label: _tbUnitSym(u[0]), sub: _tbT('u_' + u[0]) }; });
    return _tbGroup('',
      _tbField(_tbT('kind'), _tkPick('kind', _tbT('kind'), Object.keys(TB_UNITS).map(function (k) { return { v: k, label: _tbT('k_' + k) }; }), function () { return c.kind; }, function (v) {
        c.kind = v; var l = TB_UNITS[v]; c.from = l[0][0]; c.to = l[1][0]; c.v = v === 'temperature' ? 100 : 1;
        if (v === 'temperature') { c.from = 'f'; c.to = 'c'; }
        _tbCalcFields();
      })) +
      _tbField(_tbT('value'), _tkNum('v', _tbNumOn(c, 'v', { label: _tbT('value'), step: c.kind === 'temperature' ? 1 : (c.v >= 10 ? 1 : 0.1), digits: 6,
        fmt: function (v) { return _tbSig(v, true); }, editText: function (v) { return String(+v.toPrecision(10)); } }))) +
      _tbField(_tbT('from'), _tkPick('from', _tbT('from'), items, function () { return c.from; }, function (v) { c.from = v; })) +
      _tbField(_tbT('to'), _tkPick('to', _tbT('to'), items, function () { return c.to; }, function (v) { c.to = v; }) +
        '<button type="button" class="tk-swap" data-tb-swap aria-label="' + _tbH('swap') + '" title="' + _tbH('swap') + '">⇅</button>'));
  },
  solve: function (c) {
    var r = _tbConvert(c.kind, c.v, c.from, c.to), from = _tbUnitSym(c.from), to = _tbUnitSym(c.to);
    var rule = c.kind === 'temperature'
      ? (TB_TEMP_RULES[c.from + '>' + c.to] || _tbT('same_unit'))
      : '1 ' + from + ' = ' + _tbSig(_tbUnitFactor(c.kind, c.from) / _tbUnitFactor(c.kind, c.to), true) + ' ' + to;
    var all = TB_UNITS[c.kind].map(function (u) { return [_tbUnitSym(u[0]) + ' · ' + _tbT('u_' + u[0]), _tbSig(_tbConvert(c.kind, c.v, c.from, u[0])), u[0] === c.to]; });
    return {
      big: _tbSig(r) + ' ' + to,
      sub: rule,
      value: r,
      working: _tbWorking(all, _tbT('in_every', { v: _tbSig(c.v) + ' ' + from })) + _tbNote(_tbH('units_note'))
    };
  }
};

// ── The Sun and Moon on one day, anywhere ──
TB_CALC.sunmoonday = {
  init: function () { return { place: _tb.place, ms: _tbFocusNoon(_tb.place.tz) }; },
  fields: function (c) {
    return _tbGroup('', _tbField(_tbT('date'), _tkDate('ms', _tbDateOn(c, 'ms', _tbT('date'), c.place.tz, false))) +
      _tbField(_tbT('place'), _tkPlace('place', { label: _tbT('place'), get: function () { return c.place; }, set: function (p) { c.place = p; _tbCalcFields(); } })));
  },
  solve: function (c) {
    var p = c.place, tz = p.tz, k = _tbDayIn(c.ms, tz);
    var r = _arSpan(k, k, p.lat, p.lon, tz).rows[0];
    var ph = _moonPhase(new Date(r.noon || c.ms));
    var tm = function (ms) { return _arTime(ms, tz); };
    var big = r.polar ? _arT(r.polar === 'up' ? 'up_all_day' : 'down_all_day')
      : _tbT('sun_big', { rise: tm(r.rise), set: tm(r.set) });
    return {
      big: big,
      glyph: _moonGlyphSVG(ph.phase, 28),
      sub: _localMoonName(ph.name) + ' · ' + _tbT('lit', { n: _arNum(ph.illumination, 0) }) + ' · ' + _tbT('moon_rise_set', { rise: tm(r.moonrise), set: tm(r.moonset) }),
      row: r,
      working: _tbWorking([
        [_tbT('astro_dawn'), tm(r.astronomicalDawn)], [_tbT('nautical_dawn'), tm(r.nauticalDawn)], [_tbT('civil_dawn'), tm(r.civilDawn)],
        [_tbT('sunrise'), tm(r.rise)], [_tbT('noon') + ' · ' + _tbT('noon_height'), tm(r.noon) + ' · ' + (r.noonAlt != null ? _arNum(r.noonAlt, 1) + '°' : '–')],
        [_tbT('sunset'), tm(r.set)], [_tbT('civil_dusk'), tm(r.civilDusk)], [_tbT('nautical_dusk'), tm(r.nauticalDusk)], [_tbT('astro_dusk'), tm(r.astronomicalDusk)],
        [_tbT('daylength'), r.polar === 'up' ? '24:00' : r.polar === 'down' ? '0:00' : _arDuration(r.length), 1],
        [_tbT('moonrise'), tm(r.moonrise)], [_tbT('moonset'), tm(r.moonset)],
        [t('ref_moon_age'), _arT('days_n', { n: _arNum(ph.phase * _CN_SYN, 1) })]
      ], _tbLongDay(k) + ' · ' + tz) + _tbNote(_arTH('year_notes'))
    };
  }
};

function _tbRenderCalc(body) {
  var id = _tb.id, calc = TB_CALC[id];
  var c = _tb.calc[id] || (_tb.calc[id] = calc.init());
  body.innerHTML = '<div id="tb-print-head"></div>' +
    '<div class="tk-answer" id="tk-answer" aria-live="polite"></div>' +
    '<div class="tk-fields" id="tk-fields"></div>' +
    '<div id="tk-working"></div><div id="tb-how"></div>';
  body.addEventListener('click', function (e) {
    if (!e.target.closest('[data-tb-swap]')) return;
    var u = _tb.calc[_tb.id], x = u.from;
    u.from = u.to; u.to = x;
    _tkChanged();
  });
  _tb.changed = _tbSolve;
  _tbCalcFields();
}
// The input rows, drawn again when an input changes which others there are.
function _tbCalcFields() {
  var host = _tbEl('tk-fields'), id = _tb.id;
  if (!host || !TB_CALC[id]) return;
  var focusKey = document.activeElement && document.activeElement.closest && document.activeElement.closest('[data-tk], [data-tk-pick], [data-tk-seg], [data-tk-date], [data-tk-place]');
  var fk = focusKey ? ['data-tk', 'data-tk-pick', 'data-tk-seg', 'data-tk-date', 'data-tk-place'].map(function (a) { return focusKey.getAttribute(a) ? '[' + a + '="' + focusKey.getAttribute(a) + '"]' : ''; }).join('') : null;
  _tkReset();
  host.innerHTML = TB_CALC[id].fields(_tb.calc[id]);
  _tkPaint(host);
  if (fk) { var back = host.querySelector(fk); if (back) back.focus({ preventScroll: true }); }
  _tbSolve();
}
function _tbSolve() {
  var id = _tb.id, calc = TB_CALC[id], c = _tb.calc[id];
  var ans = _tbEl('tk-answer'), wk = _tbEl('tk-working');
  if (!ans || !calc) return;
  var r;
  try { r = calc.solve(c); } catch (e) { r = { big: '–', sub: _tbT('failed'), working: '' }; if (window.console) console.error(e); }
  ans.innerHTML = (r.glyph ? '<span class="tk-answer-glyph" aria-hidden="true">' + r.glyph + '</span>' : '') +
    '<div class="tk-answer-text"><div class="tk-big" dir="auto">' + _almEsc(r.big) + '</div><div class="tk-sub">' + _almEsc(r.sub) + '</div></div>';
  wk.innerHTML = (r.extra || '') + r.working;
  _tbMadeFill(_tbCalcInputs(c));
  var ph = _tbEl('tb-print-head');
  if (ph) ph.innerHTML = _tbPrintHead([]);
  _tb.last = r;
}

// Opening the view by name: a table, a calculation, or "what stops being true".
window.AlmanacRef = { open: _tbOpen, close: _tbClose };
