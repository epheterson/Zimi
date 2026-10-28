// The menu on a game's tile: a long press or a right click on the shelf opens Add to favorites, Open in new tab, How to play,
// About and (with a saved game) Reset progress.
//
//   ZIMI_MANAGE_OPEN=1 ZIMI_TORRENT=0 ZIMI_OFFLINE=1 ZIM_DIR=<empty dir> python3 -m zimi serve --port 9187
//   BASE_URL=http://localhost:9187 npx playwright test --config=tests/playwright.config.mjs tests/test_games_tilemenu.spec.mjs --reporter=list --video=off
//   SHOTS=<dir> keeps the screenshots (light, dark, Arabic)
//
// The games ZIM is Zimi's own, so the library needs nothing else. The same shelf is also opened by itself, with no Zimi around it
// (a ZIM read by anything else, or the folder on a web server):
//
//   (cd zimi/builtin/games && python3 -m http.server 9188)   STANDALONE_URL=http://localhost:9188/index.html

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:9187';
const SHOTS = process.env.SHOTS || '';
const SHELF = process.env.STANDALONE_URL || 'http://localhost:9188/index.html';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function openShelf(page) {
  await page.goto(BASE);
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(BASE + '/?a=' + encodeURIComponent('zimi_games/index.html'));
  await expect(page.locator('#reader')).toHaveClass(/open/);
  await page.evaluate(() => Saved.all().filter((i) => i.zim === 'zimi_games').forEach((i) => Saved.remove(i)));
  const frame = page.frameLocator('#reader-frame');
  await expect(frame.locator('.ar-shelf.sh-on')).toBeVisible();
  return frame;
}

// A finger held on a point of the page for ms, as a phone does it (the iframe's tile gets real touch events).
async function hold(page, box, ms = 650, move = 0) {
  const cdp = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  if (move) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + move }] });
  await page.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

// A tile in view, in the Lobby feed: one that is a game, not a family card.
async function aTile(frame) {
  const tile = frame.locator('.ar-section:not(.ar-favorites) a.ar-game:not(.sh-fam-card):visible').first();
  await tile.scrollIntoViewIfNeeded();
  return tile;
}
const tag = async (tile) => ({ href: await tile.getAttribute('href'), name: (await tile.locator('strong').textContent()).trim() });
const idOf = (href) => href.replace(/^.*\//, '').replace(/\.html$/, '');

test('a long press on a tile opens the menu, Add to favorites keeps it, and the heart in the game agrees', async ({ page }) => {
  const frame = await openShelf(page);
  const tile = await aTile(frame), { href, name } = await tag(tile);
  await hold(page, await tile.boundingBox());
  const menu = frame.locator('.gs-tm');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Add to favorites' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Open in new tab' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'About this game' })).toBeVisible();
  // the click the press leaves behind did not open the game
  await expect(page.locator('#game-title')).toHaveText('ZimiGames');
  await menu.getByRole('menuitem', { name: 'Add to favorites' }).tap();
  await expect(menu).toBeHidden();
  const row = frame.locator('#sh-favorites a.ar-game');
  await expect(row).toHaveCount(1);
  await expect(row.first()).toContainText(name);
  expect(await page.evaluate((p) => Saved.has({ zim: 'zimi_games', path: p }), href)).toBe(true);

  // the heart in that game says it is kept
  await page.evaluate((p) => openArticle('zimi_games', p, 'x'), href);
  await expect(page.locator('#library-btn')).toHaveAttribute('title', 'Remove from favorites');
  await page.evaluate(() => openArticle('zimi_games', 'index.html', 'x'));
  await expect(frame.locator('#sh-favorites a.ar-game')).toHaveCount(1);

  // a long press on the tile in the Favorites row lets it go; the row and the heart follow
  await hold(page, await frame.locator('#sh-favorites a.ar-game').first().boundingBox());
  await expect(frame.locator('.gs-tm').getByRole('menuitem', { name: 'Remove from favorites' })).toBeVisible();
  await frame.locator('.gs-tm').getByRole('menuitem', { name: 'Remove from favorites' }).tap();
  await expect(frame.locator('#sh-favorites')).toHaveCount(0);
  expect(await page.evaluate((p) => Saved.has({ zim: 'zimi_games', path: p }), href)).toBe(false);
});

