// ZimiGames inside Zimi has one header: the game's name where the search box is, its Undo or Pause and
// Menu beside it, the heart keeps it as a favorite, and Random is always a game.
//
//   ZIMI_MANAGE_OPEN=1 ZIMI_TORRENT=0 ZIMI_OFFLINE=1 ZIM_DIR=<empty dir> python3 -m zimi serve --port 9073
//   BASE_URL=http://localhost:9073 npx playwright test --config=tests/playwright.config.mjs tests/test_games_header.spec.mjs
//
// The games ZIM is Zimi's own (ZIMI_BUILTIN_ZIMS unset), so the library needs nothing else.

import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:9073';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function openGame(page, path) {
  await page.goto(BASE);
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(BASE + '/?a=' + encodeURIComponent('zimi_games/' + path));
  await expect(page.locator('#reader')).toHaveClass(/open/);
}

test('a game has one header: its name, Undo and Menu in Zimi\'s bar, none in the page', async ({ page }) => {
  await openGame(page, 'checkers.html');
  await expect(page.locator('#game-title')).toHaveText('Checkers');
  await expect(page.locator('.topbar-search')).toBeHidden();
  await expect(page.locator('#game-act-btn')).toBeVisible();
  await expect(page.locator('#game-menu-btn')).toBeVisible();
  const frame = page.frameLocator('#reader-frame');
  await expect(frame.locator('.ar-bar')).toBeHidden();
  // Menu opens the page's own sheet; Escape closes it
  await page.locator('#game-menu-btn').click();
  await expect(frame.locator('.gs-sheet')).toBeVisible();
});

test('the shelf has the search box for the games, no Undo, Menu or heart', async ({ page }) => {
  await openGame(page, 'index.html');
  await expect(page.locator('#q')).toHaveAttribute('placeholder', 'Search games');   // the shelf: Zimi's box searches the games
  await expect(page.locator('#game-act-btn')).toBeHidden();
  await expect(page.locator('#game-menu-btn')).toBeHidden();
  await expect(page.locator('#library-btn')).toBeHidden();
});

test('the heart keeps a game, and the shelf lists it under Favorites', async ({ page }) => {
  await openGame(page, 'checkers.html');
  // a server keeps hearts for everyone on it: start from none
  await page.evaluate(() => Saved.all().filter((i) => i.zim === 'zimi_games').forEach((i) => Saved.remove(i)));
  await page.evaluate(() => _updateLibraryBtnIcon());
  if ((await page.locator('#library-btn').getAttribute('title')) === 'Remove from favorites') await page.locator('#library-btn').click();
  await expect(page.locator('#library-btn')).toHaveAttribute('title', 'Add to favorites');
  await page.locator('#library-btn').click();
  await expect(page.locator('#library-btn')).toHaveAttribute('title', 'Remove from favorites');
  await page.evaluate(() => openArticle('zimi_games', 'index.html', 'x'));
  const fav = page.frameLocator('#reader-frame').locator('#sh-favorites a.ar-game');
  await expect(fav).toHaveCount(1);
  await expect(fav.first()).toContainText('Checkers');
  await page.evaluate(() => Saved.remove({ zim: 'zimi_games', path: 'checkers.html' }));
});

test('Random inside the games is always a game of the shelf', async ({ page, request }) => {
  const shelf = await (await request.get(BASE + '/w/zimi_games/games.json')).json();
  const paths = new Set(shelf.map((r) => r.path));
  for (let i = 0; i < 25; i++) {
    const got = await (await request.get(BASE + '/random?zim=zimi_games&not=chess.html')).json();
    expect(paths.has(got.path)).toBeTruthy();
    expect(got.path).not.toBe('chess.html');
  }
});

test('a Tatham puzzle has the one header too: its name, Undo and Menu, no second bar', async ({ page }) => {
  await openGame(page, 'puzzles/fifteen.html');
  await expect(page.locator('#game-title')).toHaveText('Fifteen');
  await expect(page.locator('.topbar-search')).toBeHidden();
  await expect(page.locator('#game-menu-btn')).toBeVisible();
  await expect(page.locator('#game-act-btn')).toBeVisible();
});

