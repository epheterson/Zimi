// A box that fills itself later gets its height back.
//
// The reader collapses tall, empty, transparent boxes because a captured front
// page is full of ad slots nobody filled, and they read as white voids between
// stories. The sweep runs on frame.onload.
//
// An app that mounts a moment later is indistinguishable at that instant: a
// tall empty div. The canvas guard in the sweep cannot help, because the
// canvas does not exist yet.
//
// That is how every PDF came out blank (#71), and how an offline map ZIM
// rendered as an empty page: MapLibre's container was collapsed to height 0
// before MapLibre built its canvas inside it. Measured on StreetZim's Hawaii
// ZIM, 2026-09-17: .maplibregl-map had an inline height of 0px in Zimi's
// reader and rendered nothing, while the same page opened raw drew the map.
//
// #71 was fixed by teaching the passes to skip OUR OWN pages, which left every
// other late-mounting app still broken. The comment above the sweep already
// claimed the right behaviour — "a page that later fills one by script gets
// its box back" — and this is what finally makes that true.
//
// Run: node tests/test_hollow_hole_restore.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');

let failures = 0;
const check = (ok, label) => {
  if (ok) console.log('ok: ' + label);
  else { console.error('FAIL: ' + label); failures++; }
};

function fn(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error(name + ' not found');
  let d = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(i, j + 1);
  }
  throw new Error('unbalanced ' + name);
}

// ── the sweep hands its holes to the watcher ───────────────────────────────

const sweep = fn('_settleCapturedChrome');
check(/_watchForFilledHoles\(doc, collapse\)/.test(sweep),
      'every collapsed box is watched');
check(sweep.indexOf("setProperty('height', '0'") < sweep.indexOf('_watchForFilledHoles'),
      'and watched after being collapsed, not before');
check(/dataset\.zimiCollapsed/.test(sweep),
      'a collapsed box is marked, so it can be told from one the page styled');

// ── what counts as filled ──────────────────────────────────────────────────

const watch = fn('_watchForFilledHoles');
for (const tag of ['canvas', 'iframe', 'object', 'embed', 'img', 'video', 'svg']) {
  check(watch.includes(tag), `${tag} counts as content arriving`);
}
check(/MutationObserver/.test(watch),
      'it watches rather than polls, so an app that mounts in 50ms is not left collapsed for a second');
check(/childList: true, subtree: true/.test(watch),
      'and watches the subtree, since the content lands inside the box');

// ── and it does not watch forever ──────────────────────────────────────────

check(/_HOLE_WATCH_MS/.test(watch) && /setTimeout/.test(watch),
      'the watch is short-lived: an app mounts in the first seconds or it was a hole');
check(/observer\.disconnect\(\)/.test(watch),
      'and disconnects once every hole is accounted for');

// ── restoring puts back exactly what was taken ─────────────────────────────

const restore = fn('_restoreHole');
const taken = ['height', 'min-height', 'padding', 'margin', 'overflow'];
for (const prop of taken) {
  check(restore.includes(`'${prop}'`), `${prop} is given back`);
}
check(/removeProperty/.test(restore),
      'removed rather than overwritten, so the page\'s own styling applies again');

console.log('');
if (failures) {
  console.error(failures + ' hole-restore check(s) failed');
  process.exit(1);
}
console.log('all hole-restore checks passed');