test('a scroll is not a press, a tap still opens the game, and Escape and a tap away close the menu', async ({ page }) => {
  const frame = await openShelf(page);
  const tile = await aTile(frame);
  await hold(page, await tile.boundingBox(), 650, 40);   // the finger moved: a scroll
  await expect(frame.locator('.gs-tm')).toHaveCount(0);
  await tile.tap();                                      // a tap is not a press: the game opens, no menu
  await expect(page.locator('#game-title')).not.toHaveText('ZimiGames');
  await page.evaluate(() => openArticle('zimi_games', 'index.html', 'x'));
  await expect(page.locator('#game-title')).toHaveText('ZimiGames');
  await expect(frame.locator('.gs-tm')).toHaveCount(0);
  await hold(page, await tile.boundingBox());
  await expect(frame.locator('.gs-tm')).toBeVisible();
  await page.waitForTimeout(450);
  await page.touchscreen.tap(195, 40);                    // away from the sheet
  await expect(frame.locator('.gs-tm')).toHaveCount(0);
  await expect(page.locator('#game-title')).toHaveText('ZimiGames');
  await hold(page, await tile.boundingBox());
  await expect(frame.locator('.gs-tm')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(frame.locator('.gs-tm')).toHaveCount(0);
});

test('How to play and About show on the shelf as sheets, without opening the game', async ({ page }) => {
  const frame = await openShelf(page);
  const tile = frame.locator('a.ar-game[href="checkers.html"]');
  await frame.locator('.sh-search input').fill('checkers');
  await tile.first().scrollIntoViewIfNeeded();
  await tile.first().click({ button: 'right' });   // a mouse: the popup
  const menu = frame.locator('.gs-tm');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'How to play' }).click();
  await expect(frame.locator('.ar-sheet-card h2')).toHaveText('Checkers');
  await expect(frame.locator('.ar-sheet-card .gs-help dt').first()).toHaveText('Goal');
  await frame.locator('.ar-sheet-card').getByRole('button', { name: 'Close' }).click();
  await tile.first().click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'About this game' }).click();
  await expect(frame.locator('.ar-sheet-card .gs-about a[href^="about.html?qid="]')).toBeVisible();
  await expect(page.locator('#game-title')).toHaveText('ZimiGames');
});

test('Open in new tab uses the address a reader link gets', async ({ page, context }) => {
  const frame = await openShelf(page);
  const tile = await aTile(frame), { href } = await tag(tile);
  const opened = context.waitForEvent('page');
  await tile.click({ button: 'right' });
  await frame.locator('.gs-tm').getByRole('menuitem', { name: 'Open in new tab' }).click();
  const tab = await opened;
  expect(decodeURIComponent(new URL(tab.url()).searchParams.get('a'))).toBe('zimi_games/' + href);
});

test('Reset progress is offered only with a saved game, asks first, and clears that game only', async ({ page }) => {
  const frame = await openShelf(page);
  const tile = await aTile(frame), { href } = await tag(tile), id = idOf(href);
  const menu = frame.locator('.gs-tm');
  await hold(page, await tile.boundingBox());
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Reset progress' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await frame.locator('body').evaluate((_, id) => {
    localStorage.setItem('zimi.games.save.' + id, JSON.stringify({ v: 1, at: 1, data: { x: 1 } }));
    localStorage.setItem('zimi.games.' + id + '.stats', '{"won":3}');
    localStorage.setItem('zimi.games.settings', '{"keep":1}');
    localStorage.setItem('zimi.games.save.other', '{"v":1}');
  }, id);
  await hold(page, await tile.boundingBox());
  await menu.getByRole('menuitem', { name: 'Reset progress' }).tap();
  await expect(frame.locator('.ar-sheet-card h2')).toContainText('Reset');
  await frame.locator('.ar-sheet-card').getByRole('button', { name: 'Cancel' }).tap();   // asked first: Cancel keeps it
  expect(await frame.locator('body').evaluate((_, id) => localStorage.getItem('zimi.games.save.' + id), id)).not.toBeNull();
  await hold(page, await tile.boundingBox());
  await menu.getByRole('menuitem', { name: 'Reset progress' }).tap();
  await frame.locator('.ar-sheet-card').getByRole('button', { name: 'Reset', exact: true }).tap();
  const left = await frame.locator('body').evaluate((_, id) => ({
    save: localStorage.getItem('zimi.games.save.' + id), stats: localStorage.getItem('zimi.games.' + id + '.stats'),
    settings: localStorage.getItem('zimi.games.settings'), other: localStorage.getItem('zimi.games.save.other'),
  }), id);
  expect(left).toEqual({ save: null, stats: null, settings: '{"keep":1}', other: '{"v":1}' });
});

