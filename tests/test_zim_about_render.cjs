// About this ZIM: the pure client logic behind the type badge and the
// provenance timeline. Extracted from app.js with the same vm approach as
// test_activity_rows.cjs so it runs without a browser.
//
// The contracts worth guarding hardest:
//   * a badge is derived from METADATA and only from metadata — a ZIM absent
//     from the kinds map gets NO badge, whatever its title says;
//   * the engine outranks the mode, so a replay ZIM reads "alive" even when it
//     captured a site;
//   * a record only ever claims the numbers it actually carries — a capture
//     that never counted assets must not render "0 files".
//
// Run: node tests/test_zim_about_render.cjs   (exit 0 = pass)

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
function has(label, haystack, needle) {
  ok(label, haystack.indexOf(needle) >= 0, haystack.indexOf(needle) >= 0 ? '' : 'missing ' + JSON.stringify(needle) + ' in ' + JSON.stringify(haystack));
}
function lacks(label, haystack, needle) {
  ok(label, haystack.indexOf(needle) < 0, haystack.indexOf(needle) < 0 ? '' : 'unexpected ' + JSON.stringify(needle) + ' in ' + JSON.stringify(haystack));
}

// The real en.json, so the test fails when a key the code asks for was never
// translated — the exact break a hand-written stub would hide.
const STRINGS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'i18n', 'en.json'), 'utf8'));

function makeSandbox(kinds) {
  const sandbox = {
    _zimKinds: kinds || null,
    _currentLang: 'en',
    Intl: Intl,
    Date: Date,
    t: (key, vars) => {
      let s = key in STRINGS ? STRINGS[key] : key;
      if (vars) for (const k in vars) s = s.replaceAll('{' + k + '}', vars[k]);
      return s;
    },
    // The same escaping app.js does, without a DOM.
    esc: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    _fmtBytes: (b) => b + 'B',
    // Fixed so the assertions do not depend on when the test runs.
    _relTime: () => 'THEN',
  };
  sandbox.escAttr = (s) => sandbox.esc(s).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
  sandbox.tH = (key, vars) => sandbox.t(key, vars)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  sandbox.tPlural = (base, n, vars) => {
    const cat = new Intl.PluralRules('en').select(Number(n) || 0);
    const key = (base + '_' + cat) in STRINGS ? base + '_' + cat : base + '_other';
    return sandbox.t(key, Object.assign({ n: n }, vars || {}));
  };
  vm.createContext(sandbox);
  vm.runInContext(
    extract(/var _PROV_MODE_KEYS = \{[\s\S]*?\n\};/, '_PROV_MODE_KEYS') +
    extract(/var _ZI_COUNT_KEYS = \{[^\n]*\};/, '_ZI_COUNT_KEYS') +
    extract(/var _ZI_OP_KEYS = \{[^\n]*\};/, '_ZI_OP_KEYS') +
    extract(/var _ZI_HISTORY_MODE = [^\n]*;/, '_ZI_HISTORY_MODE') +
    extract(/function _provKindKey\(kind\)\s*\{[\s\S]*?\n\}/, '_provKindKey') +
    extract(/function _provSummary\(kind\)\s*\{[\s\S]*?\n\}/, '_provSummary') +
    extract(/function _provBadgeFor\(kind\)\s*\{[\s\S]*?\n\}/, '_provBadgeFor') +
    extract(/function _provBadgeHtml\(name\)\s*\{[\s\S]*?\n\}/, '_provBadgeHtml') +
    extract(/function _ziWhen\(tsSec\)\s*\{[\s\S]*?\n\}/, '_ziWhen') +
    extract(/function _ziRow\(labelKey, valueHtml\)\s*\{[\s\S]*?\n\}/, '_ziRow') +
    extract(/function _ziSourceHtml\(source\)\s*\{[\s\S]*?\n\}/, '_ziSourceHtml') +
    extract(/function _ziTagsHtml\(tags\)\s*\{[\s\S]*?\n\}/, '_ziTagsHtml') +
    extract(/function _ziCountsText\(counts\)\s*\{[\s\S]*?\n\}/, '_ziCountsText') +
    extract(/function _ziBlockedHtml\(blocked\)\s*\{[\s\S]*?\n\}/, '_ziBlockedHtml') +
    extract(/function _ziToolsText\(record\)\s*\{[\s\S]*?\n\}/, '_ziToolsText') +
    extract(/function _ziRecordHtml\(record\)\s*\{[\s\S]*?\n\}/, '_ziRecordHtml') +
    extract(/function _ziOtherHtml\(other\)\s*\{[\s\S]*?\n\}/, '_ziOtherHtml'),
    sandbox);
  return sandbox;
}

