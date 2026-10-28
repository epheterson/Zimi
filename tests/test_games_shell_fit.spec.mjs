// Zimi's own page never ends up scrolled sideways or zoomed while a patience game is played inside it, and
// it is back to rest on the shelf. The bar is fixed: if the top document is panned, the bar is clipped.
//
//   ZIMI_MANAGE_OPEN=1 ZIMI_TORRENT=0 ZIMI_OFFLINE=1 ZIM_DIR=<empty dir> python3 -m zimi serve --port 9187
//   BASE_URL=http://localhost:9187 npx playwright test --config=tests/playwright.config.mjs tests/test_games_shell_fit.spec.mjs
//
// Runs in WebKit, iOS's engine. The games ZIM is Zimi's own.

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:9187';
test.use({ browserName: 'webkit' });
const SIZES = [{ width: 390, height: 844 }, { width: 375, height: 667 }];

async function top(page) {
  return page.evaluate(() => ({
    sx: document.scrollingElement.scrollLeft,
    sw: document.documentElement.scrollWidth,
    iw: innerWidth,
    scale: window.visualViewport ? visualViewport.scale : 1,
    barLeft: Math.round(document.querySelector('.topbar').getBoundingClientRect().left),
    barRight: Math.round(document.querySelector('.topbar').getBoundingClientRect().right),
  }));
}

async function expectAtRest(page, when) {
  const m = await top(page);
  expect(m.sx, when + ': scrolled sideways').toBe(0);
  expect(m.sw, when + ': wider than the screen').toBeLessThanOrEqual(m.iw);
  expect(m.scale, when + ': zoomed').toBe(1);
  expect(m.barLeft, when + ': bar clipped left').toBe(0);
  expect(m.barRight, when + ': bar clipped right').toBeLessThanOrEqual(m.iw);
}

for (const size of SIZES) {
  test.describe(size.width + 'px', () => {
    test.use({ viewport: size, hasTouch: true, isMobile: true });

    test('Klondike inside Zimi: double taps, drags and a stray scroll leave the top page at rest', async ({ page }) => {
      await page.goto(BASE);
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      await page.goto(BASE + '/?a=' + encodeURIComponent('zimi_games/solitaire.html'));
      await expect(page.locator('#reader')).toHaveClass(/open/);
      const frame = page.frameLocator('#reader-frame');
      await frame.locator('.zc-card:not(.zc-off)').first().waitFor();
      await page.waitForTimeout(1200);
      await expectAtRest(page, 'at the deal');

      // The shell must hold still even when something scrolls it: a focused card, scrollIntoView, a drag at the edge.
      await page.evaluate(() => { scrollTo(80, 0); document.documentElement.scrollLeft = 80; document.body.scrollLeft = 80; });
      await expectAtRest(page, 'after a programmatic sideways scroll');

      const up = frame.locator('.zc-card:not(.zc-off):not(.zc-down)');
      for (let i = 0; i < 3; i++) {
        const box = await up.last().boundingBox();
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        await page.touchscreen.tap(x, y);
        await page.waitForTimeout(60);
        await page.touchscreen.tap(x, y);
        await page.waitForTimeout(400);
      }
      await expectAtRest(page, 'after double taps');

      const box = await up.first().boundingBox();
      await page.mouse.move(box.x + 10, box.y + 10);
      await page.mouse.down();
      await page.mouse.move(size.width + 40, box.y + 120, { steps: 8 });
      await page.mouse.move(-40, box.y + 120, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      await expectAtRest(page, 'after a drag past both edges');

      // a pinch: the frame must not let the top page be zoomed by it
      const touch = await page.evaluate(() => {
        const f = document.getElementById('reader-frame');
        const cs = (e) => { let a = []; for (; e; e = e.parentElement) a.push(getComputedStyle(e).touchAction); return a; };
        return { frame: getComputedStyle(f).touchAction, inner: cs(f.contentDocument.querySelector('.zc-table')) };
      });
      expect(touch.frame, 'the game frame allows pan only, no pinch').toBe('pan-x pan-y');

      // back to the shelf
      await page.goto(BASE + '/?a=' + encodeURIComponent('zimi_games/index.html'));
      await expect(page.locator('#game-title')).toHaveText('ZimiGames');
      await page.evaluate(() => scrollTo(60, 0));
      await expectAtRest(page, 'on the shelf');
    });

    test('the bar holds a game\'s full set of buttons and a long title inside the screen', async ({ page }) => {
      await page.goto(BASE + '/?a=' + encodeURIComponent('zimi_games/solitaire.html'));
      await expect(page.locator('#game-menu-btn')).toBeVisible();
      await page.evaluate(() => { document.getElementById('game-title').textContent = 'An extraordinarily long game title that goes on and on and on'; });
      const over = await page.evaluate(() => {
        const out = [];
        for (const e of document.querySelectorAll('.topbar *')) {
          const r = e.getBoundingClientRect();
          if (r.width && getComputedStyle(e).visibility !== 'hidden' && (r.left < -0.5 || r.right > innerWidth + 0.5)) out.push(e.id || e.className);
        }
        return out;
      });
      expect(over, 'bar items outside the screen').toEqual([]);
      await expectAtRest(page, 'long title');
    });
  });
}
