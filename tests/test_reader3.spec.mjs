// Reader batch v1.8 QA — four items:
//  1. Reader View settings render INLINE (top-level) in the ⋯ menu at mobile width
//  2. A−/A+ size controls are vertically centered
//  3. Print goes through a PARENT-document print container (iOS-safe), not the iframe
//  4. Share deep-links into the SPA (/?a=<zim>/<path>) and boots one topbar
//
// Start a server first (uses the bundled devdocs ZIM):
//   ZIM_DIR=./zims python3 -m zimi serve --port 8877
// Run:
//   BASE_URL=http://localhost:8877 npx playwright test --config=tests/playwright.config.mjs tests/test_reader3.spec.mjs

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:8877';
const ZIM = 'devdocs_en_lit';
const PATH = 'templates/directives/index'; // ~30k chars → readerable
const DEEP = `${BASE}/?a=${encodeURIComponent(ZIM + '/' + PATH)}`;

async function waitReaderOpen(page) {
  await page.waitForFunction(() =>
    document.getElementById('reader') &&
    document.getElementById('reader').classList.contains('open'), null, { timeout: 20000 });
}

async function enableReaderView(page) {
  // Wait for the iframe article to load, then turn Reader View on directly.
  await page.waitForFunction(() => {
    try { return typeof _readerViewAvailable === 'function' && _readerViewAvailable(); }
    catch (e) { return false; }
  }, null, { timeout: 20000 });
  await page.evaluate(() => { if (!_readerViewOn) _readerViewToggle(); });
  await page.waitForFunction(() => _readerViewOn === true, null, { timeout: 5000 });
}

test.describe('Reader batch v1.8', () => {
  // ── Item 4: deep-link boot opens the article inside full Zimi chrome, one header
  test('deep link /?a= boots the SPA on the article with exactly one topbar', async ({ page }) => {
    await page.goto(DEEP);
    await waitReaderOpen(page);
    // Exactly one header, both after boot and after navigating away + back.
    expect(await page.locator('nav.topbar').count()).toBe(1);
    const art = await page.evaluate(() => currentArticle && { zim: currentArticle.zim, path: currentArticle.path });
    expect(art).toEqual({ zim: ZIM, path: PATH });

    // Navigate away (home) then back — the classic header-duplication trap.
    await page.evaluate(() => goHome());
    await page.waitForFunction(() =>
      !document.getElementById('reader').classList.contains('open'), null, { timeout: 10000 });
    expect(await page.locator('nav.topbar').count()).toBe(1);

    await page.goBack();
    await page.waitForTimeout(1200);
    expect(await page.locator('nav.topbar').count()).toBe(1);
  });

  // ── Item 1: inline reader settings top-level in the ⋯ menu at 390px
  test('⋯ menu shows inline reader settings at 390px, fits width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(DEEP);
    await waitReaderOpen(page);
    await enableReaderView(page);

    // Open the ⋯ overflow menu.
    await page.locator('.topbar-more').click();
    const menu = page.locator('#topbar-menu.visible');
    await expect(menu).toBeVisible();

    // Inline settings section is present and top-level (no second tap).
    const settings = menu.locator('.tbm-reader-settings');
    await expect(settings).toBeVisible();
    await expect(settings.locator('.rv-swatch')).toHaveCount(3);   // theme swatches, one row
    await expect(settings.locator('.rv-pill')).toHaveCount(2);     // font family, one row
    await expect(settings.locator('.rv-size-btn')).toHaveCount(2); // A− / A+, one row
    await expect(settings.locator('.rv-action-row')).toHaveCount(1); // Print (share hidden headless)
    await expect(settings.locator('.rv-exit-row')).toHaveCount(1);   // Exit Reader View

    // No horizontal page overflow; menu fits inside the viewport width.
    const overflow = await page.evaluate(() => ({
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      menuRight: document.getElementById('topbar-menu').getBoundingClientRect().right,
      vw: window.innerWidth,
    }));
    expect(overflow.pageOverflow).toBeLessThanOrEqual(1);
    expect(overflow.menuRight).toBeLessThanOrEqual(overflow.vw + 1);

    await page.screenshot({ path: 'scratchpad/qa15/reader3-menu-390.png' });
  });

  // ── Item 2: A−/A+ vertically centered
  test('A−/A+ size buttons are vertically centered', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(DEEP);
    await waitReaderOpen(page);
    await enableReaderView(page);
    await page.locator('.topbar-more').click();
    const btn = page.locator('#topbar-menu.visible .rv-size-btn').first();
    await expect(btn).toBeVisible();

    const geom = await btn.evaluate((el) => {
      const cs = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      // Measure the PRIMARY "A" glyph (the leading text node), not the small ±
      // superscript span — the A is what must read as vertically centered.
      const r = document.createRange();
      r.selectNode(el.firstChild);
      const t = r.getBoundingClientRect();
      const aCenter = t.top + t.height / 2;
      const btnCenter = b.top + b.height / 2;
      return { alignItems: cs.alignItems, offset: aCenter - btnCenter };
    });
    expect(geom.alignItems).toBe('center');
    // The A glyph's optical center sits on the button's center line.
    expect(Math.abs(geom.offset)).toBeLessThanOrEqual(1.5);
  });

  // ── Item 3: parent-document print container + @media print rules
  test('Print builds a parent print container with @media print rules', async ({ page }) => {
    await page.goto(DEEP);
    await waitReaderOpen(page);
    await enableReaderView(page);

    const res = await page.evaluate(() => {
      let called = false;
      const orig = window.print;
      window.print = () => { called = true; }; // dialog can't fire headless
      _readerPrint();
      const root = document.getElementById('zimi-print-root');
      const style = document.getElementById('zimi-print-style');
      const out = {
        called,
        hasRoot: !!root,
        hasContent: !!(root && root.querySelector('.zimi-reader-title, .zimi-reader-body')),
        imgsAbsolute: root ? Array.from(root.querySelectorAll('img'))
          .every((im) => !im.getAttribute('src') || /^https?:\/\//.test(im.getAttribute('src'))) : true,
        styleHasMediaPrint: !!(style && /@media\s+print/.test(style.textContent)),
        styleHidesApp: !!(style && /body>\*\{display:none/.test(style.textContent)),
        styleShowsRoot: !!(style && /zimi-print-root\{display:block/.test(style.textContent)),
      };
      // Simulate the OS print lifecycle finishing → teardown removes the container.
      window.dispatchEvent(new Event('afterprint'));
      out.cleanedUp = !document.getElementById('zimi-print-root') && !document.getElementById('zimi-print-style');
      window.print = orig;
      return out;
    });

    expect(res.called).toBe(true);
    expect(res.hasRoot).toBe(true);
    expect(res.hasContent).toBe(true);
    expect(res.imgsAbsolute).toBe(true);
    expect(res.styleHasMediaPrint).toBe(true);
    expect(res.styleHidesApp).toBe(true);
    expect(res.styleShowsRoot).toBe(true);
    expect(res.cleanedUp).toBe(true);
  });
});
