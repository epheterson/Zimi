"""How big a finger's target really is, measured the way a finger meets it.

Every clickable thing on a touch screen must give a finger at least 44 x 44 CSS px. What counts is not the drawn box but
the box that `elementFromPoint` hands the finger: padding, a negative margin and a transparent ::after all count, and a
neighbour painted over the edge takes it away. So the page is sampled on a grid and each point is given to the clickable
thing under it; the extent of each thing's points is its hit area.

`undersized(page)` returns one line for each kind of control under 44 on either axis; a test asserts the list is empty
(less the ones it names as waiting for a layout change).
"""

import json

MIN_PX = 44
# A hit area a pixel or two short is the sampling's edge, not a short control.
SLACK_PX = 1
COARSE_STEP_PX = 4
REACH_PX = 8

CLICKABLE = (
    "a[href],button,input:not([type=hidden]),select,textarea,summary,label[for],label:has(input,select,textarea),[role=button],[role=tab],"
    '[role=menuitem],[role=switch],[role=checkbox],[role=radio],[onclick],[tabindex]:not([tabindex="-1"]),[data-act],[data-action]'
)

_JS = r"""
(o) => {
  const SEL = o.sel, vw = innerWidth, vh = innerHeight, step = o.step, reach = o.reach;
  const root = o.scroller ? document.querySelector(o.scroller) : document.scrollingElement;
  const top = () => (o.scroller ? root.scrollTop : scrollY);
  const goTo = (y) => { if (o.scroller) root.scrollTop = y; else scrollTo(0, y); };
  const memo = (fn) => { const m = new WeakMap(); return (e) => { let v = m.get(e); if (v === undefined) { v = fn(e); m.set(e, v); } return v; }; };
  const pointer = memo((e) => getComputedStyle(e).cursor === 'pointer');
  const fixedUp = memo((e) => { const p = getComputedStyle(e).position; return p === 'fixed' || p === 'sticky'; });
  const fixedish = (e) => { for (let n = e; n && n !== document.documentElement; n = n.parentElement) if (fixedUp(n)) return true; return false; };
  // The clickable thing a point belongs to: a control, one of the extra selectors (the outermost), or a pointer cursor's owner.
  const owner = (h) => {
    const t = h.closest(SEL);
    if (t) return t;
    if (o.extra) {
      let x = h.closest(o.extra), y;
      if (x) { while (x.parentElement && (y = x.parentElement.closest(o.extra))) x = y; return x; }
    }
    if (!pointer(h)) return null;
    let e = h;
    while (e.parentElement && pointer(e.parentElement)) e = e.parentElement;
    return e;
  };
  // Where the scroller's list shows from: under whatever sticks at its top (a pinned head).
  const under = () => Math.max(root ? root.getBoundingClientRect().top : 0, ...Array.from(root ? root.children : []).filter((c) => getComputedStyle(c).position === 'sticky').map((c) => c.getBoundingClientRect().bottom));
  // Part of the control is out of sight above or below, behind the edge of what holds it (the screen, or a sheet that scrolls).
  const EDGE = 12;   // a box reaches up to 11px past a control: one this near an edge has its box cut by it
  const heightCut = (t) => {
    const r = t.getBoundingClientRect();
    if (r.top < EDGE || r.bottom > vh - EDGE) return true;
    for (let a = t.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      if (getComputedStyle(a).overflowY === 'visible') continue;
      const c = a.getBoundingClientRect();
      if (r.top < c.top + EDGE || r.bottom > c.bottom - EDGE) return true;
    }
    if (!o.scroller || !root.contains(t)) return false;
    // A row partly under what sticks at the scroller's top, or under something laid over its foot, is seen whole at another scroll position.
    const x = Math.min(Math.max((r.left + r.right) / 2, 0), vw - 1), at = (y) => { const h = document.elementFromPoint(x, Math.min(Math.max(y, 0), vh - 1)); return !!h && owner(h) === t; };
    return r.top < under() || !at(r.top + 2) || !at(r.bottom - 2);
  };
  const found = new Map();
  const sample = () => {
    const sx = scrollX, sy = top(), seen = new Map();
    for (let y = 1; y < vh; y += step) for (let x = 1; x < vw; x += step) {
      const h = document.elementFromPoint(x, y), t = h && owner(h);
      if (!t) continue;
      const f = seen.get(t);
      if (!f) seen.set(t, { l: x, r: x, t: y, b: y });
      else { f.l = Math.min(f.l, x); f.r = Math.max(f.r, x); f.t = Math.min(f.t, y); f.b = Math.max(f.b, y); }
    }
    for (const [t, f] of seen) {
      if (heightCut(t)) continue;   // straddling an edge it scrolls under: seen whole at another scroll position
      const hit = (x, y) => { if (x < 0 || y < 0 || x >= vw || y >= vh) return false; const h = document.elementFromPoint(x, y); return !!h && owner(h) === t; };
      const row = (y, a, z) => { for (let x = a; x <= z; x++) if (hit(x, y)) return true; return false; };
      const col = (x, a, z) => { for (let y = a; y <= z; y++) if (hit(x, y)) return true; return false; };
      let { l, r, t: tp, b } = f;
      for (let g = 0; g < reach && col(l - 1, tp, b); g++) l--;
      for (let g = 0; g < reach && col(r + 1, tp, b); g++) r++;
      for (let g = 0; g < reach && row(tp - 1, l, r); g++) tp--;
      for (let g = 0; g < reach && row(b + 1, l, r); g++) b++;
      let e = found.get(t);
      if (fixedish(t)) {   // a fixed bar keeps its place as the page scrolls: keep its biggest sighting
        const w = r - l + 1, hh = b - tp + 1;
        if (!e) found.set(t, { fixed: true, w, h: hh });
        else { e.w = Math.max(e.w, w); e.h = Math.max(e.h, hh); }
        continue;
      }
      const inside = !o.scroller || root.contains(t);
      const nb = { l: l + (inside ? sx : 0), r: r + (inside ? sx : 0), t: tp + (inside && o.scroller ? sy : o.scroller ? 0 : sy), b: b + (inside && o.scroller ? sy : o.scroller ? 0 : sy) };
      if (!e) found.set(t, nb);
      else { e.l = Math.min(e.l, nb.l); e.r = Math.max(e.r, nb.r); e.t = Math.min(e.t, nb.t); e.b = Math.max(e.b, nb.b); }
    }
  };
  const view = o.scroller ? root.clientHeight : vh;
  const maxY = o.noscroll ? 0 : Math.max(0, root.scrollHeight - view);
  const lip = o.scroller ? under() - root.getBoundingClientRect().top : 0;   // a pinned head covers the first of each page
  for (let y = 0; ; y += view - 40 - lip) { goTo(Math.min(y, maxY)); sample(); if (y >= maxY) break; }
  goTo(0);
  const sig = (e) => {
    const c = (typeof e.className === 'string' ? e.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (c ? '.' + c : '');
  };
  const out = [];
  for (const [e, f] of found) {
    // A canvas's targets are drawn (their reach is in the code); a radio or box inside its label is the label's.
    if (e.tagName === 'CANVAS' || (e.tagName === 'INPUT' && e.closest('label')) || e.closest(o.skip || ':not(*)')) continue;
    // A control the screen's edge cuts (the end of a row that scrolls sideways) is measured only where it shows: its width is not short.
    const edge = e.getBoundingClientRect(), cut = edge.right > vw + 1 || edge.left < -1;
    const w = cut ? 1e4 : f.fixed ? f.w : f.r - f.l + 1, h = f.fixed ? f.h : f.b - f.t + 1;
    out.push({ sig: sig(e), label: (e.getAttribute('aria-label') || e.title || e.textContent || e.value || '').trim().replace(/\s+/g, ' ').slice(0, 24), w, h });
  }
  return out;
};
"""


