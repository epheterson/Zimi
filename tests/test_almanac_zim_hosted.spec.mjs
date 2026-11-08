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
  let frame;
  await expect.poll(async () => {
    frame = page.frames().find((f) => f.url().includes('/w/zimi_almanac/'));
    if (!frame) return '';
    try { return await frame.evaluate(() => typeof window.openAlmanacEarth); } catch (e) { return ''; }
  }, { timeout: 60000 }).toBe('function');
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

// A choice made in the Almanac's ZIM is the person's: inside Zimi it goes through the shell's door (kept with the
// account, followed by their other windows), a change the shell takes from the account shows in the open page
// without a reload, and in Kiwix (no Zimi around) it is this browser's own, with no error.
test('inside Zimi a choice goes through the shell, and a change from the shell is drawn without a reload', async ({ page }) => {
  const frame = await openAlmanacZim(page);
  await frame.evaluate(() => _aeSetOrbits(true));
  expect(await page.evaluate(() => localStorage.getItem('zimi_ae_orbits'))).toBe('always');
  // The shell takes a change from the account (another browser) into storage: the frame hears the storage event.
  await frame.evaluate(() => {
    window.__drawn = 0;
    const real = window._renderAlmanacContent;
    window._renderAlmanacContent = function () { window.__drawn++; return real.apply(this, arguments); };
    window._almanacOpen = true;
  });
  await page.evaluate(() => { localStorage.removeItem('zimi_ae_orbits'); localStorage.setItem('zimi_almanac_units', 'ft'); });
  await expect.poll(() => frame.evaluate(() => [_aeOrbitsOn(), window.__drawn > 0])).toEqual([false, true]);
  await page.evaluate(() => { localStorage.removeItem('zimi_ae_orbits'); localStorage.removeItem('zimi_almanac_units'); });
});

// A puzzle's own preferences, which the puzzle keeps under its address, are kept under a name the account takes.
test('a puzzle keeps its preferences under a key that follows the account', async ({ page }) => {
  await page.goto(BASE + '/w/zimi_games/puzzles/net.html?raw=1');
  await expect.poll(() => page.evaluate(() => typeof window.ZimiShell), { timeout: 60000 }).toBe('object');
  const got = await page.evaluate(() => {
    const own = location.pathname + ' preferences';
    localStorage.setItem(own, 'Show grid\n1');
    return [localStorage.getItem('zimi.games.puzzleprefs.net'), localStorage.getItem(own), Object.keys(localStorage).filter((k) => /preferences/.test(k))];
  });
  expect(got).toEqual(['Show grid\n1', 'Show grid\n1', []]);
});

test('in Kiwix (no Zimi around the page) a choice is kept in this browser, with no error', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + '/w/zimi_almanac/index.html?raw=1');
  await expect.poll(() => page.evaluate(() => typeof window.openAlmanacEarth), { timeout: 60000 }).toBe('function');
  expect(await page.evaluate(() => HOSTED_IN_ZIMI)).toBe(false);
  await page.evaluate(() => { _aeSetOrbits(true); _prefWrite('zimi_almanac_units', 'ft'); });
  expect(await page.evaluate(() => [localStorage.getItem('zimi_almanac_units'), localStorage.getItem('zimi_ae_orbits')])).toEqual(['ft', 'always']);
  await page.evaluate(() => { _prefWrite('zimi_almanac_units', null); _prefWrite('zimi_ae_orbits', null); });
  expect(await page.evaluate(() => [localStorage.getItem('zimi_almanac_units'), localStorage.getItem('zimi_ae_orbits')])).toEqual([null, null]);
  expect(errors).toEqual([]);
});
