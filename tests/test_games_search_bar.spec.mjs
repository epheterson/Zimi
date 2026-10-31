// The games and the search. With ZimiGames open the top bar searches the shelf (live, Enter plays the first game, clearing
// brings the shelf back) and the page has no search box of its own; from anywhere the main search also lists matching
// games as a row; its filter pills leave out the ones that lead nowhere.
//
//   ZIM_DIR=<dir with tests/games_library_fixture.py's zims/> ZIMI_MANAGE_OPEN=1 ZIMI_TORRENT=0 ZIMI_OFFLINE=1 python3 -m zimi serve --port 9197
//   BASE_URL=http://localhost:9197 npx playwright test --config=tests/playwright.config.mjs tests/test_games_search_bar.spec.mjs --reporter=list --video=off
//   SHOTS=<dir> keeps the screenshots at 390x844

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:9197';
const SHOTS = process.env.SHOTS || '';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

async function openShelf(page) {
  await page.goto(BASE);
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(BASE + '/?a=' + encodeURIComponent('zimi_games/index.html'));
  await expect(page.locator('#reader')).toHaveClass(/open/);
  const frame = page.frameLocator('#reader-frame');
  await expect(frame.locator('.ar-shelf.sh-on')).toBeVisible();
  return frame;
}
const visibleTiles = (frame) => frame.locator('.ar-shelf a.ar-game:visible');

test('with Games open the top bar searches the shelf, Enter plays the top game, clearing brings the shelf back', async ({ page }) => {
  const frame = await openShelf(page);
  const bar = page.locator('#q');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute('placeholder', 'Search games');
  await expect(frame.locator('.sh-search')).toHaveCount(0);            // one search box
  await expect(page.locator('#game-head')).toBeHidden();
  await shot(page, 'shelf-bar');

  const all = await visibleTiles(frame).count();
  await bar.fill('checkers');
  await expect.poll(() => visibleTiles(frame).count()).toBeLessThan(all);
  await expect(frame.locator('a.ar-game[href="checkers.html"]')).toBeVisible();
  await expect(page.locator('#output')).not.toContainText('Checkers');   // the library is not asked
  await shot(page, 'shelf-filtered');

  await bar.fill('logic puzzles');                                       // a kind, not a name
  await expect.poll(() => frame.locator('a.ar-game[href^="puzzles/"]:visible').count()).toBeGreaterThan(5);
  await expect(frame.locator('a.ar-game[href="checkers.html"]')).toBeHidden();

  await bar.fill('checkers');
  await expect(frame.locator('a.ar-game[href="checkers.html"]')).toBeVisible();
  await bar.press('Enter');
  await expect(page.locator('#game-title')).toHaveText(/Checkers/);       // the game is open, its own header back
  await expect(bar).toBeHidden();
  await shot(page, 'shelf-enter-opens-game');

  await page.goBack();                                                     // back to the shelf: the box starts empty, the shelf whole
  await expect(frame.locator('.ar-shelf.sh-on')).toBeVisible();
  await expect(bar).toBeVisible();
  await expect(bar).toHaveValue('');
  await expect.poll(() => visibleTiles(frame).count()).toBeGreaterThan(all - 3);

  await bar.fill('chess');
  await expect.poll(() => visibleTiles(frame).count()).toBeLessThan(all);
  await page.locator('#search-clear').click();
  await expect(bar).toHaveValue('');
  await expect.poll(() => visibleTiles(frame).count()).toBeGreaterThan(all - 3);
});

test('Escape in the bar clears a shelf search before it closes the shelf', async ({ page }) => {
  const frame = await openShelf(page);
  await page.locator('#q').fill('go');
  await page.locator('#q').press('Escape');
  await expect(page.locator('#q')).toHaveValue('');
  await expect(page.locator('#reader')).toHaveClass(/open/);
  await expect(frame.locator('.ar-shelf.sh-on')).toBeVisible();
});

test('the main search lists the games it finds, and a tap opens one', async ({ page }) => {
  await page.goto(BASE);
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(BASE);
  await page.waitForFunction(() => typeof zimsCache !== 'undefined' && zimsCache && zimsCache.length);   // the library is known
  const asked = [];
  page.on('request', (r) => { if (r.url().includes('/games-search')) asked.push(r.url()); });
  await page.locator('#q').fill('chess');
  await page.locator('#q').press('Enter');
  const row = page.locator('#output .games-row');
  await expect(row).toBeVisible();
  await expect(row.locator('.games-row-tile', { hasText: /^Chess/ }).first()).toBeVisible();
  expect(await row.locator('.games-row-tile').count()).toBeLessThanOrEqual(6);
  await shot(page, 'main-search-games-row');
  // the list is read once: the next search asks nothing more
  await page.locator('#q').fill('go');
  await page.locator('#q').press('Enter');
  await expect(page.locator('#output .games-row .games-row-tile').first()).toBeVisible();
  expect(asked.length).toBe(1);
  // a query no game answers draws no row
  await page.locator('#q').fill('photosynthesis');
  await page.locator('#q').press('Enter');
  await expect(page.locator('#output .result, #output .empty').first()).toBeVisible();
  await expect(page.locator('#output .games-row')).toHaveCount(0);
  // a tap opens the game in the reader
  await page.locator('#q').fill('checkers');
  await page.locator('#q').press('Enter');
  await page.locator('#output .games-row-tile', { hasText: /Checkers/ }).first().click();
  await expect(page.locator('#reader')).toHaveClass(/open/);
  await expect(page.locator('#game-title')).toHaveText(/Checkers/);
});

test('search pills leave out the ones that lead nowhere once there are more than a few', async ({ page }) => {
  await page.goto(BASE);
  await page.waitForFunction(() => typeof _pillsWithoutDimmed === 'function');
  const kept = await page.evaluate(() => ({
    few: _pillsWithoutDimmed(['a', 'b', 'c'], (n) => n === 'b', () => false),                    // three: all stay
    many: _pillsWithoutDimmed(['a', 'b', 'c', 'd'], (n) => n === 'b' || n === 'c', (n) => n === 'c'),  // dimmed b goes, the one on stays
  }));
  expect(kept.few).toEqual(['a', 'b', 'c']);
  expect(kept.many).toEqual(['a', 'c', 'd']);
  // on the page: with a language chosen, no pill is drawn dimmed in a row of more than a few
  await page.locator('#q').fill('Paris');
  await page.locator('#q').press('Enter');
  await expect(page.locator('#pills-bar .pill').first()).toBeVisible();
  const langPill = page.locator('#pills-bar .lang-pills .pill:not(.active)', { hasText: /Fran/ }).first();
  await langPill.click();
  const n = await page.locator('#pills-bar .pills-row .pill').count();
  if (n > 3) await expect(page.locator('#pills-bar .pill.dimmed')).toHaveCount(0);
  await shot(page, 'pills-filtered');
});
