/* ZimCity: fingers, a mouse and keys on the map. Our own code, GPL-3.0.

   One finger with no tool held pans; one finger with a tool lays a stroke (drawn tools along the drag, zones in a row, a
   single building where the finger lifts: once the finger moves, that building's ghost rides just above it so the finger
   never hides it, and letting go off the map puts nothing down); two fingers pan and pinch and drop any stroke under way. A long press with no tool held inspects
   the tile. A wheel zooms about the pointer. The keys move a cursor tile; Enter builds there and I inspects it.
   Everything goes out through the handlers: this file never changes the city. */

import { ZOOM_MAX } from './zimcity-view.js';

var TAP_PX = 10;            // a press that moves less than this is a tap, not a drag
var LONG_PRESS_MS = 550;
var EDGE_PX = 32;           // drawing within this of the edge scrolls the map
var EDGE_SPEED = 9;         // screen pixels a frame at the very edge
var WHEEL_STEP = 1.0015;    // per wheel pixel
var GLIDE_DECAY = 0.92;     // a flung map slows by this each frame
var GLIDE_MIN = 0.3;        // and stops below this many pixels a frame
var DOUBLE_TAP_MS = 300;
var TAP_ZOOM = 1.6;
var ZOOM_MS = 220;
function still() { return window.ZimiShell && window.ZimiShell.reducedMotion ? window.ZimiShell.reducedMotion() : false; }

