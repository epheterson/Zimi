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
      // Start again, then the Almanac's own Copy, Share and Print icons
      // ("what stops being true" only prints).
      '<span class="tb-bar-end">' +
        (kind === 'table' || kind === 'calc' ? _almIconBtn('data-tb-reset', _tbT('reset'), TB_RESET_SVG) : '') +
        (kind === 'decay' ? _almIconBtn('data-tb-act="print"', t('ref_print'), ALM_PRINT_SVG) : _almDocActionsHtml('tb-act')) +
      '</span>' +
    '</div>' +
    (list.length ? '<nav class="tb-tabs" aria-label="' + _tbH(kind === 'calc' ? 'calcs' : kind === 'const' ? 'consts' : 'tables') + '">' + list.map(function (k) {
      return '<button type="button" class="tb-tab" data-tb-go="' + k + '"' + (k === id ? ' aria-current="page"' : '') + '>' + _almEsc(_tbName(k)) + '</button>';
    }).join('') + '</nav>' : '') +
    '</div><div class="tb-body" id="tb-body"></div>';
  el.querySelector('[data-tb-close]').addEventListener('click', function () { _tbClose(); });
  var reset = el.querySelector('[data-tb-reset]');
  if (reset) reset.addEventListener('click', _tbReset);
  el.querySelectorAll('[data-tb-act]').forEach(function (b) {
    b.addEventListener('click', function () { _tbAct(b.getAttribute('data-tb-act')); });
  });
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
// The view's Copy, Share and Print ("reset print and copy/share the MD or
// text output", Eric): the book of this one tile, as it stands now. "What
// stops being true" only prints, as it is.
function _tbAct(action) {
  _tkPopClose(true);
  if (_tb.kind === 'decay') return _tbPrint();
  if (action === 'print') return _tbBookPrint([_tb.id]);
  _tbBookSend([_tb.id], null, action === 'share');
}
// The open table or calculation as Markdown, as Copy gives it.
function _tbMarkdown() { return _tb.id ? _tbBookMarkdown([_tb.id]) : ''; }
// A page drawn (in the book's hidden host) as Markdown, under its heading:
// what it shows in order (a calculation's answer and the values it was
// worked from first), headings, tables, notes. Read off the page itself, so
// every table and calculation has it with nothing of its own.
function _tbPageMd(body) {
  var md = [], txt = _tbMdText;
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
    host.querySelectorAll('summary, h3, h4, li, table, dl, p.tb-note, p.tb-empty, .tb-eq').forEach(function (n) {
      // An equation as its label and its LaTeX, which Markdown readers draw.
      if (n.classList.contains('tb-eq')) { md.push(txt(n.querySelector('.tb-eq-l')) + '\n\n$$\n' + n.getAttribute('data-tex') + '\n$$'); return; }
      if (n.tagName === 'SUMMARY') { md.push((n.parentNode.classList.contains('tb-eqs') ? '### ' : '## ') + txt(n)); return; }
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
  if (_tb.pdf) { _tbPdfClose(); return true; }
  if (_tb.expectPop) { _tb.expectPop = false; return true; }
  if (_tbEl('alm-ref') && !(e.state && e.state.almTables)) { _tbClose(true); return true; }
  return false;
}
// Escape, wherever focus is: the popover first, then the view; never the
// Almanac behind it (app.js closes that on an Escape that reaches it).
window.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && _tb.pdf) { e.stopPropagation(); e.preventDefault(); history.back(); return; }
  if (e.key !== 'Escape' || !_tbEl('alm-ref')) return;
  e.stopPropagation();
  e.preventDefault();
  if (_tk.pop) _tkPopClose(); else _tbClose();
}, true);
// Paper. Every table, calculation and constants table prints as a book
// (below): the whole book of the tiles the chips show, or the book of one
// tile from its own Print, or from the browser's Print while it is open.
// "What stops being true" prints as the view is. Print sets the page up
// itself before asking for the dialog: iOS does not always send
// beforeprint, and without it the whole app went to paper, which is the
// Almanac's fixed frame and a blank page.
var TB_PRINT_CLASS = 'alm-ref-print';
var TB_BOOK_CLASS = 'alm-book-print';
var TB_PRINT_UNDO_MS = 60000;   // afterprint can be late or missing on a phone
function _tbPrintOn() {
  if (_tbEl(TB_BOOK_ID) || !(_tbEl('alm-ref') && typeof _almanacOpen !== 'undefined' && _almanacOpen)) return;
  if (_tb.kind !== 'decay') { _tbBookOn([_tb.id]); return; }
  document.documentElement.classList.add(TB_PRINT_CLASS);
}
function _tbPrintOff() {
  document.documentElement.classList.remove(TB_PRINT_CLASS, TB_BOOK_CLASS);
  [TB_BOOK_ID, TB_BOOK_STYLE_ID].forEach(function (id) { var n = _tbEl(id); if (n) n.remove(); });
}
function _tbPrintNow() {
  clearTimeout(_tb.printUndo);
  _tb.printUndo = setTimeout(_tbPrintOff, TB_PRINT_UNDO_MS);
  try { window.print(); } catch (e) { _tbPrintOff(); }
}
function _tbPrint() {
  _tkPopClose(true);
  if (typeof window.print !== 'function') return;
  _tbPrintOn();
  _tbPrintNow();
}
window.addEventListener('beforeprint', _tbPrintOn);
window.addEventListener('afterprint', function () { clearTimeout(_tb.printUndo); _tbPrintOff(); });