async function shoot(page, name) {
  const frame = await openShelf(page);
  const tile = await aTile(frame);
  await hold(page, await tile.boundingBox());
  await expect(frame.locator('.gs-tm')).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/tilemenu-${name}.png` });
  return { frame, tile };
}

test('the menu in light and dark, as a sheet for a finger and a popup for a mouse', async ({ page }) => {
  test.skip(!SHOTS, 'set SHOTS=<dir> to keep the screenshots');
  await page.emulateMedia({ colorScheme: 'light' });
  const { frame, tile } = await shoot(page, 'light');
  await page.keyboard.press('Escape');
  await tile.click({ button: 'right' });
  await expect(frame.locator('.gs-tm')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/tilemenu-popup.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await shoot(page, 'dark');
});

test.describe('in Arabic', () => {
  test.use({ locale: 'ar' });   // the shelf speaks the browser's language when Zimi passes none

  test('the menu is mirrored and in Arabic', async ({ page }) => {
    test.skip(!SHOTS, 'set SHOTS=<dir> to keep the screenshots');
    const { frame, tile } = await shoot(page, 'arabic');
    await expect(frame.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(frame.locator('.gs-tm .gs-tm-item').first()).toHaveText('إضافة إلى المفضلة');
    await page.keyboard.press('Escape');
    await tile.click({ button: 'right' });
    await expect(frame.locator('.gs-tm')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/tilemenu-arabic-popup.png` });
  });
});

test.describe('the shelf on its own, outside Zimi', () => {
  test.use({ hasTouch: false, isMobile: false, viewport: { width: 900, height: 800 } });

  test('right click and the menu key open the menu: no favorites item, a normal new tab, Reset only with a save', async ({ page, context }) => {
    await page.goto(SHELF);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.locator('.ar-shelf.sh-on')).toBeVisible();
    await page.locator('.sh-chip', { hasText: 'All' }).first().click();
    const tile = page.locator('.ar-section a.ar-game:not(.sh-fam-card):visible').first();
    const href = await tile.getAttribute('href'), id = idOf(href);
    await tile.click({ button: 'right' });
    const menu = page.locator('.gs-tm');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /favorites/ })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: 'Reset progress' })).toHaveCount(0);
    const opened = context.waitForEvent('page');
    await menu.getByRole('menuitem', { name: 'Open in new tab' }).click();
    expect(new URL((await opened).url()).pathname).toBe('/' + href);
    await expect(page.locator('.gs-tm')).toHaveCount(0);
    // the keyboard: the menu key on a focused tile, Escape gives the focus back
    await page.evaluate((id) => localStorage.setItem('zimi.games.save.' + id, '{"v":1,"data":1}'), id);
    await tile.focus();
    await page.keyboard.press('ContextMenu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await expect(menu.getByRole('menuitem', { name: 'Reset progress' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(tile).toBeFocused();
    await tile.focus();
    await page.keyboard.press('Shift+F10');
    await expect(menu).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    // a plain click still opens the game
    await tile.click();
    await expect(page).toHaveURL(new RegExp(href.replace('.', '\\.') + '$'));
  });
});