export function Input(view, h) {
  // h: { tool(): name or '', stroke(tiles, done), cancel(), inspect(x, y), moved(), cursor(x, y), lift(): px above the finger }
  var lifted = false;   // a single building's ghost is riding above the finger
  var el = view.canvas, pts = new Map(), mode = null, start = null, last = null, press = 0, pinch = null, edge = null, raf = 0;
  var cursor = null, vel = { x: 0, y: 0, t: 0 }, glide = 0, downAt = 0, lastTap = null;
  var zoomRaf = 0;
  function stopGlide() { if (glide) { cancelAnimationFrame(glide); glide = 0; } if (zoomRaf) { cancelAnimationFrame(zoomRaf); zoomRaf = 0; } }   // new input ends a fling and a double-tap zoom still easing
  // A fling keeps the map moving and slowing, as a page does; with reduced motion it stops where the finger left it.
  function fling() {
    if (still() || Math.hypot(vel.x, vel.y) < GLIDE_MIN * 2) return;
    (function frame() {
      vel.x *= GLIDE_DECAY; vel.y *= GLIDE_DECAY;
      if (Math.hypot(vel.x, vel.y) < GLIDE_MIN) { glide = 0; return; }
      view.panBy(vel.x, vel.y); h.moved();
      glide = requestAnimationFrame(frame);
    })();
  }
  // A double tap with no tool zooms in about the tap (back out to the whole city from the closest step), eased.
  function zoomTo(x, y, target) {
    if (still()) { view.zoomAt(x, y, target); h.moved(); return; }
    var from = view.cam.s, t0 = performance.now();
    (function frame(now) {
      var k = Math.min(1, (now - t0) / ZOOM_MS), e = 1 - Math.pow(1 - k, 3);
      view.zoomAt(x, y, from + (target - from) * e); h.moved();
      zoomRaf = k < 1 ? requestAnimationFrame(frame) : 0;
    })(t0);
  }

  function local(e) { var r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function clearPress() { if (press) { clearTimeout(press); press = 0; } }
  function stopEdge() { edge = null; if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  function edgeScroll() {
    raf = 0;
    if (!edge || mode !== 'stroke') return;
    var dx = edge.x < EDGE_PX ? EDGE_PX - edge.x : edge.x > view.w - EDGE_PX ? view.w - EDGE_PX - edge.x : 0;
    var dy = edge.y < EDGE_PX ? EDGE_PX - edge.y : edge.y > view.h - EDGE_PX ? view.h - EDGE_PX - edge.y : 0;
    if (dx || dy) {
      if (h.panned) h.panned();   // the edge pan is the player's: a followed citizen's camera lets go
      view.panBy(dx / EDGE_PX * EDGE_SPEED, dy / EDGE_PX * EDGE_SPEED);
      h.stroke(aim(edge), false);
      h.moved();
      raf = requestAnimationFrame(edgeScroll);
    }
  }
  // The tile a stroke means: under the finger, or under the ghost riding above it.
  function aim(p) { return view.tileAt(p.x, lifted ? p.y - h.lift() : p.y); }
  function offMap(p) { return p.x < 0 || p.y < 0 || p.x > view.w || p.y > view.h; }
  function twoFingers() {
    var a = Array.from(pts.values());
    return { mid: { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 }, dist: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1 };
  }

  el.addEventListener('pointerdown', function (e) {
    if (e.button > 0 && e.pointerType === 'mouse' && e.button !== 2) return;
    try { el.setPointerCapture(e.pointerId); } catch (x) { /* synthetic */ }
    var p = local(e);
    stopGlide();
    pts.set(e.pointerId, p);
    if (pts.size === 2) {
      clearPress();
      if (mode === 'stroke') h.cancel();
      mode = 'pinch'; pinch = Object.assign(twoFingers(), { s: view.cam.s });
      return;
    }
    if (pts.size > 2) return;
    start = last = p; downAt = performance.now(); vel = { x: 0, y: 0, t: downAt };
    // A right button or no tool: the map moves. A tool: a stroke begins where the finger is.
    if (!h.tool() || e.button === 2) {
      mode = 'pan';
      press = setTimeout(function () { press = 0; if (mode === 'pan') { mode = 'inspected'; var t = view.tileAt(start.x, start.y); h.inspect(t.x, t.y); } }, LONG_PRESS_MS);
    } else {
      mode = 'stroke'; lifted = false;
      h.stroke(view.tileAt(p.x, p.y), false);
    }
    h.moved();
  });
  el.addEventListener('pointermove', function (e) {
    if (!pts.has(e.pointerId)) {
      // A mouse hovering with a building held shows where it would go.
      if (e.pointerType === 'mouse' && h.tool() && !pts.size) { h.hover(view.tileAt(local(e).x, local(e).y)); h.moved(); }
      return;
    }
    var p = local(e);
    pts.set(e.pointerId, p);
    if (mode === 'pinch' && pts.size === 2) {
      var f = twoFingers();
      if (h.panned) h.panned();
      view.zoomAt(pinch.mid.x, pinch.mid.y, pinch.s * f.dist / pinch.dist);   // the point under the fingers stays under them
      view.panBy(f.mid.x - pinch.mid.x, f.mid.y - pinch.mid.y);
      pinch.mid = f.mid;
      h.moved();
      return;
    }
    if (Math.hypot(p.x - start.x, p.y - start.y) > TAP_PX) clearPress();
    if (mode === 'pan') {
      if (h.panned) h.panned();
      var now = performance.now(), dt = Math.max(1, now - vel.t);
      vel = { x: (p.x - last.x) * 16 / dt, y: (p.y - last.y) * 16 / dt, t: now };
      view.panBy(p.x - last.x, p.y - last.y); last = p; h.moved(); return;
    }
    if (mode === 'stroke') {
      last = p; edge = p;
      if (!lifted && e.pointerType !== 'mouse' && h.lift() && Math.hypot(p.x - start.x, p.y - start.y) > TAP_PX) lifted = true;
      h.stroke(aim(p), false);
      if (!raf) raf = requestAnimationFrame(edgeScroll);
      h.moved();
    }
  });
  function end(e) {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    clearPress();
    if (mode === 'pinch') { if (!pts.size) mode = null; return; }   // the finger left after a pinch starts nothing
    if (mode === 'stroke') {
      stopEdge();
      if (e.type === 'pointercancel' || offMap(last)) h.cancel(); else h.stroke(aim(last), true);   // let go off the map: nothing is built
      lifted = false;
    }
    if (mode === 'pan' && e.type === 'pointerup') {
      var moved = Math.hypot(last.x - start.x, last.y - start.y), now = performance.now();
      if (moved <= TAP_PX && now - downAt < LONG_PRESS_MS) {
        if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(start.x - lastTap.x, start.y - lastTap.y) < 30) {
          zoomTo(start.x, start.y, view.cam.s >= ZOOM_MAX - 0.01 ? view.minScale() : Math.min(ZOOM_MAX, view.cam.s * TAP_ZOOM));
          lastTap = null;
        } else lastTap = { x: start.x, y: start.y, t: now };
      } else if (now - vel.t < 80) fling();
    }
    mode = null;
    h.moved();
  }
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse' && !pts.size) { h.hover(null); h.moved(); } });
  el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  el.addEventListener('wheel', function (e) {
    e.preventDefault();
    stopGlide();
    var p = local(e);
    view.zoomAt(p.x, p.y, view.cam.s * Math.pow(WHEEL_STEP, -e.deltaY));
    h.moved();
  }, { passive: false });

  // The keyboard: arrows move the cursor tile (and the map with it), Enter or Space builds, I inspects, Escape puts the tool down.
  el.addEventListener('keydown', function (e) {
    var k = e.key, step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[k];
    if (!cursor) { var c = view.tileAt(view.w / 2, view.h / 2); cursor = { x: c.x, y: c.y }; }
    if (step) {
      e.preventDefault();
      cursor.x = Math.max(0, Math.min(view.city.map.width - 1, cursor.x + step[0]));
      cursor.y = Math.max(0, Math.min(view.city.map.height - 1, cursor.y + step[1]));
      view.reveal(cursor.x, cursor.y);
      h.cursor(cursor.x, cursor.y);
      h.moved();
    } else if (k === 'Escape') {
      h.cancel(); if (h.release) h.release();   // the stroke, then the tool in hand
    } else if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      if (h.tool()) { h.stroke(cursor, false); h.stroke(cursor, true); } else h.inspect(cursor.x, cursor.y);
      h.moved();
    } else if (k === 'i' || k === 'I') {
      e.preventDefault(); h.inspect(cursor.x, cursor.y);
    } else if (k === '+' || k === '=' || k === '-') {
      e.preventDefault(); view.zoomAt(view.w / 2, view.h / 2, view.cam.s * (k === '-' ? 0.8 : 1.25)); h.moved();
    }
  });
  el.addEventListener('blur', function () { cursor = null; h.cursor(null); h.moved(); });

  return { busy: function () { return mode === 'stroke' || mode === 'pinch'; } };
}