test('Sokoban keeps its position when you leave to Home and come back, and across a reload', async ({ page }) => {
  await openGame(page, 'sokoban.html');
  const frame = page.frameLocator('#reader-frame');
  for (const dir of ['Down', 'Right', 'Right', 'Up']) await frame.locator(`button[aria-label="${dir}"]`).first().tap();
  await expect(frame.locator('#sk-moves')).not.toHaveText('0');
  const moves = await frame.locator('#sk-moves').textContent();
  await page.waitForTimeout(700);   // the shell saves shortly after each tap
  await page.evaluate(() => { closeReader(); goHome(); });
  await page.evaluate(() => openArticle('zimi_games', 'sokoban.html', 'x'));
  await expect(page.frameLocator('#reader-frame').locator('#sk-moves')).toHaveText(moves);
  await page.reload();
  await expect(page.frameLocator('#reader-frame').locator('#sk-moves')).toHaveText(moves);
});

test('after a reload a game still has its back arrow, and it leads to the shelf', async ({ page }) => {
  await openGame(page, 'checkers.html');
  await expect(page.locator('#game-title')).toHaveText('Checkers');
  await page.reload();   // the article history is gone: the shelf behind the game is not
  await expect(page.locator('#game-title')).toHaveText('Checkers');
  await expect(page.locator('#back-btn')).toBeVisible();
  await page.locator('#back-btn').click();
  await expect(page.locator('#q')).toHaveAttribute('placeholder', 'Search games');   // the shelf: Zimi's box searches the games
});

test('the ZimiGames icon in Zimi\'s bar leads to the shelf from any game', async ({ page }) => {
  await openGame(page, 'mahjong.html');
  await expect(page.locator('#game-title')).toHaveText('Mahjong');
  await page.locator('.topbar-breadcrumb .bc-icon').click();
  await expect(page.locator('#q')).toHaveAttribute('placeholder', 'Search games');   // the shelf: Zimi's box searches the games
});

test('a tile\'s picture on the shelf opens what the tile opens, never Zimi\'s image viewer', async ({ page }) => {
  await openGame(page, 'index.html');
  const frame = page.frameLocator('#reader-frame');
  const pic = frame.locator('.sh-fam-card img').first();
  await expect(pic).toBeVisible();
  await pic.click();
  await page.waitForTimeout(400);
  await expect(frame.locator('.zimi-img-lightbox')).toHaveCount(0);
  await expect(frame.locator('.sh-fam-card[aria-expanded="true"]')).toHaveCount(1);
});

test('a game offers no Reader View: it is played, not read', async ({ page }) => {
  await openGame(page, 'checkers.html');
  await expect(page.locator('#game-title')).toHaveText('Checkers');
  await expect(page.locator('#readerview-btn')).toBeHidden();
  await page.locator('button.topbar-more').click();
  await expect(page.locator('#topbar-menu.visible')).toHaveCount(1);
  await expect(page.locator('#tbm-readerview')).toHaveCount(0);
  await expect(page.locator('#tbm-find')).toHaveCount(0);
});

test('a reload in a game paints the game\'s header without passing through other states', async ({ page }) => {
  await openGame(page, 'checkers.html');
  await expect(page.locator('#game-title')).toHaveText('Checkers');
  await page.evaluate(() => {
    window.__seen = [];
    const rec = () => { const t = document.getElementById('game-title'), s = document.querySelector('.topbar-search');
      window.__seen.push((t && t.offsetParent ? 'title:' + t.textContent : '') + (s && s.offsetParent && getComputedStyle(s).visibility !== 'hidden' ? '|search' : '')); };
    sessionStorage.setItem('zimi.probe', '1');
  });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('zimi.probe')) return;
    window.__seen = [];
    const rec = () => { const t = document.getElementById('game-title'), s = document.querySelector('.topbar-search');
      // nothing paints before the render-blocking stylesheet is in; until then the bar's rules are not applied and a state seen here is never shown
      const css = document.querySelector('link[href*="app.css"]');
      if (!css || !css.sheet) return;
      const v = (t && t.offsetParent && t.textContent ? 'title:' + t.textContent : '') + (s && s.offsetParent && getComputedStyle(s).visibility !== 'hidden' ? '|search' : '');
      if (v && window.__seen[window.__seen.length - 1] !== v) window.__seen.push(v); };
    new MutationObserver(rec).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await page.reload();
  await expect(page.locator('#game-title')).toHaveText('Checkers');
  await page.waitForTimeout(500);
  const seen = await page.evaluate(() => window.__seen);
  expect(seen.filter((v) => v.includes('search'))).toEqual([]);
  expect(seen.filter((v) => v.startsWith('title:') && v !== 'title:Checkers')).toEqual([]);
});