// Labels below are asserted in their written case: the small-caps look every
// screenshot shows is text-transform in app.css, not the string.

// ── Badges are metadata-derived, never title-derived ────────────────────────

const KINDS = {
  notes: { mode: 'folder', engine: '', edits: 0, ts: 1786747674 },
  handbook: { mode: 'site', engine: '', edits: 2, ts: 1785970810 },
  newsroom: { mode: '', engine: 'alive', edits: 0 },
  archive: { mode: 'import', engine: '', edits: 0 },
  mystery: { mode: '', engine: '', edits: 0 },
};
let s = makeSandbox(KINDS);

has('folder ZIM gets the Folder badge', s._provBadgeHtml('notes'), '>Folder<');
has('site ZIM gets the Site badge', s._provBadgeHtml('handbook'), '>Site<');
has('import gets the Import badge', s._provBadgeHtml('archive'), '>Import<');
// The whole reason the badge exists: "(alive)" in a TITLE is a demo artifact,
// the zimi:alive TAG is the fact — and only the latter reaches this map.
has('alive engine outranks the (absent) mode', s._provBadgeHtml('newsroom'), '>Alive<');
has('alive badge is the one that gets the outline', s._provBadgeHtml('newsroom'), 'prov-alive');
lacks('a non-alive badge stays quiet', s._provBadgeHtml('handbook'), 'prov-alive');
ok('a Zimi ZIM of unknown mode still says Zimi',
  s._provBadgeHtml('mystery').includes('>Zimi<'), s._provBadgeHtml('mystery'));
ok('a ZIM absent from the map gets NO badge', s._provBadgeHtml('wikipedia_en_all') === '');
ok('no map at all means no badges anywhere', makeSandbox(null)._provBadgeHtml('notes') === '');
// The panel renders from the kind its own fetch returned, so it needs no map.
ok('a kind alone is enough for a badge',
  makeSandbox(null)._provBadgeFor(KINDS.handbook).includes('>Site<'));

// A title that claims to be alive changes nothing: the badge never reads it.
ok('badges ignore titles entirely',
  s._provBadgeHtml('wikipedia_en_all (alive)') === '');

// ── Tooltips ───────────────────────────────────────────────────────────────

has('tooltip names Zimi and when', s._provSummary(KINDS.notes), 'Made with Zimi THEN');
has('tooltip counts later edits', s._provSummary(KINDS.handbook), 'edited 2 times since');
ok('a timestamp-less kind still gets a sentence',
  s._provSummary(KINDS.newsroom) === 'Made with Zimi', s._provSummary(KINDS.newsroom));
ok('no kind, no tooltip', s._provSummary(null) === '');

// ── Counts claim only what a record carries ─────────────────────────────────

ok('counts render in order', s._ziCountsText({ pages: 3, assets: 0, bytes: 243 }) === '3 pages · 0 files · 243B',
  s._ziCountsText({ pages: 3, assets: 0, bytes: 243 }));
ok('one page is singular', s._ziCountsText({ pages: 1 }) === '1 page');
lacks('an uncounted key is absent, not zero', s._ziCountsText({ pages: 5 }), 'file');
ok('no counts, no line', s._ziCountsText(null) === '' && s._ziCountsText({}) === '');
has('the truncation marker names its records', s._ziCountsText({ records: 3 }), '3 records');

// ── Blocked provenance ──────────────────────────────────────────────────────

const BLOCKED = { requests: 214, domains: 37, list: 'stevenblack-hosts', snapshot: '2026-07-01', override: true };
const blockedHtml = s._ziBlockedHtml(BLOCKED);
has('blocked line reads as Eric asked', blockedHtml, '214 ad/tracker requests blocked (stevenblack-hosts)');
has('blocked sub-line carries the domains', blockedHtml, '37 domains');
has('blocked sub-line carries the snapshot', blockedHtml, 'list snapshot 2026-07-01');
has('a local override is admitted', blockedHtml, "includes this machine's own blocklist");
has('one request is singular', s._ziBlockedHtml({ requests: 1, list: 'x' }), '1 ad/tracker request blocked (x)');
has('a list-less record still reads', s._ziBlockedHtml({ requests: 9 }), '9 ad/tracker requests blocked');
lacks('a list-less record grows no empty parens', s._ziBlockedHtml({ requests: 9 }), '()');
ok('nothing blocked, nothing said', s._ziBlockedHtml(null) === '' && s._ziBlockedHtml({ requests: 0 }) === '');

