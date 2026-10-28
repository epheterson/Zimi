// The Almanac's ZIM, opened inside Zimi's reader, is Zimi's own page: its PDF goes through to Zimi, which lays the
// book out and shows the file; its satellites and tides come from files packed in the ZIM. Anywhere else the
// server's paths are "not here" (a 404) and Print is the browser's dialog.
//
//   ZIMI_MANAGE_OPEN=1 ZIMI_TORRENT=0 ZIMI_OFFLINE=1 ZIM_DIR=<empty dir> python3 -m zimi serve --port 9074
//   BASE_URL=http://localhost:9074 npx playwright test --config=tests/playwright.config.mjs tests/test_almanac_zim_hosted.spec.mjs

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:9074';
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function openAlmanacZim(page) {
  await page.goto(BASE + '/?a=' + encodeURIComponent('zimi_almanac/index.html'));
  await expect(page.locator('#reader')).toHaveClass(/open/);
  const frame = page.frames().find((f) => f.url().includes('/w/zimi_almanac/'));
  await expect.poll(async () => (frame ? frame.evaluate(() => typeof window.openAlmanacEarth) : ''), { timeout: 60000 }).toBe('function');
  return frame;
}

test('inside Zimi the PDF reaches Zimi and the reader functions are Zimi\'s', async ({ page }) => {
  const frame = await openAlmanacZim(page);
  expect(await frame.evaluate(() => [HOSTED_IN_ZIMI, typeof openReader, typeof _pdfViewerUrl])).toEqual([true, 'function', 'function']);
  // an empty body is refused by Zimi (400), so the request got there; a 404 would be the page's own "not here"
  expect(await frame.evaluate(() => fetch('/almanac/pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.status))).toBe(400);
  expect(await frame.evaluate(() => fetch('/almanac-links', { method: 'POST' }).then((r) => r.status))).toBe(404);
});

test('satellites and tide stations answer from the ZIM', async ({ page }) => {
  const frame = await openAlmanacZim(page);
  const sats = await frame.evaluate(() => fetch('/almanac-satellites').then((r) => r.json()));
  expect(sats.source).toBe('snapshot');
  expect(sats.gps.length).toBeGreaterThan(20);
  const tides = await frame.evaluate(() => fetch('/almanac-place?lat=37.8&lon=-122.4').then((r) => r.json()));
  expect(tides.tides.stations[0].n).toContain('San Francisco');
});
