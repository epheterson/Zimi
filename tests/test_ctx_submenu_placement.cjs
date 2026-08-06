// DOM-free regression test for context-menu SUBMENU placement (_ctxSubPlacement).
//
// The bug this guards: on a phone the parent menu is already clamped against
// the right edge of the viewport, so a submenu opening rightward from it had
// nowhere to go — the category list rendered off screen with every label cut in
// half ("Encyclop…", "Q&A Con…"). The old flip-left test asked whether a FIXED
// assumed width fit on the left, which left a dead zone of press positions
// where neither answer was "yes" and the submenu opened right anyway.
//
// The contract now: a submenu is always fully inside the viewport, and when it
// has to be pinned (neither side fits) it clears its own trigger row — the tap
// that opens it is still on that row, and the click it becomes would otherwise
// activate whichever category landed under the finger.
//
// Same vm-extraction approach as test_define_touch_position.cjs.
//
// Run: node tests/test_ctx_submenu_placement.cjs   (exit 0 = pass)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'zimi', 'static', 'app.js'), 'utf8');
function extract(re, label) {
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + label + ' from app.js');
  return m[0];
}

const sandbox = { Math: Math };
vm.createContext(sandbox);
vm.runInContext([
  extract(/var CTX_EDGE = \d+;.*$/m, 'CTX_EDGE'),
  extract(/var CTX_SUB_TOP = \d+;.*$/m, 'CTX_SUB_TOP'),
  extract(/var CTX_SUB_GAP = \d+;.*$/m, 'CTX_SUB_GAP'),
  extract(/function _ctxSubPlacement\(r, sw, sh, vw, vh\)\s*\{[\s\S]*?\n  \}/, '_ctxSubPlacement'),
].join('\n'), sandbox);

const EDGE = sandbox.CTX_EDGE;
const place = (r, sw, sh, vw, vh) => sandbox._ctxSubPlacement(r, sw, sh, vw, vh);
// A menu row: the trigger spans the parent menu's width at some vertical offset.
const row = (menuLeft, menuWidth, top, h = 32) =>
  ({ left: menuLeft, right: menuLeft + menuWidth, top: top, bottom: top + h });

let failures = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures++;
}
// Every placement must satisfy these, always.
function invariants(label, p, vw, vh, r) {
  ok(label + ': within viewport', p.x >= EDGE - 0.01 && p.x + p.w <= vw - EDGE + 0.01 &&
    p.y >= EDGE - 0.01 && p.y + p.h <= vh - EDGE + 0.01,
    `[${p.x.toFixed(0)},${p.y.toFixed(0)} ${p.w.toFixed(0)}x${p.h.toFixed(0)}] vw=${vw} vh=${vh}`);
  ok(label + ': positive size', p.w > 0 && p.h > 0);
  if (p.pinned) {
    const coversRow = !(p.y + p.h <= r.top || p.y >= r.bottom);
    ok(label + ': pinned clears its trigger row', !coversRow,
      `sub y ${p.y.toFixed(0)}..${(p.y + p.h).toFixed(0)} vs row ${r.top}..${r.bottom}`);
  }
}

// 1. Desktop: plenty of room on the right — opens flush against the trigger.
{
  const r = row(400, 180, 300);
  const p = place(r, 181, 300, 1440, 900);
  invariants('desktop room-right', p, 1440, 900, r);
  ok('desktop room-right: opens rightward', p.x === r.right && !p.pinned, `x=${p.x}`);
  ok('desktop room-right: hangs from the trigger top', p.y === r.top - sandbox.CTX_SUB_TOP);
}

// 2. No room right, room left — flips so its right edge meets the trigger's left.
{
  const r = row(1200, 180, 300);
  const p = place(r, 181, 300, 1440, 900);
  invariants('flip-left', p, 1440, 900, r);
  ok('flip-left: opens leftward', p.x + p.w === r.left && !p.pinned, `x=${p.x} w=${p.w}`);
}

// 3. THE REPORTED BUG. 390px phone, parent menu mid-right, category list wider
//    than the gap on either side: pinned, on screen, clear of the trigger row.
{
  const vw = 390, vh = 844;
  const r = row(195, 181, 400);
  const p = place(r, 260, 300, vw, vh);
  invariants('phone dead zone', p, vw, vh, r);
  ok('phone dead zone: pinned rather than run off screen', p.pinned);
}

// 4. Sweep every press position a finger can produce on a 390x844 phone, for a
//    range of submenu sizes. This is the dead zone the old code had: it must be
//    empty now, at every x and y, not just at the edges.
{
  const vw = 390, vh = 844, MENU_W = 181;
  let bad = [];
  for (let menuLeft = EDGE; menuLeft <= vw - MENU_W - EDGE; menuLeft += 4) {
    for (let top = EDGE; top <= vh - 40; top += 37) {
      for (const sw of [140, 181, 240, 380, 500]) {
        for (const sh of [120, 300, 900]) {
          const r = row(menuLeft, MENU_W, top);
          const p = place(r, sw, sh, vw, vh);
          const offscreen = p.x < EDGE - 0.01 || p.x + p.w > vw - EDGE + 0.01 ||
            p.y < EDGE - 0.01 || p.y + p.h > vh - EDGE + 0.01 || p.w <= 0 || p.h <= 0;
          const coversRow = p.pinned && !(p.y + p.h <= r.top || p.y >= r.bottom);
          if (offscreen || coversRow) bad.push(`menuLeft=${menuLeft} top=${top} ${sw}x${sh}${coversRow ? ' COVERS ROW' : ''}`);
        }
      }
    }
  }
  ok(`phone sweep (${(((vw - MENU_W - 2 * EDGE) / 4) | 0) * 23 * 15} placements)`, bad.length === 0,
    bad.length ? bad.slice(0, 3).join(' ; ') : 'no placement leaves the viewport');
}

// 5. A submenu taller than the viewport is capped so it scrolls inside itself.
{
  const vh = 844, r = row(100, 181, 400);
  const p = place(r, 181, 4000, 390, vh);
  invariants('taller than viewport', p, 390, vh, r);
  ok('taller than viewport: height capped', p.h < 4000 && p.h > 100, `h=${p.h}`);
}

// 6. A submenu wider than the viewport is capped to the viewport, not centred
//    off the edge (labels wrap instead — see .ctx-sub.fitted).
{
  const vw = 320, r = row(60, 181, 300);
  const p = place(r, 900, 300, vw, 568);
  invariants('wider than viewport', p, vw, 568, r);
  ok('wider than viewport: width capped', p.w === vw - 2 * EDGE, `w=${p.w}`);
}

// 7. Pinned with the trigger low on the screen: goes ABOVE the row, not below.
{
  const vw = 390, vh = 844, r = row(195, 181, 780);
  const p = place(r, 260, 300, vw, vh);
  invariants('pinned near the bottom', p, vw, vh, r);
  ok('pinned near the bottom: opens upward', p.y + p.h <= r.top, `y+h=${(p.y + p.h).toFixed(0)} row top=${r.top}`);
}

// 8. Landscape phone: short viewport, trigger mid-height, list must still fit.
{
  const vw = 844, vh = 390, r = row(650, 181, 180);
  const p = place(r, 181, 600, vw, vh);
  invariants('landscape', p, vw, vh, r);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll submenu placement checks passed');
process.exit(failures ? 1 : 0);