// ═══ The book ═══
// Every tile the chips show ("For the selected filter or all I want a
// top-level copy or print for all tables calcs and constants shown that
// create a single doc nicely formatted", Eric, 2026-10-03; "Filtered for
// what's being shown", 2026-10-04), as one Markdown document or one
// printed one: a title page (the place, the days, what is shown, the
// contents), then each tile on its own page as it stands now (its window,
// its place, its inputs), How this is made open, the equations drawn.
// One tile's own Copy and Print give the same, its title block its heading.
var TB_BOOK_ID = 'alm-book';
var TB_BOOK_STYLE_ID = 'alm-book-pages';
// The words' face on paper: a book serif with lining, even-width figures.
var TB_BOOK_SERIF = "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, 'Noto Serif', Georgia, serif";
// A portrait page's text width (A4, 15 mm margins): a table wider than this
// gets a landscape page of its own.
var TB_BOOK_TEXT_MM = 180;
// Each tile drawn in turn, out of sight, and read off: its name, its
// one-line subtitle, its Markdown and, for paper, its page. The open view
// steps aside meanwhile (the pages are drawn under its ids) and comes back
// as it was; every tile is drawn from the state it has now.
function _tbBookPages(ids, paper) {
  var view = _tbEl('alm-ref'), parent = view && view.parentNode, next = view && view.nextSibling;
  var scroll = view ? view.scrollTop : 0, focus = view && view.contains(document.activeElement) ? document.activeElement : null;
  if (view) parent.removeChild(view);
  var keep = { id: _tb.id, kind: _tb.kind, changed: _tb.changed, place: _tb.place, win: _tb.win, calc: _tb.calc, specs: _tk.specs };
  _tb.place = keep.place || _tbAlmanacPlace();
  // A tile never opened is drawn from its starting values, and still starts
  // from them when it is opened later.
  _tb.win = Object.assign({}, keep.win); _tb.calc = Object.assign({}, keep.calc);
  var host = document.createElement('div');
  host.hidden = true;
  document.body.appendChild(host);
  _tb.sync = true;
  var pages = [];
  try {
    ids.forEach(function (id) {
      var kind = _tbKind(id);
      if (kind !== 'table' && kind !== 'calc' && kind !== 'const') return;
      _tb.id = id; _tb.kind = kind;
      _tkReset();
      host.innerHTML = '<div class="tb-body" id="tb-body"></div>';
      var body = host.firstChild;
      if (kind === 'table') _tbRenderTable(body);
      else if (kind === 'calc') _tbRenderCalc(body);
      else _tbRenderConst(body);
      // A constants table shares its name with a table ("Sun and Moon"):
      // in the book it says which it is.
      var page = { id: id, kind: kind, name: kind === 'const' ? _tbT('consts') + ' · ' + _tbName(id) : _tbName(id),
        sub: _tbMdText(body.querySelector('.tb-printhead .tb-sub')), at: _tbMdText(body.querySelector('.tb-printhead .tb-at')),
        md: _tbPageMd(body) };
      if (kind === 'table') page.span = _tbSpan(_tbWinState(id));
      if (paper) {
        var h1 = body.querySelector('.tb-printhead h1');
        if (h1) h1.textContent = page.name;
        body.querySelectorAll('.tb-controls, .tk-pop').forEach(function (n) { n.remove(); });
        body.querySelectorAll('details').forEach(function (d) { d.open = true; d.setAttribute('open', ''); });
        _tbEqPaint(body);
        // Its ids are the open view's; the book's copy keeps none.
        body.querySelectorAll('[id]').forEach(function (n) { n.removeAttribute('id'); });
        page.html = body.innerHTML;
      }
      pages.push(page);
    });
  } finally {
    _tb.sync = false;
    host.remove();
    _tb.id = keep.id; _tb.kind = keep.kind; _tb.changed = keep.changed; _tb.place = keep.place;
    _tb.win = keep.win; _tb.calc = keep.calc; _tk.specs = keep.specs;
    if (view) {
      parent.insertBefore(view, next && next.parentNode === parent ? next : null);
      view.scrollTop = scroll;
      if (focus && focus.isConnected) focus.focus({ preventScroll: true });
    }
  }
  return pages;
}
// The title page's lines: the tables' place, where it is, the days the
// tables cover (or the Almanac's day), what the chips show.
function _tbBookHead(pages, showing) {
  var p = _tb.place || _tbAlmanacPlace(), spans = pages.filter(function (pg) { return pg.span; }), when;
  if (spans.length) {
    var from = spans[0].span.from, to = spans[0].span.to;
    spans.forEach(function (pg) {
      if (_tbJdn(pg.span.from) < _tbJdn(from)) from = pg.span.from;
      if (_tbJdn(pg.span.to) > _tbJdn(to)) to = pg.span.to;
    });
    when = _tbRangeText(from, to);
  } else when = _tbLongDay(_tbDayIn(_almFocusInstant().getTime(), p.tz));
  return { title: t('alm_group_tables'), place: p.name, at: _tbPlaceLine(p), when: when,
    showing: showing ? _tbT('book_showing', { s: showing }) : '', made: _tbT('made', { date: _tbLongDay(_tbDayIn(Date.now(), null)) }) };
}
// As Markdown: a title block, then a section a tile, headings a level down.
// One tile: its own title block, then its page.
function _tbBookMarkdown(ids, showing) {
  var pages = _tbBookPages(ids, false), head = _tbBookHead(pages, showing);
  if (!pages.length) return '';
  if (!showing) {
    var pg = pages[0];
    return ['# ' + pg.name, [pg.sub, pg.at].filter(Boolean).join('  \n'), '*' + head.made + '*', pg.md].filter(Boolean).join('\n\n') + '\n';
  }
  var md = ['# ' + head.title, [head.place, head.at, head.when, head.showing].join('  \n'), '*' + head.made + '*',
    '**' + _tbT('book_contents') + '**\n\n' + pages.map(function (p) { return '- ' + p.name; }).join('\n')];
  pages.forEach(function (p) {
    md.push('## ' + p.name + (p.sub ? '\n\n' + p.sub : '') + (p.md ? '\n\n' + p.md.replace(/^(#+) /gm, '#$1 ') : ''));
  });
  return md.join('\n\n') + '\n';
}
// Share sends it where there is a share sheet; Copy, and Share without one,
// put it on the clipboard (app.js _copyText says "Copied").
function _tbBookSend(ids, showing, share) {
  var text = _tbBookMarkdown(ids, showing);
  if (!text) return;
  var copy = function () { if (typeof _copyText === 'function') _copyText(text); };
  if (share && navigator.share) {
    navigator.share({ title: showing ? t('alm_group_tables') : _tbName(ids[0]), text: text }).catch(function (e) { if (!e || e.name !== 'AbortError') copy(); });
  } else copy();
}
// The book on paper, in the Almanac's place (the print rules show it and
// nothing else): the title page and its contents, then the pages.
function _tbBookBuild(ids, showing) {
  var host = _tbEl('almanac-content');
  if (!host) return null;
  _tbPrintOff();
  var pages = _tbBookPages(ids, true);
  if (!pages.length) return null;
  var head = _tbBookHead(pages, showing), one = !showing, e = _almEsc;
  var book = document.createElement('div');
  book.id = TB_BOOK_ID;
  book.className = 'alm-book' + (one ? ' alm-book-one' : '');
  book.style.setProperty('--tb-book-serif', TB_BOOK_SERIF);
  var html = '';
  if (!one) {
    var toc = [['table', 'tables'], ['calc', 'calcs'], ['const', 'consts']].map(function (k) {
      var these = pages.filter(function (p) { return p.kind === k[0]; });
      return these.length ? '<h3>' + _tbH(k[1]) + '</h3><ol>' + these.map(function (p) {
        return '<li><span>' + e(k[0] === 'const' ? _tbName(p.id) : p.name) + '</span>' + (p.sub ? '<span class="tb-toc-sub">' + e(p.sub) + '</span>' : '') + '</li>';
      }).join('') + '</ol>' : '';
    }).join('');
    html = '<header class="tb-book-title"><p class="tb-book-kicker">' + e(t('almanac')) + '</p><h1>' + e(head.title) + '</h1>' +
      '<p class="tb-book-place">' + e(head.place) + '</p><p>' + e(head.at) + '</p><p>' + e(head.when) + '</p>' +
      '<p class="tb-book-showing">' + e(head.showing) + '</p>' +
      '<nav class="tb-book-toc"><h2>' + _tbH('book_contents') + '</h2>' + toc + '</nav>' +
      '<p class="tb-made">' + e(head.made) + '</p></header>';
  }
  html += pages.map(function (p) { return '<section class="tb-book-page tb-body" data-tb="' + p.id + '">' + p.html + '</section>'; }).join('');
  // No page boxes for a running foot: one at the foot of the paper instead.
  if (!('CSSMarginRule' in window)) html += '<footer class="tb-book-foot">' + e(one ? pages[0].name : head.title) + ' · ' + e(head.place) + '</footer>';
  book.innerHTML = html;
  if (one) {
    var ph = book.querySelector('.tb-printhead');
    if (ph) ph.insertAdjacentHTML('beforeend', '<p class="tb-made">' + e(head.made) + '</p>');
  }
  host.appendChild(book);
  _tbBookWide(book);
  _tbBookPageRules((one ? pages[0].name : head.title) + ' · ' + _tbShortName({ name: head.place }), one);
  return book;
}
// A page whose table is wider than portrait paper is set on its own,
// landscape page (the print rules' named page tb-wide).
function _tbBookWide(book) {
  book.classList.add('alm-book-measure');
  book.style.width = TB_BOOK_TEXT_MM + 'mm';
  book.querySelectorAll('.tb-book-page').forEach(function (s) {
    var w = s.clientWidth;
    var wide = [].some.call(s.querySelectorAll('.tb-out table, .tb-working table'), function (tb) { return tb.offsetWidth > w + 1; });
    s.classList.toggle('tb-book-wide', wide);
  });
  book.style.width = '';
  book.classList.remove('alm-book-measure');
}
// The paper's own rules, while the book is out: margins, the running foot
// (the book's name and place, the page and the count; none on a title
// page) and the landscape page for a wide table.
function _tbCssString(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') + '"'; }
function _tbBookPageRules(running, one) {
  var foot = 'font-family: ' + TB_BOOK_SERIF + '; font-size: 8pt; color: #333;';
  var st = document.createElement('style');
  st.id = TB_BOOK_STYLE_ID;
  st.textContent = '@media print {' +
    '@page { margin: 16mm 15mm 18mm; @bottom-left { content: ' + _tbCssString(running) + '; ' + foot + ' }' +
    ' @bottom-right { content: counter(page) " / " counter(pages); ' + foot + ' } }' +
    (one ? '' : '@page :first { @bottom-left { content: none; } @bottom-right { content: none; } }') +
    '@page tb-wide { size: landscape; } }';
  document.head.appendChild(st);
}
function _tbBookOn(ids, showing) {
  if (!_tbBookBuild(ids, showing)) return false;
  document.documentElement.classList.add(TB_PRINT_CLASS, TB_BOOK_CLASS);
  return true;
}
// Print: a real PDF, opened in Zimi's PDF reader (its Print prints the file
// itself). A phone's own print dialog took the page before the book was set
// ("I got one page then the webpage tiles view then the full 57 page PDF",
// Eric, 2026-10-04), so the server lays the book out in its headless
// Chromium and hands back a file. Where it has none, or it fails, the
// browser's dialog prints the book, asked for only once it is all there.
// One at a time: the Print icons spin meanwhile and a second tap waits.
var TB_PDF_URL = '/almanac/pdf';
var TB_PDF_TIMEOUT_MS = 120000;
var TB_PRINT_BTNS = '[data-tb-act="print"], [data-alm-book="print"]';
// Where a letter-size page is the paper to hand (the rest of the world: A4).
var TB_LETTER_REGIONS = ['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'GT', 'CR', 'PA', 'DO', 'PR', 'SV', 'NI', 'HN', 'BZ'];
function _tbPaper() {
  var lang = (navigator.languages && navigator.languages[0]) || navigator.language || '';
  var m = /[-_]([A-Za-z]{2})\b/.exec(lang);
  return m && TB_LETTER_REGIONS.indexOf(m[1].toUpperCase()) >= 0 ? 'Letter' : 'A4';
}
function _tbPrintBusy(on) {
  document.querySelectorAll(TB_PRINT_BTNS).forEach(function (b) {
    b.classList.toggle('alm-busy', on);
    if (on) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
  });
}
function _tbBookPrint(ids, showing) {
  _tkPopClose(true);
  if (_tb.printing) return Promise.resolve();
  _tb.printing = true;
  _tbPrintBusy(true);
  var done = function () { _tb.printing = false; _tbPrintBusy(false); };
  return _tbTemmlLoad().then(function () {
    if (_tb.pdfOff || typeof openReader !== 'function' || !window.fetch) return _tbPaperPrint(ids, showing);
    return _tbPdf(ids, showing).catch(function (err) {
      if (err !== 'unavailable' && typeof _showToast === 'function') _showToast(_tbT('pdf_failed'));
      return _tbPaperPrint(ids, showing);
    });
  }).then(done, done);
}
// The browser's dialog, once the book is out, its fonts loaded and two
// frames drawn (iOS took the page a frame early).
function _tbPaperPrint(ids, showing) {
  if (typeof window.print !== 'function' || !_tbBookOn(ids, showing)) return Promise.resolve();
  var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  return fonts.then(function () {
    return new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(resolve); }); });
  }).then(_tbPrintNow);
}
// The book as one document the server can lay out on its own: its rules
// (the reference sheet, Temml's, the page rules), the page size, the book.
function _tbBookDoc(book, name, paper) {
  var css = [];
  [].forEach.call(document.styleSheets, function (sh) {
    var href = sh.href || '', own = sh.ownerNode && sh.ownerNode.id === TB_BOOK_STYLE_ID;
    if (!own && !/almanac-reference\.css|temml\//i.test(href)) return;
    try { [].forEach.call(sh.cssRules, function (r) { css.push(r.cssText); }); } catch (e) {}
  });
  css.push('@page { size: ' + paper + '; } @page tb-wide { size: ' + paper + ' landscape; }');
  var root = document.documentElement;
  return '<!DOCTYPE html><html lang="' + _almEsc(root.lang || 'en') + '" dir="' + _almEsc(root.dir || 'ltr') + '" class="' + TB_PRINT_CLASS + ' ' + TB_BOOK_CLASS + '">' +
    '<head><meta charset="utf-8"><title>' + _almEsc(name) + '</title><style>' + css.join('\n').replace(/<\/style/gi, '<\\/style') + '</style></head>' +
    '<body><div id="almanac-view"><div id="almanac-content">' + book.outerHTML + '</div></div></body></html>';
}
// "Almanac tables - San Francisco - 2026-10-04", or the one tile's name.
function _tbPdfName(ids, showing) {
  var p = _tb.place || _tbAlmanacPlace(), d = new Date();
  var day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return [showing ? _tbT('pdf_name') : _tbName(ids[0]), _tbShortName(p), day].join(' - ');
}
function _tbPdf(ids, showing) {
  var book = _tbBookBuild(ids, showing);
  if (!book) return Promise.reject('empty');
  var name = _tbPdfName(ids, showing), paper = _tbPaper();
  var html = _tbBookDoc(book, name, paper);
  _tbPrintOff();
  var ctl = window.AbortController ? new AbortController() : null;
  var timer = ctl && setTimeout(function () { ctl.abort(); }, TB_PDF_TIMEOUT_MS);
  return fetch(TB_PDF_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify({ html: html, paper: paper, name: name }), signal: ctl ? ctl.signal : undefined
  }).then(function (r) {
    clearTimeout(timer);
    if (r.status === 501) { _tb.pdfOff = true; throw 'unavailable'; }
    if (!r.ok) throw 'failed';
    return r.json();
  }, function (e) { clearTimeout(timer); throw e; }).then(function (j) {
    if (!j || !j.url) throw 'failed';
    _tbPdfShow(j.url, name);
  });
}
// The PDF in the shell's reader, over the Almanac set aside (not closed):
// Back, from the reader's bar, the browser or Escape, returns to it where
// it was, the tables view still open.
function _tbPdfShow(url, name) {
  var view = _tbEl('almanac-view');
  if (view) view.style.display = 'none';
  _tb.pdf = true;
  history.pushState({ almPdf: true }, '', location.href);
  // The reader's bar names it as the shell's title does.
  if (typeof _setWindowTitle === 'function') _setWindowTitle(name);
  openReader(_pdfViewerUrl(url));
}
function _tbPdfClose() {
  if (!_tb.pdf) return;
  _tb.pdf = false;
  if (typeof closeReader === 'function') closeReader();
  var view = _tbEl('almanac-view'), mv = _tbEl('main-view');
  if (view) view.style.display = '';
  if (mv) mv.classList.add('hidden');
  if (typeof _setWindowTitle === 'function') _setWindowTitle('Almanac');
  if (typeof updateTopbar === 'function') updateTopbar();
  var b = document.querySelector(TB_PRINT_BTNS);
  if (b && b.focus) b.focus({ preventScroll: true });
}
// The shell's Back while the PDF is up (app.js goBack): one step back.
function _tbPdfBack() {
  if (!_tb.pdf) return false;
  history.back();
  return true;
}

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
  var was = host.querySelector('details'), open = was && was.open;
  var wasEq = host.querySelector('details.tb-eqs'), openEq = wasEq && wasEq.open;
  // A line, and for a constant the tile that holds it ("Physics").
  function group(key, lines) {
    return lines.length ? '<h4>' + _tbH(key) + '</h4><ul>' + lines.map(function (l) {
      if (typeof l === 'string') return '<li>' + _almEsc(l) + '</li>';
      return '<li>' + _almEsc(l.text) + ' · <button type="button" class="tb-how-k" data-tb-go="' + l.tile + '">' + _almEsc(_tbName(l.tile)) + '</button></li>';
    }).join('') + '</ul>' : '';
  }
  host.innerHTML = '<details class="tb-how"' + (open ? ' open' : '') + '><summary>' + _tbH('made_title') + '</summary>' +
    group('made_inputs', _tbMadeInputs(x)) + group('made_method', methods) + group('made_constants', consts) + _tbEqHtml(x, openEq) + '</details>';
  host.querySelectorAll('[data-tb-go]').forEach(function (b) { b.addEventListener('click', function () { _tbOpen(b.getAttribute('data-tb-go')); }); });
  var eq = host.querySelector('details.tb-eqs');
  if (eq) eq.addEventListener('toggle', function () { if (eq.open) _tbEqOpen(eq); });
}
// Which Constants tile holds each constant a method rests on.
var TB_MADE_CONST_TILE = { aberration: 'k_physics', light: 'k_physics', parallax: 'k_nav', moonk: 'k_sunmoon', synodic: 'k_sunmoon',
  sidereal: 'k_earth', year: 'k_time', tai: 'k_time' };

// ═══ Equations ═══
// Eric, 2026-10-03: "Every single equation from fundamentals so I could work
// it out on paper from the tables?" Under "How this is made", closed: the
// chain from the calendar date to each printed number, one equation a line,
// each with its label. Every equation is the code's own: its constants are
// read from the named constants the sums use, and the literals written here
// are checked against the source of the function named beside them
// (tests/test_almanac_tables.cjs), so the page and the sums cannot part.
// The LaTeX is drawn as MathML by Temml (static/temml, MIT), loaded only when
// the Equations are opened; Share writes the LaTeX itself, in $$...$$.
var TB_TEMML_JS = '/static/temml/temml.min.js?v=0.13.5';
var TB_TEMML_CSS = '/static/temml/Temml-Local.css?v=0.13.5';
var TB_EQ_VIEWS = {
  sunmoon: ['time', 'sun', 'gmst', 'altaz', 'rise', 'moon', 'moonrise', 'phases', 'illum'],
  twilight: ['time', 'sun', 'gmst', 'altaz', 'twilight'],
  phases: ['time', 'sun', 'moon', 'phases', 'illum'],
  tides: ['tides'],
  nav: ['time', 'sun', 'gast', 'moon', 'navmoon', 'planets', 'stars', 'eot'],
  stars: ['time', 'sun', 'gmst', 'stars', 'heliacal'],
  seasons: ['time', 'seasons'],
  eclipses: ['time', 'sun', 'gast', 'moon', 'eclipses'],
  calendars: ['jdn', 'calendars', 'computus'],
  suntime: ['time', 'sun', 'gast', 'eot', 'sundial'],
  distance: ['distance'],
  sundial: ['time', 'sun', 'gast', 'eot', 'sundial'],
  sunmoonday: ['time', 'sun', 'gmst', 'altaz', 'rise', 'twilight', 'moon', 'moonrise', 'illum'],
  units: ['units'],
  sight: ['time', 'sun', 'gast', 'moon', 'navmoon', 'planets', 'stars', 'sight'],
  days: ['jdn', 'days'],
  convert: ['jdn', 'calendars'],
  zones: ['zones']
};
// A number as TeX writes it.
function _tbTx(v) {
  var s = String(v), m = /^(-?[\d.]+)e([+-]\d+)$/.exec(s);
  return m ? m[1] + '\\times10^{' + (+m[2]) + '}' : s;
}
// The same number in a table's cell (HTML and Markdown alike): 9.03×10⁻⁸.
var TB_SUPERSCRIPT = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
function _tbCellNum(v) {
  var s = String(v), m = /^(-?[\d.]+)e([+-]\d+)$/.exec(s);
  return m ? m[1] + '×10' + String(+m[2]).replace(/./g, function (c) { return TB_SUPERSCRIPT[c]; }) : s;
}
// Words inside an equation (\text{...}): the reader's language, TeX's
// special characters left out.
function _tbTxText(k, vars) { return String(_tbT(k, vars)).replace(/[\\{}_^#$%&~]/g, ' '); }
// Whole arcminutes of an angle in degrees, as TeX (never the reader's digits: TeX reads ASCII).
function _tbTxArcmin(deg) { return Math.round(deg * TB_ARCMIN_PER_DEG) + TB_TX_MIN; }
var TB_TX_DEG = '^{\\circ}', TB_TX_MIN = '^{\\prime}', TB_TX_SEC = '^{\\prime\\prime}';
var TB_TX_MOON = '\\text{☾}';
// One equation: its label (an i18n key under tb_eq_), its TeX, and the
// functions whose source holds its literals.
function _tbEq(label, tex, fns) { return { l: label, tex: tex, fns: fns || [] }; }
function _tbEqNote(key, vars) { return { note: _tbT('eq_' + key, vars) }; }
function _tbEqTable(head, rows) { return { table: '<div class="tb-frame tb-eq-frame"><table class="tb-table tb-eq-terms" dir="ltr"><thead>' + _tbHead(head) + '</thead><tbody>' + rows.map(function (r) { return _tbRow(r); }).join('') + '</tbody></table></div>' }; }
function _tbEqYear(x) { return new Date(x.mid || x.date || Date.now()).getUTCFullYear(); }
// ΔT (TT − UT) as almanac.js _cnDeltaTdays has it for year y: the piece in force.
function _tbEqDeltaTTex(y) {
  if (y >= 2005 && y <= 2050) return '62.92+0.32217\\,t+0.005589\\,t^{2},\\quad t=y-2000';
  if (y >= 1986 && y < 2005) return '63.86+0.3345\\,t-0.060374\\,t^{2}+0.0017275\\,t^{3}+0.000651814\\,t^{4}+0.00002373599\\,t^{5},\\quad t=y-2000';
  if (y > 2050 && y <= 2150) return '-20+32\\,u^{2}-0.5628\\,(2150-y),\\quad u=\\frac{y-1820}{100}';
  if (y >= 1961 && y < 1986) return '45.45+1.067\\,t-\\frac{t^{2}}{260}-\\frac{t^{3}}{718},\\quad t=y-1975';
  if (y >= 1941 && y < 1961) return '29.07+0.407\\,t-\\frac{t^{2}}{233}+\\frac{t^{3}}{2547},\\quad t=y-1950';
  if (y >= 1920 && y < 1941) return '21.20+0.84493\\,t-0.076100\\,t^{2}+0.0020936\\,t^{3},\\quad t=y-1920';
  if (y >= 1900 && y < 1920) return '-2.79+1.494119\\,t-0.0598939\\,t^{2}+0.0061966\\,t^{3}-0.000197\\,t^{4},\\quad t=y-1900';
  return '-20+32\\,u^{2},\\quad u=\\frac{y-1820}{100}';
}
// Rows of a VSOP87 series: its name and power, A, B, C.
function _tbEqVsopRows(name, series) {
  var out = [];
  series.forEach(function (row, p) { row.forEach(function (term) { out.push([name + '<sub>' + p + '</sub>', _tbCellNum(term[0]), _tbCellNum(term[1]), _tbCellNum(term[2])]); }); });
  return out;
}
function _tbEqTermCount(series) { return series.map(function (r) { return r.length; }).join('+'); }
// Each group: a function of what the view was worked from (x), returning
// equations, notes and tables in order.
var TB_EQ = {
  jdn: function () {
    return [
      _tbEq('jdn', 'a=\\left\\lfloor\\frac{14-M}{12}\\right\\rfloor,\\quad y=Y+4800-a,\\quad m=M+12a-3', ['_gregorianToJDN']),
      _tbEq('jdn', '\\mathrm{JDN}=D+\\left\\lfloor\\frac{153m+2}{5}\\right\\rfloor+365y+\\left\\lfloor\\frac{y}{4}\\right\\rfloor-\\left\\lfloor\\frac{y}{100}\\right\\rfloor+\\left\\lfloor\\frac{y}{400}\\right\\rfloor-32045', ['_gregorianToJDN']),
      _tbEq('weekday', '(\\mathrm{JDN}+1)\\bmod 7=0\\ \\text{(Sunday)}', ['_arSundayLetters'])
    ];
  },
  time: function (x) {
    return TB_EQ.jdn().slice(0, 2).concat([
      _tbEq('jd', '\\mathrm{JD}=\\mathrm{JDN}-0.5+\\frac{h_{\\mathrm{UT}}}{24}=' + _tbTx(JD_UNIX_EPOCH) + '+\\frac{t_{\\mathrm{ms}}}{' + MS_PER_DAY + '}', ['_dateToJD']),
      _tbEq('deltat', '\\Delta T=' + _tbEqDeltaTTex(_tbEqYear(x)).replace(',\\quad', '\\ \\mathrm{s},\\quad'), ['_cnDeltaTdays']),
      _tbEq('jde', '\\mathrm{JDE}=\\mathrm{JD}+\\frac{\\Delta T}{' + TB_S_PER_DAY + '}'),
      _tbEq('centuries', 'T=\\frac{\\mathrm{JDE}-' + _tbTx(JD_J2000) + '}{' + JULIAN_CENTURY + '},\\qquad \\tau=\\frac{\\mathrm{JDE}-' + _tbTx(JD_J2000) + '}{' + AE_DAYS_PER_JULIAN_MILLENNIUM + '}')
    ]);
  },
  sun: function () {
    return [
      _tbEq('vsop', 'L,\\,B,\\,R=\\sum_{i}\\tau^{i}\\sum_{k}A_{ik}\\cos\\left(B_{ik}+C_{ik}\\,\\tau\\right)', ['_aeVsopSum']),
      _tbEqNote('vsop_note', { l: _tbEqTermCount(AE_VSOP_L), b: _tbEqTermCount(AE_VSOP_B), r: _tbEqTermCount(AE_VSOP_R) }),
      _tbEqTable(['', 'A', 'B', 'C'], _tbEqVsopRows('L', AE_VSOP_L).concat(_tbEqVsopRows('B', AE_VSOP_B), _tbEqVsopRows('R', AE_VSOP_R))),
      _tbEq('geocentric', '\\odot=L+180' + TB_TX_DEG + ',\\qquad\\beta=-B', ['_aeSun']),
      _tbEq('fk5', "\\lambda'=\\odot-1.397" + TB_TX_DEG + 'T-0.00031' + TB_TX_DEG + 'T^{2},\\quad\\Delta\\odot=' + _tbTx(AE_FK5_DLON_ARCSEC) + TB_TX_SEC +
        ",\\quad\\Delta\\beta=" + _tbTx(AE_FK5_DLAT_ARCSEC) + TB_TX_SEC + "(\\cos\\lambda'-\\sin\\lambda')", ['_aeSun']),
      _tbEq('nut_args', '\\Omega=125.04452' + TB_TX_DEG + '-1934.136261' + TB_TX_DEG + 'T,\\quad L_{\\odot}=280.4665' + TB_TX_DEG + '+36000.7698' + TB_TX_DEG +
        'T,\\quad L_{' + TB_TX_MOON + '}=218.3165' + TB_TX_DEG + '+481267.8813' + TB_TX_DEG + 'T', ['_aeNutation']),
      _tbEq('nutation', '\\Delta\\psi=-17.20' + TB_TX_SEC + '\\sin\\Omega-1.32' + TB_TX_SEC + '\\sin2L_{\\odot}-0.23' + TB_TX_SEC + '\\sin2L_{' + TB_TX_MOON + '}+0.21' + TB_TX_SEC + '\\sin2\\Omega', ['_aeNutation']),
      _tbEq('nutation', '\\Delta\\varepsilon=9.20' + TB_TX_SEC + '\\cos\\Omega+0.57' + TB_TX_SEC + '\\cos2L_{\\odot}+0.10' + TB_TX_SEC + '\\cos2L_{' + TB_TX_MOON + '}-0.09' + TB_TX_SEC + '\\cos2\\Omega', ['_aeNutation']),
      _tbEq('obliquity', '\\varepsilon=23' + TB_TX_DEG + '26' + TB_TX_MIN + '21.448' + TB_TX_SEC + _tbTx(AE_OBLIQUITY_RATE_ARCSEC) + TB_TX_SEC + 'T-0.00059' + TB_TX_SEC + 'T^{2}+0.001813' + TB_TX_SEC + 'T^{3}+\\Delta\\varepsilon', ['_aeNutation']),
      _tbEq('sun_apparent', '\\lambda=\\odot+\\Delta\\odot+\\Delta\\psi-\\frac{' + _tbTx(AE_SUN_ABERRATION_ARCSEC) + TB_TX_SEC + '}{R}', ['_aeSun']),
      _tbEq('radec', '\\alpha=\\operatorname{atan2}\\left(\\sin\\lambda\\cos\\varepsilon-\\tan\\beta\\sin\\varepsilon,\\ \\cos\\lambda\\right)', ['_aeEclipticToEquatorial']),
      _tbEq('radec', '\\delta=\\arcsin\\left(\\sin\\beta\\cos\\varepsilon+\\cos\\beta\\sin\\varepsilon\\sin\\lambda\\right)', ['_aeEclipticToEquatorial'])
    ];
  },
  gmst: function () {
    return [_tbEq('gmst', '\\theta_{0}=280.46061837' + TB_TX_DEG + '+360.98564736629' + TB_TX_DEG + '\\,(\\mathrm{JD}-' + _tbTx(JD_J2000) + ')', ['_arGmstDeg'])];
  },
  gast: function () {
    return [
      _tbEq('gast', '\\theta=280.46061837' + TB_TX_DEG + '+360.98564736629' + TB_TX_DEG + '\\,(\\mathrm{JD}-' + _tbTx(JD_J2000) + ')+0.000387933' + TB_TX_DEG + 'T^{2}-\\frac{T^{3}}{38710000}+\\Delta\\psi\\cos\\varepsilon', ['_aeGast']),
      _tbEq('gha', '\\mathrm{GHA}=\\theta-\\alpha,\\qquad \\mathrm{GHA}_{\\Upsilon}=\\theta,\\qquad \\mathrm{SHA}=360' + TB_TX_DEG + '-\\alpha', ['_arNavAt'])
    ];
  },
  altaz: function () {
    return [
      _tbEq('interp', '\\alpha(t)=\\alpha_{k}+f\\,(\\alpha_{k+1}-\\alpha_{k}),\\quad f=\\frac{t-t_{k}}{' + AR_SAMPLE_HOURS + '\\,\\mathrm{h}}', ['_arAlt']),
      _tbEq('hour_angle', 'H=\\theta_{0}+\\lambda_{E}-\\alpha', ['_arAlt']),
      _tbEq('altitude', '\\sin h=\\sin\\varphi\\sin\\delta+\\cos\\varphi\\cos\\delta\\cos H', ['_arAlt']),
      _tbEq('crossing', 'h(t)=h_{0}:\\ \\text{' + _tbTxText('eq_bisect', { n: AR_BISECT_STEPS }) + '}')
    ];
  },
  rise: function () {
    return [
      _tbEq('rise', 'h_{0}=' + _tbTxArcmin(AR_SUNRISE_ALT)),
      _tbEq('noon', 'H=0:\\quad h_{\\max}=90' + TB_TX_DEG + '-|\\varphi-\\delta|', ['_arTransits']),
      _tbEq('daylength', 't_{\\mathrm{set}}-t_{\\mathrm{rise}}')
    ];
  },
  twilight: function () {
    return [_tbEq('twilight', 'h_{0}=' + [AR_TWILIGHT_ALTS.civil, AR_TWILIGHT_ALTS.nautical, AR_TWILIGHT_ALTS.astronomical].map(function (a) { return a + TB_TX_DEG; }).join(',\\ '))];
  },
  moon: function () {
    return [
      _tbEq('moon_args', "\\begin{aligned}L'&=218.3164477" + TB_TX_DEG + '+' + AE_MOON_MEAN_LON_RATE + TB_TX_DEG + 'T-0.0015786T^{2}+\\tfrac{T^{3}}{538841}-\\tfrac{T^{4}}{65194000}\\\\' +
        'D&=297.8501921' + TB_TX_DEG + '+' + AE_MOON_ELONG_RATE + TB_TX_DEG + 'T-0.0018819T^{2}+\\tfrac{T^{3}}{545868}-\\tfrac{T^{4}}{113065000}\\\\' +
        'M&=357.5291092' + TB_TX_DEG + '+' + AE_SUN_ANOMALY_RATE + TB_TX_DEG + 'T-0.0001536T^{2}+\\tfrac{T^{3}}{24490000}\\\\' +
        "M'&=134.9633964" + TB_TX_DEG + '+' + AE_MOON_ANOMALY_RATE + TB_TX_DEG + 'T+0.0087414T^{2}+\\tfrac{T^{3}}{69699}-\\tfrac{T^{4}}{14712000}\\\\' +
        'F&=93.2720950' + TB_TX_DEG + '+' + AE_MOON_ARGLAT_RATE + TB_TX_DEG + 'T-0.0036539T^{2}-\\tfrac{T^{3}}{3526000}+\\tfrac{T^{4}}{863310000}\\end{aligned}', ['_aeMoon']),
      _tbEq('moon_a', 'A_{1}=119.75' + TB_TX_DEG + '+131.849' + TB_TX_DEG + 'T,\\ A_{2}=53.09' + TB_TX_DEG + '+479264.290' + TB_TX_DEG + 'T,\\ A_{3}=313.45' + TB_TX_DEG + '+481266.484' + TB_TX_DEG + 'T', ['_aeMoon']),
      _tbEq('moon_e', 'E=1-0.002516T-0.0000074T^{2}', ['_aeMoon']),
      _tbEq('moon_sum', "\\Sigma l=\\sum c_{l}E^{|m|}\\sin(dD+mM+m'M'+fF)+3958\\sin A_{1}+1962\\sin(L'-F)+318\\sin A_{2}", ['_aeMoon']),
      _tbEq('moon_sum', "\\Sigma r=\\sum c_{r}E^{|m|}\\cos(dD+mM+m'M'+fF)", ['_aeMoon']),
      _tbEq('moon_sum', "\\Sigma b=\\sum c_{b}E^{|m|}\\sin(dD+mM+m'M'+fF)-2235\\sin L'+382\\sin A_{3}+175\\sin(A_{1}-F)+175\\sin(A_{1}+F)+127\\sin(L'-M')-115\\sin(L'+M')", ['_aeMoon']),
      _tbEqNote('moon_note', { a: AE_MOON_LR.length, b: AE_MOON_B.length }),
      _tbEq('moon_place', "\\lambda_{" + TB_TX_MOON + "}=L'+" + _tbTx(AE_MOON_COEF_SCALE) + '\\,\\Sigma l+\\Delta\\psi,\\quad\\beta_{' + TB_TX_MOON + '}=' + _tbTx(AE_MOON_COEF_SCALE) +
        '\\,\\Sigma b,\\quad\\Delta=' + _tbTx(AE_MOON_MEAN_DIST_KM) + '+' + _tbTx(AE_MOON_DIST_SCALE) + '\\,\\Sigma r\\ \\mathrm{km}', ['_aeMoon']),
      _tbEq('radec', '\\alpha_{' + TB_TX_MOON + '},\\ \\delta_{' + TB_TX_MOON + '}\\ \\text{' + _tbTxText('eq_as_sun') + '}')
    ];
  },
  moonrise: function () {
    return [
      _tbEq('hp', '\\pi=\\arcsin\\frac{' + _tbTx(AE_EARTH_RADIUS_KM) + '}{\\Delta}'),
      _tbEq('moonrise', 'h_{0}=' + _tbTx(AR_MOON_HP_FACTOR) + '\\,\\pi-' + _tbTxArcmin(AR_MOON_REFRACTION_DEG), ['_arAlt'])
    ];
  },
  phases: function () {
    return [_tbEq('phases', '\\lambda_{' + TB_TX_MOON + '}-\\lambda_{\\odot}=' + AR_PHASE_ANGLES.map(function (a) { return a + TB_TX_DEG; }).join(',\\ '), ['_arPhases'])];
  },
  // The lit fraction and the age, as app.js _moonPhase works them for the
  // day's noon: a shorter series, the Sun from its mean longitude and the
  // equation of centre, and T from the Julian Day of UT.
  illum: function () {
    return [
      _tbEq('sun_short', '\\lambda_{\\odot}=280.4664567' + TB_TX_DEG + '+36000.76982779' + TB_TX_DEG + 'T+(1.9146' + TB_TX_DEG + '-0.004817' + TB_TX_DEG + 'T)\\sin M+0.019993' + TB_TX_DEG + '\\sin2M', ['_moonPhase']),
      _tbEq('moon_short', "\\lambda_{" + TB_TX_MOON + "}=L'+\\sum_{k=1}^{" + _MOON_LON_TERMS.length + "}c_{k}E^{|m_k|}\\sin(d_kD+m_kM+m'_kM'+f_kF),\\quad E=1-0.002516T", ['_moonEcliptic']),
      _tbEq('moon_short', '\\beta_{' + TB_TX_MOON + "}=\\sum_{k=1}^{" + _MOON_LAT_TERMS.length + "}c_{k}E^{|m_k|}\\sin(d_kD+m_kM+m'_kM'+f_kF)", ['_moonEcliptic']),
      _tbEq('illum', '\\psi=\\arccos\\left(\\cos\\beta_{' + TB_TX_MOON + '}\\cos(\\lambda_{' + TB_TX_MOON + '}-\\lambda_{\\odot})\\right),\\quad i=\\operatorname{atan2}\\left(\\sin\\psi,\\ \\tfrac{385000.56}{149597870.7}-\\cos\\psi\\right)', ['_moonPhase']),
      _tbEq('illum', 'k=\\frac{1+\\cos i}{2}', ['_moonPhase']),
      _tbEq('age', '\\mathrm{age}=\\frac{(\\lambda_{' + TB_TX_MOON + '}-\\lambda_{\\odot})\\bmod 360' + TB_TX_DEG + '}{360' + TB_TX_DEG + '}\\times' + _tbTx(_CN_SYN) + '\\ \\mathrm{d}')
    ];
  },
  navmoon: function () {
    return [
      _tbEq('hp', '\\pi_{' + TB_TX_MOON + '}=\\arcsin\\frac{' + _tbTx(AE_EARTH_RADIUS_KM) + '}{\\Delta},\\qquad SD_{' + TB_TX_MOON + '}=\\arcsin(' + _tbTx(AR_MOON_K) + '\\sin\\pi_{' + TB_TX_MOON + '})', ['_arNavAt']),
      _tbEq('sd', 'SD_{\\odot}=\\frac{' + _tbTx(AR_SUN_SD_1AU_ARCSEC) + TB_TX_SEC + '}{R},\\qquad \\pi_{\\odot}=\\frac{' + _tbTx(AR_SOLAR_PARALLAX_ARCSEC) + TB_TX_SEC + '}{R}', ['_arNavAt']),
      _tbEq('vd', 'v=60\\,\\Delta\\mathrm{GHA}_{1\\mathrm{h}}-' + Math.floor(AR_MOON_V_BASE_ARCMIN / TB_ARCMIN_PER_DEG) + TB_TX_DEG +
        (AR_MOON_V_BASE_ARCMIN % TB_ARCMIN_PER_DEG).toFixed(1) + TB_TX_MIN + ',\\qquad d=60\\,\\Delta\\delta_{1\\mathrm{h}}')
    ];
  },
  planets: function () {
    return [
      _tbEq('light_time', '\\Delta t=' + _tbTx(AR_LIGHT_DAYS_PER_AU) + '\\,\\Delta\\ \\mathrm{d},\\quad \\mathbf{x}=\\mathbf{P}(\\tau-\\Delta t)-\\mathbf{E}(\\tau)', ['_arPlanet']),
      _tbEq('aberration', 'e=0.016708634-0.000042037T,\\quad\\varpi=102.93735' + TB_TX_DEG + '+1.71946' + TB_TX_DEG + 'T,\\quad\\kappa=' + _tbTx(AR_ABERRATION_ARCSEC) + TB_TX_SEC, ['_arApparentFromEcliptic']),
      _tbEq('aberration', '\\Delta\\lambda=\\frac{-\\kappa\\cos(\\odot-\\lambda)+e\\kappa\\cos(\\varpi-\\lambda)}{\\cos\\beta},\\quad\\Delta\\beta=-\\kappa\\sin\\beta\\left(\\sin(\\odot-\\lambda)-e\\sin(\\varpi-\\lambda)\\right)', ['_arApparentFromEcliptic'])
    ];
  },
  stars: function () {
    return [
      _tbEq('proper_motion', '\\mathbf{p}=\\mathbf{u}+t\\left(\\mu_{\\alpha}\\hat{\\mathbf{e}}_{\\alpha}+\\mu_{\\delta}\\hat{\\mathbf{e}}_{\\delta}+\\frac{v_{r}\\,\\varpi}{\\mathrm{au}/\\mathrm{yr}}\\,\\mathbf{u}\\right),\\quad t\\ \\text{' + _tbTxText('eq_years') + '}', ['_arStar']),
      _tbEq('precession', '\\zeta=2306.2181' + TB_TX_SEC + 'T+0.30188' + TB_TX_SEC + 'T^{2}+0.017998' + TB_TX_SEC + 'T^{3},\\ z=2306.2181' + TB_TX_SEC + 'T+1.09468' + TB_TX_SEC + 'T^{2}+0.018203' + TB_TX_SEC + 'T^{3}', ['_arStar']),
      _tbEq('precession', '\\theta=2004.3109' + TB_TX_SEC + 'T-0.42665' + TB_TX_SEC + 'T^{2}-0.041833' + TB_TX_SEC + 'T^{3}', ['_arStar']),
      _tbEq('precession', '\\alpha=\\operatorname{atan2}(\\cos\\delta_0\\sin(\\alpha_0+\\zeta),\\ \\cos\\theta\\cos\\delta_0\\cos(\\alpha_0+\\zeta)-\\sin\\theta\\sin\\delta_0)+z', ['_arStar']),
      _tbEq('precession', '\\delta=\\arcsin(\\sin\\theta\\cos\\delta_0\\cos(\\alpha_0+\\zeta)+\\cos\\theta\\sin\\delta_0)', ['_arStar']),
      _tbEqNote('stars_note')
    ];
  },
  heliacal: function () {
    return [
      _tbEq('heliacal', '\\cos H_{0}=\\frac{\\sin h_{0}-\\sin\\varphi\\sin\\delta}{\\cos\\varphi\\cos\\delta},\\quad h_{0}=' + _tbTxArcmin(AR_STAR_RISE_ALT), ['_arStarCalendar']),
      _tbEq('heliacal', 't=d+\\frac{(\\alpha\\mp H_{0}-\\theta_{0}(d)-\\lambda_{E})\\bmod 360' + TB_TX_DEG + '}{' + AR_SIDEREAL_DEG_PER_DAY + TB_TX_DEG + '/\\mathrm{d}}', ['_arStarCalendar']),
      _tbEq('heliacal', 'h_{\\odot}(t)\\le-(' + AR_ARCUS_VISIONIS_DEG + TB_TX_DEG + '+m)', ['_arStarCalendar'])
    ];
  },
  eot: function () {
    return [
      _tbEq('eot', 'E=' + AR_MIN_PER_DEG + '\\,\\tfrac{\\mathrm{min}}{' + TB_TX_DEG + '}\\left[\\left(\\mathrm{GHA}_{\\odot}-15' + TB_TX_DEG + 'h_{\\mathrm{UT}}-180' + TB_TX_DEG + '\\right)\\ \\text{' + _tbTxText('eq_wrapped') + '}\\right]', ['_arEquationOfTime'])
    ];
  },
  sundial: function () {
    return [
      _tbEq('sundial_noon', 't_{\\mathrm{noon}}=12^{\\mathrm{h}}-\\frac{\\lambda_{E}}{15' + TB_TX_DEG + '}-E\\ \\text{' + _tbTxText('eq_twice') + '}', ['_arSunTimeSpan']),
      _tbEq('correction', 'C=-E+' + AR_MIN_PER_DEG + '\\,\\tfrac{\\mathrm{min}}{' + TB_TX_DEG + '}\\,(15' + TB_TX_DEG + '\\,o_{\\mathrm{h}}-\\lambda_{E})', ['_tbSundial'])
    ];
  },
  sight: function () {
    return [
      _tbEq('dip', 'D=' + _tbTx(AR_DIP_ARCMIN_PER_SQRT_M) + TB_TX_MIN + '\\sqrt{h_{\\mathrm{m}}}', ['_arDip']),
      _tbEq('ha', 'H_{a}=H_{s}-\\mathrm{IE}-D', ['_arReduceSight']),
      _tbEq('refraction', 'R=\\cot\\left(H_{a}+\\frac{7.31}{H_{a}+4.4}\\right)\\cdot\\frac{0.28\\,P}{T_{\\mathrm{C}}+273}\\ ' + TB_TX_MIN, ['_arRefraction']),
      _tbEq('augment', 'SD_{' + TB_TX_MOON + "}'=SD_{" + TB_TX_MOON + '}\\,(1+\\sin H_{a}\\sin\\pi_{' + TB_TX_MOON + '})', ['_arReduceSight']),
      _tbEq('pa', 'PA=\\pi\\cos H_{a}', ['_arReduceSight']),
      _tbEq('ho', 'H_{o}=H_{a}-R\\pm SD+PA', ['_arReduceSight']),
      _tbEq('lha', '\\mathrm{LHA}=\\mathrm{GHA}+\\lambda_{E}', ['_arReduceSight']),
      _tbEq('hc', '\\sin H_{c}=\\sin\\varphi\\sin\\delta+\\cos\\varphi\\cos\\delta\\cos\\mathrm{LHA}', ['_arAltAz']),
      _tbEq('zn', 'Z_{n}=\\operatorname{atan2}\\left(-\\cos\\delta\\sin\\mathrm{LHA},\\ \\sin\\delta\\cos\\varphi-\\cos\\delta\\sin\\varphi\\cos\\mathrm{LHA}\\right)', ['_arAltAz']),
      _tbEq('intercept', 'a=60\\,(H_{o}-H_{c})\\ \\mathrm{nmi}', ['_arReduceSight']),
      _tbEq('noon_lat', '\\varphi=\\delta\\pm(90' + TB_TX_DEG + '-H_{o})', ['_arNoonLatitude'])
    ];
  },
  seasons: function () {
    return [
      _tbEq('season_jde0', '\\mathrm{JDE}_{0}=c_{0}+c_{1}Y+c_{2}Y^{2}+c_{3}Y^{3}+c_{4}Y^{4},\\quad Y=\\frac{y-2000}{1000}', ['_seasonInstantJDE']),
      _tbEqTable(['', 'c<sub>0</sub>', 'c<sub>1</sub>', 'c<sub>2</sub>', 'c<sub>3</sub>', 'c<sub>4</sub>'], _SEASON_JDE0.map(function (c, i) { return [_tbH(['eq_mar', 'eq_jun', 'eq_sep', 'eq_dec'][i])].concat(c.map(_tbTx)); })),
      _tbEq('season_w', 'W=35999.373' + TB_TX_DEG + 'T-2.47' + TB_TX_DEG + ',\\quad\\Delta\\lambda=1+0.0334\\cos W+0.0007\\cos2W', ['_seasonInstantJDE']),
      _tbEq('season_s', 'S=\\sum_{k=1}^{' + _SEASON_PERIODIC.length + '}A_{k}\\cos(B_{k}+C_{k}T),\\qquad\\mathrm{JDE}=\\mathrm{JDE}_{0}+\\frac{0.00001\\,S}{\\Delta\\lambda}', ['_seasonInstantJDE']),
      _tbEqTable(['', 'A', 'B', 'C'], _SEASON_PERIODIC.map(function (r, i) { return [String(i + 1)].concat(r.map(_tbTx)); })),
      _tbEq('season_ut', '\\mathrm{UT}=\\mathrm{JDE}-\\frac{\\Delta T}{' + TB_S_PER_DAY + '}', ['_arSeasons'])
    ];
  },
  eclipses: function () {
    return [
      _tbEq('ecl_radii', 'r_{\\odot}=\\arcsin\\frac{' + _tbTx(AE_SUN_RADIUS_KM) + '}{|\\mathbf{s}-\\mathbf{o}|},\\quad r_{' + TB_TX_MOON + '}=\\arcsin\\frac{' + _tbTx(AE_MOON_RADIUS_KM) + '}{|\\mathbf{m}-\\mathbf{o}|}', ['_arEclipseHere']),
      _tbEq('ecl_solar', '\\sigma=\\angle(\\mathbf{s}-\\mathbf{o},\\ \\mathbf{m}-\\mathbf{o}),\\quad\\mathrm{mag}=\\frac{r_{\\odot}+r_{' + TB_TX_MOON + '}-\\sigma}{2r_{\\odot}}', ['_arEclipseHere']),
      _tbEq('ecl_lunar', '\\rho_{u}=' + _tbTx(AE_SHADOW_ENLARGE) + '\\,(\\pi_{' + TB_TX_MOON + '}+\\pi_{\\odot}-s_{\\odot}),\\quad\\rho_{p}=' + _tbTx(AE_SHADOW_ENLARGE) + '\\,(\\pi_{' + TB_TX_MOON + '}+\\pi_{\\odot}+s_{\\odot})', ['_aeLunarShadow']),
      _tbEq('ecl_lunar', '\\mathrm{mag}_{u}=\\frac{\\rho_{u}+s_{' + TB_TX_MOON + '}-\\sigma}{2s_{' + TB_TX_MOON + '}}', ['_aeLunarShadow'])
    ];
  },
  calendars: function () {
    return [
      _tbEq('julian', '\\mathrm{JDN}=D+\\left\\lfloor\\frac{153m+2}{5}\\right\\rfloor+365y+\\left\\lfloor\\frac{y}{4}\\right\\rfloor-32083', ['_julianToJDN']),
      _tbEq('hijri', '\\mathrm{JDN}=\\left\\lfloor\\frac{11Y+3}{30}\\right\\rfloor+354Y+30M-\\left\\lfloor\\frac{M-1}{2}\\right\\rfloor+D+1948440-385', ['_hijriToJDN']),
      _tbEq('hebrew', 'n=\\left\\lfloor\\frac{235Y-234}{19}\\right\\rfloor,\\quad p=12084+13753\\,n,\\quad d=29n+\\left\\lfloor\\frac{p}{25920}\\right\\rfloor\\ (+1\\ \\text{' + _tbTxText('eq_if', { c: '3(d+1) mod 7 < 3' }) + '})', ['_hebrewDelay1']),
      _tbEq('hebrew', '\\text{1 Tishrei}=' + _tbTx(_HEBREW_EPOCH) + '+2.5+d+d_{2}', ['_hebrewNewYear']),
      _tbEq('persian', '\\mathrm{JDN}=N_{y+' + AR_PERSIAN_YEAR_OFFSET + '}+\\begin{cases}31(M-1)&M\\le6\\\\' + AR_PERSIAN_LONG_MONTHS_DAYS + '+30(M-7)&M>6\\end{cases}+D-1', ['_arPersianToJDN']),
      _tbEqNote('persian_note', { h: AR_IRAN_OFFSET_H }),
      _tbEqNote('chinese_note')
    ];
  },
  computus: function () {
    return [
      _tbEq('computus', 'G=y\\bmod19+1,\\quad C=\\left\\lfloor\\frac{y}{100}\\right\\rfloor+1,\\quad X=\\left\\lfloor\\frac{3C}{4}\\right\\rfloor-12,\\quad Z=\\left\\lfloor\\frac{8C+5}{25}\\right\\rfloor-5', ['_arComputusGregorian']),
      _tbEq('computus', 'E=(11G+20+Z-X)\\bmod30,\\quad N=44-E\\ (+30\\ \\text{' + _tbTxText('eq_if', { c: 'N < 21' }) + '}),\\quad D=\\left\\lfloor\\frac{5y}{4}\\right\\rfloor-X-10', ['_arComputusGregorian']),
      _tbEq('computus', '\\text{' + _tbTxText('eq_computus') + '}=\\text{' + _tbTxText('eq_mar') + '}\\ N+7-((D+N)\\bmod7)', ['_arComputusGregorian'])
    ];
  },
  days: function () {
    return [
      _tbEq('days', 'n=\\mathrm{JDN}_{b}-\\mathrm{JDN}_{a}'),
      _tbEq('iso_week', 'j_{\\mathrm{Th}}=\\mathrm{JDN}-(\\mathrm{JDN}\\bmod7)+3,\\quad w=\\left\\lfloor\\frac{j_{\\mathrm{Th}}-\\mathrm{JDN}(Y,1,1)}{7}\\right\\rfloor+1', ['_tbIsoWeek'])
    ];
  },
  distance: function () {
    return [
      _tbEq('haversine', 'a=\\sin^{2}\\frac{\\Delta\\varphi}{2}+\\cos\\varphi_{1}\\cos\\varphi_{2}\\sin^{2}\\frac{\\Delta\\lambda}{2},\\quad c=2\\operatorname{atan2}\\left(\\sqrt{a},\\sqrt{1-a}\\right)', ['_tbGreatCircle']),
      _tbEq('gc_distance', 'd=R\\,c,\\quad R=' + _tbTx(TB_EARTH_R_KM) + '\\ \\mathrm{km}', ['_tbGreatCircle']),
      _tbEq('bearing', '\\theta=\\operatorname{atan2}\\left(\\sin\\Delta\\lambda\\cos\\varphi_{2},\\ \\cos\\varphi_{1}\\sin\\varphi_{2}-\\sin\\varphi_{1}\\cos\\varphi_{2}\\cos\\Delta\\lambda\\right),\\quad\\theta_{f}=\\theta_{2\\to1}+180' + TB_TX_DEG, ['_tbGreatCircle']),
      _tbEq('midpoint', 'B_{x}=\\cos\\varphi_{2}\\cos\\Delta\\lambda,\\ B_{y}=\\cos\\varphi_{2}\\sin\\Delta\\lambda,\\ \\varphi_{m}=\\operatorname{atan2}\\left(\\sin\\varphi_{1}+\\sin\\varphi_{2},\\sqrt{(\\cos\\varphi_{1}+B_{x})^{2}+B_{y}^{2}}\\right)', ['_tbGreatCircle']),
      _tbEq('midpoint', '\\lambda_{m}=\\lambda_{1}+\\operatorname{atan2}(B_{y},\\ \\cos\\varphi_{1}+B_{x})', ['_tbGreatCircle']),
      _tbEq('units', '1\\ \\mathrm{mi}=' + _tbTx(TB_KM_PER.mi) + '\\ \\mathrm{km},\\quad 1\\ \\mathrm{nmi}=' + _tbTx(TB_KM_PER.nm) + '\\ \\mathrm{km}')
    ];
  },
  units: function () {
    return [
      _tbEq('units', 'x_{b}=x_{a}\\,\\frac{f_{a}}{f_{b}}', ['_tbConvert']),
      _tbEq('temperature', '\\mathrm{K}=\\,^{\\circ}\\mathrm{C}+' + _tbTx(TB_ZERO_C_K) + ',\\quad ^{\\circ}\\mathrm{C}=(^{\\circ}\\mathrm{F}-' + TB_F_ZERO_C + ')\\times\\frac{5}{9}', ['_tbConvert'])
    ];
  },
  zones: function () {
    return [_tbEq('zones', 't_{\\mathrm{there}}=t_{\\mathrm{here}}+(o_{\\mathrm{there}}-o_{\\mathrm{here}})')];
  },
  // The tide: NOAA's harmonic sum, the astronomical arguments it is turned
  // by (almanac-tides.js TideMath), and the station's own constituents for
  // the year (amplitude, phase, speed, and that year's f and V0 + u).
  tides: function (x) {
    var m = x.made;
    if (!m || !m.st || typeof TideMath === 'undefined') return [];
    var mean = TideMath.MEAN, rec = m.st.a ? m.st : m.st.refrec;
    // A mean longitude's polynomial in degrees, its small terms written as
    // Meeus writes them (T^3/538841), as the code holds them (1 / 538841).
    var poly = function (sym, c) {
      return sym + '=' + c.map(function (v, i) {
        var sign = v < 0 ? '-' : (i ? '+' : ''), a = Math.abs(v), inv = 1 / a, pow = i > 1 ? 'T^{' + i + '}' : (i ? 'T' : '');
        if (i > 1 && Math.abs(inv - Math.round(inv)) < 1e-6 * inv) return sign + '\\frac{' + pow + '}{' + Math.round(inv) + '}';
        return sign + _tbTx(a) + (i ? '\\,' + pow : TB_TX_DEG);
      }).join('');
    };
    var out = [
      _tbEq('tide_sum', 'h(t)=Z_{0}+\\sum_{i}f_{i}H_{i}\\cos\\left(\\omega_{i}t+(V_{0}+u)_{i}-\\kappa_{i}\\right)', ['heightAt']),
      _tbEqNote('tide_t'),
      _tbEq('tide_args', '\\begin{aligned}' + [poly('s', mean.s), poly('h', mean.h), poly('p', mean.p), poly('N', mean.N), poly('p_{1}', mean.p1)].join('\\\\').replace(/=/g, '&=') + '\\end{aligned}', ['astro']),
      _tbEq('tide_v0', 'V_{0}=a\\,(15' + TB_TX_DEG + 't_{\\mathrm{UT}}+180' + TB_TX_DEG + '+h-s)+b\\,s+c\\,h+d\\,p+e\\,p_{1}+g\\cdot90' + TB_TX_DEG, ['equilibrium', 'astro']),
      _tbEqNote('tide_fu')
    ];
    if (rec) {
      var y = _tbEqYear(x), h = TideMath.harmonic(rec, _at.data.tides.constituents), terms = TideMath.yearTerms(y, h.names);
      var ft = _atUnits() === 'ft', k = ft ? 1 / TideMath.M_PER_FT : 1, u = ft ? 'ft' : 'm';
      var rows = [];
      h.names.forEach(function (n, i) {
        if (!h.amp[i] || !terms.speed[i]) return;
        rows.push([_almEsc(typeof n === 'string' ? n : n[0]), (h.amp[i] * k).toFixed(3), h.ph[i].toFixed(1), terms.speed[i].toFixed(7), terms.f[i].toFixed(4), terms.vu[i].toFixed(2)]);
      });
      out.push(_tbEq('tide_z0', 'Z_{0}=' + (h.z0 * k).toFixed(3) + '\\ \\mathrm{' + u + '}'));
      out.push(_tbEqNote('tide_table', { y: y }));
      out.push(_tbEqTable([_tbH('eq_constituent'), 'H (' + u + ')', 'κ (°)', 'ω (°/h)', 'f', 'V₀+u (°)'], rows));
    }
    if (m.st.refrec) {
      out.push(_tbEq('tide_sub', 't=t_{\\mathrm{ref}}+\\Delta t,\\qquad h=h_{\\mathrm{ref}}\\times r\\ \\ \\text{' + _tbTxText('eq_or') + '}\\ \\ h_{\\mathrm{ref}}+\\Delta h', ['subordinateExtremes']));
      out.push(_tbEq('tide_between', 'h=h_{1}+(h_{2}-h_{1})\\,\\frac{1-\\cos\\left(\\pi\\frac{t-t_{1}}{t_{2}-t_{1}}\\right)}{2}', ['between']));
    }
    return out;
  }
};
// The Equations of the open view, as HTML: each equation its label and its
// TeX, drawn as MathML only when they are open (and Temml is there): a
// closed part costs a table's redraw nothing but strings.
function _tbEqHtml(x, open) {
  var groups = TB_EQ_VIEWS[_tb.id];
  if (!groups) return '';
  var items = [];
  groups.forEach(function (g) { items = items.concat(TB_EQ[g](x)); });
  if (!items.length) return '';
  var html = items.map(function (it) {
    if (it.note) return '<p class="tb-note tb-eq-note">' + _almEsc(it.note) + '</p>';
    if (it.table) return it.table;
    var math = open ? _tbEqDraw(it.tex) : '';
    return '<div class="tb-eq" data-tex="' + _almEsc(it.tex) + '"><div class="tb-eq-l">' + _tbH('eq_' + it.l) + '</div>' +
      '<div class="tb-eq-m" dir="ltr">' + (math || '<code class="tb-eq-src">' + _almEsc(it.tex) + '</code>') + '</div></div>';
  }).join('');
  return '<details class="tb-eqs"' + (open ? ' open' : '') + '><summary>' + _tbH('eq_title') + '</summary>' + html + '</details>';
}
// TeX to MathML, when Temml has loaded; '' before then or for TeX it refuses.
function _tbEqDraw(tex) {
  if (!window.temml) return '';
  try { return window.temml.renderToString(tex, { displayMode: true, throwOnError: true }); }
  catch (e) { if (window.console) console.error(e); return ''; }
}
// Temml and its sheet, once: a promise of whether they came.
var _tbTemml = null;
function _tbTemmlLoad() {
  if (window.temml) return Promise.resolve(true);
  if (_tbTemml) return _tbTemml;
  _tbTemml = new Promise(function (resolve) {
    var css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = TB_TEMML_CSS;
    document.head.appendChild(css);
    var s = document.createElement('script');
    s.src = TB_TEMML_JS; s.async = true;
    s.onload = function () { resolve(!!window.temml); };
    s.onerror = function () { _tbTemml = null; resolve(false); };
    document.head.appendChild(s);
  });
  return _tbTemml;
}
// Draw every equation still shown as TeX in host.
function _tbEqPaint(host) {
  (host || document).querySelectorAll('.tb-eq').forEach(function (el) {
    var m = el.querySelector('.tb-eq-m');
    if (!m || m.querySelector('math')) return;
    var html = _tbEqDraw(el.getAttribute('data-tex'));
    if (html) m.innerHTML = html;
  });
}
function _tbEqOpen(host) {
  return _tbTemmlLoad().then(function (ok) { if (ok) _tbEqPaint(host); return ok; });
}

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

// The heading only paper and Copy carry: what, then where and when in one
// line; at, the place's coordinates and zone, for a one-tile title block.
function _tbPrintHead(lines, at) {
  var sub = lines.filter(Boolean).join(' · ');
  return '<header class="tb-printhead"><h1>' + _almEsc(_tbName(_tb.id)) + '</h1>' +
    (sub ? '<p class="tb-sub">' + _almEsc(sub) + '</p>' : '') + (at ? '<p class="tb-at">' + _almEsc(at) + '</p>' : '') + '</header>';
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
  // The whole book (_tbBookPages) draws every table at once, in one go.
  if (_tb.sync) draw();
  else requestAnimationFrame(function () { setTimeout(draw, 0); });
  function draw() {
    if (seq !== _tb.seq || !out.isConnected) return;
    var res;
    try { res = TB_RENDER[id](span, _tb.place); }
    catch (e) { res = { html: '<p class="tb-empty">' + _tbH('failed') + '</p>' }; if (window.console) console.error(e); }
    out.innerHTML = res.html;
    out.classList.remove('tb-busy');
    var p = _tb.place;
    var own = res.place === false ? null : res.place || _tbShortName(p);
    var ph = _tbEl('tb-print-head');
    if (ph) ph.innerHTML = _tbPrintHead([own, span.label + (res.step ? ' · ' + res.step : '')], res.place == null ? _tbPlaceLine(p) : null);
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
  }
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
      made: { station: station, n: pr.n, ref: st.refrec ? _atTitle(st.refrec.n) : null, tz: tz, units: unit, st: st },
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
  var x = _tbCalcInputs(c);
  _tbMadeFill(x);
  // Its subtitle: the places it was worked for and its day.
  var ph = _tbEl('tb-print-head');
  if (ph) ph.innerHTML = _tbPrintHead(x.places.map(function (p) { return p.name ? _tbShortName(p) : _arLatText(p.lat) + ' ' + _arLonText(p.lon); }).concat(x.date == null ? [] : [_tbShortDay(_tbDayIn(x.date, x.places.length ? x.places[0].tz : null))]),
    x.places.length === 1 ? _tbPlaceLine(x.places[0]) : null);
  _tb.last = r;
}

// Opening the view by name: a table, a calculation, or "what stops being
// true"; and the whole book of the tiles shown, copied, shared or printed.
window.AlmanacRef = {
  open: _tbOpen, close: _tbClose,
  book: function (action, ids, showing) {
    if (action === 'print') return _tbBookPrint(ids, showing);
    _tbBookSend(ids, showing, action === 'share');
  }
};
