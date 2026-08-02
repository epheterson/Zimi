// Reader View caption legibility.
//
// Captions are forced onto the reader palette's muted ink, so every figure
// shape a ZIM can emit must also have its own baked-in fill neutralised —
// otherwise the theme's ink lands on the ZIM's background and the caption
// reads worse than it did untouched. mwoffliner ships two shapes (Parsoid
// <figure typeof> and legacy .thumb/.thumbinner); warc2zim, devdocs and
// Gutenberg captures emit a bare <figure>.
//
// Start a server first, then:
//   BASE_URL=http://localhost:8873 npx playwright test \
//     --config=tests/playwright.config.mjs tests/test_reader_captions.spec.mjs

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:8873';
const THEMES = ['light', 'sepia', 'dark'];
const AA_NORMAL = 4.5;

function relLum([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(fg, bg) {
  const a = relLum(fg), b = relLum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// Render the three caption shapes in a frame styled by the reader injector and
// report each caption's colour against the background actually painted behind it.
async function measure(page, theme) {
  return page.evaluate((th) => {
    const f = document.createElement('iframe');
    f.style.cssText = 'width:800px;height:400px';
    document.body.appendChild(f);
    const d = f.contentDocument;
    d.body.className = 'zimi-reader-active rv-theme-' + th + ' rv-font-serif';
    d.body.innerHTML =
      '<div class="zimi-reader">' +
      '<figure style="background:#111"><img><figcaption id="bare">Bare figure</figcaption></figure>' +
      '<figure typeof="mw:File/Thumb" style="background:#f9f9f9"><img>' +
        '<figcaption id="parsoid">Parsoid</figcaption></figure>' +
      '<div class="thumb"><div class="thumbinner" style="background:#f9f9f9"><img>' +
        '<div class="thumbcaption" id="legacy">Legacy</div></div></div>' +
      '</div>';
    _readerViewInjectStyle(d);
    const nums = (c) => (c.match(/[\d.]+/g) || []).map(Number);
    const out = {};
    ['bare', 'parsoid', 'legacy'].forEach((id) => {
      const el = d.getElementById(id);
      let n = el, bg = null;
      while (n && n !== d.documentElement) {
        const p = nums(getComputedStyle(n).backgroundColor);
        if (p.length < 4 || p[3] > 0.5) { bg = p.slice(0, 3); break; }
        n = n.parentElement;
      }
      if (!bg) bg = nums(getComputedStyle(d.body).backgroundColor).slice(0, 3);
      out[id] = { fg: nums(getComputedStyle(el).color).slice(0, 3), bg };
    });
    f.remove();
    return out;
  }, theme);
}

test.describe('Reader View captions', () => {
  for (const theme of THEMES) {
    test(`every figure shape keeps AA contrast in the ${theme} palette`, async ({ page }) => {
      await page.goto(BASE);
      await page.evaluate((t) => localStorage.setItem('zimi_reader_theme', t), theme);
      await page.reload();
      const shapes = await measure(page, theme);
      for (const [name, c] of Object.entries(shapes)) {
        const ratio = contrast(c.fg, c.bg);
        expect(ratio, `${name} caption in ${theme}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    });
  }
});
