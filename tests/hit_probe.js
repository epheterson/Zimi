// Hit areas at a phone's width: for each control on the screen, the box where a tap lands on it (probed with
// elementFromPoint, so a ::after hit box counts) and how many are under 44x44 (the 3px sampling step is the tolerance). Used by tests/test_touch_areas_live.py.
() => {
  const MIN = 44, STEP = 3, REACH = 26;
  const sel = 'button, a[href], [role=button], [role=tab], [role=menuitem], [role=switch], input:not([type=hidden]), select, textarea, summary, [onclick], [tabindex]:not([tabindex="-1"])';
  const seen = new Set(), out = [];
  const vis = el => { const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0 || cs.pointerEvents === 'none') return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const describe = el => (el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '') +
    ((el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 18) ? ' "' + (el.getAttribute('aria-label') || el.textContent).trim().replace(/\s+/g, ' ').slice(0, 18) + '"' : ''));
  const els = Array.from(document.querySelectorAll(sel));
  for (const el of els) {
    if (seen.has(el) || !vis(el)) continue;
    seen.add(el);
    // Inline links inside running text are exempt (WCAG 2.5.8 inline exception).
    if (el.tagName === 'A' && getComputedStyle(el).display === 'inline' && el.parentElement && /^(P|LI|SPAN|DIV|TD)$/.test(el.parentElement.tagName) && el.parentElement.textContent.trim().length > el.textContent.trim().length + 12) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, hits = 0;
    const L = Math.max(0, r.left - REACH), R = Math.min(innerWidth - 1, r.right + REACH), T = Math.max(0, r.top - REACH), B = Math.min(innerHeight - 1, r.bottom + REACH);
    for (let y = T; y <= B; y += STEP) for (let x = L; x <= R; x += STEP) {
      const h = document.elementFromPoint(x, y);
      if (h && (h === el || el.contains(h))) { hits++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (!hits) continue;                                   // covered by something else: not reachable here
    let w = x1 - x0 + STEP, h = y1 - y0 + STEP;
    if (x0 <= 1 || x1 >= innerWidth - 3) w = Math.max(w, MIN);   // the screen's edge cuts the probe, not the control
    if (y0 <= 1 || y1 >= innerHeight - 3) h = Math.max(h, MIN);
    out.push({ d: describe(el), w: Math.round(w), h: Math.round(h), drawn: [Math.round(r.width), Math.round(r.height)], at: [Math.round(r.left), Math.round(r.top)],
      small: w < MIN - 3 || h < MIN - 3, rect: [x0, y0, x1 + STEP, y1 + STEP], el });
  }
  // Overlap: two small controls whose hit boxes intersect.
  const smalls = out.filter(o => o.small);
  const overlaps = [];
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    const a = out[i].rect, b = out[j].rect;
    const ix = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), iy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    if (ix > 3 && iy > 3 && !out[i].el.contains(out[j].el) && !out[j].el.contains(out[i].el)) overlaps.push([out[i].d, out[j].d]);
  }
  return { total: out.length, small: smalls.length, list: smalls.map(o => o.d + ' ' + o.w + 'x' + o.h + ' @' + o.at.join(',')), overlaps: overlaps.length, ov: overlaps.slice(0, 6) };
}