def measure(page, scroller=None, extra=None, skip=None, noscroll=False):
    """Every clickable thing the finger can reach, with the size of the box it gets: [{sig, label, w, h}]."""
    return page.evaluate(
        _JS.strip().rstrip(";"),
        dict(
            sel=CLICKABLE,
            step=COARSE_STEP_PX,
            reach=REACH_PX,
            scroller=scroller,
            extra=extra,
            skip=skip,
            noscroll=noscroll,
        ),
    )


def undersized(page, ignore=(), **kw):
    """One line per kind of control (its selector) whose hit area is under 44 on either axis, the smallest seen.

    `ignore` is a tuple of substrings of that selector: kinds that wait for a layout change and say so where they are listed.
    """
    kinds = {}
    for it in measure(page, **kw):
        if it["w"] >= MIN_PX - SLACK_PX and it["h"] >= MIN_PX - SLACK_PX:
            continue
        if any(i in it["sig"] for i in ignore):
            continue
        k = kinds.setdefault(it["sig"], dict(it, n=0))
        k["n"] += 1
        k["w"], k["h"] = min(k["w"], it["w"]), min(k["h"], it["h"])
    return [
        "%s %dx%d (x%d) %r" % (k["sig"], k["w"], k["h"], k["n"], k["label"])
        for k in sorted(kinds.values(), key=lambda x: x["sig"])
    ]