// ── Timeline records ────────────────────────────────────────────────────────

const CREATED = {
  ts: 1785970810, zimi: '1.9.0', op: 'created', mode: 'site',
  detail: 'captured 148 pages from https://handbook.example.org',
  counts: { pages: 148, assets: 902 }, blocked: BLOCKED,
};
const created = s._ziRecordHtml(CREATED);
has('record names the operation', created, '>Created<');
has('record chips the mode', created, 'zi-ev-mode">Site<');
has('record shows the detail verbatim', created, 'captured 148 pages from https://handbook.example.org');
has('record shows its counts', created, '148 pages · 902 files');
has('record shows what it refused', created, '214 ad/tracker requests blocked');
has('record credits Zimi', created, 'Zimi 1.9.0');

const edited = s._ziRecordHtml({
  ts: 1786400000, zimi: '1.9.0', op: 'edited', mode: 'site',
  detail: 'removed 4 pages', tools: { chromium: '138.0.7204.94' },
});
has('an edit reads as an edit', edited, '>Edited<');
has('an edit names the engine that ran', edited, 'chromium 138.0.7204.94');

const truncated = s._ziRecordHtml({
  ts: 1785000000, zimi: '1.9.0', op: 'truncated', mode: 'history',
  detail: '3 earlier records collapsed', counts: { records: 3 },
});
has('the truncation marker is legible', truncated, 'Earlier records collapsed');
lacks('the truncation marker gets no mode chip', truncated, 'zi-ev-mode');

// An op invented after this build shipped renders as itself rather than
// vanishing — the same forward-compatibility the record schema promises.
has('an unknown op still renders', s._ziRecordHtml({ op: 'signed', detail: 'x' }), '>signed<');

// ── Rows, sources and tags ──────────────────────────────────────────────────

ok('an empty value renders no row at all', s._ziRow('zi_source', '') === '');
has('a filled row carries its label', s._ziRow('zi_source', 'x'), '>Source<');
has('a URL source is a link', s._ziSourceHtml('https://example.org/a'), '<a href="https://example.org/a"');
has('a link cannot reach back', s._ziSourceHtml('https://example.org/a'), 'rel="noopener noreferrer"');
lacks('a folder name is NOT a link', s._ziSourceHtml('field-notes'), '<a ');
lacks('a javascript: source is never linked', s._ziSourceHtml('javascript:alert(1)'), '<a ');
ok('no source, no markup', s._ziSourceHtml('') === '');
has('tags become chips', s._ziTagsHtml(['_category:other', 'lit']), 'zi-tag">_category:other<');
ok('no tags, no chips', s._ziTagsHtml([]) === '' && s._ziTagsHtml(null) === '');

// ── Fields with no row of their own ─────────────────────────────────────────
// A build that does not recognise a metadata key must still show it: the panel
// reports the FILE, not the subset this version happens to understand.

const other = s._ziOtherHtml({ Counter: 'text/html=2', 'X-Publisher-Note': 'hi' });
has('an unrecognised field is listed', other, 'X-Publisher-Note');
has('its value comes with it', other, 'text/html=2');
// The key is the file's spelling; the UI must not retitle it (the small-caps
// look elsewhere is CSS, and .zi-k-raw opts out of it).
has('the raw key keeps its own case', other, 'zi-k-raw">X-Publisher-Note<');
ok('nothing extra, no section', s._ziOtherHtml(null) === '' && s._ziOtherHtml({}) === '');

// ── Escaping ────────────────────────────────────────────────────────────────
// Metadata is third-party text: a ZIM published by anybody can carry markup in
// its Source, its detail sentence or its tags.
lacks('a scripted detail is escaped', s._ziRecordHtml({ op: 'created', detail: '<img src=x onerror=1>' }), '<img');
lacks('a scripted tag is escaped', s._ziTagsHtml(['<b>hi</b>']), '<b>');

console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
process.exit(failures ? 1 : 0);
