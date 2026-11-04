/* ZimCity: fingers, a mouse and keys on the map. Our own code, GPL-3.0.

   One finger with no tool held pans; one finger with a tool lays a stroke (drawn tools along the drag, a building where
   the finger lifts); two fingers pan and pinch and drop any stroke under way. A long press with no tool held inspects
   the tile. A wheel zooms about the pointer. The keys move a cursor tile; Enter builds there and I inspects it.
   Everything goes out through the handlers: this file never changes the city. */

var TAP_PX = 10;            // a press that moves less than this is a tap, not a drag
var LONG_PRESS_MS = 550;
var EDGE_PX = 32;           // drawing within this of the edge scrolls the map
var EDGE_SPEED = 9;         // screen pixels a frame at the very edge
var WHEEL_STEP = 1.0015;    // per wheel pixel

export function Input(view, h) {
  // h: { tool(): name or '', stroke(tiles, done), cancel(), inspect(x, y), moved(), cursor(x, y) }
  var el = view.canvas, pts = new Map(), mode = null, start = null, last = null, press = 0, pinch = null, edge = null, raf = 0;
  var cursor = null;

  function local(e) { var r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function clearPress() { if (press) { clearTimeout(press); press = 0; } }
  function stopEdge() { edge = null; if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  function edgeScroll() {
    raf = 0;
    if (!edge || mode !== 'stroke') return;
    var dx = edge.x < EDGE_PX ? EDGE_PX - edge.x : edge.x > view.w - EDGE_PX ? view.w - EDGE_PX - edge.x : 0;
    var dy = edge.y < EDGE_PX ? EDGE_PX - edge.y : edge.y > view.h - EDGE_PX ? view.h - EDGE_PX - edge.y : 0;
    if (dx || dy) {
      view.panBy(dx / EDGE_PX * EDGE_SPEED, dy / EDGE_PX * EDGE_SPEED);
      h.stroke(view.tileAt(edge.x, edge.y), false);
      h.moved();
      raf = requestAnimationFrame(edgeScroll);
    }
  }
  function twoFingers() {
    var a = Array.from(pts.values());
    return { mid: { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 }, dist: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1 };
  }

  el.addEventListener('pointerdown', function (e) {
    if (e.button > 0 && e.pointerType === 'mouse' && e.button !== 2) return;
    try { el.setPointerCapture(e.pointerId); } catch (x) { /* synthetic */ }
    var p = local(e);
    pts.set(e.pointerId, p);
    if (pts.size === 2) {
      clearPress();
      if (mode === 'stroke') h.cancel();
      mode = 'pinch'; pinch = Object.assign(twoFingers(), { s: view.cam.s });
      return;
    }
    if (pts.size > 2) return;
    start = last = p;
    // A right button or no tool: the map moves. A tool: a stroke begins where the finger is.
    if (!h.tool() || e.button === 2) {
      mode = 'pan';
      press = setTimeout(function () { press = 0; if (mode === 'pan') { mode = 'inspected'; var t = view.tileAt(start.x, start.y); h.inspect(t.x, t.y); } }, LONG_PRESS_MS);
    } else {
      mode = 'stroke';
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
      view.zoomAt(f.mid.x, f.mid.y, pinch.s * f.dist / pinch.dist);
      view.panBy(f.mid.x - pinch.mid.x, f.mid.y - pinch.mid.y);
      pinch.mid = f.mid;
      h.moved();
      return;
    }
    if (Math.hypot(p.x - start.x, p.y - start.y) > TAP_PX) clearPress();
    if (mode === 'pan') { view.panBy(p.x - last.x, p.y - last.y); last = p; h.moved(); return; }
    if (mode === 'stroke') {
      last = p; edge = p;
      h.stroke(view.tileAt(p.x, p.y), false);
      if (!raf) raf = requestAnimationFrame(edgeScroll);
      h.moved();
    }
  });
  function end(e) {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    clearPress();
    if (mode === 'pinch') { if (!pts.size) mode = null; return; }   // the finger left after a pinch starts nothing
    if (mode === 'stroke') { stopEdge(); if (e.type === 'pointercancel') h.cancel(); else h.stroke(view.tileAt(last.x, last.y), true); }
    mode = null;
    h.moved();
  }
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse' && !pts.size) { h.hover(null); h.moved(); } });
  el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  el.addEventListener('wheel', function (e) {
    e.preventDefault();
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
      h.cursor(cursor.x, cursor.y);
      h.moved();
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