__all__ = ["measure", "undersized", "MIN_PX", "json"]


TOP_BAND = 0.3  # the top of the 3D view, as a share of its height
_TOP_BOXES = """(band) => {
  var view = document.getElementById('ae-view'), vr = view.getBoundingClientRect(), out = [], els = [];
  var sel = '#ae-view button, #ae-view .ae-stand-text, #ae-view .as-cap, #ae-view .alm-ck-l, #ae-view .alm-spd, #ae-view .as-speed';
  Array.prototype.forEach.call(document.querySelectorAll(sel), function (e) {
    var cs = getComputedStyle(e), r = e.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.1 || r.width < 2 || r.height < 2) return;
    for (var p = e.parentElement; p && p !== view; p = p.parentElement) { var ps = getComputedStyle(p); if (ps.display === 'none' || ps.visibility === 'hidden' || +ps.opacity < 0.1) return; }
    if (r.top - vr.top > band * vr.height || r.bottom < vr.top) return;
    var cl = r.left, ct = r.top, cr = r.right, cb = r.bottom;
    for (var a = e.parentElement; a && a !== view; a = a.parentElement) { var as = getComputedStyle(a); if (as.overflowX !== 'visible' || as.overflowY !== 'visible') { var ar = a.getBoundingClientRect(); if (r.bottom <= ar.top || r.top >= ar.bottom || r.right <= ar.left || r.left >= ar.right) return; cl = Math.max(cl, ar.left); ct = Math.max(ct, ar.top); cr = Math.min(cr, ar.right); cb = Math.min(cb, ar.bottom); } }   // clipped to its own scrolling box: what shows
    out.push({ name: e.id || e.className || e.tagName, l: cl, t: ct, r: cr, b: cb });
    els.push(e);
  });
  out.forEach(function (o, i) { o.in = []; els.forEach(function (p, j) { if (j !== i && p.contains(els[i])) o.in.push(j); }); });   // a part inside another is not a crossing
  return out;
}"""


def top_overlaps(page, band=TOP_BAND, slack=1):
    """Pairs of controls along the top of the 3D view whose boxes cross: one top for each mode, nothing drawn over anything."""
    boxes = page.evaluate(_TOP_BOXES, band)
    bad = []
    for i, a in enumerate(boxes):
        for j, b in enumerate(boxes[i + 1 :], i + 1):
            if j in a["in"] or i in b["in"]:
                continue
            if min(a["r"], b["r"]) - max(a["l"], b["l"]) > slack and min(a["b"], b["b"]) - max(a["t"], b["t"]) > slack:
                bad.append("%s x %s" % (a["name"], b["name"]))
    return bad
